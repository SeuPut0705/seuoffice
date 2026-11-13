import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { charIndentsOf, paraBorderSidesOf } from './reference/parse-props'
import { DEFAULT_THEME_COLORS } from './reference/theme'
import type { CharIndents, ParaBorderSides, ParaFormat, Run, ThemeFonts } from './reference/types'
import { nameOf, type XNode, xmlParser } from './reference/xml-utils'
import { failed } from './engine'
import { tagTokens } from './fragments'
import { type Comparison, engine, option } from './harness'
import { keyOrderDifference } from './key-order'
import { listedDifference } from './known-differences'
import { type Args, MODEL_FUNCTIONS, type Population, READERS, type Themes } from './props-registry'

export type Outcome = { value?: unknown } | { error: string }

interface Case {
  fn: string
  xml: string
  args: object
  typescript: Outcome
}

/**
 * Per function: checks, differences, how many of the checks TypeScript threw
 * in, and how many distinct results it gave. A function that only ever
 * returned one thing was not really compared.
 */
export const byFunction = new Map<
  string,
  {
    checks: number
    differences: number
    keyOrderOnly: number
    threw: number
    /** digests of the distinct results */
    outcomes: Set<string>
  }
>()

/**
 * A case or a result as a digest: what the run keeps of every case it has
 * seen. Kept whole, the texts, arguments and results of the (f) groups outgrew
 * the JavaScript heap of a runner.
 */
const digest = (text: string): string => createHash('sha256').update(text).digest('base64')

const pending: Array<{ comparison: Comparison; where: string; key: string; fn: string }> = []
/** Each distinct case reaches Rust once, by the digest of the case. `difference` is `null` for an equal case. */
const settled = new Map<
  string,
  {
    difference: string | null
    keyOrderOnly: boolean
    typescriptThrew: boolean
    outcome: string
    listed: boolean
  }
>()
const queued = new Map<string, Case>()

function record(comparison: Comparison, fn: string, key: string, where: string): void {
  const { difference, keyOrderOnly, typescriptThrew, outcome, listed } = settled.get(key)!
  const tally = byFunction.get(fn) ?? {
    checks: 0,
    differences: 0,
    keyOrderOnly: 0,
    threw: 0,
    outcomes: new Set(),
  }
  tally.checks += 1
  if (typescriptThrew) {
    comparison.typescriptThrew += 1
    tally.threw += 1
  }
  tally.outcomes.add(outcome)
  if (listed) comparison.listed += 1
  if (difference !== null) tally.differences += 1
  if (keyOrderOnly) tally.keyOrderOnly += 1
  byFunction.set(fn, tally)
  comparison.record(difference === null ? null : `${where}: ${difference}`, keyOrderOnly)
}

const BATCH_CHARS = 2_000_000
/** `--chars N`: how much of a call and of each answer a difference shows; the whole input reproduces it. */
export const SHOWN_CHARS = option('--chars', 300)

/** The argument text queued cases may hold before they are sent: a case of a parse function carries whole parts. */
const QUEUED_CHARS = 200_000_000
let queuedChars = 0

/** Sends the queued cases to Rust, the calls on one text together, and records the waiting checks. */
export function flush(): void {
  const byText = new Map<string, Array<[key: string, queuedCase: Case]>>()
  for (const entry of queued) {
    const list = byText.get(entry[1].xml) ?? []
    list.push(entry)
    byText.set(entry[1].xml, list)
  }
  let batch: Array<Array<[string, Case]>> = []
  let chars = 0
  const send = (): void => {
    if (batch.length === 0) return
    const { header } = engine.call<{ results: Outcome[][] }>({
      cmd: 'props',
      inputs: batch.map((cases) => ({
        xml: cases[0]![1].xml,
        calls: cases.map(([, { fn, args }]) => ({ fn, args })),
      })),
    })
    if (failed(header)) throw new Error(`props failed: ${header.error.message}`)
    batch.forEach((cases, input) => {
      cases.forEach(([key, { fn, xml, args, typescript }], index) => {
        const rust = header.results[input]![index]!
        const same = 'error' in typescript ? 'error' in rust : isDeepStrictEqual(typescript, rust)
        const call = `${fn}(${JSON.stringify(xml).slice(0, SHOWN_CHARS)}, ${JSON.stringify(args).slice(0, SHOWN_CHARS)})`
        const order =
          same && !('error' in typescript) ? keyOrderDifference(fn, typescript, rust) : null
        const listed =
          (!same || order !== null) &&
          listedDifference({
            fn,
            text: xml,
            args,
            typescript,
            rust,
          }) !== null
        settled.set(key, {
          typescriptThrew: 'error' in typescript,
          outcome: 'error' in typescript ? 'error' : digest(JSON.stringify(typescript)),
          keyOrderOnly: !listed && order !== null,
          listed,
          difference: listed
            ? null
            : !same
              ? `${call}\n` +
                `      typescript ${JSON.stringify(typescript).slice(0, SHOWN_CHARS)}\n` +
                `      rust       ${JSON.stringify(rust).slice(0, SHOWN_CHARS)}`
              : order === null
                ? null
                : `${call}\n      ${order}`,
        })
      })
    })
    batch = []
    chars = 0
  }
  for (const cases of byText.values()) {
    batch.push(cases)
    chars += cases[0]![1].xml.length + cases.length * 60
    if (chars >= BATCH_CHARS) send()
  }
  send()
  queued.clear()
  queuedChars = 0
  for (const waiting of pending.splice(0)) {
    record(waiting.comparison, waiting.fn, waiting.key, waiting.where)
  }
}

