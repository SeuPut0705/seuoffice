// Group `fielddisplay`: fieldDisplayOf of parse-fields.ts, the display hint of
// a protected field paragraph. The text is the paragraph; the styles map and
// the resolver are built on both sides from `args.parts` as the `resolve`
// group builds them. `args.resolver: false` calls it without a resolver,
// `args.styles: false` without the styles map.
import { parseNumbering } from './reference/parse-package'
import { fieldDisplayOf } from './reference/parse-fields'
import { parseStyles } from './reference/parse-styles'
import { resolveCtxOf, type ResolveCtx } from './reference/resolve-props'
import type {
  DocDefaults,
  NumberingDef,
  StyleInfo,
  ThemeColors,
  ThemeFonts,
} from './reference/types'
import { zipOf, type CallSpec, type Input } from './calls-spec'
import { parseTheme } from './compare-package'
import { elementFragments } from './fragments'

// ---------------------------------------------------------------- the context

// same as calls-resolve.ts: its context builder is not exported
interface Parsed {
  styles: Map<string, StyleInfo>
  docDefaults?: DocDefaults
  numbering: Map<string, NumberingDef>
  theme: { fonts: ThemeFonts | null; colors: ThemeColors | null }
}

// same as calls-resolve.ts
async function parse(parts: unknown): Promise<Parsed> {
  const zip = zipOf(parts)
  const theme = await parseTheme(zip)
  const { styles, docDefaults } = await parseStyles(zip, theme.colors, theme.fonts)
  const { defs } = await parseNumbering(zip)
  return { styles, docDefaults, numbering: defs, theme }
}

// same as calls-resolve.ts
const parsedByParts = new WeakMap<object, Promise<Parsed>>()

// same as calls-resolve.ts
function parsedOf(parts: unknown): Promise<Parsed> {
  if (typeof parts !== 'object' || parts === null) return parse(parts)
  let parsed = parsedByParts.get(parts)
  if (!parsed) {
    parsed = parse(parts)
    parsedByParts.set(parts, parsed)
  }
  return parsed
}

// same as calls-resolve.ts
interface CompatArgs {
  compatibilityMode?: number
  doNotUseHTMLParagraphAutoSpacing?: boolean
  indentNotNumberingTabStop?: boolean
}

// same as calls-resolve.ts
function compatOf(args: Record<string, unknown>): CompatArgs {
  const compat = (args.compat ?? {}) as CompatArgs
  return {
    compatibilityMode: compat.compatibilityMode,
    doNotUseHTMLParagraphAutoSpacing: compat.doNotUseHTMLParagraphAutoSpacing,
    indentNotNumberingTabStop: compat.indentNotNumberingTabStop,
  }
}

// same as calls-resolve.ts
async function ctxOf(args: Record<string, unknown>): Promise<ResolveCtx> {
  const { styles, docDefaults, numbering, theme } = await parsedOf(args.parts)
  const ctx = resolveCtxOf({
    styles,
    docDefaults,
    numbering,
    themeFonts: theme.fonts,
    themeColors: theme.colors,
    ...compatOf(args),
  })
  if (args.table !== undefined) ctx.table = args.table as ResolveCtx['table']
  return ctx
}

async function displayOf(text: string, args: Record<string, unknown>): Promise<unknown> {
  const ctx = await ctxOf(args)
  return fieldDisplayOf(
    text,
    args.styles === false ? undefined : ctx.styles,
    args.resolver === false ? undefined : ctx,
  )
}

// ---------------------------------------------------------------- the corpus

const PARTS = ['word/styles.xml', 'word/numbering.xml', 'word/theme/theme1.xml']
/** Characters of parts per spec and document: every call carries its parts. */
const PARTS_BUDGET = 1_500_000
const MAX_FIELD_PARAGRAPHS = 60
const MAX_PLAIN_PARAGRAPHS = 10
const BODY_PART = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/
const FIELD_MACHINERY = /<w:(?:fldChar|instrText|fldSimple)\b/

