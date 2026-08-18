import { useEffect, useMemo, useRef, useState } from 'react'
import { AudioLines, CalendarDays, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Circle, Fingerprint, List, Play, RefreshCw, Search, Settings2, Square, Trash2, Usb } from 'lucide-react'
import type { AppState, DeviceInfo, RecordingMeta, ViewMode } from '../../../shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { toast } from 'sonner'
import CleanDeviceButton from './CleanDeviceButton'
import RecordingRow from './RecordingRow'
import SettingsDialog from './SettingsDialog'
import VoiceprintsDialog from './VoiceprintsDialog'
import { cn, hasMeaningfulText } from '@/lib/utils'

interface Props {
  state: AppState
  serial: string
  onSelect: (serial: string) => void
  selectedRecordingId: string | null
  onSelectRecording: (id: string | null) => void
  /** 录音列表视图：按条（逐条）| 按天（一天一行） */
  viewMode: ViewMode
  onViewMode: (mode: ViewMode) => void
  /** 按天视图选中的日期（点击天行 → 侧边栏整读当日对话） */
  selectedDay: string | null
  onSelectDay: (day: string | null) => void
  /** 设备卡可见性上抛：滚出视口时 App 标题栏融合显示设备状态 */
  onCardVisible: (visible: boolean) => void
  /** 滚回顶部信号（变化即触发平滑滚动到顶） */
  scrollToTopSignal: number
}

/**
 * 设备状态点颜色。
 * 注意：这是给 SVG Circle + fill-current 用的 —— 必须是 text-* 类（fill 取 currentColor），
 * bg-* 在 SVG 形状上不渲染。
 */
function statusOf(d: DeviceInfo, syncing: boolean): { color: string; label: string } {
  if (syncing) return { color: 'text-sky-500', label: '同步中' }
  if (d.connected) return { color: 'text-success', label: '已连接' }
  return { color: 'text-zinc-300', label: '未连接' }
}

