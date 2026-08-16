// 同步：把设备上的新 WAV 拷贝进本地库（按设备 serial 隔离）
import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import type { RecordingMeta } from '../shared/types'
import { scanDeviceFiles } from './devices'
import {
  addRecording,
  emitState,
  findRecording,
  getDevice,
  getSync,
  recordingsRoot,
  setSync,
  takeArchivedTranscript
} from './state'
import { parseWavDuration } from './wav'
import { enqueueTranscribe } from './transcribe'

export async function syncDevice(serial: string): Promise<number> {
  if (getSync()) throw new Error('已有同步任务进行中')
  const device = getDevice(serial)
  if (!device?.connected || !device.volumePath) throw new Error('设备未连接')

  const files = scanDeviceFiles(device.volumePath)
  const pendingFiles = files.filter((f) => !findRecording(serial, f.relPath, f.size))
  if (pendingFiles.length === 0) return 0

  setSync({ serial, total: pendingFiles.length, done: 0 })
  emitState()

  const synced: RecordingMeta[] = []
  try {
    for (const file of pendingFiles) {
      setSync({ serial, total: pendingFiles.length, done: synced.length, currentFile: file.relPath })
      emitState()

      const destDir = path.join(recordingsRoot(), serial, path.dirname(file.relPath))
      fs.mkdirSync(destDir, { recursive: true })
      const dest = path.join(destDir, path.basename(file.relPath))
      // 先写临时文件再改名：拔盘/断电时不留半成品被当成完整录音
      const tmp = `${dest}.part`
      fs.copyFileSync(file.absPath, tmp)
      fs.renameSync(tmp, dest)

      const rec: RecordingMeta = {
        id: `${serial}-${Buffer.from(file.relPath).toString('base64url')}-${file.size}`,
        serial,
        relPath: file.relPath,
        fileName: path.basename(file.relPath),
        durationSec: parseWavDuration(dest),
        size: file.size,
        syncedAt: new Date().toISOString(),
        // 同 id 文件曾转写完成 → 直接恢复结果，不重跑
        transcribe: takeArchivedTranscript(
          `${serial}-${Buffer.from(file.relPath).toString('base64url')}-${file.size}`
        ) ?? { status: 'pending' }
      }
      addRecording(rec)
      if (rec.transcribe.status === 'pending') synced.push(rec)
      emitState()
    }
  } finally {
    // 无论正常完成还是中途拔盘报错，同步状态必须清掉，否则永久卡在"同步中"
    setSync(null)
    emitState()
  }

  // 同步完成 → 自动转写。量大时（预估超 10 分钟）先推送预览，由用户勾选后转写
  const EST_SEC_PER_AUDIO_SEC = 0.15 // 实测定标：57s 音频全管线约 8s（≈0.14）+ 每文件开销
  const estimatedSec = synced.reduce((sum, r) => sum + (r.durationSec ?? 60) * EST_SEC_PER_AUDIO_SEC, 0)
  if (estimatedSec > 600) {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('sync-batch-preview', {
        serial,
        estimatedSec: Math.round(estimatedSec),
        items: synced.map((r) => ({
          id: r.id,
          fileName: r.fileName,
          day: r.relPath.split('/')[1] ?? '',
          durationSec: r.durationSec,
          size: r.size
        }))
      })
    }
    // 未勾选/未确认的部分保持 pending，可从设备卡「继续转写」恢复
  } else {
    enqueueTranscribe(synced)
  }
  return synced.length
}
