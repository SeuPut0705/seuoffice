import {
  findBlock,
  isFlowingKind,
  openChapter,
  remapChapter,
  OPAQUE_ELEMENTS,
  type ChapterBlock,
  type ChapterMap,
  type OpenChapter,
} from '../../packages/epub-engine/src/blocks'
import {
  applyBlockEdit,
  applyBlockEdits,
  blockEditReplacements,
  type BlockEdit,
  type EditRefusal,
} from '../../packages/epub-engine/src/edits'
import { toggleMarkInTree } from '../../packages/epub-engine/src/marks'
import {
  blockNotation,
  blockPlainText,
  checkNotation,
  encodeBlock,
  escapeNotationText,
  newBlockNotationToXhtml,
  notationPlainText,
  notationToXhtml,
  notationTreeToXhtml,
  parseBlockNotation,
  serializeNotation,
  type NotationContext,
  type NotationNode,
  type NotationOptions,
} from '../../packages/epub-engine/src/notation'
import { applyReplacements, type RangeReplacement } from '../../packages/epub-engine/src/ranges'
import {
  epubBlockKeyString,
  epubChapterFingerprint,
  epubDocumentHash,
  epubTranslationKeys,
  EPUB_METADATA_FINGERPRINT,
  EPUB_METADATA_FINGERPRINT_SOURCE,
} from '../../packages/epub-engine/src/translate/keys'
import {
  defaultEpubTargetLanguage,
  epubBookLanguage,
  epubSampleText,
} from '../../packages/epub-engine/src/translate/language'
import { epubMigrationInfo } from '../../packages/epub-engine/src/translate/migrate'
import {
  attributeOf,
  childElements,
  elementText,
  elementTextReplacement,
  escapeAttribute,
  ID_ATTRIBUTES,
  insertionAfter,
  localIs,
  namespaceOf,
  prefixOf,
  readStartTag,
  removeIds,
  removeTagAttributes,
  setTagAttribute,
  startTagReplacement,
  tagAttribute,
  walkElements,
  whitespaceStart,
  writeStartTag,
  type StartTag,
} from '../../packages/epub-engine/src/translate/output-markup'
import {
  buildEpubTranslationRequest,
  epubTranslationSystemPrompt,
} from '../../packages/epub-engine/src/translate/prompt'
import {
  chapterTranslationUnits,
  EPUB_METADATA_PAGE,
  epubTranslationUnits,
  metadataTranslationUnits,
  type EpubMetadataLabels,
  type EpubTranslationUnit,
} from '../../packages/epub-engine/src/translate/units'
import type { EpubBook } from '../../packages/epub-engine/src/types'
import { parseXml, type XmlElement } from '../../packages/epub-engine/src/xml-positions'
import {
  LANGUAGE_SAMPLE_CHARS,
  guessLanguageFromText,
} from '../../packages/pdf-structure/src/epub/language'
import { sha256Hex } from '../../packages/pdf-structure/src/tree/hash'
import { runsText } from '../../packages/pdf-structure/src/tree/inline'
import type { InlineRun } from '../../packages/pdf-structure/src/tree/types'
import {
  easyStyleLines,
  translationStyleLines,
} from '../../packages/pdf-structure/src/translate/style'
import {
  defaultTargetLanguage,
  translationLanguageName,
  translationLanguageOf,
} from '../../packages/pdf-structure/src/translate/language'
import type { TranslationMode } from '../../packages/pdf-structure/src/store/job-keys'
import { normalizeLang } from '../../packages/i18n/src/index'
import { mulberry32 } from '../docx-diff/synthetic'
import type { Input, Spec } from '../fileparse-diff/spec'

// What crosses to the Rust side (crates/office-wasm/src/epub_pure.rs): a string that can hold a lone surrogate as its
// UTF-16 units, a number JSON has no form for as its text, a chapter as its text (the case's `text`, or `args.source`
// in units; the Rust side parses it through the host's `parseXmlPositions`), a notation tree as the flat list of its
// tokens. Answers are the TypeScript values with their strings written as units.

type WireNumber = number | string
type Json = unknown

const units = (text: string): number[] =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))
const fromUnits = (codes: unknown): string => {
  const list = codes as readonly number[]
  let text = ''
  for (let i = 0; i < list.length; i += 8192)
    text += String.fromCharCode(...list.slice(i, i + 8192))
  return text
}
const wireNumber = (n: number): WireNumber =>
  Object.is(n, -0) ? '-0' : Number.isFinite(n) ? n : String(n)
const readNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value))
const numberOut = (n: number): Json => (Number.isFinite(n) ? n : { $number: String(n) })

const HIGH = '\uD83D'
const LOW = '\uDE00'
const ASTRAL = HIGH + LOW
const NS = 'xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"'

const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>
const argText = (input: Input, key: string): string =>
  input.args?.[key] !== undefined ? fromUnits(input.args[key]) : (input.text ?? '')
const argSource = (input: Input): string => argText(input, 'source')

// ---------------------------------------------------------------------------
// The wire of what the functions take and give

const blockWire = (b: ChapterBlock): Json => ({
  id: b.id,
  kind: b.kind,
  tag: b.tag,
  attributes: b.attributes.map((a) => ({ name: a.name, value: a.value })),
  flowing: b.flowing,
  selfClosing: b.selfClosing,
  outer: { start: b.outer.start, end: b.outer.end },
  inner: { start: b.inner.start, end: b.inner.end },
  elementStart: b.element.start,
})
const chapterWire = (map: ChapterMap): Json =>
  map.broken
    ? { broken: true, source: units(map.source), error: map.error, offset: map.offset }
    : {
        broken: false,
        source: units(map.source),
        blocks: map.blocks.map(blockWire),
        nextId: map.nextId,
        hasDoctype: map.doc.hasDoctype,
      }

function tokensOf(tree: readonly NotationNode[]): Json[] {
  const out: Json[] = []
  const walk = (nodes: readonly NotationNode[]): void => {
    for (const node of nodes) {
      if (node.t === 'text') out.push(['t', units(node.v)])
      else if (node.t === 'br') out.push(['br', node.orig])
      else if (node.t === 'x' && node.c === null) out.push(['xe', numberOut(node.n)])
      else if (node.t === 'x') {
        out.push(['xo', numberOut(node.n)])
        walk(node.c!)
        out.push(['c'])
      } else {
        out.push(['o', node.t, node.orig])
        walk(node.c)
        out.push(['c'])
      }
    }
  }
  walk(tree)
  return out
}
/** The tokens as a case writes them: a number JSON cannot hold is its text. */
const tokensIn = (tree: readonly NotationNode[]): Json[] =>
  tokensOf(tree).map((token) => {
    const list = token as unknown[]
    return list[0] === 'xe' || list[0] === 'xo'
      ? [
          list[0],
          wireNumber(
            readNumber(
              list[1] !== null && typeof list[1] === 'object'
                ? (list[1] as { $number: string }).$number
                : list[1],
            ),
          ),
        ]
      : list
  })
function treeOf(tokens: unknown): NotationNode[] {
  const root: NotationNode[] = []
  const stack: { node: NotationNode & { c: NotationNode[] | null }; c: NotationNode[] }[] = []
  for (const raw of tokens as unknown[][]) {
    const into = stack.length > 0 ? stack[stack.length - 1]!.c : root
    switch (raw[0]) {
      case 't':
        into.push({ t: 'text', v: fromUnits(raw[1]) })
        break
      case 'br':
        into.push({ t: 'br', orig: raw[1] as number | null })
        break
      case 'xe':
        into.push({ t: 'x', n: readNumber(raw[1]), c: null })
        break
      case 'o': {
        const node = {
          t: raw[1] as 'b' | 'i',
          orig: raw[2] as number | null,
          c: [] as NotationNode[],
        }
        into.push(node)
        stack.push({ node, c: node.c })
        break
      }
      case 'xo': {
        const node = { t: 'x' as const, n: readNumber(raw[1]), c: [] as NotationNode[] }
        into.push(node)
        stack.push({ node, c: node.c })
        break
      }
      default:
        stack.pop()
    }
  }
  return root
}

const contextWire = (c: NotationContext): Json => ({
  placeholders: c.placeholders.map((p) => ({
    n: numberOut(p.n),
    tag: p.tag,
    empty: p.empty,
    startTag: units(p.startTag),
    endTag: units(p.endTag),
    outer: units(p.outer),
  })),
  bold: c.bold.map((m) => ({ startTag: units(m.startTag), endTag: units(m.endTag) })),
  italic: c.italic.map((m) => ({ startTag: units(m.startTag), endTag: units(m.endTag) })),
  breaks: c.breaks.map(units),
})
const contextOf = (value: unknown): NotationContext => {
  const w = record(value)
  const marks = (list: unknown) =>
    (list as { startTag: number[]; endTag: number[] }[]).map((m) => ({
      startTag: fromUnits(m.startTag),
      endTag: fromUnits(m.endTag),
    }))
  return {
    placeholders: (w.placeholders as Record<string, unknown>[]).map((p) => ({
      n: readNumber(p.n),
      tag: p.tag as string,
      empty: p.empty as boolean,
      startTag: fromUnits(p.startTag),
      endTag: fromUnits(p.endTag),
      outer: fromUnits(p.outer),
    })),
    bold: marks(w.bold),
    italic: marks(w.italic),
    breaks: (w.breaks as number[][]).map(fromUnits),
  }
}

type WireEdit = Record<string, unknown>
function editWire(edit: BlockEdit): WireEdit {
  const wire: WireEdit = { op: edit.op, blockId: units(edit.blockId) }
  if (edit.op === 'replace') {
    wire.text = units(edit.text)
    if (edit.dropRuby !== undefined) wire.dropRuby = edit.dropRuby
  } else if (edit.op === 'insert_after') wire.text = units(edit.text)
  else if (edit.op === 'split' || edit.op === 'line_break') wire.offset = wireNumber(edit.offset)
  else if (edit.op === 'merge') wire.with = edit.with
  else if (edit.op === 'toggle_mark') {
    wire.mark = edit.mark
    wire.start = wireNumber(edit.start)
    wire.end = wireNumber(edit.end)
  }
  return wire
}
function editOf(value: unknown): BlockEdit {
  const w = record(value)
  const blockId = fromUnits(w.blockId)
  switch (w.op) {
    case 'replace':
      return {
        op: 'replace',
        blockId,
        text: fromUnits(w.text),
        ...(w.dropRuby === undefined ? {} : { dropRuby: w.dropRuby as boolean }),
      }
    case 'insert_after':
      return { op: 'insert_after', blockId, text: fromUnits(w.text) }
    case 'delete':
      return { op: 'delete', blockId }
    case 'split':
      return { op: 'split', blockId, offset: readNumber(w.offset) }
    case 'merge':
      return { op: 'merge', blockId, with: w.with as 'previous' | 'next' }
    case 'line_break':
      return { op: 'line_break', blockId, offset: readNumber(w.offset) }
    default:
      return {
        op: 'toggle_mark',
        blockId,
        mark: w.mark as 'bold' | 'italic',
        start: readNumber(w.start),
        end: readNumber(w.end),
      }
  }
}
const replacementWire = (r: RangeReplacement): Json => ({
  start: numberOut(r.start),
  end: numberOut(r.end),
  text: units(r.text),
})
const replacementsWire = (list: readonly RangeReplacement[]): Json => list.map(replacementWire)
const refusalWire = (r: EditRefusal): Json => ({ code: r.code, message: units(r.message) })

const tagWire = (t: StartTag): Json => ({
  name: units(t.name),
  attributes: t.attributes.map((a) => ({
    name: units(a.name),
    raw: units(a.raw),
    value: units(a.value),
  })),
  tail: units(t.tail),
})
const tagOf = (value: unknown): StartTag => {
  const w = record(value)
  return {
    name: fromUnits(w.name),
    attributes: (w.attributes as Record<string, unknown>[]).map((a) => ({
      name: fromUnits(a.name),
      raw: fromUnits(a.raw),
      value: fromUnits(a.value),
    })),
    tail: fromUnits(w.tail),
  }
}

const runWire = (run: InlineRun): Json => {
  if (run.kind === 'text')
    return {
      kind: 'text',
      text: units(run.text),
      ...(run.bold ? { bold: true } : {}),
      ...(run.italic ? { italic: true } : {}),
      ...(run.href === undefined ? {} : { href: run.href }),
    }
  if (run.kind === 'footnoteRef')
    return {
      kind: 'footnoteRef',
      id: run.id,
      ...(run.marker === undefined ? {} : { marker: run.marker }),
    }
  if (run.kind === 'math') return { kind: 'math', latex: units(run.latex) }
  return { kind: 'lineBreak' }
}
const runOf = (value: unknown): InlineRun => {
  const w = record(value)
  if (w.kind === 'text')
    return {
      kind: 'text',
      text: fromUnits(w.text),
      ...(w.bold ? { bold: true as const } : {}),
      ...(w.italic ? { italic: true as const } : {}),
      ...(w.href === undefined ? {} : { href: w.href as string }),
    }
  if (w.kind === 'footnoteRef')
    return {
      kind: 'footnoteRef',
      id: w.id as string,
      ...(w.marker === undefined ? {} : { marker: w.marker as string }),
    }
  if (w.kind === 'math') return { kind: 'math', latex: fromUnits(w.latex) }
  return { kind: 'lineBreak' }
}
const unitWire = (u: EpubTranslationUnit): Json => ({
  runs: u.runs.map(runWire),
  pageFingerprint: u.pageFingerprint,
  page: numberOut(u.page),
  text: units(u.text),
  plainText: units(u.plainText),
  context: contextWire(u.context),
  sources: u.sources.map((s) =>
    s.kind === 'block'
      ? { kind: 'block', spineIndex: numberOut(s.spineIndex), path: s.path, blockId: s.blockId }
      : { kind: s.kind, index: s.index },
  ),
  key: {
    pageFingerprint: u.key.pageFingerprint,
    textHash: u.key.textHash,
    occurrence: u.key.occurrence,
  },
})

