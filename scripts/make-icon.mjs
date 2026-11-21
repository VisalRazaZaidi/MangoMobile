/**
 * Renders the MangoMobile app icon without any image dependencies.
 *
 *   node scripts/make-icon.mjs
 *
 * Produces build/icon.png (512x512) and build/icon.ico (multi-size, PNG frames),
 * both consumed by electron-builder.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const buildDir = join(here, '..', 'build')

const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v)
const mix = (a, b, t) => a + (b - a) * t
const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}
const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
]

const INK_TOP = rgb('#1c2436')
const INK_BOTTOM = rgb('#090c12')
const GLOW = rgb('#ff9a3c')
const MANGO_DEEP = rgb('#e2601a')
const MANGO_MID = rgb('#ff9d2b')
const MANGO_LIGHT = rgb('#ffd463')
const LEAF_DEEP = rgb('#2b8a4b')
const LEAF_LIGHT = rgb('#6fd486')
const STEM = rgb('#8a5a2b')

/**
 * Mango silhouette in 512-space, clockwise from the stem tip. The slight
 * concave shoulder below the tip gives it the recognisable mango curve instead
 * of a plain egg.
 */
const BODY_POINTS = [
  [346, 140],
  [388, 200],
  [406, 272],
  [404, 344],
  [380, 404],
  [334, 446],
  [276, 458],
  [214, 444],
  [166, 406],
  [144, 352],
  [140, 288],
  [150, 224],
  [176, 176],
  [220, 146],
  [268, 132],
  [306, 126],
  [334, 130]
]

/** Closed Catmull-Rom through the control points, with `perSegment` samples. */
function smoothPolygon(points, perSegment = 14) {
  const out = []
  const n = points.length
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n]
    const p1 = points[i]
    const p2 = points[(i + 1) % n]
    const p3 = points[(i + 2) % n]
    for (let s = 0; s < perSegment; s++) {
      const t = s / perSegment
      const t2 = t * t
      const t3 = t2 * t
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
      ])
    }
  }
  return out
}

const BODY_POLY = smoothPolygon(BODY_POINTS)

/** Scanline-fills a polygon (512-space) into a WxW coverage mask. */
function polygonMask(poly, W) {
  const mask = new Float32Array(W * W)
  const rows = Array.from({ length: W }, () => [])
  const n = poly.length
  const scale = W / 512
  for (let i = 0; i < n; i++) {
    const [x0, y0] = [poly[i][0] * scale, poly[i][1] * scale]
    const [x1, y1] = [poly[(i + 1) % n][0] * scale, poly[(i + 1) % n][1] * scale]
    if (y0 === y1) continue
    const yStart = Math.max(0, Math.ceil(Math.min(y0, y1) - 0.5))
    const yEnd = Math.min(W - 1, Math.floor(Math.max(y0, y1) - 0.5))
    const dir = y1 > y0 ? 1 : -1
    for (let y = yStart; y <= yEnd; y++) {
      const sy = y + 0.5
      const t = (sy - y0) / (y1 - y0)
      if (t < 0 || t > 1) continue
      rows[y].push({ x: x0 + (x1 - x0) * t, dir })
    }
  }
  for (let y = 0; y < W; y++) {
    const xs = rows[y].sort((a, b) => a.x - b.x)
    let winding = 0
    for (let i = 0; i < xs.length - 1; i++) {
      winding += xs[i].dir
      if (winding === 0) continue
      const from = Math.max(0, Math.ceil(xs[i].x - 0.5))
      const to = Math.min(W - 1, Math.floor(xs[i + 1].x - 0.5))
      for (let x = from; x <= to; x++) mask[y * W + x] = 1
    }
  }
  return mask
}

/** Implicit leaf mask with the outline defined by a tapered lens (512-space). */
function leafMask(W) {
  const mask = new Float32Array(W * W)
  const cx = 366
  const cy = 104
  const rot = -0.62
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const halfLen = 86
  const halfWidth = 30
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const px = (x + 0.5) * (512 / W)
      const py = (y + 0.5) * (512 / W)
      const dx = px - cx
      const dy = py - cy
      const u = (dx * cos + dy * sin) / halfLen
      const v = (-dx * sin + dy * cos) / halfWidth
      const t = Math.abs(u)
      if (t > 1) continue
      const half = Math.pow(1 - t * t, 0.68)
      if (Math.abs(v) <= half) mask[y * W + x] = 1
    }
  }
  return mask
}

