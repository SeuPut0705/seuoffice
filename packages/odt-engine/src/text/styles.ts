/**
 * Style tables both ways.
 *
 * Forward: ODF common paragraph styles become docx paragraph styles (same
 * display names, `basedOn` following the parent chain), the default style
 * becomes `w:docDefaults`. Tab stops are not put into docx styles: ODF
 * replaces a parent's tab list while OOXML merges it, so paragraphs carry
 * their effective tab list directly. Synthetic `Heading1…6` and `Hyperlink`
 * styles are added when the ODT has none, so the editor's heading and link
 * commands have styles to reference.
 *
 * Reverse ("스타일 고치기", "기본 글꼴 바꾸기"): a docx style whose XML differs
 * from what the bridge wrote is diffed property by property and only the
 * changed attributes are patched into the ODF common style, in place, keeping
 * its (Hancom) name and every other byte.
 */
import { generateParagraphXml, type GeneratedBlock, type ParaFormat } from '@genoffice/docx-engine'
import type {
  BridgeMap,
  BridgeStyleEntry,
  OdfToOoxmlContext,
  OoxmlToOdfContext,
} from '../core/convert'
import type { OdtStyle } from '../core/styles'
import { decodeXmlEntities, escapeXmlAttr } from '../core/xml'
import {
  type TextFormat,
  changedParaKeys,
  changedTextKeys,
  paraFormatFromOdf,
  paraKeys,
  paraOverrides,
  textFormatFromOdf,
  textKeys,
  textOverrides,
} from './props'
import { editStyleXml } from './style-xml'
import { twips } from './units'

// ---------------------------------------------------------------------------
// OOXML property fragments written by the docx engine's own generator

/** `<w:pPr>…</w:pPr>` the engine writes for a paragraph shape ('' when empty). */
export function ooxmlPPr(ctx: OdfToOoxmlContext, block: Omit<GeneratedBlock, 'runs'>): string {
  const xml = generateParagraphXml({ ...block, runs: [] }, ctx.generate)
  const m = /^<w:p>(<w:pPr>[\s\S]*<\/w:pPr>)<\/w:p>$/.exec(xml)
  return m ? m[1] : ''
}

/** `<w:rPr>…</w:rPr>` the engine writes for run formatting ('' when empty). */
export function ooxmlRPr(ctx: OdfToOoxmlContext, format: TextFormat): string {
  const xml = generateParagraphXml(
    { type: 'paragraph', runs: [{ text: 'x', ...format }] },
    ctx.generate,
  )
  return /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(xml)?.[0] ?? ''
}

// ---------------------------------------------------------------------------
// Style id lookup

const lookups = new WeakMap<BridgeMap, Map<string, BridgeStyleEntry>>()

/** The docx style mirroring an ODF common paragraph style, if any. */
export function styleEntryForOdf(map: BridgeMap, odfName: string | null): BridgeStyleEntry | null {
  if (odfName === null) return null
  let byName = lookups.get(map)
  if (!byName || byName.size === 0) {
    byName = new Map()
    for (const e of map.styles.paragraph) if (e.odfName !== null) byName.set(e.odfName, e)
    lookups.set(map, byName)
  }
  return byName.get(odfName) ?? null
}

export function styleEntryById(
  map: BridgeMap,
  styleId: string | undefined,
): BridgeStyleEntry | null {
  if (!styleId) return null
  return map.styles.paragraph.find((e) => e.styleId === styleId) ?? null
}

// ---------------------------------------------------------------------------
// Forward

const HEADING_SIZES = [32, 28, 26, 24, 22, 22]

