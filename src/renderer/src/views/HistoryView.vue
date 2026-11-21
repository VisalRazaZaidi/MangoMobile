<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { clearHistory, refreshHistory, state } from '@/store'
import { formatBytes, formatDateTime } from '@/lib/format'
import Icon from '@/components/Icon.vue'
import EmptyState from '@/components/EmptyState.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import type { HistoryEntry } from '@shared/types'

const showConfirm = ref(false)
const filter = ref<'all' | HistoryEntry['kind']>('all')

onMounted(() => {
  void refreshHistory()
})

const kindMeta: Record<HistoryEntry['kind'], { label: string; icon: string }> = {
  cleanup: { label: 'Cleanup', icon: 'broom' },
  'trash-restore': { label: 'Restored', icon: 'history' },
  'trash-purge': { label: 'Bin emptied', icon: 'trash' },
  uninstall: { label: 'Uninstalled', icon: 'apps' },
  'trim-caches': { label: 'Cache trim', icon: 'broom' },
  scan: { label: 'Scan', icon: 'scan' }
}

const entries = computed(() => {
  const list = filter.value === 'all' ? state.history : state.history.filter((entry) => entry.kind === filter.value)
  return list.slice(0, 500)
})

const totals = computed(() => ({
  operations: state.history.length,
  freed: state.history.reduce((sum, entry) => sum + entry.freedBytes, 0),
  failures: state.history.reduce((sum, entry) => sum + entry.failedCount, 0)
}))

async function clear(): Promise<void> {
  await clearHistory()
  showConfirm.value = false
}
</script>

<template>
  <div class="page-head">
    <div>
      <h2 class="page-title">History</h2>
      <p class="page-sub">Review previous scans, cleanups and restores on this computer.</p>
    </div>
    <div class="row" style="gap: 8px">
      <button class="btn" @click="refreshHistory"><Icon name="refresh" :size="15" /> Refresh</button>
      <button class="btn" :disabled="!state.history.length" @click="showConfirm = true">
        <Icon name="trash" :size="15" /> Clear history
      </button>
    </div>
  </div>

  <div class="grid cols-3">
    <div class="kpi">
      <div class="kpi-label">Operations</div>
      <div class="kpi-value">{{ totals.operations.toLocaleString() }}</div>
      <div class="kpi-note">newest first</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Space reclaimed</div>
      <div class="kpi-value" style="color: var(--accent)">{{ formatBytes(totals.freed) }}</div>
      <div class="kpi-note">across cleanups and cache trims</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Failures</div>
      <div class="kpi-value">{{ totals.failures }}</div>
      <div class="kpi-note">files the device refused to remove</div>
    </div>
  </div>

  <div v-if="!state.history.length" class="card">
    <EmptyState
      icon="history"
      title="No operations yet"
      message="Scan the phone, then clean something, every step is recorded here with the exact byte count and outcome."
      action-label="Open Deep Clean"
      @action="state.view = 'clean'"
    />
  </div>

  <template v-else>
    <div class="pill-toggle" style="align-self: flex-start; flex-wrap: wrap">
      <button :class="{ active: filter === 'all' }" @click="filter = 'all'">All</button>
      <button
        v-for="(meta, kind) in kindMeta"
        :key="kind"
        :class="{ active: filter === kind }"
        @click="filter = kind"
      >
        {{ meta.label }}
      </button>
    </div>

    <div class="card tight" style="padding: 0">
      <div class="scroll-area" style="max-height: calc(100vh - 400px)">
        <table class="table">
          <thead>
            <tr>
              <th style="width: 190px">When</th>
              <th style="width: 150px">Operation</th>
              <th>Details</th>
              <th class="num">Items</th>
              <th class="num">Freed</th>
              <th class="num">Failed</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in entries" :key="entry.id">
              <td class="faint" style="white-space: nowrap">{{ formatDateTime(entry.at) }}</td>
              <td>
                <span class="row" style="gap: 8px; color: var(--text)">
                  <Icon :name="kindMeta[entry.kind].icon" :size="14" class="faint" />
                  {{ kindMeta[entry.kind].label }}
                </span>
              </td>
              <td class="muted" :title="entry.details">
                {{ entry.details }}
                <span v-if="entry.deviceModel" class="faint"> · {{ entry.deviceModel }}</span>
              </td>
              <td class="num">{{ entry.itemCount.toLocaleString() }}</td>
              <td class="num" style="font-weight: 600; color: var(--text)">
                {{ entry.freedBytes ? formatBytes(entry.freedBytes) : '—' }}
              </td>
              <td class="num" :style="{ color: entry.failedCount ? 'var(--warn)' : undefined }">
                {{ entry.failedCount || '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <ConfirmDialog
    :open="showConfirm"
    danger
    title="Clear the operation history?"
    confirm-label="Clear history"
    @cancel="showConfirm = false"
    @confirm="clear"
  >
    <div class="info-box">
      This removes {{ state.history.length }} record(s) from this computer. Files already moved to the recycle bin stay on the
      phone, but MangoMobile will no longer know where to restore them, so empty or restore the bin first.
    </div>
  </ConfirmDialog>
</template>
