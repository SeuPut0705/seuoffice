/**
 * Reads one ODF paragraph (`text:p` / `text:h`) into a character model: its
 * text exactly as the bridge shows it, the span/link "frames" around every
 * character, and the markers (bookmarks, kept inline elements) anchored at
 * character offsets.
 *
 * The same walk serves both directions. Forward it also calls registered
 * inline converters; on save it re-reads the ORIGINAL paragraph (taking
 * converter output lengths from the bridge record) to know which style each
 * original character had.
 *
 * White space follows ODF 1.2 §6.1.2 as LibreOffice applies it: runs of
 * space/tab/CR/LF collapse to one space, leading white space of the paragraph
 * is dropped, `text:s` / `text:tab` / `text:line-break` are literal.
 */
import { generateParagraphXml, type Run } from '@genoffice/docx-engine'
import type { OdtStyleTable, OdtStylePart } from '../core/styles'
import {
  type BridgeMarker,
  type BridgeParagraph,
  type OdfToOoxmlContext,
  type OdtPartInfo,
  markerBookmarkName,
} from '../core/convert'
import { type ElementRange, decodeXmlEntities, readAttributes, walkElements } from '../core/xml'
import type { OdfAttrs } from './props'

/** A span or hyperlink around characters. `open`/`close` are the tags to write back. */
export type Frame =
  | { kind: 'span'; style: string | null; open: string; close: string }
  | { kind: 'a'; href: string; style: string | null; open: string; close: string }

export interface FrameSet {
  frames: Frame[]
  key: string
  /** merged own text properties of the frames' styles (outer first, inner wins) */
  attrs: OdfAttrs
  /** innermost hyperlink, or null */
  href: string | null
}

export interface ParagraphModel {
  part: OdtStylePart
  range: ElementRange
  element: 'text:p' | 'text:h'
  /** element name as written */
  tag: string
  /** start tag as written (self-closing paragraphs: rewritten as an open tag) */
  openTag: string
  closeTag: string
  styleName: string | null
  outlineLevel: number | null
  text: string
  /** frame set index per character (-1 for characters produced by an inline converter) */
  charSets: number[]
  /** frame sets; index 0 is the empty set */
  sets: FrameSet[]
  /** frame set for text typed into an empty paragraph (its empty span) */
  emptySet: number
  markers: BridgeMarker[]
  /** forward: OOXML produced by inline converters, at offsets (document order) */
  splices: Array<{ offset: number; xml: string; seq: number }>
  /** document order of markers (same numbering as `splices.seq`) */
  markerSeq: number[]
}

export interface ReadParagraphSource {
  info: OdtPartInfo
  styles: OdtStyleTable
}

export interface ReadParagraphOptions {
  /** forward conversion: calls inline converters */
  forward?: { ctx: OdfToOoxmlContext; paragraphId: number }
  /** re-reading an original paragraph: lengths of converter output come from its record */
  record?: BridgeParagraph
}

const FRAME_NAMES = new Set(['text:span', 'text:a'])
const BOOKMARK_KINDS: Record<string, BridgeMarker['kind']> = {
  'text:bookmark': 'bookmark',
  'text:bookmark-start': 'bookmark-start',
  'text:bookmark-end': 'bookmark-end',
}

/** Inline elements that are never shown as text when no converter takes them. */
export function isInvisibleInline(name: string): boolean {
  if (/^(draw|dr3d|office|form|presentation|chart|table):/.test(name)) return true
  return /^text:(note|soft-page-break|change|change-start|change-end|reference-mark|reference-mark-start|reference-mark-end|toc-mark|toc-mark-start|toc-mark-end|alphabetical-index-mark|alphabetical-index-mark-start|alphabetical-index-mark-end|user-index-mark|user-index-mark-start|user-index-mark-end|number|list|p|h|section)$/.test(
    name,
  )
}

const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r'

/** A Hancom form field ("누름틀") bookmark name. */
export const isFormFieldName = (name: string): boolean => /^NormalField/.test(name)

function attrOf(
  xml: string,
  nameEnd: number,
  openEnd: number,
  prefixes: OdtPartInfo['prefixes'],
  name: string,
) {
  for (const a of readAttributes(xml, nameEnd, openEnd)) {
    if (prefixes.canonical(a.name) === name) return decodeXmlEntities(a.raw)
  }
  return undefined
}

