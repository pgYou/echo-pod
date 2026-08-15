/* libspeexdsp 构建配置（ESP32-S3 移植）
 * - FLOATING_POINT：S3 有 FPU，用浮点（精度好、代码简单）
 * - USE_SMALLFT：用 smallft.c 的 FFT（比 kiss 简单，浮点模式默认）
 * - 不定义 USE_KISS_FFT / FIXED_POINT
 * - EXPORT 留空（不需要 DLL 导出）
 * - 不开 USE_ALLOCA（用 calloc 路径，ESP32 上安全）
 */
#ifndef SPEEXDSP_CONFIG_H
#define SPEEXDSP_CONFIG_H

/* HAVE_CONFIG_H 由 library.json 的 -DHAVE_CONFIG_H 提供，这里不重复定义 */
#define FLOATING_POINT
#define USE_SMALLFT
#define EXPORT

#endif
