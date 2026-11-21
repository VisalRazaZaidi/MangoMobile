<script setup lang="ts">
import Icon from './Icon.vue'
import { nextTick, ref, useId, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    message?: string
    confirmLabel?: string
    cancelLabel?: string
    danger?: boolean
    busy?: boolean
  }>(),
  { confirmLabel: 'Confirm', cancelLabel: 'Cancel', danger: false, busy: false, message: '' }
)

const emit = defineEmits<{ (event: 'confirm'): void; (event: 'cancel'): void }>()
const panel = ref<HTMLElement | null>(null)
const titleId = useId()
let previousFocus: HTMLElement | null = null
watch(() => props.open, async open => {
  if (open) {
    previousFocus = document.activeElement as HTMLElement
    await nextTick()
    panel.value?.querySelector<HTMLButtonElement>('.modal-foot button')?.focus()
  } else previousFocus?.focus()
})
function handleKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !props.busy) emit('cancel')
  if (event.key !== 'Tab') return
  const controls = [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])]
  const first = controls[0], last = controls[controls.length - 1]
  if (!first) { event.preventDefault(); return }
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
</script>

<template>
  <Transition name="fade">
    <div v-if="open" class="modal-backdrop" @click.self="!busy && emit('cancel')">
      <div ref="panel" class="modal" role="dialog" aria-modal="true" :aria-labelledby="titleId" style="width: min(560px, 100%)" @keydown="handleKey">
        <div class="modal-head">
          <div class="row" style="gap: 10px">
            <div
              class="brand-mark"
              :style="{
                width: '32px',
                height: '32px',
                borderRadius: '10px',
                background: danger ? 'var(--danger-icon-fill)' : 'var(--brand-icon-fill)',
                color: danger ? 'var(--danger-soft-ink)' : 'var(--accent)',
                boxShadow: 'none'
              }"
            >
              <Icon :name="danger ? 'alert' : 'shield'" :size="17" />
            </div>
            <div>
              <div :id="titleId" class="card-title">{{ title }}</div>
            </div>
          </div>
        </div>
        <div class="modal-body">
          <p v-if="message" style="margin: 0; color: var(--text-dim); line-height: 1.6; font-size: 13px">{{ message }}</p>
          <slot />
        </div>
        <div class="modal-foot">
          <button class="btn" :disabled="busy" @click="emit('cancel')">{{ cancelLabel }}</button>
          <button class="btn" :class="danger ? 'btn-danger' : 'btn-primary'" :disabled="busy" @click="emit('confirm')">
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
