// 应用设置（settings.json 持久化于 userData）
// 目前仅一项：录音数据保存路径（默认 userData/recordings）
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export interface AppSettings {
  /** 录音音频库根目录（空/未设置 = 默认 userData/recordings） */
  dataDir: string
}

const DEFAULT_DIR = (): string => path.join(app.getPath('userData'), 'recordings')

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

let settings: AppSettings = { dataDir: '' }

export function loadSettings(): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as Partial<AppSettings>
    settings = { dataDir: parsed.dataDir ?? '' }
  } catch {
    settings = { dataDir: '' }
  }
}

function saveSettings(): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
}

/** 数据目录：未设置时用默认 */
export function getDataDir(): string {
  return settings.dataDir || DEFAULT_DIR()
}

/**
 * 切换数据目录，并把已有数据迁移过去（拷贝后删除旧目录）。
 * 返回生效后的路径。
 */
export function setDataDir(dir: string): string {
  const oldDir = getDataDir()
  if (path.resolve(dir) === path.resolve(oldDir)) return oldDir

  fs.mkdirSync(dir, { recursive: true })
  if (fs.existsSync(oldDir)) {
    try {
      fs.cpSync(oldDir, dir, { recursive: true })
      fs.rmSync(oldDir, { recursive: true, force: true })
    } catch (err) {
      // 迁移失败：旧数据保留在原目录（新目录已有部分拷贝），抛给上层提示
      throw new Error(`数据迁移失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  settings.dataDir = dir
  saveSettings()
  return getDataDir()
}
