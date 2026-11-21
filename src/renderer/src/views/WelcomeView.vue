<script setup lang="ts">
import { computed, ref } from 'vue'
import { connect, refreshDiagnostics, restartAdb, state } from '@/store'
import Icon from '@/components/Icon.vue'

const working = ref(false)

const diagnostic = computed(() => state.diagnostics)
const candidates = computed(() => state.candidates)

async function detect(): Promise<void> {
  working.value = true
  try {
    await refreshDiagnostics()
    const usable = state.candidates.find((candidate) => candidate.state === 'device')
    if (usable) {
      await connect(usable.serial)
      return
    }
    if (state.candidates.length === 0) return
    await connect(state.candidates[0].serial)
  } finally {
    working.value = false
  }
}

async function openDemo(): Promise<void> {
  working.value = true
  try {
    await connect('demo')
  } finally {
    working.value = false
  }
}
</script>

<template>
  <div class="welcome">
    <div class="welcome-inner">
      <div class="row" style="gap: 12px">
        <div class="brand-mark" style="width: 42px; height: 42px; border-radius: 13px; font-size: 19px">M</div>
        <div>
          <div class="brand-title" style="font-size: 16px">MangoMobile</div>
          <div class="brand-sub">Fast phone storage cleanup over ADB</div>
        </div>
      </div>

      <h1 class="welcome-title" style="overflow-wrap: break-word; min-width: 0">
        Clean your phone's storage<br />
        without waiting on Windows Explorer.
      </h1>
      <p class="welcome-lead">
        Explorer asks the phone for one folder at a time over MTP, which is why it feels frozen. MangoMobile builds the whole
        index with a single streamed <span class="mono">adb shell find</span>, then every view, large files, duplicates,
        caches, opens instantly and the phone does the heavy lifting.
      </p>

      <div class="grid cols-3" style="margin-top: 6px">
        <div class="welcome-card">
          <div class="welcome-step">1</div>
          <div class="card-title">Enable USB debugging</div>
          <p class="welcome-muted">
            Settings → About phone → tap <b>Build number</b> seven times, then turn on <b>USB debugging</b> in Developer
            options.
          </p>
        </div>
        <div class="welcome-card">
          <div class="welcome-step">2</div>
          <div class="card-title">Plug in and allow</div>
          <p class="welcome-muted">
            Connect the cable, then accept the <b>Allow USB debugging?</b> prompt on the phone. Tick “Always allow” so it is
            remembered.
          </p>
        </div>
        <div class="welcome-card">
          <div class="welcome-step">3</div>
          <div class="card-title">Scan once, then browse</div>
          <p class="welcome-muted">
            A single scan streams file metadata and builds a local index. After that, filtering, charts and duplicate
            detection never wait on the cable.
          </p>
        </div>
      </div>

      <div class="row wrap" style="gap: 10px; margin-top: 8px">
        <button class="btn btn-primary" :disabled="working" @click="detect">
          <Icon name="scan" :size="16" /> {{ working ? 'Looking for a phone…' : 'Detect my phone' }}
        </button>
        <button class="btn" :disabled="working" @click="openDemo">
          <Icon name="phone" :size="16" /> Explore the demo device
        </button>
        <span v-if="state.adb" class="chip">
          <span class="chip-dot" :class="{ off: !state.adb.adbFound }" />
          {{ state.adb.adbFound ? `adb ${state.adb.adbVersion ?? ''}` : 'adb missing' }}
        </span>
      </div>

      <div v-if="candidates.length" class="card tight" style="margin-top: 4px">
        <div class="card-title" style="margin-bottom: 8px">Devices the computer can see</div>
        <div class="stack" style="gap: 6px; font-size: 12.5px">
          <div v-for="candidate in candidates" :key="candidate.serial" class="row" style="justify-content: space-between">
            <span class="mono faint">{{ candidate.serial }}</span>
            <span class="badge" :class="{ recoverable: candidate.state !== 'device' }">{{ candidate.state }}</span>
          </div>
        </div>
      </div>

      <div v-if="diagnostic && !diagnostic.ok" class="card tight" style="margin-top: 4px">
        <div class="row" style="gap: 8px; margin-bottom: 6px">
          <Icon name="alert" :size="16" style="color: var(--warn)" />
          <div class="card-title">{{ diagnostic.title }}</div>
        </div>
        <p class="welcome-muted" style="margin: 0 0 8px">{{ diagnostic.detail }}</p>
        <ol class="welcome-steps">
          <li v-for="step in diagnostic.steps" :key="step">{{ step }}</li>
        </ol>
        <div class="row wrap" style="gap: 8px; margin-top: 10px">
          <button class="btn btn-sm" @click="refreshDiagnostics"><Icon name="refresh" :size="13" /> Check again</button>
          <button class="btn btn-sm" @click="restartAdb">Restart adb server</button>
          <button class="btn btn-sm" :disabled="working" @click="detect">Detect my phone</button>
        </div>
      </div>

      <div class="welcome-foot">
        Your files never leave the phone: hashing, scanning and deletion all run on the device. Only metadata crosses the
        cable.
      </div>
    </div>
  </div>
</template>
