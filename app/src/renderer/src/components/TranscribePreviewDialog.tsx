import { useMemo, useState } from 'react'
import { toast } from 'sonner'
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
import { formatDuration } from '@/lib/utils'

export interface SyncBatchItem {
  id: string
  fileName: string
  day: string
  durationSec?: number
  size: number
}

export interface SyncBatchPreview {
  serial: string
  items: SyncBatchItem[]
  estimatedSec: number
}

interface Props {
  batch: SyncBatchPreview | null
  onClose: () => void
}

function formatEstimate(sec: number): string {
  const m = Math.round(sec / 60)
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟` : `${m} 分钟`
}

/** 大同步量转写预览：勾选要转写的录音（默认全选），未勾选保持待转写可稍后继续 */
export default function TranscribePreviewDialog({ batch, onClose }: Props): React.JSX.Element {
  const [excluded, setExcluded] = useState<Set<string>>(new Set())

  const selected = useMemo(
    () => (batch ? batch.items.filter((it) => !excluded.has(it.id)) : []),
    [batch, excluded]
  )
  const selectedEstimate = useMemo(
    () => selected.reduce((sum, it) => sum + (it.durationSec ?? 60) * 0.15, 0),
    [selected]
  )

  const toggle = (id: string): void => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const confirm = (): void => {
    if (!batch) return
    if (selected.length === 0) {
      toast.info('已跳过转写，可稍后从设备卡"继续转写"恢复')
      onClose()
      return
    }
    void window.api.transcribeSelected(batch.serial, selected.map((it) => it.id)).then(() => {
      toast.success(`开始转写 ${selected.length} 条`)
      onClose()
    })
  }

  return (
    <Dialog open={batch != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[80vh] min-h-[26rem] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>转写确认</DialogTitle>
          <DialogDescription>
            本次同步 {batch?.items.length ?? 0} 条录音，全部转写预计 {formatEstimate(batch?.estimatedSec ?? 0)}。
            取消勾选不需要的，只转写勾选的音频。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          {batch?.items.map((it) => (
            <label
              key={it.id}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-accent/50"
            >
              <Checkbox checked={!excluded.has(it.id)} onCheckedChange={() => toggle(it.id)} />
              <span className="min-w-0 flex-1 truncate">{it.fileName}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {it.day} · {formatDuration(it.durationSec)}
              </span>
            </label>
          ))}
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            已选 {selected.length}/{batch?.items.length ?? 0} 条 · 预计 {formatEstimate(selectedEstimate)}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={confirm}>
              跳过全部
            </Button>
            <Button disabled={selected.length === 0} onClick={confirm}>
              转写选中（{selected.length}）
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