// ---------------------------------------------------------------------------
// Building inputs

/** One input per distinct args and text; the label says what it is. */
function distinct(name: string, inputs: Input[]): Input[] {
  const seen = new Set<string>()
  const out: Input[] = []
  for (const input of inputs) {
    const key = JSON.stringify([
      input.text,
      input.args,
      input.bytes ? Array.from(input.bytes) : null,
    ])
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...input, label: `${name} ${out.length} ${input.label}`.slice(0, 200) })
  }
  return out
}
const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)]!
const generated = <T>(
  seed: number,
  count: number,
  make: (random: () => number, index: number) => T,
): T[] => {
  const random = mulberry32(seed)
  return Array.from({ length: count }, (_, i) => make(random, i))
}

const page = (body: string, head = ''): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<html ${NS}>\n<head><title>t</title>${head}</head>\n<body>\n${body}\n</body>\n</html>\n`
const DOCTYPE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">'

const PROSE = page(`<h1 id="t">Title <i>of</i> a <b>book</b></h1>
<p>First paragraph with <strong>bold</strong>, <em>italic</em>, a<br/>break and <a href="x.xhtml#n1" id="r1">a link</a>.</p>
<p class="c">Ruby: <ruby>\u6F22<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>\u5B57 and &amp; &lt; &#65; &#x1F600; end</p>
<p>Image <img src="a.png" alt="a"/> and math <math><mi>x</mi></math> and <svg><title>s</title></svg> done</p>
<p id="empty"/>
<p>Footnote<sup><a epub:type="noteref" href="#n">1</a></sup> and <span class="s" title="a &amp; b">span <b>bold <i>both</i></b></span></p>
<ul><li>one</li><li>two <b>b</b></li><li><p>para in li</p></li></ul>
<table><tr><td>cell <i>i</i></td><th>head</th><td/></tr></table>
<dl><dt>term</dt><dd>def</dd></dl>
<figure><img src="f.png"/><figcaption>cap <b>b</b></figcaption></figure>
<blockquote>quote</blockquote>
<blockquote><p>nested</p></blockquote>
<div>text div</div><div><p>wrapped</p></div><div>mixed <p>p</p></div><div>  </div>
<p>a<script>var x = 1 &lt; 2</script>b<style>p {}</style>c<template><p>t</p></template>d</p>`)

const CHAPTERS: Array<[string, string]> = [
  ['prose', PROSE],
  [
    'doctype',
    `<?xml version="1.0"?>\n${DOCTYPE}\n<html xmlns="http://www.w3.org/1999/xhtml"><body><p>a&nbsp;b&eacute;c &copy; &amp; d</p><p>x&nbsp;<b>y&nbsp;z</b>&eacute;w</p></body></html>`,
  ],
  [
    'cdata',
    page(
      '<p>a<![CDATA[b < c & d]]>e<!-- c -->f<?pi x?>g</p>\n<p>aaa<![CDATA[bbb]]>ccc <b>x<![CDATA[]]>y</b></p>\n<p><![CDATA[only]]></p>',
    ),
  ],
  [
    'crlf',
    `<?xml version="1.0"?>\r\n<html xmlns="http://www.w3.org/1999/xhtml">\r\n<body>\r\n  <p>line one\r\nline two\r\rthree</p>\r\n  <p>b</p>\r\n</body>\r\n</html>\r\n`,
  ],
  [
    'selfclosing',
    page(
      '<p class="a"/>\n  <p  id=\'x\' />\n<div/>\n<h2 />\n<table><tr><td/><td class="q"/></tr></table>\n<ul><li id="L"/><li>b</li></ul>\n<p>text</p>\n<p/>',
    ),
  ],
  [
    'anchors',
    page(
      '<p id="a">x</p>\n<p id="b">y</p>\n<p id=\'c\'>z</p>\n<p xml:id="d">w</p>\n<p title="id=1" id = "e">v</p>\n<div>t</div>\n<p id="solo">only</p>',
    ),
  ],
  [
    'astral',
    page(
      `<p>${ASTRAL} emoji &#x1F600; and a\u{1F680}b</p><p>\u{1F600}\u{1F601}\u{1F602}</p><p>x&#128512;y&#x10FFFF;z</p>`,
    ),
  ],
  [
    'prefixed',
    `<x:html xmlns:x="http://www.w3.org/1999/xhtml"><x:body><x:p>pref <x:b>bold</x:b> <x:br/></x:p><x:div><x:p>in div</x:p></x:div></x:body></x:html>`,
  ],
  [
    'inline',
    page(
      '<p>a <span class="s">b <em>c <b>d</b> e</em> f</span> g <a href="#">link <i>it</i></a> <b>x</b><b>y</b> <b>z <b>nested</b></b></p>\n<p><b>whole</b></p>\n<p><b>a</b> <i>b</i></p>\n<p><em><b>deep <i>mark</i></b></em></p>\n<p>m <b>1</b><br/><b>2</b></p>',
    ),
  ],
  [
    'merges',
    page(
      '<p>a</p><!-- c --><p>b</p>\n<p>c</p>text<p>d</p>\n<p>e</p><p/><p>f</p>\n<p>g</p>\n<h3>h</h3>\n<table><tr><td>t1</td><td>t2</td></tr></table>\n<p>i</p><p>j</p>',
    ),
  ],
  ['empty-blocks', page('<p></p><p> </p><p>\n</p><div> </div><div></div><p>x</p>')],
  [
    'opaque',
    page(
      '<p>a<svg><text>s</text></svg>b</p><p><math><mi>x</mi></math></p><p>only <script>1</script></p><p><template>t</template></p><div><svg/></div>',
    ),
  ],
  [
    'bom-and-decl',
    `\uFEFF<?xml version="1.0"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><body><p>bom</p></body></html>`,
  ],
  ['flat', '<html><body><p>no namespace</p><p>second</p></body></html>'],
  ['headings', page('<h1>one</h1>\n<h4>four</h4>\n<h5>five</h5>\n<h6>six</h6>\n<p>after</p>')],
  // a block that is the root, with only blanks before it: its indentation runs to the first character
  ['bare root', '  <p>lead</p>'],
  ['bare root tab', '\n\t<p xmlns="http://www.w3.org/1999/xhtml">lead <b>b</b></p>'],
]
const deepDivs = (n: number): string =>
  page(`${'<div>'.repeat(n)}text${'</div>'.repeat(n)}<p>after</p>`)
const deepSpans = (n: number): string => page(`<p>${'<span>'.repeat(n)}t${'</span>'.repeat(n)}</p>`)
const deepMarks = (n: number): string =>
  page(
    `<p>${'<b>'.repeat(n)}t${'</b>'.repeat(n)}</p><p>${'<span>'.repeat(n)}x${'</span>'.repeat(n)}</p>`,
  )
const manyParagraphs = (n: number): string =>
  page(
    Array.from(
      { length: n },
      (_, i) => `<p id="p${i}">Paragraph ${i} with <b>bold</b> and <i>italic</i>.</p>`,
    ).join('\n'),
  )
const HOSTILE: Array<[string, string]> = [
  ['empty', ''],
  ['text only', 'just text'],
  ['no root', '<?xml version="1.0"?>'],
  ['unclosed', page('<p>open')],
  ['mismatch', page('<p><b>x</p></b>')],
  ['bare ampersand', page('<p>a & b</p>')],
  ['unknown entity', page('<p>&bogus;</p>')],
  ['two roots', '<a/><b/>'],
  ['attribute without value', page('<p class>x</p>')],
  ['lt in attribute', page('<p title="a<b">x</p>')],
  ['bad char ref', page('<p>&#0;</p>')],
  ['comment dashes', page('<p><!-- a -- b --></p>')],
  ['deep 500 divs', deepDivs(500)],
  ['deep 500 spans', deepSpans(500)],
  ['deep 500 marks', deepMarks(500)],
  ['deep 20000 divs', deepDivs(20000)],
  ['deep 20000 spans', deepSpans(20000)],
  ['deep 20000 marks', deepMarks(20000)],
  ['300 paragraphs', manyParagraphs(300)],
  ['deep 900 spans', deepSpans(900)],
  ['deep 900 marks', deepMarks(900)],
  ['deep 900 divs', deepDivs(900)],
]
const ALL_CHAPTERS: Array<[string, string]> = [...CHAPTERS, ...HOSTILE]

/** The map of a case's text, with every block id: `[]` where the chapter is broken. */
const mapOf = (source: string): OpenChapter | null => {
  const map = openChapter(source)
  return map.broken ? null : map
}
const plainLength = (map: OpenChapter, block: ChapterBlock): number =>
  blockPlainText(map, block).length

// ---------------------------------------------------------------------------
// Chapters, blocks, notation

const tryMap = (source: string): OpenChapter | null => {
  try {
    return mapOf(source)
  } catch {
    return null
  }
}
const chapterInputs = (name: string): Input[] =>
  ALL_CHAPTERS.map(([label, source]) => ({ label: `${name} ${label}`, text: source }))
/** Sources a plain string cannot be: a lone surrogate in a chapter. */
const LONE_CHAPTERS: Array<[string, string]> = [
  ['lone high', page('<p>a\uD800b</p>')],
  ['lone low', page('<p>a\uDE00b</p>')],
  ['pair', page(`<p>a${ASTRAL}b</p>`)],
  ['reversed pair', page(`<p>a${LOW}${HIGH}b</p>`)],
  ['lone in attribute', page('<p title="\uD800">x</p>')],
  ['lone in comment', page('<p>x<!-- \uDC00 --></p>')],
]
const loneInputs = (name: string): Input[] =>
  LONE_CHAPTERS.map(([label, source]) => ({
    label: `${name} ${label}`,
    args: { source: units(source) },
  }))

/** Up to `limit` blocks of each chapter that opens, spread over it. */
function blockCases(
  limit: number,
  deep = true,
): Array<{ label: string; source: string; map: OpenChapter; block: ChapterBlock }> {
  const out: Array<{ label: string; source: string; map: OpenChapter; block: ChapterBlock }> = []
  for (const [label, source] of CHAPTERS.concat(
    [HOSTILE[12]!, HOSTILE[13]!, HOSTILE[14]!, HOSTILE[18]!],
    deep ? [HOSTILE[19]!, HOSTILE[20]!] : [],
  )) {
    const map = tryMap(source)
    if (!map) continue
    const step = Math.max(1, Math.ceil(map.blocks.length / limit))
    for (let i = 0; i < map.blocks.length; i += step)
      out.push({ label: `${label} ${map.blocks[i]!.id}`, source, map, block: map.blocks[i]! })
  }
  return out
}

/** `blockNotation` text and context of a block. */
const notationOf = (
  map: OpenChapter,
  block: ChapterBlock,
  dropRuby = false,
): { text: string; context: NotationContext } => blockNotation(map, block, { dropRuby })

