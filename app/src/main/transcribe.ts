// 转写管线：队列 + 状态机固定，底层引擎可切换（SenseVoice 真转写 / 占位实现）
import path from 'node:path'
import fs from 'node:fs'
import type { RecordingMeta } from '../shared/types'
import { addVoiceprint, emitState, getRecordings, getVoiceprints, recordingsRoot, touchVoiceprint, voiceprintsRoot } from './state'
import { scanVolumes } from './devices'
import { asrAvailable, transcribeWithSpeakersAsync, writeDemoWav } from './asr'

const queue: RecordingMeta[] = []
let running = false
let stopRequested = false

export function enqueueTranscribe(recordings: RecordingMeta[]): void {
  stopRequested = false
  queue.push(...recordings)
  void runQueue()
}

/** 停止转写：当前这条跑完后停，剩余保持 pending（可恢复） */
export function stopTranscribe(): void {
  stopRequested = true
  queue.length = 0
}

/** 恢复转写：把该设备所有 pending 的录音重新入队 */
export function resumeTranscribe(serial: string): number {
  const recs = getRecordings(serial).filter((r) => r.transcribe.status === 'pending')
  if (recs.length > 0) enqueueTranscribe(recs)
  return recs.length
}

async function runQueue(): Promise<void> {
  if (running) return
  running = true
  while (queue.length > 0) {
    if (stopRequested) break
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
    // worker 线程转写，主进程不阻塞（UI 保持可交互）；
    // 同时做声纹匹配：已注册的声音更新出现记录，新声音自动注册并落一段 demo 音频
    const registry = getVoiceprints(rec.serial).map((v) => ({ id: v.id, embedding: v.embedding }))
    const result = await transcribeWithSpeakersAsync(file, registry)
    // 聚类 → 声纹名（已注册用现名，新注册用默认名）
    const nameByCluster = new Map<number, string>()
    for (const sp of result.speakers) {
      if (sp.voiceprintId) {
        touchVoiceprint(rec.serial, sp.voiceprintId, sp.matchedEmbedding ?? undefined)
        const name = getVoiceprints(rec.serial).find((v) => v.id === sp.voiceprintId)?.name
        if (name) nameByCluster.set(sp.cluster, name)
      } else if (sp.newVoiceprint) {
        const vp = addVoiceprint(rec.serial, sp.newVoiceprint.embedding)
        nameByCluster.set(sp.cluster, vp.name)
        try {
          const dir = path.join(voiceprintsRoot(), rec.serial)
          fs.mkdirSync(dir, { recursive: true })
          writeDemoWav(path.join(dir, vp.demoFile), sp.newVoiceprint.demoSamples, sp.newVoiceprint.sampleRate)
        } catch (err) {
          console.warn('[transcribe] 声纹 demo 写入失败：', err)
        }
      }
    }
    rec.voiceprintDone = true
    // 占位标签回填为声纹名（无匹配的聚类回落"说话人 N"）
    let text = result.text
    for (const [cluster, name] of nameByCluster) {
      text = text.split('[[spk' + cluster + ']]').join('[' + name + ']')
    }
    text = text.replace(/\[\[spk(\d+)\]\]/g, (_m, c) => '[说话人 ' + (Number(c) + 1) + ']')
    return text
  }
  // 模型未下载：占位实现（保持管线可演示）
  await new Promise((r) => setTimeout(r, 1200))
  const mins = rec.durationSec ? `${Math.round(rec.durationSec / 60)} 分钟` : '未知时长'
  return `【转写占位】${rec.fileName}（${mins}）——models/sense-voice-int8 不存在，接入真实模型后此处为 SenseVoice 转写文本。`
}

/** 增量补注册：只重跑"已转写但未做过声纹注册"的录音（voiceprintDone 标记） */
export function requeueForVoiceprint(serial: string): number {
  const recs = getRecordings(serial).filter((r) => r.transcribe.status === 'done' && !r.voiceprintDone)
  for (const r of recs) {
    r.transcribe = { status: 'pending' }
  }
  if (recs.length > 0) {
    emitState()
    enqueueTranscribe(recs)
  }
  return recs.length
}