/** `JSON.stringify` drops a function without a trace: a result that is one has to show. */
function functionsVisible(_key: string, value: unknown): unknown {
  return typeof value === 'function' ? '[function]' : value
}

/** What a TypeScript call gives, in the form the Rust reply has. */
export function outcomeOf(call: () => unknown): Outcome {
  try {
    return JSON.parse(JSON.stringify({ value: call() }, functionsVisible)) as Outcome
  } catch (error) {
    return { error: String(error) }
  }
}

export function rustOutcome(fn: string, xml: string, args: object): Outcome {
  const { header } = engine.call<{ results: Outcome[][] }>({
    cmd: 'props',
    inputs: [{ xml, calls: [{ fn, args }] }],
  })
  if (failed(header)) throw new Error(`props failed: ${header.error.message}`)
  return header.results[0]![0]!
}

function check(
  comparison: Comparison,
  where: string,
  fn: string,
  xml: string,
  args: Args,
  call: () => unknown,
): void {
  checkOutcome(comparison, where, fn, xml, args, () => outcomeOf(call))
}

/**
 * One check of a function called by name on both sides. `typescript` gives
 * the outcome of the TypeScript side and runs once per distinct case.
 */
export function checkOutcome(
  comparison: Comparison,
  where: string,
  fn: string,
  xml: string,
  args: object,
  typescript: () => Outcome,
): void {
  // what the arguments are once they have crossed the wire
  const wireText = JSON.stringify(args)
  const key = digest(`${fn}\0${xml}\0${wireText}`)
  let found = queued.get(key)
  if (!found && !settled.has(key)) {
    found = { fn, xml, args: JSON.parse(wireText) as object, typescript: typescript() }
    queued.set(key, found)
    queuedChars += wireText.length
  }
  if (found) pending.push({ comparison, where, key, fn })
  else record(comparison, fn, key, where)
  if (queued.size >= 20_000 || queuedChars >= QUEUED_CHARS) flush()
}

export const READER_ELEMENTS = new Set(
  READERS.flatMap((reader) => reader.on).flatMap((on) =>
    typeof on === 'object' ? [on.element] : [],
  ),
)
/** Attribute values are taken from inside these: where the numbers of the properties live. */
const VALUE_HOSTS = new Set(['w:pPr', 'w:rPr', 'w:tblPr', 'w:tcPr'])

/** What one XML text holds for each population. */
export interface Inputs {
  elements: Map<string, string[]>
  attributeValues: Set<string>
}

