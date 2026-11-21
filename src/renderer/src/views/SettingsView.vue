<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { connect, refreshDiagnostics, restartAdb, saveSettings, state, toast } from '@/store'
import { formatBytes } from '@/lib/format'
import Icon from '@/components/Icon.vue'
import type { Settings } from '@shared/types'

const blank: Settings = {
  adbPath: '',
  useMockDevice: false,
  moveToTrash: true,
  trashRetentionDays: 7,
  scanRoot: '/sdcard',
  theme: 'system',
  largeFileMinBytes: 50 * 1024 * 1024,
  duplicateMinBytes: 4096,
  skipAppData: false
}

const draft = reactive<Settings>({ ...blank, ...(state.settings ?? {}) })
const saving = ref(false)

watch(
  () => state.settings,
  (value) => {
    if (value) Object.assign(draft, value)
  },
  { deep: true }
)

const dirty = computed(() => {
  const current = state.settings ?? blank
  return (Object.keys(blank) as (keyof Settings)[]).some((key) => draft[key] !== current[key])
})

const largeFileOptions = [10, 50, 250, 1000]

async function save(): Promise<void> {
  saving.value = true
  try {
    await saveSettings({ ...draft })
    toast('ok', 'Settings saved', 'Changes apply to the next scan and cleanup.')
  } finally {
    saving.value = false
  }
}

function reset(): void {
  Object.assign(draft, state.settings ?? blank)
}

async function openDemo(): Promise<void> {
  await connect('demo')
  await refreshDiagnostics()
}

function openDataDir(): void {
  void window.api.app.openDataDir()
}

function openPlatformTools(): void {
  void window.api.app.openExternal('https://developer.android.com/tools/releases/platform-tools')
}
</script>

