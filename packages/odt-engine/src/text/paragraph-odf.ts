/**
 * OOXML → ODF for one paragraph the editor changed (or created).
 *
 * Style: when the paragraph continues an original one, a changed format
 * creates a NEW automatic style that is a byte copy of the original automatic
 * style (tab stops, Hancom attributes, unknown children) with only the changed
 * attributes overridden; ODF automatic styles cannot be parents of automatic
 * styles. An unchanged format keeps the original style name. A brand-new
 * paragraph gets an automatic style whose parent is the common style of its
 * docx style, or the document's base paragraph style.
 *
 * Text: every edited character is mapped onto an original character (common
 * prefix/suffix of the two texts; replaced text positionally). Runs whose
 * formatting equals that character's original formatting keep the original
 * span/link markup; others get a copy of the original span style with the
 * changed text properties overridden.
 *
 * Markers: bookmarks (Hancom form fields included) and kept inline elements
 * are re-emitted byte for byte at their mapped offsets. A form-field pair keeps
 * typed text inside it, becomes an empty pair when its text was deleted, and
 * disappears only with its paragraph.
 */
import type { Block, TableParagraph } from '@genoffice/docx-engine'
import type {
  BridgeParagraph,
  EditedParagraph,
  OoxmlToOdfContext,
  ParagraphWriteEnv,
} from '../core/convert'
import type { OdtStyle, OdtStylePart } from '../core/styles'
import { escapeXmlAttr, escapeXmlText } from '../core/xml'
import { alignTexts } from './align'
import { type Placement, placeMarkers } from './markers'
import { paragraphStyleInfo } from './paragraph-ooxml'
import { type Frame, type ParagraphModel, readParagraph } from './paragraph-model'
import {
  type AttrOverrides,
  type TextKeys,
  changedParaKeys,
  changedTextKeys,
  clearedToInherited,
  paraFormatFromOdf,
  paraKeys,
  paraOverrides,
  textFormatFromOdf,
  textKeys,
  textOverrides,
} from './props'
import { editStyleXml, newStyleXml, patchStartTag } from './style-xml'
import { styleEntryById } from './styles'
import { halfPointsToPt } from './units'

export function editedParagraphFromBlock(b: Block): EditedParagraph {
  return {
    type: b.type === 'heading' ? 'heading' : b.type === 'listItem' ? 'listItem' : 'paragraph',
    runs: b.runs ?? [],
    format: b.format,
    styleId: b.styleId,
    level: b.level,
    outlineOnly: b.outlineOnly,
    list: b.list,
    rawPPr: b.rawPPr,
    hiddenBookmarks: b.hiddenBookmarks,
  }
}

/** A table-cell paragraph of the engine's table model, for the paragraph writer. */
export function editedParagraphFromTableParagraph(p: TableParagraph): EditedParagraph {
  const { runs, styleId, list, ...format } = p
  return { type: list ? 'listItem' : 'paragraph', runs, format, styleId, list }
}

export interface ParagraphWriteOptions {
  part: OdtStylePart
  /** an original paragraph next to a NEW one: its text styles are reused when formatting matches */
  neighbour?: BridgeParagraph | null
  /**
   * The original paragraph a NEW one directly follows (the first half of an
   * Enter split, or the paragraph it was typed after). When both have the same
   * docx style, the new paragraph's style is derived from this paragraph's
   * automatic style (all its properties, tab list and Hancom attributes
   * included) instead of from the common style.
   */
  follows?: BridgeParagraph | null
  /**
   * Markers already placed on this paragraph's text (by `placeMarkers` over a
   * split or joined sequence); default: the origin's markers mapped onto it.
   */
  placements?: Placement[]
}

const modelCache = new WeakMap<OoxmlToOdfContext, Map<number, ParagraphModel | null>>()

