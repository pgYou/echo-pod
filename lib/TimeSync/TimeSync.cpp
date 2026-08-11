#include "TimeSync.h"
#include <sys/time.h>
#include <stdio.h>

void TimeSync::begin(Stream &port, const char *tz) {
  port_ = &port;
  setenv("TZ", tz, 1);
  tzset();
  lineBuf_.reserve(64);
  // 兜底：先用编译时间设 RTC，保证同步前文件名也有合理日期（不准但不至于 1970）
  setRtcFromCompile();
}

void TimeSync::setRtcFromCompile() {
  // __DATE__ 形如 "Jul 26 2026"，__TIME__ 形如 "15:30:45"
  char mmm[4] = {0};
  int year = 2026, mon = 1, day = 1, h = 0, m = 0, s = 0;
  sscanf(__DATE__, "%3s %d %d", mmm, &day, &year);
  sscanf(__TIME__, "%d:%d:%d", &h, &m, &s);
  const char *monStr = "JanFebMarAprMayJunJulAugSepOctNovDec";
  const char *p = strstr(monStr, mmm);
  if (p)
    mon = (int)((p - monStr) / 3 + 1);
  struct tm t = {0};
  t.tm_year = year - 1900;
  t.tm_mon = mon - 1;
  t.tm_mday = day;
  t.tm_hour = h;
  t.tm_min = m;
  t.tm_sec = s;
  time_t now = mktime(&t);
  struct timeval tv = {.tv_sec = now};
  settimeofday(&tv, NULL);
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
  struct timeval tv = {.tv_sec = timestamp};
  settimeofday(&tv, NULL);
  bool wasUnsynced = !synced_;
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
