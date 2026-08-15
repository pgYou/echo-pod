import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** App 设置弹框：数据保存路径（变更时自动迁移已有数据） */
export default function SettingsDialog({ open, onOpenChange }: Props): React.JSX.Element {
  const [dataDir, setDataDir] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setPicked(null)
      setError(null)
      void window.api.getSettings().then((s) => setDataDir(s.dataDir))
    }
  }, [open])

  const browse = async (): Promise<void> => {
    setError(null)
    const dir = await window.api.pickDataDir()
    if (dir) setPicked(dir)
  }

  const apply = async (): Promise<void> => {
    if (!picked) return
    setBusy(true)
    setError(null)
    try {
      const applied = await window.api.setDataDir(picked)
      setDataDir(applied)
      setPicked(null)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>录音数据（音频文件）的保存位置。元数据始终保存在应用目录。</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">当前数据路径</div>
            <div className="rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs break-all">
              {dataDir || '加载中…'}
            </div>
          </div>

          {picked && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">新路径（应用后将迁移已有数据）</div>
              <div className="rounded-md border border-brand/40 bg-brand-soft/40 px-3 py-2 font-mono text-xs break-all">
                {picked}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => void browse()}>
            <FolderOpen />
            选择路径…
          </Button>
          <Button disabled={!picked || busy} onClick={() => void apply()}>
            {busy ? '迁移中…' : '应用并迁移'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
