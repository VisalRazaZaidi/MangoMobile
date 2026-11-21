<script setup lang="ts">
import { openPreview } from '@/preview'
import { computed, ref } from 'vue'
import { cancelDuplicates, findDuplicates, scan, state, toast } from '@/store'
import { formatBytes, percent, shortPath } from '@/lib/format'
import Icon from '@/components/Icon.vue'
import EmptyState from '@/components/EmptyState.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import type { DuplicateGroup, FileEntry } from '@shared/types'

const removal = ref<Record<string, string[]>>({})
const showConfirm = ref(false)
const busy = ref(false)
const minSizeKb = ref(4)
const moveToTrash = ref(true)

const totalWasted = computed(() => state.duplicates.reduce((sum, group) => sum + group.wastedBytes, 0))
const selectedFiles = computed(() => {
  const out: FileEntry[] = []
  for (const group of state.duplicates) {
    const paths = removal.value[group.id] ?? []
    for (const file of group.files) if (paths.includes(file.path)) out.push(file)
  }
  return out
})
const selectedBytes = computed(() => selectedFiles.value.reduce((sum, file) => sum + file.size, 0))

function initialiseRemoval(): void {
  const next: Record<string, string[]> = {}
  for (const group of state.duplicates) {
    // Keep the newest copy, mark older ones for removal.
    next[group.id] = group.files.slice(1).map((file) => file.path)
  }
  removal.value = next
}

async function run(): Promise<void> {
  state.duplicateOptions = {
    minSizeBytes: Math.max(1, minSizeKb.value * 1024),
    maxGroups: 300,
    fullHash: true
  }
  await findDuplicates()
  initialiseRemoval()
}

function toggle(group: DuplicateGroup, path: string): void {
  const current = removal.value[group.id] ?? []
  const next = current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path]
  removal.value = { ...removal.value, [group.id]: next }
}

function keepOnly(group: DuplicateGroup, path: string): void {
  removal.value = { ...removal.value, [group.id]: group.files.filter((file) => file.path !== path).map((file) => file.path) }
}

