#ifndef FONT_ASCII16_H_GUARD
#define FONT_ASCII16_H_GUARD
#include <stdint.h>
// 自动生成：swift firmware/tools/gen_fonts.swift —— 勿手改
// 8×16 1bpp 点阵（1 字节/行 × 16 行），索引 = 字符 - 0x20
#define FONT_ASCII16_W 8
#define FONT_ASCII16_H 16
#define FONT_ASCII16_COUNT 95
extern const uint8_t FontASCII16_Data[FONT_ASCII16_COUNT][FONT_ASCII16_H];
#endif