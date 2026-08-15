// 转写引擎：SenseVoice ASR + 说话人分离（diarization）
//
// 重活跑在 worker 线程（asr-worker）：sherpa 的 decode/diarization 是同步 C++ 调用，
// 直接在主进程跑会阻塞事件循环 → UI 冻结。worker 通过运行时生成的 .cjs 脚本启动
// （绕开构建器对 worker 的打包限制），native 模块经 createRequire 从 node_modules 解析。
// worker 启动/初始化失败时自动回落主进程同步转写（功能保底，代价是转写期间 UI 阻塞）。
//
// 模型（models/ 下，缺任一则降级）：
//   sense-voice-int8/   — ASR（必须，缺失则转写走占位实现）
//   diarization/        — 分轨（可选，缺失则整段转写不分说话人）
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sherpa = require('sherpa-onnx-node') as typeof import('sherpa-onnx-node')

function modelsRoot(): string {
  // dev：项目 models/；打包后：Resources/models/（electron-builder extraResources）
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const app = require('electron').app as Electron.App
  return app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(app.getAppPath(), 'models')
}

function exists(p: string): boolean {
  return fs.existsSync(p)
}

export function asrAvailable(): boolean {
  return exists(path.join(modelsRoot(), 'sense-voice-int8', 'model.int8.onnx'))
}

function diarizationAvailable(): boolean {
  return (
    exists(path.join(modelsRoot(), 'diarization', 'sherpa-onnx-pyannote-segmentation-3-0', 'model.int8.onnx')) &&
    exists(path.join(modelsRoot(), 'diarization', '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'))
  )
}

// ---------------------------------------------------------------- worker 线程

// prettier-ignore
const WORKER_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads')
const path = require('node:path')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const nodeRequire = createRequire(path.join(workerData.nodeModulesDir, '_'))
const sherpa = nodeRequire('sherpa-onnx-node')

const MODELS = workerData.modelsRoot
let recognizer = null
let diarizer = null

function getRecognizer() {
  if (recognizer) return recognizer
  recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      senseVoice: {
        model: path.join(MODELS, 'sense-voice-int8', 'model.int8.onnx'),
        language: '',
        useInverseTextNormalization: 1
      },
      tokens: path.join(MODELS, 'sense-voice-int8', 'tokens.txt'),
      numThreads: 4,
      debug: 0
    }
  })
  return recognizer
}