/** Writes the docx styles and docDefaults for the ODT's common styles into `ctx.docx`. */
export function convertOdtStyles(ctx: OdfToOoxmlContext): void {
  const { doc, map } = ctx
  const info = ctx.part('styles.xml')
  const commons = doc.styles.all.filter(
    (s) => s.kind === 'style' && s.family === 'paragraph' && !s.automatic,
  )
  const used = new Set<string>()
  const take = (id: string) => {
    used.add(id.toLowerCase())
    return id
  }
  const isFree = (id: string) => !used.has(id.toLowerCase())
  const ids = new Map<string, string>()
  const standard = commons.find((s) => s.name === 'Standard')
  if (standard) ids.set(standard.name, take('Normal'))
  else take('Normal')
  for (const s of commons) {
    const m =
      /^Heading_20_([1-9])$/.exec(s.name) ??
      /^Heading ([1-9])$/.exec(s.displayName ?? '') ??
      /^Heading([1-9])$/.exec(s.name)
    if (m && !ids.has(s.name) && isFree(`Heading${m[1]}`)) ids.set(s.name, take(`Heading${m[1]}`))
  }
  for (let level = 1; level <= 6; level++) {
    if (isFree(`Heading${level}`) && ![...ids.values()].includes(`Heading${level}`)) {
      // reserve for the synthetic heading styles below
      used.add(`heading${level}`)
    }
  }
  take('Hyperlink')
  let seq = 0
  for (const s of commons) {
    if (ids.has(s.name)) continue
    let id = s.name.replace(/[^A-Za-z0-9]/g, '')
    if (!/[A-Za-z]/.test(id) || !isFree(id)) {
      do id = `OdtStyle${++seq}`
      while (!isFree(id))
    }
    ids.set(s.name, take(id))
  }

  const entries: BridgeStyleEntry[] = []
  for (const s of commons) {
    const id = ids.get(s.name) as string
    const parent = s.parentName !== null ? ids.get(s.parentName) : undefined
    const next = s.nextStyleName !== null ? ids.get(s.nextStyleName) : undefined
    const level = /^Heading([1-9])$/.exec(id)
    const pPr = ooxmlPPr(ctx, {
      type: 'paragraph',
      format: paraFormatFromOdf(s.properties['style:paragraph-properties'] ?? {}, null, 0),
    })
    const outline = level ? `<w:outlineLvl w:val="${Number(level[1]) - 1}"/>` : ''
    const pPrWithOutline = outline
      ? pPr
        ? pPr.replace('</w:pPr>', `${outline}</w:pPr>`)
        : `<w:pPr>${outline}</w:pPr>`
      : pPr
    const rPr = ooxmlRPr(
      ctx,
      textFormatFromOdf(s.properties['style:text-properties'] ?? {}, info.fontFaces),
    )
    const xml =
      `<w:style w:type="paragraph"${id === 'Normal' ? ' w:default="1"' : ''} w:styleId="${escapeXmlAttr(id)}">` +
      `<w:name w:val="${escapeXmlAttr(id === 'Normal' ? 'Normal' : level ? `heading ${level[1]}` : (s.displayName ?? s.name))}"/>` +
      (parent && parent !== id ? `<w:basedOn w:val="${escapeXmlAttr(parent)}"/>` : '') +
      (next ? `<w:next w:val="${escapeXmlAttr(next)}"/>` : '') +
      `<w:qFormat/>${pPrWithOutline}${rPr}</w:style>`
    entries.push({ styleId: id, odfName: s.name, headingLevel: null, xml })
  }
  if (!standard) {
    entries.unshift({
      styleId: 'Normal',
      odfName: null,
      headingLevel: null,
      xml: '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>',
    })
  }
  for (let level = 1; level <= 6; level++) {
    const id = `Heading${level}`
    if (entries.some((e) => e.styleId === id)) continue
    entries.push({
      styleId: id,
      odfName: null,
      headingLevel: level,
      xml:
        `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="heading ${level}"/>` +
        `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
        `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
        `<w:rPr><w:b/><w:bCs/><w:sz w:val="${HEADING_SIZES[level - 1]}"/><w:szCs w:val="${HEADING_SIZES[level - 1]}"/></w:rPr></w:style>`,
    })
  }
  for (const e of entries) {
    const level = /^Heading([1-9])$/.exec(e.styleId)
    if (level && !ctx.generate.headingStyleIds.has(Number(level[1])))
      ctx.generate.headingStyleIds.set(Number(level[1]), e.styleId)
  }
  map.styles.paragraph = entries
  ctx.docx.styles.push(
    ...entries.map((e) => e.xml),
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>',
  )

  const def = doc.styles.defaultStyle('paragraph') ?? doc.styles.defaultStyle('text') ?? null
  const defRPr = def
    ? ooxmlRPr(
        ctx,
        textFormatFromOdf(def.properties['style:text-properties'] ?? {}, info.fontFaces),
      )
    : ''
  const defPPr = def
    ? ooxmlPPr(ctx, {
        type: 'paragraph',
        format: paraFormatFromOdf(def.properties['style:paragraph-properties'] ?? {}, null, 0),
      })
    : ''
  map.styles.docDefaults =
    `<w:docDefaults><w:rPrDefault>${defRPr || '<w:rPr/>'}</w:rPrDefault>` +
    `<w:pPrDefault>${defPPr || '<w:pPr/>'}</w:pPrDefault></w:docDefaults>`
  map.styles.defaultFamily = def?.family ?? null
  ctx.docx.docDefaults = map.styles.docDefaults
  map.styles.baseParagraphStyle = standard ? standard.name : dominantParent(ctx)
}

