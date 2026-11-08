/**
 * ODF → OOXML for one paragraph.
 *
 * Formatting is mapped onto the docx engine's model and written by the
 * engine's own generator, so the bridge paragraph is exactly the kind of XML
 * the engine regenerates when the editor changes it:
 * - `w:pStyle` = the docx style of the paragraph's ODF common style (the
 *   automatic style's parent); the automatic style's own paragraph properties
 *   become direct `w:pPr`, with the effective tab list.
 * - each run's direct `w:rPr` = the paragraph automatic style's own text
 *   properties overlaid with its spans' (and link's) styles.
 * - a hidden identity bookmark `_odtp<id>` opens the paragraph; every ODF
 *   bookmark and kept inline element gets a hidden `_odtm<id>_<n>` bookmark at
 *   its position. Positions are restored on save from the bridge record, not
 *   from these bookmarks (the engine moves them to the paragraph start when it
 *   regenerates a paragraph).
 */
import type { GeneratedBlock, Run } from '@genoffice/docx-engine'
import {
  type BridgeListItem,
  type BridgeParagraph,
  type OdfToOoxmlContext,
  paragraphIdentityName,
} from '../core/convert'
import type { OdtStylePart } from '../core/styles'
import type { ElementRange } from '../core/xml'
import { escapeXmlAttr } from '../core/xml'
import { type ParagraphModel, readParagraph, runsXml } from './paragraph-model'
import { type OdfAttrs, type TextFormat, paraFormatFromOdf, textFormatFromOdf } from './props'
import { ooxmlPPr, ooxmlRPr, styleEntryForOdf } from './styles'
import { twips } from './units'

export interface ParagraphOoxmlOptions {
  part: OdtStylePart
  /** converter id recorded as the paragraph's owner (default `text`) */
  owner?: string
  /** bridge block containing the paragraph, or null */
  block?: number | null
  /** list membership; `kind` is the docx list kind of the level */
  list?: (BridgeListItem & { kind: 'bullet' | 'ordered' }) | null
}

export interface ParagraphOoxml {
  /** the `w:p` element */
  xml: string
  paragraph: BridgeParagraph
  model: ParagraphModel
}

/** The paragraph-level facts of an ODF paragraph style, as the bridge maps them. */
export interface ParagraphStyleInfo {
  /** docx style id for `w:pStyle`, if any */
  styleId: string | undefined
  /** own paragraph properties written as direct formatting */
  ownParagraph: OdfAttrs
  /** own text properties applied to every run */
  ownText: OdfAttrs
  /** text properties the docx paragraph style chain gives every run (resolved common style) */
  styleText: OdfAttrs
  /** effective tab stops */
  tabStops: Array<Record<string, string>> | null
  /** effective left margin (twips) */
  marginLeft: number
  /** effective `fo:break-after` is `page` */
  breakAfter: boolean
}

export function paragraphStyleInfo(
  ctx: Pick<OdfToOoxmlContext, 'doc' | 'map'>,
  part: OdtStylePart,
  styleName: string | null,
): ParagraphStyleInfo {
  const scope = part === 'content.xml' ? 'content' : 'styles'
  const style = styleName === null ? undefined : ctx.doc.styles.find(styleName, 'paragraph', scope)
  if (!style) {
    return {
      styleId: undefined,
      ownParagraph: {},
      ownText: {},
      styleText: {},
      tabStops: null,
      marginLeft: 0,
      breakAfter: false,
    }
  }
  const resolved = ctx.doc.styles.resolve(style.name, 'paragraph', scope)
  const common = style.automatic ? style.parentName : style.name
  const pp = resolved?.properties['style:paragraph-properties'] ?? {}
  return {
    styleId: styleEntryForOdf(ctx.map, common)?.styleId,
    ownParagraph: style.automatic
      ? { ...(style.properties['style:paragraph-properties'] ?? {}) }
      : {},
    ownText: style.automatic ? { ...(style.properties['style:text-properties'] ?? {}) } : {},
    styleText:
      common === null
        ? {}
        : {
            ...(ctx.doc.styles.resolve(common, 'paragraph', scope)?.properties[
              'style:text-properties'
            ] ?? {}),
          },
    tabStops: resolved?.tabStops ?? null,
    marginLeft: twips(pp['fo:margin-left']) ?? 0,
    breakAfter: pp['fo:break-after'] === 'page',
  }
}

