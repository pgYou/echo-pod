#include "WavRecorder.h"
#include <SPI.h>
#include <SD.h>
#include <Wire.h>
#include <sys/stat.h>
#include "driver/sdmmc_host.h"
#include "driver/sdmmc_types.h"
#include "esp_vfs_fat.h"
#include "sdmmc_cmd.h"
#include "es8311.h"

// RingBuffer::flush(Print&) 的 POSIX 文件适配器（FILE* 不是 Print）
class FilePrintAdapter : public Print {
public:
  explicit FilePrintAdapter(FILE *f) : f_(f) {}
  size_t write(uint8_t b) override { return fwrite(&b, 1, 1, f_); }
  size_t write(const uint8_t *buf, size_t n) override { return fwrite(buf, 1, n, f_); }
private:
  FILE *f_;
};

WavRecorder::~WavRecorder() { end(); }

// SDIO 1-bit IDF 挂载（begin 与 rescueMount 共用；format=true 时挂载失败由
// FatFS f_mkfs FAT 重格再挂——固件内格式化，显式危险操作仅 ERROR 态入口可达）
static esp_err_t mountSd(const WavRecorder::HardwareConfig &hw, bool format,
                         sdmmc_card_t **outCard) {
  esp_vfs_fat_sdmmc_mount_config_t cfg = {};
  cfg.format_if_mount_failed = format;
  cfg.max_files = 5;
  sdmmc_host_t host = SDMMC_HOST_DEFAULT();  // 20MHz（DEFAULT）
  sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
  slot.width = 1;  // 1-bit（D0 单线）
  slot.clk = (gpio_num_t)hw.sdMmcClk;
  slot.cmd = (gpio_num_t)hw.sdMmcCmd;
  slot.d0 = (gpio_num_t)hw.sdMmcD0;
  return esp_vfs_fat_sdmmc_mount("/sdcard", &host, &slot, &cfg, outCard);
}

bool WavRecorder::rescueMount(bool format) {
  if (!hw_.useSdMmc) return false;
  if (sdCard_) {  // 已挂载（begin 时 SD 正常、音频链路失败的 ERROR 场景）：先卸载
    esp_vfs_fat_sdcard_unmount("/sdcard", sdCard_);
    sdCard_ = nullptr;
  }
  return mountSd(hw_, format, &sdCard_) == ESP_OK;
}

bool WavRecorder::begin(const HardwareConfig &hw, const VadTrigger::Params &vad) {
  if (begun_) end();
  hw_ = hw;

  // ---- 帧大小对齐 VADNet 要求 ----
  frameSamples_ = hw_.sampleRate / 1000 * vad.frameMs; // 16k/30ms = 480
  frameBytes_ = frameSamples_ * 2;
  frameBuf_ = (int16_t *)malloc(frameBytes_);
  if (!frameBuf_) {
    notifyError("帧缓冲 malloc 失败");
    return false;
  }

  // ---- 存储后端（微雪板走 IDF 挂载：step0-mic 验证过的路径，20MHz 默认频率；
  //      文件 IO 全 POSIX 经 VFS 统一，绕开 arduino SD_MMC 库）----
  if (hw_.useSdMmc) {
    esp_err_t err = mountSd(hw_, false, &sdCard_);
    if (err != ESP_OK) {
      char msg[80];
      snprintf(msg, sizeof(msg), "SD 挂载失败 err=0x%x（查卡/FAT32）", err);
      notifyError(msg);
      return false;
    }
  } else {
    SPI.begin(hw_.sdSckPin, hw_.sdMisoPin, hw_.sdMosiPin, hw_.sdCsPin);
    if (!SD.begin(hw_.sdCsPin, SPI, 400000)) {  // XIAO 1.0 SPI SD
      notifyError("SD 卡初始化失败");
      return false;
    }
  }
  mkdir(hw_.recordDir, 0775);  // 外层目录（已存在则忽略）

  // ---- 音频后端 ----
  if (hw_.useEs8311) {
    // 微雪板 ES8311（I2C 配置 codec + I2S STD 采数据；参数 step0 实测定案）
    Wire.begin(hw_.esI2cSda, hw_.esI2cScl);
    es8311_handle_t codec = es8311_create(I2C_NUM_0, ES8311_ADDRRES_0);
    if (!codec) {
      notifyError("ES8311 创建失败");
      return false;
    }
    es8311_clock_config_t clk = {};
    clk.mclk_from_mclk_pin = true;
    clk.mclk_frequency = hw_.sampleRate * 256;
    clk.sample_frequency = hw_.sampleRate;
    if (es8311_init(codec, &clk, ES8311_RESOLUTION_16, ES8311_RESOLUTION_16) != ESP_OK ||
        es8311_microphone_config(codec, false) != ESP_OK ||          // 模拟麦
        es8311_microphone_gain_set(codec, ES8311_MIC_GAIN_18DB) != ESP_OK) {
      notifyError("ES8311 初始化失败");
      return false;
    }
    i2s_.setPins(hw_.esI2sBck, hw_.esI2sLrck, hw_.esI2sDataOut, hw_.esI2sDataIn, hw_.esI2sMck);
    if (!i2s_.begin(I2S_MODE_STD, hw_.sampleRate, I2S_DATA_BIT_WIDTH_16BIT,
                    I2S_SLOT_MODE_MONO, I2S_STD_SLOT_LEFT)) {
      notifyError("ES8311 I2S 初始化失败");
      return false;
    }
  } else {
    i2s_.setPinsPdmRx(hw_.pdmClkPin, hw_.pdmDataPin);
    if (!i2s_.begin(I2S_MODE_PDM_RX, hw_.sampleRate, I2S_DATA_BIT_WIDTH_16BIT,
                    I2S_SLOT_MODE_MONO)) {
      notifyError("麦克风 I2S 初始化失败");
      return false;
    }
  }

  // ---- VAD trigger ----
  if (!vad_.begin(vad)) {
    notifyError("VadTrigger 初始化失败");
    return false;
  }

  // ---- 预录环形缓冲 ----
  if (!ring_.begin(hw_.ringBytes)) {
    notifyError("RingBuffer 分配失败");
    return false;
  }

  state_ = State::IDLE;
  dataBytes_ = 0;
  recordMs_ = 0;
  begun_ = true;
  return true;
}

