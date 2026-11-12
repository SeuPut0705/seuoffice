// Comparison (i) saveDocx: the Rust save against the TypeScript one. For each
// corpus document, the TypeScript parseDocx model is saved by both
// (`saveDocx` of patch.ts and `Command::SaveDocx`), once per variant of what
// the editor may ask, and the two packages are compared entry by entry: the
// names (in order), the text of every .xml and .rels entry, the bytes of the
// rest (an embedded workbook by its own entries, whose zip dates differ).
// The same variants run on edited models of blank documents.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import JSZip from 'jszip'
import { buildBlankDocx } from './reference/blank'
import { parseDocx } from './reference/parse'
import { saveDocx, type ParsedDocFull, type SaveBlock, type SaveOptions } from './reference/patch'
import type { Block, GeneratedBlock } from './reference/types'
import { failed } from './engine'
import { Comparison, describeTextDifference, engine } from './harness'
import { modelJson } from './model-wire'

const encode = new TextEncoder()
const decode = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Pinned: the TypeScript reads the clock where an option is absent. */
const SAVED_AT = '2024-05-06T07:08:09.123Z'
/** Documents the comparison must reach: the corpus is 185 files, some of them encrypted. */
const DOCUMENT_FLOOR = 100

const documents = new Comparison('(i) saveDocx, corpus documents saved', DOCUMENT_FLOOR)
const variantsRun = new Map<string, Comparison>()
const blankVariants = new Map<string, Comparison>()
const refusals: string[] = []

function population(into: Map<string, Comparison>, label: string): Comparison {
  let known = into.get(label)
  if (!known) {
    known = new Comparison(`(i) saveDocx, ${label}`, 1)
    into.set(label, known)
  }
  return known
}

// ---------------------------------------------------------------- the variants

interface Variant {
  name: string
  blocks: SaveBlock[]
  options: SaveOptions
}

const GENERATED_KEYS = [
  'type',
  'level',
  'outlineOnly',
  'styleId',
  'list',
  'format',
  'rawPPr',
  'bookmarks',
  'hiddenBookmarks',
  'commentStarts',
  'commentEnds',
  'runs',
  'sdtShell',
  'pPrChange',
  'paraMarkDel',
  'paraMarkIns',
  'paraMarkRPrChange',
  'blockRevision',
] as const

/** The GeneratedBlock of a text block the editor rebuilt from its model. */
function generatedOf(block: Block): GeneratedBlock | undefined {
  if (block.type !== 'paragraph' && block.type !== 'heading' && block.type !== 'listItem') return undefined
  if (!block.runs) return undefined
  const out: Record<string, unknown> = {}
  for (const key of GENERATED_KEYS) {
    const value = (block as unknown as Record<string, unknown>)[key]
    if (value !== undefined) out[key] = value
  }
  return out as unknown as GeneratedBlock
}

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const originals = (doc: ParsedDocFull): SaveBlock[] =>
  doc.blocks.filter((b) => !b.hidden).map((b): SaveBlock => ({ kind: 'original', docxIndex: b.docxIndex as number }))

const SECTION = {
  pageWidth: 11906,
  pageHeight: 16838,
  orientation: 'portrait' as const,
  marginTop: 1134,
  marginRight: 1134,
  marginBottom: 1134,
  marginLeft: 1134,
  pageBorder: false,
  columns: 2,
  colSpace: 500,
}

