import type { FileEntry, LargeFile, MediaItem, TreeChild, TreeView } from '@shared/types'

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'bmp', 'tiff', 'dng', 'raw'])
const VIDEO_EXT = new Set(['mp4', 'mkv', 'mov', 'avi', 'webm', '3gp', 'm4v', 'ts', 'flv', 'wmv'])
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'wav', 'flac', 'amr', 'wma'])
const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub', 'csv', 'md'])
const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'])
const APK_EXT = new Set(['apk', 'apks', 'xapk', 'aab'])

export function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

export function dirOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function kindOf(path: string): MediaItem['kind'] {
  const ext = extOf(path)
  if (IMAGE_EXT.has(ext)) return /screenshot/i.test(path) ? 'screenshot' : 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (DOC_EXT.has(ext)) return 'document'
  if (ARCHIVE_EXT.has(ext)) return 'archive'
  if (APK_EXT.has(ext)) return 'apk'
  return 'other'
}

/** Human-meaningful bucket derived from the path, mirroring how people think about their phone. */
export function groupOf(path: string): string {
  const lower = path.toLowerCase()
  if (lower.includes('/whatsapp') || lower.includes('com.whatsapp')) return 'WhatsApp'
  if (lower.includes('/telegram') || lower.includes('org.telegram')) return 'Telegram'
  if (lower.includes('screenshot')) return 'Screenshots'
  if (lower.includes('/dcim/camera') || lower.includes('/dcim/')) return 'Camera'
  if (lower.includes('/movies/')) return 'Movies'
  if (lower.includes('instagram') || lower.includes('com.instagram')) return 'Instagram'
  if (lower.includes('/music/')) return 'Music'
  if (lower.includes('/download')) return 'Downloads'
  if (lower.includes('/documents/')) return 'Documents'
  if (lower.includes('/android/media/')) {
    const match = /\/android\/media\/([^/]+)/.exec(lower)
    return match ? match[1] : 'App media'
  }
  if (lower.includes('/android/data/')) {
    const match = /\/android\/data\/([^/]+)/.exec(lower)
    return match ? match[1] : 'App data'
  }
  if (lower.includes('/pictures/')) return 'Pictures'
  const parts = path.split('/').filter(Boolean)
  return parts.length > 1 ? parts[1] : 'Other'
}

type DirAggregate = { bytes: number; count: number }

/**
 * In-memory index of one scanned volume.
 *
 * Directory sizes are accumulated once while files stream in, so opening the
 * treemap or any folder is O(children) instead of a re-walk. This is what keeps
 * the UI instant after the (single) device scan.
 */
export class StorageIndex {
  readonly files: FileEntry[]
  readonly dirs: Set<string>
  private readonly byPath = new Map<string, FileEntry>()
  private readonly dirAgg = new Map<string, DirAggregate>()
  private readonly filesByDir = new Map<string, FileEntry[]>()
  private totalBytesCache = 0
  private groupedByDir = false

  constructor(
    readonly root: string,
    files: FileEntry[],
    dirs: string[]
  ) {
    this.files = files
    this.dirs = new Set(dirs)
    this.dirs.add(root)
    for (const dir of this.dirs) if (!this.dirAgg.has(dir)) this.dirAgg.set(dir, { bytes: 0, count: 0 })
    for (const file of files) {
      this.byPath.set(file.path, file)
      this.totalBytesCache += file.size
      let parent = dirOf(file.path)
      while (parent.length >= root.length && parent.startsWith(root)) {
        const aggregate = this.dirAgg.get(parent)
        if (aggregate) {
          aggregate.bytes += file.size
          aggregate.count += 1
        } else {
          this.dirAgg.set(parent, { bytes: file.size, count: 1 })
        }
        if (parent === root) break
        parent = dirOf(parent)
      }
    }
  }

  static empty(root: string): StorageIndex {
    return new StorageIndex(root, [], [root])
  }

  get fileCount(): number {
    return this.files.length
  }

  get dirCount(): number {
    return this.dirs.size
  }

  get totalBytes(): number {
    return this.totalBytesCache
  }

  has(path: string): boolean {
    return this.byPath.has(path) || this.dirs.has(path)
  }

  get(path: string): FileEntry | undefined {
    return this.byPath.get(path)
  }

  bytesIn(path: string): number {
    return this.dirAgg.get(path)?.bytes ?? 0
  }

  countIn(path: string): number {
    return this.dirAgg.get(path)?.count ?? 0
  }

