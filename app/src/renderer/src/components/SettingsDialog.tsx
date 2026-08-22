import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Eye, EyeOff, FolderOpen } from 'lucide-react'
import type { LlmSettings } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** App 设置弹框：数据保存路径（变更时自动迁移已有数据）+ LLM 接口（AI 日总结用） */
export default function SettingsDialog({ open, onOpenChange }: Props): React.JSX.Element {
  const [dataDir, setDataDir] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [llm, setLlm] = useState<LlmSettings>({ baseUrl: '', model: '', apiKey: '' })
  const [llmBusy, setLlmBusy] = useState(false)
  const [showKey, setShowKey] = useState(false)

  useEffect(() => {
    if (open) {
      setPicked(null)
      setError(null)
      setShowKey(false)
      void window.api.getSettings().then((s) => {
        setDataDir(s.dataDir)
        // 旧主进程（preload 未随重启）返回值无 llm 字段，兜底空配置防炸
        setLlm(s.llm ?? { baseUrl: '', model: '', apiKey: '' })
      })
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

  const saveLlm = async (): Promise<void> => {
    setLlmBusy(true)
    try {
      setLlm(await window.api.setLlmSettings(llm))
      toast.success('LLM 设置已保存')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setLlmBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>录音数据（音频文件）的保存位置，与 AI 总结用的 LLM 接口。</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">当前数据路径</div>
            <div className="rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs break-all">
              {dataDir || '加载中…'}
            </div>
            {/* 按钮贴着路径框：小一号，就在路径框正下方（迁移类操作不与 LLM 区块的按钮混在底部） */}
            <div className="flex items-center gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => void browse()}>
                <FolderOpen className="size-3.5" />
                选择路径…
              </Button>
              <Button size="sm" disabled={!picked || busy} onClick={() => void apply()}>
                {busy ? '迁移中…' : '应用并迁移'}
              </Button>
              {error && <p className="min-w-0 truncate text-xs text-destructive">{error}</p>}
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
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="text-sm font-medium">LLM 接口</div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">API 地址（OpenAI 兼容 Base URL）</div>
            <Input
              value={llm.baseUrl}
              onChange={(e) => setLlm({ ...llm, baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">模型</div>
            <Input
              value={llm.model}
              onChange={(e) => setLlm({ ...llm, model: e.target.value })}
              placeholder="gpt-4o-mini"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">API Key</div>
            <div className="relative">
              <Input
                type={showKey ? 'text' : 'password'}
                value={llm.apiKey}
                onChange={(e) => setLlm({ ...llm, apiKey: e.target.value })}
                placeholder="sk-…"
                spellCheck={false}
                autoComplete="off"
                className="pr-9"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground"
                aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                title={showKey ? '隐藏 API Key' : '显示 API Key'}
                tabIndex={-1}
              >
                {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">用于按天视图的 AI 总结；保存在本机。</p>
            <Button size="sm" disabled={llmBusy} onClick={() => void saveLlm()}>
              {llmBusy ? '保存中…' : '保存 LLM 设置'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
