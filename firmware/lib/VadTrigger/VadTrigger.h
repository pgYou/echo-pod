#pragma once
#include "esp_vad.h" // VADNet（arduino-esp32 3.x 自带，pioarduino-build.py 默认链）
#include <stdint.h>

/**
 * VadTrigger — 基于 VADNet 的语音活动触发器
 * ============================================================
 * 职责
 *   吃音频帧 → 吐触发状态（IDLE / ACTIVE）。不碰 SD / I2S / 文件，纯判定。
 *
 * 为什么不用官方 trigger（vad_process_with_trigger）
 *   官方 trigger 是"计数器状态机"：连续 N 帧判 SPEECH 才触发、连续 M 帧
 *   silence 才停止，中间一帧中断就清零。对对话场景（人声天然有停顿、VADNet
 *   输出 SPEECH-silence-SPEECH 断续）不够稳健，speech_len 老被清零容易漏触发。
 *   本模块在 VADNet 裸判定上套"包络积分器 + 双阈值迟滞"：把抖动的二元判定
 *   平滑成连续 score(0~1)，一帧 silence 只让 score 略降、不会清零，对断续
 *   人声更友好。这套迟滞在上一版能量法录音器（archive/vad-recorder-speex.cpp）
 *   已验证体感好，这里把判定核心从 RMS 换成 VADNet 输出。
 *
 * 算法链路
 *   音频帧 → vad_process（神经网络看频谱指纹）→ 二元 SPEECH/silence
 *         → 包络积分器（IIR 低通）→ score(0~1)
 *         → 双阈值迟滞 → IDLE / ACTIVE
 *
 *   score > HIGH      → IDLE 进 ACTIVE（要积累够多人声，滤零星噪声）
 *   score < LOW       → 开始计 hangover
 *   hangover 累计满   → ACTIVE 回 IDLE
 *
 * 关键参数取舍（详见各字段注释）
 *   VAD_MODE=0 让 VADNet 宽松（抓轻声），严格性交给外层双阈值
 *   attack 快 / release 慢 → 抗毛刺 + 对话间隙 score 缓降不停
 *   HIGH/LOW 拉开 → 迟滞带，边缘不抖
 *   hangover 兜底对话场景的对方小声说话（被判 silence 但对话还在进行）
 *
 * 天花板
 *   score 积分的是 VADNet 的二元输出（vad_process 把内部概率过了 0.5 阈值），
 *   信息量在这一步已有损失。若调到极限仍不满意，下一步是换底层 esp_vadn_iface_t
 *   接口拿概率值做积分（保留不确定度），但代码复杂度上升。
 */
class VadTrigger {
public:
  // 触发状态
  enum class State : uint8_t {
    IDLE = 0,   // 监听中（未触发）
    ACTIVE = 1, // 检测到人声活动（应该录音）
  };

  // 配置参数（结构体集中，加字段不改接口）
  struct Params {
    // ---- VADNet 神经网络 ----
    vad_mode_t vadMode = VAD_MODE_0; // 0 最易触发（少漏），4 最严格（少误触）
    int sampleRate = 16000;          // 仅支持 8000/16000/32000
    int frameMs = 30;                // VADNet 帧长：仅支持 10/20/30

    // ---- 包络积分器（attack 快 / release 慢，IIR 低通滤波）----
    // attack 选择：积分的是二元值（0/1），score_n = 1 - attack^n（连续
    // SPEECH）。 要"积累 N 帧才触发"以滤单帧噪声：
    //   attack=0.70 → 3 帧≈90ms 到 HIGH（滤 1-2 帧瞬态噪声）
    //   attack=0.30 → 1 帧就破 HIGH（太敏感，单帧噪声误触发，已弃用）
    float attack = 0.70f; // 帧判 SPEECH 时：score = score*attack + 1*(1-attack)
    float release =
        0.92f; // ACTIVE 态帧判 silence 时：score = score*release + 0*(1-release)
               // 越大下降越慢（τ≈360ms，对话间隙 score 缓降，不立刻停）
    float releaseIdle =
        0.75f; // IDLE 态（未触发）的下降系数：快泄 τ≈100ms。
               // 连环咳嗽/连续敲击的间隙里 score 迅速泄掉，不会跨间隙累积
               // 垫到 HIGH 阈值。ACTIVE 态不用它（对话停顿不能快掉）。
               // 设为与 release 同值即退回旧行为（状态无关衰减）

