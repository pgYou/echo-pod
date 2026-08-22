/**
 * 录音豆 echo-pod 正式固件
 * ============================================================
 * v0.2.2 · 2026-08-20 · 微雪 ESP32-S3-ePaper-1.54（V2，N8R8，黑白屏）
 *
 * 组装：WavRecorder（VAD 自动录音，ES8311 + SD_MMC 后端）
 *     + pod_board（电源闩锁/绿灯/电池/按键/RTC）
 *     + pod_display（七状态页）
 *     + pod_usb（v0.2.0：TinyUSB 复合设备 CDC 串口 + MSC 只读 U 盘）
 *     + TimeSync（串口 CDC 校时，插线时电脑/App 可下发 SETTIME）
 * 交互矩阵：docs/interaction-design.md §5（短按归档、长按闭麦/关机）
 *
 * 已实现：VAD 自动录 + 切段 + 协议命名 + .echo-pod 开卡 + 全套交互 + 低电保护
 * v0.2.1：插电脑 = U 盘 + 串口（块代理只读同步，拔线复录）+ ERROR 态固件内
 *         格式化（长按 BOOT 5s）+ 清理事务（RMBEGIN/RM/RMEND，App 清理代删）；
 *         校时通道升级为 App 自动（HELLO/SETTIME）
 */
#include <Arduino.h>
#include <time.h>
#include <esp_mac.h>
#include <Wire.h>
#include <dirent.h>
#include <unistd.h>
#include "pod_log.h"
#include "config.h"
#include "pod_board.h"
#include "pod_display.h"
#include "pod_usb.h"
#include "TimeSync.h"
#include "WavRecorder.h"

// ---- 全局状态 ----
static WavRecorder recorder;
static TimeSync timeSync;

enum class PodMode : uint8_t {
  NORMAL,   // STANDBY ⇄ RECORDING（VAD 自动）+ MUTED
  SYNC,     // USB 在线：录音暂停
  LOWBAT,   // 低电：倒计时强制关机
  ERROR_,   // SD 异常
};
static PodMode mode = PodMode::NORMAL;
static bool recorderFsReady = false;  // recorder.begin 成功（fs 可用）
static bool muted = false;         // NORMAL 内的静音子态
static bool usbListenHold = false; // LISTEN:1 诊断：挂起「插线→同步暂停」策略，插线保持监听
static bool usbWasPlugged = false;

static pod::Battery battery;
static int todayCount = 0;         // 今日归档段数（≥minRecordBytes 才计；开机从 SD 恢复）
static uint32_t lastBatteryMs = 0;
static uint32_t lowBatSince = 0;   // LOWBAT 进入时刻

// ---- 启动全参数 dump（版本 + 硬件 + VAD + 交互阈值，复现调参的单一事实来源）----
static void dumpConfig() {
  auto hw = makeHardwareConfig();
  auto vad = makeVadParams();
  pod::log::event("---- 参数 ----\n");
  pod::log::event("音频: %s %dHz | 存储: %s %s\n",
                hw.useEs8311 ? "ES8311(I2S STD)" : "PDM",
                hw.sampleRate,
                hw.useSdMmc ? "SD_MMC 1-bit" : "SPI SD", hw.recordDir);
  pod::log::event("预滚 %uB(~%us) 最长段 %us 最短段 %uB\n",
                (unsigned)hw.ringBytes,
                (unsigned)(hw.ringBytes / (hw.sampleRate * 2)),
                (unsigned)(hw.maxRecordMs / 1000), (unsigned)hw.minRecordBytes);
  pod::log::event("VAD: mode=%d frame=%dms attack=%.2f release=%.2f/%.2f(act/idle)\n",
                (int)vad.vadMode, vad.frameMs, vad.attack, vad.release, vad.releaseIdle);
  pod::log::event("     阈值 high=%.2f mid=%.2f low=%.2f hangover=%dms warmup=%dms window=%d\n",
                vad.highThreshold, vad.midThreshold, vad.lowThreshold,
                (int)vad.hangoverMs, (int)vad.warmupMs, vad.frameWindow);
  pod::log::event("构建: %s | USB: CDC+MSC只读盘 | 交互: 短按<%ums 长按%ums 格式化%ums | 低电%d%%→%us关机\n",
#ifdef POD_DEBUG
                "debug（插线不进同步）",
#else
                "release",
#endif
                (unsigned)KEY_SHORT_MS, (unsigned)KEY_HOLD_MS,
                (unsigned)KEY_FORMAT_MS, BAT_LOW_PCT,
                (unsigned)(LOWBAT_SHUTDOWN_MS / 1000));
}

