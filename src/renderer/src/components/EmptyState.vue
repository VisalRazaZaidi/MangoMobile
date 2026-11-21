<script setup lang="ts">
import Icon from './Icon.vue'

withDefaults(
  defineProps<{
    icon?: string
    title: string
    message: string
    actionLabel?: string
    secondaryLabel?: string
  }>(),
  { icon: 'files', actionLabel: '', secondaryLabel: '' }
)

const emit = defineEmits<{ (event: 'action'): void; (event: 'secondary'): void }>()
</script>

<template>
  <div class="empty">
    <div
      class="brand-mark"
      style="width: 46px; height: 46px; border-radius: 14px; background: var(--accent-soft); color: var(--accent); box-shadow: none"
    >
      <Icon :name="icon" :size="22" />
    </div>
    <h4>{{ title }}</h4>
    <p>{{ message }}</p>
    <div class="row" style="gap: 10px; margin-top: 6px">
      <button v-if="actionLabel" class="btn btn-primary" @click="emit('action')">{{ actionLabel }}</button>
      <button v-if="secondaryLabel" class="btn" @click="emit('secondary')">{{ secondaryLabel }}</button>
    </div>
  </div>
</template>