/** The original paragraph re-read with its character frames (null when it no longer matches its record). */
export function originalModel(
  rctx: OoxmlToOdfContext,
  record: BridgeParagraph,
): ParagraphModel | null {
  let cache = modelCache.get(rctx)
  if (!cache) modelCache.set(rctx, (cache = new Map()))
  if (cache.has(record.id)) return cache.get(record.id) ?? null
  const info = rctx.part(record.part)
  const xml = info.xml
  const head = xml.slice(record.start, xml.indexOf('>', record.start) + 1)
  const selfClosing = head.endsWith('/>')
  const closeStart = selfClosing ? record.end : xml.lastIndexOf('<', record.end - 1)
  const model = readParagraph(
    { info, styles: rctx.doc.styles },
    {
      start: record.start,
      openEnd: record.start + head.length,
      closeStart,
      end: record.end,
      selfClosing,
    },
    { record },
  )
  const text =
    record.text.endsWith('\f') && !model.text.endsWith('\f') ? model.text + '\f' : model.text
  const ok = text === record.text
  if (!ok) rctx.warn(`paragraph ${record.id}: original text no longer matches its record`)
  if (ok && text.length > model.text.length)
    model.charSets.push(model.charSets.at(-1) ?? model.emptySet)
  cache.set(record.id, ok ? model : null)
  return ok ? model : null
}

interface Insert {
  offset: number
  xml: string
  attach: 'prev' | 'next'
  /** document order among inserts at the same offset */
  seq: number
  /** characters of the edited text this insert replaces (text atoms) */
  replaces?: number
}

/**
 * Writes the ODF for an edited paragraph. Usually one `text:p`/`text:h`; a
 * page break typed inside the paragraph splits it (ODF has no inline page
 * break), the later part starting on a new page.
 */
