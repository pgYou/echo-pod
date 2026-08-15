import type { EchoPodApi } from './index'

declare global {
  interface Window {
    api: EchoPodApi
  }
}

export {}
