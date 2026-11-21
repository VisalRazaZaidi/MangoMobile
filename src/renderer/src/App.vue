<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { boot, onProgress, state } from '@/store'
import SideBar from '@/components/SideBar.vue'
import Icon from '@/components/Icon.vue'
import TopBar from '@/components/TopBar.vue'
import Toasts from '@/components/Toasts.vue'
import FilePreview from '@/components/FilePreview.vue'
import { preview } from '@/preview'
import OverviewView from '@/views/OverviewView.vue'
import CleanView from '@/views/CleanView.vue'
import LargeFilesView from '@/views/LargeFilesView.vue'
import AnalysisView from '@/views/AnalysisView.vue'
import DuplicatesView from '@/views/DuplicatesView.vue'
import MediaView from '@/views/MediaView.vue'
import AppsView from '@/views/AppsView.vue'
import TrashView from '@/views/TrashView.vue'
import HistoryView from '@/views/HistoryView.vue'
import SettingsView from '@/views/SettingsView.vue'
import WelcomeView from '@/views/WelcomeView.vue'

const views = {
  overview: OverviewView,
  clean: CleanView,
  large: LargeFilesView,
  analysis: AnalysisView,
  duplicates: DuplicatesView,
  media: MediaView,
  apps: AppsView,
  trash: TrashView,
  history: HistoryView,
  settings: SettingsView
}

const currentView = computed(() => views[state.view] ?? OverviewView)

const operationPercent = computed(() => {
  const operation = state.operation
  if (!operation || operation.total <= 0) return 0
  return Math.min(100, (operation.done / operation.total) * 100)
})

let unsubscribe: (() => void) | null = null

onMounted(() => {
  unsubscribe = window.api.onProgress(onProgress)
  void boot()
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>

<template>
  <div v-if="!state.booted" class="boot">
    <div class="brand-mark" style="width: 46px; height: 46px; border-radius: 14px; font-size: 20px">M</div>
    <div class="boot-title">MangoMobile</div>
    <div class="boot-sub">Looking for adb and connected phones…</div>
  </div>

  <WelcomeView v-else-if="!state.device" />

  <div v-else class="app-shell">
    <SideBar />
    <main class="main" :class="{ 'preview-open': preview.file }">
      <TopBar />
      <div class="content">
        <component :is="currentView" />
      </div>
    </main>
  </div>

  <Transition name="fade">
    <div v-if="state.operation" class="modal-backdrop">
      <div class="modal" style="width: min(420px, 100%)">
        <div class="modal-body" style="padding-top: 22px">
          <div class="row" style="gap: 12px; align-items: flex-start">
            <div class="brand-mark" style="width: 36px; height: 36px; border-radius: 11px; box-shadow: none">
              <Icon name="broom" :size="18" />
            </div>
            <div style="flex: 1">
              <div class="card-title">{{ state.operation.title }}</div>
              <div class="card-sub">
                <template v-if="state.operation.total > 0">
                  {{ state.operation.done }} of {{ state.operation.total }} finished
                </template>
                <template v-else>Working on the phone…</template>
              </div>
              <div class="progress" :class="{ indeterminate: state.operation.total <= 0 }" style="margin-top: 12px">
                <span :style="{ width: `${operationPercent}%` }" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>

  <Toasts />
  <FilePreview />
</template>