const RICH_CONTEXT: NotationContext = {
  placeholders: [
    {
      n: 1,
      tag: 'a',
      empty: false,
      startTag: '<a href="x">',
      endTag: '</a>',
      outer: '<a href="x">y</a>',
    },
    {
      n: 2,
      tag: 'img',
      empty: true,
      startTag: '<img src="a"/>',
      endTag: '',
      outer: '<img src="a"/>',
    },
  ],
  bold: [{ startTag: '<b class="k">', endTag: '</b>' }],
  italic: [{ startTag: '<em>', endTag: '</em>' }],
  breaks: ['<br class="z"/>'],
}
const EMPTY_CONTEXT: NotationContext = { placeholders: [], bold: [], italic: [], breaks: [] }
const BIG = '9'.repeat(30)
const NOTATIONS: string[] = [
  '',
  'plain',
  'a &amp; b',
  '&lt;&gt;',
  '&#65;&#x41;',
  '&#128512;',
  '&#xD800;',
  '&#xDE00;',
  '&#0;',
  '&#x110000;',
  '&#x10FFFF;',
  `&#${BIG};`,
  `&#x${'F'.repeat(300)};`,
  '&#1;',
  '&#x;',
  '&#xg;',
  '&#X41;',
  '&bogus;',
  '&amp',
  '& ',
  '&&amp;',
  '&quot;&apos;',
  '&AMP;',
  '<b>bold</b>',
  '<i>it</i>',
  '<b><i>x</i></b>',
  '<b>a</i>',
  '</b>',
  '<b>',
  '<b></b>',
  '<br/>',
  '<br>',
  '<br />',
  '<br\u00A0/>',
  '<br\u2028/>',
  '<BR/>',
  '<br/ >',
  '<x1/>',
  '<x1>t</x1>',
  '<x1 />',
  '<x01/>',
  '<x1',
  '<x1>',
  '</x1>',
  '<x2/>',
  '<x3/>',
  '<x1/><x1/>',
  '<x1>a</x1><x2/>',
  '<x2/><x1>a</x1>',
  '<x1><x2/></x1>',
  '<x1>a<x2/></x1>',
  '<x1/><x2/>',
  '<x2>a</x2><x1/>',
  '<x1>a</x1><x1>b</x1>',
  '<x1>a</x2>',
  `<x${BIG}/>`,
  `<x${BIG}>a</x${BIG}>`,
  `<x1${BIG}/>`,
  '<q>',
  '</q>',
  '<3',
  'a < b',
  '<>',
  '<<b>>',
  '<b>a<br/>b</b>',
  '<b\n>',
  '<!-- c -->',
  '<?pi?>',
  '<a href="x">y</a>',
  '< b>',
  '<b >',
  '<b/>',
  '<i/>',
  `unknown ${ASTRAL} <q ${ASTRAL}>`,
  `<q\n>${ASTRAL}`,
  '<?x',
  '<!doctype',
  '</',
  '<b><b>x</b></b>',
  '<b>x</b><b>y</b>',
  '<i><b>x</b></i>',
  'text <b>bold <x1>link <i>it</i></x1></b> end <br/> <x2/>',
  '<b>a</b> <b>b</b> <i>c</i> <br/> <br/> <i>d</i>',
  'x'.repeat(5000),
  '<b>'.repeat(400) + 'x' + '</b>'.repeat(400),
  '<b>'.repeat(20000) + 'x' + '</b>'.repeat(20000),
  '<b>'.repeat(20000),
  '</b>'.repeat(3),
  'a\u0001b\u000B\uFFFE\uFFFF\u0000c',
  '\u2028\u00A0\uFEFF',
  'tab\tnl\ncr\r',
  ']]>',
  'it\'s "quoted"',
]
/** Notations a lone surrogate is part of (they cross as units). */
const LONE_NOTATIONS: string[] = [
  'a\uD800b',
  '\uDC00',
  '<b>\uD800</b>',
  `${HIGH}`,
  `${LOW}${HIGH}`,
  `x${ASTRAL}y\uD800`,
  '<q \uD800>',
  '<x1>\uDE00</x1>',
]

function variants(text: string): string[] {
  const out = [
    text,
    `${text} more`,
    `more ${text}`,
    text.replace(/<x1>/, ''),
    text.replace(/<\/x1>/, ''),
    text.replace(/<x1>/, '<x1/>'),
    text.replace(/<x1\/>/, '<x1></x1>'),
    text.replace(/x1/g, 'x2'),
    text.replace(/<x2\/>/, ''),
    text.replace(/<b>/, ''),
    text.replace(/<br\/>/, ''),
    `<b>${text}</b>`,
    `<i>${text}</i>`,
    text + text,
    text.replace(/&amp;/g, '&'),
    text.replace(/&/g, '&amp;'),
    text.replace(/ /, '<br/>'),
    text.replace(/<\/b>/, '</i>'),
    Array.from(text)
      .slice(0, Math.floor(text.length / 2))
      .join(''),
    text.replace(/<x1>/, '<x1><q>'),
  ]
  return out
}

function notationInputs(name: string, withLone: boolean): Input[] {
  const inputs: Input[] = []
  const rich = { context: contextWire(RICH_CONTEXT) }
  const empty = { context: contextWire(EMPTY_CONTEXT) }
  for (const notation of NOTATIONS) {
    inputs.push({
      label: `${name} empty ${JSON.stringify(notation.slice(0, 40))}`,
      text: notation,
      args: empty,
    })
  }
  for (const notation of [
    '<x1>link</x1> and <x2/>',
    '<b>x</b> <x1>y</x1> <x2/> <i>z</i><br/>',
    '<x1>a</x1>',
    '<x2/>',
    '<x1>a</x1><x2/><x2/>',
    '<x1/><x2/>',
    '<x2>a</x2><x1>a</x1>',
    '<x1>a <b>b</b></x1><x2/>',
    '<b><x1>a</x1></b><x2/>',
    '<i>a</i><i>b</i><x1>a</x1><x2/>',
    '<b>a</b><b>b</b><x1>a</x1><x2/>',
    '<br/><br/><x1>a</x1><x2/>',
    'a<br/>b<x1>c</x1><x2/>',
    '<x1><x1>a</x1></x1><x2/>',
    `<x1>a</x1><x2/><x3/>`,
    '<x1>a</x1><x2></x2>',
  ]) {
    inputs.push({
      label: `${name} rich ${JSON.stringify(notation.slice(0, 40))}`,
      text: notation,
      args: rich,
    })
  }
  for (const { label, map, block } of blockCases(5, false)) {
    for (const dropRuby of [false, true]) {
      const { text, context } = notationOf(map, block, dropRuby)
      for (const [k, variant] of variants(text).entries()) {
        inputs.push({
          label: `${name} ${label} ${dropRuby ? 'dropRuby ' : ''}variant ${k}`,
          text: variant,
          args: { context: contextWire(context) },
        })
      }
    }
  }
  if (withLone)
    for (const notation of LONE_NOTATIONS)
      inputs.push({
        label: `${name} lone ${JSON.stringify(notation)}`,
        args: { text: units(notation), ...empty },
      })
  return inputs
}

const parsedTrees = (): Array<[string, NotationNode[], NotationContext]> => {
  const out: Array<[string, NotationNode[], NotationContext]> = []
  for (const { label, map, block } of blockCases(4, false)) {
    const { tree, context } = encodeBlock(map, block)
    out.push([label, tree, context])
  }
  for (const text of NOTATIONS.slice(0, 120).concat([
    '<x1>link</x1> and <x2/>',
    '<b>x</b> <x1>y</x1> <x2/> <i>z</i><br/>',
    '<b><i>x</i></b><br/><br/>',
  ])) {
    if (text.length > 600) continue
    const parsed = parseBlockNotation(text, RICH_CONTEXT)
    if (parsed.ok) out.push([`parsed ${text.slice(0, 30)}`, parsed.tree, RICH_CONTEXT])
  }
  return out
}
const OFFBEAT_TREES: Array<[string, Json[]]> = [
  ['empty', []],
  ['empty text', [['t', []]]],
  [
    'empty text twice',
    [
      ['t', []],
      ['t', []],
    ],
  ],
  ['text', [['t', units('a<b&c>d')]]],
  ['br no orig', [['br', null]]],
  ['br orig 0', [['br', 0]]],
  ['br orig 3', [['br', 3]]],
  ['b orig 9', [['o', 'b', 9], ['t', units('x')], ['c']]],
  ['i orig 4', [['o', 'i', 4], ['t', units('x')], ['c']]],
  ['b new', [['o', 'b', null], ['t', units('x')], ['c']]],
  ['empty mark', [['o', 'b', null], ['c']]],
  ['x missing', [['xe', 7]]],
  ['x open missing', [['xo', 7], ['t', units('a')], ['c']]],
  ['x empty ok', [['xe', 2]]],
  ['x open ok', [['xo', 1], ['t', units('a')], ['c']]],
  ['x fractional', [['xe', 1.5]]],
  ['x zero', [['xe', 0]]],
  ['x negative', [['xe', -1]]],
  ['x infinity', [['xe', 'Infinity']]],
  ['x nan', [['xo', 'NaN'], ['c']]],
  ['x big', [['xe', 1e21]]],
  ['x empty content', [['xo', 1], ['c']]],
  ['x in x', [['xo', 1], ['xo', 2], ['t', units('a')], ['c'], ['c']]],
  [
    'x dup',
    [
      ['xe', 2],
      ['xe', 2],
    ],
  ],
  ['lone', [['t', [0xd800, 0x61, 0xdc00]]]],
  ['pair', [['t', units(ASTRAL)]]],
  ['controls', [['t', [0, 1, 8, 11, 12, 14, 31, 0xfffe, 0xffff, 0x20]]]],
  [
    'nested marks',
    [
      ['o', 'b', 0],
      ['o', 'i', 0],
      ['t', units('a')],
      ['c'],
      ['o', 'b', null],
      ['t', units('b')],
      ['c'],
      ['c'],
    ],
  ],
]
const DEEP_TOKENS = (n: number): Json[] => [
  ...Array.from({ length: n }, (): Json => ['o', 'b', null]),
  ['t', units('x')],
  ...Array.from({ length: n }, (): Json => ['c']),
]

const argTree = (input: Input): NotationNode[] => treeOf(input.args!.tree)
const treeInputs = (name: string, withContext: boolean): Input[] => {
  const inputs: Input[] = []
  for (const [label, tree, context] of parsedTrees()) {
    inputs.push({
      label: `${name} ${label}`,
      args: { tree: tokensIn(tree), ...(withContext ? { context: contextWire(context) } : {}) },
    })
  }
  for (const [label, tokens] of OFFBEAT_TREES) {
    inputs.push({
      label: `${name} ${label}`,
      args: { tree: tokens, ...(withContext ? { context: contextWire(RICH_CONTEXT) } : {}) },
    })
    if (withContext)
      inputs.push({
        label: `${name} ${label} empty context`,
        args: { tree: tokens, context: contextWire(EMPTY_CONTEXT) },
      })
  }
  for (const n of [300, 900, 20000]) {
    inputs.push({
      label: `${name} deep ${n}`,
      args: {
        tree: DEEP_TOKENS(n),
        ...(withContext ? { context: contextWire(EMPTY_CONTEXT) } : {}),
      },
    })
  }
  return inputs
}

const withBlock = (input: Input, f: (map: OpenChapter, block: ChapterBlock) => Json): Json => {
  const map = openChapter(argSource(input))
  if (map.broken) return chapterWire(map)
  const id = fromUnits(input.args!.blockId)
  const block = findBlock(map, id)
  if (!block) throw new Error(`no block ${id}`)
  return f(map, block)
}
const blockInputs = (
  name: string,
  extra: (map: OpenChapter, block: ChapterBlock) => Array<[string, Record<string, unknown>]>,
): Input[] => {
  const inputs: Input[] = []
  for (const { label, source, map, block } of blockCases(8)) {
    for (const [what, args] of extra(map, block))
      inputs.push({
        label: `${name} ${label}${what ? ` ${what}` : ''}`,
        text: source,
        args: { blockId: units(block.id), ...args },
      })
  }
  for (const [label, source] of [
    ['unknown id', PROSE],
    ['broken', HOSTILE[3]![1]],
    ['empty', ''],
  ] as const) {
    inputs.push({ label: `${name} ${label}`, text: source, args: { blockId: units('b99') } })
  }
  return inputs
}

export const SPECS: Spec[] = []
const add = (spec: Spec): void => {
  SPECS.push(spec)
}
const noText = { extensions: [] as string[] }

add({
  fn: 'isFlowingKind',
  ...noText,
  mutation: 'none',
  call: ({ args = {} }) => isFlowingKind(args.value as string),
  built: () =>
    distinct(
      'kind',
      [
        'p',
        'h1',
        'h6',
        'li',
        'blockquote',
        'div',
        'td',
        'th',
        'figcaption',
        'dt',
        'dd',
        'span',
        'P',
        '',
        'section',
        'body',
        'constructor',
        '__proto__',
        'toString',
        'h7',
      ].map((value) => ({ label: JSON.stringify(value), args: { value } })),
    ),
})
add({
  fn: 'openChapter',
  ...noText,
  mutation: 'text',
  call: (input) => chapterWire(openChapter(argSource(input))),
  built: () => distinct('open', [...chapterInputs('chapter'), ...loneInputs('lone')]),
})
add({
  fn: 'findBlock',
  ...noText,
  mutation: 'text',
  call: (input) => {
    const map = openChapter(argSource(input))
    if (map.broken) return chapterWire(map)
    const block = findBlock(map, fromUnits(input.args!.blockId))
    return block ? blockWire(block) : null
  },
  built: () =>
    distinct('find', [
      ...blockInputs('block', () => [['', {}]]),
      { label: 'lone id', text: PROSE, args: { blockId: units(`b1${HIGH}`) } },
    ]),
})
add({
  fn: 'remapChapter',
  ...noText,
  mutation: 'text',
  call: (input) => {
    const previous = openChapter(fromUnits(input.args!.previousSource))
    if (previous.broken) throw new Error('previous is broken')
    const replacements = (input.args!.replacements as Array<Record<string, unknown>>).map((r) => ({
      start: readNumber(r.start),
      end: readNumber(r.end),
      text: fromUnits(r.text),
    }))
    return chapterWire(remapChapter(previous, argSource(input), replacements))
  },
  built: () => {
    const inputs: Input[] = []
    for (const [label, source] of CHAPTERS) {
      const previous = openChapter(source)
      if (previous.broken) continue
      const wire = (rs: RangeReplacement[]) =>
        rs.map((r) => ({ start: wireNumber(r.start), end: wireNumber(r.end), text: units(r.text) }))
      const tried: RangeReplacement[][] = [[]]
      for (const block of previous.blocks.slice(0, 6)) {
        for (const edit of [
          { op: 'split', blockId: block.id, offset: 1 },
          { op: 'delete', blockId: block.id },
          { op: 'insert_after', blockId: block.id, text: 'new <b>b</b>' },
          { op: 'merge', blockId: block.id, with: 'next' },
          { op: 'replace', blockId: block.id, text: 'replaced' },
        ] as BlockEdit[]) {
          const computed = blockEditReplacements(previous, edit)
          if (computed.ok && computed.replacements.length > 0) tried.push(computed.replacements)
        }
      }
      tried.push(
        [{ start: 0, end: 0, text: '<!-- c -->' }],
        [{ start: previous.source.length, end: previous.source.length, text: '\n' }],
        [{ start: 3, end: 40, text: '' }],
      )
      for (const [k, replacements] of tried.entries()) {
        let source2: string
        try {
          source2 = applyReplacements(previous.source, replacements)
        } catch {
          continue
        }
        inputs.push({
          label: `remap ${label} ${k}`,
          text: source2,
          args: { previousSource: units(previous.source), replacements: wire(replacements) },
        })
      }
    }
    return distinct('remap', inputs)
  },
})

