import { useEffect, useState } from 'react'
import { Toaster } from 'sonner'
import type { AppState, ViewMode } from '../../shared/types'
import DayDetail from './components/DayDetail'
import DevicePanel from './components/DevicePanel'
import RecordingDetail from './components/RecordingDetail'
import TitleBar from './components/TitleBar'
import TranscribePreviewDialog, { type SyncBatchPreview } from './components/TranscribePreviewDialog'

export default function App(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null)
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('items')
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  // 设备卡是否在视口内（滚出后标题栏右侧融合显示设备状态）
  const [cardVisible, setCardVisible] = useState(true)
  // 点击标题栏设备状态 → 滚回顶部（信号量驱动 DevicePanel 内部滚动）
  const [scrollTopSignal, setScrollTopSignal] = useState(0)
  // 大同步量转写预览
  const [syncBatch, setSyncBatch] = useState<SyncBatchPreview | null>(null)

  useEffect(() => {
    void window.api.getState().then((s) => {
      setState(s)
      setSelectedSerial((prev) => prev ?? s.devices[0]?.serial ?? null)
    })
    return window.api.onState(setState)
  }, [])

  useEffect(() => {
    // 主/渲染版本错位（preload 未随重启）时优雅跳过
    if (typeof window.api.onSyncBatchPreview !== 'function') return
    return window.api.onSyncBatchPreview(setSyncBatch)
  }, [])

  // 选中设备被移除时回落到第一个（state 未加载时为 null；所有 hook 必须在下方早退之前）
  const effectiveSerial =
    state && selectedSerial && state.devices.some((d) => d.serial === selectedSerial)
      ? selectedSerial
      : (state?.devices[0]?.serial ?? null)

  // 天是设备作用域数据：切设备时清掉按天视图的选中
  useEffect(() => {
    setSelectedDay(null)
  }, [effectiveSerial])

  if (!state) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">加载中…</div>
  }

  // 切视图时收起另一侧的选中（避免两个侧边栏语义叠加）
  const switchView = (mode: ViewMode): void => {
    setViewMode(mode)
    if (mode === 'items') setSelectedDay(null)
    else setSelectedRecordingId(null)
  }

  // 右侧边栏：从当前 state 找选中录音（转写状态变化时实时更新）
  const selectedRecording = effectiveSerial
    ? (state.recordings[effectiveSerial] ?? []).find((r) => r.id === selectedRecordingId) ?? null
    : null

  // 按天视图侧边栏数据：选中日的全部录音（分组键与 DevicePanel 一致）
  const dayRecordings =
    effectiveSerial && selectedDay
      ? (state.recordings[effectiveSerial] ?? []).filter(
          (r) => (r.relPath.split('/')[1] ?? r.syncedAt.slice(0, 10)) === selectedDay
        )
      : []

  return (
    <div className="flex h-full flex-col bg-page-glow">
      <TitleBar
        showStatus={!cardVisible}
        device={state.devices.find((d) => d.serial === effectiveSerial)}
        sync={effectiveSerial && state.sync?.serial === effectiveSerial ? state.sync : null}
        recordingsCount={effectiveSerial ? (state.recordings[effectiveSerial] ?? []).length : 0}
        onStatusClick={() => setScrollTopSignal((s) => s + 1)}
      />
      {/* 顶天立地两栏：左侧首页布局，右侧录音详情侧边栏（打开时） */}
      <div className="flex min-h-0 flex-1">
        <main className="relative h-full min-w-0 flex-1">
          {effectiveSerial ? (
            <DevicePanel
              key={effectiveSerial}
              state={state}
              serial={effectiveSerial}
              onSelect={setSelectedSerial}
              selectedRecordingId={selectedRecordingId}
              onSelectRecording={setSelectedRecordingId}
              viewMode={viewMode}
              onViewMode={switchView}
              selectedDay={selectedDay}
              onSelectDay={setSelectedDay}
              onCardVisible={setCardVisible}
              scrollToTopSignal={scrollTopSignal}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              还没有设备。插入录音豆，或插入根目录带 .echo-pod 标志文件的 U 盘模拟。
            </div>
          )}
        </main>

        {/* 右侧详情栏：常驻挂载，宽度 0↔28rem 缓动展开/收起。按条视图 = 单条详情；按天视图 = 当日对话文稿 */}
        {viewMode === 'days' ? (
          <DayDetail
            day={selectedDay}
            recordings={dayRecordings}
            open={selectedDay != null}
            onClose={() => setSelectedDay(null)}
          />
        ) : (
          <RecordingDetail
            recording={selectedRecording}
            open={selectedRecording != null}
            onClose={() => setSelectedRecordingId(null)}
            onDelete={() => {
              setSelectedRecordingId(null)
              if (selectedRecording) {
                void window.api.deleteRecordings(selectedRecording.serial, [selectedRecording.id])
              }
            }}
          />
        )}
      </div>
      <TranscribePreviewDialog batch={syncBatch} onClose={() => setSyncBatch(null)} />
      <Toaster
        position="bottom-center"
        toastOptions={{
          style: {
            borderRadius: '9999px',
            padding: '8px 16px',
            fontSize: '12px',
            background: 'var(--foreground)',
            color: 'var(--background)',
            border: 'none',
            width: 'fit-content',
            maxWidth: '356px', // sonner 默认宽度作为上限
          }
        }}
        offset={{ bottom: 24 }}
        duration={3000}
      />
    </div>
  )
}
