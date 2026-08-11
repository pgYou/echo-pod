# echo-pod

录音豆硬件项目的**阶段2 正式工程**。继承阶段1 验证项目 [`recording-pod-hello`](../recording-pod-hello/) 已跑通的核心录音链路（WavRecorder + VadTrigger + RingBuffer + TimeSync），在阶段2 加入人机交互（LED / 按键 / 电池 / 充电）与可穿戴形态。

> 本工程是独立 git 仓库，作为 submodule 嵌入 [deep-dive](https://github.com/pgYou/deep-dive) 学习项目。
> 完整上下文（决策历程、硬件选型、焊接指南等）在 deep-dive 仓库中：
> - [项目 Journey](https://github.com/pgYou/deep-dive/blob/main/projects/recording-pod-hardware/Journey.md)
> - [阶段2 执行计划](https://github.com/pgYou/deep-dive/blob/main/projects/recording-pod-hardware/stage2-execution-plan.md)
> - [阶段2 固件设计](https://github.com/pgYou/deep-dive/blob/main/projects/recording-pod-hardware/stage2-firmware-design.md)
> - [焊接指南](https://github.com/pgYou/deep-dive/blob/main/projects/recording-pod-hardware/wiring-guide.md)

## 硬件

- **主控**：Seeed XIAO ESP32-S3 Sense（+ 摄像头扩展板，用板载 PDM 麦克风 + microSD）
- **Flash/PSRAM**：8MB QIO Flash + OPI PSRAM
- **USB**：CDC 虚拟串口（无原生 USB-串口芯片）

## 目录结构

```
echo-pod/
├── platformio.ini              # PlatformIO 配置（arduino-esp32 3.3.11 + ghfast 镜像）
├── src/
│   ├── main.cpp                # 当前：阶段1 基线（VAD 自动录音）
│   ├── config.h                # 硬件 + VAD 参数配置（改参数只动这里）
│   └── step2/                  # 阶段2 单步验证固件（每个 env 只编译 1 个）
│       └── test_led.cpp        # B1：白光 + 红光 LED（LEDC PWM）
├── lib/                        # 核心模块（阶段1 沉淀，阶段2 复用）
│   ├── WavRecorder/            # WAV 录音器（I2S → 环形缓冲 → SD）
│   ├── VadTrigger/             # VAD 触发器（ESP-SR VADNet 神经网络）
│   ├── RingBuffer/             # 环形缓冲（预录不丢首音）
│   ├── TimeSync/               # 串口校时（编译时间兜底）
│   └── speexdsp/               # vendoredSpeexDSP（降噪预处理）
├── tools/
│   └── sync_time.py            # 电脑端校时脚本
└── README.md
```

## 引脚映射

| 功能 | 焊盘 | GPIO | 说明 |
|------|------|------|------|
| 白光 LED（录音指示） | D3 | GPIO4 | 220Ω → GND，LEDC PWM |
| 红光 LED（状态/充电/低电） | D1 | GPIO2 | 220Ω → GND，LEDC PWM |
| 多功能按键 | D0 | GPIO1 | INPUT_PULLUP，Deep Sleep ext0 唤醒源 |
| 电池电压 ADC | D4 | GPIO5 | 100K/100K 分压中点（ADC1_CH4） |
| PDM 麦 CLK/DATA | — | GPIO42/41 | 扩展板 MSA261（探针实证） |
| SD 卡 CS | — | GPIO21 | 探针实证（与板载 USER_LED 复用） |

## 烧录

```bash
# 主固件（阶段1 基线，阶段2 C 大步重写为 PodController 组装）
pio run -e echo-pod -t upload
pio device monitor

# 阶段2 单步验证（如 B1 LED 验证）
pio run -e echo-pod-step2-led -t upload && pio device monitor
```

> XIAO ESP32-S3 用 USB-C 数据线连接。首次需 `gh auth` 或确保 `ghfast.top` 镜像可达（下载 arduino-esp32 3.3.11）。

## 当前状态（2026-08-12）

- ✅ 阶段1 核心录音链路验证通过（VAD 自动录音 + SD 卡 WAV + 串口校时）
- ✅ 阶段2 A 前置验证完成（磁吸线引脚探测）
- ⏳ 阶段2 B 焊接中（B1 白光/红光 LED 待焊）
- ⏳ 阶段2 C 固件（PodController 模块待实现）

## 技术栈

- **PlatformIO**：pioarduino/platform-espressif32（GitHub via ghfast 镜像）
- **框架**：arduino-esp32 **3.3.11**（ESP-IDF 5.x，LEDC 3.x API）
- **VAD**：ESP-SR VADNet（神经网络人声检测，MODE_2 严格模式）
- **降噪**：vendored SpeexDSP（preprocess NS + smallft FFT）