/** Style ids that are TOC entry styles, or based on one. */
function tocStyleIds(styles: string): Set<string> {
  const toc = new Set<string>()
  const basedOn: Array<[string, string]> = []
  for (const style of elementFragments(styles, 'w:style')) {
    const id = /\bw:styleId="([^"]*)"/.exec(style)?.[1]
    if (id === undefined) continue
    const name = /<w:name\b[^>]*\bw:val="([^"]*)"/.exec(style)?.[1] ?? ''
    if (
      /^(?:TOC ?[1-9]|TableofFigures)$/i.test(id) ||
      /^(?:toc ?[1-9]|table of figures)$/i.test(name)
    )
      toc.add(id)
    const base = /<w:basedOn\b[^>]*\bw:val="([^"]*)"/.exec(style)?.[1]
    if (base !== undefined) basedOn.push([id, base])
  }
  for (let grew = true; grew;) {
    grew = false
    for (const [id, base] of basedOn) {
      if (toc.has(base) && !toc.has(id)) {
        toc.add(id)
        grew = true
      }
    }
  }
  return toc
}

function documentInputs(parts: ReadonlyMap<string, string>): Input[] {
  const own: Array<[string, string]> = PARTS.flatMap((name) => {
    const text = parts.get(name)
    return text === undefined ? [] : [[name, text] as [string, string]]
  })
  const size = own.reduce((sum, [, text]) => sum + text.length, 0)
  const cap = Math.max(
    3,
    Math.min(MAX_FIELD_PARAGRAPHS, Math.floor(PARTS_BUDGET / Math.max(1, size))),
  )
  const toc = tocStyleIds(parts.get('word/styles.xml') ?? '')
  const paragraphs = [...parts]
    .filter(([name]) => BODY_PART.test(name))
    .flatMap(([, text]) => elementFragments(text, 'w:p'))
  const isField = (p: string): boolean => {
    if (FIELD_MACHINERY.test(p)) return true
    const styleId = /<w:pStyle\b[^>]*\bw:val="([^"]*)"/.exec(p)?.[1]
    return styleId !== undefined && toc.has(styleId)
  }
  const fields = paragraphs.filter(isField).slice(0, cap)
  const plain = paragraphs.filter((p) => !isField(p))
  const plainCap = Math.min(MAX_PLAIN_PARAGRAPHS, Math.max(1, cap - fields.length))
  const step = Math.max(1, Math.ceil(plain.length / plainCap))
  const chosen = [...fields, ...plain.filter((_, index) => index % step === 0)]
  const additive = /<w:doNotUseHTMLParagraphAutoSpacing\b/.test(
    parts.get('word/settings.xml') ?? '',
  )
  const args = {
    parts: own,
    ...(additive ? { compat: { doNotUseHTMLParagraphAutoSpacing: true } } : {}),
  }
  return chosen.map((text) => ({ text, args }))
}

// ---------------------------------------------------------------- built inputs

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

const style = (type: string, id: string, inner: string, attrs = '', name = id): string =>
  `<w:style w:type="${type}" w:styleId="${id}"${attrs}><w:name w:val="${name}"/>${inner}</w:style>`
const tabs = (...stops: string[]): string => `<w:tabs>${stops.join('')}</w:tabs>`
const stop = (val: string, pos: string, leader?: string): string =>
  `<w:tab w:val="${val}"${leader === undefined ? '' : ` w:leader="${leader}"`} w:pos="${pos}"/>`