add({
  fn: 'escapeNotationText',
  ...noText,
  mutation: 'text',
  call: (input) => units(escapeNotationText(argText(input, 'text'))),
  built: () =>
    distinct('escape', [
      ...NOTATIONS.map((text) => ({ label: JSON.stringify(text.slice(0, 40)), text })),
      ...LONE_NOTATIONS.map((text) => ({
        label: `lone ${JSON.stringify(text)}`,
        args: { text: units(text) },
      })),
    ]),
})
add({
  fn: 'encodeBlock',
  ...noText,
  mutation: 'text',
  call: (input) =>
    withBlock(input, (map, block) => {
      const { tree, context } = encodeBlock(map, block, { dropRuby: input.args!.dropRuby === true })
      return { tree: tokensOf(tree), context: contextWire(context) }
    }),
  built: () =>
    distinct(
      'encode',
      blockInputs('block', () => [
        ['', {}],
        ['dropRuby', { dropRuby: true }],
      ]),
    ),
})
add({
  fn: 'serializeNotation',
  ...noText,
  mutation: 'none',
  call: (input) => units(serializeNotation(argTree(input))),
  built: () => distinct('serialize', treeInputs('tree', false)),
})
add({
  fn: 'blockNotation',
  ...noText,
  mutation: 'text',
  call: (input) =>
    withBlock(input, (map, block) => {
      const options: NotationOptions =
        input.args!.dropRuby === undefined ? {} : { dropRuby: input.args!.dropRuby as boolean }
      const { text, context } = blockNotation(map, block, options)
      return { text: units(text), context: contextWire(context) }
    }),
  built: () =>
    distinct(
      'notation',
      blockInputs('block', () => [
        ['', {}],
        ['dropRuby', { dropRuby: true }],
        ['dropRuby false', { dropRuby: false }],
      ]),
    ),
})
add({
  fn: 'notationPlainText',
  ...noText,
  mutation: 'none',
  call: (input) => units(notationPlainText(argTree(input))),
  built: () => distinct('plain', treeInputs('tree', false)),
})
add({
  fn: 'blockPlainText',
  ...noText,
  mutation: 'text',
  call: (input) => withBlock(input, (map, block) => units(blockPlainText(map, block))),
  built: () =>
    distinct(
      'blockplain',
      blockInputs('block', () => [['', {}]]),
    ),
})
add({
  fn: 'checkNotation',
  ...noText,
  mutation: 'text',
  call: (input) => {
    const result = checkNotation(argText(input, 'text'), contextOf(input.args!.context))
    return result.ok ? { ok: true } : { ok: false, error: units(result.error) }
  },
  built: () => distinct('check', notationInputs('notation', true)),
})
add({
  fn: 'notationTreeToXhtml',
  ...noText,
  mutation: 'none',
  call: (input) => units(notationTreeToXhtml(argTree(input), contextOf(input.args!.context))),
  built: () => distinct('treexhtml', treeInputs('tree', true)),
})
add({
  fn: 'parseBlockNotation',
  ...noText,
  mutation: 'text',
  call: (input) => {
    const result = parseBlockNotation(argText(input, 'text'), contextOf(input.args!.context))
    return result.ok
      ? { ok: true, tree: tokensOf(result.tree) }
      : { ok: false, error: units(result.error) }
  },
  built: () => distinct('parse', notationInputs('notation', true)),
})
add({
  fn: 'notationToXhtml',
  ...noText,
  mutation: 'text',
  call: (input) => {
    const result = notationToXhtml(argText(input, 'text'), contextOf(input.args!.context))
    return result.ok
      ? { ok: true, xhtml: units(result.xhtml) }
      : { ok: false, error: units(result.error) }
  },
  built: () => distinct('toxhtml', notationInputs('notation', true)),
})
add({
  fn: 'newBlockNotationToXhtml',
  ...noText,
  mutation: 'text',
  call: (input) => {
    const result = newBlockNotationToXhtml(argText(input, 'text'))
    return result.ok
      ? { ok: true, xhtml: units(result.xhtml) }
      : { ok: false, error: units(result.error) }
  },
  built: () =>
    distinct('new', [
      ...NOTATIONS.map((text) => ({ label: JSON.stringify(text.slice(0, 40)), text })),
      ...LONE_NOTATIONS.map((text) => ({
        label: `lone ${JSON.stringify(text)}`,
        args: { text: units(text) },
      })),
    ]),
})

// ---------------------------------------------------------------------------
// Marks

/** A random notation tree with originals numbered in order, placeholders numbered 1, 2, ... */
function randomTree(random: () => number, size: number): NotationNode[] {
  let placeholder = 0
  let bold = 0
  let italic = 0
  const letters = ['a', 'b', 'c', 'd', ' ', '\u00E9', ASTRAL, HIGH, LOW, '<', '&']
  const nodes = (budget: number, depth: number): NotationNode[] => {
    const out: NotationNode[] = []
    for (let n = 1 + Math.floor(random() * 3); n > 0 && budget > 0; n--, budget--) {
      const kind = random()
      if (kind < 0.4 || depth > 3) {
        const v = Array.from({ length: 1 + Math.floor(random() * 5) }, () =>
          pick(random, letters),
        ).join('')
        const last = out[out.length - 1]
        if (last && last.t === 'text') last.v += v
        else out.push({ t: 'text', v })
      } else if (kind < 0.55) out.push({ t: 'br', orig: random() < 0.8 ? 0 : null })
      else if (kind < 0.8) {
        const t = random() < 0.5 ? 'b' : 'i'
        const orig = random() < 0.7 ? (t === 'b' ? bold++ : italic++) : null
        out.push({ t, orig, c: nodes(budget - 1, depth + 1) })
      } else if (kind < 0.9) out.push({ t: 'x', n: ++placeholder, c: null })
      else out.push({ t: 'x', n: ++placeholder, c: nodes(budget - 1, depth + 1) })
    }
    return out
  }
  return nodes(size, 0)
}
const ODD_OFFSETS = [NaN, Infinity, -Infinity, -0, -1, 0.5, 1.5, -0.5, 1e21, 2 ** 53]

add({
  fn: 'toggleMarkInTree',
  ...noText,
  mutation: 'none',
  call: (input) => {
    const args = input.args!
    const toggled = toggleMarkInTree(
      treeOf(args.tree),
      args.mark as 'b' | 'i',
      readNumber(args.start),
      readNumber(args.end),
    )
    return toggled === null ? null : tokensOf(toggled)
  },
  built: () => {
    const inputs: Input[] = []
    const ranged = (
      label: string,
      tree: NotationNode[],
      plain: number,
      random: () => number,
    ): void => {
      const pairs: Array<[number, number]> = [
        [0, plain],
        [0, 1],
        [1, plain],
        [0, 0],
        [plain, plain],
        [1, plain - 1],
        [0, plain + 1],
        [-1, plain],
      ]
      for (let k = 0; k < 6; k++)
        pairs.push([Math.floor(random() * (plain + 2)), Math.floor(random() * (plain + 2))])
      if (random() < 0.5)
        pairs.push(
          [pick(random, ODD_OFFSETS), Math.floor(random() * (plain + 1))],
          [Math.floor(random() * (plain + 1)), pick(random, ODD_OFFSETS)],
        )
      for (const [start, end] of pairs) {
        for (const mark of random() < 0.5 ? ['b', 'i'] : ['i', 'b']) {
          inputs.push({
            label: `${label} ${mark} ${start},${end}`,
            args: { tree: tokensIn(tree), mark, start: wireNumber(start), end: wireNumber(end) },
          })
        }
      }
    }
    for (const [label, tree] of parsedTrees().filter(([l]) => !l.startsWith('deep ')))
      ranged(`parsed ${label}`, tree, notationPlainText(tree).length, mulberry32(label.length + 5))
    for (const [label, tokens] of OFFBEAT_TREES) {
      const tree = treeOf(tokens)
      ranged(`offbeat ${label}`, tree, notationPlainText(tree).length, mulberry32(label.length + 9))
    }
    for (const tree of generated(31, 260, (random) =>
      randomTree(random, 4 + Math.floor(random() * 8)),
    )) {
      const plain = notationPlainText(tree).length
      ranged(`random ${inputs.length}`, tree, plain, mulberry32(inputs.length))
    }
    for (const n of [100, 900, 20000])
      inputs.push({
        label: `deep ${n}`,
        args: { tree: DEEP_TOKENS(n), mark: 'i', start: 0, end: 1 },
      })
    // placeholders nested 100 deep around a character: the most the Rust side rebuilds
    inputs.push({
      label: 'deep 100 placeholders',
      args: {
        tree: [
          ...Array.from({ length: 100 }, (_, i): Json => ['xo', i + 1]),
          ['t', units('abc')],
          ...Array.from({ length: 100 }, (): Json => ['c']),
        ],
        mark: 'b',
        start: 1,
        end: 2,
      },
    })
    return distinct('toggle', inputs)
  },
})

// ---------------------------------------------------------------------------
// Edits

function editsOf(map: OpenChapter, block: ChapterBlock, random: () => number): BlockEdit[] {
  const id = block.id
  const length = plainLength(map, block)
  const { text, context } = notationOf(map, block)
  const offsets = [0, 1, Math.floor(length / 2), length, length + 1, -1, 1.5, NaN].filter(
    (o, i, all) => all.indexOf(o) === i,
  )
  const edits: BlockEdit[] = [
    { op: 'replace', blockId: id, text },
    { op: 'replace', blockId: id, text: `${text} X` },
    { op: 'replace', blockId: id, text: 'new text' },
    { op: 'replace', blockId: id, text: '' },
    { op: 'replace', blockId: id, text: `<b>${text}</b>` },
    { op: 'replace', blockId: id, text: `${text}<q>`, dropRuby: true },
    { op: 'replace', blockId: id, text: notationOf(map, block, true).text, dropRuby: true },
    { op: 'replace', blockId: id, text, dropRuby: false },
    { op: 'insert_after', blockId: id, text: 'inserted <b>bold</b> &amp; <br/> text' },
    { op: 'insert_after', blockId: id, text: '' },
    { op: 'insert_after', blockId: id, text: '<x1/>' },
    { op: 'insert_after', blockId: id, text: '<q>' },
    { op: 'delete', blockId: id },
    { op: 'merge', blockId: id, with: 'previous' },
    { op: 'merge', blockId: id, with: 'next' },
  ]
  if (context.placeholders.length > 0)
    edits.push(
      { op: 'replace', blockId: id, text: text.replace(/<x1/, '<x2') },
      { op: 'replace', blockId: id, text: text.replace(/<x1[^>]*>/, '') },
    )
  for (const offset of offsets) {
    edits.push({ op: 'split', blockId: id, offset }, { op: 'line_break', blockId: id, offset })
  }
  for (const [start, end] of [
    [0, length],
    [0, 1],
    [1, length],
    [Math.floor(length / 3), Math.floor((2 * length) / 3)],
    [0, 0],
    [length, length],
    [0, length + 1],
    [-1, 1],
    [2, 1],
    [0.5, 1],
  ] as const) {
    edits.push(
      { op: 'toggle_mark', blockId: id, mark: 'bold', start, end },
      { op: 'toggle_mark', blockId: id, mark: 'italic', start, end },
    )
  }
  edits.push(
    { op: 'toggle_mark', blockId: id, mark: 'bold', start: NaN, end: 1 },
    { op: 'toggle_mark', blockId: id, mark: 'bold', start: 0, end: Infinity },
  )
  // a third of them, so that the population stays the size of a few thousand inputs
  return edits.filter(() => random() < 0.45)
}