/** What the editor may ask of a document, one variant per family of options. */
function variantsOf(doc: ParsedDocFull): Variant[] {
  const visible = doc.blocks.filter((b) => !b.hidden)
  const base = originals(doc)
  const regenerated: SaveBlock[] = visible.map((b, index): SaveBlock => {
    const block = index % 2 === 0 ? generatedOf(b) : undefined
    return block ? { kind: 'generated', block, docxIndex: b.docxIndex as number } : base[index]!
  })
  const inserted: SaveBlock[] = [
    ...base.slice(0, 1),
    { kind: 'xml', xml: '<w:p><w:r><w:t>inserted fragment</w:t></w:r></w:p>' },
    { kind: 'image', image: { base64: PNG, mime: 'image/png', widthPx: 24, heightPx: 12, altText: 'dot' } },
    { kind: 'images', images: [
      { base64: PNG, mime: 'image/png', widthPx: 10, heightPx: 10, wrap: 'square-left', posOffsetEmu: { x: 100, y: 200 } },
      { base64: PNG, mime: 'image/png', widthPx: 12, heightPx: 12, wrap: 'behind', posH: 'center', posV: 'top', zOrder: 3 },
    ] },
    { kind: 'chart', chart: { kind: 'bar', title: 'T', categories: ['a', 'b'], series: [{ name: 's', values: [1, null] }] }, extentPx: { w: 300, h: 200 } },
    {
      kind: 'generated',
      block: { type: 'heading', level: 3, runs: [{ text: 'A new heading' }, { text: ' link', link: 'https://example.com/a?b=1&c=2' }], bookmarks: ['bm1'] } as unknown as GeneratedBlock,
    },
    { kind: 'generated', block: { type: 'listItem', list: { kind: 'bullet', numId: '1', ilvl: 0 }, runs: [{ text: 'item', bold: true }] } },
    ...base.slice(1),
  ]
  const revised: SaveBlock[] = base.map((b, index): SaveBlock => {
    const block = visible[index] ? generatedOf(visible[index]!) : undefined
    if (index !== 0 || !block) return b
    return { kind: 'generated', block, docxIndex: visible[index]!.docxIndex as number, revision: { kind: 'ins', author: 'Ann', date: '2024-01-02T03:04:05Z', id: '' } }
  })
  const firstTwo = visible.slice(0, 2).map((b) => b.docxIndex as number)
  return [
    { name: 'unchanged', blocks: base, options: {} },
    { name: 'touched', blocks: base, options: { savedAt: SAVED_AT, trackRevisions: doc.trackRevisions ?? false, mirrorMargins: doc.mirrorMargins ?? false, evenAndOddHeaders: doc.evenAndOddHeaders ?? false } },
    { name: 'regenerated blocks', blocks: regenerated, options: { savedAt: SAVED_AT } },
    { name: 'inserted blocks', blocks: inserted, options: { savedAt: SAVED_AT, pageCount: 3 } },
    { name: 'tracked insertion', blocks: revised, options: { savedAt: SAVED_AT, revisionIdFloor: 500 } },
    {
      name: 'comments, notes and sources',
      blocks: base,
      options: { savedAt: SAVED_AT, comments: doc.comments, footnotes: doc.footnotes, endnotes: doc.endnotes, sources: doc.sources },
    },
    {
      name: 'headers and footers',
      blocks: base,
      options: {
        savedAt: SAVED_AT,
        header: { text: 'Header text' },
        footer: { text: 'Footer', pageNumber: true },
        headerFirst: { text: 'First header' },
        footerEven: { text: 'Even footer' },
        titlePg: true,
        evenAndOddHeaders: true,
        hfAllSections: true,
      },
    },
    { name: 'text watermark', blocks: base, options: { savedAt: SAVED_AT, watermark: 'DRAFT' } },
    { name: 'watermark removed', blocks: base, options: { savedAt: SAVED_AT, watermark: null } },
    {
      name: 'page setup',
      blocks: base,
      options: { savedAt: SAVED_AT, section: SECTION, pgNumType: { fmt: 'decimal', start: 3 }, pageColor: 'FFFF00', sectionStartType: 'continuous' },
    },
    {
      name: 'numbering',
      blocks: base,
      options: {
        savedAt: SAVED_AT,
        numbering: {
          newDefs: [{ numId: '900', kind: 'bullet' }, { numId: '901', kind: 'ordered' }],
          restartNums: [{ numId: '902', abstractNumId: '0', startOverrides: { 0: 3 } }],
          picBullets: [{ id: 7, base64: PNG, mime: 'image/png' }],
        },
      },
    },
    {
      name: 'styles and theme',
      blocks: base,
      options: {
        savedAt: SAVED_AT,
        styleUpserts: [{ styleId: 'Brand', name: 'Brand', rPr: { bold: true } }],
        themeFonts: { major: 'Arial', minor: 'Times New Roman', eastAsia: '' },
        themeColors: { accent1: 'FF0000' },
      },
    },
    {
      name: 'protection and personal information',
      blocks: base,
      options: {
        savedAt: SAVED_AT,
        protection: { edit: 'readOnly', enforced: true },
        writeProtection: null,
        removePersonalInfo: true,
        properties: { core: { title: 'Saved title' } },
      },
    },
    { name: 'zotero data', blocks: base, options: { savedAt: SAVED_AT, zoteroDocumentData: '<data data-version="3"/>' } },
    {
      name: 'content controls',
      blocks: base,
      options: { savedAt: SAVED_AT, contentControls: { wrap: [{ docxIndexes: firstTwo, spec: { tag: 'wrapped', title: 'Wrapped' } }], unwrap: [{ tag: 'none' }] } },
    },
    { name: 'inks', blocks: base, options: { savedAt: SAVED_AT, inks: [{ blockIndex: 0, base64: PNG, widthPx: 20, heightPx: 20, offsetXPx: 5, offsetYPx: 6 }] } },
    { name: 'move ranges and parts removed', blocks: base, options: { savedAt: SAVED_AT, dropOrphanMoveRanges: true, removeParts: { kinds: ['customXml'] } } },
  ]
}

