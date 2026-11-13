// Comparison (e): a docx as loadDocxZip opens it, and every value parseDocx
// reads from the package before it reaches the body.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import JSZip from 'jszip'
import { FONT_TABLE_PART_PATH, parseFontTable, readEmbeddedFonts } from './reference/font-table'
import {
  canonicalXmlSyntax,
  needsOoxmlNormalization,
  normalizeOoxmlXml,
} from './reference/ooxml-normalize'
import {
  parseComments,
  parseNumbering,
  parseProtection,
  parseRels,
  parseRemovePersonalInfo,
  parseWriteProtection,
  resolveMainDocumentPath,
  resolveRelationshipTargetPath,
} from './reference/parse-package'
import { parseStyles } from './reference/parse-styles'
import {
  DEFAULT_THEME_COLORS,
  readThemeColors,
  readThemeFonts,
  THEME_PART_PATH,
} from './reference/theme'
import type { StyleInfo, ThemeColors, ThemeFonts } from './reference/types'
import { attrsOf, findChildren, nameOf, type XNode, xmlParser } from './reference/xml-utils'
import { loadDocxZip } from './reference/zip-load'
import { failed } from './engine'
import { type Comparison, describeTextDifference, engine, repoRoot, SHOW, toolDir } from './harness'
import { RAW_HOST_ENV } from './host'
import { keyOrderDifference } from './key-order'

export type Outcome = { value?: unknown } | { error: string }

export interface Entry {
  name: string
  dir: boolean
  length?: number
  hash?: number
  error?: string
}

/** The values of one package, each as what its reader returned or threw. */
export interface Model {
  mainPath: Outcome
  /** `null` where there is no main part to have relationships. */
  documentRels: Outcome | null
  /** Every relationships part, in package order. */
  relationships: Array<[name: string, rels: Outcome]>
  /** For each relationships part that parses: its owner, and where each target leads. */
  targets: Array<[name: string, source: string, resolved: Array<string | null>]>
  contentTypes: Outcome
  theme: Outcome
  styles: Outcome
  headingStyles: Outcome
  numbering: Outcome
  fontTable: Outcome
  /** `null` where the font table could not be read. */
  embeddedFonts: Outcome | null
  comments: Outcome
  protection: Outcome
  writeProtection: Outcome
  removePersonalInfo: Outcome
}

export type Opened = { refused: string } | { entries: Entry[]; model: Model }

function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193)
  return hash >>> 0
}

/**
 * A value as JSON carries it, with what JSON would hide made visible: a Map
 * as its entries in order, a function (a table answering for an inherited
 * key) as a marker.
 */
function wireValue(value: unknown): unknown {
  const text = JSON.stringify(value, (_key, inner: unknown) =>
    inner instanceof Map ? Array.from(inner) : typeof inner === 'function' ? '[function]' : inner,
  )
  return text === undefined ? undefined : (JSON.parse(text) as unknown)
}

/** What a reader returned, for the readers after it, and its outcome on the wire. */
interface Attempt<T> {
  value?: T
  outcome: Outcome
}

async function attempt<T>(read: () => T | Promise<T>): Promise<Attempt<T>> {
  try {
    const value = await read()
    const wire = wireValue(value)
    return { value, outcome: wire === undefined ? {} : { value: wire } }
  } catch (error) {
    return { outcome: { error: String(error) } }
  }
}

async function outcomeOf(read: () => unknown): Promise<Outcome> {
  return (await attempt(read)).outcome
}

// parse.ts keeps the three readers below to itself. They are copied here, and
// PARSE_TS_SNIPPETS makes the gate fail when parse.ts no longer holds them as
// copied, so the copies cannot drift from what the engine runs.

/** `contentTypesOf` of parse.ts. */
async function contentTypesOf(zip: JSZip) {
  const defaults = new Map<string, string>()
  const overrides = new Map<string, string>()
  const file = zip.file('[Content_Types].xml')
  if (!file) return { defaults, overrides }
  const parsed = xmlParser.parse(await file.async('string')) as XNode[]
  const root = parsed.find((n) => nameOf(n) === 'Types')
  for (const node of root ? findChildren(root, 'Default') : []) {
    const attrs = attrsOf(node)
    const ext = attrs['Extension']?.toLowerCase()
    if (ext && attrs['ContentType']) defaults.set(ext, attrs['ContentType'])
  }
  for (const node of root ? findChildren(root, 'Override') : []) {
    const attrs = attrsOf(node)
    if (attrs['PartName'] && attrs['ContentType'])
      overrides.set(attrs['PartName'], attrs['ContentType'])
  }
  return { defaults, overrides }
}

