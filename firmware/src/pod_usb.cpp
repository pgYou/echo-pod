#include "pod_usb.h"
#include <string.h>
#include "USB.h"
#include "USBMSC.h"
#include "sdmmc_cmd.h"
#include "WavRecorder.h"

namespace pod::usb {

// 全局构造即向 TinyUSB 注册 MSC 接口（须发生在 USB.begin 前——本模块在
// setup 里才 begin 栈，构造先于一切，顺序天然满足）
static USBMSC msc;

static WavRecorder *rec_ = nullptr;          // SD 卡句柄来源（不拥有）
static volatile bool mediaUp_ = false;       // U 盘已挂给 host
static bool mediaWasUp_ = false;             // 清理事务前媒体是否在挂（resume 还原）
static volatile uint32_t reattachAtMs_ = 0;  // RMEND 延迟复挂时刻（0=无待办）
static volatile bool hostUp_ = false;        // host 枚举完成（≈插电脑）
static volatile uint32_t suspendSince_ = 0;  // SUSPEND 起始（0=未挂起）

// MSC 块读回调（usb 高优先级任务上下文）：固件代理的只读块设备——
// SYNC 态唯一 SD 访问者（recorder 已暂停、pod_log 已关卡写），无并发。
// 越界/参数异常返回 0（TinyUSB 向 host 报读失败，Finder 显示 IO 错误）
static int32_t mscOnRead(uint32_t lba, uint32_t offset, void *buffer, uint32_t bufsize) {
  sdmmc_card_t *card = rec_ ? rec_->sdCard() : nullptr;
  if (!card || !mediaUp_ || offset != 0 || bufsize == 0 || bufsize % 512) return 0;
  uint32_t nSec = bufsize / 512;
  if ((uint64_t)lba + nSec > card->csd.capacity) return 0;
  return sdmmc_read_sectors(card, buffer, lba, nSec) == ESP_OK ? (int32_t)bufsize : 0;
}

// 只读 U 盘：写恒拒（协议层面 isWritable(false) 已告知 host，此为兜底）
static int32_t mscOnWrite(uint32_t, uint32_t, uint8_t *, uint32_t) { return 0; }

// host 弹出卷（Finder 推出）仅作事件留痕：设备保持 SYNC 到拔线
static bool mscOnStartStop(uint8_t, bool, bool) { return true; }

// USB 插拔沿（TinyUSB 任务上下文回调；状态位 loop 里读，volatile 交付）
static void onUsbEvent(void *, esp_event_base_t base, int32_t id, void *) {
  if (base != ARDUINO_USB_EVENTS) return;
  switch (id) {
    case ARDUINO_USB_STARTED_EVENT:  // host 枚举完成（= 旧 SOF 在线的等价事件）
      hostUp_ = true;
      suspendSince_ = 0;
      break;
    case ARDUINO_USB_STOPPED_EVENT:  // 总线断开（拔线/总线复位）
      hostUp_ = false;
      suspendSince_ = 0;
      reattachAtMs_ = 0;  // 线都没了，待复挂作废
      mediaWasUp_ = false;
      break;
    case ARDUINO_USB_SUSPEND_EVENT:  // 挂起（拔线或 host 休眠；3s 无 RESUME 判离）
      if (hostUp_ && !suspendSince_) suspendSince_ = millis();
      break;
    case ARDUINO_USB_RESUME_EVENT:
      suspendSince_ = 0;
      break;
    default:
      break;
  }
}

void begin(WavRecorder &recorder) {
  rec_ = &recorder;
  // MSC 元数据（host 磁盘信息栏可见）。revision 上限 4 字符，取版本主干
  msc.vendorID("echo-pod");
  msc.productID("SD Storage");
  msc.productRevision("0.2");
  msc.onRead(mscOnRead);
  msc.onWrite(mscOnWrite);
  msc.onStartStop(mscOnStartStop);
  msc.isWritable(false);  // 只读 U 盘：录音豆写、电脑读（互斥铁律的 host 侧宣告）
  // mediaPresent 默认 false：LUN 无媒体待命，enterSync 才插媒体（host 即刻见盘）
  USB.onEvent(onUsbEvent);
  // 栈实际已由 app_main 的 USB.begin() 以 CDC+MSC 复合形态启动（MSC 接口在
  // 全局构造期注册，先于 app_main）；此处再 begin 无害（已初始化直接返回）
  USB.begin();
}

void tick() {
  // host 休眠/异常拔线只发 SUSPEND 不发 STOPPED：3s 无 RESUME 视同拔线，
  // 语义对齐 v0.1.x HWCDC 的 SOF 超时（休眠即退出 SYNC 恢复录音）
  if (suspendSince_ && millis() - suspendSince_ > 3000) {
    hostUp_ = false;
    suspendSince_ = 0;
  }
  // 清理事务延迟复挂到点执行（见 storageResume 注释）
  if (reattachAtMs_ && millis() >= reattachAtMs_) {
    reattachAtMs_ = 0;
    if (mediaWasUp_) {
      mediaWasUp_ = false;
      storageAttach();
    }
  }
}

bool hostOnline() { return hostUp_; }

bool storageAttach() {
  sdmmc_card_t *card = rec_ ? rec_->sdCard() : nullptr;
  if (!card) return false;  // 无卡/挂载失败：SYNC 态照进，U 盘不挂
  msc.begin(card->csd.capacity, 512);  // begin 仅存参数（容量/块大小），任意时刻可调
  msc.mediaPresent(true);              // host 侧立即出现可挂载卷
  mediaUp_ = true;
  return true;
}

void storageDetach() {
  if (!mediaUp_) return;
  msc.mediaPresent(false);  // 通知 host 退盘（此后固件恢复独占写卡）
  mediaUp_ = false;
  reattachAtMs_ = 0;  // 退盘即取消待复挂（拔线/异常路径防僵尸挂载）
  mediaWasUp_ = false;
}

void storageSuspend() {
  mediaWasUp_ = mediaUp_;
  if (mediaUp_) storageDetach();
}

// RMEND 延迟复挂（tick 到点执行）：清理事务全程仅 ~1-2s 时，macOS 可能没来得及
// 走完卸载就把「卷还在」当成无事发生——Finder 窗口滞留旧目录。留 4s 空窗
// 逼 host 完成卸载，复挂即全新挂载（Finder 也随新挂载刷新）
void storageResume() {
  if (mediaWasUp_ && !reattachAtMs_) reattachAtMs_ = millis() + 4000;
  else mediaWasUp_ = false;  // 本就没挂过/已取消：无事
}

}  // namespace pod::usb
