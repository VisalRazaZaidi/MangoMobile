<script setup lang="ts">
import { openPreview } from '@/preview'
import { computed, onMounted, ref, watch } from 'vue'
import {
  allPreviewItems,
  clearRules,
  clearSelection,
  executeCleanup,
  loadPreview,
  previewTotals,
  scan,
  selectAllItems,
  selectAllRules,
  selectedRuleSet,
  state,
  toast,
  toggleItem,
  toggleRule
} from '@/store'
import { formatBytes, relativeDays, shortPath } from '@/lib/format'
import Icon from '@/components/Icon.vue'
import EmptyState from '@/components/EmptyState.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import type { RuleScanResult } from '@shared/types'

const showConfirm = ref(false)
const busy = ref(false)
const moveToTrash = ref(true)
const activeResult = ref<string | null>(null)

const results = computed<RuleScanResult[]>(() => state.preview)
const activeItems = computed(() => {
  const result = results.value.find((entry) => entry.rule.id === activeResult.value)
  return result?.items ?? results.value.flatMap((entry) => entry.items)
})

const selectedBytes = computed(() => previewTotals.value.selectedBytes)

const cleanableBytes = computed(() => results.value.reduce((sum, result) => sum + result.totalBytes, 0))

onMounted(async () => {
  moveToTrash.value = state.settings?.moveToTrash ?? true
  if (state.summary && state.preview.length === 0) await loadPreview()
})

watch(
  () => state.preview.length,
  () => {
    if (!activeResult.value) activeResult.value = results.value.find((result) => result.items.length)?.rule.id ?? null
  }
)

function selectRuleTab(id: string): void {
  activeResult.value = id
}

function formatPath(path: string): string {
  const relative = path.replace(/^\/sdcard\/?/, '')
  return relative.length > 70 ? `…${relative.slice(-69)}` : relative
}

function shortRule(title: string): string {
  const words = title.split(' ')
  const short = words.slice(0, 2).join(' ')
  if (/(and|of|the|for|with|to)$/i.test(short) && words.length > 2) return words.slice(0, 3).join(' ')
  return short
}

async function runCleanup(): Promise<void> {
  busy.value = true
  try {
    await executeCleanup(moveToTrash.value)
    showConfirm.value = false
  } finally {
    busy.value = false
  }
}

function prepare(): void {
  if (state.selection.length === 0) {
    toast('warn', 'Nothing selected', 'Tick the items you want to clean, or use "Select all found".')
    return
  }
  showConfirm.value = true
}
</script>