export function paragraphToOdf(
  rctx: OoxmlToOdfContext,
  para: EditedParagraph,
  origin: BridgeParagraph | null,
  opts: ParagraphWriteOptions,
): string {
  const part = opts.part
  const info = rctx.part(part)
  const prefixes = info.prefixes
  const runs = para.runs
  const edited = runs.map((r) => r.text).join('')
  const original = origin?.text ?? ''
  const mapper = alignTexts(original, edited)
  const env: ParagraphWriteEnv = { origin, part, text: edited, mapOffset: mapper.map }
  const model = origin ? originalModel(rctx, origin) : null
  const neighbourModel = !origin && opts.neighbour ? originalModel(rctx, opts.neighbour) : null

  // ---- paragraph style
  // the original whose style this paragraph continues: its own, or for a new
  // paragraph the one it follows when both have the same docx style
  let template: BridgeParagraph | null = origin
  if (!origin && opts.follows && opts.follows.part === part) {
    const followed = paragraphStyleInfo(rctx, part, opts.follows.styleName)
    if ((followed.styleId ?? undefined) === (para.styleId ?? undefined)) template = opts.follows
  }
  const continues = !origin && template !== null
  const styleInfo = paragraphStyleInfo(rctx, part, template?.styleName ?? null)
  const scope = part === 'content.xml' ? 'content' : 'styles'
  const baseStyle: OdtStyle | undefined =
    template?.styleName != null
      ? rctx.doc.styles.find(template.styleName, 'paragraph', scope)
      : undefined
  const f0 = template
    ? paraFormatFromOdf(styleInfo.ownParagraph, styleInfo.tabStops, styleInfo.marginLeft)
    : {}
  const k0 = paraKeys(f0)
  const formatUntouched = !!origin && para.rawPPr !== undefined && para.rawPPr === origin.pPr
  const keys = formatUntouched ? [] : changedParaKeys(k0, paraKeys(para.format))
  const marginAfter = para.format?.indentLeft ?? styleInfo.marginLeft
  const pOver = paraOverrides(keys, para.format ?? {}, marginAfter, k0)
  const entry = styleEntryById(rctx.map, para.styleId)
  const styleChanged = !!origin && (para.styleId ?? undefined) !== (styleInfo.styleId ?? undefined)
  const newParent = entry?.odfName ?? rctx.map.styles.baseParagraphStyle
  const headingText: AttrOverrides = {}
  if (entry?.headingLevel && (!template || styleChanged)) {
    const size = [32, 28, 26, 24, 22, 22][entry.headingLevel - 1] ?? 24
    Object.assign(headingText, {
      'fo:font-weight': 'bold',
      'style:font-weight-asian': 'bold',
      'style:font-weight-complex': 'bold',
      'fo:font-size': halfPointsToPt(size),
      'style:font-size-asian': halfPointsToPt(size),
      'style:font-size-complex': halfPointsToPt(size),
    })
  }

  const ownAttr = (style: OdtStyle | undefined, path: string, name: string) =>
    style?.properties[path]?.[name]
  const styleFor = (extra: AttrOverrides): string | null => {
    const { 'style:master-page-name': masterPage, ...attrs } = { ...pOver.attrs, ...extra }
    const base = baseStyle?.automatic && baseStyle.part === part ? baseStyle : undefined
    // attributes of the style element itself (a section start lives there)
    const element: AttrOverrides = { 'style:display-name': null }
    const dropMaster = masterPage === null && !!base?.masterPageName
    if (dropMaster) element['style:master-page-name'] = null
    const effective: AttrOverrides = {}
    for (const [k, v] of Object.entries(attrs)) {
      const cur = ownAttr(base, 'style:paragraph-properties', k)
      if (base ? cur !== (v ?? undefined) : v !== null) effective[k] = v
    }
    const text: AttrOverrides = {}
    for (const [k, v] of Object.entries(headingText)) {
      if (ownAttr(base, 'style:text-properties', k) !== v) text[k] = v
    }
    const parentChange = styleChanged ? newParent : undefined
    const nothing =
      !Object.keys(effective).length &&
      pOver.tabStops === undefined &&
      !Object.keys(text).length &&
      parentChange === undefined &&
      !dropMaster
    if (template && nothing) return template.styleName
    const props: Record<string, AttrOverrides> = {}
    if (Object.keys(effective).length) props['style:paragraph-properties'] = effective
    if (Object.keys(text).length) props['style:text-properties'] = text
    const key = JSON.stringify([
      base?.name ?? null,
      base ? null : (template?.styleName ?? null),
      parentChange ?? null,
      props,
      pOver.tabStops ?? null,
      template ? null : newParent,
      dropMaster,
    ])
    return rctx.derivedStyle(part, key, base?.name ?? 'P', (name) => {
      if (base) {
        return editStyleXml(info.xml.slice(base.start, base.end), prefixes, {
          name,
          ...(parentChange !== undefined ? { parent: parentChange } : {}),
          attrs: element,
          props,
          tabStops: pOver.tabStops,
        })
      }
      const parent = parentChange ?? (template ? template.styleName : newParent) ?? null
      return editStyleXml(newStyleXml(name, 'paragraph', parent), prefixes, {
        props,
        tabStops: pOver.tabStops,
      })
    })
  }

  // ---- character templates
  const tplModel = model ?? neighbourModel
  const ownText = template ? styleInfo.ownText : {}
  // what a docx run inherits from its paragraph style chain (cleared run values)
  const inherited = textKeys(
    textFormatFromOdf(styleInfo.styleText, rctx.part('styles.xml').fontFaces),
  )
  const templateSet = (i: number): number => {
    if (!tplModel) return -1
    if (!model) {
      // a new paragraph next to an original one: its last character's styles
      const last = tplModel.charSets.filter((s) => s >= 0)
      return last.length ? last[last.length - 1] : tplModel.emptySet
    }
    const oLen = original.length
    if (oLen === 0) return model.emptySet
    const idx = Math.max(0, Math.min(oLen - 1, mapper.originalOf(i)))
    const set = model.charSets[idx]
    if (set !== undefined && set >= 0) return set
    for (let k = idx; k >= 0; k--) if (model.charSets[k] >= 0) return model.charSets[k]
    return model.emptySet
  }
  const keysCache = new Map<number, TextKeys>()
  const templateKeys = (set: number): TextKeys => {
    let k = keysCache.get(set)
    if (!k) {
      const attrs = set >= 0 && tplModel ? tplModel.sets[set].attrs : {}
      keysCache.set(
        set,
        (k = textKeys(textFormatFromOdf({ ...ownText, ...attrs }, info.fontFaces))),
      )
    }
    return k
  }
  const runKeys = runs.map((r) => textKeys(r))
  const frameCache = new Map<string, Frame[]>()
  const framesFor = (runIndex: number, set: number): Frame[] => {
    const cacheKey = `${runIndex}:${set}`
    const cached = frameCache.get(cacheKey)
    if (cached) return cached
    const run = runs[runIndex]
    let frames: Frame[] = set >= 0 && tplModel ? [...tplModel.sets[set].frames] : []
    const href = set >= 0 && tplModel ? tplModel.sets[set].href : null
    const link = run.link?.href ?? null
    if (link !== href) {
      frames = frames.filter((f) => f.kind !== 'a')
      if (link !== null) {
        frames.unshift({
          kind: 'a',
          href: link,
          style: null,
          open: `<text:a xlink:type="simple" xlink:href="${escapeXmlAttr(link)}">`,
          close: '</text:a>',
        })
      }
    }
    const changed = changedTextKeys(templateKeys(set), runKeys[runIndex])
    if (changed.length) {
      const target = clearedToInherited(changed, runKeys[runIndex], inherited)
      const over = textOverrides(changed, target, (family) => rctx.fontFace(part, family))
      let spanAt = -1
      for (let k = frames.length - 1; k >= 0; k--)
        if (frames[k].kind === 'span') {
          spanAt = k
          break
        }
      const span = spanAt >= 0 ? frames[spanAt] : null
      const spanStyle =
        span?.style != null ? rctx.doc.styles.find(span.style, 'text', scope) : undefined
      const base = spanStyle?.automatic && spanStyle.part === part ? spanStyle : undefined
      const effective: AttrOverrides = {}
      for (const [k, v] of Object.entries(over)) {
        if (!base || ownAttr(base, 'style:text-properties', k) !== (v ?? undefined))
          effective[k] = v
      }
      if (Object.keys(effective).length) {
        const parent = base ? undefined : (spanStyle?.name ?? null)
        const key = JSON.stringify([base?.name ?? null, parent ?? null, effective])
        const name = rctx.derivedStyle(part, key, base?.name ?? 'T', (n) =>
          base
            ? editStyleXml(info.xml.slice(base.start, base.end), prefixes, {
                name: n,
                attrs: { 'style:display-name': null },
                props: { 'style:text-properties': effective },
              })
            : editStyleXml(newStyleXml(n, 'text', parent ?? null), prefixes, {
                props: { 'style:text-properties': effective },
              }),
        )
        if (span) {
          frames[spanAt] = {
            ...span,
            style: name,
            open: patchStartTag(span.open, prefixes, { 'text:style-name': name }),
          }
        } else {
          frames.push({
            kind: 'span',
            style: name,
            open: `<text:span text:style-name="${escapeXmlAttr(name)}">`,
            close: '</text:span>',
          })
        }
      }
    }
    frameCache.set(cacheKey, frames)
    return frames
  }

  // ---- inserts: markers, run writers, injectors
  const inserts: Insert[] = []
  const skip = new Uint8Array(edited.length)
  const placed =
    opts.placements ?? (origin ? placeMarkers(rctx, [origin], [edited]).placements[0] : [])
  for (const x of placed) {
    inserts.push(x)
    for (let k = x.offset; k < x.offset + (x.replaces ?? 0) && k < skip.length; k++) skip[k] = 1
  }
  // an atom continuing one of the origin's handler markers keeps that marker's
  // document order among the markers at its offset (a picture before a bookmark)
  const usedHandlers = new Set<number>()
  const handlerSeq = (at: number, owner: string): number | null => {
    if (!origin || opts.placements) return null
    const index = origin.markers.findIndex(
      (m, k) =>
        m.kind === 'handler' &&
        m.owner === owner &&
        !usedHandlers.has(k) &&
        mapper.map(m.offset, 'start') === at,
    )
    if (index < 0) return null
    usedHandlers.add(index)
    return index
  }
  let offset = 0
  runs.forEach((run, i) => {
    const len = run.text.length
    const writer = rctx.registry.runWriterFor(run)
    if (writer) {
      const seq = handlerSeq(offset, writer.id) ?? 1e9 + i
      inserts.push({ offset, xml: writer.toOdf(rctx, run, env), attach: 'next', seq })
      for (let k = offset; k < offset + len; k++) skip[k] = 1
    } else if (run.image || run.noteRef) {
      rctx.warn(`dropped an unsupported ${run.image ? 'picture' : 'note reference'} in a paragraph`)
      for (let k = offset; k < offset + len; k++) skip[k] = 1
    }
    offset += len
  })
  for (const injector of rctx.registry.injectors) {
    for (const x of injector.inject(rctx, para, env))
      inserts.push({
        offset: x.offset,
        xml: x.xml,
        attach: x.attach ?? 'next',
        seq: 2e9 + inserts.length,
      })
  }
  inserts.sort((a, b) => a.offset - b.offset || a.seq - b.seq)

  // ---- emission
  const runAt: number[] = []
  runs.forEach((r, i) => {
    for (let k = 0; k < r.text.length; k++) runAt.push(i)
  })
  const bodies: string[] = []
  let body = ''
  let open: Frame[] = []
  let spaceOk = false
  const switchTo = (target: Frame[]) => {
    let common = 0
    while (
      common < open.length &&
      common < target.length &&
      open[common].open === target[common].open
    )
      common++
    for (let k = open.length - 1; k >= common; k--) body += open[k].close
    for (let k = common; k < target.length; k++) body += target[k].open
    open = target
  }
  const templateFrames = (k: number): Frame[] => {
    const set = templateSet(k)
    return set >= 0 && tplModel ? tplModel.sets[set].frames : []
  }
  const framesAt = (k: number): Frame[] | null =>
    k < edited.length && !skip[k] && edited[k] !== '\f' ? framesFor(runAt[k], templateSet(k)) : null
  let ins = 0
  for (let k = 0; k <= edited.length; k++) {
    const here: Insert[] = []
    while (ins < inserts.length && inserts[ins].offset <= k) here.push(inserts[ins++])
    // document order; a start-like insert sits inside the following text's spans
    for (const x of here) {
      if (x.attach === 'next') {
        // skipped characters belong to atoms: they sit in the original spans as they were
        const target = framesAt(k) ?? (k < edited.length && skip[k] ? templateFrames(k) : null)
        if (target) switchTo(target)
      }
      body += x.xml
      // markers are not text: a literal space after one is still leading/collapsed;
      // a drawing placed as a character is one, so a space after it is kept
      if (x.replaces || isCharacterObjectXml(x.xml)) spaceOk = true
    }
    if (k === edited.length) break
    if (skip[k]) continue
    const ch = edited[k]
    if (ch === '\f') {
      switchTo([])
      bodies.push(body)
      body = ''
      spaceOk = false
      continue
    }
    switchTo(framesFor(runAt[k], templateSet(k)))
    if (ch === '\t') {
      body += '<text:tab/>'
      spaceOk = true
    } else if (ch === '\n' || ch === '\v' || ch === '\u001e' || ch === '\r') {
      body += '<text:line-break/>'
      spaceOk = true
    } else if (ch === ' ') {
      let n = 1
      while (
        k + n < edited.length &&
        edited[k + n] === ' ' &&
        !skip[k + n] &&
        framesAt(k + n) === open
      )
        n++
      const atEnd = k + n >= edited.length
      if (n === 1 && spaceOk && !atEnd) {
        body += ' '
        // a second literal space would collapse into this one
        spaceOk = false
      } else {
        if (spaceOk && !atEnd) body += n === 2 ? ' <text:s/>' : ` <text:s text:c="${n - 1}"/>`
        else body += n === 1 ? '<text:s/>' : `<text:s text:c="${n}"/>`
        spaceOk = true
      }
      k += n - 1
    } else {
      body += escapeXmlText(ch)
      spaceOk = true
    }
  }
  switchTo([])
  bodies.push(body)

  // ---- page breaks split the paragraph
  const pieces = bodies.map((b, i) => ({ body: b, first: i === 0 }))
  let breakAfterLast = false
  if (pieces.length > 1 && pieces[pieces.length - 1].body === '') {
    pieces.pop()
    breakAfterLast = true
  }
  let breakBeforeFirst = false
  if (pieces.length > 1 && pieces[0].body === '') {
    pieces.shift()
    breakBeforeFirst = true
  }
  const out: string[] = []
  pieces.forEach((piece, i) => {
    const extra: AttrOverrides = {}
    const isFirst = i === 0
    const isLast = i === pieces.length - 1
    if (!isFirst || breakBeforeFirst) extra['fo:break-before'] = 'page'
    // a section starts once: never on a split-off part or a paragraph that only follows the start
    if (!isFirst || continues) extra['style:master-page-name'] = null
    if (isLast && breakAfterLast) extra['fo:break-after'] = 'page'
    else if (styleInfo.breakAfter) extra['fo:break-after'] = 'auto'
    const styleName = styleFor(extra)
    out.push(
      wrapParagraph(rctx, para, isFirst ? model : null, styleName, piece.body, part, !styleChanged),
    )
  })
  return out.join('')
}

