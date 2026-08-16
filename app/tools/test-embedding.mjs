// 声纹 embedding 诊断：验证 extractor 输出有效性 + 同人/不同人余弦分布
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const wav = process.argv[2] ?? path.join(root, 'test-assets', 'asr-test.wav')

const ex = new sherpa.SpeakerEmbeddingExtractor({
  model: path.join(root, 'models/diarization/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'),
  numThreads: 2
})
console.log('embedding dim:', ex.dim)

function embed(samples) {
  const stream = ex.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  let n = 0
  let emb = null
  while (ex.isReady(stream)) {
    emb = ex.compute(stream, false)
    n++
  }
  console.log('  compute 调用次数:', n, 'isReady 剩余:', ex.isReady(stream))
  if (!emb) emb = ex.compute(stream, false)
  return emb
}

function norm(v) {
  let s = 0
  for (const x of v) s += x * x
  return Math.sqrt(s)
}
function cosine(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot / (norm(a) * norm(b) + 1e-12)
}

const wave = sherpa.readWave(wav, false)
console.log('wav:', path.basename(wav), `${(wave.samples.length / wave.sampleRate).toFixed(1)}s`)

// 同一段音频提两次（应完全一致）
const mid = Math.floor(wave.samples.length / 2)
const seg = wave.samples.subarray(0, mid) // 前半段（同一人）
const e1 = embed(seg)
const e2 = embed(seg)
console.log('前半段: norm =', norm(e1).toFixed(4), '前5维 =', Array.from(e1.slice(0, 5)).map((x) => x.toFixed(4)).join(', '))
console.log('同人同人(同段重复): cosine =', cosine(e1, e2).toFixed(4))

// 前半 vs 后半（同一句话的两个人？asr-test 是单人 → 应高）
const e3 = embed(wave.samples.subarray(mid))
console.log('前半 vs 后半(同人): cosine =', cosine(e1, e3).toFixed(4))

// ---- 用 4 说话人测试文件定标：同人跨段 vs 异人 ----
const wav4 = path.join(root, 'models/diarization/0-four-speakers-zh.wav')
if (require('node:fs').existsSync(wav4)) {
  const w4 = sherpa.readWave(wav4, false)
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: path.join(root, 'models/diarization/sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx') }, numThreads: 2 },
    embedding: { model: path.join(root, 'models/diarization/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'), numThreads: 2 },
    clustering: { threshold: 0.9 }
  })
  const segs = sd.process(w4.samples)
  const bySpk = new Map()
  for (const s of segs) {
    if (!bySpk.has(s.speaker)) bySpk.set(s.speaker, [])
    bySpk.get(s.speaker).push(s)
  }
  console.log('\n4说话人文件：聚类数', bySpk.size)
  const embs = new Map()
  for (const [spk, list] of bySpk) {
    // 每个说话人取两个不同的段
    const a = list[0]
    const b = list[Math.min(1, list.length - 1)] === a ? list[list.length - 1] : list[1]
    const ea = embed(w4.samples.subarray(Math.round(a.start * w4.sampleRate), Math.round(a.end * w4.sampleRate)))
    const eb = embed(w4.samples.subarray(Math.round(b.start * w4.sampleRate), Math.round(b.end * w4.sampleRate)))
    embs.set(spk, [ea, eb])
    console.log(`说话人${spk + 1} 跨段同人: cosine = ${cosine(ea, eb).toFixed(4)} (段长 ${(a.end - a.start).toFixed(1)}s / ${(b.end - b.start).toFixed(1)}s)`)
  }
  const ids = [...embs.keys()]
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      console.log(`说话人${ids[i] + 1} vs ${ids[j] + 1} 异人: cosine = ${cosine(embs.get(ids[i])[0], embs.get(ids[j])[0]).toFixed(4)}`)
    }
  }
}
