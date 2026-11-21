<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { preview, closePreview } from '@/preview'
import { state } from '@/store'
import { formatBytes, formatDate } from '@/lib/format'
import Icon from './Icon.vue'
const unsupported = ref(false)
const name = computed(() => preview.file?.path.split('/').pop() ?? '')
const videoPoster = computed(() => {
  void state.settings?.theme
  const theme = getComputedStyle(document.documentElement)
  const background = theme.getPropertyValue('--panel-2').trim()
  const ink = theme.getPropertyValue('--text-dim').trim()
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="${background}"/><path d="M142 65 L142 115 L184 90 Z" fill="${ink}"/></svg>`)}`
})
watch(() => preview.result, () => { unsupported.value = false })
watch(() => state.device?.serial, closePreview)
watch(() => state.summary, closePreview)
function key(event: KeyboardEvent): void { if (event.key === 'Escape') closePreview() }
onMounted(() => window.addEventListener('keydown', key))
onUnmounted(() => window.removeEventListener('keydown', key))
</script>

<template>
  <aside v-if="preview.file" class="file-preview" aria-label="File preview">
    <div class="row preview-header">
      <strong>File preview</strong>
      <button class="btn btn-ghost btn-sm right" aria-label="Close preview" @click="closePreview"><Icon name="close" :size="18" /></button>
    </div>
    <div class="preview-body">
      <div v-if="preview.loading" class="preview-placeholder" role="status"><Icon name="refresh" class="spin" :size="28" />Loading from phone…</div>
      <div v-else-if="preview.error" class="warn-box" role="alert">{{ preview.error }}</div>
      <template v-else-if="preview.result">
        <div v-if="unsupported" class="info-box">This format or codec cannot be displayed. File details are shown below.</div>
        <img v-else-if="preview.result.kind === 'image'" :src="preview.result.url" :alt="name" class="preview-image" @error="unsupported = true" />
        <video v-else-if="preview.result.kind === 'video'" :key="preview.result.url" :src="preview.result.url" :poster="videoPoster" controls preload="metadata" class="preview-video" @error="unsupported = true" />
        <audio v-else-if="preview.result.kind === 'audio'" :key="preview.result.url" :src="preview.result.url" controls preload="metadata" @error="unsupported = true" />
        <pre v-else-if="preview.result.kind === 'text'" class="preview-text">{{ preview.result.text }}</pre>
        <div v-else class="preview-placeholder"><Icon name="files" :size="64" />{{ preview.result.message || 'Content preview is unavailable for this file type.' }}</div>
      </template>
      <h3 class="preview-name">{{ name }}</h3>
      <span v-if="state.device?.simulated" class="badge">Demo content</span>
      <dl class="preview-details">
        <dt>Type</dt><dd>{{ name.includes('.') ? name.split('.').pop()?.toUpperCase() + ' file' : 'File' }}</dd>
        <dt>Size</dt><dd>{{ formatBytes(preview.file.size) }}</dd>
        <dt>Modified</dt><dd>{{ preview.file.mtime ? formatDate(preview.file.mtime) : 'Unknown' }}</dd>
        <dt>Location</dt><dd>{{ preview.file.path }}</dd>
      </dl>
      <p class="faint">Click another filename to preview it. Checkboxes select files for cleanup.</p>
    </div>
  </aside>
</template>

<style scoped>
.file-preview { position: fixed; top: 64px; bottom: 0; right: 0; width: min(420px, 45vw); background: var(--panel); border-left: 1px solid var(--border); z-index: 30; box-shadow: var(--shadow); display: flex; flex-direction: column; }
.preview-header { padding: 16px 20px; border-bottom: 1px solid var(--border); flex: none; }
.preview-body { overflow: auto; padding: 20px; display: flex; flex-direction: column; gap: 20px; }
.preview-image, .preview-video { width: 100%; max-height: 340px; object-fit: contain; background: var(--bg-soft); border-radius: 10px; }
audio { width: 100%; }
.preview-placeholder { min-height: 180px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; color: var(--text-dim); text-align: center; }
.preview-name { margin: 0; font-size: 17px; overflow-wrap: anywhere; }
.preview-details { margin: 0; display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 16px; font-size: 12px; }
dt { color: var(--text-faint); } dd { margin: 0; overflow-wrap: anywhere; }
.preview-text { max-height: 360px; min-height: 140px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; background: var(--bg-soft); padding: 12px; border-radius: 10px; }
</style>
