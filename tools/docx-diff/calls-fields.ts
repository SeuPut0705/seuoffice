// Group `fields`: parse-fields.ts (the readers that need no resolved property
// chain), eq-field.ts, parse-sdt.ts and field-balance.ts.
import { eqFieldToOmml, inlineEqFieldResults } from './reference/eq-field'
import { balanceFieldChars } from './reference/field-balance'
import {
  additiveSpacingOf,
  directLineOf,
  directParaGeometry,
  fieldLabel,
  fieldStackAfter,
  loneFieldEnd,
  markInsideFieldCode,
  rPrNodeOf,
  tagAttr,
  tocLevelOf,
} from './reference/parse-fields'
import {
  parseSdtBlock,
  sdtMeta,
  sdtRanges,
  sdtTableXml,
  splitSdtParts,
} from './reference/parse-sdt'
import { decodeEntities } from './reference/parse-xml-text'
import {
  resolveCtxOf,
  resolveParagraphPropsXml,
  type EffectivePPr,
  type ResolveCtx,
} from './reference/resolve-props'
import type { StyleInfo } from './reference/types'
import type { XNode } from './reference/xml-utils'
import type { CallSpec, Input } from './calls-spec'
import { elementFragments } from './fragments'

// ---------------------------------------------------------------- the corpus

interface Collected {
  /** document, headers, footers and notes, whole */
  bodies: string[]
  /** every w:p of those holding field machinery, in document order */
  fieldParas: string[]
  sdts: string[]
  /** the instruction of every field: complex (instrText joined per paragraph) and simple */
  instrs: string[]
  /** styleId to name, from word/styles.xml */
  styles: Array<[string, { styleId: string; name: string }]>
  /** the w:pStyle values of the body */
  styleIds: string[]
  additive: boolean
}

const collected = new WeakMap<ReadonlyMap<string, string>, Collected>()

const BODY_PART = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/

function collect(parts: ReadonlyMap<string, string>): Collected {
  const known = collected.get(parts)
  if (known) return known
  const bodies = [...parts].filter(([name]) => BODY_PART.test(name)).map(([, text]) => text)
  const fieldParas = bodies.flatMap((body) =>
    elementFragments(body, 'w:p').filter((p) => /<w:(?:fldChar|instrText|fldSimple)\b/.test(p)),
  )
  const instrs = new Set<string>()
  for (const p of fieldParas) {
    const joined = Array.from(
      p.matchAll(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/g),
      (m) => m[1]!,
    ).join('')
    if (joined !== '') instrs.add(decodeEntities(joined))
    for (const m of p.matchAll(/<w:fldSimple\b[^>]*\bw:instr="([^"]*)"/g)) {
      instrs.add(decodeEntities(m[1]!))
    }
  }
  const styles: Collected['styles'] = []
  for (const style of elementFragments(parts.get('word/styles.xml') ?? '', 'w:style')) {
    const styleId = /\bw:styleId="([^"]*)"/.exec(style)?.[1]
    const name = /<w:name\b[^>]*\bw:val="([^"]*)"/.exec(style)?.[1]
    if (styleId !== undefined && name !== undefined) styles.push([styleId, { styleId, name }])
  }
  const body = parts.get('word/document.xml') ?? ''
  const styleIds = [
    ...new Set(Array.from(body.matchAll(/<w:pStyle\b[^>]*\bw:val="([^"]*)"/g), (m) => m[1]!)),
  ]
  const result: Collected = {
    bodies,
    fieldParas,
    sdts: bodies.flatMap((text) => elementFragments(text, 'w:sdt')),
    instrs: [...instrs],
    styles,
    styleIds,
    additive: /<w:doNotUseHTMLParagraphAutoSpacing\b/.test(parts.get('word/settings.xml') ?? ''),
  }
  collected.set(parts, result)
  return result
}

const texts = (list: string[]): Input[] => list.map((text) => ({ text }))

/** The paragraphs of a document with the field stack each one starts under. */
function stacksOf(fieldParas: string[]): Array<{ text: string; stack: boolean[] }> {
  let stack: boolean[] = []
  return fieldParas.map((text) => {
    const before = stack
    stack = fieldStackAfter(text, stack)
    return { text, stack: before }
  })
}

/** What the resolver gives a paragraph over a document with no styles. */
function effsOf(fieldParas: string[], additive: boolean): Input[] {
  const ctx = resolveCtxOf({
    styles: new Map(),
    numbering: new Map(),
    doNotUseHTMLParagraphAutoSpacing: additive,
  })
  return fieldParas.map((p) => ({ args: { eff: resolveParagraphPropsXml(p, ctx) } }))
}

// ---------------------------------------------------------------- built inputs

const r = (inner: string, attrs = ''): string => `<w:r${attrs}>${inner}</w:r>`
const fld = (type: string, quote = '"'): string =>
  r(`<w:fldChar w:fldCharType=${quote}${type}${quote}/>`)
const instr = (code: string): string => r(`<w:instrText xml:space="preserve">${code}</w:instrText>`)
const t = (text: string): string => r(`<w:t xml:space="preserve">${text}</w:t>`)
const p = (...runs: string[]): string => `<w:p>${runs.join('')}</w:p>`
const pWith = (pPr: string, ...runs: string[]): string =>
  `<w:p><w:pPr>${pPr}</w:pPr>${runs.join('')}</w:p>`
const field = (code: string, ...result: string[]): string[] => [
  fld('begin'),
  instr(code),
  fld('separate'),
  ...result,
  fld('end'),
]