// ---- 屏幕刷新（所有状态变化 / 手动刷新 / 切段都走这里）----
static void renderPage() {
  pod::PageInfo info;
  info.batteryPct = battery.pct;
  info.charging = battery.charging;

  pod::RtcTime rt;
  if (pod::rtcRead(rt))
    snprintf(info.clock, sizeof(info.clock), "%02d:%02d", rt.h, rt.mi);
  info.todayCount = todayCount;
  info.segNo = todayCount + 1;  // 正在录的是下一序号

  using P = pod::Page;
  pod::Page page = P::STANDBY;
  switch (mode) {
    case PodMode::SYNC: page = P::SYNC; break;
    case PodMode::LOWBAT: page = P::LOWBAT; break;
    case PodMode::ERROR_: page = P::ERROR_; break;
    case PodMode::NORMAL:
      if (recorder.getState() == WavRecorder::State::RECORDING) page = P::RECORDING;
      else if (muted) page = P::MUTED;
      break;
  }
  pod::showPage(page, info);
}

// ---- 关机（PWR 软闩锁真断电；USB 在线时拦下并提示）----
static void requestShutdown() {
  if (recorder.getState() == WavRecorder::State::RECORDING) recorder.splitSegment();
  pod::setLed(pod::Led::OFF);
  pod::log::event("== PWR 长按 3s：关机 ==\n");
  pod::showPage(pod::Page::SHUTDOWN, pod::PageInfo{});
  delay(2500);  // 让用户看清（电池断电后墨水屏画面驻留）
  if (!battery.charging) {
    pod::log::event("物理断电（GPIO17 拉低）—— bye\n");
    Serial.flush();
    pod::powerOff();
    for (;;) delay(1000);  // 若仍活着 = USB 供电
  }
  pod::log::event("USB 供电中关不掉 → 回到待机（拔线后长按 PWR 真关机）\n");
}

// ---- WavRecorder 回调 ----
static void onRecorderState(WavRecorder::State s) {
  if (s == WavRecorder::State::RECORDING) {
    pod::setLed(pod::Led::ON);  // 录音常亮（interaction-design §7，v0.1.0 漏驱动实测补）
    pod::log::event("[rec] >>> %s (vad score=%.2f ratio=%.2f ≥high=%.2f, peak=%d, 第%d段)\n",
                  recorder.getCurrentPath(), recorder.getVadScore(), recorder.getVadRatio(),
                  makeVadParams().highThreshold, recorder.getLastFramePeak(),
                  todayCount + 1);
  } else {
    uint32_t bytes = recorder.getDataBytes();
    bool valid = bytes >= makeHardwareConfig().minRecordBytes;
    if (valid) todayCount++;
    pod::log::event("[rec] <<< %luB %.1fs score=%.2f lowMs=%ums %s\n",
                  (unsigned long)bytes, recorder.getRecordMs() / 1000.0,
                  recorder.getVadScore(), (unsigned)recorder.getVadLowMs(),
                  valid ? "(归档)" : "(过短已删)");
    if (mode == PodMode::NORMAL) pod::setLed(pod::Led::OFF);  // 回监听灭灯（含静音收尾切段；MUTED 态灯=灭，§7）
  }
  renderPage();  // 段落切换刷屏（RECORDING↔STANDBY / 切段后新段号）
}

static void onRecorderError(const char *msg) {
  pod::log::event("[rec] X %s\n", msg);
  // SD 类错误升级 ERROR 态：数据完整性优先，继续监听无意义（重新插卡后重启恢复）
  if (strstr(msg, "SD")) {
    mode = PodMode::ERROR_;
    pod::setLed(pod::Led::OFF);
    renderPage();
    pod::log::event("[pod] SD 异常 → ERROR 态（重新插卡后重启设备）\n");
  }
}