/** Converts the paragraph at `range` of `opts.part` and records it in the bridge map. */
export function paragraphToOoxml(
  ctx: OdfToOoxmlContext,
  range: ElementRange,
  opts: ParagraphOoxmlOptions,
): ParagraphOoxml {
  const id = ctx.reserveParagraphId()
  const info = ctx.part(opts.part)
  const model = readParagraph({ info, styles: ctx.doc.styles }, range, {
    forward: { ctx, paragraphId: id },
  })
  const style = paragraphStyleInfo(ctx, opts.part, model.styleName)
  const format = paraFormatFromOdf(style.ownParagraph, style.tabStops, style.marginLeft)

  // runs per character group
  const inherited = textFormatFromOdf(style.styleText, ctx.part('styles.xml').fontFaces)
  const runFormat = new Map<number, Run>()
  const formatOf = (set: number): Run => {
    let r = runFormat.get(set)
    if (!r) {
      const s = model.sets[set]
      r = { text: '', ...textFormatFromOdf({ ...style.ownText, ...s.attrs }, info.fontFaces) }
      if (s.href !== null) r.link = { href: s.href, plain: true }
      const offs = explicitOffs(r, inherited)
      if (offs.length) {
        const { text: _t, link: _l, ...fmt } = r
        r.rawRPr = withChildren(ooxmlRPr(ctx, fmt), offs)
      }
      runFormat.set(set, r)
    }
    return r
  }
  let text = model.text
  const charSets = [...model.charSets]
  if (style.breakAfter) {
    text += '\f'
    charSets.push(charSets.length ? Math.max(0, charSets[charSets.length - 1]) : model.emptySet)
  }
  if (text === '') {
    const empty = formatOf(model.emptySet)
    if (empty.sizeHalfPoints) format.emptyRunSizeHalfPoints = empty.sizeHalfPoints
  }

  // insertion points: markers with OOXML bookmarks, converter splices
  interface Insert {
    offset: number
    seq: number
    xml: string
  }
  const inserts: Insert[] = []
  model.markers.forEach((m, i) => {
    if (m.ooxmlName === null) return
    const seq = model.markerSeq[i]
    if (m.kind === 'bookmark-start' && m.pair !== null) {
      const bid = ctx.allocateBookmarkId()
      inserts.push({
        offset: m.offset,
        seq,
        xml: `<w:bookmarkStart w:id="${bid}" w:name="${escapeXmlAttr(m.ooxmlName)}"/>`,
      })
      const end = model.markers[m.pair]
      inserts.push({
        offset: end.offset,
        seq: model.markerSeq[m.pair],
        xml: `<w:bookmarkEnd w:id="${bid}"/>`,
      })
      return
    }
    if (m.kind === 'bookmark-end' && m.pair !== null) return
    const bid = ctx.allocateBookmarkId()
    inserts.push({
      offset: m.offset,
      seq,
      xml: `<w:bookmarkStart w:id="${bid}" w:name="${escapeXmlAttr(m.ooxmlName)}"/><w:bookmarkEnd w:id="${bid}"/>`,
    })
  })
  for (const s of model.splices) inserts.push({ offset: s.offset, seq: s.seq, xml: s.xml })
  inserts.sort((a, b) => a.offset - b.offset || a.seq - b.seq)

  let body = ''
  let at = 0
  let insertIndex = 0
  const flushRuns = (to: number) => {
    const runs: Run[] = []
    let i = at
    while (i < to) {
      const set = charSets[i]
      if (set < 0) {
        i++
        continue
      }
      let j = i
      while (j < to && charSets[j] === set) j++
      runs.push({ ...formatOf(set), text: text.slice(i, j) })
      i = j
    }
    body += runsXml(ctx, runs)
    at = to
  }
  while (insertIndex < inserts.length) {
    const ins = inserts[insertIndex++]
    flushRuns(ins.offset)
    body += ins.xml
  }
  flushRuns(text.length)

  const list = opts.list ?? null
  const block: Omit<GeneratedBlock, 'runs'> = list
    ? {
        type: 'listItem',
        styleId: style.styleId,
        list: { kind: list.kind, numId: list.numId, ilvl: Math.min(8, list.level) },
        format,
      }
    : model.element === 'text:h'
      ? {
          type: 'heading',
          level: Math.min(9, model.outlineLevel ?? 1),
          outlineOnly: true,
          styleId: style.styleId,
          format,
        }
      : { type: 'paragraph', styleId: style.styleId, format }
  if (list?.header || list?.continuation) {
    // a list header / continuation paragraph shows no number
    block.type = 'paragraph'
    delete block.list
  }
  const pPr = ooxmlPPr(ctx, block)
  const idBookmark = ctx.allocateBookmarkId()
  const xml =
    `<w:p>${pPr}<w:bookmarkStart w:id="${idBookmark}" w:name="${paragraphIdentityName(id)}"/>` +
    `<w:bookmarkEnd w:id="${idBookmark}"/>${body}</w:p>`
  const paragraph: BridgeParagraph = {
    id,
    part: opts.part,
    start: range.start,
    end: range.end,
    element: model.element,
    styleName: model.styleName,
    text,
    markers: model.markers,
    pPr,
    list: list
      ? {
          numId: list.numId,
          level: list.level,
          header: list.header,
          continuation: list.continuation,
        }
      : null,
    owner: opts.owner ?? 'text',
    block: opts.block ?? null,
  }
  ctx.addParagraph(paragraph)
  return { xml, paragraph, model }
}

