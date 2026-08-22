import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, DaySummary, LlmSettings, SummaryStream } from '../shared/types'

const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke('app:get-state'),
  syncDevice: (serial: string): Promise<number> => ipcRenderer.invoke('app:sync-device', serial),
  onState: (callback: (state: AppState) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: AppState): void => callback(state)
    ipcRenderer.on('app-state', listener)
    return () => ipcRenderer.removeListener('app-state', listener)
  },
  // 设置
  getSettings: (): Promise<{ dataDir: string; llm: LlmSettings }> => ipcRenderer.invoke('app:get-settings'),
  pickDataDir: (): Promise<string | null> => ipcRenderer.invoke('app:pick-data-dir'),
  setDataDir: (dir: string): Promise<string> => ipcRenderer.invoke('app:set-data-dir', dir),
  setLlmSettings: (llm: LlmSettings): Promise<LlmSettings> =>
    ipcRenderer.invoke('app:set-llm-settings', llm),
  // AI 日总结
  summarizeDay: (serial: string, day: string): Promise<DaySummary> =>
    ipcRenderer.invoke('app:summarize-day', serial, day),
  // 数据删除
  deleteRecordings: (serial: string, ids: string[]): Promise<number> =>
    ipcRenderer.invoke('app:delete-recordings', serial, ids),
  // 清理设备上已同步文件
  cleanDevice: (serial: string): Promise<number> => ipcRenderer.invoke('app:clean-device', serial),
  // 声纹
  renameVoiceprint: (serial: string, id: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke('app:rename-voiceprint', serial, id, name),
  retranscribe: (serial: string): Promise<number> => ipcRenderer.invoke('app:retranscribe', serial),
  deleteVoiceprint: (serial: string, id: string): Promise<boolean> =>
    ipcRenderer.invoke('app:delete-voiceprint', serial, id),
  stopTranscribe: (): Promise<boolean> => ipcRenderer.invoke('app:stop-transcribe'),
  transcribeOne: (serial: string, id: string): Promise<boolean> =>
    ipcRenderer.invoke('app:transcribe-one', serial, id),
  transcribeSelected: (serial: string, ids: string[]): Promise<number> =>
    ipcRenderer.invoke('app:transcribe-selected', serial, ids),
  /** AI 总结流式增量（生成中节流推送；null = 结束/失败）。专用轻量通道，不随全量快照 */
  onSummaryDelta: (callback: (s: SummaryStream | null) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, s: Parameters<typeof callback>[0]): void => callback(s)
    ipcRenderer.on('summary-delta', listener)
    return () => ipcRenderer.removeListener('summary-delta', listener)
  },
  /** 大同步量预览：同步完成后主进程推送，渲染层弹选择框 */
  onSyncBatchPreview: (
    callback: (batch: { serial: string; items: { id: string; fileName: string; day: string; durationSec?: number; size: number }[]; estimatedSec: number }) => void
  ): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, batch: Parameters<typeof callback>[0]): void => callback(batch)
    ipcRenderer.on('sync-batch-preview', listener)
    return () => ipcRenderer.removeListener('sync-batch-preview', listener)
  }
}

export type EchoPodApi = typeof api

contextBridge.exposeInMainWorld('api', api)