/** Own (automatic) or resolved (common) text properties of a text style as seen from `scope`. */
export function textStyleAttrs(src: ReadParagraphSource, name: string | null): OdfAttrs {
  if (!name) return {}
  const style = src.styles.find(name, 'text', src.info.scope)
  if (!style) return {}
  if (style.automatic) return { ...(style.properties['style:text-properties'] ?? {}) }
  return {
    ...(src.styles.resolve(name, 'text', src.info.scope)?.properties['style:text-properties'] ??
      {}),
  }
}

export function readParagraph(
  src: ReadParagraphSource,
  range: ElementRange,
  options: ReadParagraphOptions = {},
): ParagraphModel {
  const { info } = src
  const xml = info.xml
  const prefixes = info.prefixes
  const scanner = /^<([^\s/>]+)/.exec(xml.slice(range.start, range.openEnd))
  const tag = scanner ? scanner[1] : 'text:p'
  const canonical = prefixes.canonical(tag)
  const element: 'text:p' | 'text:h' = canonical === 'text:h' ? 'text:h' : 'text:p'
  const nameEnd = range.start + 1 + tag.length
  const styleName = attrOf(xml, nameEnd, range.openEnd, prefixes, 'text:style-name') ?? null
  const levelRaw = attrOf(xml, nameEnd, range.openEnd, prefixes, 'text:outline-level')
  const outlineLevel =
    element === 'text:h' ? Math.min(10, Math.max(1, parseInt(levelRaw ?? '1', 10) || 1)) : null
  const openTag = range.selfClosing
    ? xml.slice(range.start, range.openEnd).replace(/\s*\/>$/, '>')
    : xml.slice(range.start, range.openEnd)

  const model: ParagraphModel = {
    part: info.part,
    range,
    element,
    tag,
    openTag,
    closeTag: `</${tag}>`,
    styleName,
    outlineLevel,
    text: '',
    charSets: [],
    sets: [{ frames: [], key: '', attrs: {}, href: null }],
    emptySet: 0,
    markers: [],
    splices: [],
    markerSeq: [],
  }
  if (range.selfClosing) return model

  const record = options.record
  const recorded = new Map<number, BridgeMarker>()
  if (record) for (const m of record.markers) recorded.set(m.start, m)
  const forward = options.forward
  const setIndex = new Map<string, number>([['', 0]])
  const attrCache = new Map<string, OdfAttrs>()
  const styleAttrs = (name: string | null) => {
    const k = name ?? ''
    let a = attrCache.get(k)
    if (!a) attrCache.set(k, (a = textStyleAttrs(src, name)))
    return a
  }
  const stack: Frame[] = []
  let current = 0
  let emptyChosen = false
  let ignoreLeading = true
  let seq = 0
  const chars: string[] = []

  const currentSet = (): number => {
    const key = stack.map((f) => f.open).join('\u0001')
    let index = setIndex.get(key)
    if (index === undefined) {
      const attrs: OdfAttrs = {}
      let href: string | null = null
      for (const f of stack) {
        Object.assign(attrs, styleAttrs(f.style))
        if (f.kind === 'a') href = f.href
      }
      index = model.sets.length
      model.sets.push({ frames: [...stack], key, attrs, href })
      setIndex.set(key, index)
    }
    return index
  }
  // UTF-16 code units, like every offset of the bridge
  // a drawing placed as a character (`text:anchor-type="as-char"`) takes a character
  // position: white space right after it does not collapse into the white space
  // before it. It shows only when something visible follows in the paragraph (the
  // docx engine reads a paragraph of drawings and white space as a picture block).
  let afterObject = false
  let pendingSpace: number | null = null
  const flushPending = () => {
    if (pendingSpace === null) return
    chars.push(' ')
    model.charSets.push(pendingSpace)
    pendingSpace = null
  }
  const push = (text: string, set: number) => {
    if (text) {
      flushPending()
      afterObject = false
    }
    for (let i = 0; i < text.length; i++) {
      chars.push(text[i])
      model.charSets.push(set)
    }
  }
  const pushText = (raw: string) => {
    let out = ''
    for (const ch of raw) {
      if (isWs(ch)) {
        if (!ignoreLeading) out += ' '
        else if (afterObject && pendingSpace === null && out === '') pendingSpace = current
        ignoreLeading = true
      } else {
        out += ch
        ignoreLeading = false
      }
    }
    if (out) push(out, current)
  }
  const offset = () => chars.length
  const isCharacterObject = (el: { name: string; nameEnd: number; openEnd: number }) =>
    el.name.startsWith('draw:') &&
    attrOf(xml, el.nameEnd, el.openEnd, prefixes, 'text:anchor-type') === 'as-char'
  const addMarker = (marker: Omit<BridgeMarker, 'ooxmlName'>, withBookmark: boolean) => {
    const index = model.markers.length
    model.markers.push({
      ...marker,
      ooxmlName: withBookmark && forward ? markerBookmarkName(forward.paragraphId, index) : null,
    })
    model.markerSeq.push(seq++)
  }

  walkElements(
    xml,
    prefixes,
    {
      open(el) {
        if (FRAME_NAMES.has(el.name)) {
          const style = attrOf(xml, el.nameEnd, el.openEnd, prefixes, 'text:style-name') ?? null
          const open = el.selfClosing
            ? xml.slice(el.start, el.openEnd).replace(/\s*\/>$/, '>')
            : xml.slice(el.start, el.openEnd)
          const frame: Frame =
            el.name === 'text:a'
              ? {
                  kind: 'a',
                  href: attrOf(xml, el.nameEnd, el.openEnd, prefixes, 'xlink:href') ?? '',
                  style,
                  open,
                  close: `</${el.tag}>`,
                }
              : { kind: 'span', style, open, close: `</${el.tag}>` }
          stack.push(frame)
          current = currentSet()
          if (!emptyChosen && chars.length === 0 && el.name === 'text:span') {
            model.emptySet = current
            emptyChosen = true
          }
          if (el.selfClosing) {
            stack.pop()
            current = currentSet()
          } else el.data = 'frame'
          return
        }
        if (el.name === 'text:s') {
          const c = parseInt(attrOf(xml, el.nameEnd, el.openEnd, prefixes, 'text:c') ?? '1', 10)
          push(' '.repeat(Number.isFinite(c) && c > 0 ? Math.min(c, 100000) : 1), current)
          ignoreLeading = false
          return 'skip'
        }
        if (el.name === 'text:tab') {
          push('\t', current)
          ignoreLeading = false
          return 'skip'
        }
        if (el.name === 'text:line-break') {
          push('\n', current)
          ignoreLeading = false
          return 'skip'
        }
        // everything else is atomic: handled when its extent is known (a
        // self-closing element is closed right away; a skipped one is not)
        el.data = { atomic: true, offset: offset() }
        return el.selfClosing ? undefined : 'skip'
      },
      close(el) {
        if (el.data === 'frame') {
          stack.pop()
          current = currentSet()
          return
        }
        const data = el.data as { atomic?: boolean } | undefined
        if (!data?.atomic) return
        const end = el.end
        const bookmark = BOOKMARK_KINDS[el.name]
        if (bookmark) {
          const name = attrOf(xml, el.nameEnd, el.openEnd, prefixes, 'text:name') ?? ''
          addMarker(
            {
              kind: bookmark,
              name,
              offset: offset(),
              length: 0,
              start: el.start,
              end,
              pair: null,
              field: isFormFieldName(name),
              owner: null,
            },
            true,
          )
          return
        }
        const rec = recorded.get(el.start)
        if (record && rec && (rec.kind === 'handler' || rec.kind === 'text')) {
          const text = record.text.slice(rec.offset, rec.offset + rec.length)
          const character = isCharacterObject(el)
          if (text || character) flushPending()
          const at = offset()
          push(text, rec.kind === 'handler' ? -1 : current)
          if (text) ignoreLeading = false
          else if (character) afterObject = true
          addMarker({ ...rec, offset: at, pair: null }, false)
          return
        }
        if (forward) {
          const inline = { ...el, part: info.part, xml, end, closeStart: el.closeStart }
          for (const converter of forward.ctx.registry.inlineFor(el.name)) {
            const result = converter.toOoxml(forward.ctx, inline, {
              paragraphId: forward.paragraphId,
              offset: offset(),
            })
            if (!result || result.kind === 'keep') continue
            let produced: { xml: string; text: string }
            if (result.kind === 'xml') produced = result
            else {
              produced = {
                xml: runsXml(forward.ctx, result.runs),
                text: result.runs.map((r) => r.text).join(''),
              }
            }
            const character = isCharacterObject(el)
            if (produced.text || character) flushPending()
            const at = offset()
            model.splices.push({ offset: at, xml: produced.xml, seq: seq })
            push(produced.text, -1)
            if (produced.text) ignoreLeading = false
            else if (character) afterObject = true
            addMarker(
              {
                kind: 'handler',
                name: el.name,
                offset: at,
                length: produced.text.length,
                start: el.start,
                end,
                pair: null,
                field: false,
                owner: converter.id,
              },
              false,
            )
            return
          }
        }
        if (!isInvisibleInline(el.name)) {
          const state = { ignoreLeading }
          const text = visibleText(xml, prefixes, el.openEnd, el.closeStart, state, el.selfClosing)
          if (text) {
            flushPending()
            const at = offset()
            push(text, current)
            ignoreLeading = state.ignoreLeading
            addMarker(
              {
                kind: 'text',
                name: el.name,
                offset: at,
                length: text.length,
                start: el.start,
                end,
                pair: null,
                field: false,
                owner: null,
              },
              false,
            )
            return
          }
        }
        if (isCharacterObject(el)) {
          flushPending()
          afterObject = true
        }
        addMarker(
          {
            kind: 'keep',
            name: el.name,
            offset: offset(),
            length: 0,
            start: el.start,
            end,
            pair: null,
            field: false,
            owner: null,
          },
          true,
        )
      },
      other(kind, start, end) {
        if (kind === 'text') pushText(decodeXmlEntities(xml.slice(start, end)))
        else if (kind === 'cdata') pushText(xml.slice(start + 9, Math.max(start + 9, end - 3)))
      },
    },
    range.openEnd,
    range.closeStart,
  )

  model.text = chars.join('')
  pairMarkers(model.markers)
  return model
}

