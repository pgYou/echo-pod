#include "pod_log.h"
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <dirent.h>
#include <sys/stat.h>

namespace pod::log {

static constexpr const char *LOG_DIR = "/sdcard/echo-pod/.logs";
static constexpr int KEEP_DAYS = 7;

static FILE *logFile_ = nullptr;
static char curDay_[16] = "";

static void dayString(time_t t, char *buf, size_t len) {
  struct tm ti;
  localtime_r(&t, &ti);
  strftime(buf, len, "%Y-%m-%d", &ti);
}

// 开当天日志文件（跨天自动滚动；失败静默 → 仅串口）
static void openToday() {
  char day[16];
  dayString(time(nullptr), day, sizeof(day));
  if (logFile_ && strcmp(day, curDay_) == 0) return;
  if (logFile_) {
    fclose(logFile_);
    logFile_ = nullptr;
  }
  mkdir(LOG_DIR, 0775);
  char path[48];
  snprintf(path, sizeof(path), "%s/%s.log", LOG_DIR, day);
  logFile_ = fopen(path, "a");
  strncpy(curDay_, day, sizeof(curDay_) - 1);
  curDay_[sizeof(curDay_) - 1] = 0;
}

// 清理保留期外的旧日志（文件名即日期，字符串比较即可）
static void cleanup() {
  char cutoff[16];
  dayString(time(nullptr) - (time_t)KEEP_DAYS * 86400, cutoff, sizeof(cutoff));
  DIR *d = opendir(LOG_DIR);
  if (!d) return;
  struct dirent *e;
  while ((e = readdir(d))) {
    size_t l = strlen(e->d_name);
    if (l != 14 || strcmp(e->d_name + l - 4, ".log") != 0) continue;
    char day[11];
    memcpy(day, e->d_name, 10);
    day[10] = 0;
    if (strcmp(day, cutoff) < 0) {
      char p[48];
      snprintf(p, sizeof(p), "%s/%s", LOG_DIR, e->d_name);
      remove(p);
    }
  }
  closedir(d);
}

void begin() {
  openToday();
  cleanup();
  event("==== 设备日志开始 ====\n");
}

void event(const char *fmt, ...) {
  char buf[192];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);

  Serial.print(buf);  // 串口始终输出

  if (logFile_) {
    char ts[12];
    time_t now = time(nullptr);
    struct tm ti;
    localtime_r(&now, &ti);
    strftime(ts, sizeof(ts), "%H:%M:%S ", &ti);
    fputs(ts, logFile_);
    fputs(buf, logFile_);
    fflush(logFile_);
    // fflush 只把 newlib 缓冲刷到 FatFS 内存缓存，FAT 目录项（文件长度）不更新，
    // 断电后日志归零——8-18/8-20 两个 0 字节日志即此（8-19 有内容属写入量运气）。
    // fsync 经 VFS 映射到 f_sync，数据+目录项真正落盘
    fsync(fileno(logFile_));
  }
}

void tick() {
  static uint32_t last = 0;
  if (millis() - last >= 60000) {
    last = millis();
    openToday();
  }
}

}  // namespace pod::log
