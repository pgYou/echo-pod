// pod:// 协议：把本地录音库（userData/recordings）以自定义协议暴露给渲染层播放
// 例：pod://ES3-8F2A41D9/echo-pod/2026-07-26/14-22-29.wav
// 须在 app ready 前调用 registerPodScheme（registerSchemesAsPrivileged 有此要求）
//
// 媒体播放关键点：必须处理 Range 请求（206 + Content-Range + Accept-Ranges），
// 否则 <audio> 无法获知总时长/拖动进度（症状：能出声但 duration=0）。
import { protocol } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { recordingsRoot } from './state'

const MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg'
}

function contentType(file: string): string {
  return MIME[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

export function registerPodScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'pod', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

export function handlePodProtocol(): void {
  protocol.handle('pod', (request) => {
    const url = new URL(request.url)
    const serial = url.hostname
    const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')

    // 防目录穿越：解析后必须仍在该设备的录音目录内
    const root = path.join(recordingsRoot(), serial)
    const full = path.resolve(root, relPath)
    if (!full.startsWith(root + path.sep)) {
      return new Response('forbidden', { status: 403 })
    }

    let stat: fs.Stats
    try {
      stat = fs.statSync(full)
    } catch {
      return new Response('not found', { status: 404 })
    }
    if (!stat.isFile()) {
      return new Response('not found', { status: 404 })
    }

    const baseHeaders: Record<string, string> = {
      'Content-Type': contentType(full),
      'Accept-Ranges': 'bytes'
    }

    // Range 处理（媒体元素的 duration/seek 依赖）
    const range = request.headers.get('range')
    const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0
      const end = match[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1
      if (start >= stat.size || start > end) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${stat.size}` }
        })
      }
      const stream = Readable.toWeb(
        fs.createReadStream(full, { start, end })
      ) as unknown as ReadableStream
      return new Response(stream, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': String(end - start + 1)
        }
      })
    }

    const stream = Readable.toWeb(fs.createReadStream(full)) as unknown as ReadableStream
    return new Response(stream, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(stat.size) }
    })
  })
}
