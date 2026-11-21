<script setup lang="ts">
import { computed } from 'vue'
import { cancelScan, connect, isDemo, scan, state, toast } from '@/store'
import { formatBytes, formatCount, percent } from '@/lib/format'
import Icon from './Icon.vue'

const scanningLabel = computed(() => {
  const progress = state.scanProgress
  if (!progress) return 'Indexing…'
  if (progress.phase === 'directories') return `Listing folders (${formatCount(progress.directories)})`
  if (progress.phase === 'files') return `${formatCount(progress.entries)} files · ${formatBytes(progress.bytes)}`
  if (progress.phase === 'aggregating') return 'Building index…'
  return 'Finishing…'
})

const usedPercent = computed(() => {
  const volume = state.device?.volumes[0]
  if (!volume) return 0
  return percent(volume.usedBytes, volume.totalBytes)
})

async function scanNow(): Promise<void> {
  if (!state.device) {
    toast('warn', 'No device connected', 'Connect a phone first, or open the demo device.')
    return
  }
  await scan()
}

async function pickDevice(): Promise<void> {
  const usable = state.candidates.find((candidate) => candidate.state === 'device')
  if (usable) await connect(usable.serial)
  else await connect('demo')
}
</script>

<template>
  <header class="topbar">
    <div class="row" style="gap: 12px">
      <button class="chip" style="cursor: pointer" @click="pickDevice">
        <Icon name="phone" :size="15" />
        <span v-if="state.device">{{ state.device.manufacturer }} {{ state.device.model }}</span>
        <span v-else>Connect a phone</span>
        <span class="chip-dot" :class="{ off: !state.device, warn: state.device && state.device.state !== 'device' }" />
      </button>

      <div v-if="isDemo" class="badge" style="background: var(--demo-fill); color: var(--demo-ink)">demo</div>

      <div v-if="state.device?.batteryPercent" class="chip">
        <Icon name="chip" :size="14" />
        {{ state.device.batteryPercent }}%
      </div>
    </div>

    <div v-if="state.device?.volumes[0]" class="row" style="gap: 10px; min-width: 260px; flex: 1; max-width: 420px">
      <div style="flex: 1">
        <div class="meter">
          <span
            :style="{
              width: `${usedPercent}%`,
              background: usedPercent > 92 ? 'linear-gradient(90deg,var(--storage-warning),var(--danger))' : 'linear-gradient(90deg,var(--action-start),var(--action-end))'
            }"
          />
        </div>
        <div class="row" style="justify-content: space-between; font-size: 11px; color: var(--text-faint); margin-top: 4px">
          <span>{{ formatBytes(state.device.volumes[0].usedBytes) }} used</span>
          <span>{{ formatBytes(state.device.volumes[0].freeBytes) }} free of {{ formatBytes(state.device.volumes[0].totalBytes) }}</span>
        </div>
      </div>
    </div>

    <div class="right row" style="gap: 10px">
      <div v-if="state.scanning" class="row muted" style="font-size: 12px">
        <Icon name="refresh" :size="14" class="spin" />
        {{ scanningLabel }}
      </div>
      <button v-if="state.scanning" class="btn btn-sm" @click="cancelScan">Cancel</button>
      <button class="btn btn-primary" :disabled="state.scanning || !state.device" @click="scanNow">
        <Icon name="scan" :size="16" />
        {{ state.summary ? 'Rescan storage' : 'Scan storage' }}
      </button>
    </div>
  </header>
</template>
