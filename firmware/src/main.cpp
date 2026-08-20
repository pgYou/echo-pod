/**
 * 录音豆 echo-pod 正式固件
 * ============================================================
 * v0.1.1 · 2026-08-18 · 微雪 ESP32-S3-ePaper-1.54（V2，N8R8，黑白屏）
 *
 * 组装：WavRecorder（VAD 自动录音，ES8311 + SD_MMC 后端）
 *     + pod_board（电源闩锁/绿灯/电池/按键/RTC）
 *     + pod_display（七状态页）
 *     + TimeSync（串口 CDC 校时，插线时电脑可下发 SETTIME）
 * 交互矩阵：docs/interaction-design.md §5（短按归档、长按闭麦/关机）
 *
 * 已实现：VAD 自动录 + 切段 + 协议命名 + .echo-pod 开卡 + 全套交互 + 低电保护
 * v0.2.0 计划：USB-MSC 块代理同步（当前 v0.1.0 插线仅进入同步态暂停录音；
 *             取录音用读卡器插 SD 卡，App 按卷 + .echo-pod 识别同样可用）
 */
#include <Arduino.h>
#include <time.h>
#include <esp_mac.h>
#include <Wire.h>
#include <dirent.h>
#include "pod_log.h"
#include "config.h"
#include "pod_board.h"
#include "pod_display.h"
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
  pod::log::event("交互: 短按<%ums 长按%ums 格式化%ums | 低电%d%%→%us关机\n",
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
    pod::log::event("[rec] >>> %s (vad score=%.2f ≥high=%.2f, 第%d段)\n",
                  recorder.getCurrentPath(), recorder.getVadScore(),
                  makeVadParams().highThreshold, todayCount + 1);
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
static void ensureMarker() {
  String path = String(SD_ROOT) + "/.echo-pod";
  FILE *fr = fopen(path.c_str(), "rb");
  if (fr) {
    char content[256] = {0};
    (void)!fread(content, 1, sizeof(content) - 1, fr);
    fclose(fr);
    if (strstr(content, "\"fw\": \"" FW_VERSION "\"")) return;  // 版本一致，不动
  }
  // 串行号：efuse MAC 后 4 字节（8 hex），协议格式 ES3-XXXXXXXX
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char serial[16];
  snprintf(serial, sizeof(serial), "ES3-%02X%02X%02X%02X", mac[2], mac[3], mac[4], mac[5]);

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
           FW_NAME, serial, FW_VERSION, HW_ID, created);
  FILE *f = fopen(path.c_str(), "wb");
  if (f) {
    size_t n = fwrite(json, 1, strlen(json), f);
    fclose(f);
    pod::log::event("[sd] 标志文件已写入 serial=%s fw=%s（%uB）\n", serial, FW_VERSION, (unsigned)n);
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

// ---- setup ----
void setup() {
  // 电池模式开机时序：必须最先接管供电闩锁（松开 PWR 前完成）
  pod::latchTakeover();

  Serial.begin(115200);
  delay(1500);
  pod::log::event("\n=== %s v%s（%s）===\n", FW_NAME, FW_VERSION, HW_ID);

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

  // RTC：有效 → system time 即为真实时间（关机存活已实测）；掉电 → 编译时间兜底
  bool rtcOk = pod::rtcBegin();
  Serial.println(rtcOk ? "[rtc] 有效，时间可用"
                       : "[rtc] 掉电/无芯片，编译时间兜底（插线可校准）");

  // 屏幕先起（SD 异常也立刻有显示）
  pod::displayBegin();
  pod::setLed(pod::Led::ON);  // 开机自检：亮 200ms
  delay(200);
  pod::setLed(pod::Led::OFF);

  // 录音链路（ES8311 + SD_MMC + VAD）
  if (!recorder.begin(makeHardwareConfig(), makeVadParams())) {
    pod::log::event("[sd] 初始化失败 → ERROR 态（长按 PWR 关机）\n");
    mode = PodMode::ERROR_;
    battery = pod::batterySample();
    renderPage();
    return;
  }
  recorder.onStateChange(onRecorderState);
  recorder.onError(onRecorderError);
  recorderFsReady = true;
  ensureMarker();  // 开卡 / 版本更新（B6）
  pod::log::begin();  // SD 日志开始（之后的 event 双写串口+卡）
  todayCount = countTodayWavs();  // 跨重启续算今日段数
  pod::log::event("[sd] 今日已归档 %d 段（从卡恢复）\n", todayCount);

  // 串口校时通道（电脑可发 "SETTIME:<unix秒>\n"）→ 写入 PCF85063 芯片 + 系统时钟 + 刷屏
  timeSync.begin(Serial, "CST-8");
  timeSync.onSynced([](time_t ts) {
    pod::rtcSet(ts);
    pod::log::event("[rtc] 校时完成（串口 SETTIME → 芯片 + 系统时钟）\n");
    renderPage();
  });

  battery = pod::batterySample();
  pod::log::event("[bat] 首采 %.2fV %d%%%s\n", battery.volts, battery.pct,
                battery.charging ? " 充电中" : "");
  dumpConfig();
  usbWasPlugged = battery.charging;
  if (usbWasPlugged) enterSync();  // 插着线上电：直接同步态
  else renderPage();
  Serial.println(usbWasPlugged ? "[pod] 就绪：USB 在线，同步态（拔线即恢复监听）"
                                : "[pod] 就绪：VAD 监听中");
}

// ---- SYNC 进出（v0.1.0：暂停录音 + 屏显；MSC 同步 v0.2.0）----
static void enterSync() {
  mode = PodMode::SYNC;
  recorder.setPaused(true);  // 正在录则先切段（保留预滚衔接）
  if (recorder.getState() == WavRecorder::State::RECORDING) recorder.splitSegment();
  pod::setLed(pod::Led::BLINK_500MS);
  renderPage();
  pod::log::event("[usb] 插入 → 同步态（录音暂停）\n");
}

static void exitSync() {
  mode = PodMode::NORMAL;
  recorder.setPaused(false);
  pod::setLed(pod::Led::OFF);
  renderPage();
  pod::log::event("[usb] 拔出 → 恢复监听\n");
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
      if (mode == PodMode::ERROR_)
        pod::log::event("[key] 固件内格式化 v0.2.0 提供；请先用电脑 FAT32 格式化后重新插卡\n");
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

  // 3. USB 插拔沿 → SYNC 进出
  bool plugged = Serial.isPlugged();  // 实时检测（battery.charging 是 60s 快照）
  if (plugged != usbWasPlugged) {
    usbWasPlugged = plugged;
    plugged ? enterSync() : exitSync();
  }

  // 4. 录音步进（SYNC 态 paused 内部丢帧；MUTED 同理）
  recorder.step();

  // 5. SD 热拔探测（10s；录音中跳过——写失败路径已覆盖；连续 2 次失败才判拔卡防误报）
  static uint32_t lastSdProbe = 0;
  static int sdFailCount = 0;
  if (recorder.getState() != WavRecorder::State::RECORDING &&
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

  // 6. 电池周期采样（60s；不刷屏，跨阈值时随下一次自然刷新体现）
  if (millis() - lastBatteryMs > 60000) {
    lastBatteryMs = millis();
    battery = pod::batterySample();
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

  // 7. VAD 心跳（5s：观察底噪水平与触发行为，调 high/low 阈值依据）
  static uint32_t lastVadLog = 0;
  if (millis() - lastVadLog >= 5000) {
    lastVadLog = millis();
    Serial.printf("[vad] score=%.2f peak=%d lowMs=%ums %s\n", recorder.getVadScore(),
                  recorder.getLastFramePeak(), (unsigned)recorder.getVadLowMs(),
                  recorder.getState() == WavRecorder::State::RECORDING ? "录音中" : "监听");
  }

  // 8. 串口校时（TimeSync：电脑发 "SETTIME:<unix秒>\n"，插线时可用）
  timeSync.update();

  delay(2);  // 让键扫描/串口有呼吸
}
