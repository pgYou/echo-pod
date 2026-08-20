# echo-pod 固件

录音豆（Echo回响）**正式固件**：穿戴式自动录音设备，VAD 人声触发录音 → SD 卡 → 拔卡/读卡器交给桌面 App 转写。

> 本工程是独立 git 仓库，作为 submodule 嵌入 [deep-dive](https://github.com/pgYou/deep-dive) 学习项目。
> 完整上下文（决策历程、交互设计、协议、postmortem）在 deep-dive 仓库：
> - [项目 Journey](https://github.com/pgYou/deep-dive/blob/main/projects/recording-pod-hardware/Journey.md) · [交互设计](https://github.com/pgYou/deep-dive/blob/main/projects/recording-pod-hardware/interaction-design.md) · [设备协议](https://github.com/pgYou/deep-dive/blob/main/projects/recording-pod-hardware/device-protocol.md)
> - **版本迭代记录：[CHANGELOG.md](CHANGELOG.md)**（当前 v0.1.4）

## 硬件

微雪 **ESP32-S3-ePaper-1.54 V2**（ESP32-S3-PICO-1-N8R8，1.54" 黑白墨水屏 200×200）

- **音频**：ES8311 codec + 模拟麦克风（I2S 标准模式）
- **存储**：SD_MMC（IDF esp_vfs_fat 挂载，20MHz 1-bit）
- **时钟**：PCF85063 RTC（I2C 0x51，电池直供关机存活）——全固件唯一时间权威
- **电源**：PWR 键软闩锁（GPIO17 接管/真断电），USB 在线充电（ETA6098）

## 目录结构

```
firmware/
├── platformio.ini              # 双 env 同一份 src：echo-pod（正式）+ echo-pod-debug（插线不进同步，调试用）
├── CHANGELOG.md                # 版本迭代记录（本文件平级）
├── src/
│   ├── main.cpp                # PodController：状态机 + 交互矩阵分派
│   ├── config.h                # 版本号 + 引脚 + 阈值 + VAD 参数（改参数只动这里）
│   ├── pod_board.{h,cpp}       # 闩锁/绿灯/电池/按键/RTC（时间权威+自检）
│   ├── pod_display.{h,cpp}     # 七状态墨水屏页面
│   └── pod_log.{h,cpp}         # 串口+SD 双写日志（echo-pod/.logs/，保留 7 天）
├── lib/
│   ├── WavRecorder/            # 录音器：VAD 触发 → 预滚环形缓冲 → WAV 落卡（切段/暂停）
│   ├── VadTrigger/             # ESP-SR VADNet 神经网络人声检测
│   ├── RingBuffer/             # 预录环形缓冲（不丢首音）
│   ├── TimeSync/               # 串口 SETTIME 命令解析（时间设置走 pod::rtcSet）
│   ├── EchoPaper/              # 墨水屏驱动（官方 BSP verbatim + 1bpp Painter + 字库）
│   ├── ES8311/                 # codec 驱动
│   └── speexdsp/               # vendored SpeexDSP（降噪预处理）
├── tools/
│   ├── gen_fonts.swift         # CoreText 字库生成（中文 20×20 / ASCII 8×16）
│   └── sync_time.py            # 电脑端校时脚本
└── reference/                  # 官方仓库 clone（gitignore，考证用）
```

## 关键引脚（唯一权威 `src/config.h`，考证见 interaction-design.md §1）

| 功能 | GPIO | 说明 |
|------|------|------|
| 绿灯 | 3 | 低电平亮（红灯为充电指示，不可控） |
| BOOT 键 | 0 | 短按切段/刷新，长按 3s 静音 |
| PWR 键 | 18 | 长按 3s 真关机 |
| 电源闩锁 | 17 | 高=固件接管供电（开机第一件事） |
| 电池 ADC | 4 | ÷2 分压 → 查表百分比 |
| I2C（RTC/codec） | 47/48 | PCF85063 @0x51，ES8311 @0x18 |
| SD_MMC | CLK 39 / CMD 41 / D0 40 | 1-bit 20MHz |

## 烧录

```bash
pio run -e echo-pod -t upload --upload-port /dev/cu.usbmodem101   # 正式版（插线→同步态）
pio run -e echo-pod-debug -t upload --upload-port /dev/cu.usbmodem101   # 调试版（插线只供电+串口，录音不中断）
pio device monitor -p /dev/cu.usbmodem101
# 校时（monitor 中粘贴输出，两个 env 通用）：
python3 -c "import time; print(f'SETTIME:{int(time.time())}')"
# 正式版诊断用（debug env 不需要）：插线默认进同步态暂停录音，观测 VAD 需保持监听：
LISTEN:1    # 挂起自动同步，插线保持监听（[vad] 心跳 5s 可见）
LISTEN:0    # 恢复插线自动同步策略
```

> **烧录后 I2C 总线卡死**（串口见 `SDA=0 SCL=0` / `[自检·时间] ⚠ 无芯片` / 器件探测全失败）：esptool 复位不会给外部芯片断电，总线事务半空时会被从机咬死。**长按 PWR 真断电再开机即恢复，无需重烧**（RTC 电池直供，时间不丢）。软复位无效。

## 当前状态（2026-08-20）

- ✅ 设备→App 全链路闭环：VAD 录音 → SD → 读卡器 → App 识别（协议 v1.1）
- ✅ 交互矩阵 / 七状态屏 / 绿灯 / 低电保护 / 真关机 全量实机验证
- ⏳ v0.1.4 待完整验证（时间链路：自检✓ → SETTIME → 文件落当日文件夹；VAD 抗误触：咳嗽/敲桌不触发、说话 ~1s 触发）
- ⏳ 佩戴实测收尾：VAD 抗误触复测（窗口 32 帧方案，清单见 CHANGELOG v0.1.4）、8h 续航
- 📋 v0.2.0：USB-MSC 块代理同步（TinyUSB 切栈）+ CDC 自动校时 + 固件内 SD 格式化
