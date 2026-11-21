<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { TreeChild } from '@shared/types'
import { formatBytes, percent } from '@/lib/format'
import { squarify } from '@/lib/treemap'

const props = withDefaults(defineProps<{ children: TreeChild[]; height?: number; otherBytes?: number }>(), { height: 300, otherBytes: 0 })
const emit = defineEmits<{ (event: 'select', child: TreeChild): void }>()
const chart = ref<HTMLElement | null>(null)
const width = ref(600)
const active = ref<string | null>(null)
const expanded = ref(false)
let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(entries => { width.value = entries[0].contentRect.width })
  if (chart.value) observer.observe(chart.value)
})
onUnmounted(() => observer?.disconnect())
const items = computed(() => props.children.filter(c => Number.isFinite(c.size) && c.size > 0).slice().sort((a, b) => b.size - a.size))
const total = computed(() => items.value.reduce((sum, child) => sum + child.size, 0) + props.otherBytes)
const chartItems = computed(() => {
  const visible = items.value.filter((child, index) => index < 7 && child.size / total.value >= 0.015)
  const hidden = items.value.slice(visible.length)
  const remaining = hidden.reduce((sum, child) => sum + child.size, 0) + props.otherBytes
  return [...visible.map(child => ({ child, grouped: false })), ...(remaining > 0 ? [{ child: {
    name: 'Other items', path: '__other__', size: remaining, kind: 'dir' as const,
    fileCount: hidden.reduce((sum, child) => sum + child.fileCount, 0), share: remaining / total.value
  }, grouped: true }] : [])]
})
const rects = computed(() => {
  const boxes = squarify(chartItems.value.map(item => item.child.size), width.value, props.height)
  return chartItems.value.map((item, index) => ({ ...item, index, ...boxes[index] }))
})
const focused = computed(() => chartItems.value.find(item => item.child.path === active.value)?.child)
const legend = computed(() => expanded.value ? items.value : chartItems.value.filter(item => !item.grouped).map(item => item.child))
function color(index: number): string { return `var(--chart-${Math.min(index + 1, 8)})` }
function select(item: typeof chartItems.value[number]): void {
  if (item.grouped) expanded.value = !expanded.value
  else emit('select', item.child)
}
</script>

<template>
  <div class="storage-map">
    <div ref="chart" class="treemap" :style="{ height: `${height}px` }" aria-label="Storage usage by item">
      <button v-for="rect in rects" :key="rect.child.path" class="treemap-cell"
        :class="{ 'is-active': active === rect.child.path }"
        :style="{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px`, background: color(rect.index) }"
        :aria-label="`${rect.child.name}, ${formatBytes(rect.child.size)}, ${percent(rect.child.size, total).toFixed(1)} percent. ${rect.grouped ? 'Show smaller items' : rect.child.kind === 'dir' ? 'Open folder' : 'Preview file'}`"
        @mouseenter="active = rect.child.path" @mouseleave="active = null" @focus="active = rect.child.path" @blur="active = null" @click="select(rect)">
        <template v-if="rect.w >= 90 && rect.h >= 52">
          <span class="map-name">{{ rect.child.name }}</span>
          <span class="map-size">{{ formatBytes(rect.child.size) }}</span>
          <span v-if="rect.h >= 90 && rect.w >= 130" class="map-share">{{ percent(rect.child.size, total).toFixed(1) }}%</span>
        </template>
      </button>
      <div v-if="!rects.length" class="empty"><h4>Nothing to chart here</h4><p>This folder has no files yet.</p></div>
    </div>
    <div class="map-caption" aria-live="polite">
      <template v-if="focused"><strong>{{ focused.name }}</strong><span>{{ formatBytes(focused.size) }} / {{ percent(focused.size, total).toFixed(1) }}%</span></template>
      <template v-else><span>Each block represents its share of storage.</span><span>Choose an item to explore</span></template>
    </div>
    <div class="map-list" aria-label="Storage item details">
      <button v-for="(child, index) in legend" :key="child.path" class="map-row" @click="emit('select', child)">
        <i :style="{ background: color(index) }" aria-hidden="true" /><span class="map-row-name">{{ child.name }}</span>
        <strong>{{ formatBytes(child.size) }}</strong><span class="map-row-share">{{ percent(child.size, total).toFixed(1) }}%</span>
      </button>
      <button v-if="chartItems.some(item => item.grouped)" class="map-more" :aria-expanded="expanded" @click="expanded = !expanded">
        {{ expanded ? 'Show fewer items' : `Show smaller items (${formatBytes(chartItems[chartItems.length - 1].child.size)})` }}
      </button>
      <p v-if="expanded && otherBytes > 0" class="faint">{{ formatBytes(otherBytes) }} in additional items beyond the current folder listing.</p>
    </div>
  </div>
</template>

<style scoped>
.storage-map { min-width: 0; }
.map-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
.map-size { font-size: 12px; }
.map-share { margin-top: auto; font-size: 20px; font-weight: 600; }
.map-caption { min-height: 48px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; color: var(--text-dim); font-size: 12px; }
.map-list { display: grid; }
.map-row { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto 52px; align-items: center; gap: 12px; padding: 12px 4px; background: none; border: 0; border-top: 1px solid var(--border-soft); color: var(--text); text-align: left; cursor: pointer; font: inherit; font-size: 12px; min-height: 40px; }
.map-row:hover { background: var(--panel-2); }
.map-row i { width: 8px; height: 8px; border-radius: 2px; }
.map-row-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.map-row strong { font-weight: 600; }
.map-row-share { text-align: right; color: var(--text-dim); }
.map-more { text-align: left; background: none; border: 0; padding: 12px 4px; color: var(--text); font: inherit; font-size: 12px; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
</style>
