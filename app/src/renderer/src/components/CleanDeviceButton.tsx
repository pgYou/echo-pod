import { useState } from 'react'
import { HardDriveDownload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface Props {
  serial: string
  /** 本地库无录音时禁用（无已同步文件可清） */
  hasRecordings: boolean
}

/** 清理设备上已同步的录音文件（本地库已有副本；未同步的文件保留），结果经 toast 反馈 */
export default function CleanDeviceButton({ serial, hasRecordings }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const clean = async (): Promise<void> => {
    setBusy(true)
    try {
      const n = await window.api.cleanDevice(serial)
      setOpen(false)
      if (n > 0) toast.success(`已清理设备上 ${n} 个已同步文件`)
      else toast.info('设备上没有可清理的已同步文件')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" disabled={!hasRecordings}>
          <HardDriveDownload />
          清理已同步文件
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <p className="text-sm font-medium">清理设备上的录音文件？</p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          将删除设备上<b>已同步到本机</b>的录音文件（本机副本与文稿保留），未同步的新录音不受影响。
          释放设备存储空间，给新录音腾位置。
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => void clean()}>
            {busy ? '清理中…' : '确认清理'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
