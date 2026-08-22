// CDC 串口通道（v0.2.0）：自动校时 + 设备文件清理
// 协议权威源：device-protocol.md「CDC 串口命令」节
//
// 认亲策略：VID 预筛（Espressif 0x303a，减少开错口）+ HELLO 应答为权威
//（应答含 serial，与 .echo-pod 标志文件同源）。失败静默（串口被 monitor 占用
// 等），绝不阻塞设备检测/同步主流程——唯一例外：清理是用户显式动作，
// 通道不可用要抛错让 UI 可见。
import { SerialPort } from 'serialport'

let running = false

// 设备 CDC 的 VID：微雪板走 seeed_xiao_esp32s3 板型定义，variant 写死
// USB_VID=0x2886（Seeed）；换 Espressif 默认板型则是 0x303a。都认，
// 另兜底 manufacturer 含 Espressif（HELLO 握手才是认亲权威）
const POD_VIDS = new Set(['2886', '303a'])

function normalizeVid(v?: string): string | null {
  return v ? v.replace(/^0x/i, '').toLowerCase() : null // macOS 带不带 0x 前缀都收
}

async function findPodPort(): Promise<string | null> {
  const ports = await SerialPort.list()
  for (const p of ports) {
    const vid = normalizeVid(p.vendorId)
    if ((vid && POD_VIDS.has(vid)) || (p.manufacturer ?? '').toLowerCase().includes('espressif')) {
      return p.path
    }
  }
  console.warn(
    '[cdc] 未找到设备串口，当前串口:',
    ports.map((p) => `${p.path}(vid=${p.vendorId ?? '?'},mfr=${p.manufacturer ?? '?'})`).join(' ') || '无'
  )
  return null
}

/** 设备插入沿自动校时：HELLO 握手 → 无条件下发 SETTIME（每次插线拉齐 PCF85063，漂移不累积） */
export async function cdcTimeSync(): Promise<void> {
  if (running) return
  running = true
  try {
    const portPath = await findPodPort()
    if (!portPath) return
    // 打开串口 → 发 "HELLO\n" → 等 "[pod] HELLO" 应答 → 发 SETTIME → 关口
    await new Promise<void>((resolve) => {
      const port = new SerialPort({ path: portPath, baudRate: 115200, autoOpen: false })
      let settled = false
      let buf = ''
      const finish = (): void => {
        if (settled) return
        settled = true
        try {
          port.close()
        } catch {
          /* 已关 */
        }
        resolve()
      }
      const timer = setTimeout(finish, 1500) // 握手超时（非录音豆的口）
      port.on('data', (d: Buffer) => {
        buf += d.toString('utf8')
        if (!buf.includes('[pod] HELLO')) return
        clearTimeout(timer)
        port.write(`SETTIME:${Math.floor(Date.now() / 1000)}\n`, () => finish())
      })
      port.on('error', () => {
        clearTimeout(timer)
        finish()
      })
      port.open((err) => {
        if (err) return finish()
        port.write('HELLO\n') // open 回调内写，避开未打开写入
      })
    })
  } catch {
    // 串口子系统异常（权限/驱动）不影响主流程——设备照走 MSC 文件通道
  } finally {
    running = false
  }
}

export interface CleanResult {
  ok: string[]
  fail: string[]
}

/**
 * 清理设备上已同步的录音（只读 U 盘 → 固件代删，device-protocol §6）：
 * RMBEGIN（退盘，固件独占）→ RM:<relPath>×N → RMEND（复挂，host 见干净 FAT）。
 * 空 .wav 以外的失败不重试；串口不可用抛错（用户显式动作要可见）。
 */
export async function cleanDeviceViaCdc(relPaths: string[]): Promise<CleanResult> {
  const portPath = await findPodPort()
  if (!portPath) throw new Error('未找到设备串口（确认 USB 连接为电脑且未被占用）')

  return new Promise<CleanResult>((resolve, reject) => {
    const port = new SerialPort({ path: portPath, baudRate: 115200, autoOpen: false })
    const ok: string[] = []
    const fail: string[] = []
    let buf = ''
    let stage: 'hello' | 'begin' | 'rm' | 'end' = 'hello'
    let sawBegin = false // 全程没等到 RMBEGIN 应答 = 固件过旧（首版 0.2.0 无清理命令）或串口被占
    let timer: NodeJS.Timeout

    // 严格一问一答：收到上一条应答才发下一条。绝不并发突发——设备侧 CDC
    // 接收缓冲仅 256B（约 5 条命令），一口气写 N 条会丢字节/熔行（0.2.1
    // 首验实测：路径里拼进下一条命令的残片）
    let nextIdx = 0
    const sendNext = (): void => {
      if (nextIdx >= relPaths.length) {
        stage = 'end'
        armTimer(3000) // 等 RM END 应答
        port.write('RMEND\n')
        return
      }
      armTimer(2000) // 单条超时（FAT 删除毫秒级，往返 <100ms）
      port.write(`RM:${relPaths[nextIdx]}\n`)
    }

    const finish = (): void => {
      clearTimeout(timer)
      // 中途超时也要尽力收尾：RMEND 让固件复挂 U 盘（写完再关口）
      const closeAndSettle = (): void => {
        try {
          port.close()
        } catch {
          /* 已关 */
        }
        if (!sawBegin) {
          reject(new Error('设备未应答清理命令（固件过旧或串口被占用），请重烧最新固件后重试'))
        } else {
          resolve({ ok, fail })
        }
      }
      if (stage === 'begin' || stage === 'rm') {
        try {
          port.write('RMEND\n', () => setTimeout(closeAndSettle, 200))
          return
        } catch {
          /* 关口失败走兜底 */
        }
      }
      closeAndSettle()
    }
    const armTimer = (ms: number): void => {
      clearTimeout(timer)
      timer = setTimeout(finish, ms)
    }

    const onLine = (line: string): void => {
      if (line.startsWith('[pod] HELLO')) {
        stage = 'begin'
        armTimer(2000)
        port.write('RMBEGIN\n')
        return
      }
      if (line.startsWith('[pod] RM BEGIN')) {
        sawBegin = true
        stage = 'rm'
        sendNext() // 发第 1 条，此后按应答节奏逐条推进
        return
      }
      const m = line.match(/^\[pod\] RM (OK|ERR) (.+)$/)
      if (m) {
        ;(m[1] === 'OK' ? ok : fail).push(m[2])
        nextIdx++
        sendNext()
        return
      }
      if (line.startsWith('[pod] RM END')) {
        stage = 'end'
        armTimer(100) // 稍等串口排空
        setTimeout(finish, 100)
      }
    }

    port.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) onLine(line)
      }
    })
    port.on('error', () => finish())
    armTimer(4000) // HELLO 超时
    port.open((err) => {
      if (err) return finish()
      port.write('HELLO\n')
    })
  })
}
