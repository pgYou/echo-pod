#pragma once
#include <Arduino.h>

/**
 * pod_display — 墨水屏状态页（统一三段式框架，interaction-design.md §6）
 * ============================================================
 * 底层 = lib/EchoPaper（官方驱动收编 + Painter + 字模）。
 * 顶栏（状态点+名称+电池%常显）/ 主体（各状态）/ 底栏（时间+今日条数）。
 * 黑白屏：警示=双线粗框、充电=电量条白色闪电、录音/低电=实心状态点。
 */
namespace pod {

enum class Page : uint8_t {
  STANDBY,    // 监听中
  RECORDING,  // 录音中（第 N 段）
  MUTED,      // 已暂停
  SYNC,       // USB 同步（电脑已连接）
  LOWBAT,     // 低电警告（红色级别 → 双框警示）
  ERROR_,     // SD 异常
  SHUTDOWN,   // 已关机（断电前最后一帧）
};

struct PageInfo {
  int batteryPct = 0;
  bool charging = false;
  char clock[8] = "--:--";  // RTC 时间（无效则 --:--）
  int todayCount = 0;
  int segNo = 0;  // 仅 RECORDING 页使用
};

void displayBegin();                     // 屏上电 + 白底基线 + 局部刷新模式
void showPage(Page p, const PageInfo &i);  // 渲染并快刷（~600ms）

}  // namespace pod
