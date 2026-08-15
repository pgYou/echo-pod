import { useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn, formatDuration } from '@/lib/utils'

interface Props {
  src: string
  /** 元数据中已解析的时长（秒），audio 元素拿不到真实时长时兜底显示 */
  fallbackDuration?: number
}

/** 录音行内迷你播放器：播放/暂停 + 进度条（已播深色，rAF 平滑刷新）+ 时间 */
export default function AudioPlayer({ src, fallbackDuration }: Props): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [dragRatio, setDragRatio] = useState<number | null>(null)

  // 有效总时长：audio 元素的为准，无效（0/∞）时用元数据兜底
  const total = duration > 0 ? duration : (fallbackDuration ?? 0)

  useEffect(() => {
    // 切换 src 时重置状态
    setPlaying(false)
    setCurrent(0)
    setDuration(0)
    setDragRatio(null)
    if (audioRef.current) audioRef.current.currentTime = 0
  }, [src])

  // 播放中用 requestAnimationFrame 逐帧刷新（timeupdate ~4Hz 会一顿一顿）
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = (): void => {
      const audio = audioRef.current
      if (audio && dragRatio == null) setCurrent(audio.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, dragRatio])

  const toggle = (): void => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) void audio.play()
    else audio.pause()
  }

  const ratioFromX = (clientX: number): number => {
    const el = trackRef.current
    if (!el || total <= 0) return 0
    const rect = el.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  // 拖动过程只更新视觉，松手才提交 seek（避免拖动时狂发 Range 请求）
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragRatio(ratioFromX(e.clientX))
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRatio == null) return
    setDragRatio(ratioFromX(e.clientX))
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRatio == null) return
    const ratio = ratioFromX(e.clientX)
    const audio = audioRef.current
    if (audio && total > 0) {
      audio.currentTime = ratio * total
      setCurrent(ratio * total)
    }
    setDragRatio(null)
  }

  const shownRatio = total > 0 ? (dragRatio ?? Math.min(current / total, 1)) : 0

  return (
    <div className="flex items-center gap-3">
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
      <Button variant="outline" size="icon" className="size-8 shrink-0 rounded-full" onClick={toggle}>
        {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-[1px]" />}
      </Button>

      {/* 进度条：底轨 muted，已播放部分深色（primary），带拖点 */}
      <div
        ref={trackRef}
        role="slider"
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(current)}
        className="group relative flex h-4 flex-1 cursor-pointer items-center"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDragRatio(null)}
      >
        <div className="h-1.5 w-full rounded-full bg-muted" />
        <div
          className="pointer-events-none absolute left-0 h-1.5 rounded-full bg-primary"
          style={{ width: `${shownRatio * 100}%` }}
        />
        <div
          className={cn(
            'pointer-events-none absolute size-3 -translate-x-1/2 rounded-full bg-primary shadow transition-transform',
            dragRatio != null ? 'scale-110' : 'scale-0 group-hover:scale-100'
          )}
          style={{ left: `${shownRatio * 100}%` }}
        />
      </div>

      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
        {formatDuration(current) || '0:00'} / {formatDuration(total) || '--:--'}
      </span>
    </div>
  )
}
