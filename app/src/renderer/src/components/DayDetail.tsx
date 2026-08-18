import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CalendarDays, Pause, Play, RefreshCcw, Trash2, X } from 'lucide-react'
import type { RecordingMeta } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn, formatDuration, hasMeaningfulText } from '@/lib/utils'

/** 有效文稿：已转写完成且有实质文本（去标点/标签后仍有汉字字母数字——噪音录音常转出零散标点） */
function hasText(r: RecordingMeta): boolean {
  return r.transcribe.status === 'done' && hasMeaningfulText(r.transcribe.text)
}

/** 组内排序键：录音起始时间（文件名 HH-MM-SS），非常规命名回落同步时间（与 DevicePanel 一致） */
function timeKey(r: RecordingMeta): string {
  return /^\d{2}-\d{2}-\d{2}/.test(r.fileName) ? r.fileName : r.syncedAt
}

/** 文件名 HH-MM-SS → 显示 HH:MM:SS */
function timeLabel(r: RecordingMeta): string {
  const m = /^(\d{2})-(\d{2})-(\d{2})/.exec(r.fileName)
  return m ? `${m[1]}:${m[2]}:${m[3]}` : r.fileName
}

/** 录音的 pod:// 播放地址（路径段编码，与 RecordingDetail 一致） */
function podSrc(rec: RecordingMeta): string {
  return `pod://${rec.serial}/${rec.relPath
    .split('/')
    .map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg)))
    .join('/')}`
}

/** 块头微型播放器：进度条 + 时间（仅播放中显示）+ 播放钮。进度条可点击跳转，rAF 刷新 */
function MiniPlayer({
  src,
  fallbackDuration,
  onPlayStart
}: {
  src: string
  fallbackDuration?: number
  onPlayStart: (audio: HTMLAudioElement) => void
}): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)

  // 有效总时长：audio 元素的为准，无效（0/∞）时用元数据兜底
  const total = duration > 0 ? duration : (fallbackDuration ?? 0)

  useEffect(() => {
    setPlaying(false)
    setCurrent(0)
    setDuration(0)
    if (audioRef.current) audioRef.current.currentTime = 0
  }, [src])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = (): void => {
      const a = audioRef.current
      if (a) setCurrent(a.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  const toggle = (): void => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) {
      onPlayStart(a)
      void a.play()
    } else a.pause()
  }

  const seek = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = trackRef.current
    const a = audioRef.current
    if (!el || !a || total <= 0) return
    const rect = el.getBoundingClientRect()
    const r = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    a.currentTime = r * total
    setCurrent(r * total)
  }

  const ratio = total > 0 ? Math.min(current / total, 1) : 0

  return (
    <div className="flex items-center gap-2">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration
          setDuration(Number.isFinite(d) ? d : 0)
        }}
      />
      {playing && (
        <>
          <div ref={trackRef} className="relative h-3 w-20 shrink-0 cursor-pointer" onPointerDown={seek}>
            <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-muted" />
            <div
              className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary"
              style={{ width: `${ratio * 100}%` }}
            />
          </div>
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            {formatDuration(current) || '0:00'}/{formatDuration(total) || '--:--'}
          </span>
        </>
      )}
      <button
        onClick={toggle}
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-colors hover:bg-accent"
        aria-label={playing ? '暂停' : '播放'}
      >
        {playing ? <Pause className="size-3" /> : <Play className="size-3 translate-x-[1px]" />}
      </button>
    </div>
  )
}

/** 单条录音块：头部（时间 + 重新转写/删除 + 微型播放器）+ 文稿。删除两步确认 */
function RecordingBlock({ rec, onPlayStart }: { rec: RecordingMeta; onPlayStart: (audio: HTMLAudioElement) => void }): React.JSX.Element {
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    setConfirmOpen(false)
  }, [rec.id])

  const retranscribe = (): void => {
    void window.api
      .transcribeOne(rec.serial, rec.id)
      .then(() => toast.success(`已加入转写队列：${rec.fileName}`))
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
  }

  const del = (): void => {
    setConfirmOpen(false)
    void window.api.deleteRecordings(rec.serial, [rec.id])
  }

  return (
    <section className="rounded-xl border bg-white p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted-foreground">{timeLabel(rec)}</span>
        {/* 右侧按钮区：微型播放器（进度条/时间仅播放中显示，播放钮常驻）+ 重新转写 + 删除 */}
        <span className="flex shrink-0 items-center gap-0.5">
          <span className="mr-1 flex items-center">
            <MiniPlayer src={podSrc(rec)} fallbackDuration={rec.durationSec} onPlayStart={onPlayStart} />
          </span>
          <button
            onClick={retranscribe}
            className="cursor-pointer rounded-md p-1 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground"
            aria-label="重新转写"
            title="重新转写"
          >
            <RefreshCcw className="size-3.5" />
          </button>
          <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
            <PopoverTrigger asChild>
              <button
                onClick={() => setConfirmOpen((v) => !v)}
                className={cn(
                  'cursor-pointer rounded-md p-1 outline-none transition-colors hover:bg-accent hover:text-destructive',
                  confirmOpen ? 'text-destructive' : 'text-muted-foreground'
                )}
                aria-label="删除录音"
                title="删除录音"
              >
                <Trash2 className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="end" className="w-auto p-3">
              <p className="text-xs">删除这条录音？（设备上的原始文件不受影响）</p>
              <div className="mt-2.5 flex justify-end gap-2">
                <Button variant="ghost" size="xs" onClick={() => setConfirmOpen(false)}>
                  取消
                </Button>
                <Button variant="destructive" size="xs" onClick={del}>
                  确认删除
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </span>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{rec.transcribe.text}</p>
    </section>
  )
}

interface Props {
  /** null = 关闭中；收起动画期间保留上一天内容避免闪空 */
  day: string | null
  /** 该设备当天的全部录音（含无文稿的，用于统计） */
  recordings: RecordingMeta[]
  open: boolean
  onClose: () => void
}

/** 按天视图侧边栏：一天的对话文稿连续展示（过滤无有效文本的录音），每块右上角微型播放器 */
export default function DayDetail({ day, recordings, open, onClose }: Props): React.JSX.Element {
  const lastRef = useRef<{ day: string; recordings: RecordingMeta[] } | null>(null)
  if (day) lastRef.current = { day, recordings }
  const curDay = day ?? lastRef.current?.day ?? null
  const recs = day ? recordings : (lastRef.current?.recordings ?? [])

  // 单实例播放：新起一个时暂停上一个
  const activeAudioRef = useRef<HTMLAudioElement | null>(null)
  const handlePlayStart = (audio: HTMLAudioElement): void => {
    if (activeAudioRef.current && activeAudioRef.current !== audio) activeAudioRef.current.pause()
    activeAudioRef.current = audio
  }

  if (!curDay) return <></>

  const valid = [...recs].filter(hasText).sort((a, b) => timeKey(a).localeCompare(timeKey(b)))

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
        <header className="flex items-start justify-between gap-2 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 truncate text-sm font-semibold">
              <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
              {curDay}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {recs.length} 条录音{valid.length < recs.length ? ` · ${valid.length} 条有文稿` : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground"
            aria-label="关闭详情"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {valid.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              这一天还没有有效文稿（转写完成且有文本的录音会显示在这里）
            </div>
          ) : (
            valid.map((rec) => (
              <RecordingBlock key={rec.id} rec={rec} onPlayStart={handlePlayStart} />
            ))
          )}
        </div>
      </div>
    </aside>
  )
}
