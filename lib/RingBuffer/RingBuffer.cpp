#include <string.h>
#include "RingBuffer.h"

RingBuffer::~RingBuffer() { end(); }

bool RingBuffer::begin(size_t capacity) {
  if (buf_) end();
  if (capacity == 0) return false;
  buf_ = (uint8_t *)malloc(capacity);
  if (!buf_) return false;
  capacity_ = capacity;
  head_ = 0;
  len_ = 0;
  return true;
}

void RingBuffer::end() {
  if (buf_) {
    free(buf_);
    buf_ = nullptr;
  }
  capacity_ = 0;
  head_ = 0;
  len_ = 0;
}

void RingBuffer::reset() {
  head_ = 0;
  len_ = 0;
}

void RingBuffer::push(const uint8_t *data, size_t n) {
  if (!buf_ || !data || n == 0) return;

  // 超过容量时只保留最后 capacity_ 字节（丢弃最旧）
  if (n > capacity_) {
    data += n - capacity_;
    n = capacity_;
  }

  // 环形写入：可能跨末尾绕回，分两段拷贝
  size_t space = capacity_ - head_;
  if (n <= space) {
    memcpy(buf_ + head_, data, n);
  } else {
    memcpy(buf_ + head_, data, space);
    memcpy(buf_, data + space, n - space);
  }
  head_ = (head_ + n) % capacity_;

  // 有效数据量封顶在容量（覆盖式写入）
  size_t newLen = len_ + n;
  len_ = (newLen > capacity_) ? capacity_ : newLen;
}

size_t RingBuffer::flush(Print &out) {
  if (!buf_ || len_ == 0) return 0;
  // 分块写入（每次 CHUNK 字节）：避免一次性写大块（如 64KB）导致 SD 卡超时/
  // 返回不完整。SD 库内部虽按 512 扇区分，但大块 write 在某些卡上仍会失败
  const size_t CHUNK = 4096;
  size_t total = 0;
  // 通用分块写入辅助：从 buf 的 [off, off+len) 段分块写到 out
  auto writeChunked = [&](size_t off, size_t len) {
    while (len > 0) {
      size_t n = (len > CHUNK) ? CHUNK : len;
      total += out.write(buf_ + off, n);
      off += n;
      len -= n;
    }
  };
  if (len_ < capacity_) {
    writeChunked(0, len_); // 未满：[0, len_)
  } else {
    writeChunked(head_, capacity_ - head_); // 满绕回：[head, 末)
    writeChunked(0, head_);                  //        [0, head)
  }
  reset();
  return total;
}