/** ODF markup that starts with a drawing anchored as a character (it takes a character position). */
function isCharacterObjectXml(xml: string): boolean {
  const tag = /^<([\w.-]+):[\w.-]+(?=[\s/>])[^>]*>/.exec(xml)
  return !!tag && tag[1] === 'draw' && /\stext:anchor-type\s*=\s*["']as-char["']/.test(tag[0])
}

/**
 * The paragraph element; the original start tag (ids, unknown attributes) is reused when it fits.
 * A `text:p` that is a heading only through its style's outline level (how Hancom writes its
 * outline paragraphs and how docxToOdt writes headings) stays a `text:p` while its style is
 * unchanged: Hancom numbers every `text:h` ("1.", "1.1.").
 */
function wrapParagraph(
  rctx: OoxmlToOdfContext,
  para: EditedParagraph,
  model: ParagraphModel | null,
  styleName: string | null,
  body: string,
  part: OdtStylePart,
  sameStyle: boolean,
): string {
  const prefixes = rctx.part(part).prefixes
  const heading = para.type === 'heading' && !(sameStyle && model?.element === 'text:p')
  const element = heading ? 'text:h' : 'text:p'
  const level = heading ? String(Math.max(1, Math.min(10, para.level ?? 1))) : null
  let open: string
  let close: string
  if (model && model.element === element) {
    const overrides: AttrOverrides = { 'text:style-name': styleName }
    if (level !== null) overrides['text:outline-level'] = level
    open = patchStartTag(model.openTag, prefixes, overrides)
    close = model.closeTag
  } else {
    const style = styleName !== null ? ` text:style-name="${escapeXmlAttr(styleName)}"` : ''
    open = `<${element}${style}${level !== null ? ` text:outline-level="${level}"` : ''}>`
    close = `</${element}>`
  }
  return `${open}${body}${close}`
}
