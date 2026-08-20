#include "pod_board.h"
#include "config.h"
#include <Wire.h>
#include <time.h>

namespace pod {

// ============ 电源闩锁 ============
void latchTakeover() {
  pinMode(PIN_VBAT_LATCH, OUTPUT);
  digitalWrite(PIN_VBAT_LATCH, HIGH);
}

void powerOff() {
  digitalWrite(PIN_VBAT_LATCH, LOW);
}

// ============ 绿灯 ============
static Led ledMode_ = Led::OFF;
static uint32_t ledLastBlink_ = 0;
static bool ledOn_ = false;

static void greenWrite(bool on) {
  ledOn_ = on;
  digitalWrite(PIN_LED_GREEN, on ? LOW : HIGH);  // 低电平点亮
}

void setLed(Led mode) {
  ledMode_ = mode;
  if (mode == Led::ON) greenWrite(true);
  else if (mode == Led::OFF) greenWrite(false);
  // BLINK 由 ledTick 驱动
}

void ledTick() {
  if (ledMode_ != Led::BLINK_500MS) return;
  if (millis() - ledLastBlink_ >= 500) {
    ledLastBlink_ = millis();
    greenWrite(!ledOn_);
  }
}

// ============ 电池 ============
// 电压 → 百分比查表（interaction-design.md §8.1，锂电平台期非线性线性插值）
static const float kV2P[][2] = {
    {4.20f, 100}, {4.06f, 90}, {3.98f, 80}, {3.92f, 70}, {3.87f, 60}, {3.82f, 50},
    {3.79f, 40},  {3.77f, 30}, {3.74f, 20}, {3.68f, 10}, {3.45f, 5},  {3.00f, 0}};

static int voltToPercent(float v) {
  if (v >= kV2P[0][0]) return 100;
  for (int i = 0; i < 11; i++) {
    if (v >= kV2P[i + 1][0]) {
      float f = (v - kV2P[i + 1][0]) / (kV2P[i][0] - kV2P[i + 1][0]);
      return (int)(kV2P[i + 1][1] + f * (kV2P[i][1] - kV2P[i + 1][1]));
    }
  }
  return 0;
}

void batteryInit() {
  analogReadResolution(12);
  (void)analogRead(PIN_BAT_ADC);  // 预热：触发通道配置（3.x 直接 setAttenuation 会报 not configured）
  analogSetPinAttenuation(PIN_BAT_ADC, ADC_11db);
}

Battery batterySample() {
  uint32_t mv = 0;
  for (int i = 0; i < 8; i++) {
    mv += analogReadMilliVolts(PIN_BAT_ADC);
    delay(2);
  }
  Battery b;
  b.volts = (mv / 8) * 2.0f / 1000.0f;  // ÷2 分压回乘
  b.pct = voltToPercent(b.volts);
  b.charging = Serial.isPlugged();  // USB 在线 = ETA6098 充电中（红灯亮）
  return b;
}

// ============ 按键 ============
struct Btn {
  uint8_t pin;
  bool down = false;
  bool armed = false;      // 上电时若被按住，等松开后才武装（PWR 开机场景）
  bool hold3Fired = false;
  bool hold5Fired = false;
  uint32_t tDown = 0;
};
static Btn boot_{PIN_BOOT_KEY};
static Btn pwr_{PIN_PWR_KEY};

// 单键轮询：返回 短按(true) / 无(false)，3s/5s 沿通过参数带出
static bool pollBtn(Btn &b, uint32_t now, bool &fired3s, bool &fired5s) {
  fired3s = fired5s = false;
  bool pressed = digitalRead(b.pin) == LOW;
  if (!pressed) {
    bool wasShort = b.down && !b.hold3Fired && (now - b.tDown < KEY_SHORT_MS);
    b.down = false;
    b.armed = true;
    b.hold3Fired = b.hold5Fired = false;
    return wasShort;
  }
  if (!b.down) {
    b.down = true;
    b.tDown = now;
    return false;
  }
  if (!b.armed) return false;  // 上电按住场景（PWR 开机）：松手前不触发
  if (!b.hold3Fired && now - b.tDown >= KEY_HOLD_MS) {
    b.hold3Fired = true;
    fired3s = true;
  } else if (b.hold3Fired && !b.hold5Fired && now - b.tDown >= KEY_FORMAT_MS) {
    b.hold5Fired = true;
    fired5s = true;
  }
  return false;
}

KeyEvent keyPoll() {
  uint32_t now = millis();
  bool f3, f5;
  if (pollBtn(boot_, now, f3, f5)) return KeyEvent::BOOT_SHORT;
  if (f5) return KeyEvent::BOOT_HOLD5S;
  if (f3) return KeyEvent::BOOT_HOLD3S;
  pollBtn(pwr_, now, f3, f5);  // PWR 只认 3s（5s 不分派）
  if (f3) return KeyEvent::PWR_HOLD3S;
  return KeyEvent::NONE;
}

static constexpr uint8_t PIN_I2C_SDA = 47;
static constexpr uint8_t PIN_I2C_SCL = 48;

// ---- I2C 总线恢复（SDA 被从机卡死的经典场景）----
// 某器件（SHTC3/ES8311 常见）在掉电/复位瞬间的半截事务里拉住 SDA 不放，
// 之后一切 I2C 事务都是 bus busy。标准恢复：9 个 SCL 时钟冲完事务 + STOP。
bool i2cSdaStuckLow() {
  Wire.end();
  pinMode(PIN_I2C_SDA, INPUT_PULLUP);
  delay(2);
  bool stuck = digitalRead(PIN_I2C_SDA) == LOW;
  return stuck;
}

void i2cBusRecover() {
  Wire.end();
  pinMode(PIN_I2C_SCL, OUTPUT_OPEN_DRAIN);
  pinMode(PIN_I2C_SDA, OUTPUT_OPEN_DRAIN);
  digitalWrite(PIN_I2C_SCL, HIGH);
  digitalWrite(PIN_I2C_SDA, HIGH);
  delayMicroseconds(10);
  for (int i = 0; i < 9; i++) {  // 9 个时钟把从机卡住的位移完
    digitalWrite(PIN_I2C_SCL, LOW);
    delayMicroseconds(5);
    digitalWrite(PIN_I2C_SCL, HIGH);
    delayMicroseconds(5);
  }
  // STOP 条件：SCL 高时 SDA 由低拉高
  digitalWrite(PIN_I2C_SDA, LOW);
  delayMicroseconds(5);
  digitalWrite(PIN_I2C_SDA, HIGH);
  delayMicroseconds(10);
  pinMode(PIN_I2C_SDA, INPUT_PULLUP);
  pinMode(PIN_I2C_SCL, INPUT_PULLUP);
  delay(2);
}

// ============ RTC（PCF85063）============
// I2C 0x51，寄存器 0x04 起 7 字节 BCD；SEC bit7 = OS 停振标志（=1 掉电过）
// 实测（2026-08-17）：RTC 在电源闩锁前端电池直供，真关机存活 → 开机即权威时间源
static constexpr uint8_t RTC_ADDR = 0x51;
static bool rtcPresent_ = false;

static uint8_t bcd2bin(uint8_t b) { return (b >> 4) * 10 + (b & 0x0F); }
static uint8_t bin2bcd(uint8_t v) { return ((v / 10) << 4) | (v % 10); }

bool rtcRead(RtcTime &t) {
  Wire.beginTransmission(RTC_ADDR);
  Wire.write(0x04);
  // STOP 模式（true）：NO-STOP+requestFrom 组合在 hal-i2c-ng 上会把总线挂死
  // （后续事务全部 ESP_ERR_INVALID_STATE，v0.1.0 实测）。PCF85063 支持 STOP-START。
  uint8_t e = Wire.endTransmission(true);
  if (e != 0) {
    static bool logged = false;
    if (!logged) {
      logged = true;
      Serial.printf("[rtc] 读取失败：I2C 写阶段错误 %d（1=超时总线忙 2=NACK地址 3=NACK数据 4=其他）\n", e);
    }
    return false;
  }
  if (Wire.requestFrom((int)RTC_ADDR, 7) != 7) {
    static bool logged2 = false;
    if (!logged2) {
      logged2 = true;
      Serial.println("[rtc] 读取失败：I2C 读字节不足");
    }
    return false;
  }
  uint8_t sec = Wire.read();           // 0x04 bit7 = OS 停振标志
  t.mi = bcd2bin(Wire.read() & 0x7F);
  t.h = bcd2bin(Wire.read() & 0x3F);
  t.d = bcd2bin(Wire.read() & 0x3F);
  Wire.read();                         // 0x08 weekday
  t.mo = bcd2bin(Wire.read() & 0x1F);
  t.y = bcd2bin(Wire.read());
  t.s = bcd2bin(sec & 0x7F);
  return (sec & 0x80) == 0;            // OS=0 → 晶振持续走时，时间有效
}

static void rtcWrite(const RtcTime &t) {
  Wire.beginTransmission(RTC_ADDR);
  Wire.write(0x04);
  Wire.write(bin2bcd(t.s));  // 写入即清 OS 标志
  Wire.write(bin2bcd(t.mi));
  Wire.write(bin2bcd(t.h));
  Wire.write(bin2bcd(t.d));
  Wire.write(0x01);          // weekday 随意
  Wire.write(bin2bcd(t.mo));
  Wire.write(bin2bcd(t.y));
  Wire.endTransmission();
}

static time_t rtcToUnix(const RtcTime &t) {
  // Howard Hinnant days_from_civil + 显式东八区偏移：不依赖 TZ 环境变量初始化顺序
  // （v0.1.0 踩坑：mktime 在 TimeSync 设 TZ 前调用，系统时间/录音文件名全错到 0 点）
  int y = 2000 + t.y, m = t.mo, d = t.d;
  y -= m <= 2;
  const int era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153u * (m + (m > 2 ? -3 : 9)) + 2) / 5 + (unsigned)d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  long days = (long)era * 146097 + (long)doe - 719468;
  return (time_t)days * 86400 + t.h * 3600 + t.mi * 60 + t.s - 8 * 3600;
}