/** The parent most automatic paragraph styles of the body name (Hancom: an undefined `Standard`). */
function dominantParent(ctx: OdfToOoxmlContext): string | null {
  const counts = new Map<string, number>()
  for (const s of ctx.doc.styles.all) {
    if (s.kind !== 'style' || s.family !== 'paragraph' || !s.automatic || s.part !== 'content.xml')
      continue
    if (s.parentName !== null) counts.set(s.parentName, (counts.get(s.parentName) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [name, n] of counts) {
    if (n > bestCount) {
      best = name
      bestCount = n
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Minimal OOXML property readers (style definitions and docDefaults)

function tagOf(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}(?=[\\s/>])[^>]*>`).exec(xml)?.[0]
}
function attrOf(tag: string | undefined, name: string): string | undefined {
  if (!tag) return undefined
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)
  return m ? decodeXmlEntities(m[1] ?? m[2] ?? '') : undefined
}
function onOff(tag: string | undefined): boolean | undefined {
  if (!tag) return undefined
  const v = attrOf(tag, 'w:val')
  return v === undefined || !['0', 'false', 'off', 'none'].includes(v.toLowerCase())
}
const int = (v: string | undefined) => {
  const n = v === undefined ? NaN : parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

/** Paragraph formatting of a `w:pPr` (the subset the bridge maps). */
export function readOoxmlPPr(pPr: string): ParaFormat {
  const f: ParaFormat = {}
  const jc = attrOf(tagOf(pPr, 'w:jc'), 'w:val')
  if (jc) {
    f.align =
      jc === 'both'
        ? 'justify'
        : jc === 'distribute'
          ? 'distribute'
          : jc === 'center'
            ? 'center'
            : jc === 'right' || jc === 'end'
              ? 'right'
              : 'left'
  }
  const ind = tagOf(pPr, 'w:ind')
  const left = int(attrOf(ind, 'w:left') ?? attrOf(ind, 'w:start'))
  if (left !== undefined) f.indentLeft = left
  const right = int(attrOf(ind, 'w:right') ?? attrOf(ind, 'w:end'))
  if (right !== undefined) f.indentRight = right
  const hanging = int(attrOf(ind, 'w:hanging'))
  const firstLine = int(attrOf(ind, 'w:firstLine'))
  if (hanging !== undefined) f.indentFirstLine = -hanging
  else if (firstLine !== undefined) f.indentFirstLine = firstLine
  const sp = tagOf(pPr, 'w:spacing')
  const before = int(attrOf(sp, 'w:before'))
  if (before !== undefined) f.spaceBefore = before
  const after = int(attrOf(sp, 'w:after'))
  if (after !== undefined) f.spaceAfter = after
  const line = int(attrOf(sp, 'w:line'))
  const rule = attrOf(sp, 'w:lineRule')
  if (line !== undefined) {
    if (rule === 'exact' || rule === 'atLeast') {
      f.lineRule = rule
      f.lineRawTwips = line
    } else {
      f.lineRule = 'auto'
      f.lineSpacing = line / 240
    }
  }
  if (onOff(tagOf(pPr, 'w:keepNext'))) f.keepNext = true
  if (onOff(tagOf(pPr, 'w:keepLines'))) f.keepLines = true
  if (onOff(tagOf(pPr, 'w:pageBreakBefore'))) f.pageBreakBefore = true
  const fill = attrOf(tagOf(pPr, 'w:shd'), 'w:fill')
  if (fill && fill !== 'auto') f.shadingFill = fill.toUpperCase()
  return f
}

/** Run formatting of a `w:rPr` (the subset the bridge maps). */
export function readOoxmlRPr(rPr: string): TextFormat {
  const f: TextFormat = {}
  const fonts = tagOf(rPr, 'w:rFonts')
  const ascii = attrOf(fonts, 'w:ascii') ?? attrOf(fonts, 'w:hAnsi')
  const ea = attrOf(fonts, 'w:eastAsia')
  const cs = attrOf(fonts, 'w:cs')
  if (ascii) f.fontAscii = ascii
  if (ea) f.eastAsiaFont = ea
  if (ea ?? ascii) f.font = ea ?? ascii
  if (cs) f.fontCs = cs
  const b = onOff(tagOf(rPr, 'w:b'))
  if (b !== undefined) f.bold = b
  const i = onOff(tagOf(rPr, 'w:i'))
  if (i !== undefined) f.italic = i
  const u = attrOf(tagOf(rPr, 'w:u'), 'w:val')
  if (u !== undefined) f.underline = u !== 'none'
  const s = onOff(tagOf(rPr, 'w:strike'))
  if (s !== undefined) f.strike = s
  const color = attrOf(tagOf(rPr, 'w:color'), 'w:val')
  if (color && color !== 'auto') f.color = color.toUpperCase()
  const sz = int(attrOf(tagOf(rPr, 'w:sz'), 'w:val'))
  if (sz) f.sizeHalfPoints = sz
  const hl = attrOf(tagOf(rPr, 'w:highlight'), 'w:val')
  if (hl && hl !== 'none') f.highlight = hl
  const shd = attrOf(tagOf(rPr, 'w:shd'), 'w:fill')
  if (shd && shd !== 'auto') f.shading = shd.toUpperCase()
  const va = attrOf(tagOf(rPr, 'w:vertAlign'), 'w:val')
  if (va === 'superscript' || va === 'subscript') f.vertAlign = va
  const spc = int(attrOf(tagOf(rPr, 'w:spacing'), 'w:val'))
  if (spc !== undefined) f.charSpacingTwips = spc
  const w = int(attrOf(tagOf(rPr, 'w:w'), 'w:val'))
  if (w && w !== 100) f.charScalePct = w
  if (onOff(tagOf(rPr, 'w:caps'))) f.caps = 'all'
  else if (onOff(tagOf(rPr, 'w:smallCaps'))) f.caps = 'small'
  return f
}

const firstBlock = (xml: string, name: string): string =>
  new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`).exec(xml)?.[0] ?? ''

/** `w:style` elements of a styles.xml by style id (exact XML). */
export function docxStylesById(stylesXml: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of stylesXml.matchAll(/<w:style(?=[\s>/])[^>]*?(?:\/>|>[\s\S]*?<\/w:style>)/g)) {
    const id = attrOf(/^<w:style[^>]*>/.exec(m[0])?.[0], 'w:styleId')
    if (id !== undefined && !out.has(id)) out.set(id, m[0])
  }
  return out
}

// ---------------------------------------------------------------------------
// Reverse

function styleDiff(
  rctx: OoxmlToOdfContext,
  originalXml: string,
  editedXml: string,
  odfMarginLeft: number,
): { para: Record<string, string | null>; text: Record<string, string | null> } {
  const oP = readOoxmlPPr(firstBlock(originalXml, 'w:pPr'))
  const eP = readOoxmlPPr(firstBlock(editedXml, 'w:pPr'))
  const oR = readOoxmlRPr(firstBlock(originalXml, 'w:rPr'))
  const eR = readOoxmlRPr(firstBlock(editedXml, 'w:rPr'))
  const oKeys = paraKeys(oP)
  const pKeys = changedParaKeys(oKeys, paraKeys(eP)).filter((k) => k !== 'tabs')
  const para = paraOverrides(pKeys, eP, eP.indentLeft ?? odfMarginLeft, oKeys).attrs
  const eTK = textKeys(eR)
  const text = textOverrides(changedTextKeys(textKeys(oR), eTK), eTK, (family) =>
    rctx.fontFace('styles.xml', family),
  )
  return { para, text }
}

/**
 * Writes changed docx styles and docDefaults of the edited docx back into the
 * ODT's styles.xml as narrow patches. Needs `rctx.options.editedStylesXml`.
 */
export function updateOdtStyles(rctx: OoxmlToOdfContext): void {
  const editedXml = rctx.options.editedStylesXml
  if (!editedXml) return
  const stylesXml = rctx.part('styles.xml').xml
  if (!stylesXml) return
  const prefixes = rctx.part('styles.xml').prefixes
  const edited = docxStylesById(editedXml)
  for (const entry of rctx.map.styles.paragraph) {
    if (entry.odfName === null) continue
    const now = edited.get(entry.styleId)
    if (now === undefined || now === entry.xml) continue
    const style = rctx.doc.styles.common(entry.odfName, 'paragraph')
    if (!style) continue
    const margin = twips(style.properties['style:paragraph-properties']?.['fo:margin-left']) ?? 0
    const { para, text } = styleDiff(rctx, entry.xml, now, margin)
    if (!Object.keys(para).length && !Object.keys(text).length) continue
    patchStyle(rctx, style, stylesXml, prefixes, para, text)
  }
  const editedDefaults = firstBlock(editedXml, 'w:docDefaults')
  if (editedDefaults && editedDefaults !== rctx.map.styles.docDefaults) {
    const { para, text } = styleDiff(rctx, rctx.map.styles.docDefaults, editedDefaults, 0)
    if (!Object.keys(para).length && !Object.keys(text).length) return
    const family = rctx.map.styles.defaultFamily
    const def = family ? rctx.doc.styles.defaultStyle(family) : undefined
    if (def && def.part === 'styles.xml') {
      patchStyle(rctx, def, stylesXml, prefixes, para, text)
      return
    }
    const container = rctx.doc.styles.containers.styles.styles
    if (!container) return
    const attrs = (o: Record<string, string | null>) =>
      Object.entries(o)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => ` ${k}="${escapeXmlAttr(v as string)}"`)
        .join('')
    const xml =
      '<style:default-style style:family="paragraph">' +
      (Object.keys(para).length ? `<style:paragraph-properties${attrs(para)}/>` : '') +
      (Object.keys(text).length ? `<style:text-properties${attrs(text)}/>` : '') +
      '</style:default-style>'
    if (container.selfClosing)
      rctx.patch(
        'styles.xml',
        container.start,
        container.end,
        `<office:styles>${xml}</office:styles>`,
      )
    else rctx.patch('styles.xml', container.openEnd, container.openEnd, xml)
  }
}

function patchStyle(
  rctx: OoxmlToOdfContext,
  style: OdtStyle,
  stylesXml: string,
  prefixes: ReturnType<OoxmlToOdfContext['part']>['prefixes'],
  para: Record<string, string | null>,
  text: Record<string, string | null>,
): void {
  const props: Record<string, Record<string, string | null>> = {}
  if (Object.keys(para).length) props['style:paragraph-properties'] = para
  if (Object.keys(text).length) props['style:text-properties'] = text
  const xml = editStyleXml(stylesXml.slice(style.start, style.end), prefixes, { props })
  rctx.patch('styles.xml', style.start, style.end, xml)
}
