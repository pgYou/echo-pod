# Echo Pod Desktop（echo-pod-app）

录音豆配套桌面 App。设备插入自动识别 → 一键同步录音 → 自动转写 → 按设备隔离浏览录音与文本。

技术栈：Electron + electron-vite + React + TypeScript + Tailwind v4 + shadcn/radix。仅面向 macOS（Apple Silicon）。

## 开发

```bash
npm install        # electron 二进制慢可加：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev        # 开发模式（HMR）
npm run typecheck  # 类型检查
npm run build      # 产出 out/（打包分发 = M6）
```

独立验证工具：`npm run test:asr` / `node tools/test-diarization.mjs` / `node tools/test-pipeline.mjs`（后者为分轨+转写端到端，`ELECTRON_RUN_AS_NODE=1 npx electron tools/test-pipeline.mjs` 可在 Electron 运行时验证）。`ECHO_POD_E2E=1 npm start` 走同步+转写全链路自动跑批（无 UI，全量入队）。

## 用 U 盘模拟录音豆

完整协议见 [device-protocol.md](../../../device-protocol.md)（标志文件/目录/WAV 规范的唯一权威源）。拿一个 FAT32 U 盘按以下结构放置后插入，App 会自动识别为设备：

```
U盘根目录/
├── .echo-pod                     # 标志文件（JSON）
└── echo-pod/
    └── 2026-08-15/
        └── 10-23-41.wav          # 任意 wav 文件改名即可
```

`.echo-pod` 内容：

```json
{ "device": "echo-pod", "serial": "ES3-TEST01", "fw": "2.0.0", "hw": "waveshare-epaper-1.54-v2" }
```

换一个 `serial` 即模拟第二台设备（按设备 ID 隔离）。重新插入会自动扫描出待同步文件，设备卡下方出现"开始同步"按钮，同步完成自动进入转写。

## 功能状态（对照 desktop-app-plan.md 里程碑）

| 里程碑 | 状态 |
|--------|------|
| M1 脚手架 + 主窗口 + 设备/录音 UI | ✅ |
| M2 设备检测 + 同步 | ✅ | 2s 轮询 `/Volumes`（无 watcher，不阻碍磁盘推出）+ `.echo-pod` 认亲 + 竞态防护：.part 临时文件 + rename |
| CDC 自动校时 | ✅ v0.2.0 | 设备插入沿扫 VID 0x303a 串口 → `HELLO` 握手（device-protocol §6）→ 无条件下发 `SETTIME`（serialport，失败静默） |
| M0/M4 ASR | ✅ **SenseVoice Small int8 真转写已接入**（sherpa-onnx-node，`say` 合成语音实测正确，2.8s 音频解码 61ms） |
| M3 归档 + 检索 | ✅ 文件名 + 转写全文搜索（JSON store；SQLite/FTS5 如需再升级） |
| M5 声纹分轨 | ✅ pyannote 分割 + 3dspeaker eres2net embedding + 聚类；官方 4 说话人测试音频分轨正确，输出 "[说话人 N] 文本" 格式 |
| M6 打包分发 | ✅ electron-builder dmg（arm64，含全部模型 ~337MB，未签名） |

**模型**（`models/`，已 gitignore，打包时进 Resources）：

| 模型 | 用途 | 大小 |
|------|------|------|
| sense-voice-int8/ | ASR（zh/en/ja/ko/yue 自动） | 239MB |
| diarization/sherpa-onnx-pyannote-segmentation-3-0 | 说话人分割 | 7MB |
| diarization/3dspeaker_speech_eres2net_base | 说话人 embedding | 40MB |

**降级链**：ASR 模型缺失 → 占位转写；分轨模型缺失 → 整段转写不分说话人。

## 转写交互模型（v2，2026-08-18）

同步不再自动转写。全链路：**同步完成 → 弹确认框（按天分组勾选，默认全选）→ 勾选的进入统一转写队列 → 设备卡常备行显示进度**。要点：

- **统一队列**：同步确认、设备卡"批量转写"、单条"重新转写"都汇入同一队列（去重入队；排队期间被删除的自动跳过）；队列快照 `TranscribeJob` 随 state 推送
- **不维护待转写积压**：未勾选的不再提示；后续想转走"批量转写"（按天分组，含上次失败）
- **worker 死亡自愈**：转写 worker 异常退出时 reject 全部在途请求并重启（连续 2 次死亡回落主进程同步转写）——修复此前"队列卡死、手动转写无反应"的 bug
- **设备卡转写常备行**：转写中显示 `x/y · 文件名` + 进度条 + 停止；无任务显示"当前无转写任务"

## 录音库视图

- **按条**：按天分组的录音列表（折叠/移除当天），点击行开右侧详情栏（28→34rem 宽）
- **按天**：一天一行，点击开侧边栏整读当日对话文稿。块头右侧：微型播放器（进度条/时间仅播放中显示）+ 重新转写 + 删除（两步确认）
- **有效文稿判定**：去说话人标签后实质字符（汉字/字母/数字）≥2 才算——空白/噪音录音的转写常是零散标点（`· 。`）或单个字母（`I.`）

## 已知事项

- macOS 首次打开未签名 dmg 需右键 → 打开（或 `xattr -cr` 清 quarantine）
- 聚类阈值定标 0.9（4 说话人基准音频）；真实会议场景可能需按人数微调，后续可暴露为设置项
- Electron Node 24 禁用 NAPI external buffer——`readWave` 必须传第二参 `false`（已封装在 asr.ts）

首次运行自动播种"演示设备"（离线状态、含一条已转写样例），无硬件即可看 UI 数据流。

## 结构

```
src/
├── main/               主进程
│   ├── index.ts        窗口生命周期
│   ├── devices.ts      设备检测（2s 轮询 /Volumes + .echo-pod 契约，无 watcher）
│   ├── sync.ts         同步（拷贝 + .part 原子写入 + WAV 时长解析；完成后推送转写确认事件）
│   ├── transcribe.ts   转写队列（统一入口、去重/跳过已删、TranscribeJob 进度快照）
│   ├── asr.ts          转写引擎（sherpa-onnx worker 线程，死亡自愈；回落主进程同步转写）
│   ├── state.ts        状态 + 持久化（全量快照经 IPC 推送渲染层）
│   ├── ipc.ts / settings.ts / media.ts / wav.ts / e2e.ts
│   └── demo.ts         演示设备播种
├── preload/            contextBridge IPC 桥
├── renderer/           React UI（设备卡：状态/转写常备行/批量转写/同步区；录音列表按条/按天双视图；
│   │                   侧边栏：单条详情 RecordingDetail / 当日文稿 DayDetail）
│   └── components/TranscribeSelectDialog（同步确认与批量转写共用的按天分组勾选弹框）
└── shared/types.ts     主进程 ↔ 渲染层共享类型
```
