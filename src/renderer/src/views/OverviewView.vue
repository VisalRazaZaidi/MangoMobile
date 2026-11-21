<script setup lang="ts">
import { openPreview } from '@/preview'
import { computed, onMounted, ref, watch } from 'vue'
import { go, scan, state } from '@/store'
import { formatBytes, formatCount, formatDuration, percent } from '@/lib/format'
import Icon from '@/components/Icon.vue'
import EmptyState from '@/components/EmptyState.vue'
import Treemap from '@/components/Treemap.vue'
import type { RuleScanResult, TreeView } from '@shared/types'

const rootTree = ref<TreeView | null>(null)
const cleanable = ref<RuleScanResult[]>([])
const cleanableTotal = ref(0)

const volume = computed(() => state.device?.volumes[0] ?? null)

const freeSpace = computed(() => volume.value?.freeBytes ?? 0)
const totalSpace = computed(() => volume.value?.totalBytes ?? 0)

async function loadOverview(): Promise<void> {
  if (!state.summary) return
  rootTree.value = await window.api.analysis.tree(state.summary.root)
  const defaults = state.rules.filter((rule) => rule.defaultSelected).map((rule) => rule.id)
  const preview = await window.api.cleanup.preview(defaults)
  cleanable.value = preview.filter((result) => result.items.length > 0)
  cleanableTotal.value = cleanable.value.reduce((sum, result) => sum + result.totalBytes, 0)
}

onMounted(loadOverview)
watch(() => state.summary, loadOverview)

function openAnalysis(): void {
  if (state.summary) void openInAnalysis(state.summary.root)
}

async function openInAnalysis(path: string): Promise<void> {
  state.view = 'analysis'
  state.tree = await window.api.analysis.tree(path)
  state.treePath = state.tree.path
}
</script>

<template>
  <div class="page-head">
    <div>
      <h2 class="page-title">Overview</h2>
      <p class="page-sub">
        See what is using your storage and choose what to clean up.
      </p>
    </div>
    <button class="btn" :disabled="!state.summary" @click="loadOverview">
      <Icon name="refresh" :size="15" /> Refresh
    </button>
  </div>

  <template v-if="!state.summary">
    <div class="card">
      <EmptyState
        icon="scan"
        title="Nothing indexed yet"
        :message="
          state.device
            ? 'Run one scan to build a full storage index. After that, every view opens instantly and rescans reuse the cache.'
            : 'Connect an Android phone over USB with debugging enabled, or open the built-in demo device to explore the app.'
        "
        :action-label="state.device ? 'Scan storage' : ''"
        secondary-label=""
        @action="scan"
      />
    </div>
  </template>

  <template v-else>
    <div class="grid cols-4">
      <div class="kpi">
        <div class="kpi-label">Free space</div>
        <div class="kpi-value">{{ formatBytes(freeSpace) }}</div>
        <div class="kpi-note">{{ percent(freeSpace, totalSpace).toFixed(0) }}% of {{ formatBytes(totalSpace) }}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Scanned files</div>
        <div class="kpi-value">{{ formatBytes(state.summary.totalBytes) }}</div>
        <div class="kpi-note">
          {{ formatCount(state.summary.fileCount) }} files · {{ formatCount(state.summary.dirCount) }} folders
        </div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Ready to review</div>
        <div class="kpi-value" style="color: var(--accent)">{{ formatBytes(cleanableTotal) }}</div>
        <div class="kpi-note">{{ cleanable.length }} cleanup categories to review</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Scan duration</div>
        <div class="kpi-value">{{ formatDuration(state.summary.durationMs) }}</div>
        <div class="kpi-note">
          {{ state.summary.fromCache ? 'Saved scan' : 'Latest scan' }}
        </div>
      </div>
    </div>

    <div class="grid cols-2" style="grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); align-items: start">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Where the space goes</div>
            <div class="card-sub">Folders and files in shared storage</div>
          </div>
          <button class="btn btn-sm" @click="openAnalysis()">Open analysis</button>
        </div>

        <div style="margin-top: 16px">
          <Treemap
            v-if="rootTree"
            :children="rootTree.children"
            :height="280"
            :other-bytes="rootTree.otherBytes"
            @select="(child) => child.kind === 'dir' ? openInAnalysis(child.path) : openPreview({ path: child.path, size: child.size, mtime: 0 })"
          />
        </div>
      </div>

      <div class="stack" style="align-content: start">
        <div class="card tight">
          <div class="card-head" style="margin-bottom: 10px">
            <div class="card-title">Recommended cleanup</div>
            <button class="btn btn-sm" @click="go('clean')">Review</button>
          </div>
          <div v-if="!cleanable.length" class="muted" style="font-size: 12.5px">
            Nothing matched the safe defaults. Open Deep Clean to review every rule, including recoverable ones.
          </div>
          <div v-else class="stack" style="gap: 8px">
            <div
              v-for="result in cleanable.slice(0, 6)"
              :key="result.rule.id"
              class="row"
              style="justify-content: space-between; font-size: 12.5px"
            >
              <span class="muted">{{ result.rule.title }}</span>
              <b>{{ formatBytes(result.totalBytes) }}</b>
            </div>
          </div>
        </div>

        <div class="card tight">
          <div class="card-head" style="margin-bottom: 10px">
            <div class="card-title">Largest files</div>
            <button class="btn btn-sm" @click="go('large')">See all</button>
          </div>
          <div class="stack" style="gap: 8px">
            <button
              v-for="file in state.largeFiles.slice(0, 5)"
              @click="openPreview(file)"
              :key="file.path"
              class="row largest-file-row"
              style="cursor: pointer; justify-content: space-between; font-size: 12.5px; gap: 12px"
            >
              <span class="mono muted" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                {{ file.path.split('/').pop() }}
              </span>
              <b style="white-space: nowrap">{{ formatBytes(file.size) }}</b>
            </button>
            <div v-if="!state.largeFiles.length" class="muted" style="font-size: 12.5px">No files above the size threshold.</div>
          </div>
        </div>

        <div v-if="state.summary.warnings.length" class="card tight">
          <div class="card-title" style="margin-bottom: 8px">Device notes</div>
          <div class="stack" style="gap: 6px; font-size: 12px; color: var(--text-dim)">
            <div v-for="warning in state.summary.warnings" :key="warning">â€¢ {{ warning }}</div>
          </div>
        </div>
      </div>
    </div>
  </template>
</template>
