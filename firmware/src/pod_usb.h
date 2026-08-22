#pragma once
#include <Arduino.h>
#include "WavRecorder.h"  // SD 卡句柄（MSC 块读）

/**
 * pod_usb — USB 复合设备服务层（CDC 串口 + MSC U 盘，v0.2.0）
 * ============================================================
 * 栈：TinyUSB（platformio.ini ARDUINO_USB_MODE=0 + ARDUINO_USB_ON_BOOT=0，
 * 栈由本模块在 setup 显式 USB.begin()，保证 MSC 接口先注册进复合描述符；
 * CDC 由 CDC_ON_BOOT 早已注册，Serial 语义不变）。
 *
 * 互斥铁律（software-spec）：同一时刻 SD 只归一方管——
 *   电脑挂 U 盘（SYNC 态）期间固件不写卡（recorder 暂停 + pod_log 关卡写），
 *   MSC 是固件代理的只读块设备（onWrite 恒拒），电脑读、豆子写永不并存。
 *   进 SYNC 先切段收尾当前文件（FAT 落盘干净），再 mediaPresent(true) 挂盘；
 *   拔线 mediaPresent(false) 退盘后恢复监听。切段在 enterSync 已保证。
 *
 * 插线语义（对齐 v0.1.x HWCDC SOF 检测）：
 *   hostOnline = host 枚举完成（ARDUINO_USB_STARTED 事件）。插充电头无枚举
 *   → false → 不进 SYNC 照常录音；电脑休眠 SUSPEND 3s 无 RESUME 视同拔线
 *   （tick() 判定），与旧 SOF 超时行为一致。
 *
 * debug 构建（POD_DEBUG）：主循环永不 enterSync → 永不挂 MSC，插线仅
 *   供电+串口（MSC LUN 无媒体待命，host 侧不可见）。
 *
 * CDC 串口命令（经 main.cpp TimeSync.onLine 分发，本模块不管协议）：
 *   HELLO → 设备自报家门（App 认设备 + 触发自动校时）
 *   TIME? → 回当前 Unix 秒（App 对比漂移）
 *   SETTIME:<unix秒> → 校时（v0.1.x 既有，pod::rtcSet 统一入口）
 */
namespace pod::usb {

// setup 调一次：注册 MSC 元数据/回调 + 插拔事件跟踪 + USB.begin() 启动栈。
// recorder 仅为取 SD 卡句柄（挂盘时判卡就绪 + 按扇区读），须传已构造对象
//（挂载与否在 storageAttach 时才检查，begin 失败的 ERROR 机体也可安全调用）
void begin(WavRecorder &recorder);

// loop 周期调用：SUSPEND 3s 判离（host 休眠=拔线语义）
void tick();

// host 枚举在线（≈ 旧 Serial.isPlugged()；电池 charging 判定同源）
bool hostOnline();

// 挂/退 U 盘（enterSync/exitSync 调用）。attach 时卡未就绪返回 false 不挂
bool storageAttach();
void storageDetach();

// 清理事务（App 清理已同步录音，CDC RMBEGIN/RMEND 驱动）：临时退盘让固件
// 独占删文件，删完复挂——host 重新挂载即见干净 FAT，无陈旧目录缓存。
// 非 SYNC 场景（媒体本就未挂）suspend/resume 无操作
void storageSuspend();
void storageResume();

}  // namespace pod::usb