// ---------------------------------------------------------------- comparing packages

const TEXT_ENTRY = /\.(?:xml|rels)$/i

async function entriesOf(bytes: Uint8Array): Promise<Map<string, JSZip.JSZipObject>> {
  const zip = await JSZip.loadAsync(bytes)
  return new Map(Object.entries(zip.files))
}

/** The first way two saved packages differ, or null. */
async function packageDifference(typescript: Uint8Array, rust: Uint8Array): Promise<string | null> {
  const own = await entriesOf(typescript)
  const theirs = await entriesOf(rust)
  const ownNames = [...own.keys()]
  const theirNames = [...theirs.keys()]
  if (ownNames.join('\n') !== theirNames.join('\n')) {
    const missing = ownNames.filter((name) => !theirs.has(name))
    const extra = theirNames.filter((name) => !own.has(name))
    return `entries differ: only TypeScript ${JSON.stringify(missing)}, only Rust ${JSON.stringify(extra)}${missing.length + extra.length === 0 ? ', same names in another order' : ''}`
  }
  for (const [name, entry] of own) {
    const other = theirs.get(name)!
    if (entry.dir !== other.dir) return `${name}: folder entry on one side only`
    if (entry.dir) continue
    if (TEXT_ENTRY.test(name)) {
      const a = await entry.async('string')
      const b = await other.async('string')
      if (a !== b) return `${name}: ${describeTextDifference(a, b)}`
      continue
    }
    const a = await entry.async('uint8array')
    const b = await other.async('uint8array')
    if (/\.xlsx$/i.test(name)) {
      const inner = await packageDifference(a, b)
      if (inner !== null) return `${name}: ${inner}`
      continue
    }
    if (a.length !== b.length || Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0) {
      return `${name}: bytes differ (${a.length} against ${b.length})`
    }
  }
  return null
}

interface RustSave {
  bytes?: Uint8Array
  error?: string
}

function rustSave(docx: Uint8Array, model: string, variant: Variant, nowMs: number): RustSave {
  const reply = engine.call<{ model: boolean }>(
    { cmd: 'saveDocx', blocks: variant.blocks, options: variant.options, nowMs },
    [docx, encode.encode(model)],
  )
  if (failed(reply.header)) return { error: `${reply.header.error.code}: ${reply.header.error.message}` }
  if (!reply.header.model || reply.blobs.length !== 1) throw new Error('invalid saveDocx reply')
  return { bytes: reply.blobs[0]! }
}