/** `partText` of parse.ts: a part that is only read, written the usual way. */
async function partText(file: JSZip.JSZipObject): Promise<string> {
  return canonicalXmlSyntax(await file.async('string'))
}

/** `parseTheme` and `readThemeFontLang` of parse.ts. */
export async function parseTheme(
  zip: JSZip,
): Promise<{ fonts: ThemeFonts | null; colors: ThemeColors | null }> {
  const file = zip.file(THEME_PART_PATH)
  if (!file) return { fonts: null, colors: { ...DEFAULT_THEME_COLORS } }
  const xml = await partText(file)
  const fonts = readThemeFonts(xml)
  if (fonts) {
    const { eaLang, bidiLang } = await readThemeFontLang(zip)
    if (eaLang) fonts.eaLang = eaLang
    if (bidiLang) fonts.bidiLang = bidiLang
  }
  return { fonts, colors: readThemeColors(xml) }
}

async function readThemeFontLang(zip: JSZip): Promise<{ eaLang?: string; bidiLang?: string }> {
  const file = zip.file('word/settings.xml')
  if (!file) return {}
  const tag = /<w:themeFontLang\b[^>]*>/.exec(await partText(file))?.[0]
  if (!tag) return {}
  return {
    eaLang: /\bw:eastAsia="([^"]+)"/.exec(tag)?.[1],
    bidiLang: /\bw:bidi="([^"]+)"/.exec(tag)?.[1],
  }
}

/** The heading and list paragraph styles `parseDocx` picks from the style table. */
function headingStylesOf(styles: Map<string, StyleInfo>) {
  const headingStyleIds = new Map<number, string>()
  let listParagraphStyleId: string | undefined
  for (const info of styles.values()) {
    if (info.headingLevel && !headingStyleIds.has(info.headingLevel)) {
      headingStyleIds.set(info.headingLevel, info.styleId)
    }
    if (!listParagraphStyleId && /^listparagraph$/i.test(info.styleId)) {
      listParagraphStyleId = info.styleId
    }
  }
  return { headingStyleIds, listParagraphStyleId }
}

const PARSE_TS_SNIPPETS = [
  `      const defaults = new Map<string, string>()
      const overrides = new Map<string, string>()
      const file = zip.file('[Content_Types].xml')
      if (!file) return { defaults, overrides }
      const parsed = xmlParser.parse(await file.async('string')) as XNode[]
      const root = parsed.find((n) => nameOf(n) === 'Types')
      for (const node of root ? findChildren(root, 'Default') : []) {
        const attrs = attrsOf(node)
        const ext = attrs['Extension']?.toLowerCase()
        if (ext && attrs['ContentType']) defaults.set(ext, attrs['ContentType'])
      }
      for (const node of root ? findChildren(root, 'Override') : []) {
        const attrs = attrsOf(node)
        if (attrs['PartName'] && attrs['ContentType'])
          overrides.set(attrs['PartName'], attrs['ContentType'])
      }
      return { defaults, overrides }`,
  `  const file = zip.file(THEME_PART_PATH)
  if (!file) return { fonts: null, colors: { ...DEFAULT_THEME_COLORS } }
  const xml = await partText(file)
  const fonts = readThemeFonts(xml)
  if (fonts) {
    const { eaLang, bidiLang } = await readThemeFontLang(zip)
    if (eaLang) fonts.eaLang = eaLang
    if (bidiLang) fonts.bidiLang = bidiLang
  }
  return { fonts, colors: readThemeColors(xml) }`,
  `  const file = zip.file('word/settings.xml')
  if (!file) return {}
  const tag = /<w:themeFontLang\\b[^>]*>/.exec(await partText(file))?.[0]
  if (!tag) return {}
  return {
    eaLang: /\\bw:eastAsia="([^"]+)"/.exec(tag)?.[1],
    bidiLang: /\\bw:bidi="([^"]+)"/.exec(tag)?.[1],
  }`,
  `  const headingStyleIds = new Map<number, string>()
  let listParagraphStyleId: string | undefined
  for (const info of styles.values()) {
    if (info.headingLevel && !headingStyleIds.has(info.headingLevel)) {
      headingStyleIds.set(info.headingLevel, info.styleId)
    }
    if (!listParagraphStyleId && /^listparagraph$/i.test(info.styleId)) {
      listParagraphStyleId = info.styleId
    }
  }`,
]