/** Every element a reader is called on, and the attribute values inside property elements. */
export function inputsOf(xml: string): Inputs {
  const elements = new Map<string, string[]>()
  const attributeValues = new Set<string>()
  const open = new Map<string, number[]>()
  let hostDepth = 0
  const wanted = (name: string): boolean =>
    READER_ELEMENTS.has(name) || name === 'w:p' || name === 'w:tbl'
  const add = (name: string, start: number, end: number): void => {
    const list = elements.get(name) ?? []
    list.push(xml.slice(start, end))
    elements.set(name, list)
  }
  for (const tag of tagTokens(xml)) {
    const host = VALUE_HOSTS.has(tag.name)
    if (!tag.closing && (hostDepth > 0 || host)) {
      for (const match of xml.slice(tag.start, tag.end).matchAll(/=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attributeValues.add(match[1] ?? match[2] ?? '')
      }
    }
    if (host && !tag.selfClosing) hostDepth += tag.closing ? -1 : 1
    if (!wanted(tag.name)) continue
    if (tag.selfClosing) add(tag.name, tag.start, tag.end)
    else if (!tag.closing) open.set(tag.name, [...(open.get(tag.name) ?? []), tag.start])
    else {
      const start = open.get(tag.name)?.pop()
      if (start !== undefined) add(tag.name, start, tag.end)
    }
  }
  return { elements, attributeValues }
}

/**
 * `text` itself as the input of every reader over an element or a paragraph.
 * `inputsOf` yields balanced elements only, so a text cut at its root would
 * never reach a reader through it.
 */
export function inputsOfWhole(text: string): Inputs {
  return {
    elements: new Map([...READER_ELEMENTS, 'w:p', 'w:tbl'].map((name) => [name, [text]])),
    attributeValues: new Set(),
  }
}

/**
 * An element broken at its root in the ways a truncated or damaged part
 * breaks. The parser refuses some of these and reads the others leniently;
 * either way both engines must do the same.
 */
export function brokenAtTheRoot(fragment: string): string[] {
  const openEnd = fragment.indexOf('>') + 1
  const closer = fragment.lastIndexOf('</')
  const value = fragment.indexOf('="')
  const points = Array.from(fragment)
  const afterTheOpener = (inserted: string): string =>
    fragment.slice(0, openEnd) + inserted + fragment.slice(openEnd)
  return [
    // the root never closes
    fragment.slice(0, closer === -1 ? openEnd - 2 : closer),
    points.slice(0, points.length / 2).join(''),
    fragment.slice(0, openEnd - 1),
    ...(value === -1 ? [] : [fragment.slice(0, value + 2)]),
    fragment.slice(0, -1),
    // a closer with no opener
    `${fragment}</w:x>`,
    `</w:x>${fragment}`,
    ...(closer === -1 ? [] : [`${fragment.slice(0, closer)}</w:x>`]),
    afterTheOpener('<!-- c'),
    afterTheOpener('<![CDATA[ x'),
    afterTheOpener('<?pi '),
    // deeper than the parser's maxNestedTags
    '<a>'.repeat(101) + fragment + '</a>'.repeat(101),
  ]
}

export type Group = 'pPr' | 'rPr' | 'paragraph' | 'table' | 'values'

function groupOf(on: Population): Group {
  if (on === 'attributeValue') return 'values'
  if (on === 'table') return 'paragraph'
  if (typeof on === 'string') return 'paragraph'
  switch (on.element) {
    case 'w:pPr':
    case 'w:ind':
      return 'pPr'
    case 'w:rPr':
    case 'w:rFonts':
    case 'w:bdr':
    case 'w:shd':
      return 'rPr'
    case 'w:tblPr':
    case 'w:tcPr':
    case 'w:tcMar':
    case 'w:tblCellMar':
      return 'table'
    default:
      return 'paragraph'
  }
}

/**
 * Runs every reader over what `xml` holds. `partXml` is set for a whole part,
 * which is also the input of the readers over a part.
 */
export function compareReaders(
  comparisons: Record<Group, Comparison>,
  where: string,
  inputs: Inputs,
  themes: Themes,
  partXml: string | null,
  instructions: Iterable<string>,
): void {
  const textsOf = (on: Population): Iterable<string> => {
    if (on === 'paragraph') return inputs.elements.get('w:p') ?? []
    if (on === 'table') return inputs.elements.get('w:tbl') ?? []
    if (on === 'part') return partXml === null ? [] : [partXml]
    if (on === 'instruction') return instructions
    if (on === 'attributeValue') return inputs.attributeValues
    return inputs.elements.get(on.element) ?? []
  }
  for (const reader of READERS) {
    const variants = reader.variants?.(themes) ?? [{}]
    for (const on of reader.on) {
      const node = typeof on === 'object' ? { node: on.element } : {}
      for (const text of textsOf(on)) {
        for (const variant of variants) {
          const args = { ...node, ...variant }
          check(comparisons[groupOf(on)], where, reader.fn, text, args, () =>
            reader.call(text, args),
          )
        }
      }
    }
  }
}

function model(comparison: Comparison, where: string, fn: string, args: Args): void {
  check(comparison, where, fn, '', args, () => MODEL_FUNCTIONS[fn]!(args))
}

const TINTS = [undefined, '', 'FF', '80', '33', '0', 'zz', '1FF', '-1', ' 7f']
const THEME_COLOR_NAMES = [
  'dark1',
  'text1',
  'light1',
  'background1',
  'dark2',
  'text2',
  'light2',
  'background2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hyperlink',
  'followedHyperlink',
  'none',
  'constructor',
  '__proto__',
  '',
]

export const ODD_FONT_THEMES: ThemeFonts[] = [
  { major: 'Maj', minor: 'Min' },
  { major: '', minor: '', eastAsia: '', majorEastAsia: '', majorCs: '', minorCs: '' },
  ...[
    'ja-JP',
    'ko',
    'KO-kr',
    'zh',
    'zh-TW',
    'ZH-hk',
    'en-US',
    '',
    'constructor',
    '__proto__',
  ].flatMap((eaLang) =>
    ['ar-SA', 'he', 'TH-th', '', 'constructor'].map((bidiLang) => ({
      major: 'Maj',
      minor: 'Min',
      eastAsia: eaLang === 'ko' ? 'Batang' : '',
      majorEastAsia: '',
      majorCs: bidiLang === 'he' ? 'David' : '',
      minorCs: '',
      eaLang,
      bidiLang,
      majorScripts: { Jpan: 'MS Gothic', Arab: 'Times New Roman', Hant: '' },
      minorScripts: { Hang: 'Malgun Gothic', Hebr: 'Arial', Hans: 'SimSun' },
    })),
  ),
]

/** Model functions on exhaustive small domains: every combination is cheap to list. */
export function compareModelDomains(comparison: Comparison, themes: Themes[]): void {
  const tri = [undefined, true, false]
  for (const de of tri)
    for (const dn of tri) model(comparison, 'domain', 'autoSpaceMode', { de, dn })
  const eaRefs = [undefined, 'majorEastAsia', 'minorEastAsia', 'majorBidi', '']
  for (const fonts of [...ODD_FONT_THEMES, ...themes.flatMap((theme) => theme.fonts ?? [])]) {
    for (const eaRef of eaRefs) model(comparison, 'domain', 'themeLangEaSlotFont', { fonts, eaRef })
  }
  const palettes = [
    DEFAULT_THEME_COLORS,
    { dk1: ' 1f2e3d ', lt1: '', dk2: 'xyzxyz', accent1: 'abcdef', accent2: '#123456' },
    {},
    ...themes.flatMap((theme) => theme.colors ?? []),
  ]
  const distinct = [...new Map(palettes.map((theme) => [JSON.stringify(theme), theme])).values()]
  for (const theme of distinct) {
    for (const themeColor of THEME_COLOR_NAMES) {
      for (const tint of TINTS) {
        for (const shade of [undefined, 'BF', '40', 'g']) {
          model(comparison, 'domain', 'resolveThemeColor', { themeColor, theme, tint, shade })
        }
      }
    }
  }
}

const FORMATS: Array<ParaFormat | undefined> = [
  undefined,
  {},
  { indentFirstLine: -360 },
  { indentFirstLine: 360, indentLeft: 720, align: 'left' },
  { indentFirstLine: 0, indentRight: 100 },
]
const UNITS = [
  { run: 240, normal: 210 },
  { run: 199.5, normal: 210.25 },
  { run: 0, normal: 0 },
  { run: 315, normal: -200 },
]
const CHAR_NUMBERS = [0, 100, 150, 250, 50, 1, 199, 0.5, 2.5, -100, 1e21, 33.333]

/** What the TypeScript readers return for the corpus fragments: the inputs of the model functions. */
export function modelValuesOf(
  pPrFragments: Iterable<string>,
  indFragments: Iterable<string>,
): { sides: ParaBorderSides[]; chars: CharIndents[] } {
  const distinct = <T>(
    fragments: Iterable<string>,
    name: string,
    read: (node: XNode) => T | undefined,
  ): T[] => {
    const byJson = new Map<string, T>()
    for (const fragment of fragments) {
      let node: XNode | undefined
      try {
        node = (xmlParser.parse(fragment) as XNode[]).find((n) => nameOf(n) === name)
      } catch {
        continue
      }
      const value = node && read(node)
      if (value !== undefined) byJson.set(JSON.stringify(value), value)
    }
    return [...byJson.values()]
  }
  return {
    sides: distinct(pPrFragments, 'w:pPr', (pPr) => paraBorderSidesOf(pPr)),
    chars: distinct(indFragments, 'w:ind', (ind) => charIndentsOf(ind)),
  }
}

/** Model functions on what the readers returned for the corpus, and on made values. */
export function compareModelValues(
  comparison: Comparison,
  values: { sides: ParaBorderSides[]; chars: CharIndents[]; runs: Run[][] },
  random: () => number,
): void {
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]!
  const madeChars = Array.from({ length: 300 }, (): CharIndents => {
    const chars: CharIndents = {}
    for (const key of ['left', 'right', 'firstLine', 'hanging'] as const) {
      if (random() < 0.5) chars[key] = pick(CHAR_NUMBERS)
    }
    return chars
  })
  const chars = [...values.chars, ...madeChars]
  chars.forEach((over, index) => {
    const base = index === 0 ? undefined : chars[index - 1]
    model(comparison, 'chars', 'mergeCharIndents', { base, over })
    model(comparison, 'chars', 'mergeCharIndents', { base: over })
    model(comparison, 'chars', 'activeCharIndents', { chars: over })
    for (const format of FORMATS) {
      model(comparison, 'chars', 'resolveCharIndents', { format, chars: over, units: pick(UNITS) })
    }
  })
  const madeLine = (): ParaBorderSides['t'] =>
    pick<ParaBorderSides['t']>([
      undefined,
      null,
      {},
      { none: true, spacePt: pick([1, 4, 0]) },
      { color: 'FF0000' },
      { szPt: pick([0.5, 1.5, 6]) },
      { color: '00FF00', szPt: 0.75, spacePt: pick([0, 1, 31]) },
      { spacePt: 4 },
    ])
  const madeSides = Array.from({ length: 400 }, (): ParaBorderSides => {
    const sides: ParaBorderSides = {}
    for (const side of ['t', 'b', 'l', 'r'] as const) {
      const line = madeLine()
      if (line !== undefined) sides[side] = line
    }
    return sides
  })
  const allSides = [...values.sides, ...madeSides]
  allSides.forEach((sides, index) => {
    model(comparison, 'sides', 'paraBordersOf', { sides })
    model(comparison, 'sides', 'mergeStyleBorders', { sides })
    for (const other of [allSides[index - 1], allSides[index + 7]]) {
      if (!other) continue
      const direct = MODEL_FUNCTIONS.paraBordersOf!({ sides: other }) as Args['direct']
      model(comparison, 'sides', 'mergeStyleBorders', { sides, direct })
    }
  })
  for (const runs of values.runs) {
    // a run cut in two has to merge back; the halves also feed the text tests
    const halves = runs.flatMap((run) => {
      const cut = Math.floor(run.text.length / 2)
      return [
        { ...run, text: run.text.slice(0, cut) },
        { ...run, text: run.text.slice(cut) },
      ]
    })
    for (const list of [runs, halves]) {
      model(comparison, 'runs', 'mergeRuns', { runs: list })
      model(comparison, 'runs', 'spaceOnlyRuns', { runs: list })
      model(comparison, 'runs', 'breakOnlyRuns', { runs: list })
    }
  }
}

