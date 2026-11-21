<script setup lang="ts">
import { dismissToast, state } from '@/store'
import Icon from './Icon.vue'

const icons: Record<string, string> = { info: 'alert', ok: 'check', warn: 'alert', error: 'alert' }
</script>

<template>
  <div class="toast-host">
    <TransitionGroup name="fade">
      <div v-for="toast in state.toasts" :key="toast.id" class="toast" :class="toast.type">
        <div class="row" style="align-items: flex-start; gap: 10px">
          <Icon :name="icons[toast.type] ?? 'alert'" :size="16" />
          <div style="flex: 1">
            <strong>{{ toast.title }}</strong>
            <span v-if="toast.message">{{ toast.message }}</span>
          </div>
          <button class="btn-ghost btn btn-sm" style="padding: 2px 6px" @click="dismissToast(toast.id)">
            <Icon name="close" :size="13" />
          </button>
        </div>
      </div>
    </TransitionGroup>
  </div>
</template>
