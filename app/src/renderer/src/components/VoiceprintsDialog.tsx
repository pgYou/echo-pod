import { useEffect, useState } from 'react'
import { Fingerprint, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Voiceprint } from '../../../shared/types'
import AudioPlayer from './AudioPlayer'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn, formatDate } from '@/lib/utils'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  serial: string
  deviceName: string
  voiceprints: Voiceprint[]
}

/** 单条声纹：demo 试听 + 行内重命名（名字不唯一）+ 删除（Popover 二次确认，完全删除） */
function VoiceprintRow({ serial, vp }: { serial: string; vp: Voiceprint }): React.JSX.Element {
  const [name, setName] = useState(vp.name)
  const [saved, setSaved] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    setName(vp.name)
  }, [vp.id])

  const commit = (): void => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === vp.name) {
      setName(vp.name)
      return
    }
    void window.api.renameVoiceprint(serial, vp.id, trimmed).then(() => {
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    })
  }

  const del = (): void => {
    setConfirmOpen(false)
    void window.api
      .deleteVoiceprint(serial, vp.id)
      .then(() => toast.success(`已删除「${vp.name}」`))
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
  }

  return (
    <div className="space-y-2 rounded-xl border bg-white p-3">
      <div className="flex items-center gap-2">
        <Fingerprint className="size-4 shrink-0 text-muted-foreground" />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus:ring-[3px] focus:ring-ring/50"
          aria-label="声纹名称"
        />
        {saved && <span className="shrink-0 text-xs text-success">已保存</span>}
        <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
          <PopoverTrigger asChild>
            <button
              className={cn(
                'flex shrink-0 cursor-pointer items-center rounded-md p-1 text-xs outline-none transition-all',
                confirmOpen ? 'text-destructive' : 'text-muted-foreground hover:bg-accent hover:text-destructive'
              )}
              aria-label="删除声纹"
            >
              <Trash2 className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="end" className="w-auto p-3">
            <p className="text-xs">完全删除「{vp.name}」？（demo 音频一并删除，转写文本不受影响）</p>
            <div className="mt-2.5 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>
                取消
              </Button>
              <Button variant="destructive" size="sm" onClick={del}>
                确认删除
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <AudioPlayer src={`pod://_vp/${serial}/${vp.demoFile}`} />
      <div className="text-xs text-muted-foreground">
        出现 {vp.occurrences} 次 · 首次 {formatDate(vp.firstSeen)} · 最近 {formatDate(vp.lastSeen)}
      </div>
    </div>
  )
}

/** 声纹管理弹框：设备内自动注册的声音列表（试听 / 重命名 / 删除） */
export default function VoiceprintsDialog({ open, onOpenChange, serial, deviceName, voiceprints }: Props): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex min-h-[26rem] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>声纹 · {deviceName}</DialogTitle>
          <DialogDescription>
            设备上出现过的声音在转写时自动注册。多个声纹是同一人时，可将其命名为相同名字。
          </DialogDescription>
        </DialogHeader>

        {voiceprints.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">
            还没有声纹。同步并转写录音后，出现过的声音会自动注册到这里。
          </div>
        ) : (
          <div className="max-h-[60vh] min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {voiceprints.map((vp) => (
              <VoiceprintRow key={vp.id} serial={serial} vp={vp} />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
