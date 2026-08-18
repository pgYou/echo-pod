#include "Painter.h"

void Painter::clear(uint8_t color) {
    memset(fb_, color == EPD_1in54::WHITE ? 0xFF : 0x00, sizeof(fb_));
}

void Painter::setPixel(int x, int y, uint8_t c) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    uint8_t& b = fb_[y * (W / 8) + (x >> 3)];
    uint8_t mask = 0x80 >> (x & 7);
    if (c == EPD_1in54::WHITE) b |= mask;
    else b &= ~mask;
}

void Painter::fillRect(int x, int y, int w, int h, uint8_t c) {
    for (int j = y; j < y + h; j++)
        for (int i = x; i < x + w; i++) setPixel(i, j, c);
}

void Painter::drawRect(int x, int y, int w, int h, uint8_t c) {
    hline(x, x + w - 1, y, c);
    hline(x, x + w - 1, y + h - 1, c);
    vline(x, y, y + h - 1, c);
    vline(x + w - 1, y, y + h - 1, c);
}

void Painter::drawLine(int x0, int y0, int x1, int y1, uint8_t c) {
    int dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    int dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    int err = dx + dy;
    for (;;) {
        setPixel(x0, y0, c);
        if (x0 == x1 && y0 == y1) break;
        int e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
}

void Painter::fillCircle(int cx, int cy, int r, uint8_t c) {
    for (int dy = -r; dy <= r; dy++) {
        int half = (int)sqrtf((float)(r * r - dy * dy));
        fillRect(cx - half, cy + dy, 2 * half + 1, 1, c);
    }
}

int Painter::cnIndex(uint32_t codepoint) {
    for (int i = 0; i < FONT_CN20_COUNT; i++)
        if (pgm_read_dword(&FontCN20_Index[i]) == codepoint) return i;
    return -1;
}

// UTF-8 解码：返回码点和字节数（仅支持 ASCII / 3 字节汉字区，其他按无墨迹跳过）
static int utf8Next(const char* s, uint32_t& cp) {
    uint8_t b0 = (uint8_t)s[0];
    if (b0 == 0) return 0;
    if (b0 < 0x80) { cp = b0; return 1; }
    if ((b0 & 0xF0) == 0xE0 && (uint8_t)s[1] && (uint8_t)s[2]) {
        cp = ((uint32_t)(b0 & 0x0F) << 12) | ((uint32_t)((uint8_t)s[1] & 0x3F) << 6) |
             ((uint8_t)s[2] & 0x3F);
        return 3;
    }
    cp = '?';
    return 1;
}

int Painter::textWidth(const char* utf8) {
    int w = 0;
    uint32_t cp;
    for (int n; (n = utf8Next(utf8, cp)) > 0; utf8 += n) {
        w += cp > 0x7F ? FONT_CN20_SIZE : FONT_ASCII16_W;
    }
    return w;
}

int Painter::drawText(int x, int y, const char* utf8, uint8_t c) {
    uint32_t cp;
    for (int n; (n = utf8Next(utf8, cp)) > 0; utf8 += n) {
        if (cp > 0x7F) {  // 汉字 24×24，3 字节/行
            int idx = cnIndex(cp);
            if (idx >= 0) {
                const uint8_t* g = FontCN20_Data[idx];
                for (int gy = 0; gy < FONT_CN20_SIZE; gy++) {
                    uint32_t row = (uint32_t)pgm_read_byte(&g[gy * 3]) << 16 |
                                   (uint32_t)pgm_read_byte(&g[gy * 3 + 1]) << 8 |
                                   pgm_read_byte(&g[gy * 3 + 2]);
                    for (int gx = 0; gx < FONT_CN20_SIZE; gx++)
                        if (row & (0x800000 >> gx)) setPixel(x + gx, y + gy, c);
                }
            }
            x += FONT_CN20_SIZE;
        } else {  // ASCII 8×16，1 字节/行，竖直居中于 20px 行高
            if (cp >= 0x20 && cp < 0x7F) {
                const uint8_t* g = FontASCII16_Data[cp - 0x20];
                for (int gy = 0; gy < FONT_ASCII16_H; gy++) {
                    uint8_t row = pgm_read_byte(&g[gy]);
                    for (int gx = 0; gx < 8; gx++)
                        if (row & (0x80 >> gx)) setPixel(x + gx, y + (FONT_CN20_SIZE - FONT_ASCII16_H) / 2 + gy, c);
                }
            }
            x += FONT_ASCII16_W;
        }
    }
    return x;
}
