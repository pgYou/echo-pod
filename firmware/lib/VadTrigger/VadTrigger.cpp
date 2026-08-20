#include "VadTrigger.h"

VadTrigger::~VadTrigger() { end(); }

bool VadTrigger::begin(const Params &params) {
  if (begun_) end();
  params_ = params;

  // ⚠️ 实测教训：min_speech_ms/min_noise_ms 虽然只在 vad_process_with_trigger
  // 里用，但传 0 会破坏 vad 实例内部状态（trigger 字段初始化异常），导致
  // vad_process 裸判定也失灵（固定吐假信号、不响应声音）。
  // 本模块走裸 vad_process + 自写状态机，给合理默认值（100/200）保实例正常。
  vad_ = vad_create_with_param(params_.vadMode, params_.sampleRate,
                               params_.frameMs, 100, 200);
  if (!vad_) return false;

  score_ = 0;
  state_ = State::IDLE;
  lowMs_ = 0;
  lastRaw_ = false;
  begun_ = true;
  frameCount_ = 0;
  warmupFrames_ = params_.warmupMs / params_.frameMs;
  // 滑动窗口初始化
  winSize_ = (params_.frameWindow > 0 && params_.frameWindow <= MAX_WIN)
                 ? params_.frameWindow : 1;
  winHead_ = 0;
  winCount_ = 0;
  winSum_ = 0;
  for (int i = 0; i < MAX_WIN; i++) winBuf_[i] = 0;
  return true;
}

void VadTrigger::end() {
  if (vad_) {
    vad_destroy(vad_);
    vad_ = nullptr;
  }
  begun_ = false;
}

void VadTrigger::reset() {
  score_ = 0;
  state_ = State::IDLE;
  lowMs_ = 0;
}

VadTrigger::State VadTrigger::process(const int16_t *samples, int n) {
  if (!begun_ || !samples) return state_;

  // 帧长防御：VADNet 要求严格帧大小（如 16k/30ms=480），传错会越界/异常。
  // 不符时返回当前状态、不更新，避免污染状态机。
  int need = params_.sampleRate / 1000 * params_.frameMs;
  if (n != need) return state_;

  // 预热期（前 warmupFrames 帧）：PDM/I2S/VADNet 启动瞬态读数不稳，会被误判
  // SPEECH。喂 VADNet 让它内部状态/滤波器稳定，但不更新 score/状态（返回 IDLE）。
  // 用帧计数而非 millis()：确定性、不依赖时间分辨率、模块不绑死 Arduino 时间源
  frameCount_++;
  if (frameCount_ <= warmupFrames_) {
    vad_process(vad_, (int16_t *)samples, params_.sampleRate, params_.frameMs);
    return State::IDLE;
  }

  // 1. VADNet 裸判定（神经网络看频谱指纹，不看能量）。
  //    注意 vad_process 第二参数是非 const int16_t*，但实际只读不改数据，
  //    这里 cast 掉 const 表达"逻辑上不改输入"的意图。
  vad_state_t raw = vad_process(vad_, (int16_t *)samples,
                                params_.sampleRate, params_.frameMs);
  lastRaw_ = (raw == VAD_SPEECH);

  // 2. 滑动窗口：取最近 winSize_ 帧 VADNet 判定的占比（抑制瞬态噪声）
  //    翻书/轻拍：1-2 帧误判 SPEECH，在 5 帧窗口里占比 0.2-0.4 → ratio 低
  //    人声持续：多帧判 SPEECH，占比 0.8-1.0 → ratio 高
  if (winCount_ == winSize_) {
    winSum_ -= winBuf_[winHead_]; // 窗口满，移出最旧（增量维护）
  } else {
    winCount_++;
  }
  winBuf_[winHead_] = lastRaw_ ? 1 : 0;
  winSum_ += winBuf_[winHead_];
  winHead_ = (winHead_ + 1) % winSize_;
  float ratio = (winCount_ > 0) ? (float)winSum_ / winCount_ : 0;

  // 3. score 积分（目标改为窗口占比 ratio，而非单帧 0/1）
  //    ratio 低 → score 目标低 → 涨不起来（瞬态噪声被窗口稀释后压不上去）
  //    下降系数按状态分流：IDLE 快泄（releaseIdle，防连咳/连敲跨间隙累积
  //    垫脚）；ACTIVE 慢降（release，对话停顿 score 缓降不切段）
  float a;
  if (ratio >= score_) {
    a = params_.attack;
  } else {
    a = (state_ == State::IDLE) ? params_.releaseIdle : params_.release;
  }
  score_ = score_ * a + ratio * (1.0f - a);

  // 4. 双阈值迟滞状态机
  if (state_ == State::IDLE) {
    if (score_ > params_.highThreshold) {
      state_ = State::ACTIVE;
      lowMs_ = 0;
    }
  } else { // ACTIVE
    // 三区间停止逻辑（防 score 帧级抖动反复重置 hangover）：
    //   score < LOW         → lowMs 累计（确定静）
    //   LOW <= score < MID  → lowMs 保持（模糊区，抖动落这里不重置）
    //   score >= MID        → lowMs 清零（确定有声，真有持续人声才重置）
    if (score_ < params_.lowThreshold) {
      lowMs_ += (uint32_t)params_.frameMs;
      if (lowMs_ >= params_.hangoverMs) {
        state_ = State::IDLE;
        lowMs_ = 0;
      }
    } else if (score_ >= params_.midThreshold) {
      lowMs_ = 0; // 只有明显回升才清零
    }
    // else: LOW~MID 模糊区，lowMs 保持不变
  }
  return state_;
}
