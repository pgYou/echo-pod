# Echo Pod Desktop（echo-pod-app）

录音豆配套桌面 App。设备插入自动识别 → 一键同步录音 → 自动转写 → 按设备隔离浏览录音与文本。

技术栈：Electron + electron-vite + React + TypeScript + Tailwind v4 + shadcn/radix。仅面向 macOS（Apple Silicon）。

## 开发

```bash
npm install        # electron 二进制慢可加：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev        # 开发模式（HMR）
npm run typecheck  # 类型检查
npm run build      # 产出 out/（打包分发 = M6，待 electron-builder）
```

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
| M2 设备检测 + 同步 | ✅（chokidar 监听 /Volumes + .echo-pod 认亲 + 竞态防护：.part 临时文件 + rename） |
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

**独立验证工具**：`npm run test:asr` / `npm run test:diarization` / `npm run test:pipeline`（后者为分轨+转写端到端，`ELECTRON_RUN_AS_NODE=1 npx electron tools/test-pipeline.mjs` 可在 Electron 运行时验证）。

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
│   ├── devices.ts      设备检测（/Volumes + .echo-pod 契约）
│   ├── sync.ts         同步（拷贝 + .part 原子写入 + WAV 时长解析）
│   ├── transcribe.ts   转写管线（当前占位，M0/M4 换 sherpa-onnx-node）
│   ├── state.ts        状态 + 持久化（全量快照经 IPC 推送渲染层）
│   └── demo.ts         演示设备播种
├── preload/            contextBridge IPC 桥
├── renderer/           React UI（单列布局：设备信息卡内下拉切换设备 + 同步区 + 录音列表/文稿/搜索）
└── shared/types.ts     主进程 ↔ 渲染层共享类型
```
