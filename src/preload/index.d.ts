import type { MangoApi } from '@shared/types'

declare global {
  interface Window {
    api: MangoApi
  }
}

export {}
