<script setup lang="ts">
import { openPreview } from '@/preview'
import { computed, onMounted, ref } from 'vue'
import { loadMedia, refreshHistory, scan, state, toast } from '@/store'
import { formatBytes, formatDate, relativeDays, shortPath } from '@/lib/format'
import Icon from '@/components/Icon.vue'
import EmptyState from '@/components/EmptyState.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import type { MediaItem } from '@shared/types'

const activeKind = ref<'all' | MediaItem['kind']>('all')
const search = ref('')
const selection = ref<string[]>([])
const showConfirm = ref(false)
const busy = ref(false)
const moveToTrash = ref(true)

const kindIcons: Record<MediaItem['kind'], string> = {
  image: 'image',
  screenshot: 'image',
  video: 'files',
  audio: 'layers',
  document: 'files',
  archive: 'layers',
  apk: 'apps',
  other: 'files'
}

onMounted(async () => {
  moveToTrash.value = state.settings?.moveToTrash ?? true
  if (state.summary && state.mediaBuckets.length === 0) await loadMedia()
})

const totalBytes = computed(() => state.mediaBuckets.reduce((sum, bucket) => sum + bucket.totalBytes, 0))
const totalCount = computed(() => state.mediaBuckets.reduce((sum, bucket) => sum + bucket.count, 0))

const activeBucket = computed(() => state.mediaBuckets.find((bucket) => bucket.kind === activeKind.value) ?? null)

const visible = computed(() => {
  const base = activeKind.value === 'all' ? state.mediaBuckets.flatMap((bucket) => bucket.items) : activeBucket.value?.items ?? []
  const query = search.value.trim().toLowerCase()
  const matched = query ? base.filter((item) => item.path.toLowerCase().includes(query) || item.group.toLowerCase().includes(query)) : base
  return [...matched].sort((a, b) => b.size - a.size).slice(0, 600)
})

const selectedItems = computed(() => {
  const map = new Map<string, MediaItem>()
  for (const bucket of state.mediaBuckets) for (const item of bucket.items) map.set(item.path, item)
  return selection.value.map((path) => map.get(path)).filter((item): item is MediaItem => Boolean(item))
})
const selectedBytes = computed(() => selectedItems.value.reduce((sum, item) => sum + item.size, 0))

function toggle(path: string): void {
  const index = selection.value.indexOf(path)
  if (index >= 0) selection.value.splice(index, 1)
  else selection.value.push(path)
}

function selectVisible(): void {
  selection.value = visible.value.slice(0, 500).map((item) => item.path)
}

function chooseKind(kind: 'all' | MediaItem['kind']): void {
  activeKind.value = kind
  selection.value = []
}

function folderLabel(path: string): string {
  const dir = path.slice(0, path.lastIndexOf('/')).replace(/^\/sdcard/, '')
  return dir || '/'
}