const FIELD_PARAS: string[] = [
  p(...field(' PAGE ', t('3'))),
  p(fld('begin'), instr(' TOC \\o "1-3" \\h \\z \\u '), fld('separate')),
  p(fld('begin'), instr(' TOC \\o "1-3" ')),
  p(fld('end'), r('<w:br w:type="page"/>')),
  p(fld('end')),
  p(fld('end', "'")),
  p(fld('end', "'"), r("<w:br w:type='page'/>")),
  p(fld('separate'), t('result'), fld('end')),
  p(fld('separate')),
  p(fld('end'), ...field('REF _Ref123 \\h', t('1.2'))),
  p(fld('end'), fld('begin'), instr('PAGEREF _Toc1 \\h')),
  p(
    fld('begin'),
    instr(' IF '),
    fld('begin'),
    instr(' PAGE '),
    fld('begin'),
    instr(' NUMPAGES '),
    fld('separate'),
    t('9'),
    fld('end'),
    fld('separate'),
    t('2'),
    fld('end'),
    instr(' = 1 "a" "b" '),
    fld('separate'),
    t('a'),
    fld('end'),
  ),
  p(fld('begin'), fld('begin'), fld('begin'), instr('SEQ x')),
  p(
    fld('begin'),
    instr('HYPERLINK "http://example.com"'),
    fld('separate'),
    '<w:fldSimple w:instr=" PAGE "><w:r><w:t>4</w:t></w:r></w:fldSimple>',
    fld('end'),
  ),
  p('<w:fldSimple w:instr="SEQ Figure \\* ARABIC"><w:r><w:t>1</w:t></w:r></w:fldSimple>'),
  p("<w:fldSimple w:instr='DATE'><w:r><w:t>today</w:t></w:r></w:fldSimple>"),
  p('<w:fldSimple w:instr="   "/>'),
  p(fld('end'), r('<w:tab/>')),
  p(fld('end'), r('<w:cr/>')),
  p(fld('end'), r('<w:br/>')),
  pWith('<w:tabs><w:tab w:val="right" w:pos="9000"/></w:tabs>', fld('end')),
  pWith('<w:tabs><w:tab w:val="right" w:pos="9000"/></w:tabs>', fld('end'), r('<w:tab/>')),
  p(fld('end'), r('<w:drawing><wp:inline/></w:drawing>')),
  p(fld('end'), r('<w:pict/>')),
  p(fld('end'), r('<w:object/>')),
  p(fld('end'), fld('end')),
  p(fld('begin'), r('<w:instrText></w:instrText>'), fld('end')),
  p(fld('begin'), r('<w:instrText>   </w:instrText>'), fld('end')),
  p(...field(' DATE \\@ "yyyy-MM-dd" ', t('2024-01-01'))),
  p(...field('TIME', t('12:00'))),
  p(...field('INCLUDEPICTURE "a.png" \\* MERGEFORMATINET')),
  p(...field('STYLEREF "Heading 1"', t('Intro'))),
  p(...field('NUMPAGES', t('12'))),
  p(...field('MERGEFIELD Name', t('&lt;Name&gt;'))),
  p(...field('page', t('7'))),
  p(...field('stra\u00DFe x')),
  p(...field('\u00A0TOC\u3000\\o')),
  p(r('<w:fldChar w:dirty="true" w:fldCharType="begin"/>'), instr('PAGE'), fld('end')),
  p(r('<w:fldChar w:fldCharType="begin" w:fldLock="1"/>'), instr('PAGE'), fld('end')),
  p(r('<w:fldChar fldCharType="end"/>')),
  p(r('<w:fldChar w:fldCharType="End"/>')),
  p(r('<w:fldCharX w:fldCharType="begin"/>'), fld('end')),
  p(t('plain text')),
  p(t('a'), fld('end'), fld('begin')),
  p(fld('end'), fld('begin', "'")),
  p(fld('end'), '<w:fldSimple w:instr="PAGE"/>'),
  p(fld('end'), r('<w:instrText>x</w:instrText>')),
  pWith(
    '<w:pStyle w:val="TOC1"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs>',
    r('<w:hyperlink w:anchor="_Toc1"/>'),
    t('1.'),
    r('<w:tab/>'),
    t('Intro'),
    r('<w:tab/>'),
    ...field(' PAGEREF _Toc1 \\h ', t('3')),
  ),
  p(
    r(
      '<w:rPr><w:b/><w:sz w:val="24"/><w:rFonts w:ascii="Times" w:eastAsia="Batang"/></w:rPr><w:instrText>PAGE</w:instrText>',
    ),
  ),
  pWith("<w:pStyle w:val='TOC2'/>", ...field('PAGE', t('1'))),
  pWith('<w:pStyle  w:val="Heading1" w:other="x"/>', ...field('REF x', t('a'))),
  `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK \\l "_Toc1" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:hyperlink w:anchor="_Toc1"><w:r><w:t>Intro</w:t></w:r></w:hyperlink></w:p>`,
  `<w:p><w:r><w:t>Next</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
]

/** EQ instructions: every switch with its options, nested, escaped, malformed. */
const EQ_INSTRS: string[] = [
  'EQ \\f(1,2)',
  ' eq \\F(a,b) ',
  'EQ \\f(1)',
  'EQ \\f()',
  'EQ \\f(,)',
  'EQ \\r(3,x)',
  'EQ \\r(x)',
  'EQ \\r()',
  'EQ \\r(a,b,c)',
  'EQ \\s\\up8(2)',
  'EQ \\s\\do4(i)',
  'EQ \\s\\up(a,b)',
  'EQ \\s(a,b,c)',
  'EQ \\s\\ai4\\di2(x,y)',
  'EQ \\s\\do\\up(x)',
  'EQ \\o(=,/)',
  'EQ \\o\\al(a,b)',
  'EQ \\o\\ac\\ar(a)',
  'EQ \\x(boxed)',
  'EQ \\x\\to\\bo(a)',
  'EQ \\x\\le\\ri(a,b)',
  'EQ \\x\\to(a)',
  'EQ \\x\\to\\bo\\le\\ri(a)',
  'EQ \\b(x)',
  'EQ \\b\\bc\\[(x,y)',
  'EQ \\b\\bc\\{(z)',
  'EQ \\b\\bc\\<(z)',
  'EQ \\b\\bc\\|(z)',
  'EQ \\b\\bc\\\u27E8(z)',
  'EQ \\b\\bc\\"(x)',
  'EQ \\b\\lc\\[\\rc\\)(a)',
  'EQ \\b\\lc\\[(a)',
  'EQ \\b\\rc\\>(a)',
  'EQ \\b\\bc(x)',
  'EQ \\b\\bc\\',
  'EQ \\b \\bc\\( (x)',
  'EQ \\d\\fo10()',
  'EQ \\d\\ba(x)',
  'EQ \\i(0,1,x)',
  'EQ \\i\\su(i=1,n,i)',
  'EQ \\i\\pr(,,x)',
  'EQ \\i\\in(a,b,c)',
  'EQ \\i\\su\\in(,,x)',
  'EQ \\i\\fc\\\u222E(a,b,c)',
  'EQ \\i\\vc\\\u2211\\in(,n,x)',
  'EQ \\i\\fc\\a(1,2,3)',
  'EQ \\i()',
  'EQ \\l(a,b,c)',
  'EQ \\l(a;b)',
  'EQ \\a(1,2,3,4)',
  'EQ \\a\\al\\co2(1,2,3)',
  'EQ \\a\\ar\\co3\\vs3\\hs3(1,2)',
  'EQ \\a\\co0(1,2)',
  'EQ \\a\\co99(1)',
  'EQ \\a\\co(1,2)',
  'EQ \\a\\co-2(1,2)',
  'EQ \\a\\co-(1,2,3)',
  'EQ \\a\\CO2\\AL(a,b,c,d)',
  'EQ \\f(\\r(2),\\s\\up5(3))',
  'EQ \\b(\\f(1,2)+\\r(3,x))',
  'EQ \\a\\co2(\\f(a,b),\\r(c),\\x(d),\\i(,,e))',
  'EQ \\f(a\\,b,c\\)d)',
  'EQ \\l(\\(,\\))',
  'EQ \\f(a\\\\b,c)',
  'EQ \\f((a,b),c)',
  'EQ \\f(1,2) \\* MERGEFORMAT',
  'EQ \\* MERGEFORMAT',
  'EQ \\* Upper \\f(x,y)',
  'EQ \\f(1,2',
  'EQ \\f 1,2)',
  'EQ \\f  (1,2)',
  'EQ \\z(1)',
  'EQ',
  'EQ ',
  'EQ plain text',
  'EQ a\\',
  'EQ (unbalanced',
  'EQ \\f(1,2))',
  'EQ \\f(1,2)tail',
  'EQX \\f(1,2)',
  'PAGE',
  '',
  'EQ \\f(a<b,c&d)',
  'EQ \\f(a\u0001b,c)',
  'EQ \\f(\u{1F600},\\\u{1F600})',
  'EQ \\b\\bc\\\u{1F600}(x)',
  'EQ\t\\f(1,2)',
  '\u00A0EQ \\f(1,2)\u00A0',
  '\uFEFFEQ \\f(1,2)',
  `EQ ${'\\r('.repeat(64)}x${')'.repeat(64)}`,
  `EQ ${'\\r('.repeat(65)}x${')'.repeat(65)}`,
]

/** Paragraphs holding EQ fields, for the inlining. */
const EQ_PARAS: string[] = [
  p(...field('EQ \\f(1,2)')),
  p(
    r('<w:rPr><w:sz w:val="28"/></w:rPr><w:fldChar w:fldCharType="begin"/>'),
    r('<w:rPr><w:i/></w:rPr><w:instrText>EQ \\r(3,x)</w:instrText>'),
    fld('end'),
  ),
  p(fld('begin'), instr('EQ \\f(1,'), instr('2)'), fld('separate'), fld('end')),
  // the E and the Q in two elements, so no element opens the instruction; beside
  // it an element that is w:instrText only under Unicode case folding
  p(
    fld('begin'),
    instr('E'),
    instr('Q \\f(1,2)'),
    fld('separate'),
    fld('end'),
    r('<w:\u0131nstrText>EQ</w:\u0131nstrText>'),
  ),
  p(
    r('<w:in\u017ftrText>EQ</w:in\u017ftrText>'),
    fld('begin'),
    instr('E'),
    instr('Q \\r(3,x)'),
    fld('end'),
  ),
  p(fld('begin'), instr('E'), instr('Q \\f(1,2)'), fld('separate'), fld('end')),
  p(...field('EQ \\f(a&amp;b,c&lt;d)')),
  p(...field('EQ \\z(1)', t('kept'))),
  p(
    fld('begin'),
    instr('EQ \\f('),
    ...field('PAGE', t('3')),
    instr(',2)'),
    fld('separate'),
    fld('end'),
  ),
  p(
    r('<w:fldChar w:fldCharType="begin"/>', ' w:rsidR="00AB"'),
    r('<w:instrText>EQ \\s\\up8(2)</w:instrText>', ' w:rsidR="00AB"'),
    r('<w:fldChar w:fldCharType="end"/>', ' w:rsidR="00AB"'),
  ),
  `<w:p><w:r><w:instrText>EQ \\f(1,2)</w:instrText><w:fldChar w:fldCharType="begin"/><w:fldChar w:fldCharType="end"/>`,
  `<w:p><w:fldChar w:fldCharType="begin"/><w:instrText>EQ \\f(1,2)</w:instrText><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
  p(t('a'), ...field('EQ \\f(1,2)'), t('b'), ...field('EQ \\r(2)'), t('c')),
  p(
    r('<w:fldChar w:fldCharType="begin"/><w:instrText>EQ \\f(1,2)</w:instrText>'),
    r('<w:fldChar w:fldCharType="end"/><w:fldChar w:fldCharType="begin"/>'),
    r('<w:instrText>EQ \\r(9)</w:instrText><w:fldChar w:fldCharType="end"/>'),
  ),
  p(fld('begin'), r('<w:instrText> eq \\r(2)</w:instrText>'), fld('end', "'")),
  p(fld('begin'), r('<W:INSTRTEXT>EQ \\f(1,2)</W:INSTRTEXT>'), fld('end')),
  p(...field('PAGE', t('1'))),
  p(fld('begin'), instr('EQ \\f(1,2)'), fld('end'), fld('end'), fld('end')),
  p(fld('begin'), instr('EQ \\f(1,2)'), fld('separate')),
  p(fld('begin'), instr('EQ \\f(\u{1F600},\uD55C)'), fld('end'), t('\uD55C\uAE00')),
  p(...field('EQ \\f(a,b)'), r('<w:instrText>EQ \\f(c,d)</w:instrText>')),
]

