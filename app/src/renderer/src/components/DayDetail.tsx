import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CalendarDays, Loader2, MessageSquare, Pause, Play, RefreshCcw, Sparkles, Trash2, X } from 'lucide-react'
import type { DaySummary, RecordingMeta, SummaryStream } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn, formatDateTime, formatDuration, hasMeaningfulText } from '@/lib/utils'

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
  /** 当天的 AI 总结（主进程生成后随状态推送） */
  summary?: DaySummary | null
  /** 进行中的总结流（全局单任务；匹配当天时在总结 tab 实时渲染） */
  summaryStream: SummaryStream | null
  /** LLM 是否已配置（未配置时置灰总结入口，提示先去设置） */
  llmConfigured: boolean
  open: boolean
  onClose: () => void
}

/** 按天视图侧边栏：双 tab —— 对话文稿连续展示（过滤无有效文本的录音）+ AI 按时间线总结 */
export default function DayDetail({ day, recordings, summary, summaryStream, llmConfigured, open, onClose }: Props): React.JSX.Element {
  const lastRef = useRef<{ day: string; recordings: RecordingMeta[]; summary?: DaySummary | null } | null>(null)
  if (day) lastRef.current = { day, recordings, summary }
  const curDay = day ?? lastRef.current?.day ?? null
  const recs = day ? recordings : (lastRef.current?.recordings ?? [])
  const curSummary = day ? summary : lastRef.current?.summary

  // 内容 tab：对话 / AI 总结
  const [tab, setTab] = useState<'chat' | 'summary'>('chat')

  // 单实例播放：新起一个时暂停上一个
  const activeAudioRef = useRef<HTMLAudioElement | null>(null)
  const handlePlayStart = (audio: HTMLAudioElement): void => {
    if (activeAudioRef.current && activeAudioRef.current !== audio) activeAudioRef.current.pause()
    activeAudioRef.current = audio
  }

  if (!curDay) return <></>

  const valid = [...recs].filter(hasText).sort((a, b) => timeKey(a).localeCompare(timeKey(b)))
  // 流式状态在主进程全局单槽（不随本组件卸载丢失）：匹配当天 → 实时渲染；不匹配 → 只是全局占用（按钮置灰）
  const stream =
    summaryStream != null && recs[0]?.serial === summaryStream.serial && curDay === summaryStream.day
      ? summaryStream
      : null
  const busy = summaryStream != null
  // 渲染层热更新后 preload 未随重启（开发态常见）：新 API 尚未注入，直接调用会抛 not a function
  const apiMissing = typeof window.api.summarizeDay !== 'function'
  const disabledReason = busy
    ? '正在总结中，请稍候'
    : apiMissing
      ? '应用版本错位，请重启应用'
      : llmConfigured
        ? undefined
        : '请先在「设置」中配置 LLM 接口'

  const runSummarize = (): void => {
    const serial = recs[0]?.serial
    if (!serial || !curDay || disabledReason) return
    window.api
      .summarizeDay(serial, curDay)
      .then(() => toast.success('AI 总结已生成'))
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
  }

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
          {/* 右侧：内容 tab 切换（对话 / AI 总结）+ 关闭 */}
          <div className="flex shrink-0 items-center gap-1.5">
            <div className="flex items-center rounded-md border p-0.5">
              <button
                onClick={() => setTab('chat')}
                className={cn(
                  'flex cursor-pointer items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-xs outline-none transition-colors',
                  tab === 'chat' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
                aria-label="对话文稿"
              >
                <MessageSquare className="size-3" />
                对话
              </button>
              <button
                onClick={() => setTab('summary')}
                className={cn(
                  'flex cursor-pointer items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-xs outline-none transition-colors',
                  tab === 'summary' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
                aria-label="AI 总结"
              >
                <Sparkles className="size-3" />
                AI 总结
              </button>
            </div>
            <button
              onClick={onClose}
              className="cursor-pointer rounded-md p-1 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground"
              aria-label="关闭详情"
            >
              <X className="size-4" />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {tab === 'summary' ? (
            valid.length === 0 ? (
              <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                这一天还没有可总结的文稿（转写完成且有文本的录音才能生成总结）
              </div>
            ) : stream ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  AI 总结中，实时生成…
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{stream.text}</p>
              </div>
            ) : curSummary ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {curSummary.model} · 生成于 {formatDateTime(curSummary.createdAt)}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 px-2.5 text-xs"
                    disabled={disabledReason != null}
                    title={disabledReason}
                    onClick={runSummarize}
                  >
                    <RefreshCcw className="size-3" />
                    重新总结
                  </Button>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{curSummary.summary}</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
                <Sparkles className="size-5 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">用 LLM 按时间线总结这一天的对话</p>
                <Button size="sm" disabled={disabledReason != null} title={disabledReason} onClick={runSummarize}>
                  <Sparkles className="size-3.5" />
                  生成 AI 总结
                </Button>
                <p className="text-xs text-muted-foreground">
                  {apiMissing
                    ? '应用版本错位，请重启应用后再试'
                    : busy
                      ? '有另一个总结正在进行，完成后即可生成'
                      : llmConfigured
                        ? '总结基于当日已转写文稿，重新转写后可再次生成'
                        : '请先在「设置」中配置 LLM 接口'}
                </p>
              </div>
            )
          ) : (
            <div className="space-y-4">
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
          )}
        </div>
      </div>
    </aside>
  )
}
