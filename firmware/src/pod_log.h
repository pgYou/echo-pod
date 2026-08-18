#pragma once
#include <Arduino.h>

/**
 * pod_log — 设备日志（串口 + SD 卡双写）
 * ============================================================
 * 位置：/sdcard/echo-pod/.logs/YYYY-MM-DD.log（录音目录内的隐藏子目录，App
 * 扫描忽略 . 开头，见
 * device-protocol.md v1.1 §5）。事件级：写后即 fflush，掉电不丢；高频心跳
 * （VAD 5s）不入卡，避免干扰录音 WAV 顺序写。保留最近 7 天，开机自动清理。
 * 卡未挂载/写入失败时静默降级为仅串口（绝不影响主流程）。
 */
namespace pod::log {

void begin();  // SD 挂载成功后调用：开当天文件 + 清理旧日志
void event(const char *fmt, ...);  // 事件日志：串口 + 文件（带时间戳）
void tick();  // loop 周期调用：跨天滚动（60s 检查一次）

}  // namespace pod::log
