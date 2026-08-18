import { contextBridge, ipcRenderer } from 'electron'
import type { AppState } from '../shared/types'

const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke('app:get-state'),
  syncDevice: (serial: string): Promise<number> => ipcRenderer.invoke('app:sync-device', serial),
  onState: (callback: (state: AppState) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: AppState): void => callback(state)
    ipcRenderer.on('app-state', listener)
    return () => ipcRenderer.removeListener('app-state', listener)
  },
  // 设置
  getSettings: (): Promise<{ dataDir: string }> => ipcRenderer.invoke('app:get-settings'),
  pickDataDir: (): Promise<string | null> => ipcRenderer.invoke('app:pick-data-dir'),
  setDataDir: (dir: string): Promise<string> => ipcRenderer.invoke('app:set-data-dir', dir),
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
