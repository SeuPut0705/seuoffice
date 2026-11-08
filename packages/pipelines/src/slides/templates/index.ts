// Renderer-safe entry (`@genoffice/pipelines/slides/templates`): data and lookup only.
// The validator lives in '../template-check' because it builds pages with pptx-engine (Node only).
import { SLIDE_TEMPLATES } from './catalog'
import type { SlideTemplate } from './contract'

export * from './contract'

/** Every built-in template, in display order. */
export function listSlideTemplates(): readonly SlideTemplate[] {
  return SLIDE_TEMPLATES
}

/** The template with this id or name (case-insensitive), or undefined. */
export function findSlideTemplate(idOrName: string): SlideTemplate | undefined {
  const key = String(idOrName ?? '')
    .trim()
    .toLowerCase()
  if (!key) return undefined
  return SLIDE_TEMPLATES.find((t) => t.id.toLowerCase() === key || t.name.toLowerCase() === key)
}
