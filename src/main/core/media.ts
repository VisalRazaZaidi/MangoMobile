import type { MediaBucket, MediaItem } from '@shared/types'
import { type StorageIndex, extOf, groupOf, kindOf } from './storage-index'

const BUCKET_LABELS: Record<MediaItem['kind'], string> = {
  screenshot: 'Screenshots',
  video: 'Videos',
  image: 'Photos',
  audio: 'Audio',
  document: 'Documents',
  archive: 'Archives',
  apk: 'Installers',
  other: 'Other files'
}

const BUCKET_ORDER: MediaItem['kind'][] = ['screenshot', 'video', 'image', 'audio', 'document', 'archive', 'apk', 'other']

/**
 * Media review buckets, derived from the existing index so no extra device traffic
 * is needed. Items are sorted newest-first inside a bucket so "what did I just take"
 * is the first thing you see.
 */
export function buildMediaBuckets(index: StorageIndex, limitPerBucket = 400): MediaBucket[] {
  const buckets = new Map<MediaItem['kind'], MediaItem[]>()

  for (const file of index.files) {
    const kind = kindOf(file.path)
    const item: MediaItem = {
      ...file,
      kind,
      group: groupOf(file.path),
      ext: extOf(file.path)
    }
    const list = buckets.get(kind)
    if (list) list.push(item)
    else buckets.set(kind, [item])
  }

  const out: MediaBucket[] = []
  for (const kind of BUCKET_ORDER) {
    const items = buckets.get(kind)
    if (!items || items.length === 0) continue
    const sorted = [...items].sort((a, b) => b.size - a.size)
    out.push({
      kind,
      label: BUCKET_LABELS[kind],
      count: items.length,
      totalBytes: items.reduce((sum, item) => sum + item.size, 0),
      items: sorted.slice(0, limitPerBucket)
    })
  }
  return out
}
