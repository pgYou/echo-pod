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
}

export interface SyncState {
  serial: string
  total: number
  done: number
  currentFile?: string
}

/** 全量状态快照：主进程每次变更推给渲染层 */
export interface AppState {
  devices: DeviceInfo[]
  /** 按 serial 分组的录音元数据 */
  recordings: Record<string, RecordingMeta[]>
  sync: SyncState | null
}
