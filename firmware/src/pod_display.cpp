#include "pod_display.h"
#include "EPD_1in54.h"
#include "Painter.h"

namespace pod {

static EPD_1in54 epd;
static Painter paint;

void displayBegin() { epd.begin(); }

// 顶栏电池图标：外框 28×14 + 电池帽 + 黑色电量条；充电时条中央抠白色闪电
static void drawBattery(int x, int y, const PageInfo &i) {
  using E = EPD_1in54;
  paint.drawRect(x, y, 28, 14, E::BLACK);
  paint.fillRect(x + 28, y + 4, 3, 6, E::BLACK);
  int w = 24 * i.batteryPct / 100;
  if (i.batteryPct > 0 && w < 2) w = 2;
  paint.fillRect(x + 2, y + 2, w, 10, E::BLACK);
  if (i.charging) {
    paint.drawLine(x + 14, y + 3, x + 10, y + 8, E::WHITE);
    paint.drawLine(x + 10, y + 8, x + 13, y + 8, E::WHITE);
    paint.drawLine(x + 13, y + 8, x + 11, y + 11, E::WHITE);
  }
}

void showPage(Page p, const PageInfo &info) {
  using E = EPD_1in54;
  paint.clear();

  // ---- 顶栏（0..29，垂直中线 15；录音/低电/错误实心点，其余空心）。关机页无顶栏 ----
  static const char *kName[] = {"待机", "录音", "已暂停", "同步", "低电", "存储"};
  if (p != Page::SHUTDOWN) {
    bool filled = (p == Page::RECORDING || p == Page::LOWBAT || p == Page::ERROR_);
    paint.fillCircle(12, 15, 6, E::BLACK);
    if (!filled) paint.fillCircle(12, 15, 4, E::WHITE);
    paint.drawText(24, 5, kName[(int)p], E::BLACK);
    drawBattery(136, 8, info);
    char pct[8];
    snprintf(pct, sizeof(pct), "%d%%", info.batteryPct);
    paint.drawText(172, 5, pct, E::BLACK);
    paint.hline(0, 199, 30, E::BLACK);
  }

  // ---- 主体 ----
  switch (p) {
    case Page::STANDBY: {
      paint.fillRect(94, 50, 12, 22, E::BLACK);  // 麦克风图标
      paint.fillCircle(100, 61, 6, E::BLACK);
      paint.vline(84, 54, 72, E::BLACK);
      paint.vline(116, 54, 72, E::BLACK);
      paint.hline(84, 116, 54, E::BLACK);
      paint.vline(100, 72, 80, E::BLACK);
      paint.hline(88, 112, 81, E::BLACK);
      paint.drawTextCenter(100, 100, "监听中", E::BLACK);
      break;
    }
    case Page::RECORDING: {
      static const int hs[] = {10, 22, 34, 26, 40, 18, 12};  // 波形条
      for (int i2 = 0; i2 < 7; i2++)
        paint.fillRect(44 + i2 * 16, 76 - hs[i2] / 2, 10, hs[i2], E::BLACK);
      char s[24];
      snprintf(s, sizeof(s), "录音中 第%d段", info.segNo);
      paint.drawTextCenter(100, 112, s, E::BLACK);
      break;
    }
    case Page::MUTED: {
      paint.fillRect(80, 52, 14, 36, E::BLACK);  // 暂停图标
      paint.fillRect(106, 52, 14, 36, E::BLACK);
      paint.drawTextCenter(100, 102, "已暂停", E::BLACK);
      paint.drawTextCenter(100, 134, "长按BOOT恢复", E::BLACK);
      break;
    }
    case Page::SYNC: {
      paint.vline(86, 52, 80, E::BLACK);  // 上下双箭头
      paint.drawLine(80, 60, 86, 52, E::BLACK);
      paint.drawLine(86, 52, 92, 60, E::BLACK);
      paint.vline(114, 52, 80, E::BLACK);
      paint.drawLine(108, 72, 114, 80, E::BLACK);
      paint.drawLine(114, 80, 120, 72, E::BLACK);
      paint.drawTextCenter(100, 100, "电脑已连接", E::BLACK);
      paint.drawTextCenter(100, 128, "正在同步", E::BLACK);
      if (info.charging) paint.drawTextCenter(100, 152, "充电中", E::BLACK);
      break;
    }
    case Page::LOWBAT: {
      paint.drawRect(36, 36, 128, 128, E::BLACK);  // 双线粗框警示
      paint.drawRect(40, 40, 120, 120, E::BLACK);
      paint.drawLine(100, 56, 64, 122, E::BLACK);  // 警告三角
      paint.drawLine(100, 56, 136, 122, E::BLACK);
      paint.drawLine(64, 122, 136, 122, E::BLACK);
      paint.fillRect(96, 80, 8, 22, E::BLACK);  // 感叹号
      paint.fillRect(96, 106, 8, 8, E::BLACK);
      paint.drawTextCenter(100, 128, "请充电", E::BLACK);
      break;
    }
    case Page::ERROR_: {
      // 去矩形双线框；错误可能来自 SD/I2C/音频初始化，文案不做具体归因
      paint.fillRect(96, 44, 8, 26, E::BLACK);  // 感叹号
      paint.fillRect(96, 82, 8, 8, E::BLACK);
      paint.drawTextCenter(100, 116, "设备异常", E::BLACK);
      paint.drawTextCenter(100, 148, "长按PWR键关机", E::BLACK);
      break;
    }
    case Page::SHUTDOWN: {
      paint.drawTextCenter(100, 70, "已关机", E::BLACK);
      paint.drawTextCenter(100, 110, "按PWR键重新开机", E::BLACK);
      break;  // 无底栏，下方条件跳过
    }
  }

  // ---- 底栏（RTC 时间 + 今日条数；关机页无）----
  if (p != Page::SHUTDOWN) {
    paint.hline(0, 199, 170, E::BLACK);
    paint.drawText(8, 175, info.clock, E::BLACK);
    char cnt[24];
    snprintf(cnt, sizeof(cnt), "今日%d条", info.todayCount);
    paint.drawText(200 - 8 - paint.textWidth(cnt), 174, cnt, E::BLACK);
  }

  epd.display(paint.buffer());
}

}  // namespace pod
