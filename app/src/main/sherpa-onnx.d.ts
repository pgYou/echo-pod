// sherpa-onnx-node 未随包发布 .d.ts，此处声明本项目用到的最小 API 面
// 完整 JSDoc 定义见 node_modules/sherpa-onnx-node/types.js

declare module 'sherpa-onnx-node' {
  export interface WaveObject {
    samples: Float32Array
    sampleRate: number
  }

  export interface OfflineSenseVoiceModelConfig {
    model: string
    language?: string
    useInverseTextNormalization?: number
  }

  export interface OfflineModelConfig {
    senseVoice?: OfflineSenseVoiceModelConfig
    tokens: string
    numThreads?: number
    debug?: boolean | number
    provider?: string
  }

  export interface OfflineRecognizerConfig {
    modelConfig: OfflineModelConfig
  }

  export interface OfflineStream {
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
  }

  export interface OfflineRecognizerResult {
    text: string
  }

  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig)
    createStream(): OfflineStream
    decode(stream: OfflineStream): void
    getResult(stream: OfflineStream): OfflineRecognizerResult
  }

  /** enableExternalBuffer=false 时内部拷贝样本；Electron(Node 24+) 必须传 false */
  export function readWave(filename: string, enableExternalBuffer?: boolean): WaveObject

  export interface OfflineSpeakerSegment {
    start: number
    end: number
    speaker: number
  }

  export interface OfflineSpeakerDiarizationConfig {
    segmentation: { pyannote: { model: string }; numThreads?: number }
    embedding: { model: string; numThreads?: number }
    clustering: { numClusters?: number; threshold?: number }
    minDurationOn?: number
    minDurationOff?: number
  }

  export class OfflineSpeakerDiarization {
    constructor(config: OfflineSpeakerDiarizationConfig)
    process(samples: Float32Array): OfflineSpeakerSegment[]
  }
}
