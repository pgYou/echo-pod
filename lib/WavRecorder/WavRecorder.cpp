#include "WavRecorder.h"

WavRecorder::~WavRecorder() { end(); }

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

  // ---- SD 卡 ----
  SPI.begin(hw_.sdSckPin, hw_.sdMisoPin, hw_.sdMosiPin, hw_.sdCsPin);
  if (!SD.begin(hw_.sdCsPin, SPI, 400000)) {
    notifyError("SD 卡初始化失败");
    return false;
  }
  SD.mkdir(hw_.recordDir); // 外层目录（已存在则忽略）

  // ---- 麦克风（PDM RX）----
  i2s_.setPinsPdmRx(hw_.pdmClkPin, hw_.pdmDataPin);
  if (!i2s_.begin(I2S_MODE_PDM_RX, hw_.sampleRate, I2S_DATA_BIT_WIDTH_16BIT,
                  I2S_SLOT_MODE_MONO)) {
    notifyError("麦克风 I2S 初始化失败");
    return false;
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

  // 读一帧（严格 = VADNet 帧长）。没读够就跳过本轮（PDM 还在灌，下一轮重读）。
  // 偶尔丢一个不完整帧（30ms）对录音/判定影响极小。
  size_t got = i2s_.readBytes((char *)frameBuf_, frameBytes_);
  if (got < (size_t)frameBytes_) return;

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
    size_t wrote = wavFile_.write((const uint8_t *)frameBuf_, frameBytes_);
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
  SD.mkdir(folder);
  currentPath_ = folder + "/" + fname;

  wavFile_ = SD.open(currentPath_, FILE_WRITE);
  if (!wavFile_) {
    String msg = "打开文件失败：" + currentPath_;
    notifyError(msg.c_str());
    return; // 留在 IDLE，下一帧 trigger 仍 ACTIVE 会重试
  }
  writeWavHeader();
  // 先刷预录缓冲（≈1 秒引子，含触发语音本身）→ 不丢首音
  dataBytes_ = ring_.flush(wavFile_);
  recordMs_ = (uint32_t)(dataBytes_ / (2.0f * hw_.sampleRate) * 1000);
  state_ = State::RECORDING;
  notifyState(State::RECORDING);
}

void WavRecorder::stopRecording() {
  if (state_ == State::RECORDING) {
    if (wavFile_) {
      finalizeWav();
      wavFile_.close();
    }
    state_ = State::IDLE;
    // 录音太短 → 删除文件（误触发 / SD 写入异常的垃圾文件）
    if (dataBytes_ < hw_.minRecordBytes) {
      SD.remove(currentPath_);
      String msg = "录音太短（" + String(dataBytes_) + "B），已删除 " + currentPath_;
      notifyError(msg.c_str());
    }
    notifyState(State::IDLE); // 回调里上层可读到本段最后的 dataBytes_ / recordMs_
  }
  ring_.reset(); // 清空缓冲，避免下次触发刷入上一段的旧数据
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
  // 标准 WAV 头：data size 先填 0，finalizeWav 回填真实大小（seek 回写）。
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
  wavFile_.write(h, 44);
}

void WavRecorder::finalizeWav() {
  // 回填 RIFF chunk size（36 + data）和 data size（PCM 字节数）
  uint32_t chunkSize = 36 + dataBytes_;
  wavFile_.seek(4);
  wavFile_.write((const uint8_t *)&chunkSize, 4);
  wavFile_.seek(40);
  wavFile_.write((const uint8_t *)&dataBytes_, 4);
}