<template>
  <div class="page-head">
    <div>
      <h2 class="page-title">Deep Clean</h2>
      <p class="page-sub">Review cleanup categories and files before moving them to the recycle bin or deleting them.</p>
    </div>
    <div class="row" style="gap: 8px">
      <button class="btn btn-sm" @click="selectAllRules">Select all rules</button>
      <button class="btn btn-sm" @click="clearRules">Clear</button>
    </div>
  </div>

  <div v-if="!state.summary" class="card">
    <EmptyState
      icon="scan"
      title="Scan the phone first"
      message="Deep Clean works from the storage index, so it needs one scan before it can show what is reclaimable."
      action-label="Scan storage"
      @action="scan"
    />
  </div>

  <div v-else class="grid" style="grid-template-columns: 1.05fr 1fr; align-items: start">
    <div class="stack" style="gap: 10px">
      <div class="row" style="justify-content: space-between">
        <div class="card-title">Cleanup rules</div>
        <div class="muted" style="font-size: 12px">{{ selectedRuleSet.size }} of {{ state.rules.length }} enabled</div>
      </div>

      <div
        v-for="rule in state.rules"
        :key="rule.id"
        class="rule-card"
        :class="{ selected: selectedRuleSet.has(rule.id), disabled: Boolean(results.find((r) => r.rule.id === rule.id)?.skippedReason) }"
      >
        <div class="rule-head">
          <input
            class="checkbox"
            type="checkbox"
            :checked="selectedRuleSet.has(rule.id)"
            :disabled="Boolean(results.find((r) => r.rule.id === rule.id)?.skippedReason)"
            @change="toggleRule(rule.id)"
          />
          <span class="rule-title">{{ rule.title }}</span>
          <span class="badge" :class="rule.risk">{{ rule.risk }}</span>
          <span class="right mono" style="font-size: 12.5px; color: var(--text)">
            {{ formatBytes(results.find((r) => r.rule.id === rule.id)?.totalBytes ?? 0) }}
          </span>
        </div>
        <div class="rule-desc">{{ rule.description }}</div>
        <div class="rule-meta">
          <span>{{ rule.category }}</span>
          <span>·</span>
          <span>{{ (results.find((r) => r.rule.id === rule.id)?.items.length ?? 0).toLocaleString() }} items</span>
          <span v-if="selectedRuleSet.has(rule.id)" class="right" style="cursor: pointer; color: var(--accent)" @click="selectRuleTab(rule.id)">
            inspect →
          </span>
        </div>
        <div v-if="results.find((r) => r.rule.id === rule.id)?.skippedReason" class="warn-box">
          {{ results.find((r) => r.rule.id === rule.id)?.skippedReason }}
        </div>
      </div>
    </div>

    <div class="card" style="position: sticky; top: 0">
      <div class="card-head">
        <div>
          <div class="card-title">Preview</div>
          <div class="card-sub">
            {{ formatBytes(cleanableBytes) }} found ·
            <b style="color: var(--accent)">{{ formatBytes(selectedBytes) }}</b> selected
          </div>
        </div>
        <div class="row" style="gap: 6px">
          <button class="btn btn-sm" @click="selectAllItems">Select all found</button>
          <button class="btn btn-sm" @click="clearSelection">Clear</button>
        </div>
      </div>

      <div v-if="results.filter((r) => r.items.length).length > 1" class="pill-toggle" style="margin-bottom: 10px; flex-wrap: wrap">
        <button :class="{ active: activeResult === null }" @click="activeResult = null">All</button>
        <button
          v-for="result in results.filter((r) => r.items.length)"
          :key="result.rule.id"
          :class="{ active: activeResult === result.rule.id }"
          @click="selectRuleTab(result.rule.id)"
        >
          {{ shortRule(result.rule.title) }}
        </button>
      </div>

      <div class="scroll-area" style="max-height: 430px">
        <table class="table">
          <tbody>
            <tr v-for="item in activeItems.slice(0, 400)" :key="item.path">
              <td style="width: 30px">
                <input class="checkbox" type="checkbox" :checked="state.selection.includes(item.path)" @change="toggleItem(item.path)" />
              </td>
              <td class="path" :title="item.path"><button class="file-link" @click="openPreview(item)">{{ formatPath(item.path) }}</button></td>
              <td class="num">{{ item.isDirectory ? 'folder' : formatBytes(item.size) }}</td>
              <td class="num faint" style="width: 92px">
                {{ item.isDirectory ? '' : relativeDays(item.mtime) }}
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!activeItems.length" class="empty" style="padding: 26px">
          <h4>Nothing to show</h4>
          <p>Enable a rule on the left to see the files it would remove.</p>
        </div>
      </div>

      <div class="info-box" style="margin-top: 12px">
        <label class="row" style="gap: 8px; cursor: pointer">
          <input v-model="moveToTrash" class="checkbox" type="checkbox" />
          <span>
            Move to the phone's recycle bin instead of deleting
            <span class="faint">({{ state.settings?.trashRetentionDays ?? 7 }} day retention, restorable)</span>
          </span>
        </label>
      </div>

      <button class="btn btn-primary" style="width: 100%; margin-top: 12px" :disabled="state.selection.length === 0" @click="prepare">
        <Icon name="broom" :size="16" />
        {{ moveToTrash ? 'Move' : 'Delete' }} {{ state.selection.length }} item(s) · {{ formatBytes(selectedBytes) }}
      </button>
    </div>
  </div>

  <ConfirmDialog
    :open="showConfirm"
    :danger="!moveToTrash"
    :busy="busy"
    :title="moveToTrash ? 'Move selected files to the recycle bin?' : 'Permanently delete selected files?'"
    :confirm-label="moveToTrash ? 'Move to recycle bin' : 'Delete permanently'"
    @cancel="showConfirm = false"
    @confirm="runCleanup"
  >
    <div class="info-box">
      <div><b>{{ state.selection.length }}</b> item(s), {{ formatBytes(selectedBytes) }}.</div>
      <div class="faint" style="margin-top: 6px">
        {{ moveToTrash ? 'Files are moved to /sdcard/.MangoMobileTrash and can be restored from the Recycle Bin.' : 'This cannot be undone.' }}
      </div>
    </div>
    <div class="stack" style="gap: 4px; max-height: 220px; overflow: auto">
      <div v-for="path in state.selection.slice(0, 40)" :key="path" class="mono faint">{{ shortPath(path, 90) }}</div>
      <div v-if="state.selection.length > 40" class="faint">…and {{ state.selection.length - 40 }} more</div>
    </div>
  </ConfirmDialog>
</template>
