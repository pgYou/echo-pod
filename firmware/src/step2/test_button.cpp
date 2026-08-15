/**
 * B2 验证：多功能按键（INPUT_PULLUP + 消抖 + 长短按判定）
 * ============================================
 * 焊接：按键一脚接 D0/GPIO1，另一脚接 GND（见 wiring-guide.md 分电路详解 4）
 * 目的：焊完按键后烧此固件，验证按下/松开检测、消抖、短按/长按分类
 *
 * 判定逻辑（与 stage2-firmware-design.md 按键行为一致）：
 *   按下 < 1s  → 短按（运行中切换 LISTENING↔RECORDING）
 *   按下 ≥ 3s  → 长按（关机流程：finalize WAV → 红光快闪 → Deep Sleep）
 *   1~3s 松开 → 无操作（消抖缓冲区，防误触）
 *
 * 电平：INPUT_PULLUP，松开=HIGH(3.3V)，按下=LOW(接地)
 */

#include <Arduino.h>

constexpr uint8_t BUTTON_PIN = 1;               // D0 = GPIO1，多功能按键
constexpr unsigned long DEBOUNCE_MS = 20;       // 消抖窗口（机械按键抖动 ~10ms）
constexpr unsigned long SHORT_PRESS_MAX = 1000; // 短按上限
constexpr unsigned long LONG_PRESS_MIN = 3000;  // 长按下限

// 消抖状态
bool lastRaw = HIGH;                // 上次原始读数
bool lastStable = HIGH;             // 上次稳定读数（INPUT_PULLUP 默认 HIGH）
unsigned long lastChangeMs = 0;     // 上次电平变化时刻

// 按键事件状态
unsigned long pressStartMs = 0;     // 本次按下起始时刻
bool longPressAnnounced = false;    // 达到长按阈值时已实时提示

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 2000) delay(10);

  Serial.println("\n====================================");
  Serial.println(" B2 按键验证");
  Serial.println(" 按键=GPIO1(D0) · INPUT_PULLUP · 另一端 GND");
  Serial.println("====================================");
  Serial.println(" 操作：按下/松开按键，串口打印分类");
  Serial.println("   <1s = 短按  |  1~3s = 无操作  |  ≥3s = 长按");
  Serial.println(" （按住达 3s 会立即提示「已达长按阈值」，不必等到松开）\n");

  pinMode(BUTTON_PIN, INPUT_PULLUP);
}

void loop() {
  bool raw = digitalRead(BUTTON_PIN);

  // 消抖：电平变化后稳定 DEBOUNCE_MS 才采纳为新稳态
  if (raw != lastRaw) {
    lastRaw = raw;
    lastChangeMs = millis();
  }
  bool stable = (millis() - lastChangeMs >= DEBOUNCE_MS) ? raw : lastStable;

  // 稳定电平发生跳变 → 触发按下/松开事件
  if (stable != lastStable) {
    lastStable = stable;
    if (stable == LOW) {
      // HIGH → LOW：按下
      pressStartMs = millis();
      longPressAnnounced = false;
      Serial.printf("[%.1fs] 按下 (LOW)\n", millis() / 1000.0);
    } else {
      // LOW → HIGH：松开，按持续时间分类
      unsigned long duration = millis() - pressStartMs;
      const char *type;
      if (duration < SHORT_PRESS_MAX) type = "短按";
      else if (duration >= LONG_PRESS_MIN) type = "长按";
      else type = "无操作（消抖缓冲区）";
      Serial.printf("[%.1fs] 松开，持续 %lums → %s\n",
                    millis() / 1000.0, duration, type);
    }
  }

  // 实时反馈：按住达到长按阈值时立即提示（不等松开）
  if (lastStable == LOW && !longPressAnnounced &&
      millis() - pressStartMs >= LONG_PRESS_MIN) {
    longPressAnnounced = true;
    Serial.printf("[%.1fs] ★ 已达长按阈值 3s（松开即触发长按）\n",
                  millis() / 1000.0);
  }
}
