// 应用设置（settings.json 持久化于 userData）
// 两项：录音数据保存路径（默认 userData/recordings）+ LLM 接口（AI 日总结用）
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { LlmSettings } from '../shared/types'

export interface AppSettings {
  /** 录音音频库根目录（空/未设置 = 默认 userData/recordings） */
  dataDir: string
  /** LLM 接口（OpenAI 兼容，AI 日总结用；空 = 未配置） */
  llm: LlmSettings
}

const DEFAULT_DIR = (): string => path.join(app.getPath('userData'), 'recordings')
const DEFAULT_LLM = (): LlmSettings => ({ baseUrl: '', model: '', apiKey: '' })

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

let settings: AppSettings = { dataDir: '', llm: DEFAULT_LLM() }

export function loadSettings(): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as Partial<AppSettings>
    settings = { dataDir: parsed.dataDir ?? '', llm: { ...DEFAULT_LLM(), ...parsed.llm } }
  } catch {
    settings = { dataDir: '', llm: DEFAULT_LLM() }
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

// ---------------------------------------------------------------- LLM 接口

export function getLlmSettings(): LlmSettings {
  return settings.llm
}

/** LLM 是否已配置齐全（快照推给渲染层用于置灰总结按钮；不把 apiKey 散播到侧边栏） */
export function isLlmConfigured(): boolean {
  const l = settings.llm
  return !!(l.baseUrl && l.model && l.apiKey)
}

/** 保存 LLM 接口设置（返回规整后的生效值）。apiKey 明文存 userData/settings.json，本应用为本地单用户，不做加密 */
export function setLlmSettings(llm: LlmSettings): LlmSettings {
  settings.llm = {
    baseUrl: llm.baseUrl.trim(),
    model: llm.model.trim(),
    apiKey: llm.apiKey.trim()
  }
  saveSettings()
  return settings.llm
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