function getDiarizer() {
  if (diarizer) return diarizer
  const dir = path.join(MODELS, 'diarization')
  diarizer = new sherpa.OfflineSpeakerDiarization({
    segmentation: {
      pyannote: { model: path.join(dir, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.int8.onnx') },
      numThreads: 2
    },
    embedding: {
      model: path.join(dir, '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'),
      numThreads: 2
    },
    clustering: { threshold: 0.9 },
    minDurationOn: 0.3,
    minDurationOff: 0.5
  })
  return diarizer
}

function decode(samples) {
  const r = getRecognizer()
  const stream = r.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  r.decode(stream)
  return r.getResult(stream).text
}

function transcribe(file) {
  const wave = sherpa.readWave(file, false)
  const haveDiar = fs.existsSync(path.join(MODELS, 'diarization', 'sherpa-onnx-pyannote-segmentation-3-0', 'model.int8.onnx')) &&
    fs.existsSync(path.join(MODELS, 'diarization', '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'))
  if (!haveDiar) return decode(wave.samples).trim()
  const segments = getDiarizer().process(wave.samples)
  const lines = []
  for (const seg of segments) {
    const start = Math.round(seg.start * wave.sampleRate)
    const end = Math.round(seg.end * wave.sampleRate)
    const text = decode(wave.samples.subarray(start, end)).trim()
    if (text) lines.push('[说话人 ' + (seg.speaker + 1) + '] ' + text)
  }
  return lines.length > 0 ? lines.join('\\n') : decode(wave.samples).trim()
}

parentPort.on('message', (m) => {
  if (m.type !== 'transcribe') return
  try {
    parentPort.postMessage({ id: m.id, ok: true, text: transcribe(m.file) })
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e) })
  }
})
parentPort.postMessage({ type: 'ready' })
`

let worker: Worker | null = null
let workerFailed = false
let readyPromise: Promise<boolean> | null = null
let seq = 0
const pending = new Map<number, { resolve: (text: string) => void; reject: (err: Error) => void }>()

function startWorker(): Promise<boolean> {
  if (readyPromise) return readyPromise
  readyPromise = new Promise((resolve) => {
    if (workerFailed) return resolve(false)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const app = require('electron').app as Electron.App
      const nodeModulesDir = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
        : path.join(app.getAppPath(), 'node_modules')
      const scriptPath = path.join(app.getPath('userData'), 'asr-worker.cjs')
      fs.writeFileSync(scriptPath, WORKER_SCRIPT)

      const w = new Worker(scriptPath, { workerData: { modelsRoot: modelsRoot(), nodeModulesDir } })
      const timeout = setTimeout(() => {
        console.warn('[asr] worker 初始化超时，回落主进程同步转写')
        void w.terminate()
        workerFailed = true
        resolve(false)
      }, 60_000)

      w.on('message', (m: { type?: string; id?: number; ok?: boolean; text?: string; error?: string }) => {
        if (m.type === 'ready') {
          clearTimeout(timeout)
          worker = w
          resolve(true)
        } else if (m.id != null && pending.has(m.id)) {
          const p = pending.get(m.id)!
          pending.delete(m.id)
          if (m.ok) p.resolve(m.text ?? '')
          else p.reject(new Error(m.error ?? 'transcribe failed'))
        }
      })
      w.on('error', (err: unknown) => {
        console.warn('[asr] worker 异常，回落主进程同步转写：', err instanceof Error ? err.message : err)
        clearTimeout(timeout)
        workerFailed = true
        resolve(false)
      })
    } catch (err) {
      console.warn('[asr] worker 启动失败，回落主进程同步转写：', err instanceof Error ? err.message : err)
      workerFailed = true
      resolve(false)
    }
  })
  return readyPromise
}

/** 异步转写（worker 线程，不阻塞主进程/UI） */
export async function transcribeWithSpeakersAsync(filePath: string): Promise<string> {
  const ok = await startWorker()
  if (ok && worker) {
    return new Promise<string>((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      worker!.postMessage({ type: 'transcribe', id, file: filePath })
    })
  }
  return transcribeWithSpeakersSync(filePath)
}

// ---------------------------------------------------------------- 同步实现（worker 失败时的回落路径）

let syncRecognizer: import('sherpa-onnx-node').OfflineRecognizer | null = null
let syncDiarizer: import('sherpa-onnx-node').OfflineSpeakerDiarization | null = null

function getSyncRecognizer(): import('sherpa-onnx-node').OfflineRecognizer {
  if (syncRecognizer) return syncRecognizer
  syncRecognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      senseVoice: {
        model: path.join(modelsRoot(), 'sense-voice-int8', 'model.int8.onnx'),
        language: '',
        useInverseTextNormalization: 1
      },
      tokens: path.join(modelsRoot(), 'sense-voice-int8', 'tokens.txt'),
      numThreads: 4,
      debug: 0
    }
  })
  return syncRecognizer
}

function getSyncDiarizer(): import('sherpa-onnx-node').OfflineSpeakerDiarization {
  if (syncDiarizer) return syncDiarizer
  const dir = path.join(modelsRoot(), 'diarization')
  syncDiarizer = new sherpa.OfflineSpeakerDiarization({
    segmentation: {
      pyannote: { model: path.join(dir, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.int8.onnx') },
      numThreads: 2
    },
    embedding: {
      model: path.join(dir, '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'),
      numThreads: 2
    },
    clustering: { threshold: 0.9 },
    minDurationOn: 0.3,
    minDurationOff: 0.5
  })
  return syncDiarizer
}

function decodeSync(samples: Float32Array): string {
  const r = getSyncRecognizer()
  const stream = r.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  r.decode(stream)
  return r.getResult(stream).text
}

function transcribeWithSpeakersSync(filePath: string): string {
  // 第二参 false：Electron 内置 Node 24+ 禁用 NAPI external buffer
  const wave = sherpa.readWave(filePath, false)
  if (!diarizationAvailable()) return decodeSync(wave.samples).trim()

  const segments = getSyncDiarizer().process(wave.samples)
  const lines: string[] = []
  for (const seg of segments) {
    const start = Math.round(seg.start * wave.sampleRate)
    const end = Math.round(seg.end * wave.sampleRate)
    const text = decodeSync(wave.samples.subarray(start, end)).trim()
    if (text) lines.push(`[说话人 ${seg.speaker + 1}] ${text}`)
  }
  return lines.length > 0 ? lines.join('\n') : decodeSync(wave.samples).trim()
}
