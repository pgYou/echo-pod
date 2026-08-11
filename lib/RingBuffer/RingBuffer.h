#pragma once
#include <stdint.h>
#include <stddef.h>
#include <Print.h> // Arduino Print（SD 的 File 继承自它，flush 通用）

/**
 * RingBuffer — 环形预录缓冲
 * ============================================================
 * 职责
 *   持续写入音频字节；需要时按"最旧→最新"顺序刷出有效数据。不碰音频格式 /
 *   文件类型 / 判定逻辑，纯字节缓冲。
 *
 * 为什么需要（录音豆核心痛点）
 *   VAD 触发有延迟：要攒够 score 才判定为 ACTIVE，等触发时第一个字已经开始
 *   说了（几百 ms 已过）。如果触发才开始写文件，会丢首音。解法：IDLE 时持续
 *   把音频喂进环形缓冲，触发瞬间先把缓冲刷进文件 → 连触发前的引子都留住。
 *   这是行车记录仪 / Zoom / WebRTC 都用的成熟预录方案。
 *
 *   缓冲满后继续写会覆盖最旧数据（始终保留最近的 N 秒）。flush 时按顺序输出。
 *
 * 内存
 *   内部 malloc（heap）。ESP32-S3 有 PSRAM，大缓冲没问题。容量由 begin() 指定。
 *   默认 32KB ≈ 1 秒（16kHz mono 16bit）。
 *
 * 线程安全
 *   非线程安全（单生产者单消费者，同一线程调用）。当前录音豆在 loop 单线程
 *   用，够用。若以后拆采集/写入双任务，需要加锁或改用 StreamBuffer。
 */
class RingBuffer {
public:
  RingBuffer() = default;
  ~RingBuffer();

  // 分配容量（字节）。失败（capacity=0 或内存不足）返回 false。可重复调用。
  bool begin(size_t capacity);
  void end();

  // 写入数据（超过容量时覆盖最旧，保留最后 capacity 字节）
  void push(const uint8_t *data, size_t n);

  // 把有效数据按"最旧→最新"顺序刷到输出（File / Serial 等，只要是 Print）。
  // 返回刷出的字节数。刷完后缓冲清空（reset）。
  size_t flush(Print &out);

  // 清空缓冲（不释放内存）
  void reset();

  // ---- 观测 ----
  size_t available() const { return len_; }     // 当前有效字节数
  size_t capacity() const { return capacity_; } // 总容量
  bool isFull() const { return len_ >= capacity_; }

private:
  uint8_t *buf_ = nullptr;
  size_t capacity_ = 0;
  size_t head_ = 0; // 下一个写入位
  size_t len_ = 0;  // 有效数据量（封顶 capacity_）
};
