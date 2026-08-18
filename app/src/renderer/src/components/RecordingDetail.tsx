import { useRef } from 'react'
import { RefreshCcw, Speech, Trash2, X } from 'lucide-react'
import type { RecordingMeta } from '../../../shared/types'
import AudioPlayer from './AudioPlayer'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn, formatBytes, formatDateTime, formatDuration } from '@/lib/utils'

interface Props {
  /** null = 关闭中；收起动画期间保留上一条内容避免闪空 */
  recording: RecordingMeta | null
  open: boolean
  onClose: () => void
  onDelete: () => void
}

/** 右侧详情栏：顶天立地，独立滚动。宽度 0↔34rem 缓动展开/收起，内容定宽防挤压 */
export default function RecordingDetail({ recording, open, onClose, onDelete }: Props): React.JSX.Element {
  const lastRef = useRef<RecordingMeta | null>(null)
  if (recording) lastRef.current = recording
  const rec = recording ?? lastRef.current
  if (!rec) return <></>

  return (
    <aside
      className={cn(
        'h-full shrink-0 overflow-hidden rounded-l-2xl bg-card transition-[width,border-color] duration-300 ease-in-out',
        open ? 'w-[34rem] border-l' : 'w-0 border-transparent'
      )}
    >
      {/* 内层定宽：宽度动画期间内容不重排 */}
      <div
        className={cn(
          'flex h-full w-[34rem] flex-col transition-opacity duration-200',
          open ? 'opacity-100 delay-100' : 'opacity-0'
        )}
      >
        {/* 头部（不随内容滚动） */}
        <header className="flex items-start justify-between gap-2 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{rec.fileName}</h2>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">{rec.serial}</p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground"
            aria-label="关闭详情"
          >
            <X className="size-4" />
          </button>
        </header>

        {/* 内容区（独立滚动） */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <AudioPlayer
            src={`pod://${rec.serial}/${rec.relPath
              .split('/')
              .map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg)))
              .join('/')}`}
            fallbackDuration={rec.durationSec}
          />

          <div className="space-y-1 text-xs text-muted-foreground">
            <div>日期目录：{rec.relPath.split('/')[1] ?? '--'}</div>
            <div>
              时长 {formatDuration(rec.durationSec)} · 大小 {formatBytes(rec.size)}
            </div>
            <div>{formatDateTime(rec.syncedAt)} 同步</div>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-semibold">转写文稿</h3>
              {rec.transcribe.status === 'done' && (
                <Badge className="bg-success/15 text-success hover:bg-success/15">已转写</Badge>
              )}
              {rec.transcribe.status === 'transcribing' && (
                <Badge className={cn('animate-pulse bg-sky-500/15 text-sky-700 hover:bg-sky-500/15')}>转写中</Badge>
              )}
            </div>
            {rec.transcribe.status === 'done' && rec.transcribe.text ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{rec.transcribe.text}</p>
            ) : rec.transcribe.status === 'transcribing' ? (
              <p className="text-sm text-muted-foreground animate-pulse">转写中…</p>
            ) : rec.transcribe.status === 'failed' ? (
              <p className="text-sm text-destructive">转写失败：{rec.transcribe.error}</p>
            ) : (
              <p className="text-sm text-muted-foreground">待转写（同步完成后自动开始）</p>
            )}
          </div>
        </div>

        {/* 底部操作（不随内容滚动） */}
        <footer className="flex gap-2 border-t px-5 py-3">
          <Button
            variant="ghost"
            className="flex-1"
            disabled={rec.transcribe.status === 'transcribing'}
            onClick={() => void window.api.transcribeOne(rec.serial, rec.id)}
          >
            {rec.transcribe.status === 'done' ? <RefreshCcw /> : <Speech />}
            {rec.transcribe.status === 'done' ? '重新转写' : '转写文本'}
          </Button>
          <Button
            variant="ghost"
            className="flex-1 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 />
            移除
          </Button>
        </footer>
      </div>
    </aside>
  )
}
