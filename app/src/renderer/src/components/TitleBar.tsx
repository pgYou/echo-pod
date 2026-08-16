import { Circle } from 'lucide-react'
import type { DeviceInfo, SyncState } from '../../../shared/types'
import { cn } from '@/lib/utils'

/** 应用图标：无边框版（透明底 + 橙色渐变音量条，几何同 AudioLines / app icon.svg） */
function AppIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden>
      <defs>
        <linearGradient id="echopod-titlebar-brand" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#f97316" />
          <stop offset="100%" stopColor="#fbbf24" />
        </linearGradient>
      </defs>
      <g fill="url(#echopod-titlebar-brand)">
        <rect x="219" y="472" width="53" height="80" rx="26" />
        <rect x="326" y="366" width="53" height="293" rx="26" />
        <rect x="433" y="272" width="53" height="480" rx="26" />
        <rect x="539" y="419" width="53" height="187" rx="26" />
        <rect x="646" y="339" width="53" height="347" rx="26" />
        <rect x="753" y="472" width="53" height="80" rx="26" />
      </g>
    </svg>
  )
}

interface Props {
  /** 设备卡滚出视口后，标题栏右侧融合显示设备状态（此时 icon+标题靠左） */
  showStatus: boolean
  device?: DeviceInfo
  sync?: SyncState | null
  recordingsCount: number
  /** 点击右侧设备状态区：滚动回顶部 */
  onStatusClick?: () => void
}

function statusOf(d: DeviceInfo, syncing: boolean): { color: string; label: string } {
  if (syncing) return { color: 'text-sky-500', label: '同步中' }
  if (d.connected) return { color: 'text-success', label: '已连接' }
  return { color: 'text-zinc-300', label: '未连接' }
}

export default function TitleBar({ showStatus, device, sync, recordingsCount, onStatusClick }: Props): React.JSX.Element {
  const st = device ? statusOf(device, sync != null) : null
  const statusActive = showStatus && st != null

  return (
    // eslint-disable-next-line prettier/prettier
    <header
      className="relative flex h-9 shrink-0 items-center select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* 应用标识 + 标题：常态居中 / 状态融合时靠左，两组交叉渐隐渐显（不做水平移动） */}
      <div
        className={cn(
          'absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 transition-opacity duration-200',
          statusActive ? 'opacity-0' : 'opacity-100'
        )}
      >
        <AppIcon className="size-6" />
        <span className="text-xs font-medium text-foreground">Echo回响</span>
      </div>
      <div
        className={cn(
          'absolute top-1/2 left-20 flex -translate-y-1/2 items-center gap-1 transition-opacity duration-200',
          statusActive ? 'opacity-100' : 'opacity-0'
        )}
      >
        <AppIcon className="size-6" />
        <span className="text-xs font-medium text-foreground">Echo回响</span>
      </div>

      {/* 设备状态（右侧，滚出设备卡后渐显；点击滚回顶部，需 no-drag） */}
      <button
        onClick={onStatusClick}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className={cn(
          'ml-auto flex cursor-pointer items-center gap-2 rounded-md px-3 py-1 pr-4 text-right transition-all duration-200',
          statusActive ? 'opacity-100 hover:bg-accent/60' : 'pointer-events-none opacity-0'
        )}
        aria-label="回到顶部"
      >
        <Circle className={cn('size-2 fill-current', st!.color, sync && 'animate-pulse')} />
        <span className="text-xs font-medium">{device?.name ?? 'Echo回响'}</span>
        <span className="text-xs text-muted-foreground">{st!.label}</span>
        {sync && (
          <span className="text-xs text-muted-foreground">
            {sync.done}/{sync.total}
          </span>
        )}
        <span className="text-xs text-muted-foreground">{recordingsCount} 条录音</span>
      </button>
    </header>
  )
}
