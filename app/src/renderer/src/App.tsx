import { useEffect, useState } from 'react'
import { Toaster } from 'sonner'
import type { AppState } from '../../shared/types'
import DevicePanel from './components/DevicePanel'
import RecordingDetail from './components/RecordingDetail'
import TitleBar from './components/TitleBar'
import TranscribePreviewDialog, { type SyncBatchPreview } from './components/TranscribePreviewDialog'

export default function App(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null)
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(null)
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

  if (!state) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">加载中…</div>
  }

  // 选中设备被移除时回落到第一个
  const effectiveSerial =
    selectedSerial && state.devices.some((d) => d.serial === selectedSerial)
      ? selectedSerial
      : (state.devices[0]?.serial ?? null)

  // 右侧边栏：从当前 state 找选中录音（转写状态变化时实时更新）
  const selectedRecording = effectiveSerial
    ? (state.recordings[effectiveSerial] ?? []).find((r) => r.id === selectedRecordingId) ?? null
    : null

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
              onCardVisible={setCardVisible}
              scrollToTopSignal={scrollTopSignal}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              还没有设备。插入录音豆，或插入根目录带 .echo-pod 标志文件的 U 盘模拟。
            </div>
          )}
        </main>

        {/* 右侧详情栏：常驻挂载，宽度 0↔26rem 缓动展开/收起 */}
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
