<script setup lang="ts">
defineProps<{ name: string; size?: number }>()

const paths: Record<string, string> = {
  dashboard:
    'M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v11h-7zM3 13h7v8H3z',
  broom:
    'M14 3l7 7-3 3-7-7zM9 10l5 5-4 4a3 3 0 01-4 0 3 3 0 010-4zM4 20l2-2',
  files:
    'M13 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V9zM13 3v6h6',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  copy:
    'M9 9h10v12H9zM5 15V3h10',
  image:
    'M3 5h18v14H3zM3 15l5-4 4 3 3-2 6 5',
  apps:
    'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  trash:
    'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6',
  history:
    'M12 8v5l3 2M3 12a9 9 0 109-9 9 9 0 00-7.5 4M3 4v5h5',
  settings:
    'M12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7zM19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2 2 2 0 11-4 0 1.7 1.7 0 00-2.9-1.2l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 004 15a2 2 0 110-4 1.7 1.7 0 001.2-2.9l-.1-.1a2 2 0 112.8-2.8l.1.1A1.7 1.7 0 0011 4.1 2 2 0 1115 4a1.7 1.7 0 002.9 1.2l.1-.1a2 2 0 112.8 2.8l-.1.1A1.7 1.7 0 0020 11a2 2 0 110 4',
  scan: 'M3 8V5a2 2 0 012-2h3M16 3h3a2 2 0 012 2v3M21 16v3a2 2 0 01-2 2h-3M8 21H5a2 2 0 01-2-2v-3M3 12h18',
  phone:
    'M7 2h10a2 2 0 012 2v16a2 2 0 01-2 2H7a2 2 0 01-2-2V4a2 2 0 012-2zM11 18h2',
  refresh: 'M21 12a9 9 0 11-3-6.7M21 3v6h-6',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M4 12l5 5L20 6',
  alert: 'M12 3l9 17H3zM12 9v5M12 17h.01',
  external: 'M14 4h6v6M20 4l-8 8M18 14v5a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h5',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
  table: 'M3 5h18v14H3zM3 10h18M9 10v9M15 10v9',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  arrowLeft: 'M15 18l-6-6 6-6',
  arrowUp: 'M12 19V5M5 12l7-7 7 7',
  download: 'M12 3v12M7 11l5 5 5-5M5 21h14',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  chip: 'M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M7 7h10v10H7z',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5'
}
</script>

<template>
  <svg
    :width="size ?? 18"
    :height="size ?? 18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] ?? paths.dashboard" />
  </svg>
</template>
