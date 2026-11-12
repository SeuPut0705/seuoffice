import { listEmbeddedFonts, openPptx, parseTheme, type OpenedPptx } from '@seuoffice/pptx-engine'
import carlitoRegular from '@seuoffice/ui/fonts/Carlito-Regular.ttf?asset'
import carlitoBold from '@seuoffice/ui/fonts/Carlito-Bold.ttf?asset'
import carlitoItalic from '@seuoffice/ui/fonts/Carlito-Italic.ttf?asset'
import carlitoBoldItalic from '@seuoffice/ui/fonts/Carlito-BoldItalic.ttf?asset'
import hbWasmUrl from '../../../../node_modules/harfbuzzjs/dist/harfbuzz.wasm?asset'
import { reportError, type WebDocument } from '@seuoffice/web-platform'
import { registerEmbeddedFonts } from '../main/fonts'
import { listMetafileFonts } from '../main/metafile-fonts'
import {
  buildAllRenderSlides,
  getFontMetrics,
  readSlideMedia,
  resetFontMetrics,
  type Session,
} from '../main/session-state'
import { shapedMetricsReady } from '../main/shaped-metrics'
import type { RenderSlide } from '@seuoffice/pptx-render'
import type { OpenResult } from '../shared/ipc'
import { setDeck } from './deck-reads'
import { putFile } from './memfs'
import { loadTemplateFontsFor } from './template-fonts'

const MEDIA_SCHEME = 'seuoffice-slide-media://'
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

/** Files the font code reads at the paths fonts.ts and shaped-metrics.ts know them by */
let fontFilesReady: Promise<void> | undefined
function loadFontFiles(): Promise<void> {
  fontFilesReady ??= Promise.all(
    [carlitoRegular, carlitoBold, carlitoItalic, carlitoBoldItalic, hbWasmUrl].map(async (url) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`seuoffice web: ${url} answered ${response.status}`)
      putFile(url, new Uint8Array(await response.arrayBuffer()))
    }),
  ).then(() => undefined)
  return fontFilesReady
}

/** slides-main.ts adoptEmbeddedFonts: the deck's embedded faces, then the metafile pictures' facenames */
function adoptEmbeddedFonts(opened: OpenedPptx): void {
  try {
    if (registerEmbeddedFonts(listEmbeddedFonts(opened.archive))) resetFontMetrics()
  } catch {
    // embedded fonts are best-effort: a malformed fntdata must never block opening
  }
  try {
    const metrics = getFontMetrics()
    for (const f of listMetafileFonts(opened.archive))
      metrics.displayFamily?.({
        fontFamily: f.family,
        fontSizePx: 100,
        bold: f.bold,
        italic: f.italic,
      })
  } catch {
    // best-effort as well
  }
}

/** slides-main.ts deckDefaultFont */
function deckDefaultFont(opened: OpenedPptx): string | undefined {
  try {
    const slidePath = opened.archive.readPresentation().slidePaths[0]
    if (!slidePath) return undefined
    const themePath = opened.archive.resolveSlideChain(slidePath).themePath
    const xml = themePath ? opened.archive.readText(themePath) : undefined
    return xml ? parseTheme(xml).minorFont : undefined
  } catch {
    return undefined
  }
}

const METAFILE_MIME = /^image\/(?:x-)?(?:emf|wmf)$/

function base64Of(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/**
 * The page cannot reach the desktop's media scheme, so every media URL becomes a blob URL of the
 * bytes the desktop would have served. EMF and WMF stay data URLs: the renderer's metafile
 * rasterizer keys on that form.
 */
function mediaUrlFor(url: string): string {
  const media = readSlideMedia(url)
  if (!media) return url
  if (METAFILE_MIME.test(media.mime)) return `data:${media.mime};base64,${base64Of(media.body)}`
  return URL.createObjectURL(new Blob([media.body.slice()], { type: media.mime }))
}

/** Desktop media URL to the page URL standing for it, kept for the page's lifetime */
const pageUrls = new Map<string, string>()

/** Replace every media URL string in the tree, one blob per distinct URL */
function resolveMedia(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith(MEDIA_SCHEME)) return value
    let resolved = pageUrls.get(value)
    if (resolved === undefined) pageUrls.set(value, (resolved = mediaUrlFor(value)))
    return resolved
  }
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = resolveMedia(value[i])
    return value
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) record[key] = resolveMedia(record[key])
  return value
}

/** Render state built by the desktop helpers, with its media URLs made reachable from the page */
export function forPage<T>(rendered: T): T {
  return resolveMedia(rendered) as T
}

let session: Session | undefined

/** The open deck with its history, in the shape the desktop's main process keeps per window */
export function currentSession(): Session | undefined {
  return session
}

/** Every slide of the open deck, laid out for the width the renderer last asked for */
export function renderDeck(): RenderSlide[] | null {
  return session ? forPage(buildAllRenderSlides(session.opened, session.fitWidthPx)) : null
}

/**
 * main/slides-main.ts preparePptxOpen + openAndBuild for a document the page already holds: no
 * password prompt, recovery, recent files or session registry. The result is what the desktop's
 * `slides:open-path` answers, with media as blob URLs. Null (after telling the host) when the
 * deck cannot be shown.
 */
export async function openPptxForWeb(
  doc: WebDocument,
  fitWidthPx: number,
): Promise<OpenResult | null> {
  // main/cfb-sniff.ts: legacy .ppt and password-protected OOXML share this header
  if (doc.bytes.length >= CFB_MAGIC.length && CFB_MAGIC.every((byte, i) => doc.bytes[i] === byte)) {
    reportError('open_failed', 'encrypted or legacy presentations are not supported on the web yet')
    return null
  }
  try {
    await loadFontFiles()
    await shapedMetricsReady()
    const opened = await openPptx(doc.bytes)
    if (await loadTemplateFontsFor(opened.archive)) resetFontMetrics()
    adoptEmbeddedFonts(opened)
    setDeck(opened)
    session = {
      path: doc.virtualPath,
      opened,
      fitWidthPx,
      undoStack: [],
      redoStack: [],
    }
    return {
      path: doc.virtualPath,
      slides: renderDeck() ?? [],
      size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
      defaultFont: deckDefaultFont(opened),
    }
  } catch (error) {
    reportError('open_failed', error instanceof Error ? error.message : String(error))
    return null
  }
}