const sdtOf = (pr: string | null, content: string, contentTag = 'w:sdtContent'): string =>
  `<w:sdt>${pr === null ? '' : `<w:sdtPr>${pr}</w:sdtPr>`}<${contentTag}>${content}</w:sdtContent></w:sdt>`
const tbl = (inner = '<w:tr><w:tc><w:p/></w:tc></w:tr>'): string => `<w:tbl>${inner}</w:tbl>`

const SDT_PRS: Array<string | null> = [
  '<w:alias w:val="Title"/><w:tag w:val="t1"/><w:id w:val="123"/><w:lock w:val="sdtLocked"/>',
  "<w:alias w:val='Single'/><w:tag w:val='q'/><w:lock w:val='contentLocked'/><w:text/>",
  '<w:id w:val="-5"/><w:text w:multiLine="1"/><w:showingPlcHdr/>',
  '<w:richText/>',
  '<w14:checkbox><w14:checked w14:val="1"/></w14:checkbox>',
  '<w:checkbox w:checked="1"/>',
  '<w:checkbox/>',
  '<w:checkbox><w:checked w:val="0"/></w:checkbox>',
  '<w:dropDownList><w:listItem w:displayText="A" w:value="a"/></w:dropDownList>',
  '<w:comboBox/>',
  '<w:date w:fullDate="2024-01-01T00:00:00Z"><w:dateFormat w:val="yyyy-MM-dd"/></w:date>',
  '<w:date/><w:comboBox/>',
  '<w:picture/>',
  '<w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj>',
  '<w15:repeatingSection/>',
  '<w15:repeatingSectionItem/>',
  '<w:dataBinding w:xpath="/root/a" w:storeItemID="{X}"/><w:text/>',
  '<w:placeholder><w:docPart w:val="DefaultPlaceholder"/></w:placeholder><w:showingPlcHdr/>',
  '<w:rPr><w:b/></w:rPr><w:aliasX w:val="x"/><w:tagged w:val="y"/><w:id/><w:lock/>',
  '',
  null,
]

