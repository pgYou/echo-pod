#include "TimeSync.h"
#include <stdio.h>

void TimeSync::begin(Stream &port, const char *tz) {
  port_ = &port;
  setenv("TZ", tz, 1);  // localtime_r（文件名/日志时间戳）显示时区
  tzset();
  lineBuf_.reserve(64);
  // 只管时区与串口命令，不设时间——时间权威在 pod_board（rtcBegin：RTC 芯片
  // 为准，编译时间兜底）。v0.1.1 曾在此无条件 settimeofday(编译时间)，每次
  // 开机把有效 RTC 时间砸掉，文件名日期永远停在编译日（v0.1.2 移除）
}

void TimeSync::update() {
  if (!port_)
    return;
  // 非阻塞读：有数据才处理，无数据立即返回
  while (port_->available()) {
    char c = (char)port_->read();
    if (c == '\n') {
      // 解析行命令
      static const char prefix[] = "SETTIME:";
      const int prefixLen = sizeof(prefix) - 1;
      if (lineBuf_.startsWith(prefix) && lineBuf_.length() > prefixLen) {
        time_t ts = (time_t)lineBuf_.substring(prefixLen).toInt();
        sync(ts);
      } else if (lineCb_) {
        lineCb_(lineBuf_.c_str());  // 非 SETTIME 行转发（如 LISTEN:1/0）
      }
      lineBuf_ = "";
    } else if (c != '\r' && isPrintable(c)) {
      // 防缓冲区无限增长（异常输入兜底）
      if (lineBuf_.length() < 64)
        lineBuf_ += c;
    }
  }
}

void TimeSync::sync(time_t timestamp) {
  // 设置动作交回调（main 接 pod::rtcSet 统一入口：系统时钟 + RTC 芯片一起设），
  // 本类不再直接 settimeofday
  synced_ = true;
  if (syncedCb_) {
    syncedCb_(timestamp);
  }
}

time_t TimeSync::now() const {
  time_t t;
  time(&t);
  return t;
}

void TimeSync::formatNow(char *buf, size_t len, const char *fmt) const {
  time_t t = now();
  struct tm ti;
  localtime_r(&t, &ti);
  strftime(buf, len, fmt, &ti);
}
