/**
 * 录音豆 echo-pod - 阶段1 基线（VAD 自动录音）
 * ============================================
 * 继承 recording-pod-hello 已验证的核心录音链路：
 *   WavRecorder + VadTrigger + RingBuffer + TimeSync
 *   自动检测人声 → 预录不丢首音 → 写 WAV 到 SD
 *
 * 阶段2 计划（B 焊接 + C 固件，详见 stage2-firmware-design.md）：
 *   - 焊接：白光/红光 LED + 多功能按键 + 电池 ADC 分压 + Pogo Pin
 *   - 固件：新增 PodController 模块封装人机交互（LED/按键/电池/充电），
 *           届时重写本文件为 PodController + WavRecorder 组装版
 *
 * 当前状态：阶段2 B1 焊接前（本文件 = 阶段1 基线，保证 echo-pod 立即可跑）
 */

#include "TimeSync.h"
#include "WavRecorder.h"
#include "config.h" // 硬件 + VAD 参数配置（改参数只动 config.h）
#include <Arduino.h>
#include <time.h>

WavRecorder recorder;
TimeSync timeSync;

void onStateChange(WavRecorder::State s) {
  float score = recorder.getVadScore();
  if (s == WavRecorder::State::RECORDING) {
    Serial.printf("[%.1fs] >>> 开始录音：%s (score %.2f)\n", millis() / 1000.0,
                  recorder.getCurrentPath(), score);
  } else {
    Serial.printf("[%.1fs] <<< 停止：%uB (%.1fs，含预录)\n", millis() / 1000.0,
                  recorder.getDataBytes(), recorder.getRecordMs() / 1000.0);
  }
}

void onError(const char *msg) { Serial.printf("X 错误：%s\n", msg); }

// 时间同步成功回调：打印校准到的时间
void onTimeSynced(time_t timestamp) {
  char buf[32];
  struct tm ti;
  localtime_r(&timestamp, &ti);
  strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &ti);
  Serial.printf("OK 时间已同步：%s\n", buf);
}

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 2000)
    delay(10);

  Serial.println();
  Serial.println("====================================");
  Serial.println(" 录音豆 echo-pod - 阶段1 基线");
  Serial.println(" WavRecorder + VadTrigger + RingBuffer + TimeSync");
  Serial.println("====================================");

  // 时间：先用编译时间兜底，监听串口 "SETTIME:<秒>\n" 同步电脑时间
  timeSync.begin(Serial, "CST-8");
  timeSync.onSynced(onTimeSynced);
  Serial.println("OK RTC（编译时间兜底，待串口同步校准）");
  Serial.println("   电脑端：python tools/sync_time.py /dev/cu.usbmodem1101");

  recorder.onStateChange(onStateChange);
  recorder.onError(onError);

  if (!recorder.begin(makeHardwareConfig(), makeVadParams())) {
    Serial.println("X 录音器初始化失败，停。");
    while (1)
      delay(1000);
  }
  Serial.println("OK 录音器启动，IDLE 监听中...\n");
}

void loop() {
  timeSync.update(); // 非阻塞监听串口校时命令
  recorder.step();

  // 诊断打印（500ms 一打，调参稳定后可改回 1000）
  static unsigned long lastPrint = 0;
  if (millis() - lastPrint >= 500) {
    lastPrint = millis();
    const auto &vp = recorder.getVadParams();
    Serial.printf(
        "[%.1fs] %s recMs=%lu score=%.2f lowMs=%lu (H%.2f/M%.2f/L%.2f)\n",
        millis() / 1000.0,
        recorder.getState() == WavRecorder::State::RECORDING ? "REC " : "idle",
        recorder.getRecordMs(), recorder.getVadScore(), recorder.getVadLowMs(),
        vp.highThreshold, vp.midThreshold, vp.lowThreshold);
  }
}
