import type { QuickLookWindowApi } from '../../../shared/quick-look-api'
import type { QuickLookHomeApi } from '../../../shared/quick-look-home'

declare global {
  interface Window {
    aiOfficeQuickLook?: QuickLookWindowApi
    aiOfficeQuickLookHome?: QuickLookHomeApi
  }
}

export {}
