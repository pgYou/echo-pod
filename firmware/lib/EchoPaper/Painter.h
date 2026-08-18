#pragma once
#include <Arduino.h>
#include "EPD_1in54.h"
#include "font_cn20.h"
#include "font_ascii16.h"

// 200×200 黑白墨水屏帧缓冲绘制器：矩形/线/圆/中英混排文本。
// 1bpp 与驱动一致：25 字节/行（MSB 起 8 像素/字节），1=白 0=黑。
// 文本走 UTF-8：ASCII 用 8×16 点阵，汉字用 24×24 点阵（y+4 对齐中线）。
class Painter {
public:
    static constexpr int W = EPD_1in54::WIDTH;
    static constexpr int H = EPD_1in54::HEIGHT;

    void clear(uint8_t color = EPD_1in54::WHITE);
    void setPixel(int x, int y, uint8_t c);
    void fillRect(int x, int y, int w, int h, uint8_t c);
    void drawRect(int x, int y, int w, int h, uint8_t c);
    void hline(int x0, int x1, int y, uint8_t c) { fillRect(x0, y, x1 - x0 + 1, 1, c); }
    void vline(int x, int y0, int y1, uint8_t c) { fillRect(x, y0, 1, y1 - y0 + 1, c); }
    void drawLine(int x0, int y0, int x1, int y1, uint8_t c);
    void fillCircle(int cx, int cy, int r, uint8_t c);

    // 中英混排：返回绘制后 x。汉字 24px，ASCII 8px（y+4 竖直居中于 24px 行高）
    int drawText(int x, int y, const char* utf8, uint8_t c);
    int textWidth(const char* utf8);
    // 以 (cx, y) 为水平中心绘制
    void drawTextCenter(int cx, int y, const char* utf8, uint8_t c) {
        drawText(cx - textWidth(utf8) / 2, y, utf8, c);
    }

    const uint8_t* buffer() const { return fb_; }

private:
    static int cnIndex(uint32_t codepoint);  // -1 = 无此字
    uint8_t fb_[W / 8 * H]{};
};