function editInputs(name: string): Input[] {
  const inputs: Input[] = []
  const random = mulberry32(77)
  for (const [label, source] of CHAPTERS.concat([HOSTILE[12]!, HOSTILE[18]!])) {
    const map = tryMap(source)
    if (!map) continue
    const step = Math.max(1, Math.ceil(map.blocks.length / 7))
    for (let i = 0; i < map.blocks.length; i += step) {
      for (const edit of editsOf(map, map.blocks[i]!, random)) {
        inputs.push({
          label: `${name} ${label} ${edit.op} ${map.blocks[i]!.id}`,
          text: source,
          args: { edit: editWire(edit) },
        })
      }
    }
  }
  for (const [label, source] of [
    ['unclosed', HOSTILE[3]![1]],
    ['empty', ''],
  ] as const) {
    inputs.push({
      label: `${name} ${label}`,
      text: source,
      args: { edit: editWire({ op: 'delete', blockId: 'b1' }) },
    })
  }
  inputs.push({
    label: `${name} unknown`,
    text: PROSE,
    args: { edit: editWire({ op: 'delete', blockId: 'b404' }) },
  })
  inputs.push({
    label: `${name} unknown with lone`,
    text: PROSE,
    args: { edit: editWire({ op: 'split', blockId: `x${HIGH}`, offset: 0 }) },
  })
  return inputs
}
const openOrWire = (input: Input, f: (map: OpenChapter) => Json): Json => {
  const map = openChapter(argSource(input))
  return map.broken ? chapterWire(map) : f(map)
}

add({
  fn: 'blockEditReplacements',
  ...noText,
  mutation: 'text',
  call: (input) =>
    openOrWire(input, (map) => {
      const result = blockEditReplacements(map, editOf(input.args!.edit))
      return result.ok
        ? { ok: true, replacements: replacementsWire(result.replacements) }
        : { ok: false, refusal: refusalWire(result.refusal) }
    }),
  built: () => distinct('replacements', editInputs('edit')),
})
add({
  fn: 'applyBlockEdit',
  ...noText,
  mutation: 'text',
  call: (input) =>
    openOrWire(input, (map) => {
      const result = applyBlockEdit(map, editOf(input.args!.edit))
      return result.ok
        ? {
            ok: true,
            map: chapterWire(result.map),
            replacements: replacementsWire(result.replacements),
            created: result.created,
          }
        : { ok: false, refusal: refusalWire(result.refusal) }
    }),
  built: () => distinct('apply', editInputs('edit')),
})
add({
  fn: 'applyBlockEdits',
  ...noText,
  mutation: 'text',
  call: (input) =>
    openOrWire(input, (map) => {
      const result = applyBlockEdits(map, (input.args!.edits as unknown[]).map(editOf))
      return result.ok
        ? {
            ok: true,
            map: chapterWire(result.map),
            replacements: replacementsWire(result.replacements),
            created: result.created,
          }
        : { ok: false, index: result.index, refusal: refusalWire(result.refusal) }
    }),
  built: () => {
    const inputs: Input[] = []
    const random = mulberry32(88)
    for (const [label, source] of CHAPTERS.concat([HOSTILE[18]!])) {
      const map = tryMap(source)
      if (!map || map.blocks.length === 0) continue
      const ids = () => `b${1 + Math.floor(random() * (map.blocks.length + 2))}`
      for (let k = 0; k < 14; k++) {
        const edits: BlockEdit[] = []
        for (let n = 1 + Math.floor(random() * 4); n > 0; n--) {
          const id = ids()
          edits.push(
            pick<BlockEdit>(random, [
              { op: 'split', blockId: id, offset: Math.floor(random() * 6) },
              { op: 'line_break', blockId: id, offset: Math.floor(random() * 4) },
              { op: 'delete', blockId: id },
              { op: 'merge', blockId: id, with: random() < 0.5 ? 'next' : 'previous' },
              { op: 'insert_after', blockId: id, text: `n${n} <i>it</i>` },
              { op: 'replace', blockId: id, text: `r${n}` },
              {
                op: 'toggle_mark',
                blockId: id,
                mark: random() < 0.5 ? 'bold' : 'italic',
                start: 0,
                end: 1 + Math.floor(random() * 3),
              },
            ]),
          )
        }
        inputs.push({
          label: `edits ${label} ${k}`,
          text: source,
          args: { edits: edits.map(editWire) },
        })
      }
    }
    inputs.push(
      { label: 'edits none', text: PROSE, args: { edits: [] } },
      {
        label: 'edits noop',
        text: PROSE,
        args: { edits: [editWire({ op: 'insert_after', blockId: 'b1', text: '<x1/>' })] },
      },
    )
    return distinct('applyedits', inputs)
  },
})

// ---------------------------------------------------------------------------
// translate/output-markup.ts

const MARKUPS: string[] = [
  '<a href="x" id="i">t</a>',
  `<p id='a' class="b">x<span xml:id="c"/>y</p>`,
  '<br/><hr />',
  '<!-- <p id="c"> --><p id="d"/>',
  '<![CDATA[<p id="x">]]><p id="y">',
  '<?pi <p id="z">?>',
  '</p id="q">',
  '<!DOCTYPE x>',
  '<p id="a" id="b">',
  '<p ID="a">',
  'text < no tag',
  '<p id=a>',
  '<p id="a>',
  '<>',
  '< p id="a">',
  '<p\tid\n=\r"a"  class = \'b\'\u00A0>',
  '<p id="a"class="b">',
  '<p id=">" class="c>">x</p>',
  '<p/',
  '<p',
  '<',
  '',
  'plain text',
  '<!-- unterminated <p id="a">',
  '<![CDATA[ unterminated <p id="a">',
  '<? unterminated <p id="a">',
  '<p data-id="1" id="2" xml:id="3" xml:ID="4" ID="5">',
  '<a b="1" c=\'2\' d = "3" e= \'4\' />',
  '<a\u2028b="1">',
  '<\u00A0a>',
  '<a b="1" =x>',
  '<a "x">',
  `<p title="${ASTRAL}" id="a">`,
  '<<p id="a">',
  '<p id="a"><p id="b"/></p><p id="c">',
  '</>',
  '<!>x',
  '<!-->x-->y',
  '<!--->',
  '<?>x?>',
  '<p\nid="a"\n/>',
  '<p id="a"/ >',
  '<p id="a" / >',
  '<p / id="a">',
  '<a b="1"c="2"/>',
  '<p id="">',
  "<p id=''>",
  '<p id=" ">',
  '<a b="&amp;" c="&lt;"/>',
  '<a b="x\ny" c="z"/>',
]
const LONE_MARKUPS: string[] = [
  '<p id="a">\uD800</p>',
  '<p \uD800="1" id="b">',
  '<p id="\uDC00">',
  `<p id="a">${HIGH}`,
  '<\uD800>',
  '<p id="a" \uD800>x',
]
const markupInputs = (name: string): Input[] => [
  ...MARKUPS.map((text) => ({ label: `${name} ${JSON.stringify(text.slice(0, 40))}`, text })),
  ...LONE_MARKUPS.map((text) => ({
    label: `${name} lone ${JSON.stringify(text)}`,
    args: { markup: units(text) },
  })),
]
const markupOf = (input: Input): string => argText(input, 'markup')

const tagList = (): Array<[string, StartTag]> => {
  const out: Array<[string, StartTag]> = []
  for (const markup of MARKUPS) {
    for (
      let at = markup.indexOf('<');
      at >= 0 && at < markup.length;
      at = markup.indexOf('<', at + 1)
    ) {
      const read = readStartTag(markup, at)
      if (read) out.push([`${JSON.stringify(markup.slice(at, at + 30))}`, read.tag])
    }
  }
  out.push([
    'no lead',
    {
      name: 'p',
      attributes: [
        { name: 'a', raw: 'a="1"', value: '1' },
        { name: 'b', raw: ' b="2"', value: '2' },
      ],
      tail: '>',
    },
  ])
  out.push(['empty', { name: '', attributes: [], tail: '' }])
  out.push([
    'lone',
    {
      name: '\uD800',
      attributes: [{ name: '\uDC00', raw: ' \uDC00="x"', value: 'x' }],
      tail: '/>',
    },
  ])
  return out
}
const NAMES = ['id', 'xml:id', 'class', 'a', 'b', 'c', 'href', 'ID', '', 'data-id', 'x y']

add({
  fn: 'readStartTag',
  ...noText,
  mutation: 'text',
  call: (input) => {
    const markup = markupOf(input)
    const read =
      input.args?.at === undefined
        ? readStartTag(markup)
        : readStartTag(markup, readNumber(input.args.at))
    return read ? { tag: tagWire(read.tag), end: read.end } : null
  },
  built: () => {
    const inputs = markupInputs('markup')
    for (const markup of MARKUPS) {
      for (const at of [
        markup.indexOf('<', 1),
        1,
        -1,
        1.5,
        NaN,
        Infinity,
        markup.length,
        markup.length + 1,
      ]) {
        inputs.push({
          label: `at ${String(at)} ${JSON.stringify(markup.slice(0, 30))}`,
          text: markup,
          args: { at: wireNumber(at) },
        })
      }
    }
    return distinct('readtag', inputs)
  },
})
add({
  fn: 'writeStartTag',
  ...noText,
  mutation: 'none',
  call: (input) => units(writeStartTag(tagOf(input.args!.tag))),
  built: () =>
    distinct(
      'writetag',
      tagList().map(([label, tag]) => ({ label, args: { tag: tagWire(tag) } })),
    ),
})
add({
  fn: 'escapeAttribute',
  ...noText,
  mutation: 'text',
  call: (input) => units(escapeAttribute(argText(input, 'value'))),
  built: () =>
    distinct('escapeattr', [
      ...NOTATIONS.slice(0, 40).map((text) => ({ label: JSON.stringify(text), text })),
      { label: 'quotes', text: 'a"b\'c<d>e&f' },
      { label: 'lone', args: { value: units('a\uD800"') } },
    ]),
})
add({
  fn: 'tagAttribute',
  ...noText,
  mutation: 'none',
  call: (input) => {
    const value = tagAttribute(tagOf(input.args!.tag), fromUnits(input.args!.name))
    return value === undefined ? null : units(value)
  },
  built: () =>
    distinct(
      'tagattr',
      tagList().flatMap(([label, tag]) =>
        NAMES.map((name) => ({
          label: `${label} ${name}`,
          args: { tag: tagWire(tag), name: units(name) },
        })),
      ),
    ),
})
add({
  fn: 'setTagAttribute',
  ...noText,
  mutation: 'none',
  call: (input) => {
    const tag = tagOf(input.args!.tag)
    setTagAttribute(tag, fromUnits(input.args!.name), fromUnits(input.args!.escaped))
    return tagWire(tag)
  },
  built: () =>
    distinct(
      'settag',
      tagList().flatMap(([label, tag]) =>
        ['id', 'class', 'new', 'a'].map((name) => ({
          label: `${label} ${name}`,
          args: { tag: tagWire(tag), name: units(name), escaped: units('v&amp;"') },
        })),
      ),
    ),
})
add({
  fn: 'removeTagAttributes',
  ...noText,
  mutation: 'none',
  call: (input) => {
    const tag = tagOf(input.args!.tag)
    removeTagAttributes(tag, new Set((input.args!.names as number[][]).map(fromUnits)))
    return tagWire(tag)
  },
  built: () =>
    distinct(
      'removetag',
      tagList().flatMap(([label, tag]) =>
        [['id', 'xml:id'], ['a'], [], ['b', 'c', 'zzz']].map((names) => ({
          label: `${label} ${names.join(',')}`,
          args: { tag: tagWire(tag), names: names.map(units) },
        })),
      ),
    ),
})
add({
  fn: 'removeIds',
  ...noText,
  mutation: 'text',
  call: (input) => units(removeIds(markupOf(input))),
  built: () =>
    distinct('removeids', [
      ...markupInputs('markup'),
      ...CHAPTERS.map(([label, source]) => ({ label: `chapter ${label}`, text: source })),
      { label: 'long', text: '<p id="a">x</p>'.repeat(300) },
      { label: 'long comment', text: `<!--${'-'.repeat(5000)} <p id="a">` },
    ]),
})
add({
  fn: 'prefixOf',
  ...noText,
  mutation: 'none',
  call: ({ args = {} }) => prefixOf(args.name as string),
  built: () =>
    distinct(
      'prefix',
      ['dc:title', 'title', ':x', 'a:b:c', '', 'xml:id', 'epub:type', 'é:é', ':'].map((name) => ({
        label: JSON.stringify(name),
        args: { name },
      })),
    ),
})
add({
  fn: 'whitespaceStart',
  ...noText,
  mutation: 'text',
  call: (input) => whitespaceStart(argSource(input), readNumber(input.args!.offset)),
  built: () =>
    distinct(
      'wsstart',
      ['', 'abc', '  a  b \t\r\n  ', '\n\n\n', 'a\u00A0 b', `a${ASTRAL}  `, '   '].flatMap((text) =>
        [0, 1, 2, 3, 5, text.length]
          .filter((o) => o <= text.length)
          .map((offset) => ({
            label: `${JSON.stringify(text)} ${offset}`,
            text,
            args: { offset },
          })),
      ),
    ),
})

// The functions over one element of a parsed chapter: the case names the element by its place in document order.
const withElement = (
  input: Input,
  f: (source: string, el: XmlElement, order: XmlElement[]) => Json,
): Json => {
  const source = argSource(input)
  const parsed = parseXml(source)
  if (!parsed.ok) return { ok: false, error: parsed.error, offset: parsed.offset }
  const order = [...walkElements(parsed.doc.root)]
  const el = order[input.args!.element as number]
  return el === undefined ? null : f(source, el, order)
}
const refs = (list: readonly XmlElement[], order: readonly XmlElement[]): Json =>
  list.map((e) => {
    const at = order.indexOf(e)
    return at < 0 ? null : at
  })
