#pragma once
#include "WavRecorder.h"  // 带入 VadTrigger.h

/**
 * 录音豆 echo-pod 正式固件配置
 * ============================================================
 * 硬件：微雪 ESP32-S3-ePaper-1.54（V2，N8R8，黑白屏）
 * 改参数只动这个文件，模块逻辑稳定不动。
 */

// ---- 版本（正式固件唯一权威，串口横幅 / .echo-pod fw 字段同源）----
#define FW_VERSION "0.1.3"
#define FW_NAME "echo-pod"
#define HW_ID "waveshare-epaper-1.54-v2"

// ---- 板级引脚（考证定案，见 docs/interaction-design.md §1）----
inline constexpr int PIN_LED_GREEN = 3;    // 绿灯，低电平点亮（与排针 GP3 复用）
inline constexpr int PIN_PWR_KEY = 18;     // PWR 键（BAT_KEY），按下为低
inline constexpr int PIN_BOOT_KEY = 0;     // BOOT 键，按下为低
inline constexpr int PIN_VBAT_LATCH = 17;  // BAT_Control：高=固件接管供电，低=物理断电
inline constexpr int PIN_BAT_ADC = 4;      // 电池 ADC1_CH3，÷2 分压

// ---- SD_MMC 根（微雪板 SDIO 1-bit 挂载点）----
inline constexpr const char *SD_ROOT = "/sdcard";

// ---- 交互阈值（interaction-design.md §5）----
inline constexpr uint32_t KEY_SHORT_MS = 1000;   // 短按上限
inline constexpr uint32_t KEY_HOLD_MS = 3000;    // 长按（BOOT 静音 / PWR 关机 统一 3s）
inline constexpr uint32_t KEY_FORMAT_MS = 5000;  // ERROR 态格式化确认
inline constexpr int BAT_LOW_PCT = 8;            // 低电自动关机阈值
inline constexpr uint32_t LOWBAT_SHUTDOWN_MS = 60000;  // 低电强制关机倒计时

// ---- 录音硬件 / 路径 / 时长 ----
inline WavRecorder::HardwareConfig makeHardwareConfig() {
  WavRecorder::HardwareConfig hw;
  hw.useEs8311 = true;   // 微雪板 ES8311 codec（I2C 47/48 + I2S STD 15/38/16/14）
  hw.useSdMmc = true;    // 微雪板 SDIO 1-bit
  hw.sdMmcClk = 39;      // SDIO CLK / CMD / D0（GPIO 矩阵，官方原理图定案）
  hw.sdMmcCmd = 41;
  hw.sdMmcD0 = 40;
  hw.sampleRate = 16000; // VADNet 要求 16kHz
  hw.recordDir = "/sdcard/echo-pod";  // SD_MMC 后端须含挂载点（device-protocol.md）
  hw.ringBytes = 64 * 1024;           // 2s 预录（16k mono 16bit）
  hw.maxRecordMs = 300000;            // 单段上限 5 分钟
  hw.minRecordBytes = 16 * 1024;      // <0.5s 删除（垃圾段防污染）
  return hw;
}

// ---- VAD trigger 调参（v0.1.2 抗咳嗽/敲桌重调，见 CHANGELOG）----
inline VadTrigger::Params makeVadParams() {
  VadTrigger::Params vad;
  vad.vadMode = VAD_MODE_2;  // Very Aggressive：严格判人声，挡拍桌子/敲击等噪声
  vad.sampleRate = 16000;
  vad.frameMs = 30;           // VADNet 帧长 → 480 样本/帧
  vad.attack = 0.70f;         // 0.94→0.70：抗误触职责移交 32 帧窗口，积分器回归快上升
                              // （3 帧内 score 贴近窗口占比，触发延迟 ≈ 窗口填充时间）
  vad.release = 0.92f;        // ACTIVE 态慢降 τ≈360ms（对话间隙 score 缓降不切段）
  vad.releaseIdle = 0.75f;    // IDLE 态快泄 τ≈100ms（连咳/连敲间隙 score 掉光，不累积）
  vad.highThreshold = 0.68f;  // 上穿 → ACTIVE（佩戴环境噪声实测易触发，0.60→0.68）
  vad.midThreshold = 0.30f;   // >=MID 才清零 hangover（防抖动重置）
  vad.lowThreshold = 0.20f;   // <LOW 累计 hangover
  vad.hangoverMs = 6000;      // lowMs 累计满 6s 才停
  vad.warmupMs = 300;         // 开机预热丢弃（codec/VADNet 瞬态）
  vad.frameWindow = 32;       // 5→32：窗口 150ms→960ms，语义从"防毛刺"升级为"语音密度"
                              // 单声咳嗽(~15帧)占比≈0.47、长咳(20帧)≈0.63 都过不了 0.68；
                              // 真人连续说话占比≈1.0 正常触发（延迟~0.75s < 2s 预滚，不丢首音）
  return vad;
}