void WavRecorder::end() {
  if (state_ == State::RECORDING) stopRecording();
  vad_.end();
  ring_.end();
  if (frameBuf_) {
    free(frameBuf_);
    frameBuf_ = nullptr;
  }
  begun_ = false;
}

void WavRecorder::step() {
  if (!begun_) return;

  // 读一帧（严格 = VADNet 帧长）。没读够就跳过本轮（还在灌，下一轮重读）。
  // 偶尔丢一个不完整帧（30ms）对录音/判定影响极小。
  size_t got = i2s_.readBytes((char *)frameBuf_, frameBytes_);
  if (got < (size_t)frameBytes_) return;

  // 音频峰值（诊断链路用，几条指令成本）
  int16_t peak = 0;
  for (int i = 0; i < frameSamples_; i++) {
    int16_t a = frameBuf_[i] < 0 ? -frameBuf_[i] : frameBuf_[i];
    if (a > peak) peak = a;
  }
  framePeak_ = peak;

  // 暂停（USB 同步等）：音频照读但丢弃，防 I2S 积压陈旧数据；VAD 冻结
  if (paused_) return;

  // VAD 判定（更新内部 score / 状态机）
  vad_.process(frameBuf_, frameSamples_);

  if (state_ == State::IDLE) {
    // 持续喂预录缓冲（触发瞬间会被 flush 进文件 → 不丢首音）
    ring_.push((const uint8_t *)frameBuf_, frameBytes_);

    if (vad_.getState() == VadTrigger::State::ACTIVE) {
      startRecording(); // 内部 flush ring（含当前触发帧）
    }
  } else { // RECORDING
    // 用 if-else 分支保证：触发帧已在 IDLE 分支经 ring flush 写入，
    // 不会在 RECORDING 分支再写一次（避免重复）。
    size_t wrote = fwrite(frameBuf_, 1, frameBytes_, wavFile_);
    dataBytes_ += wrote;
    recordMs_ += (uint32_t)vad_.getParams().frameMs;

    // 停止条件
    bool triggerStop = (vad_.getState() == VadTrigger::State::IDLE);
    bool maxStop = (hw_.maxRecordMs > 0 && recordMs_ >= hw_.maxRecordMs);
    if (triggerStop) {
      stopRecording();
    } else if (maxStop) {
      notifyError("到达最长录音时长，自动停止");
      stopRecording();
    } else if (wrote < (size_t)frameBytes_) {
      // 写入失败容忍：SD 卡偶发忙/慢会返回不完整。连续 N 次才判定真坏，
      // 避免单次抖动导致录音中断（中断后 score 还高会立即重触发→循环）
      writeFailCount_++;
      if (writeFailCount_ >= 5) {
        notifyError("SD 连续写入失败");
        stopRecording();
      }
    } else {
      writeFailCount_ = 0; // 写入正常，清零
    }
  }
}

