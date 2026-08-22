#pragma once
#include <Arduino.h>
#include <ESP_I2S.h>
#include <cstdio>
#include "driver/sdmmc_types.h"  // sdmmc_card_t（v0.2.0 MSC 块代理读卡用）
#include "VadTrigger.h"
#include "RingBuffer.h"

/**
 * WavRecorder — 录音豆核心录音器（编排者）
 * ============================================================
 * 职责
 *   组合 PDM 麦采集 + VadTrigger + RingBuffer + SD 卡 + WAV 封装，编排完整
 *   "自动检测人声 → 预录不丢首音 → 写 WAV 到 SD"流程。
 *   自身不含判定算法（在 VadTrigger）和缓冲算法（在 RingBuffer），是这两者
 *   的使用者 + SD/I2S/WAV 的封装者。
 *
 * 状态机
 *   IDLE      持续读麦 → 喂 RingBuffer（预录）+ VadTrigger 判定
 *        ↓ VadTrigger 转 ACTIVE（score 上穿 HIGH）
 *   RECORDING 新建 WAV → 先 flush RingBuffer（预录引子）→ 持续写 PCM
 *        ↓ VadTrigger 回 IDLE（score 跌破 LOW + hangover）或达时长上限
 *   回 IDLE  finalize WAV（回填 size）→ 关文件 → 继续监听
 *
 * 设计要点
 *   - 回调解耦：状态变化 / 错误通知通过回调上报，不硬绑 Serial 打印
 *   - 时间来源不绑死：用 time() 读 RTC，RTC 设置交给上层（main.cpp 或未来
 *     的"时间纠正模块"），本模块只读不设。接入新时间源时替换 time() 即可
 *   - 引脚 / 路径 / 时长全配置化（HardwareConfig 结构体）
 *   - 帧大小自动对齐 VADNet 要求（sampleRate/1000 * frameMs）
 *
 * 已知简化（待后续模块补）
 *   - 时间用编译时间设 RTC（main.cpp），不准，待接 NTP / 串口设时模块
 *   - 无电源管理（功耗模式、低电量处理），待补
 *   - 无 USB-MSC 同步模式，待补
 */
class WavRecorder {
public:
  enum class State : uint8_t {
    IDLE = 0,
    RECORDING = 1,
  };

  // 状态变化回调（IDLE ↔ RECORDING）
  typedef void (*StateCallback)(State state);
  // 错误回调（非致命：留在/回到 IDLE 继续监听；致命：调用方决定重启）
  typedef void (*ErrorCallback)(const char *msg);

  // 硬件 / 路径 / 时长配置
  struct HardwareConfig {
    // ---- 音频后端 ----
    // useEs8311=true: 微雪 ESP32-S3-ePaper-1.54 板载 ES8311（I2C+I2S STD，2.0 硬件）
    // useEs8311=false: XIAO PDM 麦（1.0 硬件，pdmClkPin/pdmDataPin 生效）
    bool useEs8311 = false;
    // PDM 麦（XIAO ESP32-S3 Sense 扩展板 MSA261，探针实证 CLK=42 DATA=41）
    int pdmClkPin = 42;
    int pdmDataPin = 41;
    // ES8311（微雪板，引脚官方定案，见 interaction-design.md §1）
    int esI2cSda = 47, esI2cScl = 48;
    int esI2sMck = 14, esI2sBck = 15, esI2sLrck = 38, esI2sDataIn = 16;
    int esI2sDataOut = 45;  // ESP32→codec（配置齐全，即使录音不发送
    // ---- 存储后端 ----
    // useSdMmc=true: SD_MMC 1-bit（微雪板 SDIO CLK=39 CMD=41 D0=40）
    // useSdMmc=false: SPI SD（XIAO 1.0，sdCsPin 等生效）
    bool useSdMmc = false;
    // SD_MMC 引脚（GPIO 矩阵）。微雪板非默认 IOMUX，必须显式指定；-1 = 库默认
    int sdMmcClk = -1, sdMmcCmd = -1, sdMmcD0 = -1;
    // SD 卡（SPI，CS=GPIO21 探针实证 — 一脚两用 USER_LED，访问时橙灯闪）
    int sdCsPin = 21;
    int sdSckPin = 7;
    int sdMisoPin = 8;
    int sdMosiPin = 9;
    // 音频（VADNet 要求 16kHz）
    int sampleRate = 16000;
    // SD 卡文件组织（日期子目录自动建在其下）。SD_MMC 后端须写全路径含挂载点
    const char *recordDir = "/echo-pod";
    // 预录缓冲容量（字节）。64KB ≈ 2s（16k mono 16bit）
    // 比触发延迟（~180ms）大一个数量级，触发慢也不丢首音
    size_t ringBytes = 64 * 1024;
    // 单段最长录音（防异常长录占用）。0 = 不限
    uint32_t maxRecordMs = 300000; // 默认 5 分钟
    // 录音短于此则删除文件（误触发 / SD 写入异常产生的垃圾文件，避免污染 SD
    // 和后续转写）。含预录缓冲字节，正常录音不会低于此
    size_t minRecordBytes = 16 * 1024; // 16KB ≈ 0.5s
  };

