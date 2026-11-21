<script setup lang="ts">
import { openPreview } from '@/preview'
import { computed, onMounted, ref } from 'vue'
import { purgeTrash, refreshTrash, restoreTrash, state, toast } from '@/store'
import { formatBytes, formatDateTime, shortPath } from '@/lib/format'
import Icon from '@/components/Icon.vue'
import EmptyState from '@/components/EmptyState.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const selection = ref<string[]>([])
const busy = ref(false)
const purgeMode = ref<'selected' | 'all' | null>(null)

onMounted(() => {
  if (state.device) void refreshTrash()
})

const entries = computed(() => state.trash?.entries ?? [])
const totalBytes = computed(() => state.trash?.totalBytes ?? 0)
const selectedEntries = computed(() => entries.value.filter((entry) => selection.value.includes(entry.storedPath)))
const selectedBytes = computed(() => selectedEntries.value.reduce((sum, entry) => sum + entry.size, 0))
const retention = computed(() => state.settings?.trashRetentionDays ?? 7)

const groups = computed(() => {
  const map = new Map<string, { opId: string; at: number; entries: typeof entries.value }>()
  for (const entry of entries.value) {
    const group = map.get(entry.opId) ?? { opId: entry.opId, at: entry.at, entries: [] }
    group.entries.push(entry)
    map.set(entry.opId, group)
  }
  return [...map.values()].sort((a, b) => b.at - a.at)
})

function toggle(path: string): void {
  const index = selection.value.indexOf(path)
  if (index >= 0) selection.value.splice(index, 1)
  else selection.value.push(path)
}

function toggleGroup(opId: string): void {
  const stored = entries.value.filter((entry) => entry.opId === opId).map((entry) => entry.storedPath)
  const allSelected = stored.every((path) => selection.value.includes(path))
  selection.value = allSelected
    ? selection.value.filter((path) => !stored.includes(path))
    : [...new Set([...selection.value, ...stored])]
}

async function restore(): Promise<void> {
  if (!selection.value.length) return
  busy.value = true
  try {
    await restoreTrash(selection.value)
    selection.value = []
  } finally {
    busy.value = false
  }
}

async function purge(): Promise<void> {
  busy.value = true
  try {
    if (purgeMode.value === 'selected') {
      await purgeTrash(selection.value)
      selection.value = []
    } else {
      await purgeTrash()
    }
    purgeMode.value = null
  } finally {
    busy.value = false
  }
}

function requestPurge(mode: 'selected' | 'all'): void {
  if (mode === 'selected' && !selection.value.length) {
    toast('warn', 'Nothing selected', 'Tick the entries you want to remove permanently.')
    return
  }
  purgeMode.value = mode
}
</script>

<template>
  <div class="page-head">
    <div>
      <h2 class="page-title">Recycle Bin</h2>
      <p class="page-sub">Restore removed files or delete them permanently to free storage.</p>
    </div>
    <div class="row" style="gap: 8px">
      <button class="btn" :disabled="state.trashLoading" @click="refreshTrash">
        <Icon name="refresh" :size="15" /> Refresh
      </button>
      <button class="btn" :disabled="!selection.length || busy" @click="restore">
        <Icon name="history" :size="15" /> Restore {{ selection.length || '' }}
      </button>
      <button class="btn btn-danger" :disabled="!entries.length || busy" @click="requestPurge('all')">
        <Icon name="trash" :size="15" /> Empty bin
      </button>
    </div>
  </div>

  <div class="grid cols-3">
    <div class="kpi">
      <div class="kpi-label">Recoverable</div>
      <div class="kpi-value">{{ formatBytes(totalBytes) }}</div>
      <div class="kpi-note">{{ entries.length }} file(s) in the bin</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Removal batches</div>
      <div class="kpi-value">{{ groups.length }}</div>
      <div class="kpi-note">each batch restores independently</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Selected</div>
      <div class="kpi-value" style="color: var(--accent)">{{ formatBytes(selectedBytes) }}</div>
      <div class="kpi-note">{{ selection.length }} file(s) marked</div>
    </div>
  </div>

  <div v-if="!entries.length" class="card">
    <EmptyState
      icon="trash"
      title="The recycle bin is empty"
      message="Anything you remove with the recycle-bin option lands here first, so it can be put back exactly where it came from."
      secondary-label=""
    />
  </div>

  <template v-else>
    <div class="row wrap" style="justify-content: space-between; gap: 8px">
      <div class="muted" style="font-size: 12.5px">{{ state.trash?.dir }}</div>
      <div class="row" style="gap: 8px">
        <button class="btn btn-sm" @click="selection = entries.map((entry) => entry.storedPath)">Select all</button>
        <button class="btn btn-sm" @click="selection = []">Clear</button>
        <button class="btn btn-sm btn-danger" :disabled="!selection.length" @click="requestPurge('selected')">
          Delete selected permanently
        </button>
      </div>
    </div>

    <div class="stack">
      <div v-for="group in groups" :key="group.opId" class="card tight">
        <div class="card-head" style="margin-bottom: 8px">
          <div class="row" style="gap: 10px">
            <input
              class="checkbox"
              type="checkbox"
              :checked="group.entries.every((entry) => selection.includes(entry.storedPath))"
              @change="toggleGroup(group.opId)"
            />
            <div>
              <div class="card-title">{{ formatDateTime(group.at) }}</div>
              <div class="card-sub">
                {{ group.entries.length }} file(s) · {{ formatBytes(group.entries.reduce((sum, entry) => sum + entry.size, 0)) }}
              </div>
            </div>
          </div>
          <span class="chip mono">{{ group.opId.slice(0, 18) }}</span>
        </div>

        <table class="table">
          <tbody>
            <tr v-for="entry in group.entries" :key="entry.storedPath">
              <td style="width: 30px">
                <input
                  class="checkbox"
                  type="checkbox"
                  :checked="selection.includes(entry.storedPath)"
                  @change="toggle(entry.storedPath)"
                />
              </td>
              <td class="path" :title="entry.originalPath"><button class="file-link" @click="openPreview({ path: entry.storedPath, size: entry.size, mtime: entry.mtime })">{{ shortPath(entry.originalPath, 92) }}</button></td>
              <td class="num faint">{{ formatBytes(entry.size) }}</td>
              <td class="num" style="width: 130px">
                <button class="btn btn-sm" @click="restoreTrash([entry.storedPath])">Put back</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <ConfirmDialog
    :open="purgeMode !== null"
    danger
    :busy="busy"
    :title="purgeMode === 'all' ? 'Empty the recycle bin?' : 'Permanently delete the selected files?'"
    :confirm-label="purgeMode === 'all' ? 'Empty bin' : 'Delete permanently'"
    @cancel="purgeMode = null"
    @confirm="purge"
  >
    <div class="info-box">
      <template v-if="purgeMode === 'all'">
        All <b>{{ entries.length }}</b> file(s), {{ formatBytes(totalBytes) }}, will be deleted from the phone. This cannot be
        undone.
      </template>
      <template v-else>
        <b>{{ selection.length }}</b> file(s), {{ formatBytes(selectedBytes) }}, will be deleted from the phone. This cannot be
        undone.
      </template>
    </div>
    <div class="stack" style="gap: 3px; max-height: 180px; overflow: auto">
      <div
        v-for="entry in (purgeMode === 'all' ? entries : selectedEntries).slice(0, 30)"
        :key="entry.storedPath"
        class="mono faint"
      >
        {{ shortPath(entry.originalPath, 88) }}
      </div>
    </div>
  </ConfirmDialog>
</template>
