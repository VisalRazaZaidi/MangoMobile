import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FileEntry, FilePreview } from '../../shared/types'
import type { DeviceTransport } from '../adb/transport'
import { extOf } from './storage-index'

export function validatePreviewPath(path: string, root: string): void {
  if (typeof path !== 'string' || !path.startsWith(`${root.replace(/\/$/, '')}/`) ||
      /[\0\r\n]/.test(path) || path.split('/').slice(1).some(p => !p || p === '.' || p === '..')) {
    throw new Error('Preview path is outside the scanned storage or is invalid')
  }
}

export function previewKind(path: string): FilePreview['kind'] {
  const ext = extOf(path)
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) return 'image'
  if (['mp4', 'webm', 'mov', 'm4v', 'mkv', '3gp'].includes(ext)) return 'video'
  if (['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac'].includes(ext)) return 'audio'
  if (['txt', 'log', 'json', 'csv', 'md', 'yaml', 'yml', 'xml', 'ini'].includes(ext)) return 'text'
  return 'details'
}

/** Only opaque tokens expose temporary copies; device paths never become local URLs. */
export class PreviewCache {
  private readonly dir = mkdtempSync(join(tmpdir(), 'mangomobile-preview-'))
  private readonly files = new Map<string, string>()

  resolve(token: string): string | undefined { return this.files.get(token) }
  dispose(): void { rmSync(this.dir, { recursive: true, force: true }) }

  async load(transport: DeviceTransport, file: FileEntry): Promise<FilePreview> {
    const kind = file.isDirectory ? 'details' : previewKind(file.path)
    const result: FilePreview = { ...file, kind }
    if (kind === 'details') return result
    const limit = kind === 'text' ? 1024 * 1024 : 512 * 1024 * 1024
    if (file.size > limit) return { ...result, kind: 'details', message: `Preview is limited to ${kind === 'text' ? '1 MB for text' : '512 MB for media'}.` }
    const token = randomUUID()
    const local = join(this.dir, `${token}.${extOf(file.path)}`)
    try {
      await transport.copyFile(file.path, local)
      if (statSync(local).size > limit) throw new Error('File grew beyond the preview size limit')
      if (kind === 'text') {
        const text = readFileSync(local, 'utf8')
        rmSync(local, { force: true })
        return { ...result, text }
      }
      this.files.set(token, local)
      // Bound the cache while retaining the current and recent selections.
      while (this.files.size > 3) {
        const [oldToken, oldPath] = this.files.entries().next().value!
        this.files.delete(oldToken)
        rmSync(oldPath, { force: true })
      }
      return { ...result, url: `mango-preview://cache/${token}` }
    } catch (error) {
      rmSync(local, { force: true })
      throw error
    }
  }
}