function elementInputs(
  name: string,
  extra: Array<[string, Record<string, unknown>]>,
  sources = CHAPTERS,
): Input[] {
  const inputs: Input[] = []
  for (const [label, source] of sources) {
    const parsed = parseXml(source)
    const count = parsed.ok ? [...walkElements(parsed.doc.root)].length : 0
    const places = [
      ...new Set([
        0,
        1,
        2,
        3,
        Math.floor(count / 3),
        Math.floor(count / 2),
        count - 2,
        count - 1,
        count,
      ]),
    ].filter((k) => k >= 0)
    for (const element of places)
      for (const [what, args] of extra)
        inputs.push({
          label: `${name} ${label} #${element}${what ? ` ${what}` : ''}`,
          text: source,
          args: { element, ...args },
        })
  }
  inputs.push({
    label: `${name} unclosed`,
    text: HOSTILE[3]![1],
    args: { element: 0, ...extra[0]![1] },
  })
  return inputs
}
const NONE: Array<[string, Record<string, unknown>]> = [['', {}]]

add({
  fn: 'childElements',
  ...noText,
  mutation: 'text',
  call: (input) => withElement(input, (_s, el, order) => refs(childElements(el), order)),
  built: () => distinct('children', elementInputs('el', NONE)),
})
add({
  fn: 'walkElements',
  ...noText,
  mutation: 'text',
  call: (input) => withElement(input, (_s, el, order) => refs([...walkElements(el)], order)),
  built: () =>
    distinct('walk', [
      ...elementInputs('el', NONE),
      ...[500, 20000].map((n) => ({ label: `deep ${n}`, text: deepDivs(n), args: { element: 0 } })),
    ]),
})
add({
  fn: 'attributeOf',
  ...noText,
  mutation: 'text',
  call: (input) =>
    withElement(input, (_s, el) => attributeOf(el, input.args!.name as string) ?? null),
  built: () =>
    distinct(
      'attrof',
      elementInputs(
        'el',
        ['id', 'class', 'href', 'xmlns', 'xmlns:epub', 'xml:id', 'title', 'src', 'nope', ''].map(
          (name) => [name, { name }],
        ),
      ),
    ),
})
add({
  fn: 'localIs',
  ...noText,
  mutation: 'text',
  call: (input) => withElement(input, (_s, el) => localIs(el, input.args!.local as string)),
  built: () =>
    distinct(
      'localis',
      elementInputs(
        'el',
        ['p', 'P', 'span', 'body', 'html', 'div', 'b', 'x:p', 'li', 'b', ''].map((local) => [
          local,
          { local },
        ]),
      ),
    ),
})
add({
  fn: 'namespaceOf',
  ...noText,
  mutation: 'text',
  call: (input) => withElement(input, (_s, el) => namespaceOf(el, input.args!.prefix as string)),
  built: () =>
    distinct(
      'nsof',
      elementInputs(
        'el',
        ['', 'epub', 'x', 'xml', 'nope'].map((prefix) => [prefix, { prefix }]),
      ),
    ),
})
add({
  fn: 'elementText',
  ...noText,
  mutation: 'text',
  call: (input) =>
    withElement(input, (_s, el) => units(elementText(el, new Set(input.args!.skip as string[])))),
  built: () =>
    distinct('eltext', [
      ...elementInputs(
        'el',
        [[], ['rt', 'rp'], ['b'], ['script', 'style'], ['p', 'div', 'body']].map((skip) => [
          skip.join(','),
          { skip },
        ]),
      ),
      ...[300, 20000].map((n) => ({
        label: `deep ${n}`,
        text: deepSpans(n),
        args: { element: 2, skip: [] },
      })),
    ]),
})
const CHANGES: Array<[string, Array<Record<string, unknown>>]> = [
  ['none', []],
  ['set class', [{ op: 'set', name: units('class'), escaped: units('z') }]],
  ['set id', [{ op: 'set', name: units('id'), escaped: units('q&amp;') }]],
  ['remove ids', [{ op: 'remove', names: [units('id'), units('xml:id')] }]],
  ['tail', [{ op: 'tail', value: units('/>') }]],
  [
    'mixed',
    [
      { op: 'set', name: units('a'), escaped: units('1') },
      { op: 'set', name: units('a'), escaped: units('2') },
      { op: 'remove', names: [units('class')] },
    ],
  ],
]
add({
  fn: 'startTagReplacement',
  ...noText,
  mutation: 'text',
  call: (input) =>
    withElement(input, (source, el) => {
      const replacement = startTagReplacement(source, el, (tag) => {
        for (const change of input.args!.changes as Array<Record<string, unknown>>) {
          if (change.op === 'set')
            setTagAttribute(tag, fromUnits(change.name), fromUnits(change.escaped))
          else if (change.op === 'remove')
            removeTagAttributes(tag, new Set((change.names as number[][]).map(fromUnits)))
          else tag.tail = fromUnits(change.value)
        }
      })
      return replacement === null ? null : replacementWire(replacement)
    }),
  built: () =>
    distinct(
      'starttag',
      elementInputs(
        'el',
        CHANGES.map(([what, changes]) => [what, { changes }]),
      ),
    ),
})
add({
  fn: 'elementTextReplacement',
  ...noText,
  mutation: 'text',
  call: (input) =>
    withElement(input, (source, el) =>
      replacementWire(elementTextReplacement(source, el, fromUnits(input.args!.escaped))),
    ),
  built: () =>
    distinct(
      'textrepl',
      elementInputs(
        'el',
        ['x', '', '&lt;a&amp;b', 'é'].map((escaped) => [escaped, { escaped: units(escaped) }]),
      ),
    ),
})
add({
  fn: 'insertionAfter',
  ...noText,
  mutation: 'text',
  call: (input) =>
    withElement(input, (source, el) =>
      replacementWire(insertionAfter(source, el, fromUnits(input.args!.markup))),
    ),
  built: () =>
    distinct(
      'insafter',
      elementInputs(
        'el',
        ['<p>n</p>', '', '<b/>'].map((markup) => [markup, { markup: units(markup) }]),
      ),
    ),
})

// ---------------------------------------------------------------------------
// translate/: prompt, language, keys, units, migrate

const LANGS = [
  'zh',
  'en',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'th',
  'id',
  'ru',
  'ar',
  'pt',
  'it',
  'pl',
  'cs',
  'nl',
  'ms',
  'he',
  'hi',
  'zh-TW',
  'vi',
]
const ODD_LANGS = [
  'xx',
  'zh-Hant',
  '',
  'EN',
  'ko-KR',
  'x"y',
  `${ASTRAL}`,
  '</document_blocks>',
  'zh_TW',
]
const MODES: Array<[string, string | undefined]> = [
  ['translate', 'translate'],
  ['easy', 'easy'],
  ['default', undefined],
  ['other', 'other'],
]
const modeArgs = (mode: string | undefined): Record<string, unknown> =>
  mode === undefined ? {} : { mode }
const asMode = (args: Record<string, unknown>): TranslationMode | undefined =>
  args.mode as TranslationMode | undefined

add({
  fn: 'epubTranslationSystemPrompt',
  ...noText,
  mutation: 'none',
  call: ({ args = {} }) =>
    asMode(args) === undefined
      ? epubTranslationSystemPrompt(args.lang as string)
      : epubTranslationSystemPrompt(args.lang as string, asMode(args)),
  built: () =>
    distinct(
      'prompt',
      [...LANGS, ...ODD_LANGS].flatMap((lang) =>
        MODES.map(([label, mode]) => ({
          label: `${JSON.stringify(lang)} ${label}`,
          args: { lang, ...modeArgs(mode) },
        })),
      ),
    ),
})
const REQUEST_BLOCKS: Array<[string, Array<[string, string]>]> = [
  ['none', []],
  ['one', [['1', 'Hello <b>world</b>']]],
  [
    'two',
    [
      ['1', 'a'],
      ['2', 'b <x1/> c'],
    ],
  ],
  ['closing', [['1', 'x </document_blocks> y']]],
  ['closing upper', [['1', 'x </DOCUMENT_BLOCKS and </Document_Blocks']]],
  ['kelvin', [['1', 'x </document_bloc\u212As> y']]],
  ['long s', [['1', 'x </document_block\u017F> y']]],
  ['quotes', [['1', 'say "hi"\\ and \'x\'\n\ttab\u0001\u001F\u007F']]],
  ['separators', [['1', 'a\u2028b\u2029c']]],
  [
    'lone',
    [
      ['1', 'a\uD800b'],
      ['2', '\uDC00'],
      ['\uD800', 'x'],
    ],
  ],
  ['astral', [['1', `${ASTRAL} \u{1F680}`]]],
  [
    'id odd',
    [
      ['', 'x'],
      ['</document_blocks>', 'y'],
    ],
  ],
  ['unicode', [['1', '\u00E9\u4E2D\uD55C']]],
]
add({
  fn: 'buildEpubTranslationRequest',
  ...noText,
  mutation: 'none',
  call: ({ args = {} }) => {
    const blocks = (args.blocks as Array<{ id: number[]; text: number[] }>).map((b) => ({
      id: fromUnits(b.id),
      text: fromUnits(b.text),
    }))
    return asMode(args) === undefined
      ? buildEpubTranslationRequest(args.lang as string, blocks)
      : buildEpubTranslationRequest(args.lang as string, blocks, asMode(args))
  },
  built: () =>
    distinct(
      'request',
      REQUEST_BLOCKS.flatMap(([label, blocks]) =>
        ['ko', 'en', 'xx', '</document_blocks>'].flatMap((lang) =>
          MODES.slice(0, 3).map(([mode, value]) => ({
            label: `${label} ${lang} ${mode}`,
            args: {
              lang,
              blocks: blocks.map(([id, text]) => ({ id: units(id), text: units(text) })),
              ...modeArgs(value),
            },
          })),
        ),
      ),
    ),
})

const SAMPLES: Array<[string, string]> = [
  ['none', ''],
  ['english', 'The quick brown fox jumps over the lazy dog. '.repeat(3)],
  ['thin', 'a b c'],
  ['19', 'a'.repeat(19)],
  ['20', 'a'.repeat(20)],
  ['french', 'Le renard brun saute par-dessus le chien paresseux. '],
  ['korean', '\uC548\uB155\uD558\uC138\uC694 \uC138\uACC4 '.repeat(4)],
  ['japanese', '\u3053\u3093\u306B\u3061\u306F\u4E16\u754C\u3067\u3059'.repeat(4)],
  ['han', '\u4F60\u597D\u4E16\u754C'.repeat(6)],
  ['kana boundary 0.1', `\u3042${'\u5B57'.repeat(9)}`.repeat(3)],
  ['kana below', `\u3042${'\u5B57'.repeat(10)}`.repeat(3)],
  ['han kana 1/10', `\u3042${'\u5B57'.repeat(9)}`],
  ['russian', '\u041F\u0440\u0438\u0432\u0435\u0442 \u043C\u0438\u0440 '.repeat(4)],
  [
    'greek',
    '\u0393\u03B5\u03B9\u03B1 \u03C3\u03BF\u03C5 \u03BA\u03CC\u03C3\u03BC\u03B5 '.repeat(3),
  ],
  [
    'arabic',
    '\u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645 '.repeat(3),
  ],
  ['hebrew', '\u05E9\u05DC\u05D5\u05DD \u05E2\u05D5\u05DC\u05DD '.repeat(3)],
  ['hindi', '\u0928\u092E\u0938\u094D\u0924\u0947 \u0926\u0941\u0928\u093F\u092F\u093E '.repeat(3)],
  [
    'bengali',
    '\u09A8\u09AE\u09B8\u09CD\u0995\u09BE\u09B0 \u09AC\u09BF\u09B6\u09CD\u09AC '.repeat(3),
  ],
  ['thai', '\u0E2A\u0E27\u0E31\u0E2A\u0E14\u0E35\u0E0A\u0E32\u0E27\u0E42\u0E25\u0E01'.repeat(3)],
  [
    'georgian',
    '\u10D2\u10D0\u10DB\u10D0\u10E0\u10EF\u10DD\u10D1\u10D0 \u10DB\u10E1\u10DD\u10E4\u10DA\u10D8\u10DD'.repeat(
      2,
    ),
  ],
  ['armenian', '\u0532\u0561\u0580\u0587 \u0531\u0577\u056D\u0561\u0580\u0570'.repeat(3)],
  ['ethiopic', '\u1230\u120B\u121D \u12D3\u1208\u121D '.repeat(3)],
  ['tie', `${'a'.repeat(20)}${'\u0431'.repeat(20)}`],
  ['tie 2', `${'\u0431'.repeat(20)}${'a'.repeat(20)}`],
  ['mixed latin cjk', `${'ab'.repeat(8)}\u4F60\u597D\u4E16\u754C\u4F60\u597D`],
  ['cut at 100000', `${'a'.repeat(99990)}${'\u0431'.repeat(100)}`],
  ['cut in a pair', `${'a'.repeat(99999)}${ASTRAL}${'\u0431'.repeat(30)}`],
  ['astral han', '\u{20000}'.repeat(12)],
  ['lone surrogates', '\uD800\uDC00'.repeat(3) + 'a'.repeat(10) + '\uD800'.repeat(30)],
  ['numbers', '1234567890'.repeat(5)],
  ['punctuation', '!?.,;:'.repeat(10)],
]
const randomScripts = (): Array<[string, string]> =>
  generated(51, 120, (random, i) => {
    let text = ''
    for (let n = 25 + Math.floor(random() * 60); n > 0; n--) {
      let code = Math.floor(random() * 0x30000)
      if (random() < 0.5)
        code =
          pick(
            random,
            [
              0x41, 0x61, 0xc0, 0x370, 0x400, 0x530, 0x590, 0x600, 0x900, 0x980, 0xa00, 0xa80,
              0xb80, 0xc00, 0xc80, 0xd00, 0xd80, 0xe00, 0xe80, 0x1000, 0x10a0, 0x1200, 0x3040,
              0x30a0, 0x4e00, 0xac00, 0x1100, 0x20000,
            ],
          ) + Math.floor(random() * 90)
      if (code >= 0xd800 && code <= 0xdfff) code = 0x61
      text += String.fromCodePoint(code)
    }
    return [`random ${i}`, text]
  })
