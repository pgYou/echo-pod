import { useEffect, useState } from 'react'
import { ChevronRight, FileAudio, Trash2 } from 'lucide-react'
import type { RecordingMeta } from '../../../shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn, formatBytes, formatDateTime, formatDuration } from '@/lib/utils'

function TranscribeBadge({ recording }: { recording: RecordingMeta }): React.JSX.Element {
  switch (recording.transcribe.status) {
    case 'done':
      return <Badge className="bg-success/15 text-success hover:bg-success/15">已转写</Badge>
    case 'transcribing':
      return <Badge className="animate-pulse bg-sky-500/15 text-sky-700 hover:bg-sky-500/15">转写中</Badge>
    case 'failed':
      return <Badge variant="destructive">转写失败</Badge>
    default:
      return <Badge variant="secondary">待转写</Badge>
  }
}

interface Props {
  recording: RecordingMeta
  selected: boolean
  onSelect: () => void
  onDelete: () => void
}

/** 紧凑列表行：元信息 + 最多两行转写预览。点击打开右侧详情栏；删除按钮在状态徽章旁，两步确认 */
export default function RecordingRow({ recording, selected, onSelect, onDelete }: Props): React.JSX.Element {
  const rec = recording
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setConfirmDelete(false)
  }, [rec.id])

  return (
    <div
      className={cn(
        'group relative flex items-center gap-3 px-4 py-3 transition-colors',
        selected ? 'bg-accent' : 'hover:bg-accent/50'
      )}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onSelect()
        }}
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-left outline-none"
      >
        <FileAudio className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {/* 标题行：文件名 + 状态徽章 + 删除 + 箭头（垂直居中对齐） */}
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{rec.fileName}</span>
            <span className="flex shrink-0 items-center gap-1">
              <TranscribeBadge recording={rec} />
              <Popover open={confirmDelete} onOpenChange={setConfirmDelete}>
                <PopoverTrigger asChild>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmDelete((v) => !v)
                    }}
                    className={cn(
                      'flex cursor-pointer items-center rounded-md p-1 outline-none transition-all',
                      confirmDelete
                        ? 'text-destructive'
                        : 'text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive'
                    )}
                    aria-label="删除录音"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="end"
                  className="w-auto p-3"
                  onClick={(e) => e.stopPropagation()}
                >
                  <p className="text-xs">删除这条录音？（设备上的原始文件不受影响）</p>
                  <div className="mt-2.5 flex justify-end gap-2">
                    <Button variant="ghost" size="xs" onClick={() => setConfirmDelete(false)}>
                      取消
                    </Button>
                    <Button variant="destructive" size="xs" onClick={onDelete}>
                      确认删除
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
              <ChevronRight className="size-4 text-muted-foreground" />
            </span>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {formatDuration(rec.durationSec)} · {formatBytes(rec.size)} · {formatDateTime(rec.syncedAt)} 同步
          </div>
          {/* 两行转写预览 */}
          {rec.transcribe.status === 'done' && rec.transcribe.text ? (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {rec.transcribe.text}
            </p>
          ) : rec.transcribe.status === 'transcribing' ? (
            <p className="mt-1 animate-pulse text-xs text-muted-foreground">转写中…</p>
          ) : rec.transcribe.status === 'failed' ? (
            <p className="mt-1 line-clamp-2 text-xs text-destructive">{rec.transcribe.error}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
