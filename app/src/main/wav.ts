// WAV 头解析：读录音时长（fmt/data 块）
import fs from 'node:fs'

export function parseWavDuration(filePath: string): number | undefined {
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const header = Buffer.alloc(128)
      const read = fs.readSync(fd, header, 0, 128, 0)
      if (read < 44 || header.toString('ascii', 0, 4) !== 'RIFF') return undefined

      let offset = 12 // 跳过 RIFF<size>WAVE
      let byteRate = 0
      let dataSize = 0
      while (offset + 8 <= read) {
        const chunkId = header.toString('ascii', offset, offset + 4)
        const chunkSize = header.readUInt32LE(offset + 4)
        if (chunkId === 'fmt ' && offset + 8 + 16 <= read) {
          byteRate = header.readUInt32LE(offset + 16) // fmt 第 8 字节起的 byteRate
        } else if (chunkId === 'data') {
          dataSize = chunkSize
          break // data 块通常在最后
        }
        offset += 8 + chunkSize + (chunkSize % 2) // 块按 2 字节对齐
      }
      if (byteRate > 0 && dataSize > 0) return Math.round((dataSize / byteRate) * 10) / 10
      return undefined
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
}