async function remove(): Promise<void> {
  busy.value = true
  try {
    const result = await window.api.cleanup.execute(
      selectedItems.value.map((item) => ({ path: item.path, size: item.size, mtime: item.mtime })),
      ['manual.media'],
      moveToTrash.value
    )
    toast(
      result.failedCount === 0 ? 'ok' : 'warn',
      result.failedCount === 0 ? 'Media cleaned' : 'Finished with issues',
      `${formatBytes(result.freedBytes)} recovered from ${result.deletedCount} file(s).`
    )
    selection.value = []
    showConfirm.value = false
    await Promise.all([loadMedia(), refreshHistory()])
  } catch (error) {
    toast('error', 'Could not remove media', error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page-head">
    <div>
      <h2 class="page-title">Media</h2>
      <p class="page-sub">Browse photos, videos, audio and documents. Click a filename to preview it.</p>
    </div>
    <button class="btn" :disabled="!state.summary" @click="loadMedia"><Icon name="refresh" :size="15" /> Refresh</button>
  </div>

  <div v-if="!state.summary" class="card">
    <EmptyState
      icon="image"
      title="No index yet"
      message="Run one scan and the media library is grouped automatically, no thumbnails are downloaded over the cable."
      action-label="Scan storage"
      @action="scan"
    />
  </div>

  <template v-else>
    <div class="grid cols-4">
      <button
        class="kpi"
        style="text-align: left; cursor: pointer"
        :style="{ borderColor: activeKind === 'all' ? 'var(--media-selection-edge)' : undefined }"
        @click="chooseKind('all')"
      >
        <div class="kpi-label">Everything</div>
        <div class="kpi-value">{{ formatBytes(totalBytes) }}</div>
        <div class="kpi-note">{{ totalCount.toLocaleString() }} files in the index</div>
      </button>
      <button
        v-for="bucket in state.mediaBuckets.slice(0, 3)"
        :key="bucket.kind"
        class="kpi"
        style="text-align: left; cursor: pointer"
        :style="{ borderColor: activeKind === bucket.kind ? 'var(--media-selection-edge)' : undefined }"
        @click="chooseKind(bucket.kind)"
      >
        <div class="kpi-label">
          <Icon :name="kindIcons[bucket.kind]" :size="13" style="vertical-align: -2px" /> {{ bucket.label }}
        </div>
        <div class="kpi-value">{{ formatBytes(bucket.totalBytes) }}</div>
        <div class="kpi-note">{{ bucket.count.toLocaleString() }} files</div>
      </button>
    </div>

    <div class="card tight">
      <div class="row wrap" style="gap: 12px">
        <div class="pill-toggle" style="flex-wrap: wrap">
          <button :class="{ active: activeKind === 'all' }" @click="chooseKind('all')">All</button>
          <button
            v-for="bucket in state.mediaBuckets"
            :key="bucket.kind"
            :class="{ active: activeKind === bucket.kind }"
            @click="chooseKind(bucket.kind)"
          >
            {{ bucket.label }} <span class="faint">{{ bucket.count }}</span>
          </button>
        </div>

        <div class="row" style="gap: 8px; flex: 1; min-width: 200px">
          <Icon name="search" :size="15" class="faint" />
          <input
            v-model="search"
            placeholder="Filter by name or folder…"
            style="flex: 1; background: var(--panel-2); border: 1px solid var(--border); border-radius: 9px; padding: 7px 10px; color: var(--text); font-size: 13px; outline: none"
          />
        </div>

        <div class="right row" style="gap: 8px">
          <span class="muted" style="font-size: 12px">
            {{ visible.length }} of {{ activeKind === 'all' ? totalCount.toLocaleString() : (activeBucket?.count ?? 0).toLocaleString() }}
          </span>
          <button class="btn btn-sm" @click="selectVisible">Select shown</button>
          <button class="btn btn-sm" @click="selection = []">Clear</button>
          <button class="btn btn-sm btn-danger" :disabled="!selection.length" @click="showConfirm = true">
            Remove {{ selection.length || '' }} · {{ formatBytes(selectedBytes) }}
          </button>
        </div>
      </div>
      <div v-if="activeBucket" class="faint" style="font-size: 11.5px; margin-top: 8px">
        Showing the largest {{ activeBucket.items.length }} of {{ activeBucket.count.toLocaleString() }} items in this bucket.
      </div>
    </div>

    <div class="card tight" style="padding: 0">
      <div class="scroll-area" style="max-height: calc(100vh - 420px)">
        <table class="table">
          <thead>
            <tr>
              <th style="width: 34px"></th>
              <th>File</th>
              <th>Kind</th>
              <th>Folder</th>
              <th class="num">Size</th>
              <th class="num">Modified</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in visible" :key="item.path">
              <td>
                <input class="checkbox" type="checkbox" :checked="selection.includes(item.path)" @change="toggle(item.path)" />
              </td>
              <td class="path" :title="item.path"><button class="file-link" @click="openPreview(item)">{{ item.path.split('/').pop() }}</button></td>
              <td class="faint">
                <span class="row" style="gap: 6px; white-space: nowrap">
                  <Icon :name="kindIcons[item.kind]" :size="14" /> {{ item.group }}
                </span>
              </td>
              <td class="mono faint" :title="item.path">{{ folderLabel(item.path) }}</td>
              <td class="num" style="color: var(--text); font-weight: 600">{{ formatBytes(item.size) }}</td>
              <td class="num faint" :title="formatDate(item.mtime)">{{ relativeDays(item.mtime) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="!visible.length" class="empty">
          <h4>Nothing in this bucket</h4>
          <p>Pick another kind, clear the filter, or scan again after adding new media.</p>
        </div>
      </div>
    </div>
  </template>

  <ConfirmDialog
    :open="showConfirm"
    :danger="!moveToTrash"
    :busy="busy"
    title="Remove the selected media?"
    :confirm-label="moveToTrash ? 'Move to recycle bin' : 'Delete permanently'"
    @cancel="showConfirm = false"
    @confirm="remove"
  >
    <div class="info-box">
      {{ selection.length }} file(s), {{ formatBytes(selectedBytes) }}.
    </div>
    <label class="row" style="gap: 8px; cursor: pointer; font-size: 12.5px; color: var(--text-dim)">
      <input v-model="moveToTrash" class="checkbox" type="checkbox" />
      Move to the recycle bin (restorable for {{ state.settings?.trashRetentionDays ?? 7 }} days)
    </label>
    <div class="stack" style="gap: 3px; max-height: 180px; overflow: auto">
      <div v-for="path in selection.slice(0, 30)" :key="path" class="mono faint">{{ shortPath(path, 88) }}</div>
      <div v-if="selection.length > 30" class="faint">…and {{ selection.length - 30 }} more</div>
    </div>
  </ConfirmDialog>
</template>
