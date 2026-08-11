#pragma once
#include "WavRecorder.h" // 带入 VadTrigger.h

/**
 * 录音豆配置参数
 * ============================================================
 * 改参数只动这个文件，main.cpp 逻辑稳定不动。
 * 两个 inline 函数返回配置好的结构体（inline 避免多重定义）。
 */

// ---- 硬件 / 路径 / 时长 ----
inline WavRecorder::HardwareConfig makeHardwareConfig() {
  WavRecorder::HardwareConfig hw;
  // PDM 麦（XIAO ESP32-S3 Sense 扩展板 MSA261，探针实证 CLK=42 DATA=41）
  hw.pdmClkPin = 42;
  hw.pdmDataPin = 41;
  // SD 卡（SPI，CS=GPIO21 探针实证 — 一脚两用 USER_LED，访问时橙灯闪）
  hw.sdCsPin = 21;
  hw.sdSckPin = 7;
  hw.sdMisoPin = 8;
  hw.sdMosiPin = 9;
  // 音频（VADNet 要求 16kHz）
  hw.sampleRate = 16000;
  // SD 卡文件组织（日期子目录自动建在其下）
  hw.recordDir = "/echo-pod";
  // 预录缓冲容量（字节）。64KB ≈ 2s（16k mono 16bit）
  // 比触发延迟（~180ms）大一个数量级，触发慢也不丢首音
  hw.ringBytes = 64 * 1024;
  // 单段最长录音（防异常长录）。0 = 不限
  hw.maxRecordMs = 300000; // 5 分钟
  // 录音短于此删除文件（误触发/SD 写入异常垃圾文件）
  hw.minRecordBytes = 16 * 1024; // 16KB ≈ 0.5s
  return hw;
}

// ---- VAD trigger 调参 ----
inline VadTrigger::Params makeVadParams() {
  VadTrigger::Params vad;
  vad.vadMode = VAD_MODE_2;  // Very Aggressive：严格判人声，挡拍桌子/敲击等噪声
                              // （MODE_0 太宽松会放行拍桌子；MODE_2 是平衡点）
  vad.sampleRate = 16000;
  vad.frameMs = 30;           // VADNet 帧长 → 480 样本/帧
  vad.attack = 0.92f;         // 11 帧≈330ms 持续 SPEECH 才触发（继续拉长以挡拍桌子；
                              // 有 2s 预录兜底，不怕触发慢丢首音）
  vad.release = 0.92f;        // 慢降 τ≈360ms（对话间隙 score 缓降）
  vad.highThreshold = 0.60f;  // 上穿 → ACTIVE
  vad.midThreshold = 0.30f;   // >=MID 才清零 hangover（防抖动重置）
  vad.lowThreshold = 0.20f;   // <LOW 累计 hangover
  vad.hangoverMs = 6000;       // lowMs 累计满 6s 才停
  vad.warmupMs = 300;          // 开机预热丢弃（PDM/VADNet 瞬态）
  vad.frameWindow = 5;         // 5 帧滑动窗口取占比（抑制翻书等瞬态噪声）
  return vad;
}