const STYLES_BODY = [
  style(
    'paragraph',
    'Normal',
    '<w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="22"/></w:rPr>',
    ' w:default="1"',
  ),
  style(
    'paragraph',
    'TOC1',
    `<w:basedOn w:val="Normal"/><w:pPr>${tabs(stop('right', '9350', 'dot'))}<w:spacing w:after="100"/></w:pPr><w:rPr><w:b/></w:rPr>`,
    '',
    'toc 1',
  ),
  style(
    'paragraph',
    'TOC2',
    `<w:basedOn w:val="Normal"/><w:pPr>${tabs(stop('left', '880'), stop('right', '9350', 'hyphen'))}<w:ind w:left="220"/></w:pPr>`,
    '',
    'toc 2',
  ),
  style(
    'paragraph',
    'TOC3',
    `<w:basedOn w:val="TOC1"/><w:pPr><w:ind w:left="440" w:hanging="220"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr>`,
    '',
    'toc 3',
  ),
  style('paragraph', 'TOC4', '<w:basedOn w:val="Normal"/>', '', 'toc 4'),
  style(
    'paragraph',
    'TOC5',
    `<w:pPr>${tabs(stop('right', '8000', 'underscore'), stop('left', '0'))}</w:pPr>`,
    '',
    'toc 5',
  ),
  style(
    'paragraph',
    'TOC6',
    `<w:pPr>${tabs(stop('right', '9000', 'middleDot'))}<w:spacing w:line="300" w:lineRule="exact"/></w:pPr>`,
    '',
    'toc 6',
  ),
  style(
    'paragraph',
    'TOC7',
    `<w:pPr>${tabs(stop('right', '9000', 'heavy'))}<w:spacing w:line="360" w:lineRule="auto"/></w:pPr>`,
    '',
    'toc 7',
  ),
  style('paragraph', 'TOC8', `<w:pPr>${tabs(stop('right', '0', 'dot'))}</w:pPr>`, '', 'toc 8'),
  // a right stop at a negative position: a paragraph of this style gets no right tab position
  style(
    'paragraph',
    'TocNegative',
    `<w:pPr>${tabs(stop('right', '-720', 'dot'))}</w:pPr>`,
    '',
    'toc 4',
  ),
  style(
    'paragraph',
    'TOC9',
    `<w:pPr><w:bidi/>${tabs(stop('right', '9350', 'none'), stop('left', '600'))}<w:spacing w:line="280" w:lineRule="atLeast"/></w:pPr><w:rPr><w:rtl/></w:rPr>`,
    '',
    'toc 9',
  ),
  style('paragraph', 'x12', `<w:pPr>${tabs(stop('right', '7000', 'dot'))}</w:pPr>`, '', 'toc 3'),
  style(
    'paragraph',
    'TableofFigures',
    `<w:pPr>${tabs(stop('right', '9350', 'dot'))}</w:pPr>`,
    '',
    'table of figures',
  ),
  style('paragraph', 'Figures', '', '', 'Table of Figures'),
  style(
    'paragraph',
    'MyToc',
    `<w:pPr>${tabs(stop('right', '9000', 'dot'))}</w:pPr>`,
    '',
    'Inhaltsverzeichnis 1',
  ),
  style('paragraph', 'MyTocChild', '<w:basedOn w:val="MyToc"/>', '', 'Inhaltsverzeichnis 2'),
  style(
    'paragraph',
    '__proto__',
    `<w:pPr>${tabs(stop('right', '6000', 'dot'))}</w:pPr>`,
    '',
    'toc 2',
  ),
  style('paragraph', 'toString', '', '', 'TOC 5'),
  style(
    'paragraph',
    'Heading1',
    '<w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="32"/><w:rFonts w:ascii="Cambria"/></w:rPr>',
  ),
  style('character', 'TocLink', '<w:rPr><w:color w:val="0000FF"/><w:u w:val="single"/></w:rPr>'),
  style('character', 'Strong', '<w:rPr><w:b/></w:rPr>'),
].join('')

const DOC_DEFAULTS = `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="SimSun"/><w:sz w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80"/></w:pPr></w:pPrDefault></w:docDefaults>`

const STYLES = `<w:styles ${W}>${DOC_DEFAULTS}${STYLES_BODY}</w:styles>`

const NUMBERING = `<w:numbering ${W}><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="432" w:hanging="432"/><w:tabs><w:tab w:val="num" w:pos="432"/></w:tabs></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`

const RICH: Array<[string, string]> = [
  ['word/styles.xml', STYLES],
  ['word/numbering.xml', NUMBERING],
]
const BARE: Array<[string, string]> = []
/** parseNumbering throws on a part the parser refuses: so does building the context. */
const THROWS: Array<[string, string]> = [
  ['word/styles.xml', STYLES],
  ['word/numbering.xml', `<w:numbering ${W}><w:num w:numId="1"`],
]

const r = (inner: string, rPr = ''): string =>
  `<w:r>${rPr === '' ? '' : `<w:rPr>${rPr}</w:rPr>`}${inner}</w:r>`
const t = (text: string, rPr = ''): string => r(`<w:t xml:space="preserve">${text}</w:t>`, rPr)
const delText = (text: string, rPr = ''): string =>
  r(`<w:delText xml:space="preserve">${text}</w:delText>`, rPr)
const fld = (type: string, rPr = ''): string => r(`<w:fldChar w:fldCharType="${type}"/>`, rPr)
const instr = (code: string, rPr = ''): string =>
  r(`<w:instrText xml:space="preserve">${code}</w:instrText>`, rPr)
const TAB = r('<w:tab/>')
const p = (...runs: string[]): string => `<w:p>${runs.join('')}</w:p>`
const pWith = (pPr: string, ...runs: string[]): string =>
  `<w:p><w:pPr>${pPr}</w:pPr>${runs.join('')}</w:p>`
const styled = (id: string, more: string, ...runs: string[]): string =>
  pWith(`<w:pStyle w:val="${id}"/>${more}`, ...runs)
