// Generates the app icon (build/icon.png, 1024x1024): white clock on an orange rounded square.
// electron-builder turns it into .icns (macOS) and .ico (Windows).
// Run: node scripts/make-app-icon.mts
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

type RGBA = [number, number, number, number]

function png(size: number, colorAt: (x: number, y: number) => RGBA): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4
      const [r, g, b, a] = colorAt(x, y)
      raw[i] = r
      raw[i + 1] = g
      raw[i + 2] = b
      raw[i + 3] = Math.round(255 * a)
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
  ihdr[8] = 8
  ihdr[9] = 6
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

const SIZE = 1024
const BG: [number, number, number] = [194, 65, 12] // matches the app accent
const c = SIZE / 2
const margin = 100 // macOS icon grid: artwork inset from the canvas edge
const radius = 185
const stroke = 56

function inRoundedSquare(x: number, y: number): boolean {
  const lo = margin
  const hi = SIZE - margin
  if (x < lo || x > hi || y < lo || y > hi) return false
  const cx = Math.min(Math.max(x, lo + radius), hi - radius)
  const cy = Math.min(Math.max(y, lo + radius), hi - radius)
  return Math.hypot(x - cx, y - cy) <= radius
}

function inClock(x: number, y: number): boolean {
  const ring = Math.abs(Math.hypot(x - c, y - c) - 250) <= stroke / 2
  const minute = distToSegment(x, y, c, c, c, c - 170) <= stroke / 2
  const hour = distToSegment(x, y, c, c, c + 120, c) <= stroke / 2
  return ring || minute || hour
}

const icon = png(SIZE, (x, y) => {
  let bg = 0
  let fg = 0
  for (let sy = 0; sy < 3; sy++)
    for (let sx = 0; sx < 3; sx++) {
      const px = x + (sx + 0.5) / 3
      const py = y + (sy + 0.5) / 3
      if (inRoundedSquare(px, py)) {
        bg++
        if (inClock(px, py)) fg++
      }
    }
  if (bg === 0) return [0, 0, 0, 0]
  const f = fg / bg
  return [
    Math.round(BG[0] + (255 - BG[0]) * f),
    Math.round(BG[1] + (255 - BG[1]) * f),
    Math.round(BG[2] + (255 - BG[2]) * f),
    bg / 9
  ]
})

const out = path.join(import.meta.dirname, '..', 'build')
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'icon.png'), icon)
console.log('wrote', path.join(out, 'icon.png'))