/** The copied readers that parse.ts no longer holds as copied. */
export function driftedCopies(): number {
  const parseTs = readFileSync(resolve(repoRoot, 'tools/docx-diff/reference/parse.ts'), 'utf8')
  return PARSE_TS_SNIPPETS.filter((snippet) => !parseTs.includes(snippet)).length
}

/** The part a relationships part belongs to: a/_rels/b.xml.rels is of a/b.xml. */
function sourceOf(relsName: string): string {
  const found = /(^|\/)_rels\/([^/]+)\.rels$/.exec(relsName)
  return found ? relsName.slice(0, found.index) + found[1] + found[2] : ''
}

async function typescriptModel(zip: JSZip): Promise<Model> {
  const files = Object.entries(zip.files).filter(([, file]) => !file.dir)
  const mainPath = await attempt(() => resolveMainDocumentPath(zip))
  const documentRels =
    typeof mainPath.value === 'string'
      ? await outcomeOf(() => parseRels(zip, mainPath.value!.replace(/([^/]+)$/, '_rels/$1.rels')))
      : null
  const relationships: Model['relationships'] = []
  const targets: Model['targets'] = []
  for (const [name] of files) {
    if (!name.endsWith('.rels')) continue
    const rels = await attempt(() => parseRels(zip, name))
    relationships.push([name, rels.outcome])
    if (rels.value) {
      const source = sourceOf(name)
      targets.push([
        name,
        source,
        [...rels.value.values()].map((rel) => resolveRelationshipTargetPath(source, rel.target)),
      ])
    }
  }

  const theme = await attempt(() => parseTheme(zip))
  const styles = await attempt(() =>
    parseStyles(zip, theme.value?.colors ?? null, theme.value?.fonts ?? null),
  )
  const headingStyles = styles.value
    ? await outcomeOf(() => headingStylesOf(styles.value!.styles))
    : styles.outcome

  const fontTable = await attempt(async () => {
    const file = zip.file(FONT_TABLE_PART_PATH)
    return file ? parseFontTable(await partText(file)) : []
  })
  const embeddedFonts = fontTable.value
    ? await outcomeOf(async () =>
        (await readEmbeddedFonts(zip, fontTable.value!)).map(({ data, ...font }) => ({
          ...font,
          length: data.length,
          hash: fnv1a(data),
        })),
      )
    : null

  return {
    mainPath: mainPath.outcome,
    documentRels,
    relationships,
    targets,
    contentTypes: await outcomeOf(() => contentTypesOf(zip)),
    theme: theme.outcome,
    styles: styles.outcome,
    headingStyles,
    numbering: await outcomeOf(() => parseNumbering(zip)),
    fontTable: fontTable.outcome,
    embeddedFonts,
    comments: await outcomeOf(() => parseComments(zip)),
    protection: await outcomeOf(() => parseProtection(zip)),
    writeProtection: await outcomeOf(() => parseWriteProtection(zip)),
    removePersonalInfo: await outcomeOf(() => parseRemovePersonalInfo(zip)),
  }
}

async function typescriptEntries(zip: JSZip): Promise<Entry[]> {
  const entries: Entry[] = []
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) {
      entries.push({ name, dir: true })
      continue
    }
    try {
      const bytes = await file.async('uint8array')
      entries.push({ name, dir: false, length: bytes.length, hash: fnv1a(bytes) })
    } catch (error) {
      entries.push({
        name,
        dir: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return entries
}

export async function typescriptOpen(docx: Uint8Array): Promise<Opened> {
  let zip: JSZip
  try {
    zip = await loadDocxZip(docx)
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) }
  }
  return { entries: await typescriptEntries(zip), model: await typescriptModel(zip) }
}

export function rustOpen(docx: Uint8Array): Opened {
  const { header } = engine.call<{ package: Opened }>({ cmd: 'package' }, [docx])
  if (failed(header)) throw new Error(`package failed: ${header.error.message}`)
  return header.package
}

/**
 * One loader on a container, in a child process: the only way to see that it
 * does not return. A loader that hangs or dies gives a result that says so
 * instead of hanging or ending the gate. Two loaders that fail alike give the
 * same result, so a caller that expects an answer has to name it.
 *
 * `host: 'node'` runs the TypeScript loader on Node as it is, without what
 * host.ts does to it.
 */
