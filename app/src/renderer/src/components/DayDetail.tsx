import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Pause, Play, X } from 'lucide-react'
import type { RecordingMeta } from '../../../shared/types'
import { cn, hasMeaningfulText } from '@/lib/utils'

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

/** 块右上角微型播放器：圆钮播放/暂停 + 细进度条（rAF 刷新，点击进度条跳转） */
function MiniPlayer({ src, onPlayStart }: { src: string; onPlayStart: (audio: HTMLAudioElement) => void }): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [ratio, setRatio] = useState(0)

  useEffect(() => {
    setPlaying(false)
    setRatio(0)
    if (audioRef.current) audioRef.current.currentTime = 0
  }, [src])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = (): void => {
      const a = audioRef.current
      if (a && a.duration > 0 && Number.isFinite(a.duration)) setRatio(Math.min(a.currentTime / a.duration, 1))
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
    if (!el || !a || !a.duration || !Number.isFinite(a.duration)) return
    const rect = el.getBoundingClientRect()
    const r = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    a.currentTime = r * a.duration
    setRatio(r)
  }

  return (
    <div className="flex items-center gap-2">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <button
        onClick={toggle}
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-colors hover:bg-accent"
        aria-label={playing ? '暂停' : '播放'}
      >
        {playing ? <Pause className="size-3" /> : <Play className="size-3 translate-x-[0.5px]" />}
      </button>
      <div ref={trackRef} className="relative h-3 w-20 cursor-pointer" onPointerDown={seek}>
        <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-muted" />
        <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
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
        open ? 'w-[28rem] border-l' : 'w-0 border-transparent'
      )}
    >
      {/* 内层定宽：宽度动画期间内容不重排 */}
      <div
        className={cn(
          'flex h-full w-[28rem] flex-col transition-opacity duration-200',
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
              <section key={rec.id} className="rounded-xl border bg-white p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{timeLabel(rec)}</span>
                  <MiniPlayer src={podSrc(rec)} onPlayStart={handlePlayStart} />
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{rec.transcribe.text}</p>
              </section>
            ))
          )}
        </div>
      </div>
    </aside>
  )
}
