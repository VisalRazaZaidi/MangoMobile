<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { loadApps, state, trimCaches, uninstallApp } from '@/store'
import { formatBytes } from '@/lib/format'
import Icon from '@/components/Icon.vue'
import EmptyState from '@/components/EmptyState.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import type { InstalledApp } from '@shared/types'

const search = ref('')
const showSystem = ref(false)
const sortKey = ref<'size' | 'name'>('size')
const target = ref<InstalledApp | null>(null)
const uninstalling = ref(false)

onMounted(() => {
  if (state.device && !state.apps) void loadApps()
})

const all = computed(() => state.apps?.apps ?? [])

const visible = computed(() => {
  const query = search.value.trim().toLowerCase()
  const filtered = all.value.filter((app) => {
    if (!showSystem.value && app.system) return false
    if (!query) return true
    return app.label.toLowerCase().includes(query) || app.packageName.toLowerCase().includes(query)
  })
  return [...filtered].sort((a, b) => (sortKey.value === 'size' ? b.apkBytes - a.apkBytes : a.label.localeCompare(b.label)))
})

const userApps = computed(() => all.value.filter((app) => !app.system))
const sized = computed(() => all.value.filter((app) => app.sized))
const largest = computed(() => [...all.value].sort((a, b) => b.apkBytes - a.apkBytes).slice(0, 5))

async function confirmUninstall(): Promise<void> {
  if (!target.value) return
  uninstalling.value = true
  try {
    await uninstallApp(target.value.packageName)
    target.value = null
  } finally {
    uninstalling.value = false
  }
}
</script>

