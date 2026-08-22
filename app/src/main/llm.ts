// AI 日总结：把一天的转写文稿按时间线发给 OpenAI 兼容 LLM（SSE 流式），边生成边推给渲染层，完成后持久化
// 调用必须在主进程（渲染层有 CSP 限制，且 apiKey 不应暴露给渲染层）
//
// 超时语义：不做总时长限制（长对话生成可能几分钟），改为
// - 空闲超时：IDLE_TIMEOUT_MS 内没收到任何新内容 → 中止（区分"慢"与"挂了"）
// - 总量上限：TOTAL_TIMEOUT_MS 兜底防失控流
import type { DaySummary, RecordingMeta } from '../shared/types'
import { hasMeaningfulText } from '../shared/text'
import { getLlmSettings } from './settings'
import { getRecordings, saveDaySummary, broadcastSummaryDelta } from './state'

const IDLE_TIMEOUT_MS = 120_000
const TOTAL_TIMEOUT_MS = 600_000
/** 流式文本推送节流（状态广播 + 落库都压在这个频率上） */
const EMIT_THROTTLE_MS = 200

/** 全局同一时刻只跑一个总结（流式状态 summaryStream 是单槽） */
let summarizingKey: string | null = null

/** 与渲染层同款天键：relPath 第二段（echo-pod/2026-08-14/xx.wav），非常规命名回落同步日期 */
function dayKeyOf(r: RecordingMeta): string {
  return r.relPath.split('/')[1] ?? r.syncedAt.slice(0, 10)
}

/** 组内排序键与时间标签（与 DayDetail 一致：文件名 HH-MM-SS 优先） */
function timeKey(r: RecordingMeta): string {
  return /^\d{2}-\d{2}-\d{2}/.test(r.fileName) ? r.fileName : r.syncedAt
}
function timeLabel(r: RecordingMeta): string {
  const m = /^(\d{2})-(\d{2})-(\d{2})/.exec(r.fileName)
  return m ? `${m[1]}:${m[2]}:${m[3]}` : r.fileName
}

/** Base URL → chat/completions 完整地址（容忍尾部斜杠与已带 endpoint 的写法） */
function chatUrl(base: string): string {
  const u = base.trim().replace(/\/+$/, '')
  return u.endsWith('/chat/completions') ? u : `${u}/chat/completions`
}

const SYSTEM_PROMPT = [
  '你是录音整理助手。用户会给出某人一天的录音转写文稿，每段以"-- 时:分:秒 --"开头、按时间排序，段内可能带说话人标签（如 [说话人 1]）。',
  '请按时间线整理这一天的内容，要求：',
  '- 按时间顺序归纳话题（相邻同类内容合并），每条以大致时间开头，如「09:30 ·」',
  '- 涉及多个说话人时保留称呼，便于分辨谁说了什么',
  '- 提炼话题、结论和待办，忽略语气词与无意义寒暄，不要逐字复述',
  '- 纯文本输出，不要 markdown 语法（#、** 等）',
  '- 结尾用一两句话总览这一天'
].join('\n')

/** 生成（或重新生成）某设备某天的 AI 总结。流式过程中的部分文本经 AppState.summaryStream 推送；失败抛错，成功随状态推送并入库 */
export async function summarizeDay(serial: string, day: string): Promise<DaySummary> {
  const { baseUrl, model, apiKey } = getLlmSettings()
  if (!baseUrl || !model || !apiKey) {
    throw new Error('未配置 LLM 接口：请在设置中填写 API 地址、模型和 API Key')
  }

  const valid = getRecordings(serial)
    .filter(
      (r) => r.transcribe.status === 'done' && hasMeaningfulText(r.transcribe.text) && dayKeyOf(r) === day
    )
    .sort((a, b) => timeKey(a).localeCompare(timeKey(b)))
  if (valid.length === 0) throw new Error('这一天没有已转写的文稿，无法总结')

  const key = `${serial}/${day}`
  if (summarizingKey) throw new Error('正在总结中，请稍候')

  let transcript = valid.map((r) => `-- ${timeLabel(r)} --\n${r.transcribe.text}`).join('\n\n')
  if (transcript.length > 100_000) {
    transcript = transcript.slice(0, 100_000) + '\n…（内容过长已截断）'
  }

  summarizingKey = key
  broadcastSummaryDelta({ serial, day, text: '' })

  const controller = new AbortController()
  const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  let idleTimer: NodeJS.Timeout | undefined
  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
  }
  let lastEmit = 0
  let text = ''
  const emitText = (force: boolean): void => {
    if (!force && Date.now() - lastEmit < EMIT_THROTTLE_MS) return
    lastEmit = Date.now()
    broadcastSummaryDelta({ serial, day, text })
  }

  /** 解析一行 SSE；返回 true 表示收到 [DONE] */
  const consumeLine = (raw: string): boolean => {
    const line = raw.trim()
    if (!line.startsWith('data:')) return false // 空行/供应商注释（": ping"）等
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') return true
    try {
      const chunk = JSON.parse(payload) as {
        choices?: { delta?: { content?: string }; message?: { content?: string } }[]
      }
      // 标准 OpenAI 流式给 delta.content；个别兼容实现退化给完整 message
      const delta = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? ''
      if (delta) {
        text += delta
        emitText(false)
      }
    } catch {
      // 非 JSON 载荷（心跳等），忽略
    }
    return false
  }

  try {
    resetIdle()
    let res: Response
    try {
      res = await fetch(chatUrl(baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `以下是 ${day} 的录音转写文稿：\n\n${transcript}` }
          ],
          temperature: 0.3,
          stream: true
        }),
        signal: controller.signal
      })
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`LLM 首字等待超时（${IDLE_TIMEOUT_MS / 1000} 秒无响应）`)
      throw new Error(`LLM 请求失败：${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`LLM 接口返回 ${res.status}${body ? `：${body.slice(0, 300)}` : ''}`)
    }
    if (!res.body) throw new Error('LLM 接口未返回流式响应体')

    // SSE 分帧不保证按行到达：按 \n 切分，末行（可能不完整）留在缓冲
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let finished = false
    while (!finished) {
      const { done, value } = await reader.read()
      if (done) break
      resetIdle()
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (consumeLine(line)) {
          finished = true
          break
        }
      }
    }
    // 连接关闭但没发 [DONE] 的实现：残留缓冲再消费一次
    if (!finished && buf && consumeLine(buf)) finished = true

    if (!text.trim()) throw new Error('LLM 未返回总结内容')

    const s: DaySummary = {
      serial,
      day,
      summary: text.trim(),
      recordingIds: valid.map((r) => r.id),
      model,
      createdAt: new Date().toISOString()
    }
    saveDaySummary(s)
    return s
  } catch (err) {
    if (controller.signal.aborted && err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `LLM 响应超时（${IDLE_TIMEOUT_MS / 1000} 秒无新增内容，或总时长超过 ${TOTAL_TIMEOUT_MS / 60000} 分钟）`
      )
    }
    throw err
  } finally {
    summarizingKey = null
    clearTimeout(totalTimer)
    if (idleTimer) clearTimeout(idleTimer)
    broadcastSummaryDelta(null)
  }
}
