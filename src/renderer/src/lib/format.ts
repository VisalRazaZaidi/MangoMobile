export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** index
  const precision = index === 0 ? 0 : value >= 100 ? 0 : decimals
  return `${value.toFixed(precision)} ${units[index]}`
}

export function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 10_000) return `${Math.round(count / 1000)}k`
  return count.toLocaleString()
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes} min ${seconds}s`
}

export function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return '—'
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  })
}

export function formatDateTime(ms: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function relativeDays(unixSeconds: number): string {
  if (!unixSeconds) return 'unknown'
  const days = Math.floor((Date.now() / 1000 - unixSeconds) / 86_400)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  if (days < 365) return `${Math.round(days / 30)} months ago`
  return `${(days / 365).toFixed(1)} years ago`
}

export function shortPath(path: string, maxLength = 72): string {
  if (path.length <= maxLength) return path
  const head = path.slice(0, Math.ceil(maxLength * 0.35))
  const tail = path.slice(-Math.ceil(maxLength * 0.55))
  return `${head}…${tail}`
}

export function percent(part: number, total: number): number {
  if (!total) return 0
  return Math.min(100, Math.max(0, (part / total) * 100))
}

export function bytesCompact(bytes: number): string {
  return formatBytes(bytes, 0).replace(' ', '')
}

const PALETTE = [
  '#f59e0b',
  '#5b8cff',
  '#35d39a',
  '#a06bff',
  '#ff6b9d',
  '#22b8cf',
  '#ff922b',
  '#74c0fc',
  '#b197fc',
  '#63e6be',
  '#ffa8a8',
  '#ffe066'
]

export function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length]
}

/** Stable colour per name so folders keep their colour between visits. */
export function colorForName(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return PALETTE[hash % PALETTE.length]
}