add({
  fn: 'guessLanguageFromText',
  ...noText,
  mutation: 'text',
  call: (input) => guessLanguageFromText(argText(input, 'text')) ?? null,
  built: () =>
    distinct(
      'guess',
      [...SAMPLES, ...randomScripts()].map(([label, text]) =>
        /[\uD800-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))
          ? { label, args: { text: units(text) } }
          : { label, text },
      ),
    ),
})
const UI_LANGS = [
  'en',
  'ko',
  'zh',
  'zh-TW',
  'zh-CN',
  'zh-Hant',
  'zh_HK',
  'ja-JP',
  'in',
  'in-ID',
  'iw',
  'iw-IL',
  'xx',
  '',
  ' ko ',
  'KO',
  'Zh_tw',
  'pt-BR',
  'it_IT',
  'inx',
  'iwx',
  'en-US',
  'fr',
  'he',
  'id',
  'ms-MY',
  'vi-VN',
]
const LOCALE_VALUES: Array<string | null | undefined> = [
  ...UI_LANGS,
  ...LANGS,
  '  \u00A0zh-TW\uFEFF',
  'ZH-HANT-TW',
  'z',
  'zh-',
  'zh-x',
  'in\u00E9',
  'in-',
  'in_x',
  'iw\u00E9',
  'zh\u212A',
  '\u0130N',
  null,
  undefined,
]
// the one UI language besides English is Korean: its spellings, and what only looks like it
const KOREAN_VALUES = [
  'ko',
  'KO',
  'Ko',
  ' ko ',
  '\u00A0ko\uFEFF',
  'ko-KR',
  'ko_KR',
  'KO_kr',
  'ko-',
  'ko_',
  'ko-Hang-KR',
  'kor',
  'korean',
  'k',
  'ko\u00E9',
  'ko KR',
  'kok',
  'ko.KR',
  'ko\u212A',
  '\u212Ao',
  '\u0131ko',
  'x-ko',
  ' ',
  '\n',
]
add({
  fn: 'normalizeLang',
  ...noText,
  mutation: 'none',
  call: ({ args = {} }) => normalizeLang(args.value as string | null | undefined),
  built: () =>
    distinct(
      'normalize',
      [...LOCALE_VALUES, ...KOREAN_VALUES].map((value) => ({
        label: JSON.stringify(value) ?? 'undefined',
        args: value === undefined ? {} : { value },
      })),
    ),
})
add({
  fn: 'translationLanguageOf',
  ...noText,
  mutation: 'none',
  call: ({ args = {} }) => translationLanguageOf(args.value as string | null | undefined),
  built: () =>
    distinct(
      'tlangof',
      [...LOCALE_VALUES, ...KOREAN_VALUES].map((value) => ({
        label: JSON.stringify(value) ?? 'undefined',
        args: value === undefined ? {} : { value },
      })),
    ),
})
add({
  fn: 'translationLanguageName',
  ...noText,
  mutation: 'none',
  call: ({ args = {} }) => translationLanguageName(args.code as string),
  built: () =>
    distinct(
      'langname',
      [...LANGS, ...ODD_LANGS, 'toString', 'constructor', '__proto__'].map((code) => ({
        label: JSON.stringify(code),
        args: { code },
      })),
    ),
})
add({
  fn: 'translationStyleLines',
  ...noText,
  mutation: 'none',
  call: ({ args = {} }) => translationStyleLines(args.lang as string),
  built: () =>
    distinct(
      'style',
      [...LANGS, ...ODD_LANGS].map((lang) => ({ label: JSON.stringify(lang), args: { lang } })),
    ),
})
add({
  fn: 'easyStyleLines',
  ...noText,
  mutation: 'none',
  call: ({ args = {} }) => easyStyleLines(args.lang as string),
  built: () =>
    distinct(
      'easystyle',
      [...LANGS, ...ODD_LANGS].map((lang) => ({ label: JSON.stringify(lang), args: { lang } })),
    ),
})
add({
  fn: 'defaultTargetLanguage',
  ...noText,
  mutation: 'text',
  call: (input) =>
    asMode(input.args!) === undefined
      ? defaultTargetLanguage(input.args!.uiLanguage as string, argText(input, 'documentText'))
      : defaultTargetLanguage(
          input.args!.uiLanguage as string,
          argText(input, 'documentText'),
          asMode(input.args!),
        ),
  built: () =>
    distinct(
      'target',
      SAMPLES.slice(0, 14).flatMap(([label, text]) =>
        ['en', 'ko', 'zh', 'zh-TW', 'ja', 'xx', 'ru', 'fr', ''].flatMap((uiLanguage) =>
          MODES.slice(0, 3).map(([mode, value]) => ({
            label: `${label} ${uiLanguage} ${mode}`,
            text,
            args: { uiLanguage, ...modeArgs(value) },
          })),
        ),
      ),
    ),
})
const BOOK_LANGUAGES: string[][] = [
  [],
  [''],
  [' '],
  ['und'],
  [' und '],
  ['und-Latn'],
  ['UND_x'],
  ['en'],
  ['en-US'],
  [' fr_CA '],
  ['', 'und', 'de'],
  ['zh-Hant', 'en'],
  ['\u00A0ja\uFEFF'],
  ['Ko'],
  ['en', 'fr'],
  ['unda'],
]
add({
  fn: 'epubBookLanguage',
  ...noText,
  mutation: 'text',
  call: (input) =>
    epubBookLanguage(input.args!.languages as string[], argText(input, 'sampleText')) ?? null,
  built: () =>
    distinct(
      'booklang',
      BOOK_LANGUAGES.flatMap((languages) =>
        [
          ['english', SAMPLES[1]![1]],
          ['korean', SAMPLES[6]![1]],
          ['none', ''],
          ['thin', 'a b'],
        ].map(([label, text]) => ({
          label: `${JSON.stringify(languages)} ${label}`,
          text: text!,
          args: { languages },
        })),
      ),
    ),
})
add({
  fn: 'defaultEpubTargetLanguage',
  ...noText,
  mutation: 'text',
  call: (input) =>
    asMode(input.args!) === undefined
      ? defaultEpubTargetLanguage(
          input.args!.uiLanguage as string,
          input.args!.languages as string[],
          argText(input, 'sampleText'),
        )
      : defaultEpubTargetLanguage(
          input.args!.uiLanguage as string,
          input.args!.languages as string[],
          argText(input, 'sampleText'),
          asMode(input.args!),
        ),
  built: () =>
    distinct(
      'epubtarget',
      BOOK_LANGUAGES.slice(0, 12).flatMap((languages) =>
        ['en', 'ko', 'zh-TW', 'fr', 'xx', 'ja-JP'].flatMap((uiLanguage) =>
          MODES.slice(0, 3).flatMap(([mode, value]) =>
            [
              ['english', SAMPLES[1]![1]],
              ['korean', SAMPLES[6]![1]],
              ['none', ''],
            ].map(([label, text]) => ({
              label: `${JSON.stringify(languages)} ${uiLanguage} ${mode} ${label}`,
              text: text!,
              args: { uiLanguage, languages, ...modeArgs(value) },
            })),
          ),
        ),
      ),
    ),
})
const sampleUnits = (spec: Array<[number, number]>): Input => ({
  label: JSON.stringify(spec.map(([p, n]) => `${p}:${n}`)).slice(0, 80),
  args: {
    units: spec.map(([page, length], i) => ({
      page: wireNumber(page),
      plainText: units(String.fromCharCode(97 + (i % 26)).repeat(length)),
    })),
  },
})
add({
  fn: 'epubSampleText',
  ...noText,
  mutation: 'none',
  call: ({ args = {} }) => {
    const list = (args.units as Array<{ page: WireNumber; plainText: number[] }>).map((u) => ({
      page: readNumber(u.page),
      plainText: fromUnits(u.plainText),
    }))
    return units(epubSampleText(list as unknown as EpubTranslationUnit[]))
  },
  built: () =>
    distinct(
      'sample',
      [
        [],
        [[0, 5]],
        [
          [-1, 5],
          [0, 3],
        ],
        [
          [0, 5],
          [-1, 4],
          [2, 6],
        ],
        [
          [0, 50000],
          [1, 49999],
          [2, 10],
        ],
        [
          [0, 50000],
          [1, 49998],
          [2, 10],
        ],
        [
          [0, 99999],
          [1, 5],
        ],
        [
          [0, 100000],
          [1, 5],
        ],
        [
          [0, 0],
          [0, 0],
        ],
        [
          [1, 99998],
          [2, 0],
          [3, 7],
        ],
        [
          [-1, 200000],
          [0, 4],
        ],
        [
          [NaN, 3],
          [Infinity, 2],
        ],
        [[0.5, 4]],
        [[-0, 4]],
      ]
        .map((spec) => sampleUnits(spec as Array<[number, number]>))
        .concat([
          {
            label: 'lone',
            args: {
              units: [
                { page: 0, plainText: [0xd800, 0x61] },
                { page: 1, plainText: [0xdc00] },
              ],
            },
          },
        ]),
    ),
})

