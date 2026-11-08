/**
 * The template gallery's cover previews on the renderer side: which of the two
 * sample covers a UI language shows, and the covers asked of the main process
 * (slides:template-cover-render), kept per template and language so reopening
 * the gallery draws at once. No AI and no network are involved.
 */
import type { Lang } from '@genoffice/i18n'
import type { RenderSlide } from '@genoffice/pptx-render'
import type { TemplateCoverLang } from '../../shared/ipc'

/** A Korean UI shows the Korean cover; the other 20 languages show the English one */
export function templateCoverLang(lang: Lang): TemplateCoverLang {
  return lang === 'ko' ? 'ko' : 'en'
}

const covers = new Map<string, Promise<RenderSlide | null>>()

/**
 * The cover of a built-in template as a render tree, or null when it cannot be
 * had (a stale preload, a failed build). A failure is not kept.
 */
export function loadTemplateCover(
  id: string,
  lang: TemplateCoverLang,
): Promise<RenderSlide | null> {
  const key = `${id}\n${lang}`
  const cached = covers.get(key)
  if (cached) return cached
  const pending = (async () => {
    try {
      const slide = await window.slidesApi.renderTemplateCover(id, lang)
      return slide && Array.isArray(slide.nodes) ? slide : null
    } catch {
      return null
    }
  })()
  covers.set(key, pending)
  void pending.then((slide) => {
    if (!slide) covers.delete(key)
  })
  return pending
}

/** Forget the kept covers (tests) */
export function clearTemplateCoverCache(): void {
  covers.clear()
}
