#pragma once
#include <Arduino.h>

// 微雪 ESP32-S3-ePaper-1.54（黑白版）墨水屏薄壳。
// 底层为官方 epaper_driver_bsp（lib/EchoPaper/epaper_driver_bsp.*，一字未改，
// 2026-08-17 实机验证：585ms 局部刷新清晰稳定）。本壳只负责：
//   1. 屏供电（EPD_PWR=GPIO6 低有效，官方例程在 user_app 侧做，这里补齐）
//   2. 官方调用序列：Init → 白底基线(DisplayPartBaseImage) → Init_Partial
//      → 此后每帧只写 0x24 + DisplayPart 局部快刷
//   3. 适配 Painter 的 1bpp 帧缓冲（1=白 0=黑，25 字节/行 × 200）
//
// 踩坑实录（前三版教训）：手写 Arduino SPI 传输层（逐段 CS 翻转写）在长帧
// 数据上引发 BUSY 卡死——刷新模型与 SPI 层都以官方实机代码为准，不再自研。
class EPD_1in54 {
public:
    static constexpr int WIDTH = 200;
    static constexpr int HEIGHT = 200;
    static constexpr int FB_SIZE = WIDTH / 8 * HEIGHT;  // 5000 字节

    // 帧缓冲像素值
    static constexpr uint8_t BLACK = 0;
    static constexpr uint8_t WHITE = 1;

    static constexpr int PIN_PWR = 6;  // 屏供电使能，低有效

    void begin();   // 屏上电 + 官方 Init + 白底基线 + 局部刷新模式
    void display(const uint8_t* fb);    // 帧缓冲送屏（局部快刷 ~600ms）
    void clear(uint8_t colorBit);       // 重建基线（全刷，洗残影用；仅支持白）
    void powerOff();                    // 断屏电（画面驻留）
};