/** Rounded stem between two points (512-space). */
function stemMask(W) {
  const mask = new Float32Array(W * W)
  const ax = 332
  const ay = 148
  const bx = 362
  const by = 118
  const radius = 5.5
  const minX = Math.max(0, Math.floor((Math.min(ax, bx) - radius) / (512 / W)))
  const maxX = Math.min(W - 1, Math.ceil((Math.max(ax, bx) + radius) / (512 / W)))
  const minY = Math.max(0, Math.floor((Math.min(ay, by) - radius) / (512 / W)))
  const maxY = Math.min(W - 1, Math.ceil((Math.max(ay, by) + radius) / (512 / W)))
  const vx = bx - ax
  const vy = by - ay
  const len2 = vx * vx + vy * vy
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = (x + 0.5) * (512 / W)
      const py = (y + 0.5) * (512 / W)
      const t = clamp(((px - ax) * vx + (py - ay) * vy) / len2)
      const dx = px - (ax + vx * t)
      const dy = py - (ay + vy * t)
      if (dx * dx + dy * dy <= radius * radius) mask[y * W + x] = 1
    }
  }
  return mask
}

/** Rounded tile with analytic anti-aliasing (returns coverage 0..1). */
function tileCoverage(px, py, s) {
  const margin = 14 * s
  const half = 256 * s - margin
  const radius = 112 * s
  const qx = Math.abs(px - 256 * s) - (half - radius)
  const qy = Math.abs(py - 256 * s) - (half - radius)
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
  return clamp(0.5 - d / s)
}

/** Coverage-preserving box downsample. */
function downsample(mask, W, size) {
  const ss = W / size
  const out = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0
      for (let sy = 0; sy < ss; sy++) {
        const row = (y * ss + sy) * W + x * ss
        for (let sx = 0; sx < ss; sx++) sum += mask[row + sx]
      }
      out[y * size + x] = sum / (ss * ss)
    }
  }
  return out
}

/** Normalized distance from the body centre, used for volume shading. */
function bodyDistance(px, py, s) {
  const dx = px - 262 * s
  const dy = py - 296 * s
  const u = dx / (146 * s)
  const v = dy / (172 * s)
  return Math.hypot(u, v)
}

