// 转写管线：队列 + 状态机固定，底层引擎可切换（SenseVoice 真转写 / 占位实现）
import path from 'node:path'
import type { RecordingMeta } from '../shared/types'
import { emitState, recordingsRoot } from './state'
import { scanVolumes } from './devices'
import { asrAvailable, transcribeWithSpeakersAsync } from './asr'

const queue: RecordingMeta[] = []
let running = false

export function enqueueTranscribe(recordings: RecordingMeta[]): void {
  queue.push(...recordings)
  void runQueue()
}

async function runQueue(): Promise<void> {
  if (running) return
  running = true
  while (queue.length > 0) {
    const rec = queue.shift()!
    rec.transcribe = { status: 'transcribing', startedAt: new Date().toISOString() }
    emitState()
    try {
      const text = await transcribeOne(rec)
      rec.transcribe = {
        status: 'done',
        text,
        startedAt: rec.transcribe.startedAt,
        finishedAt: new Date().toISOString()
      }
    } catch (err) {
      rec.transcribe = {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        startedAt: rec.transcribe.startedAt,
        finishedAt: new Date().toISOString()
      }
    }
    emitState()
  }
  running = false
  // 转写完成后刷新设备待同步数（若设备还插着）
  scanVolumes()
}

async function transcribeOne(rec: RecordingMeta): Promise<string> {
  const file = path.join(recordingsRoot(), rec.serial, rec.relPath)
  if (asrAvailable()) {
    // worker 线程转写，主进程不阻塞（UI 保持可交互）
    return transcribeWithSpeakersAsync(file)
  }
  // 模型未下载：占位实现（保持管线可演示）
  await new Promise((r) => setTimeout(r, 1200))
  const mins = rec.durationSec ? `${Math.round(rec.durationSec / 60)} 分钟` : '未知时长'
  return `【转写占位】${rec.fileName}（${mins}）——models/sense-voice-int8 不存在，接入真实模型后此处为 SenseVoice 转写文本。`
}