static void enterSync();  // 定义在下方（setup 先用）

// ---- 今日段数恢复（跨重启续算：扫今天日期目录的 .wav 数）----
static int countTodayWavs() {
  time_t now;
  time(&now);
  struct tm ti;
  localtime_r(&now, &ti);
  char dir[48];
  strftime(dir, sizeof(dir), "/sdcard/echo-pod/%Y-%m-%d", &ti);
  DIR *d = opendir(dir);
  if (!d) return 0;
  int n = 0;
  struct dirent *e;
  while ((e = readdir(d))) {
    size_t l = strlen(e->d_name);
    if (l >= 4 && strcasecmp(e->d_name + l - 4, ".wav") == 0) n++;
  }
  closedir(d);
  return n;
}

// ---- .echo-pod 标志文件（device-protocol.md v1.0；无则开卡写入）----

// 设备串行号（efuse MAC 后 4 字节，协议格式 ES3-XXXXXXXX；标志文件与
// CDC HELLO 应答共用，首取后缓存）
static const char *podSerial() {
  static char serial[16];
  static bool cached = false;
  if (!cached) {
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(serial, sizeof(serial), "ES3-%02X%02X%02X%02X", mac[2], mac[3], mac[4], mac[5]);
    cached = true;
  }
  return serial;
}

static void ensureMarker() {
  String path = String(SD_ROOT) + "/.echo-pod";
  FILE *fr = fopen(path.c_str(), "rb");
  if (fr) {
    char content[256] = {0};
    (void)!fread(content, 1, sizeof(content) - 1, fr);
    fclose(fr);
    if (strstr(content, "\"fw\": \"" FW_VERSION "\"")) return;  // 版本一致，不动
  }
  // 串行号见 podSerial()（efuse MAC 后 4 字节，与 HELLO 应答同源）

  time_t now;
  time(&now);
  struct tm ti;
  localtime_r(&now, &ti);
  char created[32];
  strftime(created, sizeof(created), "%Y-%m-%dT%H:%M:%S+08:00", &ti);

  char json[256];
  snprintf(json, sizeof(json),
           "{\n"
           "  \"device\": \"%s\",\n"
           "  \"serial\": \"%s\",\n"
           "  \"fw\": \"%s\",\n"
           "  \"hw\": \"%s\",\n"
           "  \"tz\": \"+08:00\",\n"
           "  \"created\": \"%s\"\n"
           "}\n",
           FW_NAME, podSerial(), FW_VERSION, HW_ID, created);
  FILE *f = fopen(path.c_str(), "wb");
  if (f) {
    size_t n = fwrite(json, 1, strlen(json), f);
    fclose(f);
    pod::log::event("[sd] 标志文件已写入 serial=%s fw=%s（%uB）\n", podSerial(), FW_VERSION, (unsigned)n);
  } else {
    pod::log::event("[sd] X 标志文件写入失败（open 失败）\n");
  }
}

// ---- SD 热拔探测（异常可观测：读标志文件 1 字节，真实 IO 才能暴露拔卡）----
static bool sdProbeOk() {
  FILE *f = fopen((String(SD_ROOT) + "/.echo-pod").c_str(), "rb");
  if (!f) return false;
  int c = fgetc(f);  // 拔卡后 open/读会随 host 超时失败
  fclose(f);
  return c >= 0;
}

// ---- CDC 清理事务（App 清理已同步录音，device-protocol §6）----
// RMBEGIN → RM:echo-pod/…/xx.wav ×N → RMEND：退盘让固件独占删，删完复挂
//（host 重挂即见干净 FAT）。只放行录音目录下的 .wav（防穿越/不碰 .logs）
static bool rmPathValid(const char *rel) {
  size_t l = strlen(rel);
  if (l < 10 || l > 80 || strncmp(rel, "echo-pod/", 9) != 0) return false;
  if (strstr(rel, "..") || strstr(rel, "/.")) return false;  // 含 .logs 与目录穿越
  return strcasecmp(rel + l - 4, ".wav") == 0;
}

