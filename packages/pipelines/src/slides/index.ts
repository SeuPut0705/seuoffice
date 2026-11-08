// Renderer code imports './layout-audit' by its own subpath: this entry pulls in pptx-engine (Node only).
export * from './page-spec'
export * from './deck-spec'
export * from './audit-deck'
export * from './layout-audit'
export { coverCropFractions } from './cover-crop'
export { SLIDES_GUIDES } from './guides'
export * from './outline'
export * from './stage-check'
// The templates folder is also its own renderer-safe subpath; the validator below is Node only.
export * from './templates/index'
export * from './template-check'
