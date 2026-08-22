# echo-pod 固件

录音豆（Echo回响）**正式固件**：穿戴式自动录音设备，VAD 人声触发录音 → SD 卡 → 插线挂只读 U 盘交给桌面 App 拉取转写（v0.2.0 起，此前走读卡器）。

> 本工程是独立 git 仓库，作为 submodule 嵌入 [deep-dive](https://github.com/pgYou/deep-dive) 学习项目。
> 完整上下文（决策历程、交互设计、协议、postmortem）在 deep-dive 仓库：
> - [项目 Journey](https://github.com/pgYou/deep-dive/blob/main/projects/recording-pod-hardware/Journey.md) · [交互设计](https://github.com/pgYou/deep-dive/blob/main/projects/recording-pod-hardware/interaction-design.md) · [设备协议](https://github.com/pgYou/deep-dive/blob/main/projects/recording-pod-hardware/device-protocol.md)
> - **版本迭代记录：[CHANGELOG.md](CHANGELOG.md)**（当前 v0.2.2）

## 硬件

微雪 **ESP32-S3-ePaper-1.54 V2**（ESP32-S3-PICO-1-N8R8，1.54" 黑白墨水屏 200×200）

- **音频**：ES8311 codec + 模拟麦克风（I2S 标准模式）
- **存储**：SD_MMC（IDF esp_vfs_fat 挂载，20MHz 1-bit）
- **USB（v0.2.0）**：TinyUSB 复合设备——CDC 串口 + MSC 只读 U 盘（插电脑切段收尾→挂盘暂停录音，拔线退盘复录；插哑充电头不枚举、照常录音）
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
│   ├── pod_usb.{h,cpp}         # USB 复合设备（CDC+MSC 只读 U 盘，插拔事件）
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
pio run -e echo-pod -t upload --upload-port /dev/cu.usbmodem101   # 正式版（插电脑→U盘+串口）
pio run -e echo-pod-debug -t upload --upload-port /dev/cu.usbmodem101   # 调试版（插线只供电+串口，录音不中断）
pio device monitor -p /dev/cu.usbmodem101
# 串口命令（两个 env 通用；协议见 device-protocol.md §6）：
HELLO               # 设备应答 fw/hw/serial（App 认设备 + 触发自动校时）
TIME?               # 回当前 Unix 秒（漂移诊断）
python3 -c "import time; print(f'SETTIME:{int(time.time())}')"   # 手动校时（App 会自动做）
RMBEGIN             # 清理事务开（退盘）——App 清理已同步录音用，手动玩也行
RM:echo-pod/2026-08-20/21-30-34.wav   # 删一个录音（仅 echo-pod/ 下 .wav）
RMEND               # 清理事务收（清空日期目录 + 复挂 U 盘）
LISTEN:1            # 正式版诊断用：挂起自动同步，插线保持监听（[vad] 心跳 5s 可见）
LISTEN:0            # 恢复插线自动同步策略
```

> **v0.2.0 切 TinyUSB 栈后烧录首验注意**：CDC 从硬件外设换成软件栈，esptool/monitor 需重验一次（TinyUSB CDC 支持 DTR/RTS 复位进下载模式）；万一进不去 bootloader，**按住 BOOT 键插线**走 ROM 下载模式。编译时「ARDUINO_USB_MODE redefined」警告属预期（=0 生效）。
>
> **烧录后 I2C 总线卡死**（串口见 `SDA=0 SCL=0` / `[自检·时间] ⚠ 无芯片` / 器件探测全失败）：esptool 复位不会给外部芯片断电，总线事务半空时会被从机咬死。**长按 PWR 真断电再开机即恢复，无需重烧**（RTC 电池直供，时间不丢）。软复位无效。

## 当前状态（2026-08-20）

- ✅ 设备→App 全链路闭环：VAD 录音 → SD → 读卡器 → App 识别（协议 v1.1）
- ✅ 交互矩阵 / 七状态屏 / 绿灯 / 低电保护 / 真关机 全量实机验证
- ✅ v0.1.4 佩戴实测验收：时间链路（文件名落当日目录+时间正确）、VAD 密度阈值（摩擦/口袋噪声收敛，用户确认「改善很多」）
- ⏳ v0.1.5 待烧录验证：电量重标定（0%=3.60V+棘轮，看放电单调下滑）、⚡ 插拔沿即刻出现/消失、阈值 0.92 说话仍正常触发、分钟沿走字
- ⏳ v0.2.2 待烧录验证（**这次必须烧**——校时回写修复）：插线自动校时后串口见「校时完成（系统 + 芯片写回 ✓）」、**屏幕一分钟内与电脑对齐**；再真关机重开机屏幕仍对（芯片真写 + 电池存活）。顺带带上 0.2.1 尾巴：TZ 提前（日志头两条不再 UTC）、RMEND 延迟 4s 复挂（Finder 随新挂载刷新）、CDC 缓冲 1024B
- ✅ v0.2.1 清理事务实测验收（2026-08-20）：CDC 代删 + 一问一答，卡上目录干净；Finder 窗口滞留为显示缓存（重开窗口即好）
- ⏳ v0.2.0 其余待验：② 拔线自动退盘复录 ③ 插哑充电头不进 SYNC 照常录音 ⑥ ERROR 态长按 BOOT 5s 格式化（废卡试）
- ⏳ 佩戴实测收尾：8h 续航；绒毛套 A/B（可选）
