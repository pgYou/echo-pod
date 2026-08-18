import { useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { formatDuration } from '@/lib/utils'

export interface TranscribeItem {
  id: string
  fileName: string
  day: string
  durationSec?: number
  size: number
  /** 上次转写失败（批量转写场景标出，可重试） */
  failed?: boolean
}

export interface SyncBatchPreview {
  serial: string
  items: TranscribeItem[]
  estimatedSec: number
}

interface Props {
  open: boolean
  onClose: () => void
  title: string
  description: string
  items: TranscribeItem[]
  /** 确认：传选中的 id 列表（空 = 跳过）。调用方负责关框与 IPC */
  onConfirm: (ids: string[]) => void
}

/** 预计转写耗时（实测定标：1s 音频 ≈ 0.15s 全管线） */
export function formatEstimate(sec: number): string {
  const m = Math.max(1, Math.round(sec / 60))
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟` : `${m} 分钟`
}

/**
 * 转写选择弹框：按天分组勾选（单选 / 按天全选），默认全选。
 * 两个场景共用：同步完成后的"立即转写确认"、设备卡"批量转写"。
 */
export default function TranscribeSelectDialog({
  open,
  onClose,
  title,
  description,
  items,
  onConfirm
}: Props): React.JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // 打开/换一批时重置为全选
  useEffect(() => {
    if (open) setSelected(new Set(items.map((it) => it.id)))
  }, [open, items])

  // 按天分组（天倒序，与录音列表一致）
  const dayGroups = useMemo(() => {
    const groups = new Map<string, TranscribeItem[]>()
    for (const it of items) {
      const bucket = groups.get(it.day) ?? []
      bucket.push(it)
      groups.set(it.day, bucket)
    }
    return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [items])

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleDay = (recs: TranscribeItem[]): void => {
    const ids = recs.map((r) => r.id)
    const allSelected = ids.every((id) => selected.has(id))
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (allSelected) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  const selectedEstimate = items.reduce(
    (sum, it) => sum + (selected.has(it.id) ? (it.durationSec ?? 60) * 0.15 : 0),
    0
  )

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[80vh] min-h-[26rem] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {dayGroups.map(([day, recs]) => {
            const selCount = recs.filter((r) => selected.has(r.id)).length
            return (
              <div key={day}>
                {/* 天头：全选/半选/全不选 */}
                <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50">
                  <Checkbox
                    checked={selCount === 0 ? false : selCount === recs.length ? true : 'indeterminate'}
                    onCheckedChange={() => toggleDay(recs)}
                  />
                  {day} · {recs.length} 条
                </label>
                <div className="mt-0.5 space-y-0.5">
                  {recs.map((it) => (
                    <label
                      key={it.id}
                      className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-accent/50"
                    >
                      <Checkbox checked={selected.has(it.id)} onCheckedChange={() => toggle(it.id)} />
                      <span className="min-w-0 flex-1 truncate">{it.fileName}</span>
                      {it.failed && (
                        <Badge variant="destructive" className="shrink-0">
                          上次失败
                        </Badge>
                      )}
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatDuration(it.durationSec)}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            已选 {selected.size}/{items.length} 条 · 预计 {formatEstimate(selectedEstimate)}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button disabled={selected.size === 0} onClick={() => onConfirm([...selected])}>
              转写选中（{selected.size}）
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
