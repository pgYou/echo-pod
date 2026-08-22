// 设备检测：轮询 /Volumes 挂载/卸载，读 .echo-pod 标志文件认亲
// 契约见 software-spec.md「设备 ↔ App 契约」
//
// 磁盘资源声明：
// - 不使用任何文件监听（watcher/FSEvents 会持有卷引用，阻止用户推出磁盘——实测踩坑）
// - 改为 2s 轮询 readdir，所有磁盘访问均为瞬态（读后即关），随时可弹出
// - 非 echo 卷仅读根目录标志文件一次（缺失即跳过，不遍历目录）
import fs from 'node:fs'
import path from 'node:path'
import type { DeviceInfo } from '../shared/types'
import { emitState, findRecording, setDisconnected, upsertDevice } from './state'
import { cdcTimeSync } from './cdc'

const VOLUMES_DIR = '/Volumes'
const MARKER_FILE = '.echo-pod'
const RECORDINGS_DIR = 'echo-pod'
const POLL_INTERVAL_MS = 2000

interface Marker {
  device?: string
  serial?: string
  fw?: string
  hw?: string
}

export interface DeviceFile {
  relPath: string
  absPath: string
  size: number
}

export function scanDeviceFiles(volumePath: string): DeviceFile[] {
  const root = path.join(volumePath, RECORDINGS_DIR)
  const files: DeviceFile[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue // macOS 垃圾文件
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.wav')) {
        try {
          const stat = fs.statSync(abs)
          // 协议完整性约定：0 字节/<1KB = 未完成录音（断电/拔盘残留），跳过
          if (stat.size < 1024) continue
          files.push({ relPath: path.relative(volumePath, abs), absPath: abs, size: stat.size })
        } catch {
          // 文件消失（正在拔盘），跳过
        }
      }
    }
  }
  walk(root)
  return files
}

function readMarker(volumePath: string): Marker | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(volumePath, MARKER_FILE), 'utf-8')) as Marker
  } catch {
    return null
  }
}

/** 上一轮扫描结果（serial → 状态摘要），用于变更检测：没变化就不广播不落盘 */
let lastSeen = new Map<string, string>()
/** 断连去抖：CDC 清理事务（RMBEGIN→RMEND）会退盘 1~3s + 固件延迟复挂 4s，
 *  卷短暂消失合计可达 ~6s。连续 3 轮（≥6s）不见才判断连，避免清理时 UI 闪「已断开」 */
const missStreak = new Map<string, number>()

/**
 * 扫描所有挂载卷。返回是否有状态变化。
 */
export function scanVolumes(): boolean {
  const current = new Map<string, string>()
  const updates: DeviceInfo[] = []

  let volumes: fs.Dirent[]
  try {
    volumes = fs.readdirSync(VOLUMES_DIR, { withFileTypes: true })
  } catch {
    return false
  }
  for (const vol of volumes) {
    if (!vol.isDirectory()) continue
    const volumePath = path.join(VOLUMES_DIR, vol.name)
    const marker = readMarker(volumePath)
    if (!marker?.serial) continue // 不是录音豆（无标志文件），不遍历目录

    const files = scanDeviceFiles(volumePath)
    const pendingCount = files.filter((f) => !findRecording(marker.serial!, f.relPath, f.size)).length
    updates.push({
      serial: marker.serial,
      name: marker.device || 'Echo Pod',
      fw: marker.fw,
      hw: marker.hw,
      connected: true,
      volumePath,
      pendingCount
    })
    current.set(marker.serial, JSON.stringify([marker.device, marker.fw, marker.hw, pendingCount]))
  }

  let changed = false
  for (const info of updates) {
    if (lastSeen.get(info.serial) !== current.get(info.serial)) {
      upsertDevice(info)
      changed = true
      // 插入沿（含 App 启动时已在线）：CDC 自动校时一次（U 盘通道之外的
      // 串口通道，hello 握手 + SETTIME，见 cdc.ts；失败静默）
      if (!lastSeen.has(info.serial)) void cdcTimeSync()
    }
  }
  // 断连去抖（见 missStreak 注释）：streak 里的先计满，本轮新消失的入 streak
  for (const serial of missStreak.keys()) {
    if (current.has(serial)) {
      missStreak.delete(serial) // 回来了（清理事务复挂）
      continue
    }
    const n = (missStreak.get(serial) ?? 0) + 1
    if (n >= 3) {
      setDisconnected(serial)
      missStreak.delete(serial)
      changed = true
    } else {
      missStreak.set(serial, n)
    }
  }
  for (const serial of lastSeen.keys()) {
    if (!current.has(serial)) missStreak.set(serial, 1)
  }
  lastSeen = current
  if (changed) emitState()
  return changed
}

export function startDeviceWatch(): void {
  // 立即扫一次，此后低频轮询（无任何 watcher，不阻碍磁盘推出）
  scanVolumes()
  setInterval(() => {
    scanVolumes()
  }, POLL_INTERVAL_MS)
}
