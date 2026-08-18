#include "EPD_1in54.h"
#include "epaper_driver_bsp.h"

// 官方驱动实例（epaper_driver_bsp 一字未改）
static epaper_driver_display* drv = nullptr;

void EPD_1in54::begin() {
    pinMode(PIN_PWR, OUTPUT);
    digitalWrite(PIN_PWR, LOW);  // 屏上电（低有效）
    delay(10);

    custom_lcd_spi_t cfg = {};
    cfg.cs = 11;    // EPD_CS_PIN
    cfg.dc = 10;    // EPD_DC_PIN
    cfg.rst = 9;    // EPD_RST_PIN
    cfg.busy = 8;   // EPD_BUSY_PIN
    cfg.mosi = 13;  // EPD_MOSI_PIN
    cfg.scl = 12;   // EPD_SCK_PIN
    cfg.spi_host = 1;  // SPI2_HOST（官方例程用 SPI2_HOST； Arduino SPI 库未初始化不冲突）
    cfg.buffer_len = 5000;

    drv = new epaper_driver_display(WIDTH, HEIGHT, cfg);
    // 官方 user_app.cpp 调用链原样
    drv->EPD_Init();
    drv->EPD_Clear();                  // buffer 白底
    drv->EPD_DisplayPartBaseImage();   // 0x24+0x26 双写 + 全刷基线
    drv->EPD_Init_Partial();           // 转局部刷新模式
}

void EPD_1in54::display(const uint8_t* fb) {
    // 官方 flush_cb 同款：清白 → 画黑像素 → 局部刷
    drv->EPD_Clear();
    for (int y = 0; y < HEIGHT; y++) {
        const uint8_t* row = fb + y * (WIDTH / 8);
        for (int xb = 0; xb < WIDTH / 8; xb++) {
            uint8_t b = row[xb];
            if (b == 0xFF) continue;  // 整字节全白跳过
            for (int i = 0; i < 8; i++)
                if (!(b & (0x80 >> i)))
                    drv->EPD_DrawColorPixel(xb * 8 + i, y, DRIVER_COLOR_BLACK);
        }
    }
    drv->EPD_DisplayPart();  // 0x24 + 局部刷新（0xCF，刷后自动维护旧数据 RAM）
}

void EPD_1in54::clear(uint8_t colorBit) {
    // 重建基线（洗残影用）：官方白底全刷序列。仅支持白。
    if (colorBit != WHITE) return;
    drv->EPD_Clear();
    drv->EPD_DisplayPartBaseImage();
    drv->EPD_Init_Partial();
}

void EPD_1in54::powerOff() {
    // 官方驱动无私有命令通道，直接断屏电（e-paper 断电画面驻留）
    digitalWrite(PIN_PWR, HIGH);
}
