/**
 * Lists both ways.
 *
 * Forward: each ODF list style (`text:list-style`) becomes one docx
 * `w:abstractNum`; each top-level `text:list` becomes one `w:num`, except that
 * a list continuing another (`text:continue-list`, `text:continue-numbering`)
 * shares the instance it continues. Paragraphs become numbered docx
 * paragraphs at `w:ilvl` = nesting depth - 1.
 *
 * Reverse: consecutive list paragraphs of the edited docx are grouped by
 * `w:numId` and written as nested `text:list` / `text:list-item` markup. The
 * first group continuing an original list reuses that list's start tag
 * (style, `xml:id`); later groups of the same list continue its numbering.
 * A list the editor created gets a new automatic list style from the edited
 * docx's numbering definition.
 */
import {
  type CustomNumberingLevel,
  type NumberingDef,
  customLevelXml,
} from '@genoffice/docx-engine'
import type { BridgeList, OdfToOoxmlContext, OoxmlToOdfContext } from '../core/convert'
import type { OdtListLevel, OdtStyle } from '../core/styles'
import { escapeXmlAttr } from '../core/xml'
import { textFormatFromOdf } from './props'
import { twips, twipsToCm } from './units'

// ---------------------------------------------------------------------------
// Number formats

const NUM_FORMATS: Array<[string, string]> = [
  ['1', 'decimal'],
  ['a', 'lowerLetter'],
  ['A', 'upperLetter'],
  ['i', 'lowerRoman'],
  ['I', 'upperRoman'],
  ['가, 나, 다, ...', 'ganada'],
  ['ㄱ, ㄴ, ㄷ, ...', 'chosung'],
  ['①, ②, ③, ...', 'decimalEnclosedCircle'],
  ['일, 이, 삼, ...', 'koreanDigital'],
  ['一, 二, 三, ...', 'ideographTraditional'],
  ['', 'none'],
]

export function numFmtFromOdf(format: string | undefined): string {
  if (format === undefined) return 'decimal'
  return NUM_FORMATS.find(([odf]) => odf === format)?.[1] ?? 'decimal'
}

export function numFmtToOdf(numFmt: string): string {
  return NUM_FORMATS.find(([, ooxml]) => ooxml === numFmt)?.[0] ?? '1'
}

// ---------------------------------------------------------------------------
// Forward

interface ListStyleNumbering {
  abstractNumId: string
  /** docx list kind per 0-based level */
  kinds: Array<'bullet' | 'ordered'>
}

interface ListState {
  byStyle: Map<string, ListStyleNumbering>
  /** xml:id of a converted top-level list → numId */
  byXmlId: Map<string, string>
  /** list style name → numId of the last list using it */
  lastByStyle: Map<string, string>
  nextAbstract: number
  nextNum: number
}

const states = new WeakMap<OdfToOoxmlContext, ListState>()
const stateOf = (ctx: OdfToOoxmlContext): ListState => {
  let s = states.get(ctx)
  if (!s) {
    s = {
      byStyle: new Map(),
      byXmlId: new Map(),
      lastByStyle: new Map(),
      nextAbstract: 0,
      nextNum: 1,
    }
    states.set(ctx, s)
  }
  return s
}

function levelToCustom(
  level: OdtListLevel | undefined,
  depth: number,
  fontFaces: ReadonlyMap<string, string>,
): CustomNumberingLevel {
  const fallbackLeft = 400 * (depth + 1)
  if (!level)
    return { numFmt: 'decimal', lvlText: `%${depth + 1}.`, indentLeft: fallbackLeft, hanging: 360 }
  const a = level.attrs
  const llp = level.properties['style:list-level-properties'] ?? {}
  const align = level.properties['style:list-level-properties/style:list-level-label-alignment']
  let indentLeft: number
  let hanging: number
  let suff: CustomNumberingLevel['suff'] = 'tab'
  let tabStop: number | undefined
  if (llp['text:list-level-position-and-space-mode'] === 'label-alignment' && align) {
    indentLeft = twips(align['fo:margin-left']) ?? fallbackLeft
    const ti = twips(align['fo:text-indent']) ?? 0
    hanging = ti < 0 ? -ti : 0
    const follow = align['text:label-followed-by']
    suff = follow === 'space' ? 'space' : follow === 'nothing' ? 'nothing' : 'tab'
    tabStop = twips(align['text:list-tab-stop-position'])
  } else {
    const before = twips(llp['text:space-before']) ?? 0
    const width = twips(llp['text:min-label-width']) ?? 360
    indentLeft = before + width
    hanging = width
  }
  const text = textFormatFromOdf(level.properties['style:text-properties'] ?? {}, fontFaces)
  const out: CustomNumberingLevel = { numFmt: 'decimal', lvlText: '', indentLeft, hanging, suff }
  if (tabStop !== undefined && tabStop !== indentLeft) out.tabStop = tabStop
  if (text.font) out.font = text.font
  if (level.kind === 'bullet' || level.kind === 'image') {
    out.numFmt = 'bullet'
    out.lvlText = a['text:bullet-char'] ?? '•'
    return out
  }
  out.numFmt = numFmtFromOdf(a['style:num-format'])
  const display = Math.max(
    1,
    Math.min(depth + 1, parseInt(a['text:display-levels'] ?? '1', 10) || 1),
  )
  const parts: string[] = []
  for (let k = depth + 2 - display; k <= depth + 1; k++) parts.push(`%${k}`)
  out.lvlText = `${a['style:num-prefix'] ?? ''}${parts.join('.')}${a['style:num-suffix'] ?? ''}`
  const start = parseInt(a['text:start-value'] ?? '1', 10)
  if (Number.isFinite(start) && start !== 1) out.start = start
  return out
}