const SDT_CONTENTS: string[] = [
  p(t('one')),
  p(t('one')) + p(t('two')),
  p(t('one')) + tbl(),
  tbl(),
  tbl(`<w:tr><w:tc>${tbl()}</w:tc></w:tr>`) + p(t('after')),
  tbl() + tbl(),
  '',
  '<w:p/>',
  '<w:p/><w:p/>',
  p(t('\uD55C\uAE00\u{1F600}')) + p(t('x')),
  '<w:p w:x="a>b"><w:r><w:t>q</w:t></w:r></w:p >',
  '<w:p><w:r><w:t>nb</w:t></w:r></w:p\u00A0>',
  tbl('<w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl\u00A0>'),
  '<!-- <w:p>no</w:p> -->' + p(t('c')),
  '<w:r><w:t>run only</w:t></w:r>',
  '<w:tr><w:tc><w:p/></w:tc></w:tr>',
  '<w:tc><w:p/></w:tc><w:tc><w:p/></w:tc>',
  '</w:p><w:p>stray</w:p>',
  '<w:customXml><w:p/></w:customXml><w:p/>',
  '<w:p><w:p>inner</w:p></w:p>',
  '<w:p>open',
  '<w:tbl/>' + tbl(),
  '<w:tbl><w:tr>',
]

