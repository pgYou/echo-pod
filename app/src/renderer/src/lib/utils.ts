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

// 有效文稿判定下沉 shared（主进程 AI 总结同样要用），此处转出口保持 @/lib/utils 引用不变
export { hasMeaningfulText } from '../../../shared/text'
