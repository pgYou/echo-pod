#pragma once
#include <Arduino.h>
#include <time.h>

/**
 * TimeSync — 时间同步（串口校时 + 编译时间兜底）
 * ============================================================
 * 职责
 *   管理录音豆的时间来源。begin 时先用编译时间设 RTC（兜底，保证同步前
 *   文件名也有合理日期），然后 update() 持续监听串口的同步命令。收到电脑
 *   发来的 "SETTIME:<unix秒>\n" → settimeofday → 标记已同步 → 回调通知。
 *
 * 为什么不靠 ESP32 软件 RTC
 *   软件 RTC 断电即丢（板子无电池后备）。每次开机需重新校时。录音豆的产品
 *   逻辑是"磁吸底座连电脑自动同步"，插底座时电脑顺便发时间戳校时，零硬件
 *   零网络依赖。符合方案 B（USB 串口同步）。
 *
 * 串口协议
 *   电脑发送："SETTIME:1770000000\n"（Unix 时间戳，秒，UTC）
 *   板子解析 → settimeofday → 后续 time()/localtime 返回正确时间
 *
 * 时区
 *   Unix 时间戳是 UTC 秒，settimeofday 设的也是 UTC。
 *   TZ="CST-8" → localtime_r 显示 UTC+8（中国本地时间）。文件名用本地时间。
 *
 * 可扩展（后续模块）
 *   - WiFi NTP：sync(now_from_ntp) 复用同一接口
 *   - 硬件 RTC（DS3231）：begin 时读 DS3231 → sync()
 *
 * 单一职责：只管"时间来源 + 设 RTC"，不碰 SD/录音（WavRecorder 用 time() 读）。
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

private:
  Stream *port_ = nullptr;
  bool synced_ = false;
  SyncedCallback syncedCb_ = nullptr;
  String lineBuf_; // 串口命令行缓冲

  void setRtcFromCompile(); // 编译时间兜底（__DATE__/__TIME__）
};
