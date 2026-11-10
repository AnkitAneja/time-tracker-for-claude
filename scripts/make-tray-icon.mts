// Generates the macOS template tray icon (black + alpha): a clock face.
// Run: npx tsx scripts/make-tray-icon.mts
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

function png(size: number, alphaAt: (x: number, y: number) => number): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4
      raw[i + 3] = Math.round(255 * Math.max(0, Math.min(1, alphaAt(x, y))))
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function clock(size: number): Buffer {
  const s = size / 16
  const c = size / 2
  const stroke = 1.4 * s
  return png(size, (x, y) => {
    // 4x supersampling for smooth edges
    let a = 0
    for (let sy = 0; sy < 4; sy++)
      for (let sx = 0; sx < 4; sx++) {
        const px = x + (sx + 0.5) / 4
        const py = y + (sy + 0.5) / 4
        const ring = Math.abs(Math.hypot(px - c, py - c) - 6.3 * s) <= stroke / 2
        const minute = distToSegment(px, py, c, c, c, c - 4.2 * s) <= stroke / 2
        const hour = distToSegment(px, py, c, c, c + 3 * s, c) <= stroke / 2
        if (ring || minute || hour) a++
      }
    return a / 16
  })
}

const out = path.join(import.meta.dirname, '..', 'resources')
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'trayTemplate.png'), clock(16))
fs.writeFileSync(path.join(out, 'trayTemplate@2x.png'), clock(32))
console.log('wrote', out)