<template>
  <div class="page-head">
    <div>
      <h2 class="page-title">Settings</h2>
      <p class="page-sub">Set your connection, appearance and cleanup preferences.</p>
    </div>
    <div class="row" style="gap: 8px">
      <button class="btn" :disabled="!dirty || saving" @click="reset">Discard</button>
      <button class="btn btn-primary" :disabled="!dirty || saving" @click="save">
        <Icon name="check" :size="15" /> Save changes
      </button>
    </div>
  </div>

  <div class="grid" style="grid-template-columns: 1fr 1fr; align-items: start">
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Appearance</div>
            <div class="card-sub">The interface follows the operating system unless you pin a theme.</div>
          </div>
        </div>
        <div class="pill-toggle">
          <button :class="{ active: draft.theme === 'system' }" @click="draft.theme = 'system'">System</button>
          <button :class="{ active: draft.theme === 'dark' }" @click="draft.theme = 'dark'">Dark</button>
          <button :class="{ active: draft.theme === 'light' }" @click="draft.theme = 'light'">Light</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Safety</div>
            <div class="card-sub">Defaults used by every cleanup preview.</div>
          </div>
          <Icon name="shield" :size="17" class="faint" />
        </div>

        <div class="stack" style="gap: 12px">
          <label class="row" style="gap: 10px; cursor: pointer; align-items: flex-start">
            <input v-model="draft.moveToTrash" class="checkbox" type="checkbox" style="margin-top: 3px" />
            <span>
              Move removed files to the recycle bin by default
              <span class="faint" style="display: block; font-size: 12px">
                Files stay at /sdcard/.MangoMobileTrash until the retention window expires.
              </span>
            </span>
          </label>

          <div class="row" style="justify-content: space-between; gap: 12px">
            <div>
              <div>Recycle bin retention</div>
              <div class="faint" style="font-size: 12px">Expired batches are purged automatically when you connect.</div>
            </div>
            <div class="row" style="gap: 8px">
              <input
                v-model.number="draft.trashRetentionDays"
                type="number"
                min="1"
                max="365"
                style="width: 82px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 9px; padding: 6px 9px; color: var(--text)"
              />
              <span class="muted" style="font-size: 12.5px">days</span>
            </div>
          </div>

          <label class="row" style="gap: 10px; cursor: pointer; align-items: flex-start">
            <input v-model="draft.skipAppData" class="checkbox" type="checkbox" style="margin-top: 3px" />
            <span>
              Skip /sdcard/Android during scans
              <span class="faint" style="display: block; font-size: 12px">
                Recommended on Android 11+: the folder is unreadable to the shell user and slows the walk down.
              </span>
            </span>
          </label>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Scanning</div>
            <div class="card-sub">Thresholds used by the index and the duplicate scanner.</div>
          </div>
        </div>
        <div class="stack" style="gap: 12px">
          <div class="row" style="justify-content: space-between; gap: 12px">
            <div>
              <div>Scan root</div>
              <div class="faint" style="font-size: 12px">Usually /sdcard. Change it for an SD card mounted elsewhere.</div>
            </div>
            <input
              v-model="draft.scanRoot"
              class="mono"
              style="width: 190px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 9px; padding: 6px 9px; color: var(--text)"
            />
          </div>

          <div>
            <div style="margin-bottom: 6px">Large-file threshold</div>
            <div class="pill-toggle">
              <button
                v-for="value in largeFileOptions"
                :key="value"
                :class="{ active: draft.largeFileMinBytes === value * 1024 * 1024 }"
                @click="draft.largeFileMinBytes = value * 1024 * 1024"
              >
                {{ value >= 1000 ? '1 GB+' : `${value} MB+` }}
              </button>
            </div>
          </div>

          <div class="row" style="justify-content: space-between; gap: 12px">
            <div>
              <div>Duplicate minimum size</div>
              <div class="faint" style="font-size: 12px">
                Smaller files are skipped before hashing. Current: {{ formatBytes(draft.duplicateMinBytes) }}
              </div>
            </div>
            <div class="row" style="gap: 8px">
              <input
                v-model.number="draft.duplicateMinBytes"
                type="number"
                min="0"
                style="width: 110px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 9px; padding: 6px 9px; color: var(--text)"
              />
              <span class="muted" style="font-size: 12.5px">bytes</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="stack">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">ADB connection</div>
            <div class="card-sub">MangoMobile talks to the phone through Android's own bridge, not MTP.</div>
          </div>
          <span class="chip-dot" :class="{ off: !state.adb?.adbFound, warn: state.adb?.adbFound && !state.adb?.serverRunning }" />
        </div>

        <div class="stack" style="gap: 10px; font-size: 12.5px; color: var(--text-dim)">
          <div class="row" style="justify-content: space-between; gap: 10px">
            <span>Status</span>
            <b :style="{ color: state.adb?.adbFound ? 'var(--ok)' : 'var(--danger)' }">
              {{ state.adb?.adbFound ? `found · ${state.adb.adbVersion ?? 'version unknown'}` : 'not found' }}
            </b>
          </div>
          <div class="row" style="justify-content: space-between; gap: 10px">
            <span>Path</span>
            <span class="mono faint" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
              {{ state.adb?.adbPath || 'not resolved' }}
            </span>
          </div>
          <div class="row" style="justify-content: space-between; gap: 10px">
            <span>Server</span>
            <b :style="{ color: state.adb?.serverRunning ? 'var(--ok)' : 'var(--warn)' }">
              {{ state.adb?.serverRunning ? 'running' : 'stopped' }}
            </b>
          </div>
          <div v-if="state.adb?.error" class="warn-box">{{ state.adb.error }}</div>

          <div>
            <div style="margin-bottom: 6px">Custom adb path</div>
            <input
              v-model="draft.adbPath"
              placeholder="Leave empty to use PATH"
              class="mono"
              style="width: 100%; background: var(--panel-2); border: 1px solid var(--border); border-radius: 9px; padding: 7px 10px; color: var(--text); font-size: 12px"
            />
          </div>

          <div class="row wrap" style="gap: 8px">
            <button class="btn btn-sm" @click="restartAdb"><Icon name="refresh" :size="13" /> Restart adb server</button>
            <button class="btn btn-sm" @click="openPlatformTools"><Icon name="external" :size="13" /> Get platform tools</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Device</div>
            <div class="card-sub">{{ state.device ? state.device.model : 'No device connected' }}</div>
          </div>
          <Icon name="phone" :size="17" class="faint" />
        </div>

        <div class="stack" style="gap: 10px; font-size: 12.5px; color: var(--text-dim)">
          <template v-if="state.device">
            <div class="row" style="justify-content: space-between"><span>Serial</span><span class="mono faint">{{ state.device.serial }}</span></div>
            <div class="row" style="justify-content: space-between"><span>Android</span><span>{{ state.device.androidVersion }}</span></div>
            <div class="row" style="justify-content: space-between"><span>SDK</span><span>{{ state.device.sdk }}</span></div>
            <div class="row" style="justify-content: space-between"><span>Bulk stat</span><span>{{ state.device.capabilities.bulkStat ? 'supported' : 'no' }}</span></div>
            <div class="row" style="justify-content: space-between">
              <span>/sdcard/Android readable</span>
              <span>{{ state.device.capabilities.androidDataReadable ? 'yes' : 'hidden by Android' }}</span>
            </div>
          </template>
          <div v-else class="muted">Connect a phone to see its capabilities here.</div>

          <label class="row" style="gap: 10px; cursor: pointer; align-items: flex-start; border-top: 1px solid var(--border-soft); padding-top: 10px">
            <input v-model="draft.useMockDevice" class="checkbox" type="checkbox" style="margin-top: 3px" />
            <span>
              Use the built-in demo device
              <span class="faint" style="display: block; font-size: 12px">
                A simulated Pixel with fixture files. Useful to try the whole flow without a cable.
              </span>
            </span>
          </label>

          <button class="btn btn-sm" style="align-self: flex-start" @click="openDemo">
            <Icon name="phone" :size="13" /> Open demo device
          </button>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">About</div>
            <div class="card-sub">MangoMobile {{ state.info?.version ?? '' }}</div>
          </div>
        </div>
        <div class="stack" style="gap: 8px; font-size: 12.5px; color: var(--text-dim)">
          <div class="row" style="justify-content: space-between"><span>Electron</span><span>{{ state.info?.electron ?? '—' }}</span></div>
          <div class="row" style="justify-content: space-between"><span>Platform</span><span>{{ state.info?.platform ?? '—' }}</span></div>
          <div class="row" style="justify-content: space-between; gap: 10px">
            <span>Data folder</span>
            <span class="mono faint" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ state.info?.userDataDir }}</span>
          </div>
          <button class="btn btn-sm" style="align-self: flex-start" @click="openDataDir">
            <Icon name="external" :size="13" /> Open data folder
          </button>
          <div class="faint" style="font-size: 11.5px; line-height: 1.6">
            Inspired by MangoDisk. Licensed under GPL-3.0-only. All cleanup happens on your own device; nothing is uploaded.
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
