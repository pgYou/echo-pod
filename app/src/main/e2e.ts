// 端到端自动跑批：真实扫描 → 同步 → 转写全链路（走正式代码路径）
// 用法：ECHO_POD_E2E=1 npm start（或 npx electron . --e2e）
// 依赖：已插入的模拟/真实录音豆设备（.echo-pod 标志文件 + echo-pod/ 录音目录）
import { app } from 'electron'
import { snapshot } from './state'
import { syncDevice } from './sync'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const log = (...args: unknown[]): void => console.log('[e2e]', ...args)

export const isE2E: boolean = process.argv.includes('--e2e') || !!process.env['ECHO_POD_E2E']

const TIMEOUT_MS = 60 * 60 * 1000

export async function runE2E(): Promise<void> {
  try {
    await sleep(3000) // 等待首轮扫描（2s 轮询）
    let state = snapshot()
    const connected = state.devices.filter((d) => d.connected)
    log(`设备扫描：${state.devices.length} 台已知，${connected.length} 台在线`)
    const target = connected.find((d) => d.pendingCount > 0)

    if (!target) {
      const anyDevice = connected[0] ?? state.devices[0]
      log(`无待同步文件（设备 ${anyDevice?.serial ?? '无'}），流程结束`)
      app.exit(1)
      return
    }

    log(`识别设备 ${target.serial}（${target.name}），待同步 ${target.pendingCount} 个`)
    const t0 = Date.now()
    const synced = await syncDevice(target.serial)
    log(`同步完成：${synced} 个文件，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

    // 等待转写队列排空
    for (;;) {
      await sleep(3000)
      state = snapshot()
      const recs = state.recordings[target.serial] ?? []
      const counts = { done: 0, failed: 0, working: 0 }
      for (const r of recs) {
        if (r.transcribe.status === 'done') counts.done++
        else if (r.transcribe.status === 'failed') counts.failed++
        else counts.working++
      }
      log(`转写进度：done=${counts.done} failed=${counts.failed} 进行中=${counts.working}`)
      if (recs.length > 0 && counts.working === 0) {
        const minutes = ((Date.now() - t0) / 60000).toFixed(1)
        log('=== 全链路完成 ===')
        log(`录音入库 ${recs.length} 条，总耗时 ${minutes} 分钟`)
        const sample = recs.find((r) => r.transcribe.text)
        if (sample) {
          log(`文稿示例（${sample.fileName}）：`)
          log((sample.transcribe.text ?? '').split('\n').slice(0, 4).join('\n'))
        }
        app.exit(0)
        return
      }
      if (Date.now() - t0 > TIMEOUT_MS) {
        log('超时退出')
        app.exit(2)
        return
      }
    }
  } catch (err) {
    log('失败：', err)
    app.exit(3)
  }
}
