#pragma once
#include <Arduino.h>
#include <time.h>

/**
 * TimeSync — 串口校时命令解析（SETTIME）
 * ============================================================
 * 职责（v0.1.2 收窄）：只做两件事——设 TZ 时区、非阻塞解析串口
 * "SETTIME:<unix秒>\n" 并经 onSynced 回调交付。自身不设系统时间。
 *
 * 时间权威（pod_board）：开机 rtcBegin 无条件采纳芯片时间（ACK+OS=0 即
 * 有效）；仅芯片失效（无芯片/停振）才用编译时间兜底；校时统一入口
 * pod::rtcSet(unix)——settimeofday + 写 RTC 芯片一起完成，全固件
 * time()/localtime_r（录音文件名 / 日志时间戳 / FAT 时间戳）自动跟随，
 * 屏幕直读芯片一致。
 *
 * 串口协议：电脑发送 "SETTIME:1770000000\n"（Unix 时间戳，秒，UTC）
 * 时区：TZ="CST-8" → localtime_r 显示 UTC+8（中国本地时间），文件名用本地时间
 */
class TimeSync {
public:
  // 同步成功回调（参数：同步到的 Unix 时间戳）
  typedef void (*SyncedCallback)(time_t timestamp);

  // 初始化。port: 监听同步命令的串口；tz: 时区字符串（如 "CST-8"）
  void begin(Stream &port, const char *tz = "CST-8");

  // 在 loop 里反复调用，非阻塞解析串口命令。无数据时立即返回。
  void update();

  // 手动同步（其他时间源如 NTP / 硬件 RTC 可直接调用，复用同一入口）
  void sync(time_t timestamp);

  // ---- 观测 ----
  bool isSynced() const { return synced_; }
  time_t now() const;                                  // 当前 Unix 秒
  void formatNow(char *buf, size_t len, const char *fmt) const; // strftime 格式化
  void onSynced(SyncedCallback cb) { syncedCb_ = cb; }

  // 通用行命令回调：非 SETTIME 的行原样转发（如诊断命令 LISTEN:1/0）
  typedef void (*LineCallback)(const char *line);
  void onLine(LineCallback cb) { lineCb_ = cb; }

private:
  Stream *port_ = nullptr;
  bool synced_ = false;
  SyncedCallback syncedCb_ = nullptr;
  LineCallback lineCb_ = nullptr;
  String lineBuf_; // 串口命令行缓冲
};
