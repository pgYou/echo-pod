// M5 spike：说话人分离（diarization）独立验证
// 用法：npm run test:diarization [wav路径]
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dir = path.join(root, 'models', 'diarization')
const wav = process.argv[2] ?? path.join(dir, '0-four-speakers-zh.wav')

const sd = new sherpa.OfflineSpeakerDiarization({
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

console.time('diarize')
const wave = sherpa.readWave(wav, false)
const segments = sd.process(wave.samples)
console.timeEnd('diarize')

console.log('---')
console.log(`输入: ${path.basename(wav)} (${(wave.samples.length / wave.sampleRate).toFixed(1)}s)`)
console.log(`分段数: ${segments.length}`)
for (const s of segments) {
  console.log(`  [${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] 说话人 ${s.speaker}`)
}