    // ---- 三区间迟滞（HIGH > MID > LOW）----
    float highThreshold = 0.60f; // 上穿 → ACTIVE（要近期 60%+ 帧判 SPEECH）
    float midThreshold = 0.30f;  // ACTIVE 时 score>=MID 才清零 hangover（确定有声）
                                 // LOW~MID 是模糊区：lowMs 保持不变。防 VADNet 偶尔
                                 // 误判 SPEECH 让 score 抖到 LOW 以上反复重置 hangover
                                 // 导致永不停止
    float lowThreshold = 0.2f; // score<LOW → 累计 hangover（确定静）
    uint32_t hangoverMs =
        10000; // lowMs 累计满此值才退出 ACTIVE（录音豆兜底）
               // 对话场景对方小声被判 silence 时，靠这个不切断
    uint32_t warmupMs = 300;     // 开机预热：前 300ms 丢弃判定（PDM/I2S/VADNet
                                 // 灌满期读数不稳，瞬态会被误判 SPEECH 叠加 attack
                                 // 快 → 0.4s 误触发。archive 版 WARMUP_MS 同理）
    int frameWindow = 5;         // 滑动窗口帧数：最近 N 帧 VADNet 判定取占比，再更新
                                 // score。抑制瞬态噪声（翻书/轻拍）：1-2 帧误判在 5 帧
                                 // 窗口里占比 0.2-0.4 → ratio 低 → score 涨不起来。
                                 // 1 = 关闭窗口（退化为单帧）
  };

  VadTrigger() = default;
  ~VadTrigger();

  // 初始化 VADNet 实例。失败返回 false（内存不足 / 参数非法）。
  // 不用默认参数（Params() 在类内触发 NSDMI 完整性问题），调用方显式传。
  bool begin(const Params &params);

  // 释放 VADNet 实例（可重复调用，析构时自动调）
  void end();

  // 处理一帧音频，返回当前触发状态。
  // samples: 16bit 单声道样本
  // n:       样本数，必须 = sampleRate/1000*frameMs（如 16k/30ms=480）
  //          帧长不符时返回当前状态但不更新（防御 VADNet 越界）
  State process(const int16_t *samples, int n);

  // 手动重置状态机（清 score / hangover，长期静默后归零）
  void reset();

  // ---- 观测（调试 / 上层决策）----
  State getState() const { return state_; }
  float getScore() const { return score_; }          // 平滑后的语音确信度 0~1
  bool getLastRawSpeech() const { return lastRaw_; } // 上一帧 VADNet 裸判定
  uint32_t getLowMs() const { return lowMs_; }       // 当前 score<LOW 已累计 ms
  const Params &getParams() const { return params_; }

private:
  vad_handle_t vad_ = nullptr; // VADNet 实例（C 接口）
  Params params_;
  float score_ = 0; // 包络积分值 0~1
  State state_ = State::IDLE;
  uint32_t lowMs_ = 0;   // score<LOW 累计时长（ACTIVE 时计）
  bool lastRaw_ = false; // 上一帧 VADNet 裸判定
  bool begun_ = false;
  uint32_t frameCount_ = 0;   // 已处理帧数（用于预热判定）
  uint32_t warmupFrames_ = 0; // 预热帧数（= warmupMs / frameMs，begin 时算）

  // 滑动窗口（最近 N 帧 VADNet 判定，取占比抑制瞬态噪声）
  static const int MAX_WIN = 48; // 容量上限（48 帧 ≈ 1.44s @30ms，数组 192B 可忽略）
  int winBuf_[MAX_WIN] = {0}; // 环形存最近 N 帧的 0/1
  int winSize_ = 1;           // 窗口大小（= frameWindow，clamp 到 [1, MAX_WIN]）
  int winHead_ = 0;           // 写入位
  int winCount_ = 0;          // 已写入帧数（0→winSize_，满了之后不变）
  int winSum_ = 0;            // 窗口内 SPEECH 帧总数（增量维护，O(1) 取占比）
};
