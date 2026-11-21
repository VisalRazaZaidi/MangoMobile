import type { DuplicateGroup, DuplicateProgress, DuplicateScanOptions, FileEntry } from '@shared/types'
import type { DeviceTransport } from '../adb/transport'
import type { StorageIndex } from './storage-index'
import { shPath } from '../adb/transport'

const HASH_BATCH = 8
const DEFAULT_BYTE_BUDGET = 4 * 1024 * 1024 * 1024

type HashedFile = { path: string; hash: string }

/**
 * Exact duplicate detection in three stages:
 *   1. group by exact size (free, from the index),
 *   2. hash candidate contents on the device (md5sum, batched),
 *   3. group by digest and compute wasted bytes.
 *
 * Hashing runs on the phone so the USB link only carries hashes, never file bodies.
 * A byte budget keeps a scan of a 128 GB phone bounded; anything not hashed is
 * reported as approximate rather than silently dropped.
 */
export async function findDuplicates(options: {
  transport: DeviceTransport
  index: StorageIndex
  settings: DuplicateScanOptions
  signal: AbortSignal
  onProgress: (progress: DuplicateProgress) => void
}): Promise<DuplicateGroup[]> {
  const { transport, index, settings, signal, onProgress } = options
  const minSize = Math.max(1, settings.minSizeBytes)

  const bySize = new Map<number, FileEntry[]>()
  for (const file of index.files) {
    if (file.size < minSize) continue
    const bucket = bySize.get(file.size)
    if (bucket) bucket.push(file)
    else bySize.set(file.size, [file])
  }

  const candidateGroups = [...bySize.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([size, files]) => ({ size, files }))
    .sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1))
    .slice(0, Math.max(1, settings.maxGroups))

  const candidateFiles = candidateGroups.reduce((sum, group) => sum + group.files.length, 0)
  onProgress({ phase: 'grouping', candidates: candidateFiles, hashed: 0, groups: candidateGroups.length })

  if (candidateGroups.length === 0) {
    onProgress({ phase: 'done', candidates: 0, hashed: 0, groups: 0 })
    return []
  }

  const hashable: FileEntry[] = []
  const overBudget: { size: number; files: FileEntry[] }[] = []
  let budget = DEFAULT_BYTE_BUDGET
  for (const group of candidateGroups) {
    const cost = group.size * group.files.length
    if (cost <= budget) {
      budget -= cost
      hashable.push(...group.files)
    } else {
      overBudget.push(group)
    }
  }

  const hashed: HashedFile[] = []
  for (let index_ = 0; index_ < hashable.length; index_ += HASH_BATCH) {
    if (signal.aborted) {
      onProgress({ phase: 'cancelled', candidates: candidateFiles, hashed: hashed.length, groups: 0 })
      return []
    }
    const batch = hashable.slice(index_, index_ + HASH_BATCH)
    const command = `md5sum ${batch.map((file) => shPath(file.path)).join(' ')} 2>/dev/null`
    const result = await transport.exec(command, { signal, timeoutMs: 900_000 })
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^([0-9a-f]{32})\s+(.+)$/.exec(line.trim())
      if (match) hashed.push({ hash: match[1], path: match[2] })
    }
    onProgress({
      phase: 'hashing',
      candidates: candidateFiles,
      hashed: hashed.length,
      groups: 0
    })
  }

  const sizeByPath = new Map(index.files.map((file) => [file.path, file.size]))
  const byDigest = new Map<string, FileEntry[]>()
  for (const entry of hashed) {
    const size = sizeByPath.get(entry.path)
    if (size === undefined) continue
    const key = `${size}:${entry.hash}`
    const list = byDigest.get(key)
    const file: FileEntry = { path: entry.path, size, mtime: index.get(entry.path)?.mtime ?? 0 }
    if (list) list.push(file)
    else byDigest.set(key, [file])
  }

  const groups: DuplicateGroup[] = []
  for (const [key, files] of byDigest) {
    if (files.length < 2) continue
    const size = files[0].size
    groups.push({
      id: key,
      hash: key.slice(key.indexOf(':') + 1),
      size,
      wastedBytes: size * (files.length - 1),
      files: [...files].sort((a, b) => b.mtime - a.mtime),
      approximate: false
    })
  }

  // Groups too large to hash within the budget are still surfaced, clearly marked.
  for (const group of overBudget) {
    const signature = group.files
      .map((file) => file.path.slice(file.path.lastIndexOf('/') + 1).toLowerCase())
      .sort()
      .join('|')
    groups.push({
      id: `size:${group.size}:${signature.slice(0, 60)}`,
      hash: `size-${group.size}`,
      size: group.size,
      wastedBytes: group.size * (group.files.length - 1),
      files: [...group.files].sort((a, b) => b.mtime - a.mtime),
      approximate: true
    })
  }

  groups.sort((a, b) => b.wastedBytes - a.wastedBytes)
  onProgress({ phase: 'done', candidates: candidateFiles, hashed: hashed.length, groups: groups.length })
  return groups
}