const field = (code: string, ...result: string[]): string[] => [
  fld('begin'),
  instr(code),
  fld('separate'),
  ...result,
  fld('end'),
]
const pageref = (page: string, rPr = ''): string[] => field(' PAGEREF _Toc100 \\h ', t(page, rPr))
const link = (anchor: string, ...runs: string[]): string =>
  `<w:hyperlink w:anchor="${anchor}" w:history="1">${runs.join('')}</w:hyperlink>`
/** A TOC entry of style `id`: hyperlink, title, tab, PAGEREF. */
const entry = (id: string, title: string, page = '3', more = ''): string =>
  styled(id, more, link('_Toc100', t(title), TAB, ...pageref(page)))
const TOC_FIELD = [fld('begin'), instr(' TOC \\o "1-3" \\h \\z \\u '), fld('separate')]

const ASTRAL7 = '\u{1D7D9}'.repeat(7)
const ASTRAL8 = '\u{1D7D9}'.repeat(8)
const ASTRAL10 = '\u{1D7D9}'.repeat(10)
const ASTRAL11 = '\u{1D7D9}'.repeat(11)

const PARAS: string[] = [
  // each TOC level, its right tab and leader from the style
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((level) =>
    entry(`TOC${level}`, `Title ${level}`, String(level)),
  ),
  entry('TOC 2', 'Pages style id'),
  entry('toc3', 'lower-case id'),
  entry('x12', 'opaque id named toc 3'),
  entry('TableofFigures', 'Figure 1'),
  entry('Figures', 'named table of figures'),
  entry('__proto__', 'proto style named toc 2'),
  entry('constructor', 'inherited name, no such style'),
  entry('toString', 'named TOC 5'),
  entry('Missing', 'style not in the map'),
  entry('MyToc', 'custom TOC style'),
  entry('MyTocChild', 'based on the custom one'),
  styled('TOC1', '', ...TOC_FIELD, link('_Toc1', t('Intro'), TAB, ...pageref('1'))),
  // right tab from direct tabs
  styled('TOC1', tabs(stop('right', '8000', 'hyphen')), t('Direct'), TAB, ...pageref('4')),
  styled('TOC1', tabs(stop('right', '8000')), t('Bare direct'), TAB, t('4')),
  styled('TOC2', tabs(stop('right', '7000', 'zigzag')), t('Unknown leader'), TAB, t('4')),
  styled('TOC2', tabs(stop('right', 'abc', 'dot')), t('NaN pos'), TAB, t('4')),
  styled('TOC2', tabs(stop('right', '-5', 'dot')), t('Negative pos'), TAB, t('4')),
  styled('TOC2', tabs(stop('right', '0x10', 'dot')), t('Hex pos'), TAB, t('4')),
  styled('TOC2', tabs(stop('right', '1e3', 'middleDot')), t('Exponent pos'), TAB, t('4')),
  styled('TOC2', tabs(stop('right', '', 'dot')), t('Empty pos'), TAB, t('4')),
  styled(
    'TOC2',
    "<w:tabs><w:tab w:val='right' w:leader='underscore' w:pos='7777'/></w:tabs>",
    t('Quoted'),
    TAB,
    t('4'),
  ),
  styled(
    'TOC1',
    tabs(stop('right', '5000', 'dot'), stop('left', '300'), stop('right', '9000', 'heavy')),
    t('Last right wins'),
    TAB,
    t('4'),
  ),
  // cleared stops
  styled('TOC1', tabs(stop('clear', '9350')), t('Cleared'), TAB, t('5')),
  styled(
    'TOC1',
    "<w:tabs><w:tab w:val='clear' w:pos='9350'/></w:tabs>",
    t('Cleared quoted'),
    TAB,
    t('5'),
  ),
  styled('TOC1', tabs(stop('clear', '1234')), t('Other cleared'), TAB, t('5')),
  styled('TOC2', tabs(stop('clear', '880')), t('1.1'), TAB, t('Left cleared'), TAB, t('5')),
  styled(
    'TOC2',
    tabs(stop('clear', '880'), stop('clear', '9350')),
    t('2.1'),
    TAB,
    t('All cleared'),
    TAB,
    t('5'),
  ),
  styled('TOC4', '', t('Default stops'), TAB, t('6')),
  // number tab: from the style, from direct tabs, none
  styled('TOC2', '', t('1.1.'), TAB, t('Intro'), TAB, ...pageref('7')),
  styled(
    'TOC2',
    '<w:ind w:left="440" w:hanging="440"/>',
    t('1.2.'),
    TAB,
    t('Hanging'),
    TAB,
    t('8'),
  ),
  styled(
    'TOC2',
    '<w:ind w:left="1000" w:firstLine="200"/>',
    t('1.3.'),
    TAB,
    t('Past the stop'),
    TAB,
    t('8'),
  ),
  styled(
    'TOC1',
    tabs(stop('left', '660'), stop('right', '9000', 'dot')),
    t('2.'),
    TAB,
    t('Direct left'),
    TAB,
    t('9'),
  ),
  styled(
    'TOC1',
    tabs(stop('left', '0'), stop('left', 'x'), stop('left', '500')),
    t('3.'),
    TAB,
    t('Skips 0'),
    TAB,
    t('9'),
  ),
  styled('TOC1', '', t('Chapter 1'), TAB, t('Spaced, no left stop'), TAB, t('9')),
  styled('TOC2', '', t('Chapter 1'), TAB, t('Spaced, left stop'), TAB, t('9')),
  styled('TOC2', '', t('Chapter\t1'), TAB, t('Tab inside'), TAB, t('9')),
  styled('TOC1', '', t('123456789012345'), TAB, t('15 units'), TAB, t('9')),
  styled('TOC1', '', t('1234567890123456'), TAB, t('16 units'), TAB, t('9')),
  styled('TOC2', '', t('a 34567890123456789x'), TAB, t('20 units'), TAB, t('9')),
  styled('TOC2', '', t('a 345678901234567890x'), TAB, t('21 units'), TAB, t('9')),
  styled('TOC1', '', t(ASTRAL7), TAB, t('7 astral'), TAB, t('9')),
  styled('TOC1', '', t(ASTRAL8), TAB, t('8 astral'), TAB, t('9')),
  styled('TOC2', '', t(ASTRAL10), TAB, t('10 astral'), TAB, t('9')),
  styled('TOC2', '', t(ASTRAL11), TAB, t('11 astral'), TAB, t('9')),
  styled('TOC1', '', t('  '), TAB, t('Blank first'), TAB, t('9')),
  styled('TOC1', '', t('A'), TAB, TAB, t('Empty middle'), TAB, t(' 10 ')),
  styled('TOC1', '', t('Only'), TAB),
  styled('TOC1', '', TAB, t('Leading tab'), TAB, t('3')),
  // run tabs spaced and paired, tab-stop definitions in w:tabs
  styled('TOC1', '', t('Spaced'), r('<w:tab />'), t('3')),
  styled('TOC1', '', t('Paired'), r('<w:tab></w:tab>'), t('3')),
  styled('TOC1', '', t('Paired spaced'), r('<w:tab> </w:tab>'), t('3')),
  // entities and astral text
  styled('TOC1', '', t('A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos;'), TAB, t('&#49;&#x32;')),
  styled('TOC1', '', t('Smile &#x1F600; \u{1F600}'), TAB, t('&#xD800;')),
  styled('TOC1', '', t('&amp;amp;'), TAB, t('&#65;'), TAB, t('3')),
  // hyperlink wrappers
  styled(
    'TOC1',
    '',
    `<w:hyperlink r:id="rId9" w:anchor="_Toc9">${t('Rel first')}${TAB}${t('2')}</w:hyperlink>`,
  ),
  styled(
    'TOC1',
    '',
    `<w:hyperlink w:anchor='_Toc9'>${t('Quoted anchor')}${TAB}${t('2')}</w:hyperlink>`,
  ),
  styled('TOC1', '', `<w:hyperlink w:anchor="">${t('Empty anchor')}${TAB}${t('2')}</w:hyperlink>`),
  styled('TOC1', '', `<w:hyperlink>${t('No anchor')}${TAB}${t('2')}</w:hyperlink>`),
  // tracked deletions
  styled(
    'TOC1',
    '',
    `<w:del w:id="1" w:author="a">${delText('Gone')}${TAB}${delText('4')}</w:del>`,
  ),
  styled(
    'TOC1',
    '<w:rPr><w:del w:id="2" w:author="a"/></w:rPr>',
    `<w:del w:id="1" w:author="a">${delText('Gone mark')}${TAB}${delText('4')}</w:del>`,
  ),
  styled('TOC1', '', `<w:del w:id="1">${delText('Old')}</w:del>`, t('New'), TAB, t('5')),
  styled('TOC1', '', `<w:del>${t('Live in del')}</w:del>`, TAB, t('5')),
  styled('TOC1', '', delText('Loose deleted'), TAB, delText('6')),
  // fonts of the result runs
  styled('TOC1', '', t('Times', '<w:rFonts w:ascii="Times New Roman"/>'), TAB, t('1')),
  styled('TOC1', '', t('\uBAA9\uCC28', '<w:rFonts w:eastAsia="Batang"/>'), TAB, t('1')),
  styled(
    'TOC1',
    '',
    t('\uBAA9\uCC28', '<w:rFonts w:ascii="Arial" w:eastAsia="Batang"/>'),
    TAB,
    t('1'),
  ),
  styled('TOC1', '', t('Latin', '<w:rFonts w:eastAsia="Batang"/>'), TAB, t('1')),
  styled(
    'TOC1',
    '',
    t('Intro ', '<w:rFonts w:ascii="Arial"/>'),
    t('\uC18C\uAC1C', '<w:rFonts w:eastAsia="Malgun Gothic"/>'),
    TAB,
    t('1'),
  ),
  styled(
    'TOC1',
    '',
    t('Same ', '<w:rFonts w:ascii="Gulim"/>'),
    t('\uC18C\uAC1C', '<w:rFonts w:eastAsia="Gulim"/>'),
    TAB,
    t('1'),
  ),
  styled('TOC1', '', t('\u6F22\u5B57', '<w:rFonts w:hint="eastAsia"/>'), TAB, t('1')),
  styled('TOC1', '', t('Theme', '<w:rFonts w:asciiTheme="minorHAnsi"/>'), TAB, t('1')),
  styled('TOC1', '', t('Empty face', '<w:rFonts w:ascii=""/>'), TAB, t('1')),
  styled('TOC1', '', t('\uFF21\uFF22', '<w:rFonts w:eastAsia="MS Mincho"/>'), TAB, t('1')),
  // sizes, weight, character style
  styled('TOC1', '', t('Sized', '<w:sz w:val="24"/>'), TAB, ...pageref('2', '<w:sz w:val="28"/>')),
  styled(
    'TOC1',
    '',
    t('Instr sized'),
    TAB,
    fld('begin', '<w:sz w:val="40"/>'),
    instr(' PAGEREF _Toc1 ', '<w:sz w:val="40"/>'),
    fld('separate'),
    t('2'),
    fld('end'),
  ),
  styled('TOC1', '', t('Bad size', '<w:sz w:val="big"/>'), TAB, t('2')),
  styled('TOC1', '', t('Zero size', '<w:sz w:val="0"/>'), TAB, t('2')),
  styled('TOC1', '', t('Bold', '<w:b/>'), TAB, t('2')),
  styled('TOC1', '', t('Not bold', '<w:b w:val="0"/>'), TAB, t('2')),
  styled(
    'TOC1',
    '',
    t('Styled run', '<w:rStyle w:val="TocLink"/><w:i/><w:color w:val="FF0000"/>'),
    TAB,
    t('2'),
  ),
  styled('TOC1', '', t('Strong', '<w:rStyle w:val="Strong"/>'), TAB, t('2')),
  styled('TOC1', '', t('Missing run style', '<w:rStyle w:val="Nope"/>'), TAB, t('2')),
  // line and paragraph geometry
  styled(
    'TOC1',
    '<w:spacing w:before="120" w:after="0" w:line="360" w:lineRule="auto"/>',
    t('Line'),
    TAB,
    t('3'),
  ),
  styled(
    'TOC1',
    '<w:spacing w:line="240" w:lineRule="exact" w:beforeAutospacing="1"/>',
    t('Exact'),
    TAB,
    t('3'),
  ),
  styled('TOC6', '', t('Style exact'), TAB, t('3')),
  styled('TOC7', '', t('Style auto'), TAB, t('3')),
  styled('TOC9', '', t('Style at least'), TAB, t('3')),
  styled(
    'TOC1',
    '<w:ind w:left="300" w:right="200" w:firstLine="100"/>',
    t('Styled indent'),
    TAB,
    t('3'),
  ),
  // RTL
  styled('TOC1', '<w:bidi/>', t('\u05E9\u05DC\u05D5\u05DD', '<w:rtl/>'), TAB, t('3')),
  styled(
    'TOC9',
    '',
    t('1.'),
    TAB,
    t('\u0645\u0631\u062D\u0628\u0627', '<w:rtl/><w:sz w:val="26"/>'),
    TAB,
    t('3'),
  ),
  // unstyled TOC entries: PAGEREF behind a right tab
  pWith(tabs(stop('right', '9350', 'dot')), t('Unstyled'), TAB, ...pageref('11')),
  pWith(
    `${tabs(stop('right', '9350', 'dot'))}<w:ind w:left="400" w:hanging="200"/>`,
    t('Unstyled indent'),
    TAB,
    ...pageref('11'),
  ),
  pWith(
    "<w:tabs><w:tab w:val='right' w:pos='9000'/></w:tabs>",
    t('Unstyled quoted'),
    TAB,
    ...pageref('11'),
  ),
  pWith(tabs(stop('right', '9350', 'dot')), t('No tab run'), ...pageref('11')),
  pWith(tabs(stop('left', '9350', 'dot')), t('Left only'), TAB, ...pageref('11')),
  pWith('<w:pStyle w:val="MyToc"/>', t('Custom style stop'), TAB, ...pageref('12')),
  pWith('<w:pStyle w:val="MyToc"/>', t('Custom no run tab'), ...pageref('12')),
  pWith('<w:pStyle w:val="MyTocChild"/>', t('Custom child'), TAB, ...pageref('12')),
  p(t('No stop'), TAB, ...pageref('12')),
  pWith(tabs(stop('right', '9350')), t('Not PAGEREF'), TAB, ...field(' REF _Ref1 ', t('3'))),
  pWith(
    tabs(stop('right', '9350')),
    t('PAGEREF last'),
    TAB,
    fld('begin'),
    instr('PAGEREF'),
    fld('end'),
  ),
  pWith(tabs(stop('right', '9350')), t('pageref lower'), TAB, ...field(' pageref _Toc1 ', t('3'))),
  pWith(
    `<w:pStyle w:val="TOC3"/>${tabs(stop('right', '9350', 'dot'))}`,
    t('Styled, no tab run'),
    ...pageref('5'),
  ),
  // TOC-styled paragraphs without a tab run
  styled('TOC1', '', ...TOC_FIELD),
  styled('TOC1', '<w:rPr><w:sz w:val="40"/></w:rPr>'),
  styled('TOC1', '', t('Contents')),
  styled('TOC2', '<w:ind w:left="500"/><w:jc w:val="center"/>', t('Title only')),
  styled('TOC1', '', fld('end')),
  // text fields
  p(...field(' PAGE ', t('3'))),
  p(...field(' DATE ', t('2024-01-01', '<w:rFonts w:ascii="Courier"/><w:sz w:val="18"/>'))),
  p(
    ...field(
      ' REF _Ref1 ',
      t('L', '<w:sz w:val="96"/>'),
      t('orem ipsum dolor sit amet', '<w:sz w:val="20"/>'),
    ),
  ),
  p(...field(' REF x ', t('ab', '<w:sz w:val="30"/>'), t('cd', '<w:sz w:val="20"/>'))),
  p(...field(' REF x ', t('ab', '<w:sz w:val="20"/>'), t('cd', '<w:sz w:val="30"/>'))),
  p(...field(' REF x ', t('ab'), t('cd', '<w:sz w:val="30"/>'))),
  p(...field(' REF x ', t('\u{1F600}', '<w:sz w:val="40"/>'), t('abc', '<w:sz w:val="20"/>'))),
  p(...field(' REF x ', t('', '<w:sz w:val="40"/>'), t('a', '<w:sz w:val="20"/>'))),
  p(...field(' REF x ', t('a', '<w:sz w:val="x"/>'), t('b', '<w:sz w:val="20"/>'))),
  p(...field(' REF x ', t('\uD55C\uAE00', '<w:rFonts w:ascii="Arial" w:eastAsia="Batang"/>'))),
  p(
    ...field(' REF x ', t('a', '<w:rFonts w:eastAsia=""/>'), t('b', '<w:rFonts w:ascii="Arial"/>')),
  ),
  p(...field(' REF x ', t('a'), t('b', '<w:rFonts w:ascii="Georgia"/>'))),
  pWith('<w:jc w:val="center"/>', ...field(' PAGE ', t('1'))),
  pWith('<w:jc w:val="distribute"/>', ...field(' PAGE ', t('1'))),
  pWith('<w:jc w:val="both"/>', ...field(' PAGE ', t('1'))),
  pWith('<w:jc w:val="end"/><w:bidi/>', ...field(' PAGE ', t('1'))),
  pWith(
    '<w:spacing w:before="0" w:after="0" w:line="480" w:lineRule="auto"/><w:ind w:left="720"/>',
    ...field(' PAGE ', t('1')),
  ),
  pWith('<w:spacing w:line="-240"/>', ...field(' PAGE ', t('1'))),
  pWith('<w:pStyle w:val="Heading1"/>', ...field(' REF _Ref2 \\r ', t('1.'))),
  pWith(
    '<w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>',
    t('Heading '),
    ...field(' SEQ x ', t('2')),
  ),
  p(fld('begin'), instr(' PA'), instr('GE '), fld('separate'), t('1'), t('2'), fld('end')),
  p(
    fld('begin'),
    instr(' IF '),
    fld('begin'),
    instr(' PAGE '),
    fld('separate'),
    t('2'),
    fld('end'),
    instr(' = 2 "yes" "no" '),
    fld('separate'),
    t('yes'),
    fld('end'),
  ),
  p(...field('EQ \\f(1,2)')),
  p(t('x = '), ...field('EQ \\r(3,x)', t('old'))),
  pWith('<w:pStyle w:val="TOC1"/>', ...field('EQ \\o(a,b)')),
  p('<w:fldSimple w:instr=" PAGE "><w:r><w:t>4</w:t></w:r></w:fldSimple>'),
  p(...field(' MERGEFIELD Name ', t('&lt;Name&gt; &#x1F600;'))),
  p(t('  '), fld('end')),
  // empty lines, page breaks, nothing
  p(fld('end')),
  pWith('<w:rPr><w:sz w:val="40"/></w:rPr><w:spacing w:after="0"/>', fld('end')),
  pWith('<w:rPr><w:sz w:val="40"/></w:rPr>', fld('end'), fld('end')),
  p(fld('end'), r('<w:br w:type="page"/>')),
  p(fld('end'), r("<w:br w:type='page'/>")),
  p(fld('begin'), r('<w:br w:type="page"/>')),
  p(fld('begin')),
  p(fld('separate')),
  p(fld('end'), TAB),
  p(r('<w:drawing/>')),
  '<w:p/>',
  p(),
  // malformed XML
  styled('TOC1', '', t('Bad rPr', '<w:b>'), TAB, t('5', '<w:sz w:val="30">')),
  '<w:p><w:pPr><w:pStyle w:val="TOC1"/><w:jc w:val="center"></w:pPr>' +
    t('Bad pPr') +
    TAB +
    t('5') +
    '</w:p>',
  '<w:p><w:pPr><w:jc w:val="center"></w:pPr>' +
    fld('begin') +
    instr(' PAGE ') +
    fld('separate') +
    t('7') +
    fld('end') +
    '</w:p>',
  '<w:p><w:r><w:t>unclosed' + TAB,
  '<w:p><w:pPr><w:pStyle w:val="TOC1"/>' + t('no pPr end') + TAB + t('5'),
]

