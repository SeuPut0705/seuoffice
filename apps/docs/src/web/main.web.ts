import '@seuoffice/web-platform/globals'
import { viewMode } from '@seuoffice/web-platform'
import { installBridges } from './bridge'

// The ribbon starts collapsed (a density value readRibbonDensity understands) so a document
// opened for viewing gets the whole window; the user can still expand it.
if (viewMode()) {
  try {
    localStorage.setItem('aidocs.ribbonCollapsed', 'collapsed')
  } catch {
    /* storage blocked: the ribbon just starts expanded */
  }
}
installBridges()
// dynamic so the renderer's modules evaluate after window.desktop exists; static imports would hoist above it
await import('../renderer/main')