export default function DevicePanel({
  state,
  serial,
  onSelect,
  selectedRecordingId,
  onSelectRecording,
  viewMode,
  onViewMode,
  selectedDay,
  onSelectDay,
  onCardVisible,
  scrollToTopSignal
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [voiceprintsOpen, setVoiceprintsOpen] = useState(false)
  // 按天分组折叠状态（默认展开）
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set())
  // 「移除当天」二次确认中的日期
  const [confirmDay, setConfirmDay] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 标题栏状态区点击 → 列表平滑滚回顶部
  useEffect(() => {
    if (scrollToTopSignal <= 0) return
    rootRef.current
      ?.querySelector('[data-slot="scroll-area-viewport"]')
      ?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [scrollToTopSignal])

  const toggleDay = (day: string): void => {
    setCollapsedDays((prev) => {
      const next = new Set(prev)
      if (next.has(day)) next.delete(day)
      else next.add(day)
      return next
    })
  }
  const device = state.devices.find((d) => d.serial === serial)
  const recordings = state.recordings[serial] ?? []
  const sync = state.sync?.serial === serial ? state.sync : null

  // 搜索：文件名 + 转写全文（不区分大小写）；按天分组 —— 天级倒序（新日期在前），组内正序（当天时间从早到晚）
  const dayGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = [...recordings].filter(
      (r) =>
        !q ||
        r.fileName.toLowerCase().includes(q) ||
        (r.transcribe.text ?? '').toLowerCase().includes(q)
    )
    // 组内排序键：录音起始时间（文件名 HH-MM-SS），非常规命名回落到同步时间
    const timeKey = (r: RecordingMeta): string =>
      /^\d{2}-\d{2}-\d{2}/.test(r.fileName) ? r.fileName : r.syncedAt

    const groups = new Map<string, RecordingMeta[]>()
    for (const r of list) {
      const day = r.relPath.split('/')[1] ?? r.syncedAt.slice(0, 10)
      const bucket = groups.get(day) ?? []
      bucket.push(r)
      groups.set(day, bucket)
    }
    return [...groups.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([day, recs]) => [day, [...recs].sort((a, b) => timeKey(a).localeCompare(timeKey(b)))] as const)
  }, [recordings, query])

  const deleteRecordings = (ids: string[]): void => {
    void window.api.deleteRecordings(serial, ids)
  }

  // 转写进度（不依赖设备连接——转录在本地跑）
  const transcribing = recordings.find((r) => r.transcribe.status === 'transcribing')
  const queuedCount = recordings.filter((r) => r.transcribe.status === 'pending').length
  const doneCount = recordings.filter((r) => r.transcribe.status === 'done').length
  const transcribeTotal = doneCount + queuedCount + (transcribing ? 1 : 0)

  if (!device) return <div className="p-8 text-muted-foreground">设备不存在</div>

  const st = statusOf(device, sync != null)

  // 一键展开/收起：有任何一组展开 → 收起全部；全收起 → 展开全部
  const allDays = dayGroups.map(([day]) => day)
  const allCollapsed = allDays.length > 0 && allDays.every((d) => collapsedDays.has(d))
  const toggleAllDays = (): void => {
    setCollapsedDays(allCollapsed ? new Set() : new Set(allDays))
  }

  const startSync = async (): Promise<void> => {
    try {
      await window.api.syncDevice(serial)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div ref={rootRef} className="relative h-full">
      {/* 列表滚动区（渐变背景在 App 根节点，不随滚动；滚出设备卡时上报，App 标题栏融合显示状态） */}
      <ScrollArea
        className="h-full"
        onScroll={(e) => onCardVisible(e.currentTarget.scrollTop <= 200)}
      >
        <div className="mx-auto max-w-3xl space-y-6 px-8 pb-16">
          {/* 设备信息卡：白底、无框无影。左列 = logo（顶部对齐），右列 = 全部内容 */}
          <section className="flex gap-3 rounded-2xl bg-white p-6">
            {/* 应用标识（左列，唯一元素） */}
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-sm">
              <AudioLines className="size-5" />
            </div>

            <div className="min-w-0 flex-1 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  {/* 设备切换：点击展开悬浮下拉 */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className="group flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 -ml-1 text-left outline-none transition-colors hover:bg-accent">
                        <Circle className={cn('size-2.5 fill-current', st.color, sync && 'animate-pulse')} />
                        <span className="truncate text-lg font-semibold">
                          {device.name ?? 'Echo Pod'}
                        </span>
                        <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-64">
                      <DropdownMenuLabel>切换设备（{state.devices.length}）</DropdownMenuLabel>
                      {state.devices.map((d) => {
                        const dst = statusOf(d, state.sync?.serial === d.serial)
                        return (
                          <DropdownMenuItem key={d.serial} onSelect={() => onSelect(d.serial)}>
                            <Circle className={cn('size-2 fill-current', dst.color)} />
                            <span className="flex-1 truncate">{d.name ?? 'Echo Pod'}</span>
                            <span className="text-xs text-muted-foreground">
                              {state.recordings[d.serial]?.length ?? 0} 条
                            </span>
                            {d.serial === serial && <Check className="size-3.5" />}
                          </DropdownMenuItem>
                        )
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <div className="px-1 font-mono text-xs text-muted-foreground">{device.serial}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge
                    variant="secondary"
                    className={cn(
                      device.connected ? 'bg-success/15 text-success' : 'bg-zinc-500/10 text-zinc-500'
                    )}
                  >
                    {st.label}
                  </Badge>
                  <button
                    onClick={() => setVoiceprintsOpen(true)}
                    className="cursor-pointer rounded-md p-1.5 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground"
                    aria-label="声纹管理"
                  >
                    <Fingerprint className="size-4" />
                  </button>
                  <button
                    onClick={() => setSettingsOpen(true)}
                    className="cursor-pointer rounded-md p-1.5 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground"
                    aria-label="设置"
                  >
                    <Settings2 className="size-4" />
                  </button>
                </div>
              </div>

              <div className="flex gap-4 text-xs text-muted-foreground">
                <span>固件 {device.fw ?? '--'}</span>
                <span>硬件 {device.hw ?? '--'}</span>
                <span>{recordings.length} 条录音</span>
              </div>

              {/* 转写状态：进行中显示进度+停止；停止后有积压显示继续 */}
              {transcribing ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="min-w-0 truncate">
                      转写中 · {doneCount + 1}/{transcribeTotal} · {transcribing.fileName}
                    </span>
                    <button
                      onClick={() => void window.api.stopTranscribe()}
                      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 outline-none transition-colors hover:bg-accent hover:text-destructive"
                      aria-label="停止转写"
                    >
                      <Square className="size-3 fill-current" />
                      停止
                    </button>
                  </div>
                  <Progress value={((doneCount + (transcribing ? 1 : 0)) / transcribeTotal) * 100} />
                </div>
              ) : queuedCount > 0 ? (
                <div className="flex items-center gap-3">
                  <Button variant="outline" onClick={() => void window.api.resumeTranscribe(serial)}>
                    <Play />
                    继续转写（剩余 {queuedCount} 条）
                  </Button>
                </div>
              ) : null}

              {/* 同步区：设备下方 */}
              {sync ? (
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span className="truncate">正在同步 {sync.currentFile ?? '…'}</span>
                    <span>
                      {sync.done}/{sync.total}
                    </span>
                  </div>
                  <Progress value={(sync.done / sync.total) * 100} />
                </div>
              ) : device.connected ? (
                <div className="flex items-center gap-3">
                  {device.pendingCount > 0 ? (
                    <Button onClick={() => void startSync()}>
                      <Usb />
                      开始同步（{device.pendingCount} 个新录音）
                    </Button>
                  ) : (
                    <Button variant="outline" disabled>
                      <RefreshCw />
                      已是最新
                    </Button>
                  )}
                  <CleanDeviceButton serial={serial} hasRecordings={recordings.length > 0} />
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  未连接。插入设备后自动扫描待同步文件。
                </div>
              )}
            </div>
          </section>

          {/* 录音列表：按天分组，点击行打开右侧详情栏 */}
          <div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">录音</h2>

                {/* 视图切换：按条（逐条列表）/ 按天（一天一行 → 侧边栏整读当日对话） */}
                <div className="flex items-center rounded-md border p-0.5">
                  <button
                    onClick={() => onViewMode('items')}
                    className={cn(
                      'flex cursor-pointer items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-xs outline-none transition-colors',
                      viewMode === 'items' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
                    )}
                    aria-label="按条查看"
                  >
                    <List className="size-3" />
                    按条
                  </button>
                  <button
                    onClick={() => onViewMode('days')}
                    className={cn(
                      'flex cursor-pointer items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-xs outline-none transition-colors',
                      viewMode === 'days' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
                    )}
                    aria-label="按天查看"
                  >
                    <CalendarDays className="size-3" />
                    按天
                  </button>
                </div>
                {viewMode === 'items' && dayGroups.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-muted-foreground"
                    onClick={toggleAllDays}
                  >
                    {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
                    {allCollapsed ? '展开全部' : '收起全部'}
                  </Button>
                )}
              </div>
              <div className="relative w-64">
                <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索文件名或全文…"
                  className="h-8 w-full rounded-md border bg-background pr-3 pl-8 text-xs outline-none focus:ring-[3px] focus:ring-ring/50"
                />
              </div>
            </div>
            {dayGroups.length === 0 ? (
              <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                {query ? `没有匹配"${query}"的录音` : '还没有同步的录音'}
              </div>
            ) : viewMode === 'days' ? (
              /* 按天视图：一天一行，点击 → 右侧栏整读当日对话文稿 */
              <div className="divide-y overflow-hidden rounded-xl border bg-white">
                {dayGroups.map(([day, recs]) => {
                  const validCount = recs.filter(
                    (r) => r.transcribe.status === 'done' && hasMeaningfulText(r.transcribe.text)
                  ).length
                  const selected = day === selectedDay
                  return (
                    <div
                      key={day}
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelectDay(selected ? null : day)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') onSelectDay(selected ? null : day)
                      }}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors outline-none',
                        selected ? 'bg-accent' : 'hover:bg-accent/50'
                      )}
                    >
                      <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{day}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {recs.length} 条录音
                          {validCount > 0 && validCount < recs.length ? ` · ${validCount} 条有文稿` : ''}
                        </div>
                      </div>
                      <ChevronRight
                        className={cn('size-4 shrink-0 text-muted-foreground transition-transform', selected && 'rotate-90')}
                      />
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="space-y-8">
                {dayGroups.map(([day, recs]) => {
                  const collapsed = collapsedDays.has(day)
                  return (
                    <section key={day}>
                      <header
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleDay(day)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') toggleDay(day)
                        }}
                        className="group mb-2 flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 outline-none select-none hover:bg-accent/50"
                        aria-expanded={!collapsed}
                      >
                        <ChevronDown
                          className={cn(
                            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-300',
                            collapsed && '-rotate-90'
                          )}
                        />
                        <h3 className="text-xs font-medium text-muted-foreground">
                          {day} · {recs.length} 条
                        </h3>
                        <div className="h-px flex-1 bg-border" />
                        <Popover open={confirmDay === day} onOpenChange={(v) => setConfirmDay(v ? day : null)}>
                          <PopoverTrigger asChild>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                setConfirmDay((prev) => (prev === day ? null : day))
                              }}
                              className={cn(
                                'flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-xs outline-none transition-all hover:bg-accent hover:text-destructive',
                                confirmDay === day ? 'text-destructive' : 'text-muted-foreground'
                              )}
                              aria-label={`移除 ${day} 的录音`}
                            >
                              <Trash2 className="size-3" />
                              移除当天
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            side="top"
                            align="end"
                            className="w-auto p-3"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <p className="text-xs">移除 {day} 的 {recs.length} 条录音？（设备上的原始文件不受影响）</p>
                            <div className="mt-2.5 flex justify-end gap-2">
                              <Button variant="ghost" size="xs" onClick={() => setConfirmDay(null)}>
                                取消
                              </Button>
                              <Button
                                variant="destructive"
                                size="xs"
                                onClick={() => {
                                  setConfirmDay(null)
                                  deleteRecordings(recs.map((r) => r.id))
                                }}
                              >
                                确认移除
                              </Button>
                            </div>
                          </PopoverContent>
                        </Popover>
                      </header>

                      {/* 折叠容器：grid-template-rows 0fr↔1fr 过渡 + overflow hidden 实现缓动收起 */}
                      <div
                        className={cn(
                          'grid transition-[grid-template-rows] duration-300 ease-in-out',
                          collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'
                        )}
                      >
                        <div className="min-h-0 overflow-hidden">
                          <div className="divide-y rounded-xl border bg-white overflow-hidden">
                            {recs.map((rec) => (
                              <RecordingRow
                                key={rec.id}
                                recording={rec}
                                selected={rec.id === selectedRecordingId}
                                onSelect={() => onSelectRecording(rec.id === selectedRecordingId ? null : rec.id)}
                                onDelete={() => deleteRecordings([rec.id])}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    </section>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </ScrollArea>

      {/* 设置弹框 */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      {/* 声纹管理弹框 */}
      <VoiceprintsDialog
        open={voiceprintsOpen}
        onOpenChange={setVoiceprintsOpen}
        serial={serial}
        deviceName={device.name ?? 'Echo Pod'}
        voiceprints={(state.voiceprints ?? {})[serial] ?? []}
      />
    </div>
  )
}