// ---------- 状态切换 ----------
void WavRecorder::startRecording() {
  String folder, fname;
  buildPath(folder, fname);
  mkdir(folder.c_str(), 0775);
  currentPath_ = folder + "/" + fname;

  wavFile_ = fopen(currentPath_.c_str(), "wb");
  if (!wavFile_) {
    String msg = "打开文件失败：" + currentPath_;
    notifyError(msg.c_str());
    return; // 留在 IDLE，下一帧 trigger 仍 ACTIVE 会重试
  }
  writeWavHeader();
  // 先刷预录缓冲（≈2 秒引子，含触发语音本身）→ 不丢首音
  FilePrintAdapter adapter(wavFile_);
  dataBytes_ = ring_.flush(adapter);
  recordMs_ = (uint32_t)(dataBytes_ / (2.0f * hw_.sampleRate) * 1000);
  state_ = State::RECORDING;
  notifyState(State::RECORDING);
}

void WavRecorder::stopRecording(bool keepRing) {
  if (state_ == State::RECORDING) {
    if (wavFile_) {
      finalizeWav();
      fclose(wavFile_);
      wavFile_ = nullptr;
    }
    state_ = State::IDLE;
    // 录音太短 → 删除文件（误触发 / SD 写入异常的垃圾文件）
    if (dataBytes_ < hw_.minRecordBytes) {
      remove(currentPath_.c_str());
      String msg = "录音太短（" + String(dataBytes_) + "B），已删除 " + currentPath_;
      notifyError(msg.c_str());
    }
    notifyState(State::IDLE); // 回调里上层可读到本段最后的 dataBytes_ / recordMs_
  }
  // 手动切段保留预滚（新段与上段尾部 ~2s 重叠，切点不丢话）；
  // 自然结束清空（避免下段刷入上一段旧数据）
  if (!keepRing) ring_.reset();
  dataBytes_ = 0;
  recordMs_ = 0;
}

// ---------- 回调派发 ----------
void WavRecorder::notifyState(State s) {
  if (stateCb_) stateCb_(s);
}

void WavRecorder::notifyError(const char *msg) {
  if (errorCb_) errorCb_(msg);
}

// ---------- 路径 / 时间 ----------
void WavRecorder::buildPath(String &folder, String &fname) {
  // 时间来源：上层负责设 RTC（time()）。本模块不设时间，只读。
  // 后续接入"时间纠正模块"时，替换 time() 来源即可，本模块不改。
  // 注意：RTC 未设时（如断电重启无电池后备）time() 返回 0 → 文件名会落到
  // 1970-01-01，是已知问题，由时间纠正模块解决。
  time_t now;
  time(&now);
  struct tm ti;
  localtime_r(&now, &ti);
  char d[16], n[32];
  strftime(d, sizeof(d), "%Y-%m-%d", &ti);
  strftime(n, sizeof(n), "%H-%M-%S.wav", &ti);
  folder = String(hw_.recordDir) + "/" + d; // /echo-pod/2026-07-26
  fname = String(n);
}

// ---------- WAV 44 字节头（PCM / mono / 16bit）----------
void WavRecorder::writeWavHeader() {
  // 标准 WAV 头：data size 先填 0，finalizeWav 回填真实大小（fseek 回写）。
  uint8_t h[44] = {0};
  memcpy(h + 0, "RIFF", 4);
  memcpy(h + 8, "WAVE", 4);
  memcpy(h + 12, "fmt ", 4);
  h[16] = 16;  // fmt chunk size
  h[20] = 1;   // audio format = PCM
  h[22] = 1;   // mono
  uint32_t sr = hw_.sampleRate;
  memcpy(h + 24, &sr, 4);               // sample rate
  uint32_t br = hw_.sampleRate * 1 * 2; // byte rate = sr * channels * bps/8
  memcpy(h + 28, &br, 4);
  h[32] = 2;  // block align = channels * bps/8
  h[34] = 16; // bits per sample
  memcpy(h + 36, "data", 4);
  fwrite(h, 1, 44, wavFile_);
}

void WavRecorder::finalizeWav() {
  // 双回填（step0 踩坑教训）：RIFF 总长（offset 4）+ data 大小（offset 40）
  uint32_t riffBytes = 36 + dataBytes_;
  fseek(wavFile_, 4, SEEK_SET);
  fwrite(&riffBytes, 4, 1, wavFile_);
  fseek(wavFile_, 40, SEEK_SET);
  fwrite(&dataBytes_, 4, 1, wavFile_);
}
