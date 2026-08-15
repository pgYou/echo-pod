// 全局状态 + 持久化（JSON store，M3 换 SQLite 时的替换点）
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { AppState, DeviceInfo, RecordingMeta, SyncState } from '../shared/types'
import { getDataDir } from './settings'

interface LibraryFile {
  devices: Record<string, DeviceInfo>
  recordings: Record<string, RecordingMeta[]>
  /** 转写档案：音频文件被清理后保留的转写结果（id = serial+relPath+size），重同步同文件时恢复 */
  archive?: Record<string, RecordingMeta['transcribe']>
}

const ARCHIVE_CAP = 500

const storePath = (): string => path.join(app.getPath('userData'), 'library.json')

const state: LibraryFile = { devices: {}, recordings: {} }
let saveTimer: NodeJS.Timeout | null = null

export function loadLibrary(): void {
  try {
    const raw = fs.readFileSync(storePath(), 'utf-8')
    const parsed = JSON.parse(raw) as LibraryFile
    state.devices = parsed.devices ?? {}
    state.recordings = parsed.recordings ?? {}
    state.archive = parsed.archive ?? {}
    // 启动时所有设备离线
    for (const d of Object.values(state.devices)) {
      d.connected = false
      d.volumePath = undefined
      d.pendingCount = 0
    }
    // 上次退出时若在转写中，重置回待转写
    for (const list of Object.values(state.recordings)) {
      for (const r of list) {
        if (r.transcribe.status === 'transcribing') r.transcribe.status = 'pending'
      }
    }
    pruneMissingFiles()
  } catch {
    // 首次运行，无库文件
  }
}

/**
 * 一致性自愈：元数据对应的音频文件不在磁盘上（异常退出/外部删除）→ 丢弃该条目，
 * 但转写结果存入档案（同文件重同步时恢复，不重跑转写）。被丢弃的文件下次设备插入时重新同步。
 */
function pruneMissingFiles(): void {
  const root = recordingsRoot()
  for (const [serial, list] of Object.entries(state.recordings)) {
    const kept: RecordingMeta[] = []
    let dropped = 0
    for (const r of list) {
      if (fs.existsSync(path.join(root, serial, r.relPath))) {
        kept.push(r)
      } else {
        dropped++
        if (r.transcribe.status === 'done' && r.transcribe.text) {
          archiveTranscript(r.id, r.transcribe)
        }
      }
    }
    if (dropped > 0) {
      console.warn(`[state] 设备 ${serial}：${dropped} 条录音的音频文件缺失，已移除元数据（转写结果存档，重同步后恢复）`)
      if (kept.length > 0) state.recordings[serial] = kept
      else delete state.recordings[serial]
    }
  }
}

function archiveTranscript(id: string, transcribe: RecordingMeta['transcribe']): void {
  state.archive ??= {}
  const keys = Object.keys(state.archive)
  if (keys.length >= ARCHIVE_CAP) {
    // 超限淘汰最旧的条目（插入序）
    delete state.archive[keys[0]]
  }
  state.archive[id] = transcribe
}

/** 取回档案中的转写结果（取出即删除）。同步同文件（同 id）时调用。 */
export function takeArchivedTranscript(id: string): RecordingMeta['transcribe'] | undefined {
  const hit = state.archive?.[id]
  if (hit) {
    delete state.archive![id]
    save()
  }
  return hit
}

/**
 * 移除录音元数据（用户主动删除）。已完成转写存档（同文件再次同步时恢复，不重跑）。
 * 返回被移除的元数据列表（调用方负责删音频文件）。
 */
export function removeRecordings(serial: string, ids: string[]): RecordingMeta[] {
  const list = state.recordings[serial]
  if (!list) return []
  const idSet = new Set(ids)
  const removed = list.filter((r) => idSet.has(r.id))
  if (removed.length === 0) return []
  state.recordings[serial] = list.filter((r) => !idSet.has(r.id))
  for (const r of removed) {
    if (r.transcribe.status === 'done' && r.transcribe.text) {
      archiveTranscript(r.id, r.transcribe)
    }
  }
  emitState()
  return removed
}

function save(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true })
    fs.writeFileSync(storePath(), JSON.stringify(state, null, 2))
  }, 500)
}

export function snapshot(): AppState {
  return {
    devices: Object.values(state.devices)
      .sort((a, b) => a.serial.localeCompare(b.serial)),
    recordings: state.recordings,
    sync: currentSync
  }
}

let currentSync: SyncState | null = null

export function emitState(): void {
  const snap = snapshot()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('app-state', snap)
  }
  save()
}

export function getDevice(serial: string): DeviceInfo | undefined {
  return state.devices[serial]
}

export function upsertDevice(info: DeviceInfo): void {
  const existing = state.devices[info.serial]
  state.devices[info.serial] = existing ? { ...existing, ...info } : info
}

export function setDisconnected(serial: string): void {
  const d = state.devices[serial]
  if (d?.connected) {
    d.connected = false
    d.volumePath = undefined
    d.pendingCount = 0
  }
}

export function getRecordings(serial: string): RecordingMeta[] {
  return state.recordings[serial] ?? []
}

export function addRecording(rec: RecordingMeta): void {
  const list = state.recordings[rec.serial] ?? (state.recordings[rec.serial] = [])
  list.push(rec)
}

export function findRecording(serial: string, relPath: string, size: number): RecordingMeta | undefined {
  return (state.recordings[serial] ?? []).find((r) => r.relPath === relPath && r.size === size)
}

export function setSync(s: SyncState | null): void {
  currentSync = s
}

export function getSync(): SyncState | null {
  return currentSync
}

export function recordingsRoot(): string {
  // 可配置（App 设置里的"数据保存路径"），默认 userData/recordings
  return getDataDir()
}
