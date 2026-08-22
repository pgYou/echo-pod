// 设备 ↔ App 共享类型（主进程与渲染进程共用）

export interface DeviceInfo {
  serial: string
  name?: string
  fw?: string
  hw?: string
  connected: boolean
  /** 挂载点绝对路径（如 /Volumes/ECHO-POD），仅已连接时有 */
  volumePath?: string
  /** 待同步文件数（仅已连接时有意义） */
  pendingCount: number
}

export type TranscribeStatus = 'pending' | 'transcribing' | 'done' | 'failed'

export interface TranscribeState {
  status: TranscribeStatus
  text?: string
  error?: string
  startedAt?: string
  finishedAt?: string
}

export interface RecordingMeta {
  id: string
  serial: string
  /** 设备上的相对路径，如 echo-pod/2026-08-14/10-23-41.wav */
  relPath: string
  fileName: string
  /** 录音时长（秒），由 WAV 头解析；解析失败为 undefined */
  durationSec?: number
  size: number
  syncedAt: string
  transcribe: TranscribeState
  /** 转写时已完成声纹注册（增量补注册的依据：true = 不再需要跑） */
  voiceprintDone?: boolean
}

export interface SyncState {
  serial: string
  total: number
  done: number
  currentFile?: string
}

/** 转写队列快照（主进程实时推送；只反映本次入队的任务，"待转写"积压不算在内） */
export interface TranscribeJob {
  serial: string
  total: number
  done: number
  currentFile?: string
}

/** 录音列表视图：按条（逐条列表）| 按天（一天一行，侧边栏整读当日对话） */
export type ViewMode = 'items' | 'days'

/** LLM 接口设置（OpenAI 兼容 chat/completions，用于 AI 日总结） */
export interface LlmSettings {
  /** API 地址（Base URL），如 https://api.openai.com/v1；以 /chat/completions 结尾亦可 */
  baseUrl: string
  model: string
  apiKey: string
}

/** 一天的 AI 总结（主进程调 LLM 生成，随库持久化） */
export interface DaySummary {
  serial: string
  /** 天键，如 2026-08-22（与录音分组同源） */
  day: string
  /** 按时间线的总结文本 */
  summary: string
  /** 参与本次总结的录音 id（重转写/新增文稿后可据此判断过期） */
  recordingIds: string[]
  /** 生成所用模型（溯源） */
  model: string
  createdAt: string
}

/** 进行中的 AI 日总结流（SSE 增量实时推送；null = 无进行中的总结） */
export interface SummaryStream {
  serial: string
  day: string
  /** 已生成的部分文本 */
  text: string
}

/** 声纹（设备内自动注册的声音身份）。同名允许重复 = 多个声纹是同一人（识别拆分） */
export interface Voiceprint {
  id: string
  /** 显示名，默认"声音 N"；可重命名，不唯一（同一名 = 同一人） */
  name: string
  /** 说话人 embedding（与 diarization 的 3dspeaker 模型同源，用于出现过的声音匹配） */
  embedding: number[]
  /** demo 音频文件名（voiceprints/<serial>/ 下） */
  demoFile: string
  firstSeen: string
  lastSeen: string
  /** 累计出现段数 */
  occurrences: number
}

/** 全量状态快照：主进程每次变更推给渲染层 */
export interface AppState {
  devices: DeviceInfo[]
  /** 按 serial 分组的录音元数据 */
  recordings: Record<string, RecordingMeta[]>
  /** 按 serial 分组的声纹（设备隔离） */
  voiceprints: Record<string, Voiceprint[]>
  sync: SyncState | null
  /** 转写队列快照（无任务时为 null） */
  transcribe: TranscribeJob | null
  /** AI 日总结（键 `${serial}/${day}`） */
  summaries: Record<string, DaySummary>
  /** LLM 接口是否已配置齐全（未配置时置灰 AI 总结入口） */
  llmConfigured: boolean
}