export function openOnce(
  side: 'typescript' | 'rust',
  docx: Uint8Array,
  host: 'product' | 'node' = 'product',
): unknown {
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'load-once.ts', side], {
    cwd: toolDir,
    input: docx,
    timeout: 5_000,
    encoding: 'utf8',
    env: host === 'node' ? { ...process.env, [RAW_HOST_ENV]: '1' } : process.env,
  })
  if (child.error || child.signal) return 'does not return within 5 s'
  if (child.status !== 0 || child.stdout.trim() === '') {
    return `ends with status ${child.status} and no result: ${child.stderr.trim().split('\n').at(-1)}`
  }
  return JSON.parse(child.stdout) as unknown
}

/** A package given as named texts: the readers without the zip container. */
export async function typescriptParts(parts: Array<[string, string]>): Promise<Model> {
  const zip = new JSZip()
  for (const [name, text] of parts) zip.file(name, text)
  return typescriptModel(zip)
}

export function rustParts(parts: Array<[string, string]>): Model {
  const { header } = engine.call<{ package: Opened }>({
    cmd: 'packageParts',
    parts: parts.map(([name, text]) => ({ name, text })),
  })
  if (failed(header)) throw new Error(`packageParts failed: ${header.error.message}`)
  if ('refused' in header.package) throw new Error('packageParts refused')
  return header.package.model
}

/**
 * The gate appends the host's own text to "cannot be inflated": Node gives
 * the bare name TypeError, a browser something else, Rust its own sentence.
 * Only what the TypeScript wrote itself is compared.
 */
const withoutHostText = (message: string): string =>
  message.replace(/(cannot be inflated:).*$/s, '$1')

const brief = (value: unknown): string => {
  const text = JSON.stringify(value) ?? 'undefined'
  return text.length > 600 ? `${text.slice(0, 600)}... (${text.length} characters)` : text
}

/** One place where two JSON values differ, and the two values there. */
export interface PathDifference {
  path: string
  typescript: string
  rust: string
}

/** A value of a package that differs, with every place it differs at. */
export interface ValueDifference {
  comparison: string
  where: string
  value: string
  paths: PathDifference[]
}

/** Every differing value of the run, for the report file. */
const pathReport: ValueDifference[] = []
export const PATH_REPORT = resolve(toolDir, 'out/package-paths.json')

/**
 * Every place where two JSON values differ, as a path and the two values
 * there, in the order of the keys. A key on one side only is one place.
 */
function differingPaths(typescript: unknown, rust: unknown, path = ''): PathDifference[] {
  if (
    typescript !== null &&
    rust !== null &&
    typeof typescript === 'object' &&
    typeof rust === 'object' &&
    Array.isArray(typescript) === Array.isArray(rust)
  ) {
    const [left, right] = [new Map(Object.entries(typescript)), new Map(Object.entries(rust))]
    const inner = [...new Set([...left.keys(), ...right.keys()])].flatMap((key) => {
      const [a, b]: unknown[] = [left.get(key), right.get(key)]
      return isDeepStrictEqual(a, b) ? [] : differingPaths(a, b, `${path}/${key}`)
    })
    if (inner.length > 0) return inner
  }
  return [{ path: path || '/', typescript: brief(typescript), rust: brief(rust) }]
}

/**
 * A difference as the report prints it: the first place in full, then the
 * count of places and the first SHOW of them. The report file holds all.
 */
function describeDifference(
  comparison: Comparison,
  where: string,
  value: string,
  typescript: unknown,
  rust: unknown,
): string {
  const paths = differingPaths(typescript, rust)
  pathReport.push({ comparison: comparison.label, where, value, paths })
  const [first] = paths as [PathDifference]
  const listed = paths.slice(0, SHOW).map(({ path }) => path)
  const more = paths.length > SHOW ? `, ... ${paths.length - SHOW} more in ${PATH_REPORT}` : ''
  return (
    `${where}: ${value} at ${first.path}\n      typescript ${first.typescript}\n      rust       ${first.rust}` +
    (paths.length > 1 ? `\n      ${paths.length} paths differ: ${listed.join(', ')}${more}` : '')
  )
}

/** Writes every differing value of the run with all its places, and says where. */
export function writePathReport(): void {
  const paths = pathReport.reduce((sum, { paths }) => sum + paths.length, 0)
  mkdirSync(dirname(PATH_REPORT), { recursive: true })
  writeFileSync(
    PATH_REPORT,
    JSON.stringify({ values: pathReport.length, paths, differences: pathReport }, null, 2) + '\n',
  )
  console.log(
    `(e) package values that differ: ${pathReport.length}, at ${paths} paths, every one in ${PATH_REPORT}`,
  )
}