const SDTS: string[] = [
  ...SDT_PRS.map((pr) => sdtOf(pr, p(t('x')))),
  ...SDT_CONTENTS.map((content) => sdtOf(SDT_PRS[0]!, content)),
  sdtOf(SDT_PRS[0]!, '', 'w:sdtContent w:x="1"'),
  '<w:sdt><w:sdtPr><w:tag w:val="e"/></w:sdtPr><w:sdtContent/></w:sdt>',
  '<w:sdt><w:sdtPr><w:tag w:val="none"/></w:sdtPr></w:sdt>',
  '<w:sdt/>',
  '<w:sdt><w:sdtContent><w:p/>',
  '<w:sdt><w:sdtContent></w:sdt>',
  '<w:sdtContent><w:p/></w:sdtContent>',
  '</w:sdtContent><w:sdt><w:sdtContent><w:p/>',
  '</w:sdt><w:sdt><w:sdtContent/></w:sdt>',
  '<w:sdt><w:sdtContent><w:p/></w:sdtContent>',
  '<w:sdt><w:sdtContent><w:p>open</w:sdtContent></w:sdt>',
  sdtOf('<w:tag w:val="outer"/>', sdtOf('<w:tag w:val="inner"/><w:checkbox/>', p(t('x')))),
  sdtOf(
    '<w:tag w:val="outer"/>',
    sdtOf('<w:tag w:val="inner"/>', p(t('a')) + p(t('b'))) + p(t('c')),
  ),
  sdtOf(
    '<w:tag w:val="o"/>',
    sdtOf('<w:tag w:val="m"/>', sdtOf('<w:alias w:val="deep"/>', tbl() + p(t('d')))),
  ),
  sdtOf('<w:tag w:val="cover"/>', p(sdtOf('<w:tag w:val="run"/>', t('inline'))) + p(t('z'))),
  sdtOf(
    '<w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj>',
    p(...field('TOC \\o "1-3"', t('Contents'))) +
      pWith('<w:pStyle w:val="TOC1"/>', t('Intro'), r('<w:tab/>'), t('1')) +
      p(fld('end')),
  ),
  `<w:tbl><w:tr>${sdtOf('<w:tag w:val="cell"/>', '<w:tc><w:p/></w:tc>')}</w:tr></w:tbl>`,
  `<w:tbl>${sdtOf('<w:tag w:val="row"/><w15:repeatingSection/>', '<w:tr><w:tc><w:p/></w:tc></w:tr>')}</w:tbl>`,
  `<w:p>${sdtOf('<w:alias w:val="run"/><w:text/>', t('inline'))}</w:p>`,
  sdtOf("<w:tag w:val='a\"b'/>", "<w:p w:a='x>y'/>" + p(t('k'))),
  sdtOf('<w:tag w:val="x"/>', p(t('a'))) + sdtOf('<w:tag w:val="y"/>', p(t('b')) + p(t('c'))),
]

const SHORT_EFF = {
  indent: { left: 0, right: 0, firstLine: 0 },
  spacing: { before: 0, after: 0, beforeAuto: false, afterAuto: false },
  source: {},
}
const effOf = (
  source: Record<string, string>,
  spacing: Record<string, unknown> = {},
  indent: Record<string, unknown> = {},
): Input => ({
  args: {
    eff: {
      indent: { ...SHORT_EFF.indent, ...indent },
      spacing: { ...SHORT_EFF.spacing, ...spacing },
      source,
    },
  },
})
const ALL_DIRECT = Object.fromEntries(
  [
    'spaceBefore',
    'spaceAfter',
    'spaceBeforeAuto',
    'spaceAfterAuto',
    'indentLeft',
    'indentRight',
    'indentFirstLine',
    'line',
  ].map((key) => [key, 'direct']),
)

const EFFS: Input[] = [
  effOf(
    ALL_DIRECT,
    {
      before: 120,
      after: 240,
      beforeAuto: true,
      afterAuto: true,
      line: { rule: 'auto', raw: 360 },
    },
    { left: 720, right: 360, firstLine: -360 },
  ),
  effOf(
    {},
    { before: 120, after: 240, beforeAuto: true, line: { rule: 'exact', raw: 280 } },
    { left: 5 },
  ),
  effOf({ spaceBefore: 'direct', spaceBeforeAuto: 'direct', line: 'paraStyle' }, { before: 0 }),
  effOf({ spaceAfterAuto: 'direct', spaceAfter: 'paraStyle' }, { afterAuto: true, after: 100 }),
  effOf({ indentFirstLine: 'direct', indentLeft: 'numbering' }, {}, { firstLine: 420, left: 9 }),
  effOf({ indentRight: 'direct', line: 'direct' }, { line: { rule: 'auto', raw: 0 } }),
  effOf({ line: 'direct' }, { line: { rule: 'auto', raw: -5 } }),
  effOf({ line: 'direct' }, { line: { rule: 'atLeast', raw: 300 } }),
  effOf({ line: 'direct' }, { line: { rule: 'auto', raw: 241 } }),
  effOf({ line: 'direct' }, { line: { rule: 'auto', raw: 252 } }),
  effOf({ line: 'direct' }, { line: { rule: 'auto', raw: 1 } }),
  effOf({ line: 'direct' }, { line: { rule: 'auto', raw: 246 } }),
  effOf({ line: 'direct' }, { line: { rule: 'auto', raw: 1.2 } }),
  effOf({ line: 'direct' }),
  effOf(
    { line: 'direct', spaceBefore: 'direct' },
    { line: { rule: 'auto', raw: NaN }, before: NaN },
  ),
  effOf({ line: 'direct' }, { line: { rule: 'exact', raw: Infinity } }),
  effOf({ line: 'docDefaults' }, { line: { rule: 'auto', raw: 480 } }),
  { args: { eff: {} } },
]

const STACKS: boolean[][] = [[], [false], [true], [true, false], [false, true], [false, true, true]]