/** Schema order of the run properties written here. */
const RPR_ORDER = [
  'w:rStyle',
  'w:rFonts',
  'w:b',
  'w:bCs',
  'w:i',
  'w:iCs',
  'w:strike',
  'w:color',
  'w:spacing',
  'w:w',
  'w:sz',
  'w:szCs',
  'w:highlight',
  'w:u',
  'w:shd',
  'w:vertAlign',
]

/**
 * Explicit "off" toggles a run needs because its paragraph's docx style turns
 * them on while the ODF span says normal (the engine model only writes "on").
 */
function explicitOffs(run: TextFormat, inherited: TextFormat): string[] {
  const out: string[] = []
  if (run.bold === false && inherited.bold) out.push('<w:b w:val="0"/>', '<w:bCs w:val="0"/>')
  if (run.italic === false && inherited.italic) out.push('<w:i w:val="0"/>', '<w:iCs w:val="0"/>')
  if (run.strike === false && inherited.strike) out.push('<w:strike w:val="0"/>')
  if (run.underline === false && inherited.underline) out.push('<w:u w:val="none"/>')
  return out
}

function withChildren(rPr: string, extra: string[]): string {
  const inner = rPr ? rPr.slice('<w:rPr>'.length, -'</w:rPr>'.length) : ''
  const children = [...(inner.match(/<w:[A-Za-z]+(?:\s[^>]*)?\/>/g) ?? []), ...extra]
  const rank = (c: string) => {
    const i = RPR_ORDER.indexOf(/^<([^\s/>]+)/.exec(c)?.[1] ?? '')
    return i < 0 ? RPR_ORDER.length : i
  }
  return `<w:rPr>${children.sort((a, b) => rank(a) - rank(b)).join('')}</w:rPr>`
}