function render(size) {
  const ss = size <= 64 ? 8 : 4
  const W = size * ss

  const body = downsample(polygonMask(BODY_POLY, W), W, size)
  const leaf = downsample(leafMask(W), W, size)
  const stem = downsample(stemMask(W), W, size)

  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Work in 512-space so all shape constants stay readable.
      const px = (x + 0.5) * (512 / size)
      const py = (y + 0.5) * (512 / size)
      const i = y * size + x

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      const paint = (cr, cg, cb, alpha) => {
        if (alpha <= 0) return
        const na = alpha + a * (1 - alpha)
        if (na <= 0) return
        r = (cr * alpha + r * a * (1 - alpha)) / na
        g = (cg * alpha + g * a * (1 - alpha)) / na
        b = (cb * alpha + b * a * (1 - alpha)) / na
        a = na
      }

      // Tile
      const tileA = tileCoverage(px, py, 1)
      if (tileA <= 0) {
        out[i * 4] = 0
        out[i * 4 + 1] = 0
        out[i * 4 + 2] = 0
        out[i * 4 + 3] = 0
        continue
      }
      const bgT = clamp((py - 14) / 484)
      paint(mix(INK_TOP[0], INK_BOTTOM[0], bgT), mix(INK_TOP[1], INK_BOTTOM[1], bgT), mix(INK_TOP[2], INK_BOTTOM[2], bgT), 1)

      // Warm halo behind the fruit
      const glowDist = Math.hypot(px - 250, py - 300) / 330
      paint(GLOW[0], GLOW[1], GLOW[2], Math.pow(clamp(1 - glowDist), 2.4) * 0.5)

      // Contact shadow under the fruit
      const shadow = Math.hypot((px - 268) / 160, (py - 452) / 22)
      paint(0, 0, 0, Math.pow(clamp(1 - shadow), 1.6) * 0.32)

      // Stem, then leaf, then body: the fruit hides the stem's base.
      if (stem[i] > 0) {
        const shade = 0.72 + 0.28 * smoothstep(380, 140, py)
        paint(STEM[0] * shade, STEM[1] * shade, STEM[2] * shade, stem[i])
      }

      if (leaf[i] > 0) {
        const u = ((px - 366) * Math.cos(-0.62) + (py - 104) * Math.sin(-0.62)) / 86
        const v = (-(px - 366) * Math.sin(-0.62) + (py - 104) * Math.cos(-0.62)) / 30
        const t = clamp((u + 1) / 2)
        let cr = mix(LEAF_LIGHT[0], LEAF_DEEP[0], 0.35 + 0.65 * t)
        let cg = mix(LEAF_LIGHT[1], LEAF_DEEP[1], 0.35 + 0.65 * t)
        let cb = mix(LEAF_LIGHT[2], LEAF_DEEP[2], 0.35 + 0.65 * t)
        const vein = smoothstep(0.1, 0.02, Math.abs(v))
        const shade = 1 - 0.2 * vein - 0.1 * smoothstep(0.7, 1.05, Math.abs(v))
        paint(cr * shade, cg * shade, cb * shade, leaf[i])
      }

      if (body[i] > 0) {
        const d = bodyDistance(px, py, 1)
        const lightT = clamp(((214 - px) * 0.62 + (232 - py) * 0.5) / 230 + 0.5)
        const warm = clamp(lightT * 1.12)
        let cr, cg, cb
        if (warm < 0.5) {
          const t = warm / 0.5
          cr = mix(MANGO_DEEP[0], MANGO_MID[0], t)
          cg = mix(MANGO_DEEP[1], MANGO_MID[1], t)
          cb = mix(MANGO_DEEP[2], MANGO_MID[2], t)
        } else {
          const t = (warm - 0.5) / 0.5
          cr = mix(MANGO_MID[0], MANGO_LIGHT[0], t)
          cg = mix(MANGO_MID[1], MANGO_LIGHT[1], t)
          cb = mix(MANGO_MID[2], MANGO_LIGHT[2], t)
        }

        // Volume falloff toward the silhouette edge.
        const volume = 1 - 0.34 * smoothstep(0.62, 1.02, d)
        cr *= volume
        cg *= volume
        cb *= volume

        // Green blush near the stem, like a ripening mango.
        const blush = smoothstep(0.25, 1, (296 - py) / 172) * 0.32
        cr = mix(cr, 126, blush)
        cg = mix(cg, 164, blush)
        cb = mix(cb, 80, blush)

        // Specular highlight on the upper-left shoulder.
        const hi = Math.hypot(px - 192, py - 216) / 84
        const shine = Math.pow(clamp(1 - hi), 2.1) * 0.55
        cr = mix(cr, 255, shine)
        cg = mix(cg, 247, shine)
        cb = mix(cb, 216, shine)

        // Faint reflected light along the lower-right rim.
        const rim = smoothstep(0.9, 0.99, d) * smoothstep(0.1, 0.7, (px - 300) / 120) * 0.16
        cr = mix(cr, 255, rim)
        cg = mix(cg, 190, rim)
        cb = mix(cb, 140, rim)

        paint(cr, cg, cb, body[i])
      }

      out[i * 4] = Math.round(clamp(r, 0, 255))
      out[i * 4 + 1] = Math.round(clamp(g, 0, 255))
      out[i * 4 + 2] = Math.round(clamp(b, 0, 255))
      out[i * 4 + 3] = Math.round(clamp(a) * 255)
    }
  }
  return out
}

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function encodeIco(frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  const entries = []
  let offset = 6 + frames.length * 16
  for (const { size, png } of frames) {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.png)])
}

// --- main -------------------------------------------------------------------

mkdirSync(buildDir, { recursive: true })

const png512 = encodePng(512, render(512))
writeFileSync(join(buildDir, 'icon.png'), png512)

const icoSizes = [256, 128, 64, 48, 32, 16]
const frames = icoSizes.map((size) => ({ size, png: encodePng(size, render(size)) }))
writeFileSync(join(buildDir, 'icon.ico'), encodeIco(frames))
writeFileSync(join(buildDir, 'icon-256.png'), frames[0].png)

console.log(`icon.png  ${(png512.length / 1024).toFixed(1)} KB`)
console.log(`icon.ico  ${(Buffer.concat(frames.map((f) => f.png)).length / 1024).toFixed(1)} KB (${icoSizes.join(', ')})`)
