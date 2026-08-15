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
    }
  }
  for (const serial of lastSeen.keys()) {
    if (!current.has(serial)) {
      setDisconnected(serial)
      changed = true
    }
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