/** The style's only right stop at a negative position (TOC8's at 0 drops later anyway); rich package only. */
const NEGATIVE_STOP = entry('TocNegative', 'Negative style stop')

const COMPAT_ADDITIVE = { doNotUseHTMLParagraphAutoSpacing: true }

/** Every paragraph over the rich package; then without a resolver, without styles, both, and over the other packages. */
function built(): Input[] {
  const inputs: Input[] = []
  PARAS.forEach((text, index) => {
    inputs.push({ text, args: { parts: RICH } })
    inputs.push({ text, args: { parts: RICH, resolver: false } })
    inputs.push({ text, args: { parts: RICH, styles: false } })
    if (index % 3 === 0) {
      inputs.push({ text, args: { parts: RICH, resolver: false, styles: false } })
      inputs.push({ text, args: { parts: BARE } })
    }
    if (index % 4 === 0) inputs.push({ text, args: { parts: RICH, compat: COMPAT_ADDITIVE } })
  })
  inputs.push({ text: PARAS[0]!, args: { parts: THROWS } })
  inputs.push({ text: PARAS[0]!, args: { parts: THROWS, resolver: false } })
  for (const args of [{}, { resolver: false }, { styles: false }])
    inputs.push({ text: NEGATIVE_STOP, args: { parts: RICH, ...args } })
  return inputs
}

// ---------------------------------------------------------------- the specs

export const FIELDDISPLAY: CallSpec[] = [
  {
    fn: 'fielddisplay.fieldDisplayOf',
    call: displayOf,
    fromDocument: documentInputs,
    built: built(),
  },
]
