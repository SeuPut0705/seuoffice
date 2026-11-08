// The read-only half of the desktop's `slides:*` handlers (main/slides-main.ts), answering from the
// deck this page opened instead of a main-process session. Every getter answers like a window
// without a session when no deck is open.
import {
  elementSpid,
  getElementLink,
  getRunLinks,
  getSections,
  getSlideAnimations,
  getSlideComments,
  getSlideLinks,
  getSlideNotes,
  getSlideTransition,
  listSlideLayouts,
  readHeaderFooter,
  type OpenedPptx,
} from '@genoffice/pptx-engine'
import { tm } from '../main/i18n-main'
import type { AnimationItem, ShapeKey, SlidesApi } from '../shared/ipc'

let deck: OpenedPptx | undefined

/** The deck the getters answer for */
export function setDeck(opened: OpenedPptx): void {
  deck = opened
}

/** XML attribute text to a string (main/slides-main.ts decodeXmlAttr) */
function decodeXmlAttr(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (m, hex, dec, name) => {
    const code = hex ? parseInt(hex, 16) : dec ? parseInt(dec, 10) : NaN
    if (Number.isFinite(code)) return code <= 0x10ffff ? String.fromCodePoint(code) : m
    return named[String(name).toLowerCase()] ?? m
  })
}

const AV_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  // Chromium refuses video/quicktime but demuxes the bytes as video/mp4
  mov: 'video/mp4',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
}

export const deckReads: Partial<SlidesApi> = {
  getSlideSize: async () => (deck ? { ...deck.deck.size } : null),
  getLayouts: async () =>
    deck ? { layouts: listSlideLayouts(deck.archive), size: { ...deck.deck.size } } : null,
  getTransition: async (slideIndex) => {
    const slide = deck?.deck.slides[slideIndex]
    return slide ? getSlideTransition(slide) : 'none'
  },
  getNotes: async (slideIndex) => {
    const slide = deck?.deck.slides[slideIndex]
    return deck && slide ? getSlideNotes(deck.archive, slide.path) : ''
  },
  getComments: async (slideIndex) => {
    const slide = deck?.deck.slides[slideIndex]
    return deck && slide ? getSlideComments(deck.archive, slide.path) : []
  },
  getAllComments: async () =>
    deck ? deck.deck.slides.map((slide) => getSlideComments(deck!.archive, slide.path)) : [],
  getSections: async () => (deck ? getSections(deck) : []),
  getHeaderFooter: async (slideIndex) => {
    const slide = deck?.deck.slides[slideIndex]
    return slide ? readHeaderFooter(slide) : { footer: null, slideNum: false, date: null }
  },
  getLink: async (slideIndex, sourceId) =>
    deck ? getElementLink(deck, slideIndex, sourceId) : null,
  getSlideLinks: async (slideIndex) =>
    deck
      ? getSlideLinks(deck, slideIndex).map(({ elementId, target }) => ({
          sourceId: elementId,
          target,
        }))
      : [],
  getRunLinks: async (slideIndex) =>
    deck
      ? getRunLinks(deck, slideIndex).map(({ elementId, ...rest }) => ({
          sourceId: elementId,
          ...rest,
        }))
      : [],
  getAnimations: async (slideIndex): Promise<AnimationItem[]> => {
    const slide = deck?.deck.slides[slideIndex]
    if (!slide) return []
    const bySpid = new Map<number, (typeof slide.elements)[number]>()
    for (const el of slide.elements) {
      const spid = elementSpid(el)
      if (spid != null && !bySpid.has(spid)) bySpid.set(spid, el)
    }
    const typeLabel: Record<string, string> = {
      text: tm('labelTextBox'),
      shape: tm('labelShape'),
      picture: tm('labelPicture'),
      group: tm('labelGroup'),
      table: tm('labelTable'),
      chart: tm('labelChart'),
      passthrough: tm('labelObject'),
    }
    const out: AnimationItem[] = []
    for (const a of getSlideAnimations(slide)) {
      const el = bySpid.get(a.spid)
      if (!el) continue
      out.push({
        sourceId: el.id,
        targetName: el.name || typeLabel[el.type] || tm('labelObject'),
        effect: a.effect,
        trigger: a.trigger,
        durationMs: a.durationMs,
        delayMs: a.delayMs,
        ...(a.direction != null ? { direction: a.direction } : {}),
        ...(a.motionPath != null ? { motionPath: a.motionPath } : {}),
        ...(a.paragraph != null ? { paragraph: a.paragraph } : {}),
      })
    }
    return out
  },
  getShapeKeys: async (slideIndex): Promise<ShapeKey[]> => {
    const slide = deck?.deck.slides[slideIndex]
    if (!slide) return []
    return slide.elements.map((el) => {
      // hidden elements parse as passthroughs without a model name: read their own cNvPr
      const cNvPr = /<p:cNvPr\b[^>]*>/.exec(el.anchor?.originalXml ?? '')?.[0] ?? ''
      const rawName = /\sname="([^"]*)"/.exec(cNvPr)?.[1]
      return {
        sourceId: el.id,
        spid: elementSpid(el),
        name: el.name ?? (rawName ? decodeXmlAttr(rawName) : ''),
        ...(/\shidden="(?:1|true)"/.test(cNvPr) ? { hidden: true } : {}),
      }
    })
  },
  getMediaData: async (slideIndex, sourceId) => {
    const slide = deck?.deck.slides[slideIndex]
    const el = slide?.elements.find((x) => x.id === sourceId)
    if (!deck || !el || el.type !== 'picture') return null
    const media = el.media
    if (!media?.target) return null
    if (media.external) return { kind: media.kind, dataUrl: media.target }
    const bytes = deck.archive.readBytes(media.target)
    if (!bytes) return null
    const ext = media.target.split('.').pop()?.toLowerCase() ?? ''
    const mime = AV_MIME[ext] ?? (media.kind === 'video' ? 'video/mp4' : 'audio/mpeg')
    return {
      kind: media.kind,
      dataUrl: URL.createObjectURL(new Blob([bytes.slice()], { type: mime })),
    }
  },
}