function abstractFor(ctx: OdfToOoxmlContext, styleName: string | null): ListStyleNumbering {
  const state = stateOf(ctx)
  const key = styleName ?? ''
  let found = state.byStyle.get(key)
  if (found) return found
  const style: OdtStyle | undefined =
    styleName === null ? undefined : ctx.doc.styles.listStyle(styleName, 'content')
  const faces = ctx.part(style?.part ?? 'content.xml').fontFaces
  const levels: CustomNumberingLevel[] = []
  for (let depth = 0; depth < 9; depth++) {
    levels.push(
      levelToCustom(
        style?.levels.find((l) => l.level === depth + 1),
        depth,
        faces,
      ),
    )
  }
  const abstractNumId = String(state.nextAbstract++)
  ctx.docx.abstractNums.push(
    `<w:abstractNum w:abstractNumId="${abstractNumId}"><w:multiLevelType w:val="hybridMultilevel"/>` +
      levels.map((l, i) => customLevelXml(l, i)).join('') +
      '</w:abstractNum>',
  )
  found = {
    abstractNumId,
    kinds: levels.map((l) => (l.numFmt === 'bullet' ? 'bullet' : 'ordered')),
  }
  state.byStyle.set(key, found)
  return found
}

export interface ListInstance {
  numId: string
  kinds: Array<'bullet' | 'ordered'>
  list: BridgeList
}

/**
 * The `w:num` for a top-level list block (creating it, or reusing the one it
 * continues).
 */
export function listInstance(
  ctx: OdfToOoxmlContext,
  blockId: number,
  attrs: {
    styleName: string | null
    xmlId: string | null
    continueList: string | null
    continueNumbering: boolean
  },
): ListInstance {
  const state = stateOf(ctx)
  const abs = abstractFor(ctx, attrs.styleName)
  let numId =
    (attrs.continueList !== null ? state.byXmlId.get(attrs.continueList) : undefined) ??
    (attrs.continueNumbering ? state.lastByStyle.get(attrs.styleName ?? '') : undefined)
  let list = numId ? ctx.map.lists.find((l) => l.numId === numId) : undefined
  if (!numId || !list) {
    numId = String(state.nextNum++)
    ctx.docx.nums.push(
      `<w:num w:numId="${numId}"><w:abstractNumId w:val="${abs.abstractNumId}"/></w:num>`,
    )
    list = { numId, abstractNumId: abs.abstractNumId, styleName: attrs.styleName, blocks: [] }
    ctx.map.lists.push(list)
  }
  list.blocks.push(blockId)
  if (attrs.xmlId !== null) state.byXmlId.set(attrs.xmlId, numId)
  state.lastByStyle.set(attrs.styleName ?? '', numId)
  return { numId, kinds: abs.kinds, list }
}

// ---------------------------------------------------------------------------
// Reverse

/** A new automatic list style from an edited docx numbering definition; returns its name. */
export function listStyleFromNumbering(
  rctx: OoxmlToOdfContext,
  def: NumberingDef | undefined,
): string {
  const key = `list:${def?.abstractNumId ?? 'none'}`
  return rctx.derivedStyle('content.xml', key, 'L', (name) => {
    const levels: string[] = []
    for (let i = 0; i < 9; i++) {
      const l = def?.levels[i]
      const level = i + 1
      const left = l?.indentLeft ?? 720 * level
      const hanging = l?.hanging ?? 360
      const props =
        '<style:list-level-properties text:list-level-position-and-space-mode="label-alignment">' +
        `<style:list-level-label-alignment text:label-followed-by="${l?.suff === 'space' ? 'space' : l?.suff === 'nothing' ? 'nothing' : 'listtab'}" ` +
        `text:list-tab-stop-position="${twipsToCm(left)}" fo:text-indent="${twipsToCm(-hanging)}" fo:margin-left="${twipsToCm(left)}"/>` +
        '</style:list-level-properties>'
      if (!l || l.numFmt === 'bullet') {
        levels.push(
          `<text:list-level-style-bullet text:level="${level}" text:bullet-char="${escapeXmlAttr(l?.lvlText || '•')}">${props}</text:list-level-style-bullet>`,
        )
        continue
      }
      const m = /^([\s\S]*?)((?:%\d)(?:\.%\d)*)([\s\S]*)$/.exec(l.lvlText)
      const prefix = m ? m[1] : ''
      const suffix = m ? m[3] : l.lvlText
      const display = m ? m[2].split('.').length : 1
      levels.push(
        `<text:list-level-style-number text:level="${level}"` +
          (prefix ? ` style:num-prefix="${escapeXmlAttr(prefix)}"` : '') +
          (suffix ? ` style:num-suffix="${escapeXmlAttr(suffix)}"` : '') +
          ` style:num-format="${escapeXmlAttr(numFmtToOdf(l.numFmt))}"` +
          (display > 1 ? ` text:display-levels="${display}"` : '') +
          // ODF start values are positive integers (a docx list may start at 0)
          (l.start > 1 ? ` text:start-value="${l.start}"` : '') +
          `>${props}</text:list-level-style-number>`,
      )
    }
    return `<text:list-style style:name="${escapeXmlAttr(name)}">${levels.join('')}</text:list-style>`
  })
}