// RMEND 收尾：顺手清空日期目录（App 侧不再直接 rmdir——只读卷做不到了）
static void pruneEmptyDayDirs() {
  char root[48];
  snprintf(root, sizeof(root), "%s/echo-pod", SD_ROOT);
  DIR *d = opendir(root);
  if (!d) return;
  struct dirent *e;
  while ((e = readdir(d))) {
    if (e->d_name[0] == '.') continue;
    char p[64];
    snprintf(p, sizeof(p), "%s/%s", root, e->d_name);
    DIR *sub = opendir(p);
    if (!sub) continue;
    bool empty = true;
    struct dirent *se;
    while ((se = readdir(sub))) {
      if (se->d_name[0] != '.') {  // . 与 .. 之外有内容即非空
        empty = false;
        break;
      }
    }
    closedir(sub);
    if (empty) rmdir(p);
  }
  closedir(d);
}

// ---- setup ----
void setup() {
  // 电池模式开机时序：必须最先接管供电闩锁（松开 PWR 前完成）
  pod::latchTakeover();

  Serial.begin(115200);
  // CDC 接收缓冲 256→1024B：App 侧清理事务已改一问一答，这里只是加固——
  // 0.2.1 首验实测突发批量写会溢出丢字节/熔行（详见 CHANGELOG v0.2.1）
  Serial.setRxBufferSize(1024);
  // TZ 尽早设：否则重启后头两条卡日志按 UTC 显示（实测 14:25 vs 本地 22:25
  // 差 8h——TimeSync.begin 设 TZ 在 pod_log::begin 之后才跑）。TimeSync 重复设无害
  setenv("TZ", "CST-8", 1);
  tzset();
  delay(1500);
  pod::log::event("\n=== %s v%s%s（%s）===\n", FW_NAME, FW_VERSION,
#ifdef POD_DEBUG
                  " debug",
#else
                  "",
#endif
                  HW_ID);

  // ---- I2C 最早诊断（在其他模块碰总线前）----
  {
    bool ok = Wire.begin(47, 48);
    Serial.printf("[diag] Wire.begin(47,48) → %d\n", ok);
    // 关键器件 ACK 探测：0=应答正常
    Wire.beginTransmission(0x51);  // PCF85063 RTC
    Serial.printf("[diag] RTC(0x51) probe → %d\n", Wire.endTransmission(true));
    Wire.beginTransmission(0x18);  // ES8311 codec
    Serial.printf("[diag] ES8311(0x18) probe → %d\n", Wire.endTransmission(true));
    Wire.beginTransmission(0x70);  // SHTC3
    Serial.printf("[diag] SHTC3(0x70) probe → %d\n", Wire.endTransmission(true));
    // 引脚电平（释放后靠上拉应=1；0 = 总线被某器件拉死）
    Wire.end();
    pinMode(47, INPUT_PULLUP);
    pinMode(48, INPUT_PULLUP);
    delay(2);
    Serial.printf("[diag] 空闲电平 SDA(47)=%d SCL(48)=%d（正常 1/1）\n", digitalRead(47),
                  digitalRead(48));
    // 注意：SDA=0 时 Wire.end 已释放驱动，下面的 rtcBegin 会做总线恢复
  }

  pinMode(PIN_LED_GREEN, OUTPUT);  // setLed 前置
  pod::setLed(pod::Led::OFF);
  pod::batteryInit();

  // ---- 启动自检（暂只有时间项；后续可扩展 SD 卡/屏幕/电池自检项）----
  // 时间：外部 RTC 芯片为唯一权威（ACK+OS=0 无条件采纳）；结果详打在 [自检·时间] 行
  pod::rtcBegin();

  // 屏幕先起（SD 异常也立刻有显示）
  pod::displayBegin();
  pod::setLed(pod::Led::ON);  // 开机自检：亮 200ms
  delay(200);
  pod::setLed(pod::Led::OFF);

  // USB 复合栈（CDC + MSC）尽早启动：ERROR 机体也有串口诊断通道。
  // MSC 此刻无媒体（enterSync 才挂盘），卡未就绪不阻碍栈起来
  pod::usb::begin(recorder);

  // 录音链路（ES8311 + SD_MMC + VAD）。回调先注册：begin 阶段的失败细节
  // （SD 挂载 / ES8311 / I2S）经 onError 打出——此前注册在后，细节被吞
  recorder.onStateChange(onRecorderState);
  recorder.onError(onRecorderError);
  if (!recorder.begin(makeHardwareConfig(), makeVadParams())) {
    // SD 若已挂载则日志上卡（音频失败也有留痕）；未挂载 pod_log 静默降级仅串口
    pod::log::begin();
    pod::log::event("[pod] 录音链路初始化失败（原因见上方错误行）→ ERROR 态（长按 PWR 关机重启）\n");
    mode = PodMode::ERROR_;
    battery = pod::batterySample();
    renderPage();
    return;
  }
  recorderFsReady = true;
  ensureMarker();  // 开卡 / 版本更新（B6）
  pod::log::begin();  // SD 日志开始（之后的 event 双写串口+卡）
  todayCount = countTodayWavs();  // 跨重启续算今日段数
  pod::log::event("[sd] 今日已归档 %d 段（从卡恢复）\n", todayCount);

  // 串口校时通道（电脑可发 "SETTIME:<unix秒>\n"）→ 写入 PCF85063 芯片 + 系统时钟 + 刷屏
  timeSync.begin(Serial, "CST-8");
  timeSync.onSynced([](time_t ts) {
    bool chip = pod::rtcSet(ts);
    // 区分「校时完成」与「半成」：系统钟总在（文件名正确），芯片写回失败屏幕
    // 仍走旧时间（v0.2.2 前此失败静默——芯片漂移恒慢正是它的指纹）
    if (chip) {
      pod::log::event("[rtc] 校时完成（系统 + 芯片写回 ✓）\n");
    } else {
      pod::log::event("[rtc] X 校时半成：系统已设，芯片写回失败（查 I2C/芯片在场）\n");
    }
    renderPage();
  });
  // 通用串口命令（经 TimeSync 行转发）：LISTEN:1 = 插线保持监听（诊断 VAD 用，
  // 破「插线即同步暂停、无法边连串口边观测」死锁）；LISTEN:0 = 恢复自动策略；
  // HELLO = 设备自报家门（App 认设备 → 自动下发 SETTIME 校时）；
  // TIME? = 回当前 Unix 秒（人工/诊断查漂移）
  timeSync.onLine([](const char *line) {
    if (strcmp(line, "LISTEN:1") == 0) {
      usbListenHold = true;
      if (mode == PodMode::SYNC) {
        mode = PodMode::NORMAL;
        recorder.setPaused(false);
        pod::setLed(pod::Led::OFF);
        renderPage();
      }
      pod::log::event("[usb] LISTEN:1 诊断模式：USB 在线保持监听（插线自动同步已挂起）\n");
    } else if (strcmp(line, "LISTEN:0") == 0) {
      usbListenHold = false;
      if (pod::usb::hostOnline() && mode == PodMode::NORMAL) {
        mode = PodMode::SYNC;
        recorder.setPaused(true);
        if (recorder.getState() == WavRecorder::State::RECORDING)
          recorder.splitSegment();
        pod::setLed(pod::Led::BLINK_500MS);
        renderPage();
        pod::log::event("[usb] LISTEN:0 + USB 在线 → 同步态（录音暂停）\n");
      } else {
        pod::log::event("[usb] LISTEN:0 恢复插线自动同步策略\n");
      }
    } else if (strcmp(line, "HELLO") == 0) {
      // App 设备识别握手：应答后 App 紧跟 SETTIME 下发（插线自动校时）
      Serial.printf("[pod] HELLO fw=%s hw=%s serial=%s\n", FW_VERSION, HW_ID, podSerial());
    } else if (strcmp(line, "TIME?") == 0) {
      time_t now;
      time(&now);
      Serial.printf("[pod] TIME %lld\n", (long long)now);
    } else if (strcmp(line, "RMBEGIN") == 0) {
      pod::usb::storageSuspend();  // 退盘：清理事务期间固件独占卡（互斥铁律）
      Serial.println("[pod] RM BEGIN");
    } else if (strncmp(line, "RM:", 3) == 0) {
      const char *rel = line + 3;
      if (!rmPathValid(rel)) {
        Serial.printf("[pod] RM ERR %s\n", rel);
      } else {
        char p[96];
        snprintf(p, sizeof(p), "%s/%s", SD_ROOT, rel);
        Serial.printf(remove(p) == 0 ? "[pod] RM OK %s\n" : "[pod] RM ERR %s\n", rel);
      }
    } else if (strcmp(line, "RMEND") == 0) {
      pruneEmptyDayDirs();
      pod::usb::storageResume();  // 复挂：host 重新挂载即见干净 FAT
      Serial.println("[pod] RM END");
    }
  });

  battery = pod::batterySample();
  pod::log::event("[bat] 首采 %.2fV %d%%%s\n", battery.volts, battery.pct,
                battery.charging ? " 充电中" : "");
  dumpConfig();
#ifdef POD_DEBUG
  usbListenHold = true;  // debug 构建：永久挂起插线同步（插线=供电+串口，录音不中断）
#endif
  usbWasPlugged = battery.charging;
  if (usbWasPlugged && !usbListenHold) enterSync();  // 插着线上电：直接同步态
  else renderPage();
  Serial.println(usbWasPlugged ? "[pod] 就绪：USB 在线，同步态（拔线即恢复监听）"
                                : "[pod] 就绪：VAD 监听中");
}

