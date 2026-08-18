import { dialog, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { snapshot, removeRecordings, recordingsRoot, findRecording, getDevice, renameVoiceprint, deleteVoiceprint, voiceprintsRoot } from './state'
import { syncDevice } from './sync'
import { enqueueTranscribe, requeueForVoiceprint, stopTranscribe } from './transcribe'
import { getRecordings } from './state'
import { getDataDir, setDataDir } from './settings'
import { scanDeviceFiles, scanVolumes } from './devices'

export function registerIpc(): void {
  ipcMain.handle('app:get-state', () => snapshot())

  ipcMain.handle('app:sync-device', (_event, serial: unknown) => {
    if (typeof serial !== 'string') throw new Error('invalid serial')
    return syncDevice(serial)
  })

  // ---- 设置 ----

  ipcMain.handle('app:get-settings', () => ({ dataDir: getDataDir() }))

  ipcMain.handle('app:pick-data-dir', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择录音数据保存路径'
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('app:set-data-dir', (_event, dir: unknown) => {
    if (typeof dir !== 'string' || dir.length === 0) throw new Error('invalid dir')
    return setDataDir(dir)
  })

  // ---- 数据删除 ----

  ipcMain.handle('app:delete-recordings', (_event, serial: unknown, ids: unknown) => {
    if (typeof serial !== 'string' || !Array.isArray(ids)) throw new Error('invalid args')
    const removed = removeRecordings(serial, ids as string[])
    for (const r of removed) {
      try {
        fs.rmSync(path.join(recordingsRoot(), serial, r.relPath), { force: true })
      } catch (err) {
        console.warn('[ipc] 删除音频文件失败：', r.relPath, err)
      }
    }
    return removed.length
  })

  // 单条（重新）转写
  ipcMain.handle('app:transcribe-one', (_event, serial: unknown, id: unknown) => {
    if (typeof serial !== 'string' || typeof id !== 'string') throw new Error('invalid args')
    const rec = getRecordings(serial).find((r) => r.id === id)
    if (!rec) throw new Error('recording not found')
    rec.transcribe = { status: 'pending' }
    enqueueTranscribe([rec])
    return true
  })

  // 批量转写（大同步量的选择结果）
  ipcMain.handle('app:transcribe-selected', (_event, serial: unknown, ids: unknown) => {
    if (typeof serial !== 'string' || !Array.isArray(ids)) throw new Error('invalid args')
    const idSet = new Set(ids as string[])
    const recs = getRecordings(serial).filter((r) => idSet.has(r.id))
    enqueueTranscribe(recs)
    return recs.length
  })

  // 转写控制
  ipcMain.handle('app:stop-transcribe', () => {
    stopTranscribe()
    return true
  })

  // 从已转写录音补注册声纹（重置为待转写并重新入队）
  ipcMain.handle('app:retranscribe', (_event, serial: unknown) => {
    if (typeof serial !== 'string') throw new Error('invalid serial')
    return requeueForVoiceprint(serial)
  })

  // 声纹删除（元数据 + demo 音频，完全删除）
  ipcMain.handle('app:delete-voiceprint', (_event, serial: unknown, id: unknown) => {
    if (typeof serial !== 'string' || typeof id !== 'string') throw new Error('invalid args')
    const vp = deleteVoiceprint(serial, id)
    if (vp) {
      try {
        fs.rmSync(path.join(voiceprintsRoot(), serial, vp.demoFile), { force: true })
      } catch (err) {
        console.warn('[ipc] 声纹 demo 删除失败：', err)
      }
    }
    return vp != null
  })

  // 声纹重命名（名字不唯一：多个声纹可同名 = 同一人）
  ipcMain.handle('app:rename-voiceprint', (_event, serial: unknown, id: unknown, name: unknown) => {
    if (typeof serial !== 'string' || typeof id !== 'string' || typeof name !== 'string') {
      throw new Error('invalid args')
    }
    renameVoiceprint(serial, id, name)
    return true
  })

  // 清理设备上已同步的录音文件（本地库已有副本的那些；未同步的保留）
  ipcMain.handle('app:clean-device', (_event, serial: unknown) => {
    if (typeof serial !== 'string') throw new Error('invalid serial')
    const device = getDevice(serial)
    if (!device?.connected || !device.volumePath) throw new Error('设备未连接')

    const synced = scanDeviceFiles(device.volumePath).filter((f) => findRecording(serial, f.relPath, f.size))
    for (const f of synced) {
      try {
        fs.rmSync(f.absPath, { force: true })
      } catch (err) {
        console.warn('[ipc] 清理设备文件失败：', f.relPath, err)
      }
    }
    // 顺手清掉空的日期目录
    try {
      const dayRoot = path.join(device.volumePath, 'echo-pod')
      for (const entry of fs.readdirSync(dayRoot)) {
        const dir = path.join(dayRoot, entry)
        if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir)
        }
      }
    } catch {
      // 目录不存在或非空，忽略
    }
    scanVolumes()
    return synced.length
  })
}
