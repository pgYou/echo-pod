/**
 * B1 验证：白光 + 红光 LED（LEDC PWM）
 * ============================================
 * 焊接：白光 D3/GPIO4、红光 D1/GPIO2，各串 220Ω → GND（见 wiring-guide.md）
 * 目的：焊完两颗 LED 后烧此固件，逐段演示验证焊接 + PWM 通道
 *
 * arduino-esp32 3.x LEDC API：按引脚分配通道
 *   ledcAttach(pin, freq, bits) / ledcWrite(pin, duty)
 * （旧 2.x 的 ledcSetup/ledcAttachPin/ledcWrite(channel) 已废弃，3.3.11 编译不过）
 */

#include <Arduino.h>

constexpr uint8_t  WHITE_PIN = 4;    // D3 = GPIO4，录音指示灯
constexpr uint8_t  RED_PIN   = 2;    // D1 = GPIO2，状态/充电/低电指示灯
constexpr uint32_t PWM_FREQ  = 1000; // 1kHz，无闪烁感
constexpr uint8_t  PWM_BITS  = 8;    // duty 范围 0-255

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 2000) delay(10);

  Serial.println("\n====================================");
  Serial.println(" B1 LED 验证");
  Serial.println(" 白光=GPIO4(D3)  红光=GPIO2(D1)");
  Serial.println("====================================");

  // 3.x：ledcAttach 按引脚自动分配 LEDC 通道，返回 false 说明该引脚不支持 PWM
  if (!ledcAttach(WHITE_PIN, PWM_FREQ, PWM_BITS))
    Serial.println("X 白光 LEDC 附加失败（GPIO4 不支持 PWM？）");
  if (!ledcAttach(RED_PIN, PWM_FREQ, PWM_BITS))
    Serial.println("X 红光 LEDC 附加失败（GPIO2 不支持 PWM？）");

  ledcWrite(WHITE_PIN, 0);
  ledcWrite(RED_PIN, 0);
  Serial.println("OK 两路 LEDC 就绪，开始演示\n");
}

// --- 演示分段：每段串口先打印再执行，便于对照观察 ---

static void demoWhite() {
  Serial.println("[1/4] 白光常亮 3s");
  ledcWrite(WHITE_PIN, 255);
  ledcWrite(RED_PIN, 0);
  delay(3000);
  Serial.println("      白光灭 1s");
  ledcWrite(WHITE_PIN, 0);
  delay(1000);
}

static void demoRedSteady() {
  Serial.println("[2/4] 红光常亮 3s");
  ledcWrite(RED_PIN, 255);
  delay(3000);
  ledcWrite(RED_PIN, 0);
}

static void demoRedBreathing() {
  Serial.println("[3/4] 红光呼吸 2 周期（0->255->0）");
  for (int c = 0; c < 2; c++) {
    for (int d = 0; d <= 255; d += 5) { ledcWrite(RED_PIN, d); delay(15); }
    for (int d = 255; d >= 0; d -= 5) { ledcWrite(RED_PIN, d); delay(15); }
  }
}

static void demoRedBlink() {
  Serial.println("[4/4] 红光闪烁 3 次");
  for (int i = 0; i < 3; i++) {
    ledcWrite(RED_PIN, 255); delay(200);
    ledcWrite(RED_PIN, 0);   delay(200);
  }
}

void loop() {
  demoWhite();
  demoRedSteady();
  demoRedBreathing();
  demoRedBlink();
  Serial.println("----- 一轮结束，循环 -----\n");
  delay(1000);
}
