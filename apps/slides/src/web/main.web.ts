import '@seuoffice/web-platform/globals'
import { installBridges } from './bridge'

installBridges()
// dynamic so the renderer's modules evaluate after window.slidesApi exists; static imports would hoist above it
await import('../renderer/main')
