<script setup lang="ts">
import { openPreview } from '@/preview'
import { computed, onMounted, ref } from 'vue'
import { loadLargeFiles, scan, state, toast } from '@/store'
import { formatBytes, formatDate, relativeDays, shortPath } from '@/lib/format'
import Icon from '@/components/Icon.vue'
import EmptyState from '@/components/EmptyState.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import type { FileEntry } from '@shared/types'

const search = ref('')
const minSizeMb = ref(50)
const sortKey = ref<'size' | 'date'>('size')
const selection = ref<string[]>([])
const showConfirm = ref(false)
const busy = ref(false)
const moveToTrash = ref(true)

const thresholds = [10, 50, 250, 1000]

const filtered = computed(() => {
  const query = search.value.trim().toLowerCase()
  const list = state.largeFiles.filter((file) => file.size >= minSizeMb.value * 1024 * 1024)
  const matched = query ? list.filter((file) => file.path.toLowerCase().includes(query)) : list
  return [...matched].sort((a, b) => (sortKey.value === 'size' ? b.size - a.size : b.mtime - a.mtime))
})

const selectedBytes = computed(() =>
  filtered.value.filter((file) => selection.value.includes(file.path)).reduce((sum, file) => sum + file.size, 0)
)

onMounted(async () => {
  moveToTrash.value = state.settings?.moveToTrash ?? true
  if (state.summary && state.largeFiles.length === 0) await loadLargeFiles()
})

function toggle(path: string): void {
  const index = selection.value.indexOf(path)
  if (index >= 0) selection.value.splice(index, 1)
  else selection.value.push(path)
}

function selectAll(): void {
  selection.value = filtered.value.slice(0, 500).map((file) => file.path)
}

async function remove(): Promise<void> {
  const items: FileEntry[] = filtered.value
    .filter((file) => selection.value.includes(file.path))
    .map((file) => ({ path: file.path, size: file.size, mtime: file.mtime }))
  busy.value = true
  try {
    const result = await window.api.cleanup.execute(items, ['manual.large-files'], moveToTrash.value)
    toast(
      result.failedCount === 0 ? 'ok' : 'warn',
      result.failedCount === 0 ? 'Space reclaimed' : 'Finished with issues',
      `${formatBytes(result.freedBytes)} recovered from ${result.deletedCount} file(s).`
    )
    selection.value = []
    showConfirm.value = false
    await loadLargeFiles()
  } catch (error) {
    toast('error', 'Could not remove files', error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}

function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')).replace('/sdcard', '')
}
</script>

<template>
  <div class="page-head">
    <div>
      <h2 class="page-title">Large Files</h2>
      <p class="page-sub">Find the largest files, preview them and choose what to remove.</p>
    </div>
    <div class="row" style="gap: 8px">
      <button class="btn btn-sm" @click="loadLargeFiles"><Icon name="refresh" :size="14" /> Refresh</button>
    </div>
  </div>

  <div v-if="!state.summary" class="card">
    <EmptyState
      icon="files"
      title="No index yet"
      message="Scan the phone once, then this list is instant and stays cached."
      action-label="Scan storage"
      @action="scan"
    />
  </div>

  <template v-else>
    <div class="card tight">
      <div class="row wrap" style="gap: 12px">
        <div class="pill-toggle">
          <button v-for="value in thresholds" :key="value" :class="{ active: minSizeMb === value }" @click="minSizeMb = value">
            {{ value >= 1000 ? '1 GB+' : `${value} MB+` }}
          </button>
        </div>

        <div class="row" style="gap: 8px; flex: 1; min-width: 220px">
          <Icon name="search" :size="15" class="faint" />
          <input
            v-model="search"
            placeholder="Filter by name or folder…"
            style="flex: 1; background: var(--panel-2); border: 1px solid var(--border); border-radius: 9px; padding: 7px 10px; color: var(--text); font-size: 13px; outline: none"
          />
        </div>

        <div class="pill-toggle">
          <button :class="{ active: sortKey === 'size' }" @click="sortKey = 'size'">Largest</button>
          <button :class="{ active: sortKey === 'date' }" @click="sortKey = 'date'">Newest</button>
        </div>

        <div class="right row" style="gap: 8px">
          <span class="muted" style="font-size: 12px">{{ filtered.length }} files</span>
          <button class="btn btn-sm" @click="selectAll">Select shown</button>
          <button class="btn btn-sm" @click="selection = []">Clear</button>
          <button class="btn btn-sm btn-danger" :disabled="!selection.length" @click="showConfirm = true">
            Remove {{ selection.length || '' }} · {{ formatBytes(selectedBytes) }}
          </button>
        </div>
      </div>
    </div>

    <div class="card tight" style="padding: 0">
      <div class="scroll-area" style="max-height: calc(100vh - 320px)">
        <table class="table">
          <thead>
            <tr>
              <th style="width: 34px"></th>
              <th>File</th>
              <th>Folder</th>
              <th class="num">Size</th>
              <th class="num">Modified</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="file in filtered" :key="file.path">
              <td>
                <input class="checkbox" type="checkbox" :checked="selection.includes(file.path)" @change="toggle(file.path)" />
              </td>
              <td class="path" :title="file.path"><button class="file-link" @click="openPreview(file)">{{ file.path.split('/').pop() }}</button></td>
              <td class="mono faint" :title="file.dir">{{ folderOf(file.path) }}</td>
              <td class="num" style="color: var(--text); font-weight: 600">{{ formatBytes(file.size) }}</td>
              <td class="num faint" :title="formatDate(file.mtime)">{{ relativeDays(file.mtime) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="!filtered.length" class="empty">
          <h4>No files above {{ minSizeMb }} MB</h4>
          <p>Lower the threshold, or the phone is already tidy.</p>
        </div>
      </div>
    </div>
  </template>

  <ConfirmDialog
    :open="showConfirm"
    :danger="!moveToTrash"
    :busy="busy"
    title="Remove the selected large files?"
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
    </div>
  </ConfirmDialog>
</template>