const STYLE_MAP: Array<[string, { styleId: string; name: string }]> = (
  [
    ['a1', 'toc 2'],
    ['a2', 'TOC 5'],
    ['a3', 'table of figures'],
    ['a4', 'Table Of Figures'],
    ['a5', '\uBAA9\uCC28 1'],
    ['a6', 'Custom TOC'],
    ['a7', 'toc 10'],
    ['a8', 'toc0'],
    ['TOC3', 'heading 1'],
    ['a9', 'toc 7 '],
    ['10', 'toc 1'],
    // U+0131 and U+017F: an i and an s only under Unicode case folding
    ['b1', 'table of f\u0131gures'],
    ['b2', 'Table Of Figure\u017f'],
    ['b3', 'TABLE OF F\u0131GURE\u017f'],
  ] as const
).map(([styleId, name]) => [styleId, { styleId, name }])

const STYLE_IDS = [
  'TOC1',
  'TOC 9',
  'toc3',
  'Toc4',
  'TOC0',
  'TOC10',
  'TOC',
  'TOC 1 ',
  'TOC  1',
  'TableofFigures',
  'tableoffigures',
  'TableOfFigures1',
  'TableofF\u0131gures',
  'tableoffigure\u017f',
  'TABLEOFF\u0131GURE\u017f',
  'Heading1',
  '',
  '\uBAA9\uCC281',
  ...STYLE_MAP.map(([id]) => id),
  'missing',
]

const TAG_ATTRS: Array<[string, string, string]> = [
  ['<w:pPr><w:pStyle w:val="TOC1"/></w:pPr>', 'w:pStyle', 'w:val'],
  ["<w:pPr><w:pStyle w:val='TOC2'/></w:pPr>", 'w:pStyle', 'w:val'],
  ['<w:pPr><w:pStyleX w:val="no"/><w:pStyle w:val="yes"/></w:pPr>', 'w:pStyle', 'w:val'],
  ['<w:pPr><w:pStyle w:other="1" w:val=""/></w:pPr>', 'w:pStyle', 'w:val'],
  ['<w:pPr><w:pStyle w:val="a\'b"/></w:pPr>', 'w:pStyle', 'w:val'],
  ['<w:pPr><w:pStyle w:val="mixed\'/></w:pPr>', 'w:pStyle', 'w:val'],
  ['<w:pPr><w:pStyle/></w:pPr>', 'w:pStyle', 'w:val'],
  ['<w:pPr><w:pStyle\tw:val="tab"/></w:pPr>', 'w:pStyle', 'w:val'],
  ['<w:hyperlink w:anchor="_Toc1"/>', 'w:hyperlink', 'w:anchor'],
  ['<w:fldChar w:fldCharType="begin"/>', 'w:fldChar', 'w:fldCharType'],
  ['<w:pStyle wXval="x"/>', 'w:pStyle', 'w.val'],
  ['<w:pStyle xw:val="suffix"/>', 'w:pStyle', 'w:val'],
  ['<w:pStyle\u00A0w:val="nbsp"/>', 'w:pStyle', 'w:val'],
  ['<w:pStyle w:val="x"/>', 'w:(', 'w:val'],
  ['<w:pStyle w:val="x"/>', 'w:pStyle', 'w:v[al'],
  ['<w:a{ w:val="brace"/>', 'w:a{', 'w:val'],
  ['<w:a] w:val="bracket"/>', 'w:a]', 'w:val'],
  ['<w:pStyle w:val="x"/>', 'w:pStyle|w:b', 'w:val'],
]

const BODIES: string[] = [
  `<w:body>${p(...field('PAGE', t('1')))}</w:body>`,
  `<w:body>${p(fld('begin'), instr('TOC'), fld('separate'), t('a'))}${p(t('b'))}</w:body>`,
  `<w:body>${p(fld('begin'), instr('TOC'))}`,
  `<w:body>${p(t('x'), fld('separate'), fld('end'))}</w:body>`,
  `<w:body>${p(r('<w:fldChar w:fldCharType="end"/><w:fldChar w:fldCharType="end"/>'))}</w:body>`,
  `<w:body><w:p><w:r><w:fldChar w:fldCharType="end"/>`,
  `<w:body><w:p><w:r/><w:fldChar w:fldCharType="end"/></w:p></w:body>`,
  `<w:body><!-- ${fld('end')} --><![CDATA[<w:fldChar w:fldCharType="begin"/>]]><?pi ${fld('begin')}?>${p(t('a'))}</w:body>`,
  `<!DOCTYPE x [<!ENTITY a "<w:p>">]><w:body>${p(fld('begin'))}</w:body>`,
  `<w:body><w:p><w:r><w:pict><w:txbxContent>${p(fld('begin'), instr('PAGE'))}</w:txbxContent></w:pict></w:r></w:p></w:body>`,
  `<w:body><w:p>${fld('begin')}<w:r><w:pict><w:txbxContent>${p(t('in'))}</w:txbxContent></w:pict></w:r>${t('after')}</w:p>${p(t('next'))}</w:body>`,
  `<w:body><w:p/>${p(fld('begin'))}<w:p/></w:body>`,
  `<w:body>${p(r('<w:fldChar w:fldCharType = "end" />'))}</w:body>`,
  `<w:body>${p(r('<w:fldChar w:x="a>b" w:fldCharType=\'end\'/>'))}</w:body>`,
  `<w:body><w:p>${r('<w:fldChar w:fldCharType="end"/>')}</w:p ></w:body>`,
  `<w:body><w:p><w:r><w:fldChar w:fldCharType="separate"/></w:r ></w:p></w:body>`,
  `<w:body>${p(fld('begin'), fld('begin'), instr('X'))}${p(fld('end'))}</w:body>`,
  `<w:body>${p(fld('begin'), fld('begin'))}</w:body>`,
  `<w:body>${p(fld('end'), fld('separate'), t('k'), fld('end'))}${p(fld('separate'))}</w:body>`,
  `<w:body>${p(fld('end'))}<w:r`,
  `<w:body>${p(t('no fields'))}</w:body>`,
  `<w:body>${p(t('w:fldCharType mentioned'))}</w:body>`,
  `<w:body><w:p>\uD55C${fld('end')}\u{1F600}${fld('begin')}</w:p></w:body>`,
  `<w:body>${p(r('<w:fldChar w:fldCharType="Begin"/>'))}</w:body>`,
]