  WavRecorder() = default;
  ~WavRecorder();

  // 初始化全部（I2S 麦 + SD + VadTrigger + RingBuffer）。任一失败返回 false。
  // 不用默认参数（结构体默认构造在类内触发 NSDMI 完整性问题），调用方显式传。
  bool begin(const HardwareConfig &hw, const VadTrigger::Params &vad);
  void end();

  // 救援挂载（v0.2.0，firmware-plan B6）：begin 挂载失败后的重试入口。
  // format=true 且挂载失败 → f_mkfs FAT 重格再挂（固件内格式化，ERROR 态
  // 长按 BOOT 5s 触发）。挂载成功本身不格式化——卡上数据完好则原样挂回。
  // 成功返回 true（/sdcard 可用，卡句柄同步更新到 sdCard()）
  bool rescueMount(bool format);

  // 主循环步进。在 Arduino loop() 里反复调用，非阻塞。
  void step();

  // ---- 运行控制（PodController 调用）----
  // 手动切段：强制收尾当前段并归档；预滚缓冲保留（新段开头与上段尾部 ~2s 重叠，
  // 切点不丢话）。VAD 仍激活则下一帧自动开新段继续录（"短按归档"语义）。
  void splitSegment() { stopRecording(true); }
  // 暂停/恢复监听（USB 同步等场景）：暂停期间音频照读但丢弃（防 I2S 积压陈旧数据）
  void setPaused(bool p) { paused_ = p; }



  // ---- 回调 ----
  void onStateChange(StateCallback cb) { stateCb_ = cb; }
  void onError(ErrorCallback cb) { errorCb_ = cb; }

  // ---- 观测（调试 / 上层展示）----
  State getState() const { return state_; }
  uint32_t getRecordMs() const { return recordMs_; }
  uint32_t getDataBytes() const { return dataBytes_; }
  float getVadScore() const { return vad_.getScore(); }
  float getVadRatio() const { return vad_.getRatio(); }  // 窗口原始语音占比（包络前，debug 调参）
  // 最近一帧原始音频峰值（0..32767）。音频链路自检：peak=0 → I2S 无数据；peak>0 而 score=0 → VAD 层问题
  int getLastFramePeak() const { return framePeak_; }
  uint32_t getVadLowMs() const { return vad_.getLowMs(); }
  const VadTrigger::Params &getVadParams() const { return vad_.getParams(); }
  const char *getCurrentPath() const { return currentPath_.c_str(); }
  // SD 原始卡句柄（SD_MMC 后端挂载成功后有效；USB-MSC 块代理按扇区读卡用，
  // 调用方保证读取期间本模块不写卡——SYNC 态暂停录音即满足）
  sdmmc_card_t *sdCard() const { return sdCard_; }

private:
  I2SClass i2s_;
  VadTrigger vad_;
  RingBuffer ring_;
  HardwareConfig hw_;
  State state_ = State::IDLE;
  bool begun_ = false;

  FILE *wavFile_ = nullptr;  // POSIX（存储层与 arduino SD_MMC 库解耦，走 IDF VFS）
  sdmmc_card_t *sdCard_ = nullptr;  // IDF 挂载返回的卡句柄（MSC 块代理共用）
  uint32_t dataBytes_ = 0; // 当前文件已写 PCM 字节
  uint32_t recordMs_ = 0;  // 当前已录时长（ms）
  String currentPath_;

  StateCallback stateCb_ = nullptr;
  ErrorCallback errorCb_ = nullptr;
  bool paused_ = false;

  int frameSamples_ = 0;   // 每帧样本数（= sampleRate/1000*frameMs）
  int frameBytes_ = 0;     // 每帧字节数（= frameSamples*2）
  int16_t *frameBuf_ = nullptr;
  int framePeak_ = 0;
  int writeFailCount_ = 0; // 连续写入失败计数（容忍偶发，累计才停）

  void notifyState(State s);
  void notifyError(const char *msg);
  void startRecording();
  void stopRecording(bool keepRing = false);  // keepRing: 手动切段保留预滚（重叠衔接）
  void buildPath(String &folder, String &fname);
  void writeWavHeader();
  void finalizeWav();
};
