#pragma once
#include <Arduino.h>

/**
 * pod_board — 板卡服务层（电源闩锁 / 绿灯 / 电池 / 按键 / RTC）
 * ============================================================
 * 引脚与行为依据 docs/interaction-design.md §1/§5/§7/§8（2026-08-17 实测定案）。
 * 纯服务层无业务状态机，PodController（main.cpp）按交互矩阵分派事件。
 */
namespace pod {

// ---- 电源闩锁（BAT_Control=GPIO17）----
void latchTakeover();  // 开机第一件事：拉高接管供电（电池模式松手前完成）
void powerOff();       // 真关机：拉低物理断电（仅电池模式有效，USB 直供断不掉）

// ---- 绿灯（GPIO3 低亮）----
enum class Led : uint8_t { OFF, ON, BLINK_500MS };
void setLed(Led mode);
void ledTick();  // loop 里每次调用（快闪计时）

// ---- 电池（GPIO4 ÷2 分压查表，§8.1）----
struct Battery {
  float volts;
  int pct;
  bool charging;  // USB 在线 = ETA6098 充电中
};
void batteryInit();
Battery batterySample();  // 8 次均值采样 + 查表；charging 取 USB 在线

// ---- 按键（BOOT=GPIO0 / PWR=GPIO18，交互矩阵见 §5）----
enum class KeyEvent : uint8_t {
  NONE = 0,
  BOOT_SHORT,   // <1s：录音=切段 / 非录音=刷新状态页
  BOOT_HOLD3S,  // ≥3s：静音 ↔ 恢复
  BOOT_HOLD5S,  // ≥5s：仅 ERROR 态 = 格式化确认（v0.1.0 提示走电脑）
  PWR_HOLD3S,   // ≥3s：关机（USB 在线时由上层拦下并提示）
};
KeyEvent keyPoll();  // loop 里每次调用，返回本周期事件（沿触发，不重复）

// ---- RTC（PCF85063，I2C 0x51；关机存活 → 全固件时间权威）----
struct RtcTime {
  uint8_t y, mo, d, h, mi, s;  // y = 2000+xx
};
// 启动自检·时间项（唯一调用处 setup）：芯片自报有效（ACK+OS=0，晶振持续走时）
// → 无条件采纳为系统时钟，不做编译时间比较；无芯片/停振 → 编译时间兜底起步
// （有芯片则写回重新走时），返回 false 待插线校准
bool rtcBegin();
bool rtcRead(RtcTime &t);
// 统一校时入口：settimeofday + 写 RTC 芯片一次完成（无芯片则只设系统时钟）。
// 之后全固件 time()/localtime_r（录音文件名/日志时间戳）自动跟随；屏幕直读芯片
void rtcSet(time_t unixSec);

}  // namespace pod