  /** Immediate child directories, largest first. */
  childDirs(path: string): string[] {
    const prefix = path === '/' ? '/' : `${path}/`
    const out: string[] = []
    for (const dir of this.dirs) {
      if (dir === path || !dir.startsWith(prefix)) continue
      if (dir.indexOf('/', prefix.length) !== -1) continue
      out.push(dir)
    }
    return out
  }

  private ensureGrouped(): void {
    if (this.groupedByDir) return
    this.groupedByDir = true
    for (const file of this.files) {
      const dir = dirOf(file.path)
      const list = this.filesByDir.get(dir)
      if (list) list.push(file)
      else this.filesByDir.set(dir, [file])
    }
  }

  filesIn(path: string): FileEntry[] {
    this.ensureGrouped()
    return this.filesByDir.get(path) ?? []
  }

  /**
   * Treemap/children view. `limit` caps the number of rendered children; the tail
   * is aggregated so the chart still accounts for every byte.
   */
  tree(path: string, limit = 60): TreeView {
    const target = this.dirs.has(path) ? path : this.root
    const total = this.bytesIn(target)
    const children: TreeChild[] = []

    for (const dir of this.childDirs(target)) {
      const size = this.bytesIn(dir)
      if (size === 0) continue
      children.push({
        name: baseName(dir),
        path: dir,
        kind: 'dir',
        size,
        fileCount: this.countIn(dir),
        share: total > 0 ? size / total : 0,
        childCount: undefined
      })
    }

    for (const file of this.filesIn(target)) {
      children.push({
        name: baseName(file.path),
        path: file.path,
        kind: 'file',
        size: file.size,
        fileCount: 1,
        share: total > 0 ? file.size / total : 0
      })
    }

    children.sort((a, b) => b.size - a.size)
    const visible = children.slice(0, limit)
    const otherBytes = children.slice(limit).reduce((sum, child) => sum + child.size, 0)

    return {
      path: target,
      totalBytes: total,
      fileCount: this.countIn(target),
      children: visible,
      otherBytes
    }
  }

  largeFiles(limit: number, minBytes = 0): LargeFile[] {
    return this.files
      .filter((file) => file.size >= minBytes)
      .sort((a, b) => b.size - a.size)
      .slice(0, limit)
      .map((file) => ({
        ...file,
        ext: extOf(file.path),
        dir: dirOf(file.path),
        group: groupOf(file.path)
      }))
  }

  /** Directories that contain no file at any depth. */
  emptyDirs(maxEntries = 500): string[] {
    const out: string[] = []
    for (const [dir, aggregate] of this.dirAgg) {
      if (dir === this.root) continue
      if (aggregate.count === 0) out.push(dir)
      if (out.length >= maxEntries) break
    }
    return out.sort()
  }

  /** Files matching a directory prefix, used by cleanup rules. */
  scanPrefix(prefix: string, predicate: (file: FileEntry) => boolean, limit = 20_000): FileEntry[] {
    const out: FileEntry[] = []
    const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`
    for (const file of this.files) {
      if (!file.path.startsWith(normalized)) continue
      if (predicate(file)) {
        out.push(file)
        if (out.length >= limit) break
      }
    }
    return out
  }

  allDirs(): string[] {
    return [...this.dirs]
  }

  /**
   * Returns a copy with files and folders removed. Rebuilding the aggregate is
   * cheaper (and safer) than mutating counters in place, and keeps the index
   * immutable for any view still holding a reference.
   */
  without(removedFiles: Set<string>, removedDirs: Set<string> = new Set()): StorageIndex {
    if (removedFiles.size === 0 && removedDirs.size === 0) return this
    const files = this.files.filter((file) => !removedFiles.has(file.path))
    // Folders are untouched unless they were removed explicitly: deleting a file
    // does not delete its parent, it just leaves it empty.
    const dirs = removedDirs.size === 0 ? [...this.dirs] : [...this.dirs].filter((dir) => !removedDirs.has(dir))
    return new StorageIndex(this.root, files, dirs)
  }

  toJSON(): { root: string; files: [string, number, number][]; dirs: string[] } {
    return {
      root: this.root,
      files: this.files.map((file) => [file.path, file.size, file.mtime]),
      dirs: [...this.dirs]
    }
  }

  static fromJSON(data: { root: string; files: [string, number, number][]; dirs: string[] }): StorageIndex {
    const files = data.files.map(([path, size, mtime]) => ({ path, size, mtime }))
    return new StorageIndex(data.root, files, data.dirs)
  }
}