const PATHS = [
  'OEBPS/ch1.xhtml',
  'ch1.xhtml',
  '',
  'a/b c/\u00E9.xhtml',
  `x/${ASTRAL}.xhtml`,
  'OEBPS/Ch1.xhtml',
  'OEBPS\\ch1.xhtml',
  'a\uD800b',
  'OEBPS/\u4E2D\u6587.xhtml',
]
add({
  fn: 'epubChapterFingerprint',
  ...noText,
  mutation: 'text',
  call: (input) => epubChapterFingerprint(argText(input, 'path')),
  built: () =>
    distinct('fingerprint', [
      ...PATHS.filter((p) => !/[\uD800-\uDFFF]/.test(p) || p === `x/${ASTRAL}.xhtml`).map(
        (text) => ({ label: JSON.stringify(text), text }),
      ),
      { label: 'lone', args: { path: units('a\uD800b') } },
      { label: 'lone low', args: { path: units('\uDC00') } },
    ]),
})
const RUN_TEXTS = [
  '',
  'abc',
  'a  b\t\n c',
  '  lead and trail  ',
  'e\u0301',
  '\u00E9',
  '\u1100\u1161',
  '\uAC00',
  '\u212B',
  '\u00C5',
  'A\u030A',
  '\u0041\u0308\u0301',
  '\u00A0nbsp\u00A0',
  '\uFEFFbom\uFEFF',
  '\u2028ls\u2029',
  'x\u0085y',
  '\uD800',
  'a\uD800\u0301',
  '\u0301\uDC00',
  ASTRAL,
  `${ASTRAL}\u0301`,
  '\u2126',
  '\u03A9',
  '\uFB01',
  '\u1E9B\u0323',
  '\u0958',
  'a\u200Bb',
  '\u3000full\u3000',
  'a\u0000b',
]
const runKinds = (text: string): InlineRun[] => [{ kind: 'text', text }]
add({
  fn: 'epubTranslationKeys',
  ...noText,
  mutation: 'none',
  call: ({ args = {} }) =>
    epubTranslationKeys(
      (args.units as Array<{ runs: unknown[]; pageFingerprint: string }>).map((u) => ({
        runs: u.runs.map(runOf),
        pageFingerprint: u.pageFingerprint,
      })),
    ),
  built: () => {
    const inputs: Input[] = []
    const unitOf = (runs: InlineRun[], pageFingerprint = 'fp') => ({
      runs: runs.map(runWire),
      pageFingerprint,
    })
    inputs.push({ label: 'none', args: { units: [] } })
    for (const text of RUN_TEXTS)
      inputs.push({ label: JSON.stringify(text), args: { units: [unitOf(runKinds(text))] } })
    inputs.push({
      label: 'repeats',
      args: {
        units: [
          unitOf(runKinds('a')),
          unitOf(runKinds(' a ')),
          unitOf(runKinds('a'), 'other'),
          unitOf(runKinds('a b')),
          unitOf(runKinds('a\u00A0b')),
          unitOf(runKinds('a')),
          unitOf(runKinds('\u00E9')),
          unitOf(runKinds('e\u0301')),
          unitOf(runKinds('e\u0301'), 'other'),
        ],
      },
    })
    inputs.push({
      label: 'kinds',
      args: {
        units: [
          unitOf([
            { kind: 'text', text: 'a', bold: true, italic: true, href: 'x' },
            { kind: 'footnoteRef', id: 'n1', marker: '3' },
            { kind: 'math', latex: '\\x' },
            { kind: 'lineBreak' },
            { kind: 'text', text: ' b ' },
          ]),
          unitOf([{ kind: 'footnoteRef', id: 'n1' }]),
          unitOf([]),
          unitOf([{ kind: 'lineBreak' }]),
          unitOf([
            { kind: 'text', text: '' },
            { kind: 'text', text: '' },
          ]),
          unitOf([{ kind: 'math', latex: 'a  b' }]),
        ],
      },
    })
    inputs.push({
      label: 'fingerprint with nul',
      args: {
        units: [
          unitOf(runKinds('a'), 'a\u0000b'),
          unitOf(runKinds('a'), 'a'),
          unitOf(runKinds('\u0000b'), 'a'),
        ],
      },
    })
    inputs.push({
      label: 'many',
      args: {
        units: Array.from({ length: 200 }, (_, i) =>
          unitOf(runKinds(`block ${i % 7}`), `fp${i % 3}`),
        ),
      },
    })
    return distinct('keys', inputs)
  },
})
add({
  fn: 'epubBlockKeyString',
  ...noText,
  mutation: 'none',
  call: ({ args = {} }) =>
    epubBlockKeyString(
      args.key as { pageFingerprint: string; textHash: string; occurrence: number },
    ),
  built: () =>
    distinct(
      'keystring',
      [
        ['a', 'b', 0],
        ['', '', 7],
        ['x:y', 'z:w', 12],
        ['\u00E9', `${ASTRAL}`, 1],
      ].map(([pageFingerprint, textHash, occurrence]) => ({
        label: JSON.stringify([pageFingerprint, occurrence]),
        args: { key: { pageFingerprint, textHash, occurrence } },
      })),
    ),
})
add({
  fn: 'epubDocumentHash',
  ...noText,
  mutation: 'none',
  call: async ({ bytes }) => epubDocumentHash(bytes ?? new Uint8Array()),
  built: () =>
    distinct(
      'dochash',
      [
        new Uint8Array(),
        new Uint8Array([0]),
        new Uint8Array([0x61, 0x62, 0x63]),
        new Uint8Array(55).fill(1),
        new Uint8Array(56).fill(1),
        new Uint8Array(64).fill(2),
        new Uint8Array(1000).map((_, i) => i * 7),
      ].map((bytes, i) => ({ label: `bytes ${bytes.length} ${i}`, bytes })),
    ),
})
add({
  fn: 'sha256Hex',
  ...noText,
  mutation: 'text',
  call: (input) =>
    input.args?.text !== undefined
      ? sha256Hex(fromUnits(input.args.text))
      : input.bytes !== undefined
        ? sha256Hex(input.bytes)
        : sha256Hex(input.text ?? ''),
  built: () =>
    distinct(
      'sha',
      [
        ...['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), '\u00E9\u4E2D', ASTRAL].map(
          (text) => ({
            label: JSON.stringify(text.slice(0, 20)),
            text: text,
            args: { text: units(text) },
          }),
        ),
        { label: 'lone', args: { text: units('a\uD800b') } },
        { label: 'lone low', args: { text: units('\uDC00') } },
        { label: 'bytes', bytes: new Uint8Array([1, 2, 3]) },
      ].map((input) => ({ ...input, text: undefined })),
    ),
})
add({
  fn: 'runsText',
  ...noText,
  mutation: 'none',
  call: ({ args = {} }) => units(runsText((args.runs as unknown[]).map(runOf))),
  built: () =>
    distinct(
      'runstext',
      [
        [],
        [{ kind: 'text', text: 'a' }],
        [{ kind: 'lineBreak' }],
        [{ kind: 'math', latex: 'x^2' }],
        [{ kind: 'footnoteRef', id: 'n' }],
        [
          { kind: 'text', text: 'a' },
          { kind: 'lineBreak' },
          { kind: 'math', latex: '\\b' },
          { kind: 'footnoteRef', id: 'n', marker: '1' },
          { kind: 'text', text: 'z', bold: true, italic: true, href: '#p=1' },
        ],
        [
          { kind: 'text', text: '\uD800' },
          { kind: 'text', text: '\uDC00' },
        ],
      ].map((runs, i) => ({
        label: `runs ${i}`,
        args: { runs: (runs as InlineRun[]).map(runWire) },
      })),
    ),
})

// Units of a chapter and of the labels of a book
add({
  fn: 'chapterTranslationUnits',
  ...noText,
  mutation: 'text',
  call: (input) => {
    const map = openChapter(argSource(input))
    if (map.broken) return chapterWire(map)
    return chapterTranslationUnits(map, {
      index: readNumber(input.args!.index),
      path: input.args!.path as string,
    }).map(unitWire)
  },
  built: () =>
    distinct('units', [
      ...CHAPTERS.flatMap(([label, source]) =>
        [
          [0, 'OEBPS/ch1.xhtml'],
          [3, 'a/\u00E9.xhtml'],
          [-1, ''],
        ].map(([index, path]) => ({
          label: `${label} ${index}`,
          text: source,
          args: { index: wireNumber(index as number), path },
        })),
      ),
      { label: 'index nan', text: PROSE, args: { index: 'NaN', path: 'p' } },
      { label: 'index 1.5', text: PROSE, args: { index: 1.5, path: 'p' } },
      { label: 'broken', text: HOSTILE[3]![1], args: { index: 0, path: 'p' } },
      {
        label: 'repeated blocks',
        text: page(
          '<p>Same text</p><p>Same text</p><p> Same   text </p><p>Other</p><p>1234</p><p><b>x</b></p>',
        ),
        args: { index: 1, path: 'rep.xhtml' },
      },
      {
        label: 'ruby',
        text: page('<p>\u6F22<ruby>\u5B57<rt>ji</rt></ruby>x</p><p><rt>only</rt></p>'),
        args: { index: 2, path: 'ruby.xhtml' },
      },
    ]),
})
const LABELS: Array<[string, EpubMetadataLabels]> = [
  ['empty', { titles: [], nav: [], ncx: [] }],
  ['one title', { titles: ['A Title'], nav: [], ncx: [] }],
  [
    'same everywhere',
    {
      titles: ['Chapter  One'],
      nav: ['Chapter One', 'Two'],
      ncx: [' chapter one'.trim(), 'Two', '\u00C9t\u00E9'],
    },
  ],
  ['nfc fold', { titles: ['\u00C9t\u00E9'], nav: ['E\u0301te\u0301'], ncx: ['\u00C9t\u00E9 '] }],
  ['no letters', { titles: ['123', '---', ''], nav: ['\u2014', ' 4 5 '], ncx: ['\uD800'] }],
  ['markup chars', { titles: ['a < b & c > d'], nav: ['a < b & c > d', 'a&b'], ncx: [] }],
  [
    'whitespace',
    {
      titles: ['  lead\u00A0\u00A0gap\ttab\nnl  '],
      nav: ['lead gap tab nl'],
      ncx: ['\u2028x\u2029'],
    },
  ],
  ['lone', { titles: ['a\uD800b', 'a\uD800b'], nav: ['\uDC00x'], ncx: ['x'] }],
  [
    'cjk',
    {
      titles: ['\uD55C\uAE00 \uC81C\uBAA9', '\u4E2D\u6587'],
      nav: ['\u4E2D\u6587'],
      ncx: ['\uD55C\uAE00 \uC81C\uBAA9'],
    },
  ],
  [
    'many',
    {
      titles: Array.from({ length: 30 }, (_, i) => `Title ${i % 11}`),
      nav: Array.from({ length: 30 }, (_, i) => `Title ${i % 13}`),
      ncx: [],
    },
  ],
]
add({
  fn: 'metadataTranslationUnits',
  ...noText,
  mutation: 'none',
  call: ({ args = {} }) =>
    metadataTranslationUnits(
      Object.fromEntries(
        ['titles', 'nav', 'ncx'].map((key) => [key, (args[key] as number[][]).map(fromUnits)]),
      ) as unknown as EpubMetadataLabels,
    ).map(unitWire),
  built: () =>
    distinct(
      'metadata',
      LABELS.map(([label, labels]) => ({
        label,
        args: {
          titles: labels.titles.map(units),
          nav: labels.nav.map(units),
          ncx: labels.ncx.map(units),
        },
      })),
    ),
})

// epubMigrationInfo reads a saved book; the case gives the chapters the book holds, and the keys of its units, which the
// Rust side takes as the caller's reading (`epubTranslationUnits(book)` is not ported).
interface BookCase {
  path: string
  source: string
}
const fakeBook = (chapters: BookCase[], titles: string[]): EpubBook =>
  ({
    spine: {
      items: chapters.map((c, index) => ({ index, path: c.path, fixedLayout: false })),
      tocId: null,
      pageProgressionDirection: null,
    },
    manifest: [],
    metadata: { titles },
    readText: async (path: string) => {
      const c = chapters.find((x) => x.path === path)
      return c ? { text: c.source, valid: true } : null
    },
  }) as unknown as EpubBook
const bookCase = (chapters: BookCase[]) => ({
  chapters: chapters.map((c) => ({ path: c.path, source: units(c.source) })),
})
const BOOKS: Array<[string, BookCase[], string[]]> = [
  ['empty', [], []],
  ['one', [{ path: 'OEBPS/ch1.xhtml', source: PROSE }], ['Title']],
  [
    'two',
    [
      { path: 'OEBPS/ch1.xhtml', source: PROSE },
      { path: 'OEBPS/ch2.xhtml', source: CHAPTERS[8]![1] },
    ],
    ['Book', 'Book'],
  ],
  [
    'duplicate path',
    [
      { path: 'a.xhtml', source: CHAPTERS[8]![1] },
      { path: 'b.xhtml', source: CHAPTERS[9]![1] },
      { path: 'a.xhtml', source: CHAPTERS[8]![1] },
    ],
    [],
  ],
  ['astral path', [{ path: `x/${ASTRAL}.xhtml`, source: CHAPTERS[6]![1] }], ['\u00C9t\u00E9']],
  [
    'broken chapter',
    [
      { path: 'bad.xhtml', source: HOSTILE[3]![1] },
      { path: 'ok.xhtml', source: CHAPTERS[8]![1] },
    ],
    ['T'],
  ],
]
add({
  fn: 'epubMigrationInfo',
  ...noText,
  mutation: 'none',
  call: async ({ args = {} }) => {
    const chapters = (args.chapters as Array<{ path: string; source: number[] }>).map((c) => ({
      path: c.path,
      source: fromUnits(c.source),
    }))
    const info = await epubMigrationInfo(fakeBook(chapters, args.titles as string[]), {
      oldDocHash: args.oldDocHash as string,
      newDocHash: args.newDocHash as string,
    })
    return {
      oldDocHash: info.oldDocHash,
      newDocHash: info.newDocHash,
      pageFingerprints: info.pageFingerprints,
      blockKeys: info.blockKeys,
      keepBlockKeys: info.keepBlockKeys,
    }
  },
  built: async () => {
    const inputs: Input[] = []
    for (const [label, chapters, titles] of BOOKS) {
      const { units: read } = await epubTranslationUnits(fakeBook(chapters, titles))
      inputs.push({
        label,
        args: {
          ...bookCase(chapters),
          titles,
          spinePaths: chapters.map((c) => c.path),
          blockKeys: read.map((u) => u.key),
          oldDocHash: 'old',
          newDocHash: 'new',
        },
      })
    }
    return distinct('migrate', inputs)
  },
})

add({
  fn: 'pureConstants',
  ...noText,
  mutation: 'none',
  // one input per constant, each its own result
  call: ({ args = {} }) => {
    const constants: Record<string, unknown> = {
      OPAQUE_ELEMENTS: [...OPAQUE_ELEMENTS],
      ID_ATTRIBUTES: [...ID_ATTRIBUTES].sort(),
      EPUB_METADATA_FINGERPRINT_SOURCE,
      EPUB_METADATA_FINGERPRINT,
      EPUB_METADATA_PAGE,
      LANGUAGE_SAMPLE_CHARS,
      opaque: [...OPAQUE_ELEMENTS].map(() => true),
    }
    return typeof args.name === 'string' ? constants[args.name] : undefined
  },
  built: () =>
    [
      'OPAQUE_ELEMENTS',
      'ID_ATTRIBUTES',
      'EPUB_METADATA_FINGERPRINT_SOURCE',
      'EPUB_METADATA_FINGERPRINT',
      'EPUB_METADATA_PAGE',
      'LANGUAGE_SAMPLE_CHARS',
      'opaque',
    ].map((name) => ({ label: name, args: { name } })),
})

// an input that crosses as units has no text to mutate: it seeds no mutations
for (const [index, spec] of SPECS.entries()) {
  if (spec.mutation !== 'text') continue
  const built = spec.built
  SPECS[index] = {
    ...spec,
    built: async () =>
      (await built()).map((input) =>
        input.text === undefined ? { ...input, mutate: false } : input,
      ),
  }
}