/** Attribute values the tracked documents never hold: where JavaScript number and string rules show. */
export const ODD_VALUES = [
  '',
  '0',
  '-0',
  '+5',
  '-5',
  '12.7',
  '.5',
  '5.',
  '-.5',
  '1e3',
  '1E-2',
  '1e',
  '0x1F',
  '0X1f',
  '0x',
  '-0x10',
  'ff',
  'FF',
  '04A0',
  '12abc',
  'abc',
  ' 42 ',
  '\t7',
  '00012',
  '9007199254740993',
  '99999999999999999999999',
  '1e400',
  '-1e400',
  'Infinity',
  '-Infinity',
  '+Infinity',
  'NaN',
  '\uFF11\uFF12',
  '\u0663',
  '1_000',
  '1,000',
  '0b11',
  '0o17',
  '0.1',
  '2.5',
  '-2.5',
  '0.5',
  '-0.5',
  '1.5',
  '0.49999999999999994',
  '4.35',
  '240',
  '480',
  '9525',
  '4762',
  '14287',
  '130000',
  '130001',
  '4294967296',
  '4294967328',
  '2147483648',
  '-2147483649',
  'FFFFFFFFFFFFFFFFFFFF',
  '1FFFFFFFFFFFFF',
  '20000000000001',
  '20000000000003',
  'true',
  'false',
  'on',
  'off',
  '1',
  'none',
  'nil',
  'auto',
  'ON',
  'True',
  'FALSE',
  'OFF',
  'constructor',
  '__proto__',
  'toString',
  'hasOwnProperty',
  'solid',
  'pct12',
  'pct50',
  'pct5',
  'pct100',
  'pct101',
  'pct0',
  'pctx',
  'pct',
  'pct1e1',
  'pct0x10',
  'thinDiagStripe',
  'diagCross',
  'HorzSTRIPE',
  'clear',
  'single',
  'center',
  'both',
  'distribute',
  'start',
  'end',
  'decimal',
  'dot',
  'margin',
  'dxa',
  'pct',
  'majorBidi',
  'minorBidi',
  'majorEastAsia',
  'minorEastAsia',
  'majorHAnsi',
  'minorAscii',
  'accent1',
  'dark1',
  'hyperlink',
  '#ff0000',
  ' FF0000 ',
  'fff',
  'GGGGGG',
  '&#48;',
  '&#x31;&#50;',
  '&amp;',
  '&lt;b&gt;',
  '\u0130',
  '\u212A',
  'O\uFB00',
  '\u00A012',
  '\uFEFF12',
  '12\u00A0',
  '\u{1F600}',
  'ja-JP',
  'ko',
  'zh-TW',
  'begin',
  'end',
  'separate',
  'page',
  'preserve',
  'f',
  'white',
  'visibility:hidden',
  'right',
  'left',
  'dxa',
  'w:rubyBase',
]