static void setSystemTime(time_t ts) {
  struct timeval tv;
  tv.tv_sec = ts;
  tv.tv_usec = 0;
  settimeofday(&tv, nullptr);
}

// 编译时刻（__DATE__/__TIME__，本机墙钟=东八区）—— 兜底起步值 / 新旧比较基准
static RtcTime compileTime() {
  static const char *kMo[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
  char monStr[4] = {0};
  int day, year, h, mi, s;
  sscanf(__DATE__, "%3s %d %d", monStr, &day, &year);
  sscanf(__TIME__, "%d:%d:%d", &h, &mi, &s);
  uint8_t moN = 1;
  for (int i = 0; i < 12; i++)
    if (strcmp(monStr, kMo[i]) == 0) moN = i + 1;
  return {(uint8_t)(year - 2000), moN, (uint8_t)day, (uint8_t)h, (uint8_t)mi, (uint8_t)s};
}

void rtcSet(time_t unixSec) {
  // 统一校时入口：系统时钟无条件设（无芯片时也要走时间）；芯片在则同步写回
  if (unixSec < 1577836800) return;  // <2020-01-01 = 异常值（SETTIME 手误/解析垃圾），拒绝
  setSystemTime(unixSec);
  if (!rtcPresent_) return;
  time_t local = unixSec + 8 * 3600;  // 东八区墙钟（UTC + 偏移，gmtime_r 无 TZ 依赖）
  struct tm ti;
  gmtime_r(&local, &ti);
  RtcTime t;
  t.y = ti.tm_year + 1900 - 2000;
  t.mo = ti.tm_mon + 1;
  t.d = ti.tm_mday;
  t.h = ti.tm_hour;
  t.mi = ti.tm_min;
  t.s = ti.tm_sec;
  rtcWrite(t);
}

bool rtcBegin() {
  // 总线卡死自愈：SDA 被拉低（半截事务残留）→ 9 时钟恢复
  if (i2cSdaStuckLow()) {
    Serial.println("[i2c] SDA 卡低，执行总线恢复（9 时钟 + STOP）");
    i2cBusRecover();
    if (i2cSdaStuckLow()) {
      Serial.println("[i2c] X 恢复后 SDA 仍低（器件硬件级卡死，需真关机断电）");
    } else {
      Serial.println("[i2c] 恢复成功，SDA 释放");
    }
  }
  if (!Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL)) {
    Serial.println("[rtc] Wire.begin 失败，重置总线重试");
    Wire.end();
    delay(10);
    if (!Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL)) {
      Serial.println("[rtc] Wire.begin 二次失败");
      return false;
    }
  }
  // 时间权威 = RTC 芯片；仅当芯片无效（无 ACK / 停振 OS=1）或落后于固件编译
  // 时刻（停振残留旧值）时，才用编译时间兜底——新旧取新者
  RtcTime t;
  bool readOk = rtcRead(t);
  RtcTime ct = compileTime();
  time_t ctTs = rtcToUnix(ct);
  if (readOk) {
    time_t rtcTs = rtcToUnix(t);
    Serial.printf("[rtc] 原始读数 20%02d-%02d-%02d %02d:%02d:%02d（固件编译 20%02d-%02d-%02d）\n",
                  t.y, t.mo, t.d, t.h, t.mi, t.s, ct.y, ct.mo, ct.d);
    if (rtcTs >= ctTs) {  // 芯片新于编译时刻 = 在走时 → 采纳为权威
      setSystemTime(rtcTs);
      return true;
    }
    Serial.println("[rtc] 芯片时间落后于固件编译时刻（停振残留旧值）→ 编译时间兜底");
  }
  // 兜底：编译时刻起步；有芯片（ACK）则写回，让芯片从可信起点重新走时
  Wire.beginTransmission(RTC_ADDR);
  bool ack = Wire.endTransmission() == 0;
  if (ack) {
    rtcWrite(ct);  // 写入即清 OS 标志
    rtcPresent_ = true;
  }
  setSystemTime(ctTs);
  Serial.printf("[rtc] 编译时间兜底 20%02d-%02d-%02d %02d:%02d:%02d（插线发 SETTIME 校准）\n",
                ct.y, ct.mo, ct.d, ct.h, ct.mi, ct.s);
  return false;  // 时间不准（待校准）
}

}  // namespace pod
