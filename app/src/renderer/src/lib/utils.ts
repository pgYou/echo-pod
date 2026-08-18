import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function formatDuration(sec?: number): string {
  if (sec == null) return '--:--'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return `${d.toLocaleDateString('zh-CN')} ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("zh-CN")
}

/**
 * 有效文稿判定：去掉说话人标签（[名字]/[说话人 N]，标签是元数据不算内容）后，
 * 标点空白不算，实质字符（汉字/字母/数字）需 ≥2 个。
 * 噪音/空白录音的空转写常是零散标点（"· 。"）或单个字母（"I."）——只判"有无"挡不住，需数个数。
 */
export function hasMeaningfulText(text?: string | null): boolean {
  if (!text) return false
  const chars = text.replace(/\[[^\]]*\]/g, ' ').match(/[\p{L}\p{N}]/gu)
  return chars != null && chars.length >= 2
}
