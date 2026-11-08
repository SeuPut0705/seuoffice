/**
 * The cover preview of a built-in design template, for the AI panel's template
 * gallery: the template's sample cover is built with the same page builder a
 * generated page goes through, opened in memory and laid out like any slide,
 * and the render tree of that one slide goes to the renderer, which draws it
 * with the slide navigator's thumbnail drawing.
 *
 * The renderer names a catalog id and a cover language only; the spec is looked
 * up here. Covers carry no images, so nothing is fetched, and the pptx never
 * leaves memory. No open document is read or changed.
 */
import { ipcMain } from 'electron'
import { buildPagePptx, parsePageSpec } from '@genoffice/pipelines/slides'
import { listSlideTemplates } from '@genoffice/pipelines/slides/templates'
import { openPptx } from '@genoffice/pptx-engine'
import type { RenderSlide } from '@genoffice/pptx-render'
import type { TemplateCoverLang } from '../shared/ipc'
import { buildAllRenderSlides, getFontMetrics } from './session-state'

/** The width the editor lays slides out at (the renderer's FIT_WIDTH), so the preview matches the canvas */
const COVER_FIT_WIDTH_PX = 1280

const covers = new Map<string, Promise<RenderSlide | null>>()

async function buildCover(id: string, lang: TemplateCoverLang): Promise<RenderSlide | null> {
  const template = listSlideTemplates().find((t) => t.id === id)
  if (!template) return null
  const parsed = parsePageSpec(JSON.stringify(template.sampleCover[lang]))
  if (!parsed.ok) return null
  const metrics = getFontMetrics()
  const { bytes } = await buildPagePptx(parsed.spec, {
    fetchImage: async () => null,
    fontMetrics: metrics,
  })
  const opened = await openPptx(bytes)
  return buildAllRenderSlides(opened, COVER_FIT_WIDTH_PX)[0] ?? null
}

/**
 * The render tree of a template's sample cover; null for anything that is not
 * a catalog id with `ko` or `en`, or when the cover could not be built. Answers
 * are kept per (id, language); a failure is not kept, so the next ask retries.
 */
export function renderTemplateCover(id: unknown, lang: unknown): Promise<RenderSlide | null> {
  if (typeof id !== 'string' || (lang !== 'ko' && lang !== 'en')) return Promise.resolve(null)
  if (!listSlideTemplates().some((t) => t.id === id)) return Promise.resolve(null)
  const key = `${id}\n${lang}`
  const cached = covers.get(key)
  if (cached) return cached
  const pending = buildCover(id, lang).catch(() => null)
  covers.set(key, pending)
  void pending.then((slide) => {
    if (!slide) covers.delete(key)
  })
  return pending
}

/** Register slides:template-cover-render (called from registerSlidesIpc, which the shell runs too). */
export function registerTemplateCoverIpc(): void {
  ipcMain.handle('slides:template-cover-render', (_e, id: unknown, lang: unknown) =>
    renderTemplateCover(id, lang),
  )
}
