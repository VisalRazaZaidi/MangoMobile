import { createHash } from 'node:crypto'

export type VNode = {
  path: string
  kind: 'dir' | 'file'
  size: number
  /** Unix seconds */
  mtime: number
  /** Stable identity used to synthesise content hashes for duplicate detection */
  contentKey?: string
  /** Directory listing permission, emulating scoped-storage restrictions */
  readable?: boolean
}

export type VirtualFs = {
  nodes: Map<string, VNode>
  /** Volume accounting shown by `df` */
  volume: { mount: string; totalBytes: number; usedBytes: number }
  apps: { packageName: string; label: string; codeBytes: number; dataBytes: number; cacheBytes: number; system: boolean }[]
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MB = 1024 * 1024
const GB = 1024 * MB
const DAY = 86_400

/** Deterministic md5 for a synthetic file body, shared by every duplicate copy. */
export function contentDigest(contentKey: string, partial = false): string {
  return createHash('md5').update(partial ? `${contentKey}:head` : contentKey).digest('hex')
}

type Spec = {
  dir: string
  count: number
  name: (i: number, rand: () => number) => string
  size: (rand: () => number) => number
  /** Age window in days, newest first */
  ageDays: [number, number]
  sizeRound?: number
}

/**
 * Builds a fixture that looks like a real 128 GB phone: camera roll, screenshots,
 * WhatsApp media, downloads full of installers, app caches, and duplicate copies.
 * Sizes are deliberately realistic so the treemap and "largest files" views are meaningful.
 */
export function buildVirtualFs(options: { androidDataReadable?: boolean; seed?: number } = {}): VirtualFs {
  const rand = mulberry32(options.seed ?? 20261115)
  const now = Math.floor(Date.now() / 1000)
  const nodes = new Map<string, VNode>()

  const ensureDir = (path: string, mtime = now - 30 * DAY) => {
    if (nodes.has(path)) return
    const parts = path.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current += `/${part}`
      if (!nodes.has(current)) {
        nodes.set(current, { path: current, kind: 'dir', size: 4096, mtime })
      }
    }
  }

  const addFile = (path: string, size: number, ageDays: number, contentKey?: string, readable?: boolean) => {
    const parent = path.slice(0, path.lastIndexOf('/'))
    ensureDir(parent)
    nodes.set(path, {
      path,
      kind: 'file',
      size,
      mtime: now - Math.floor(ageDays * DAY),
      contentKey: contentKey ?? `auto:${path}`,
      readable
    })
  }

  const specs: Spec[] = [
    {
      dir: '/sdcard/DCIM/Camera',
      count: 214,
      name: (i) => `IMG_2026${String(1 + (i % 12)).padStart(2, '0')}${String(1 + (i % 28)).padStart(2, '0')}_${String(100000 + i)}.jpg`,
      size: (r) => Math.round((2.1 + r() * 4.2) * MB),
      ageDays: [1, 900]
    },
    {
      dir: '/sdcard/DCIM/Camera',
      count: 26,
      name: (i) => `VID_2026${String(1 + (i % 12)).padStart(2, '0')}1${i % 10}_${String(200000 + i)}.mp4`,
      size: (r) => Math.round((48 + r() * 520) * MB),
      ageDays: [5, 700]
    },
    {
      dir: '/sdcard/DCIM/Screenshots',
      count: 148,
      name: (i) => `Screenshot_2026${String(1 + (i % 12)).padStart(2, '0')}${String(1 + (i % 28)).padStart(2, '0')}-${String(120000 + i)}.png`,
      size: (r) => Math.round((0.4 + r() * 2.6) * MB),
      ageDays: [20, 1100]
    },
    {
      dir: '/sdcard/DCIM/.thumbnails',
      count: 420,
      name: (i) => `thumb_${String(900000 + i)}.jpg`,
      size: (r) => Math.round((8 + r() * 90) * 1024),
      ageDays: [30, 900]
    },
    {
      dir: '/sdcard/Pictures/Screenshots',
      count: 64,
      name: (i) => `Screenshot_2025${String(1 + (i % 12)).padStart(2, '0')}${String(1 + (i % 28)).padStart(2, '0')}-${String(300000 + i)}.png`,
      size: (r) => Math.round((0.6 + r() * 1.8) * MB),
      ageDays: [200, 900]
    },
    {
      dir: '/sdcard/Pictures/Instagram',
      count: 92,
      name: (i) => `instagram_${String(400000 + i)}.jpg`,
      size: (r) => Math.round((180 + r() * 900) * 1024),
      ageDays: [60, 800]
    },
    {
      dir: '/sdcard/Movies',
      count: 7,
      name: (i) => `movie_${i + 1}.mkv`,
      size: (r) => Math.round((680 + r() * 2100) * MB),
      ageDays: [120, 900]
    },
    {
      dir: '/sdcard/Music',
      count: 58,
      name: (i) => `track_${String(7000 + i)}.m4a`,
      size: (r) => Math.round((3.2 + r() * 8.4) * MB),
      ageDays: [40, 1200]
    },
    {
      dir: '/sdcard/Download',
      count: 22,
      name: (i) => `app_installer_${i + 1}.apk`,
      size: (r) => Math.round((18 + r() * 90) * MB),
      ageDays: [12, 400]
    },
    {
      dir: '/sdcard/Download',
      count: 9,
      name: (i) => `archive_${i + 1}.zip`,
      size: (r) => Math.round((40 + r() * 700) * MB),
      ageDays: [30, 620]
    },
    {
      dir: '/sdcard/Download',
      count: 12,
      name: (i) => `document_${i + 1}.pdf`,
      size: (r) => Math.round((0.2 + r() * 6) * MB),
      ageDays: [4, 500]
    },
    {
      dir: '/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images',
      count: 186,
      name: (i) => `IMG-2026${String(1 + (i % 12)).padStart(2, '0')}${String(1 + (i % 28)).padStart(2, '0')}-WA${String(1000 + i)}.jpg`,
      size: (r) => Math.round((90 + r() * 480) * 1024),
      ageDays: [3, 700]
    },
    {
      dir: '/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Video',
      count: 24,
      name: (i) => `VID-20260${String(1 + (i % 9))}${String(1 + (i % 28)).padStart(2, '0')}-WA${String(2000 + i)}.mp4`,
      size: (r) => Math.round((6 + r() * 60) * MB),
      ageDays: [4, 600]
    },
    {
      dir: '/sdcard/Android/media/com.whatsapp/WhatsApp/Media/.Statuses',
      count: 38,
      name: (i) => `status_${String(5000 + i)}.mp4`,
      size: (r) => Math.round((1 + r() * 14) * MB),
      ageDays: [1, 30]
    },
    {
      dir: '/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Voice Notes',
      count: 44,
      name: (i) => `PTT-2026${String(300 + i)}.opus`,
      size: (r) => Math.round((60 + r() * 900) * 1024),
      ageDays: [10, 500]
    },
    {
      dir: '/sdcard/Telegram/Telegram Files',
      count: 31,
      name: (i) => `document_${i + 1}.pdf`,
      size: (r) => Math.round((0.3 + r() * 40) * MB),
      ageDays: [15, 600]
    },
    {
      dir: '/sdcard/Documents',
      count: 27,
      name: (i) => `report_${String(2020 + (i % 7))}_${i + 1}.docx`,
      size: (r) => Math.round((30 + r() * 2400) * 1024),
      ageDays: [10, 1500]
    },
    {
      dir: '/sdcard/.thumbnails',
      count: 210,
      name: (i) => `thumbdata_${i}.bin`,
      size: (r) => Math.round((20 + r() * 200) * 1024),
      ageDays: [40, 800]
    },
    {
      dir: '/sdcard/.Trash',
      count: 16,
      name: (i) => `trashed_${i + 1}.jpg`,
      size: (r) => Math.round((0.5 + r() * 8) * MB),
      ageDays: [5, 120]
    },
    {
      dir: '/sdcard/boardcamp/logs',
      count: 12,
      name: (i) => `app-2026-${String(i + 1).padStart(2, '0')}.log`,
      size: (r) => Math.round((200 + r() * 3000) * 1024),
      ageDays: [20, 300]
    }
  ]

  for (const spec of specs) {
    ensureDir(spec.dir)
    for (let i = 0; i < spec.count; i += 1) {
      const age = spec.ageDays[0] + rand() * (spec.ageDays[1] - spec.ageDays[0])
      addFile(`${spec.dir}/${spec.name(i, rand)}`, spec.size(rand), age)
    }
  }

  // Loose junk in the shared root and Download: partial downloads, temp files, logs.
  const junk = ['update.apk.part', 'video.tmp', 'export.tmp', 'crash.log', 'debug.log', 'installer.zip.crdownload'.slice(0, 20)]
  junk.forEach((name, index) => addFile(`/sdcard/Download/${name}`, Math.round((5 + rand() * 400) * MB), 12 + index * 30))
  addFile('/sdcard/.DS_Store', 6 * 1024, 90)
  addFile('/sdcard/download.log', Math.round(2.4 * MB), 60)

  // Empty directories that a cleanup pass should reclaim.
  ensureDir('/sdcard/empty_folder')
  ensureDir('/sdcard/Download/empty_cache')
  ensureDir('/sdcard/Movies/.nomedia_cache')

  // Exact duplicates: the same content copied by chat apps and repeated downloads.
  const duplicateTemplate: [string, number][] = [
    ['IMG-20260102-WA0001.jpg', Math.round(2.4 * MB)],
    ['IMG-20260103-WA0007.jpg', Math.round(1.8 * MB)],
    ['bills_january.pdf', Math.round(640 * 1024)],
    ['promo_video.mp4', Math.round(28 * MB)],
    ['ringtone.mp3', Math.round(5.6 * MB)],
    ['screenshot_backup.png', Math.round(1.2 * MB)]
  ]
  duplicateTemplate.forEach(([name, size], groupIndex) => {
    const key = `dupe:${groupIndex}`
    addFile(`/sdcard/Download/${name}`, size, 120 + groupIndex * 20, key)
    addFile(`/sdcard/DCIM/Camera/${name}`, size, 118 + groupIndex * 20, key)
    addFile(`/sdcard/WhatsApp/Media/WhatsApp Images/${name}`, size, 110 + groupIndex * 20, key)
    if (groupIndex < 3) {
      addFile(`/sdcard/Telegram/Telegram Files/${name}`, size, 100 + groupIndex * 20, key)
    }
  })

  // Scoped storage: /sdcard/Android/data is normally closed to the shell user.
  const readable = options.androidDataReadable ?? false
  const cacheSpecs: [string, number, number][] = [
    ['/sdcard/Android/data/com.whatsapp/cache', 62, 260],
    ['/sdcard/Android/data/com.android.chrome/cache/Cache_Data', 118, 900],
    ['/sdcard/Android/data/com.spotify.music/files/cache', 74, 300],
    ['/sdcard/Android/data/com.instagram.android/cache/image_cache', 96, 700],
    ['/sdcard/Android/data/com.google.android.youtube/cache/exo', 44, 420],
    ['/sdcard/Android/data/com.android.vending/cache', 51, 380]
  ]
  for (const [dir, count, peakMb] of cacheSpecs) {
    ensureDir(dir)
    for (let i = 0; i < count; i += 1) {
      addFile(`${dir}/${i.toString(16).padStart(16, '0')}.0`, Math.round((0.05 + rand() * (peakMb / 8)) * MB), 3 + rand() * 120, undefined, readable)
    }
  }

  const nodesArray = [...nodes.values()]
  for (const node of nodesArray) {
    if (node.path.includes('/Android/data/') || node.path.includes('/Android/obb/')) {
      node.readable = readable
    }
  }
  const dataDir = nodes.get('/sdcard/Android/data')
  if (dataDir) dataDir.readable = readable

  // Volume accounting: sum the fixture, then add the system-reserved portion.
  let used = 0
  for (const node of nodes.values()) if (node.kind === 'file') used += node.size
  const totalBytes = 128 * GB
  const usedBytes = Math.min(totalBytes - 4 * GB, used + 41 * GB)

  const apps = [
    { packageName: 'com.whatsapp', label: 'WhatsApp', codeBytes: 210 * MB, dataBytes: 4.8 * GB, cacheBytes: 1.6 * GB, system: false },
    { packageName: 'com.instagram.android', label: 'Instagram', codeBytes: 320 * MB, dataBytes: 2.2 * GB, cacheBytes: 1.1 * GB, system: false },
    { packageName: 'com.android.chrome', label: 'Chrome', codeBytes: 480 * MB, dataBytes: 1.4 * GB, cacheBytes: 820 * MB, system: false },
    { packageName: 'com.spotify.music', label: 'Spotify', codeBytes: 240 * MB, dataBytes: 3.6 * GB, cacheBytes: 640 * MB, system: false },
    { packageName: 'com.google.android.youtube', label: 'YouTube', codeBytes: 300 * MB, dataBytes: 980 * MB, cacheBytes: 520 * MB, system: false },
    { packageName: 'org.telegram.messenger', label: 'Telegram', codeBytes: 280 * MB, dataBytes: 5.4 * GB, cacheBytes: 1.9 * GB, system: false },
    { packageName: 'com.android.vending', label: 'Google Play Store', codeBytes: 120 * MB, dataBytes: 420 * MB, cacheBytes: 260 * MB, system: true },
    { packageName: 'com.google.android.gms', label: 'Google Play services', codeBytes: 640 * MB, dataBytes: 1.1 * GB, cacheBytes: 310 * MB, system: true },
    { packageName: 'com.android.settings', label: 'Settings', codeBytes: 84 * MB, dataBytes: 60 * MB, cacheBytes: 12 * MB, system: true }
  ]

  return { nodes, volume: { mount: '/storage/emulated/0', totalBytes, usedBytes }, apps }
}

export function normalizePath(path: string): string {
  let value = path.replace(/\/+/g, '/')
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1)
  return value
}

/** `/sdcard` and `/storage/emulated/0` are the same volume on a real device. */
export function canonicalPath(path: string): string {
  const normalized = normalizePath(path)
  if (normalized === '/storage/emulated/0') return '/sdcard'
  if (normalized.startsWith('/storage/emulated/0/')) return `/sdcard/${normalized.slice('/storage/emulated/0/'.length)}`
  if (normalized.startsWith('/storage/self/primary')) {
    return normalized === '/storage/self/primary' ? '/sdcard' : `/sdcard/${normalized.slice('/storage/self/primary/'.length)}`
  }
  return normalized
}