const RPRS: string[] = [
  r('<w:rPr><w:b/><w:sz w:val="24"/></w:rPr><w:t>x</w:t>'),
  '<w:rPr w:rsidR="1"><w:rFonts w:ascii="A" w:eastAsia="B"/></w:rPr>',
  '<w:rPr></w:rPr>',
  '<w:rPr/><w:rPr><w:i/></w:rPr>',
  '<w:rPr>text<w:b/>tail</w:rPr>',
  '<w:rPr><w:rFonts w:ascii="A&amp;B"/><![CDATA[c]]></w:rPr>',
  '<w:rPr><__proto__/></w:rPr>',
  '<w:rPr><w:b w:val=></w:rPr>',
  '<w:rPr><w:b></w:rPr>',
  '<w:r/>',
  '<w:rPrChange w:id="1"><w:rPr><w:i/></w:rPr></w:rPrChange>',
  '<w:rPr\n w:x="1"><w:color w:val="FF0000"/><w:color w:val="00FF00"/></w:rPr>',
  '<w:rPr></w:rPr></w:rPr>',
  '<w:rPr><w:b/></w:x></w:rPr>',
  '<w:rPr><w:rFonts w:hAnsi="H" w:eastAsia="E" w:ascii="A"/></w:rPr>',
  '<w:rPr z="1" a="2" 10="3" 2="4"><w:b/></w:rPr>',
]

/** Controls whose tags a comment, CDATA or a processing instruction fakes or hides. */
const MASKED_SDTS: string[] = [
  '<w:p><w:sdt><w:sdtContent><w:r><w:t>a</w:t></w:r></w:sdtContent></w:sdt></w:p>',
  '<w:p><!-- <w:sdt><w:sdtContent></w:sdtContent></w:sdt> --><w:sdt><w:sdtContent><w:r><w:t>real</w:t></w:r></w:sdtContent></w:sdt></w:p>',
  '<w:p><w:sdt><w:sdtContent><w:r><w:t><![CDATA[</w:sdtContent></w:sdt>]]></w:t></w:r></w:sdtContent></w:sdt></w:p>',
  '<w:p><w:sdt><w:sdtPr><w:tag w:val="a"/></w:sdtPr><w:sdtContent><?pi </w:sdtContent> ?><w:r><w:t>x</w:t></w:r></w:sdtContent></w:sdt></w:p>',
  '<w:p><w:sdt><w:sdtContent><!-- </w:sdt> --><w:sdt><w:sdtContent><w:r/></w:sdtContent></w:sdt></w:sdtContent></w:sdt></w:p>',
  '<w:p><w:sdt a="<!-- x -->"><w:sdtContent/></w:sdt><!--></w:sdt>--><w:sdt><w:sdtContent></w:sdtContent></w:sdt></w:p>',
  '<w:p><!-- never closed <w:sdt><w:sdtContent></w:sdtContent></w:sdt></w:p>',
  '<w:p><![CDATA[ never closed <w:sdt><w:sdtContent></w:sdtContent></w:sdt></w:p>',
  '<w:p><?pi never closed <w:sdt><w:sdtContent></w:sdtContent></w:sdt></w:p>',
  '<w:p><!--a--><!--b--><w:sdt><w:sdtContent></w:sdtContent></w:sdt><![CDATA[c]]><?d e?></w:p>',
  '<w:p>\u{1F600}<!-- \u{1F600} --><w:sdt><w:sdtContent><w:r><w:t>\u{e9}</w:t></w:r></w:sdtContent></w:sdt>\u{1F600}<![CDATA[\u{1F601}]]></w:p>',
  '<w:p><w:sdt><w:sdtContent><w:r><w:t>a</w:t></w:r><w:sdt><w:sdtContent><!--</w:sdtContent>--></w:sdtContent></w:sdt></w:sdtContent></w:sdt></w:p>',
]

// ---------------------------------------------------------------- the specs

/** A node with its attributes as entries: their order is part of the node (serializeXNode). */
function attrEntries(node: XNode): unknown {
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      key === ':@'
        ? Object.entries(value as Record<string, string>)
        : Array.isArray(value)
          ? (value as XNode[]).map(attrEntries)
          : value,
    ]),
  )
}

