// M0 spike：SenseVoice 独立转写验证（不依赖 Electron）
// 用法：npm run test:asr [wav路径]
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const modelDir = path.join(root, 'models', 'sense-voice-int8')
const wav = process.argv[2] ?? path.join(root, 'test-assets', 'asr-test.wav')

console.time('init')
const recognizer = new sherpa.OfflineRecognizer({
  modelConfig: {
    senseVoice: {
      model: path.join(modelDir, 'model.int8.onnx'),
      language: '',
      useInverseTextNormalization: 1
    },
    tokens: path.join(modelDir, 'tokens.txt'),
    numThreads: 4,
    debug: 0
  }
})
console.timeEnd('init')

console.time('decode')
// Electron(Node 24+) 禁用 external buffer，必须传 false 让其内部拷贝
const wave = sherpa.readWave(wav, false)
const stream = recognizer.createStream()
stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples })
recognizer.decode(stream)
const result = recognizer.getResult(stream)
console.timeEnd('decode')

console.log('---')
console.log(`输入: ${wav} (${(wave.samples.length / wave.sampleRate).toFixed(1)}s)`)
console.log(`转写: ${result.text.trim()}`)
