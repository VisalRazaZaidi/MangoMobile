<script setup lang="ts">
import { computed } from 'vue'
import { go, state } from '@/store'
import Icon from './Icon.vue'

const items = computed(() => [
  {
    group: 'Storage',
    entries: [
      { key: 'overview', label: 'Overview', icon: 'dashboard', count: '' },
      {
        key: 'clean',
        label: 'Deep Clean',
        icon: 'broom',
        count: state.preview.length ? String(state.preview.filter((r) => r.items.length).length) : ''
      },
      {
        key: 'large',
        label: 'Large Files',
        icon: 'files',
        count: state.largeFiles.length ? String(state.largeFiles.length) : ''
      },
      { key: 'analysis', label: 'Space Analysis', icon: 'chart', count: '' },
      {
        key: 'duplicates',
        label: 'Duplicates',
        icon: 'copy',
        count: state.duplicates.length ? String(state.duplicates.length) : ''
      },
      { key: 'media', label: 'Media', icon: 'image', count: '' }
    ]
  },
  {
    group: 'System',
    entries: [
      { key: 'apps', label: 'Apps', icon: 'apps', count: state.apps ? String(state.apps.apps.length) : '' },
      {
        key: 'trash',
        label: 'Recycle Bin',
        icon: 'trash',
        count: state.trash?.entries.length ? String(state.trash.entries.length) : ''
      },
      { key: 'history', label: 'History', icon: 'history', count: '' },
      { key: 'settings', label: 'Settings', icon: 'settings', count: '' }
    ]
  }
])

function navigate(key: string): void {
  void go(key as Parameters<typeof go>[0])
}
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-mark">M</div>
      <div>
        <div class="brand-title">MangoMobile</div>
        <div class="brand-sub">Phone storage cleaner</div>
      </div>
    </div>

    <template v-for="section in items" :key="section.group">
      <div class="nav-label">{{ section.group }}</div>
      <button
        v-for="entry in section.entries"
        :key="entry.key"
        class="nav-item"
        :class="{ active: state.view === entry.key }"
        @click="navigate(entry.key)"
      >
        <Icon :name="entry.icon" :size="17" />
        <span>{{ entry.label }}</span>
        <span v-if="entry.count" class="count">{{ entry.count }}</span>
      </button>
    </template>

    <div class="sidebar-footer">
      <div class="row">
        <span class="chip-dot" :class="{ off: !state.device }" />
        <span>{{ state.device ? state.device.model : 'No device' }}</span>
      </div>
      <div v-if="state.device" class="faint">
        Android {{ state.device.androidVersion }} · SDK {{ state.device.sdk }}
      </div>
      <div v-if="state.device?.simulated" class="faint">Simulated device · fixture data</div>
    </div>
  </aside>
</template>