/** The model as JSON, its `internal.originalBytes` left to blob 0. */
function modelWithoutBytes(doc: ParsedDocFull): string {
  const model = JSON.parse(modelJson(doc)) as { internal: { originalBytes: unknown } }
  model.internal.originalBytes = { $bytes: '' }
  return JSON.stringify(model)
}

async function compareVariant(
  into: Comparison,
  where: string,
  doc: ParsedDocFull,
  docx: Uint8Array,
  model: string,
  variant: Variant,
): Promise<void> {
  const nowMs = Date.now()
  let typescript: Uint8Array | undefined
  let thrown: string | undefined
  try {
    typescript = await saveDocx(doc, variant.blocks, variant.options)
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  }
  const rust = rustSave(docx, model, variant, nowMs)
  const label = `${where} [${variant.name}]`
  if (thrown !== undefined || rust.error !== undefined) {
    // a refusal is compared by presence
    if (thrown !== undefined && rust.error !== undefined) {
      into.record(null)
      return
    }
    into.record(thrown !== undefined ? `${label}: only TypeScript refused: ${thrown}` : `${label}: only Rust refused: ${rust.error}`)
    if (rust.error !== undefined) refusals.push(`${label}: ${rust.error}`)
    return
  }
  into.record((await packageDifference(typescript!, rust.bytes!)) === null ? null : `${label}: ${await packageDifference(typescript!, rust.bytes!)}`)
}

/** `doc` is what the TypeScript parseDocx returned for `bytes`. */
export async function saveOnDocument(where: string, bytes: Uint8Array, doc: ParsedDocFull): Promise<void> {
  const model = modelWithoutBytes(doc)
  documents.record(null)
  for (const variant of variantsOf(doc)) {
    await compareVariant(population(variantsRun, variant.name), where, doc, bytes, model, variant)
  }
}

// ---------------------------------------------------------------- blank documents, edited

const BLANK_OPTIONS = [
  {},
  { paperSize: 'letter' as const },
  { eastAsiaFont: 'MS Gothic', omitGeneratorFields: true },
]

/** Edited models of blank documents: what the corpus does not hold. */
export async function saveAfterCorpus(): Promise<void> {
  for (const [index, options] of BLANK_OPTIONS.entries()) {
    const docx = await buildBlankDocx({ ...options, createdAt: new Date(Date.UTC(2024, 0, 1)) } as Parameters<typeof buildBlankDocx>[0])
    const doc = (await parseDocx(docx)) as ParsedDocFull
    const where = `blank document ${index}`
    const model = modelWithoutBytes(doc)
    for (const variant of variantsOf(doc)) {
      await compareVariant(population(blankVariants, variant.name), where, doc, docx, model, variant)
    }
    // an edit round trip: the saved document reopened, edited and saved again
    const saved = await saveDocx(doc, variantsOf(doc)[3]!.blocks, { savedAt: SAVED_AT })
    const again = (await parseDocx(saved)) as ParsedDocFull
    const reopened = modelWithoutBytes(again)
    for (const variant of variantsOf(again)) {
      await compareVariant(population(blankVariants, `reopened, ${variant.name}`), `${where} reopened`, again, saved, reopened, variant)
    }
  }
}

/** `--report FILE`: what each population compared and where the two differ. */
export function reportSave(): void {
  const at = process.argv.indexOf('--report')
  if (at === -1) return
  const path = resolve(process.argv[at + 1]!).replace(/(\.json)?$/, '.save.json')
  const line = (comparison: Comparison) => ({
    label: comparison.label,
    compared: comparison.compared,
    differences: comparison.differences.length,
    first: comparison.differences.slice(0, 20),
  })
  const report = {
    documents: line(documents),
    variants: [...variantsRun.values()].map(line),
    blank: [...blankVariants.values()].map(line),
    refusals,
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: process.argv.includes('--first') ? 'wx' : 'w' })
}