<template>
  <div class="page-head">
    <div>
      <h2 class="page-title">Apps</h2>
      <p class="page-sub">Review installed apps and their available sizes. You can trim caches or uninstall apps you no longer need.</p>
    </div>
    <div class="row" style="gap: 8px">
      <button class="btn" :disabled="state.appsLoading" @click="loadApps">
        <Icon name="refresh" :size="15" /> Refresh
      </button>
      <button class="btn btn-primary" :disabled="!state.device || Boolean(state.operation)" @click="trimCaches">
        <Icon name="broom" :size="15" /> Trim all caches
      </button>
    </div>
  </div>

  <div v-if="!state.apps" class="card">
    <EmptyState
      icon="apps"
      :title="state.appsLoading ? 'Reading packages…' : 'App sizes not loaded yet'"
      message="Package names and APK sizes come straight from the phone over ADB. No account, no cloud lookup."
      :action-label="state.appsLoading ? '' : 'Load apps'"
      @action="loadApps"
    />
  </div>

  <template v-else>
    <div v-if="!state.apps.available" class="card">
      <div class="warn-box">{{ state.apps.message }}</div>
    </div>

    <div class="grid cols-4">
      <div class="kpi">
        <div class="kpi-label">Installed apps</div>
        <div class="kpi-value">{{ all.length.toLocaleString() }}</div>
        <div class="kpi-note">{{ userApps.length.toLocaleString() }} installed by you · {{ all.length - userApps.length }} system</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">APK size</div>
        <div class="kpi-value">{{ formatBytes(state.apps.totalApkBytes) }}</div>
        <div class="kpi-note">exact, read from the package paths</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Device cache</div>
        <div class="kpi-value" style="color: var(--accent)">
          {{ state.apps.totalCacheBytes ? formatBytes(state.apps.totalCacheBytes) : '—' }}
        </div>
        <div class="kpi-note">system-wide figure from diskstats</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">App data</div>
        <div class="kpi-value">{{ state.apps.totalDataBytes ? formatBytes(state.apps.totalDataBytes) : '—' }}</div>
        <div class="kpi-note">read-only estimate, removal is per-app</div>
      </div>
    </div>

    <div v-if="state.apps.message" class="info-box">{{ state.apps.message }}</div>

    <div class="grid" style="grid-template-columns: 1.5fr 1fr; align-items: start">
      <div class="card tight" style="padding: 0">
        <div class="row wrap" style="gap: 12px; padding: 14px 16px">
          <div class="row" style="gap: 8px; flex: 1; min-width: 200px">
            <Icon name="search" :size="15" class="faint" />
            <input
              v-model="search"
              placeholder="Search apps or package names…"
              style="flex: 1; background: var(--panel-2); border: 1px solid var(--border); border-radius: 9px; padding: 7px 10px; color: var(--text); font-size: 13px; outline: none"
            />
          </div>
          <div class="pill-toggle">
            <button :class="{ active: sortKey === 'size' }" @click="sortKey = 'size'">Largest</button>
            <button :class="{ active: sortKey === 'name' }" @click="sortKey = 'name'">Name</button>
          </div>
          <label class="row muted" style="gap: 7px; font-size: 12.5px; cursor: pointer">
            <input v-model="showSystem" class="checkbox" type="checkbox" />
            Show system apps
          </label>
        </div>

        <div class="scroll-area" style="max-height: calc(100vh - 430px)">
          <table class="table">
            <thead>
              <tr>
                <th>App</th>
                <th class="num">APK size</th>
                <th class="num"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="app in visible" :key="app.packageName">
                <td class="path">
                  <div class="row" style="gap: 9px">
                    <div
                      class="brand-mark"
                      style="width: 26px; height: 26px; border-radius: 8px; font-size: 12px; box-shadow: none"
                    >
                      {{ app.label.slice(0, 1).toUpperCase() }}
                    </div>
                    <div style="min-width: 0">
                      <div style="color: var(--text); font-weight: 600; font-size: 13px">{{ app.label }}</div>
                      <div class="mono faint" style="font-size: 11px">{{ app.packageName }}</div>
                    </div>
                  </div>
                </td>
                <td class="num" style="color: var(--text); font-weight: 600">
                  {{ app.sized ? formatBytes(app.apkBytes) : '—' }}
                </td>
                <td class="num" style="width: 128px">
                  <div class="row" style="justify-content: flex-end; gap: 6px">
                    <span v-if="app.system" class="badge">system</span>
                    <button v-else class="btn btn-sm btn-danger" @click="target = app">Uninstall</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="!visible.length" class="empty">
            <h4>No apps match</h4>
            <p>Try a different search, or enable system apps.</p>
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card tight">
          <div class="card-title" style="margin-bottom: 10px">Heaviest installs</div>
          <div class="stack" style="gap: 8px">
            <div
              v-for="app in largest"
              :key="app.packageName"
              class="row"
              style="justify-content: space-between; font-size: 12.5px; gap: 10px"
            >
              <span class="muted" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ app.label }}</span>
              <b style="white-space: nowrap">{{ app.sized ? formatBytes(app.apkBytes) : '—' }}</b>
            </div>
            <div v-if="!largest.length" class="muted" style="font-size: 12.5px">Nothing reported.</div>
          </div>
        </div>

        <div class="card tight">
          <div class="card-title" style="margin-bottom: 8px">Why sizes are partial</div>
          <div class="stack" style="gap: 8px; font-size: 12.5px; color: var(--text-dim); line-height: 1.6">
            <div>
              Android 11 and newer keep <span class="mono">/sdcard/Android/data</span> outside the reach of the ADB shell
              user, so per-app cache folders cannot be measured without root.
            </div>
            <div>
              “Trim all caches” asks the system to reclaim rebuildable cache data immediately. Uninstall uses
              <span class="mono">pm uninstall --user 0</span>, which removes the app for you without touching the system
              image.
            </div>
          </div>
        </div>

        <div v-if="sized.length !== all.length" class="info-box">
          {{ all.length - sized.length }} package(s) did not report an APK size. Those are usually split or system
          packages whose code path is not readable by the shell.
        </div>
      </div>
    </div>
  </template>

  <ConfirmDialog
    :open="Boolean(target)"
    danger
    :busy="uninstalling"
    title="Uninstall this app?"
    confirm-label="Uninstall for this user"
    @cancel="target = null"
    @confirm="confirmUninstall"
  >
    <template v-if="target">
      <div class="info-box">
        <div><b>{{ target.label }}</b> · <span class="mono">{{ target.packageName }}</span></div>
        <div class="faint" style="margin-top: 6px">
          Runs <span class="mono">pm uninstall --user 0 {{ target.packageName }}</span> on the phone. App data for this user is
          removed; reinstalling from the Play Store does not restore it.
        </div>
      </div>
    </template>
  </ConfirmDialog>
</template>
