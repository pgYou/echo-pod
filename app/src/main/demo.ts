// 首次运行播种演示设备：无硬件也能立即看到 UI 与数据流
import type { DeviceInfo, RecordingMeta } from '../shared/types'
import { getRecordings, upsertDevice, addRecording } from './state'

const DEMO_SERIAL = 'ES3-DEMO01'

function demoRecording(fileName: string, dayOffset: number, hour: number, min: number, sec: number, size: number, text?: string): RecordingMeta {
  const d = new Date()
  d.setDate(d.getDate() - dayOffset)
  d.setHours(hour, min, sec, 0)
  const day = d.toISOString().slice(0, 10)
  return {
    id: `${DEMO_SERIAL}-demo-${fileName}`,
    serial: DEMO_SERIAL,
    relPath: `echo-pod/${day}/${fileName}`,
    fileName,
    durationSec: sec < 60 ? 187 + sec : sec,
    size,
    syncedAt: d.toISOString(),
    transcribe: text
      ? { status: 'done', text, startedAt: d.toISOString(), finishedAt: d.toISOString() }
      : { status: 'pending' }
  }
}

export function seedDemoIfNeeded(): void {
  if (getRecordings(DEMO_SERIAL).length > 0) return
  const device: DeviceInfo = {
    serial: DEMO_SERIAL,
    name: '演示设备',
    fw: '2.0.0',
    hw: 'waveshare-epaper-1.54-v2',
    connected: false,
    pendingCount: 0
  }
  upsertDevice(device)
  addRecording(
    demoRecording('14-32-05.wav', 1, 14, 32, 5, 3_740_000, [
      '[说话人 A] 这次会议我们过一下录音豆二点零的进度。',
      '[说话人 B] 硬件已经下单了，微雪那块墨水屏板子，本周应该能到。',
      '[说话人 A] 桌面端呢？',
      '[说话人 B] Electron 的壳已经搭起来了，同步和转写的架子都通，就差把 sherpa-onnx 接进去。',
      '（以上为演示数据）'
    ].join('\n'))
  )
  addRecording(demoRecording('10-23-41.wav', 0, 10, 23, 41, 2_210_000))
}