async function removeSelected(): Promise<void> {
  busy.value = true
  try {
    const result = await window.api.cleanup.execute(
      selectedFiles.value.map((file) => ({ path: file.path, size: file.size, mtime: file.mtime })),
      ['duplicates'],
      moveToTrash.value
    )
    toast(
      result.failedCount === 0 ? 'ok' : 'warn',
      result.failedCount === 0 ? 'Duplicates removed' : 'Finished with issues',
      `${formatBytes(result.freedBytes)} recovered from ${result.deletedCount} file(s).`
    )
    showConfirm.value = false
    await run()
  } catch (error) {
    toast('error', 'Could not remove duplicates', error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page-head">
    <div>
      <h2 class="page-title">Duplicates</h2>
      <p class="page-sub">Find matching file contents and review which copies to keep.</p>
    </div>
    <div class="row" style="gap: 8px">
      <div class="pill-toggle">
        <button v-for="value in [4, 256, 1024]" :key="value" :class="{ active: minSizeKb === value }" @click="minSizeKb = value">
          {{ value === 4 ? 'Any size' : value >= 1024 ? '1 MB+' : '256 KB+' }}
        </button>
      </div>
      <button class="btn btn-primary" :disabled="!state.summary || state.duplicateRunning" @click="run">
        <Icon name="copy" :size="15" /> Find duplicates
      </button>
      <button v-if="state.duplicateRunning" class="btn" @click="cancelDuplicates">Cancel</button>
    </div>
  </div>

  <div v-if="!state.summary" class="card">
    <EmptyState
      icon="copy"
      title="No index yet"
      message="Duplicate detection reuses the storage index, then hashes candidates on the device."
      action-label="Scan storage"
      @action="scan"
    />
  </div>

  <template v-else>
    <div v-if="state.duplicateProgress" class="card tight">
      <div class="row" style="justify-content: space-between; font-size: 12.5px">
        <span class="muted">
          {{
            state.duplicateProgress.phase === 'hashing'
              ? `Hashing on device, ${state.duplicateProgress.hashed} of ${state.duplicateProgress.candidates} candidates`
              : state.duplicateProgress.phase === 'grouping'
                ? 'Grouping by size…'
                : 'Finishing…'
          }}
        </span>
        <span class="faint">{{ state.duplicateProgress.groups }} groups</span>
      </div>
      <div class="progress" style="margin-top: 10px">
        <span
          :style="{
            width: `${percent(state.duplicateProgress.hashed, Math.max(1, state.duplicateProgress.candidates))}%`
          }"
        />
      </div>
    </div>

    <div v-if="state.duplicates.length" class="grid cols-3">
      <div class="kpi">
        <div class="kpi-label">Groups</div>
        <div class="kpi-value">{{ state.duplicates.length }}</div>
        <div class="kpi-note">exact content matches</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Reclaimable</div>
        <div class="kpi-value" style="color: var(--accent)">{{ formatBytes(totalWasted) }}</div>
        <div class="kpi-note">keeping one copy of each</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Marked for removal</div>
        <div class="kpi-value">{{ formatBytes(selectedBytes) }}</div>
        <div class="kpi-note">{{ selectedFiles.length }} files</div>
      </div>
    </div>

    <div v-if="state.duplicates.length" class="row" style="justify-content: flex-end; gap: 8px">
      <button class="btn" @click="initialiseRemoval">Reset selection</button>
      <button class="btn btn-danger" :disabled="!selectedFiles.length" @click="showConfirm = true">
        Remove {{ selectedFiles.length }} duplicate(s) · {{ formatBytes(selectedBytes) }}
      </button>
    </div>

    <div class="stack">
      <div v-for="group in state.duplicates" :key="group.id" class="card tight">
        <div class="card-head" style="margin-bottom: 8px">
          <div class="row" style="gap: 10px">
            <div class="card-title">{{ formatBytes(group.size) }} each</div>
            <span class="chip">{{ group.files.length }} copies</span>
            <span class="chip" style="color: var(--warn)">wastes {{ formatBytes(group.wastedBytes) }}</span>
            <span v-if="group.approximate" class="badge highImpact">size match only</span>
          </div>
          <div class="mono faint" style="font-size: 11px">{{ group.hash.slice(0, 16) }}</div>
        </div>
        <table class="table">
          <tbody>
            <tr v-for="file in group.files" :key="file.path">
              <td style="width: 30px">
                <input
                  class="checkbox"
                  type="checkbox"
                  :checked="(removal[group.id] ?? []).includes(file.path)"
                  @change="toggle(group, file.path)"
                />
              </td>
              <td class="path" :title="file.path"><button class="file-link" @click="openPreview(file)">{{ shortPath(file.path, 96) }}</button></td>
              <td class="num faint">{{ formatBytes(file.size) }}</td>
              <td class="num" style="width: 120px">
                <button class="btn btn-sm" @click="keepOnly(group, file.path)">Keep this one</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="!state.duplicates.length && !state.duplicateRunning" class="card">
      <EmptyState
        icon="copy"
        title="No duplicate groups yet"
        message="Run a scan to hash size-matched candidates on the device. Keeping one copy of each group is the safe default."
      />
    </div>
  </template>

  <ConfirmDialog
    :open="showConfirm"
    :danger="!moveToTrash"
    :busy="busy"
    title="Remove duplicate copies?"
    :confirm-label="moveToTrash ? 'Move to recycle bin' : 'Delete permanently'"
    @cancel="showConfirm = false"
    @confirm="removeSelected"
  >
    <div class="info-box">
      {{ selectedFiles.length }} file(s), {{ formatBytes(selectedBytes) }}. One copy of every group stays untouched.
    </div>
    <label class="row" style="gap: 8px; cursor: pointer; font-size: 12.5px; color: var(--text-dim)">
      <input v-model="moveToTrash" class="checkbox" type="checkbox" />
      Move to the recycle bin (restorable)
    </label>
  </ConfirmDialog>
</template>
