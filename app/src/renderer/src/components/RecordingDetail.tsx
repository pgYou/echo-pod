import { Trash2, X } from 'lucide-react'
import type { RecordingMeta } from '../../../shared/types'
import AudioPlayer from './AudioPlayer'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn, formatBytes, formatDateTime, formatDuration } from '@/lib/utils'

interface Props {
  recording: RecordingMeta
  onClose: () => void
  onDelete: () => void
}

/** 右侧详情栏：顶天立地，独立滚动。播放器 + 完整文稿 + 元信息 */
export default function RecordingDetail({ recording, onClose, onDelete }: Props): React.JSX.Element {
  const rec = recording

  return (
    <aside className="flex h-full w-[26rem] shrink-0 flex-col border-l bg-card">
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
      <footer className="border-t px-5 py-3">
        <Button
          variant="ghost"
          className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 />
          移除此录音
        </Button>
      </footer>
    </aside>
  )
}