// ---- SYNC 进出（v0.2.0：切段收尾 → 挂只读 U 盘；拔线退盘复录）----
static void enterSync() {
  mode = PodMode::SYNC;
  recorder.setPaused(true);  // 正在录则先切段（保留预滚衔接；切段收尾=FAT 落盘干净）
  if (recorder.getState() == WavRecorder::State::RECORDING) recorder.splitSegment();
  pod::log::setCardEnabled(false);  // 互斥铁律：U 盘期间固件侧不再写卡（串口照常）
  bool diskUp = pod::usb::storageAttach();
  battery = pod::batterySample();  // 插拔沿取新鲜样：charging 不再用 ≤60s 旧快照（⚡ 时序 bug）
  pod::setLed(pod::Led::BLINK_500MS);
  renderPage();
  pod::log::event("[usb] 插入 → 同步态（%s，录音暂停）\n",
                  diskUp ? "U 盘已挂载，电脑可直接读" : "无卡：U 盘未挂载");
}

static void exitSync() {
  pod::usb::storageDetach();        // 先退盘：host 侧卷消失，固件收回 SD 独占权
  pod::log::setCardEnabled(true);
  mode = PodMode::NORMAL;
  recorder.setPaused(false);
  battery = pod::batterySample();  // 同上：拔线沿新鲜样，防 ⚡ 残留
  pod::setLed(pod::Led::OFF);
  renderPage();
  pod::log::event("[usb] 拔出 → 退盘，恢复监听\n");
}

