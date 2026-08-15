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
  cleanDevice: (serial: string): Promise<number> => ipcRenderer.invoke('app:clean-device', serial)
}

export type EchoPodApi = typeof api

contextBridge.exposeInMainWorld('api', api)
