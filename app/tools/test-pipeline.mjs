// 端到端：diarization 切段 → 逐段 SenseVoice 转写（与 src/main/asr.ts 同逻辑）
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const wav = process.argv[2] ?? path.join(root, 'models', 'diarization', '0-four-speakers-zh.wav')

const asr = new sherpa.OfflineRecognizer({
  modelConfig: {
    senseVoice: {
      model: path.join(root, 'models/sense-voice-int8/model.int8.onnx'),
      language: '',
      useInverseTextNormalization: 1
    },
    tokens: path.join(root, 'models/sense-voice-int8/tokens.txt'),
    numThreads: 4,
    debug: 0
  }
})

const sd = new sherpa.OfflineSpeakerDiarization({
  segmentation: {
    pyannote: { model: path.join(root, 'models/diarization/sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx') },
    numThreads: 2
  },
  embedding: { model: path.join(root, 'models/diarization/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'), numThreads: 2 },
  clustering: { threshold: 0.9 },
  minDurationOn: 0.3,
  minDurationOff: 0.5
})

function decode(samples) {
  const stream = asr.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  asr.decode(stream)
  return asr.getResult(stream).text.trim()
}

console.time('pipeline')
const wave = sherpa.readWave(wav, false)
const segments = sd.process(wave.samples)
const lines = []
for (const seg of segments) {
  const start = Math.round(seg.start * wave.sampleRate)
  const end = Math.round(seg.end * wave.sampleRate)
  const text = decode(wave.samples.subarray(start, end))
  if (text) lines.push(`[说话人 ${seg.speaker + 1}] ${text}`)
}
console.timeEnd('pipeline')

console.log('---')
console.log(`输入: ${path.basename(wav)} (${(wave.samples.length / wave.sampleRate).toFixed(1)}s, ${segments.length} 段)`)
console.log(lines.join('\n'))
