import { reactive } from 'vue'
import type { FileEntry, FilePreview } from '@shared/types'

export const preview = reactive({ file: null as FileEntry | null, result: null as FilePreview | null, loading: false, error: '' })
let requestId = 0
export function closePreview(): void {
  requestId++
  preview.file = null
  preview.result = null
  preview.loading = false
}
export async function openPreview(file: FileEntry): Promise<void> {
  const id = ++requestId
  preview.file = { path: file.path, size: file.size, mtime: file.mtime, isDirectory: file.isDirectory }
  preview.result = null
  preview.error = ''
  preview.loading = true
  try {
    const result = await window.api.preview.load(file.path)
    if (id === requestId) preview.result = result
  } catch (error) {
    if (id === requestId) preview.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (id === requestId) preview.loading = false
  }
}