/** The values compared as one check each; `relationships` is one check per part. */
const MODEL_VALUES = [
  'mainPath',
  'documentRels',
  'targets',
  'contentTypes',
  'theme',
  'styles',
  'headingStyles',
  'numbering',
  'fontTable',
  'embeddedFonts',
  'comments',
  'protection',
  'writeProtection',
  'removePersonalInfo',
] as const satisfies ReadonlyArray<keyof Model>

const threw = (outcome: unknown): boolean =>
  outcome !== null && typeof outcome === 'object' && 'error' in outcome

/** An outcome that threw on the TypeScript side must be an error in Rust; a value must be equal. */
function sameOutcome(typescript: unknown, rust: unknown): boolean {
  return threw(typescript) ? threw(rust) : isDeepStrictEqual(typescript, rust)
}

export function compareModels(
  comparison: Comparison,
  where: string,
  typescript: Model,
  rust: Model,
): void {
  const check = (name: string, left: unknown, right: unknown): void => {
    if (threw(left)) comparison.typescriptThrew += 1
    if (!sameOutcome(left, right)) {
      comparison.record(describeDifference(comparison, where, name, left, right))
      return
    }
    const order = threw(left) ? null : keyOrderDifference(`package ${name}`, left, right)
    comparison.record(order === null ? null : `${where}: ${name} ${order}`, order !== null)
  }
  for (const key of MODEL_VALUES) check(key, typescript[key], rust[key])
  const parts = Math.max(typescript.relationships.length, rust.relationships.length)
  for (let index = 0; index < parts; index++) {
    const [left, right] = [typescript.relationships[index], rust.relationships[index]]
    if (left?.[0] !== right?.[0]) check('relationships part', left?.[0], right?.[0])
    else check(`relationships of ${left?.[0]}`, left?.[1], right?.[1])
  }
}

/**
 * One check for the container: both sides refuse with the same message, or
 * both open it to the same entries. The models are compared when it opens.
 */
export async function comparePackage(
  opened: Comparison,
  values: Comparison,
  where: string,
  docx: Uint8Array,
): Promise<Opened> {
  const typescript = await typescriptOpen(docx)
  const rust = rustOpen(docx)
  if ('refused' in typescript || 'refused' in rust) {
    if ('refused' in typescript) opened.typescriptThrew += 1
    const same =
      'refused' in typescript &&
      'refused' in rust &&
      withoutHostText(typescript.refused) === withoutHostText(rust.refused)
    opened.record(
      same
        ? null
        : `${where}: typescript ${'refused' in typescript ? `refuses: ${typescript.refused}` : 'opens it'}; ` +
            `rust ${'refused' in rust ? `refuses: ${rust.refused}` : 'opens it'}`,
    )
    return typescript
  }
  // what reading a damaged entry throws is compared by presence
  const entryErrorsAsFlags = (entries: Entry[]): Entry[] =>
    entries.map((entry) => (entry.error === undefined ? entry : { ...entry, error: 'throws' }))
  const [typescriptFlagged, rustFlagged] = [
    entryErrorsAsFlags(typescript.entries),
    entryErrorsAsFlags(rust.entries),
  ]
  const same = isDeepStrictEqual(typescriptFlagged, rustFlagged)
  const order = same
    ? keyOrderDifference('package entries', typescript.entries, rust.entries)
    : null
  opened.record(
    !same
      ? describeDifference(opened, where, 'entries', typescriptFlagged, rustFlagged)
      : order === null
        ? null
        : `${where}: entries ${order}`,
    order !== null,
  )
  compareModels(values, where, typescript.model, rust.model)
  return typescript
}

/** normalizeOoxmlXml and needsOoxmlNormalization over a batch of parts. */
export function compareNormalized(comparison: Comparison, where: string, parts: string[]): void {
  if (parts.length === 0) return
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const { header, blobs } = engine.call<{ needed: boolean[] }>(
    { cmd: 'normalizeOoxml' },
    parts.map((part) => encoder.encode(part)),
  )
  if (failed(header)) throw new Error(`normalizeOoxml failed: ${header.error.message}`)
  parts.forEach((part, index) => {
    const typescript = normalizeOoxmlXml(part)
    const rust = decoder.decode(blobs[index]!)
    const needed = needsOoxmlNormalization(part)
    comparison.record(
      needed !== header.needed[index]
        ? `${where} part ${index}: needsOoxmlNormalization is ${needed}, Rust says ${header.needed[index]}`
        : typescript === rust
          ? null
          : `${where} part ${index}: ${describeTextDifference(typescript, rust)}`,
    )
  })
}