/** Pairs bookmark starts and ends of one paragraph by name (nearest open start). */
export function pairMarkers(markers: BridgeMarker[]): void {
  const open = new Map<string, number[]>()
  markers.forEach((m, i) => {
    m.pair = null
    if (m.kind === 'bookmark-start') {
      const list = open.get(m.name)
      if (list) list.push(i)
      else open.set(m.name, [i])
    } else if (m.kind === 'bookmark-end') {
      const start = open.get(m.name)?.pop()
      if (start !== undefined) {
        markers[start].pair = i
        m.pair = start
      }
    }
  })
}

/** Visible text inside an inline element (fields and the like), with paragraph white-space rules. */
function visibleText(
  xml: string,
  prefixes: OdtPartInfo['prefixes'],
  from: number,
  to: number,
  state: { ignoreLeading: boolean },
  selfClosing: boolean,
): string {
  if (selfClosing || from >= to) return ''
  let out = ''
  walkElements(
    xml,
    prefixes,
    {
      open(el) {
        if (el.name === 'text:s') {
          const c = parseInt(attrOf(xml, el.nameEnd, el.openEnd, prefixes, 'text:c') ?? '1', 10)
          out += ' '.repeat(Number.isFinite(c) && c > 0 ? Math.min(c, 100000) : 1)
          state.ignoreLeading = false
          return 'skip'
        }
        if (el.name === 'text:tab' || el.name === 'text:line-break') {
          out += el.name === 'text:tab' ? '\t' : '\n'
          state.ignoreLeading = false
          return 'skip'
        }
        if (isInvisibleInline(el.name) || BOOKMARK_KINDS[el.name]) return 'skip'
      },
      other(kind, start, end) {
        if (kind !== 'text') return
        for (const ch of decodeXmlEntities(xml.slice(start, end))) {
          if (isWs(ch)) {
            if (!state.ignoreLeading) out += ' '
            state.ignoreLeading = true
          } else {
            out += ch
            state.ignoreLeading = false
          }
        }
      },
    },
    from,
    to,
  )
  return out
}

/** OOXML of engine runs (no paragraph wrapper), written by the docx engine's generator. */
export function runsXml(ctx: OdfToOoxmlContext, runs: Run[]): string {
  if (!runs.length) return ''
  const xml = generateParagraphXml({ type: 'paragraph', runs }, ctx.generate)
  return xml.slice('<w:p>'.length, xml.length - '</w:p>'.length)
}