/** Start and end of every element of `xml` below the root. */
function childSpans(xml: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const open: number[] = []
  for (const tag of tagTokens(xml)) {
    if (tag.selfClosing) {
      if (open.length > 0) spans.push([tag.start, tag.end])
    } else if (!tag.closing) open.push(tag.start)
    else {
      const start = open.pop()
      if (start !== undefined && open.length > 0) spans.push([start, tag.end])
    }
  }
  return spans
}

/**
 * One to three edits of a fragment: an attribute value replaced by an odd one,
 * a child element duplicated or removed, and rewrites that leave the XML
 * meaning alone (other white space inside a tag, the other quote, white space
 * between elements), since every tracked document is written in one style.
 */
export function mutateProps(fragment: string, random: () => number): string {
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]!
  let xml = fragment
  for (let edits = 1 + Math.floor(random() * 3); edits > 0; edits--) {
    const kind = random()
    if (kind < 0.5) {
      const values = [...xml.matchAll(/="[^"]*"/g)]
      if (values.length === 0) continue
      const value = pick(values)
      xml = `${xml.slice(0, value.index)}="${pick(ODD_VALUES)}"${xml.slice(value.index + value[0].length)}`
    } else if (kind < 0.7) {
      const spans = childSpans(xml)
      if (spans.length === 0) continue
      const [start, end] = pick(spans)
      xml =
        kind < 0.6
          ? xml.slice(0, end) + xml.slice(start, end) + xml.slice(end)
          : xml.slice(0, start) + xml.slice(end)
    } else if (kind < 0.8) {
      const values = [...xml.matchAll(/="([^"'<>]*)"/g)]
      if (values.length === 0) continue
      const value = pick(values)
      xml = `${xml.slice(0, value.index)}='${value[1]}'${xml.slice(value.index + value[0].length)}`
    } else {
      const tags = [...tagTokens(xml)]
      if (tags.length === 0) continue
      const tag = pick(tags)
      const space = pick(['\n', '\t', '  ', '\r\n', ' \n\t'])
      const text = xml.slice(tag.start, tag.end)
      const inside = text.indexOf(' ')
      xml =
        kind < 0.9 && inside !== -1
          ? xml.slice(0, tag.start + inside) + space + xml.slice(tag.start + inside + 1)
          : kind < 0.95
            ? xml.slice(0, tag.end - (tag.selfClosing ? 2 : 1)) +
              space +
              xml.slice(tag.end - (tag.selfClosing ? 2 : 1))
            : xml.slice(0, tag.end) + space + xml.slice(tag.end)
    }
  }
  return xml
}
