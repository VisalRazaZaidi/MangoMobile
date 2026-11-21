<script setup lang="ts">
import { openPreview } from '@/preview'
import { computed, onMounted } from 'vue'
import { loadTree, scan, state, toast } from '@/store'
import { formatBytes, formatCount, percent } from '@/lib/format'
import Icon from '@/components/Icon.vue'
import EmptyState from '@/components/EmptyState.vue'
import Treemap from '@/components/Treemap.vue'
import type { TreeChild } from '@shared/types'

const tree = computed(() => state.tree)

const crumbs = computed(() => {
  const path = state.treePath
  if (!path) return []
  const root = state.summary?.root ?? '/sdcard'
  const relative = path === root ? '' : path.slice(root.length).replace(/^\//, '')
  const segments = relative ? relative.split('/') : []
  const items: { label: string; path: string }[] = [{ label: root.replace('/', ''), path: root }]
  let current = root
  for (const segment of segments) {
    current = `${current}/${segment}`
    items.push({ label: segment, path: current })
  }
  return items
})

const parentPath = computed(() => {
  const path = state.treePath
  const root = state.summary?.root ?? '/sdcard'
  if (!path || path === root) return null
  return path.slice(0, path.lastIndexOf('/')) || root
})

onMounted(() => {
  if (state.summary && !state.tree) void loadTree(state.summary.root)
})

function open(child: TreeChild): void {
  if (child.kind === 'dir') void loadTree(child.path)
  else void openPreview({ path: child.path, size: child.size, mtime: 0 })
}

const visibleChildren = computed(() => state.tree?.children.slice(0, 200) ?? [])
</script>

<template>
  <div class="page-head">
    <div>
      <h2 class="page-title">Space Analysis</h2>
      <p class="page-sub">Explore folders by size. Choose a block to open a folder or preview a file.</p>
    </div>
    <div class="row" style="gap: 8px">
      <button class="btn btn-sm" :disabled="!parentPath" @click="parentPath && loadTree(parentPath)">
        <Icon name="arrowUp" :size="14" /> Up
      </button>
      <button class="btn btn-sm" :disabled="!state.summary" @click="state.summary && loadTree(state.summary.root)">Root</button>
    </div>
  </div>

  <div v-if="!state.summary" class="card">
    <EmptyState
      icon="chart"
      title="No index yet"
      message="Scan the phone to build the folder map used by this chart."
      action-label="Scan storage"
      @action="scan"
    />
  </div>

  <template v-else-if="tree">
    <div class="crumb">
      <button v-for="(crumb, index) in crumbs" :key="crumb.path" @click="loadTree(crumb.path)">
        {{ crumb.label }}<span v-if="index < crumbs.length - 1">/</span>
      </button>
      <span class="right faint">{{ formatCount(tree.fileCount) }} files · {{ formatBytes(tree.totalBytes) }}</span>
    </div>

    <div class="card">
      <Treemap :children="tree.children" :height="320" :other-bytes="tree.otherBytes" @select="open" />

    </div>

    <div class="card tight" style="padding: 0">
      <table class="table">
        <thead>
          <tr>
            <th>Name</th>
            <th class="num">Size</th>
            <th style="width: 34%">Share of folder</th>
            <th class="num">Files</th>
            <th class="num"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="child in visibleChildren" :key="child.path">
            <td class="path" @click="open(child)" style="cursor: pointer">
              <span class="row" style="gap: 8px">
                <Icon :name="child.kind === 'dir' ? 'folder' : 'files'" :size="15" class="faint" />
                {{ child.name }}
              </span>
            </td>
            <td class="num" style="color: var(--text); font-weight: 600">{{ formatBytes(child.size) }}</td>
            <td>
              <div class="meter" style="height: 6px">
                <span :style="{ width: `${percent(child.size, tree.totalBytes)}%`, background: 'linear-gradient(90deg,var(--action-start),var(--action-end))' }" />
              </div>
            </td>
            <td class="num faint">{{ child.kind === 'dir' ? formatCount(child.fileCount) : '—' }}</td>
            <td class="num">
              <button v-if="child.kind === 'dir'" class="btn btn-sm" @click="loadTree(child.path)">Open</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!visibleChildren.length" class="empty">
        <h4>Empty folder</h4>
        <p>Nothing inside this directory.</p>
      </div>
    </div>
  </template>
</template>