// ---- loop ----
void loop() {
  // 1. 按键（交互矩阵 interaction-design.md §5）
  switch (pod::keyPoll()) {
    case pod::KeyEvent::BOOT_SHORT:
      if (mode == PodMode::NORMAL &&
          recorder.getState() == WavRecorder::State::RECORDING) {
        recorder.splitSegment();  // 切段：归档+立即开新段（仍在说话）
        pod::log::event("[key] BOOT 短按 → 切段 (vad score=%.2f，%s)\n",
                      recorder.getVadScore(),
                      recorder.getVadScore() >= makeVadParams().highThreshold
                          ? "仍激活，将自动开新段" : "已静，回监听");
      } else {
        battery = pod::batterySample();  // 手动刷新状态页（时间/电量/充电态）
        renderPage();
        pod::log::event("[key] BOOT 短按 → 刷新状态页\n");
      }
      break;
    case pod::KeyEvent::BOOT_HOLD3S:
      if (mode == PodMode::NORMAL) {
        muted = !muted;
        recorder.setPaused(muted);
        if (muted && recorder.getState() == WavRecorder::State::RECORDING)
          recorder.splitSegment();  // 静音前收尾
        renderPage();
        pod::log::event("[key] BOOT 长按 → %s\n", muted ? "静音（已暂停）" : "恢复监听");
      }
      break;
    case pod::KeyEvent::BOOT_HOLD5S:
      // 固件内格式化（firmware-plan B6）：仅 ERROR 态（SD 挂载失败）可达，
      // 双重确认 = 屏显异常提示 + 5s 长按；挂载成功路径不存在格式化入口，
      // 「已有录音拒绝格式化」由构造保证（卡可读则原样挂回、绝不 f_mkfs）
      if (mode == PodMode::ERROR_) {
        pod::log::event("[sd] 格式化确认（长按 5s）：卸载重挂，失败则 FAT 重格…\n");
        if (recorder.rescueMount(true)) {
          pod::log::event("[sd] 挂载成功（无需格式化则原样保留）→ 重启恢复完整链路\n");
          Serial.flush();
          delay(1500);
          esp_restart();  // 重走开机流：录音链路 + ensureMarker 开卡
        }
        pod::log::event("[sd] X 格式化失败（多半无卡）——插卡后长按 BOOT 重试，或用电脑 FAT32 格式化\n");
      }
      break;
    case pod::KeyEvent::PWR_HOLD3S:
      if (mode != PodMode::SYNC) requestShutdown();  // USB 在线不关机（§5）
      else pod::log::event("[key] USB 供电中关不掉，拔线后长按 PWR\n");
      break;
    default:
      break;
  }
  pod::ledTick();
  pod::log::tick();
  pod::usb::tick();  // SUSPEND 3s 判离（host 休眠=拔线，退出 SYNC 恢复录音）

  // 2. ERROR 态：插回检测提示 + 电池周期采样（录音链路未起）
  if (mode == PodMode::ERROR_) {
    static uint32_t lastSdHint = 0;
    static bool cardBack = false;
    if (!cardBack && recorderFsReady && millis() - lastSdHint > 30000) {
      lastSdHint = millis();
      if (sdProbeOk()) {  // 开机即无卡的场景 fs() 不可用，靠 recorderFsReady 区分
        cardBack = true;
        pod::log::event("[sd] 卡已插回：长按 PWR 关机后再开机恢复录音\n");
      }
    }
    if (millis() - lastBatteryMs > 60000) {
      lastBatteryMs = millis();
      battery = pod::batterySample();
      if (battery.pct <= BAT_LOW_PCT && !battery.charging) {
        pod::log::event("[bat] 低电 → 关机\n");
        requestShutdown();
      }
    }
    return;
  }

  // 3. USB 插拔沿 → SYNC 进出（LISTEN:1 诊断时挂起：插线不进 SYNC；拔线若在 SYNC 才恢复）
  bool plugged = pod::usb::hostOnline();  // 实时检测（battery.charging 是 60s 快照）
  if (plugged != usbWasPlugged) {
    usbWasPlugged = plugged;
    if (plugged) {
      if (!usbListenHold) enterSync();
    } else if (mode == PodMode::SYNC) {
      exitSync();
    }
  }

  // 4. 录音步进（SYNC 态 paused 内部丢帧；MUTED 同理）
  recorder.step();

  // 5. SD 热拔探测（10s；录音中跳过——写失败路径已覆盖；SYNC 态跳过——
  //    U 盘期间 SD 只归 MSC 读，固件不碰卡；连续 2 次失败才判拔卡防误报）
  static uint32_t lastSdProbe = 0;
  static int sdFailCount = 0;
  if (mode != PodMode::SYNC &&
      recorder.getState() != WavRecorder::State::RECORDING &&
      millis() - lastSdProbe >= 10000) {
    lastSdProbe = millis();
    if (!sdProbeOk()) {
      sdFailCount++;
      pod::log::event("[sd] 探测失败 %d/2\n", sdFailCount);
      if (sdFailCount >= 2) {
        mode = PodMode::ERROR_;
        pod::setLed(pod::Led::OFF);
        renderPage();
        pod::log::event("[sd] 连续失败 → 判定卡拔出，ERROR 态（插回后长按 PWR 重开机恢复）\n");
        return;
      }
    } else {
      sdFailCount = 0;
    }
  }

  // 6. 电池周期采样（60s；百分比不刷屏——跨阈值随下一次自然刷新体现；
  //    充电态翻转例外：立即刷一次，⚡ 图标与红灯对齐 ≤60s）
  if (millis() - lastBatteryMs > 60000) {
    bool chgWas = battery.charging;
    lastBatteryMs = millis();
    battery = pod::batterySample();
    if (battery.charging != chgWas) renderPage();
    pod::log::event("[bat] %.2fV %d%%%s\n", battery.volts, battery.pct,
                  battery.charging ? " 充电中" : "");
  }

  // 6. 低电保护（<8% 且未充电 → 警告屏 + 60s 强制关机；插线即解除）
  if (mode == PodMode::LOWBAT) {
    if (battery.charging || battery.pct > BAT_LOW_PCT) {
      mode = PodMode::NORMAL;  // 解除
      renderPage();
      pod::log::event("[bat] 低电解除\n");
    } else if (millis() - lowBatSince > LOWBAT_SHUTDOWN_MS) {
      pod::log::event("[bat] 低电 60s 到 → 强制关机\n");
      requestShutdown();
    }
  } else if (battery.pct <= BAT_LOW_PCT && !battery.charging) {
    mode = PodMode::LOWBAT;
    lowBatSince = millis();
    if (recorder.getState() == WavRecorder::State::RECORDING) recorder.splitSegment();
    pod::setLed(pod::Led::OFF);
    renderPage();  // 强制刷警告屏（§6.3 唯一允许的电量触发刷新）
    pod::log::event("[bat] 低电警告（60s 后自动关机）\n");
  }

  // 7. VAD 心跳：调参观测。release = 串口 5s；debug（POD_DEBUG）= 串口 500ms 高频，
  //    三层分开看：ratio=窗口原始语音占比（包络前） / score=attack/release 包络后 /
  //    peak=音频峰值——能量门与阈值调参依据。空闲时每 30s 落卡一份（电池场景
  //    无串口也能复盘；录音中不写卡防干扰 WAV 顺序写）
  static uint32_t lastVadLog = 0;
  static uint32_t lastVadCard = 0;
#ifdef POD_DEBUG
  static uint32_t lastVadDbg = 0;
  if (millis() - lastVadDbg >= 500) {
    lastVadDbg = millis();
    Serial.printf("[vad+] ratio=%.2f score=%.2f peak=%d lowMs=%ums %s\n",
                  recorder.getVadRatio(), recorder.getVadScore(),
                  recorder.getLastFramePeak(), (unsigned)recorder.getVadLowMs(),
                  recorder.getState() == WavRecorder::State::RECORDING ? "录音中" : "监听");
  }
#endif
  if (millis() - lastVadLog >= 5000) {
    lastVadLog = millis();
    bool rec = recorder.getState() == WavRecorder::State::RECORDING;
#ifndef POD_DEBUG
    Serial.printf("[vad] score=%.2f peak=%d lowMs=%ums %s\n", recorder.getVadScore(),
                  recorder.getLastFramePeak(), (unsigned)recorder.getVadLowMs(),
                  rec ? "录音中" : "监听");
#endif
    if (!rec && millis() - lastVadCard >= 30000) {
      lastVadCard = millis();
      pod::log::event("[vad] score=%.2f peak=%d\n", recorder.getVadScore(),
                      recorder.getLastFramePeak());
    }
  }

  // 8. 串口校时（TimeSync：电脑发 "SETTIME:<unix秒>\n"，插线时可用）
  timeSync.update();

  // 9. 分钟沿刷屏（时钟走字）：每秒查 RTC 分钟，变化才刷——残影只来自变化的分钟
  //    数字，同分钟零驱动；600ms 阻塞由 2s 预滚环吸收（切段刷屏同机制已验证）。
  //    电量百分比也随每分钟刷新自然跟进（不用等状态事件）
  static uint32_t lastMinPoll = 0;
  static int lastMin = -1;
  if (millis() - lastMinPoll >= 1000) {
    lastMinPoll = millis();
    pod::RtcTime rt;
    if (pod::rtcRead(rt) && rt.mi != lastMin) {
      lastMin = rt.mi;
      renderPage();
    }
  }

  delay(2);  // 让键扫描/串口有呼吸
}