export const FIELDS: CallSpec[] = [
  {
    fn: 'fields.rPrNodeOf',
    call: (text) => {
      const node = rPrNodeOf(text)
      return node && attrEntries(node)
    },
    fromDocument: (parts) => texts(collect(parts).fieldParas),
    built: texts([...RPRS, ...FIELD_PARAS]),
  },
  {
    fn: 'fields.tocLevelOf',
    call: (text, args) =>
      tocLevelOf(
        text,
        args.styles === undefined ? undefined : new Map(args.styles as Array<[string, StyleInfo]>),
      ),
    fromDocument: (parts) => {
      const { styleIds, styles } = collect(parts)
      return styleIds.map((text) => ({ text, args: { styles } }))
    },
    built: [
      ...STYLE_IDS.map((text) => ({ text })),
      ...STYLE_IDS.map((text) => ({ text, args: { styles: STYLE_MAP } })),
      { text: 'a1', args: { styles: [...STYLE_MAP, ['a1', { styleId: 'a1', name: 'plain' }]] } },
    ],
  },
  {
    fn: 'fields.tagAttr',
    call: (text, args) => tagAttr(text, args.tag as string, args.name as string),
    fromDocument: (parts) =>
      collect(parts).fieldParas.flatMap((text) =>
        (
          [
            ['w:pStyle', 'w:val'],
            ['w:fldChar', 'w:fldCharType'],
            ['w:hyperlink', 'w:anchor'],
          ] as const
        ).map(([tag, name]) => ({ text, args: { tag, name } })),
      ),
    built: [
      ...TAG_ATTRS.map(([text, tag, name]) => ({ text, args: { tag, name } })),
      ...FIELD_PARAS.map((text) => ({ text, args: { tag: 'w:pStyle', name: 'w:val' } })),
    ],
  },
  {
    fn: 'fields.directParaGeometry',
    call: (_text, args) => directParaGeometry(args.eff as EffectivePPr),
    fromDocument: (parts) => {
      const { fieldParas, additive } = collect(parts)
      return effsOf(fieldParas, additive)
    },
    built: [...EFFS, ...effsOf(FIELD_PARAS, false)],
    mutation: 'none',
  },
  {
    fn: 'fields.directLineOf',
    call: (_text, args) => directLineOf(args.eff as EffectivePPr),
    fromDocument: (parts) => {
      const { fieldParas, additive } = collect(parts)
      return effsOf(fieldParas, additive)
    },
    built: [...EFFS, ...effsOf(FIELD_PARAS, false)],
    mutation: 'none',
  },
  {
    fn: 'fields.additiveSpacingOf',
    call: (_text, args) => additiveSpacingOf(args.ctx as ResolveCtx),
    fromDocument: (parts) => {
      const ctx = resolveCtxOf({
        styles: new Map(),
        numbering: new Map(),
        doNotUseHTMLParagraphAutoSpacing: collect(parts).additive,
      })
      return [{ args: { ctx: { compat: ctx.compat } } }]
    },
    built: [
      { args: { ctx: { compat: { additiveParaSpacing: true, mode: 15 } } } },
      { args: { ctx: { compat: { additiveParaSpacing: false, mode: 0 } } } },
      { args: { ctx: {} } },
    ],
    mutation: 'none',
  },
  {
    fn: 'fields.fieldStackAfter',
    call: (text, args) => fieldStackAfter(text, args.stack as boolean[]),
    fromDocument: (parts) =>
      stacksOf(collect(parts).fieldParas).map(({ text, stack }) => ({ text, args: { stack } })),
    built: [
      ...FIELD_PARAS.flatMap((text) => STACKS.map((stack) => ({ text, args: { stack } }))),
      ...stacksOf([...FIELD_PARAS, ...EQ_PARAS]).map(({ text, stack }) => ({
        text,
        args: { stack },
      })),
      { text: p(fld('begin')), args: {} },
    ],
  },
  {
    fn: 'fields.markInsideFieldCode',
    call: (_text, args) => markInsideFieldCode(args.stack as boolean[]),
    fromDocument: (parts) =>
      stacksOf(collect(parts).fieldParas).map(({ stack }) => ({ args: { stack } })),
    built: [...STACKS.map((stack) => ({ args: { stack } })), { args: {} }],
    mutation: 'none',
  },
  {
    fn: 'fields.loneFieldEnd',
    call: (text) => loneFieldEnd(text),
    fromDocument: (parts) => texts(collect(parts).fieldParas),
    built: texts(FIELD_PARAS),
  },
  {
    fn: 'fields.fieldLabel',
    call: (text) => fieldLabel(text),
    fromDocument: (parts) => texts(collect(parts).fieldParas),
    built: texts(FIELD_PARAS),
  },
  {
    fn: 'fields.eqFieldToOmml',
    call: (text) => eqFieldToOmml(text),
    fromDocument: (parts) => texts(collect(parts).instrs),
    built: texts(EQ_INSTRS),
  },
  {
    fn: 'fields.inlineEqFieldResults',
    call: (text) => inlineEqFieldResults(text),
    fromDocument: (parts) => texts(collect(parts).fieldParas),
    built: texts([...EQ_PARAS, ...FIELD_PARAS]),
  },
  {
    fn: 'fields.sdtRanges',
    call: (text) => sdtRanges(text),
    fromDocument: (parts) => texts([...collect(parts).bodies, ...collect(parts).sdts]),
    built: texts([...SDTS, ...BODIES, ...MASKED_SDTS]),
  },
  {
    fn: 'fields.parseSdtBlock',
    call: (text) => parseSdtBlock(text),
    fromDocument: (parts) => texts(collect(parts).sdts),
    built: texts(SDTS),
  },
  {
    fn: 'fields.sdtMeta',
    call: (text) => sdtMeta(text),
    fromDocument: (parts) => texts(collect(parts).sdts),
    built: texts(SDTS),
  },
  {
    fn: 'fields.splitSdtParts',
    call: (text) => splitSdtParts(text),
    fromDocument: (parts) => texts(collect(parts).sdts),
    built: texts(SDTS),
  },
  {
    fn: 'fields.sdtTableXml',
    call: (text) => sdtTableXml(text),
    fromDocument: (parts) => texts(collect(parts).sdts),
    built: texts(SDTS),
  },
  {
    fn: 'fields.balanceFieldChars',
    call: (text) => balanceFieldChars(text),
    fromDocument: (parts) => texts(collect(parts).bodies),
    built: texts([...BODIES, ...FIELD_PARAS]),
  },
]
