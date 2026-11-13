/**
 * Group `b5-agent`, part `generate`: `apps/shell/src/main/generate/*` (the
 * generate window, its session, the materials, the request checks and the
 * conversions without AI), the runtime parts of `shared/generate-api.ts`,
 * `generate-home-channels.ts` and `generate-default-prompts.ts`, and
 * `packages/file-parse/src/attachable.ts` (`file-parse/attachable.<export>`).
 *
 * Names are `<ts-file>.<export>`. A function that drives a fake is a scenario:
 * the first argument is an object of what the fakes answer and a list of
 * `steps`, the answer is one entry per step, and each call of a fake is one
 * log line that the Rust fakes write the same way.
 *
 * The engines the generate modules import are not loadable here and are not
 * held by main-core: `@seuoffice/file-parse` (`parseFileToText`),
 * `@seuoffice/xmind-engine`, `@seuoffice/pptx-engine`, `@seuoffice/pptx-ops`
 * and `../mcp/pptx-outline` are answered by stubs, for importers inside
 * `apps/shell/src/main/generate` only, that follow the case's `engine`:
 *
 * - `parse`: by path, the answer of `parseFileToText` (`{ ok, error?, kind?,
 *   text? }`), or `{ throws: true }`; each call logs `['parse', path]`.
 * - `root`: the first sheet's root topic of the map reader (`outlineToSheets`;
 *   logs `['outlineToSheets', text, untitled]`), `{ throws: true }` for a
 *   reader that throws. `createThrows`: `createXmindDocumentFromOutline`
 *   (logs `['createXmind', text, untitled]`) throws.
 * - `slides`: `{ count, throws? }` the slides `parsePptxOutline` makes (logs
 *   `['parsePptxOutline', text]`); `MAX_OUTLINE_SLIDES` is 3. `outlineToOps`
 *   makes one op `op<i>` per slide (logs `['outlineToOps', count]`).
 * - `blankThrows`, `txn`: `createBlankPptx`/`openPptx` (log `['openPptx']`)
 *   throw; `runTxn` (logs `['runTxn', op]`) answers per op name `{ applied:
 *   false, failures? }` or `{ throws: true }`, applied otherwise. A saved deck
 *   is the bytes `de c0 <ops applied>`.
 *
 * A `Uint8Array` crosses as its hex text. `Date.now()` is the clock of the
 * call. The window's renderer strings are read from the real
 * `generateText` and handed to Rust in the case.
 */
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { dirname } from 'node:path'
import { useElectron } from '../electron-fake.ts'
import type { Case, FnSpec, Group, TsContext } from '../types.ts'

// ---------------------------------------------------------------------------
// the stubs of the engines
// ---------------------------------------------------------------------------

interface Engine {
  parse?: Record<string, unknown>
  root?: Record<string, unknown>
  createThrows?: boolean
  slides?: { count: number; throws?: boolean }
  blankThrows?: boolean
  txn?: Record<string, Record<string, unknown>>
}

interface Box {
  engine: Engine
  log: (...line: unknown[]) => void
  parse: (path: string) => Promise<unknown>
}

const BOX_KEY = Symbol.for('main-diff.generate')
/** a table entry by the path, or by the file name when the case's folder is not known */
function byPath<T>(table: Record<string, T> | undefined, path: string): T | undefined {
  return table?.[path] ?? table?.[path.slice(path.lastIndexOf('/') + 1)]
}

const box: Box = {
  engine: {},
  log: () => {},
  parse: async (path) => {
    box.log('parse', path)
    const spec = byPath(box.engine.parse, path) as Json | undefined
    if (!spec || spec.throws) throw new Error('parse failed')
    return spec
  },
}
;(globalThis as unknown as Record<symbol, Box>)[BOX_KEY] = box

const attachableUrl = new URL('../../../packages/file-parse/src/attachable.ts', import.meta.url)
  .href

const STUB_URLS: Record<string, string> = {
  '@seuoffice/file-parse': 'main-diff-generate:file-parse',
  '@seuoffice/xmind-engine': 'main-diff-generate:xmind-engine',
  '@seuoffice/pptx-engine': 'main-diff-generate:pptx-engine',
  '@seuoffice/pptx-ops': 'main-diff-generate:pptx-ops',
  '../mcp/pptx-outline': 'main-diff-generate:pptx-outline',
}

const BOX_LINE = `const box = globalThis[Symbol.for('main-diff.generate')]`
const STUB_SOURCES: Record<string, string> = {
  'main-diff-generate:file-parse': [
    BOX_LINE,
    `export { ATTACHABLE_EXTS, attachableMaxBytes } from ${JSON.stringify(attachableUrl)}`,
    `export const parseFileToText = (path) => box.parse(path)`,
  ].join('\n'),
  'main-diff-generate:xmind-engine': [
    BOX_LINE,
    `export const OUTLINE_KIND_MARKS = { summary: '(summary)', callout: '(callout)', floating: '(floating)', other: '(other)', boundary: '(boundary)', relationship: '(relationship)' }`,
    `export function outlineToSheets(text, options) {`,
    `  box.log('outlineToSheets', text, options.untitled)`,
    `  const root = box.engine.root`,
    `  if (root && root.throws) throw new Error('outline failed')`,
    `  return root ? [{ rootTopic: root }] : []`,
    `}`,
    `export async function createXmindDocumentFromOutline(text, options) {`,
    `  box.log('createXmind', text, options.untitled)`,
    `  if (box.engine.createThrows) throw new Error('create failed')`,
    `}`,
  ].join('\n'),
  'main-diff-generate:pptx-engine': [
    BOX_LINE,
    `export async function createBlankPptx() { return { blank: true } }`,
    `export async function openPptx() {`,
    `  box.log('openPptx')`,
    `  if (box.engine.blankThrows) throw new Error('blank failed')`,
    `  return { applied: 0 }`,
    `}`,
    `export async function savePptx(opened) { return Uint8Array.from([0xde, 0xc0, opened.applied]) }`,
  ].join('\n'),
  'main-diff-generate:pptx-ops': [
    BOX_LINE,
    `export function runTxn(opened, request) {`,
    `  const op = request.ops[0]`,
    `  box.log('runTxn', op.op)`,
    `  const spec = (box.engine.txn || {})[op.op]`,
    `  if (spec && spec.throws) throw new Error('txn failed')`,
    `  if (spec) return spec`,
    `  opened.applied += 1`,
    `  return { applied: true }`,
    `}`,
  ].join('\n'),
  'main-diff-generate:pptx-outline': [
    BOX_LINE,
    `export const MAX_OUTLINE_SLIDES = 3`,
    `export function parsePptxOutline(format, text) {`,
    `  box.log('parsePptxOutline', text)`,
    `  const spec = box.engine.slides || { count: 1 }`,
    `  if (spec.throws) throw new Error('outline parse failed')`,
    `  return Array.from({ length: spec.count }, (_, i) => ({ title: 's' + i, paragraphs: [] }))`,
    `}`,
    `export function outlineToOps(slides) {`,
    `  box.log('outlineToOps', slides.length)`,
    `  return slides.map((_, i) => ({ op: 'op' + i }))`,
    `}`,
  ].join('\n'),
}

registerHooks({
  resolve(specifier, context, next) {
    const stub = STUB_URLS[specifier]
    if (stub && context.parentURL?.includes('/apps/shell/src/main/generate/')) {
      return { url: stub, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    const source = STUB_SOURCES[url]
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return next(url, context)
  },
})

// loaded after the hooks are in place
const limits = await import('../../../apps/shell/src/main/generate/limits.ts')
const titleBar = await import('../../../apps/shell/src/main/generate/title-bar.ts')
const api = await import('../../../apps/shell/src/shared/generate-api.ts')
const prompts = await import('../../../apps/shell/src/shared/generate-default-prompts.ts')
const homeChannels = await import('../../../apps/shell/src/shared/generate-home-channels.ts')
const materials = await import('../../../apps/shell/src/main/generate/materials.ts')
const request = await import('../../../apps/shell/src/main/generate/request.ts')
const openMaterials = await import('../../../apps/shell/src/main/generate/open-materials.ts')
const convert = await import('../../../apps/shell/src/main/generate/convert.ts')
const convertedTab = await import('../../../apps/shell/src/main/generate/converted-tab.ts')
const sessionModule = await import('../../../apps/shell/src/main/generate/session.ts')
const generateWindow = await import('../../../apps/shell/src/main/generate/generate-window.ts')
const handoff = await import('../../../packages/electron-utils/src/generate-handoff.ts')
const unsaved = await import('../../../packages/electron-utils/src/unsaved-files.ts')
const markdownSeed = await import('../../../apps/markdown/src/main/seed-main.ts')
const mindmapSeed = await import('../../../apps/mindmap/src/main/seed-main.ts')
const slidesSeed = await import('../../../apps/slides/src/main/seed-queue.ts')
const strings = await import('../../../apps/shell/src/renderer/src/i18n/strings-generate.ts')
const attachable = await import('../../../packages/file-parse/src/attachable.ts')

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Fn = (...args: never[]) => unknown
type Json = Record<string, unknown>

const each = (...sets: unknown[][]): Case[] => sets.map((args): Case => ({ args }))
const constant = (why: string, ts: () => unknown): FnSpec => ({
  ts,
  cases: [{ args: [] }],
  single: why,
})

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/** the engine of the case answers the stubs while `run` runs */
async function withEngine<T>(engine: Engine | undefined, cx: TsContext, run: () => Promise<T>) {
  box.engine = engine ?? {}
  box.log = cx.log
  try {
    return await run()
  } finally {
    box.engine = {}
    box.log = () => {}
  }
}

/** `Date.now()` of the call */
async function withNow<T>(now: number, run: () => Promise<T>): Promise<T> {
  const real = Date.now
  Date.now = () => now
  try {
    return await run()
  } finally {
    Date.now = real
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** the answer of a step that threw: its message */
async function guarded(run: () => unknown): Promise<unknown> {
  try {
    return await run()
  } catch (error) {
    return { error: message(error) }
  }
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const STATUS = (over: Json = {}): Json => ({
  key: '/m/a.txt',
  name: 'a.txt',
  path: '/m/a.txt',
  ext: 'txt',
  unsaved: false,
  textLength: 10,
  sizeBytes: 100,
  ...over,
})

const generateNoticeCases = each(
  ['slides', 0],
  ['slides', 8000],
  ['slides', 8001],
  ['html', 8001],
  ['mindmap', 8001],
  ['mindmap', 100000],
  ['mindmap', 100001],
  ['slides', 250000],
)

const maxBytesCases = each(['png'], ['PNG'], ['docx'], ['pdf'], ['txt'], [''], ['.png'], ['zzz'])

const extCases = each(
  ['/a/b/Report.TXT'],
  ['/a/b/noext'],
  ['/a/b/.bashrc'],
  ['/a/b/archive.tar.gz'],
  ['/a/dir.d/file'],
  ['/a/b/slides.PPTX'],
  ['C:\\x\\y.md'],
  [''],
)

const keyCases = each(
  ['/x/y/../z.txt'],
  ['/x//y.md'],
  ['/x/./y'],
  ['/Mixed/Case.TXT'],
  ['/trailing/'],
)

const untitledCases = each([3, 'Untitled 1'], [0, ''], [1.5, 'x'], [-1, 'Doc'])

// summarizeMaterials ---------------------------------------------------------

const summaryCases = each(
  [[], 'slides'],
  [[STATUS()], 'slides'],
  [[STATUS({ textLength: 9000 })], 'slides'],
  [[STATUS({ textLength: 9000 })], 'mindmap'],
  [
    [
      STATUS({ textLength: 60000 }),
      STATUS({ key: '/m/b.txt', path: '/m/b.txt', textLength: 60000 }),
    ],
    'html',
  ],
  [
    [STATUS({ unsaved: true }), STATUS({ key: '/m/b.txt', name: 'b.txt', path: '/m/b.txt' })],
    'slides',
  ],
  [
    [STATUS({ problem: 'missing' }), STATUS({ key: '/m/c.txt', name: 'c.txt', path: '/m/c.txt' })],
    'slides',
  ],
  [[STATUS({ problem: 'unreadable', unsaved: true })], 'slides'],
  [[STATUS({ sizeBytes: undefined })], 'slides'],
  [
    Array.from({ length: 20 }, (_, i) =>
      STATUS({ key: `/m/${i}.txt`, name: `${i}.txt`, path: `/m/${i}.txt` }),
    ),
    'slides',
  ],
  [
    Array.from({ length: 21 }, (_, i) =>
      STATUS({ key: `/m/${i}.txt`, name: `${i}.txt`, path: `/m/${i}.txt` }),
    ),
    'slides',
  ],
  [
    [
      ...Array.from({ length: 20 }, (_, i) =>
        STATUS({ key: `/m/${i}.txt`, name: `${i}.txt`, path: `/m/${i}.txt` }),
      ),
      STATUS({ key: '/m/x.txt', name: 'x.txt', path: '/m/x.txt', problem: 'missing' }),
    ],
    'slides',
  ],
  [
    [
      ...Array.from({ length: 20 }, (_, i) =>
        STATUS({ key: `/m/${i}.txt`, name: `${i}.txt`, path: `/m/${i}.txt` }),
      ),
      STATUS({ key: '/m/x.txt', name: 'x.txt', path: '/m/x.txt', unsaved: true }),
    ],
    'slides',
  ],
)

// ---------------------------------------------------------------------------
// request
// ---------------------------------------------------------------------------

const valueCases = each(
  ['slides'],
  ['html'],
  ['mindmap'],
  ['mindmap-to-markdown'],
  ['markdown-to-mindmap'],
  ['SLIDES'],
  [''],
  [null],
  [1],
  [{ kind: 'slides' }],
  [['slides']],
)

const conversionCases = each(
  [[]],
  [['/a/map.xmind']],
  [['/a/map.XMIND']],
  [['/a/note.md']],
  [['/a/note.markdown']],
  [['/a/note.txt']],
  [['/a/a.xmind', '/a/b.xmind']],
  [['/a/dir/map.xmind.bak']],
)

const longText = 'x'.repeat(32000)
const validateCases = each(
  [null],
  ['text'],
  [[]],
  [{}],
  [{ mode: 'ai' }],
  [{ mode: 'ai', kind: 'pdf', materials: ['/a/b.txt'] }],
  [{ mode: 'convert', kind: 'slides', materials: ['/a/b.xmind'] }],
  [{ mode: 'ai', kind: 'slides' }],
  [{ mode: 'ai', kind: 'slides', materials: [] }],
  [{ mode: 'ai', kind: 'slides', materials: 'nope' }],
  [{ mode: 'ai', kind: 'slides', materials: [7] }],
  [{ mode: 'ai', kind: 'slides', materials: [''] }],
  [{ mode: 'ai', kind: 'slides', materials: ['relative/a.txt'] }],
  [{ mode: 'ai', kind: 'slides', materials: [`/${'a'.repeat(4096)}`] }],
  [{ mode: 'ai', kind: 'slides', materials: [`/${'a'.repeat(4095)}`] }],
  [{ mode: 'ai', kind: 'slides', materials: ['/a/b.txt', '/a/./b.txt', '/a/c.txt'] }],
  [
    {
      mode: 'ai',
      kind: 'html',
      materials: Array.from({ length: 21 }, (_, i) => `/a/${i}.txt`),
    },
  ],
  [
    {
      mode: 'ai',
      kind: 'html',
      materials: Array.from({ length: 20 }, (_, i) => `/a/${i}.txt`),
      text: 'hello',
    },
  ],
  [{ mode: 'ai', kind: 'mindmap', materials: ['/a/b.txt'], text: null }],
  [{ mode: 'ai', kind: 'mindmap', materials: ['/a/b.txt'], text: 5 }],
  [{ mode: 'ai', kind: 'mindmap', materials: ['/a/b.txt'], text: longText }],
  [{ mode: 'ai', kind: 'mindmap', materials: ['/a/b.txt'], text: `${longText}x` }],
  [{ mode: 'convert', kind: 'mindmap-to-markdown', materials: ['/a/b.xmind'] }],
  [{ mode: 'convert', kind: 'mindmap-to-markdown', materials: ['/a/b.xmind'], text: '  \u00a0\n' }],
  [{ mode: 'convert', kind: 'mindmap-to-markdown', materials: ['/a/b.xmind'], text: ' go ' }],
  [{ mode: 'convert', kind: 'mindmap-to-markdown', materials: ['/a/b.xmind', '/a/c.xmind'] }],
  [{ mode: 'convert', kind: 'markdown-to-mindmap', materials: ['/a/b.xmind'] }],
  [{ mode: 'convert', kind: 'markdown-to-mindmap', materials: ['/a/b.MD'], text: '' }],
  [{ mode: 'convert', kind: 'mindmap-to-slides', materials: ['/a/b.xmind', '/a/./b.xmind'] }],
)

interface PrepareScenario {
  inspect: Record<string, Json | { throws: true }>
}

async function runPrepare(raw: unknown, o: PrepareScenario, cx: TsContext) {
  try {
    return await request.prepareGenerateRequest(raw, async (path: string) => {
      cx.log('inspect', path)
      const status = o.inspect[path]
      if (!status || status.throws) throw new Error(`inspect failed: ${path}`)
      return status as never
    })
  } catch (error) {
    return { error: message(error) }
  }
}

const prepareAi = (materials: string[], text: unknown = 'go', kind = 'slides') => ({
  mode: 'ai',
  kind,
  materials,
  text,
})

const prepareCases: Case[] = [
  [
    prepareAi(['/a/b.txt']),
    { inspect: { '/a/b.txt': STATUS({ key: '/a/b.txt', path: '/a/b.txt', name: 'b.txt' }) } },
  ],
  [{ mode: 'nope' }, { inspect: {} }],
  [prepareAi(['relative.txt']), { inspect: {} }],
  [
    prepareAi(['/a/b.txt', '/a/c.txt']),
    {
      inspect: {
        '/a/b.txt': STATUS({ path: '/a/b.txt', name: 'b.txt', problem: 'missing' }),
        '/a/c.txt': STATUS({ path: '/a/c.txt', name: 'c.txt' }),
      },
    },
  ],
  [
    prepareAi(['/a/b.txt', '/a/c.txt']),
    {
      inspect: {
        '/a/b.txt': STATUS({ path: '/a/b.txt', name: 'b.txt', unsaved: true }),
        '/a/c.txt': STATUS({ path: '/a/c.txt', name: 'c.txt', problem: 'too-large' }),
      },
    },
  ],
  [
    prepareAi(['/a/b.txt']),
    {
      inspect: { '/a/b.txt': STATUS({ path: '/a/b.txt', name: 'b.txt', problem: 'unsupported' }) },
    },
  ],
  [
    prepareAi(['/a/b.txt', '/a/c.txt', '/a/d.txt']),
    {
      inspect: {
        '/a/b.txt': { throws: true },
        '/a/c.txt': STATUS({ path: '/a/c.txt' }),
        '/a/d.txt': { throws: true },
      },
    },
  ],
  [
    { mode: 'convert', kind: 'mindmap-to-markdown', materials: ['/a/map.xmind'], text: '' },
    {
      inspect: {
        '/a/map.xmind': STATUS({
          path: '/a/map.xmind',
          name: 'map.xmind',
          ext: 'xmind',
          textLength: 200000,
        }),
      },
    },
  ],
  [
    prepareAi(['/a/b.txt'], 'go', 'html'),
    { inspect: { '/a/b.txt': STATUS({ path: '/a/b.txt', textLength: 9000 }) } },
  ],
].map(([raw, scenario]): Case => ({ args: [raw, scenario] }))

// ---------------------------------------------------------------------------
// inspectMaterial
// ---------------------------------------------------------------------------

interface InspectScenario {
  engine?: Engine
  /** by path, what the injected `stat` answers; absent: the real one */
  stat?: Record<string, { isFile?: boolean; size: number; mtimeMs?: number } | { throws: true }>
  injectParse?: boolean
  /** the shell's open files (`setOpenFilesSource`), or 'throws' for a source that fails; absent: none */
  openFiles?: Array<{ filePath?: string; dirty: boolean }> | 'throws'
  steps: Array<{ inspect: string } | { write: { path: string; text: string; mtimeMs?: number } }>
}

function writeFile(path: string, text: string, mtimeMs?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
}

async function runInspect(o: InspectScenario, cx: TsContext): Promise<unknown[]> {
  return withEngine(o.engine, cx, async () => {
    const results: unknown[] = []
    for (const step of o.steps) {
      if ('write' in step) {
        writeFile(step.write.path, step.write.text, step.write.mtimeMs)
        continue
      }
      const deps: Record<string, unknown> = {}
      const stat = o.stat
      if (stat) {
        deps.stat = async (path: string) => {
          cx.log('stat', path)
          const answer = byPath(stat, path)
          if (!answer || 'throws' in answer) throw new Error('stat failed')
          return { isFile: () => answer.isFile ?? true, size: answer.size, mtimeMs: answer.mtimeMs }
        }
      }
      if (o.injectParse) deps.parse = (path: string) => box.parse(path)
      const files = o.openFiles
      unsaved.setOpenFilesSource(
        files === undefined
          ? null
          : () => {
              if (files === 'throws') throw new Error('open files failed')
              return files
            },
      )
      try {
        results.push(await guarded(() => materials.inspectMaterial(step.inspect, deps as never)))
      } finally {
        unsaved.setOpenFilesSource(null)
      }
    }
    return results
  })
}

const text = (n: number, ch = 'a'): Json => ({ ok: true, kind: 'text', text: ch.repeat(n) })
const MB = 1024 * 1024

const inspectCases: Case[] = [
  {
    // a plain text file: parsed, its length measured
    args: [
      {
        engine: { parse: { '/m/a.txt': text(12) } },
        stat: { '/m/a.txt': { size: 12, mtimeMs: 1000 } },
        injectParse: true,
        steps: [{ inspect: '/m/a.txt' }],
      },
    ],
  },
  {
    // not absolute, unsupported, missing, a folder, too large, a picture over the cap
    args: [
      {
        stat: {
          '/m/dir.txt': { isFile: false, size: 0 },
          '/m/big.txt': { size: 50 * MB + 1 },
          '/m/edge.txt': { size: 50 * MB },
          '/m/big.png': { size: 5 * MB + 1 },
          '/m/pic.png': { size: 5 * MB },
          '/m/huge.pdf': { size: 900 * MB },
          '/m/huge.docx': { size: 900 * MB },
        },
        engine: {
          parse: {
            '/m/edge.txt': text(3),
            '/m/pic.png': { ok: true, kind: 'image' },
            '/m/huge.pdf': text(7),
            '/m/huge.docx': text(1),
          },
        },
        injectParse: true,
        steps: [
          { inspect: 'rel/a.txt' },
          { inspect: '/m/a.exe' },
          { inspect: '/m/gone.txt' },
          { inspect: '/m/dir.txt' },
          { inspect: '/m/big.txt' },
          { inspect: '/m/edge.txt' },
          { inspect: '/m/big.png' },
          { inspect: '/m/pic.png' },
          { inspect: '/m/huge.pdf' },
          { inspect: '/m/huge.docx' },
          { inspect: '/m/' },
          { inspect: '/m/noext' },
          { inspect: '/m/.md' },
        ],
      },
    ],
  },
  {
    // open with unsaved changes: not read; another file, and a clean one, are
    args: [
      {
        stat: {
          '/m/a.md': { size: 5, mtimeMs: 1 },
          '/m/b.md': { size: 5, mtimeMs: 1 },
          '/m/c.md': { size: 5, mtimeMs: 1 },
        },
        openFiles: [
          { filePath: '/m/a.md', dirty: true },
          { filePath: '/m/c.md', dirty: false },
          { dirty: true },
        ],
        engine: { parse: { '/m/a.md': text(5), '/m/b.md': text(5), '/m/c.md': text(7) } },
        injectParse: true,
        steps: [{ inspect: '/m/a.md' }, { inspect: '/m/b.md' }, { inspect: '/m/c.md' }],
      },
    ],
  },
  {
    // the open files cannot be told: counts as unsaved, nothing is read
    args: [
      {
        stat: { '/m/a.md': { size: 5, mtimeMs: 1 } },
        openFiles: 'throws',
        engine: { parse: { '/m/a.md': text(5) } },
        injectParse: true,
        steps: [{ inspect: '/m/a.md' }],
      },
    ],
  },
  {
    // what the reader says: a throw, a failure, a picture, a kind that is not text, no text
    args: [
      {
        stat: Object.fromEntries(
          ['t', 'f', 'i', 'k', 'n'].map((n) => [`/m/${n}.txt`, { size: 1, mtimeMs: 1 }]),
        ),
        engine: {
          parse: {
            '/m/t.txt': { throws: true },
            '/m/f.txt': { ok: false, error: 'nope' },
            '/m/i.txt': { ok: true, kind: 'image' },
            '/m/k.txt': { ok: true, kind: 'sheet', text: 'abc' },
            '/m/n.txt': { ok: true, kind: 'text' },
          },
        },
        injectParse: true,
        steps: ['t', 'f', 'i', 'k', 'n'].map((n) => ({ inspect: `/m/${n}.txt` })),
      },
    ],
  },
  {
    // an astral character is two units long
    args: [
      {
        stat: { '/m/s.txt': { size: 4, mtimeMs: 5 } },
        engine: { parse: { '/m/s.txt': { ok: true, kind: 'text', text: '\u{1F600}a' } } },
        injectParse: true,
        steps: [{ inspect: '/m/s.txt' }],
      },
    ],
  },
  {
    // the real stat and the cached length: a second look at the same file does not parse
    args: [
      {
        engine: { parse: { 'c.txt': text(9), 'd.txt': text(4) } },
        steps: [
          { inspect: '$DIR/c.txt' },
          { inspect: '$DIR/c.txt' },
          { inspect: '$DIR/d.txt' },
          { write: { path: '$DIR/c.txt', text: 'changed size', mtimeMs: 5000 } },
          { inspect: '$DIR/c.txt' },
          { inspect: '$DIR/c.txt' },
          { write: { path: '$DIR/c.txt', text: 'size changed!', mtimeMs: 5000 } },
          { inspect: '$DIR/c.txt' },
          { write: { path: '$DIR/c.txt', text: 'size changed?', mtimeMs: 6000 } },
          { inspect: '$DIR/c.txt' },
        ],
      },
    ],
    files: { 'c.txt': { text: 'abcd', mtimeMs: 2000 }, 'd.txt': { text: 'wxyz', mtimeMs: 2000 } },
  },
  {
    // an injected parser bypasses the cache; a stat without mtime has no key
    args: [
      {
        engine: { parse: { '/m/a.txt': text(2), '/m/b.txt': text(3) } },
        stat: { '/m/a.txt': { size: 2, mtimeMs: 7 }, '/m/b.txt': { size: 3 } },
        injectParse: true,
        steps: [
          { inspect: '/m/a.txt' },
          { inspect: '/m/a.txt' },
          { inspect: '/m/b.txt' },
          { inspect: '/m/b.txt' },
        ],
      },
    ],
  },
  {
    // the cache keeps 64 lengths: the oldest two are read again
    args: [
      {
        engine: {
          parse: Object.fromEntries(
            Array.from({ length: 66 }, (_, i) => [`f${i}.txt`, text(i + 1)]),
          ),
        },
        steps: [
          ...Array.from({ length: 66 }, (_, i) => ({ inspect: `$DIR/f${i}.txt` })),
          { inspect: '$DIR/f0.txt' },
          { inspect: '$DIR/f1.txt' },
          { inspect: '$DIR/f65.txt' },
          { inspect: '$DIR/f2.txt' },
        ],
      },
    ],
    files: Object.fromEntries(
      Array.from({ length: 66 }, (_, i) => [`f${i}.txt`, { text: 'x', mtimeMs: 3000 }]),
    ),
  },
].map((c) => c as Case)

// ---------------------------------------------------------------------------
// open-materials
// ---------------------------------------------------------------------------

interface TabSpec {
  id: string
  kind: string
  title: string
  filePath?: string
  active?: boolean
  dirty?: boolean
}

interface OpenScenario {
  tabs: TabSpec[]
  /** by tab id: the webContents of the tab (absent: none) */
  contents?: Record<string, { id: number; destroyed?: boolean }>
  /** the kinds the host gave a save for */
  save?: string[]
  /** by kind: what the save does: false (the editor says no) or 'throws' */
  saveResult?: Record<string, boolean | 'throws'>
  steps: Array<
    | { saveActionFor: string }
    | { saveMaterial: string }
    | { pathOfUntitled: number }
    | { showUntitled: number }
  >
}

function makeOpenDeps(o: OpenScenario, cx: TsContext) {
  const saveFor = (kind: string) => {
    const result = o.saveResult?.[kind]
    return async (...args: unknown[]) => {
      cx.log(
        'save',
        kind,
        ...args.map((a) => (typeof a === 'object' ? `contents:${(a as { id: number }).id}` : a)),
      )
      if (result === 'throws') throw new Error(`${kind} save failed`)
      return result ?? true
    }
  }
  const save: Record<string, unknown> = {}
  for (const kind of o.save ?? []) save[kind] = saveFor(kind)
  return {
    list: async () => {
      return o.tabs.map((t) => ({ active: false, dirty: false, ...t }))
    },
    webContentsFor: (tabId: string) => {
      cx.log('webContentsFor', tabId)
      const spec = o.contents?.[tabId]
      return spec ? { id: spec.id, isDestroyed: () => spec.destroyed ?? false } : undefined
    },
    reveal: (tabId: string) => cx.log('reveal', tabId),
    save,
  }
}

async function runOpen(o: OpenScenario, cx: TsContext): Promise<unknown[]> {
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => cx.log('warn', args[0], message(args[1]))
  try {
    const open = openMaterials.createOpenMaterials(makeOpenDeps(o, cx) as never)
    const results: unknown[] = []
    for (const step of o.steps) {
      if ('saveActionFor' in step)
        results.push(await guarded(() => open.saveActionFor(step.saveActionFor)))
      else if ('saveMaterial' in step)
        results.push(await guarded(() => open.saveMaterial(step.saveMaterial)))
      else if ('pathOfUntitled' in step)
        results.push(await guarded(() => open.pathOfUntitled(step.pathOfUntitled)))
      else results.push(await guarded(() => open.showUntitled(step.showUntitled)))
    }
    return results
  } finally {
    console.warn = realWarn
  }
}

const tab = (id: string, kind: string, filePath: string | undefined, dirty = true): TabSpec => ({
  id,
  kind,
  title: id,
  ...(filePath === undefined ? {} : { filePath }),
  dirty,
})

const openCases: Case[] = [
  {
    // which tabs can be saved in place, by kind and by extension
    args: [
      {
        tabs: [
          tab('d1', 'docs', '$DIR/a.docx'),
          tab('d2', 'docs', '$DIR/a.odt'),
          tab('s1', 'sheets', '$DIR/a.xlsx'),
          tab('s2', 'sheets', '$DIR/a.csv'),
          tab('p1', 'slides', '$DIR/a.PPTX'),
          tab('m1', 'markdown', '$DIR/a.md'),
          tab('h1', 'html', '$DIR/a.html'),
          tab('k1', 'mindmap', '$DIR/a.xmind'),
          tab('f1', 'pdf', '$DIR/a.pdf'),
          tab('u1', 'docs', undefined),
          tab('e1', 'docs', ''),
        ],
        save: ['docs', 'sheets', 'slides', 'markdown', 'html', 'mindmap'],
        steps: [
          { saveActionFor: '$DIR/a.docx' },
          { saveActionFor: '$DIR/a.odt' },
          { saveActionFor: '$DIR/a.xlsx' },
          { saveActionFor: '$DIR/a.csv' },
          { saveActionFor: '$DIR/a.PPTX' },
          { saveActionFor: '$DIR/a.md' },
          { saveActionFor: '$DIR/a.html' },
          { saveActionFor: '$DIR/a.xmind' },
          { saveActionFor: '$DIR/a.pdf' },
          { saveActionFor: '$DIR/not-open.docx' },
          { saveActionFor: '' },
        ],
      },
    ],
  },
  {
    // a kind the host gave no save for is shown, not written
    args: [
      {
        tabs: [tab('d1', 'docs', '$DIR/a.docx'), tab('m1', 'markdown', '$DIR/a.md')],
        save: ['markdown'],
        steps: [{ saveActionFor: '$DIR/a.docx' }, { saveActionFor: '$DIR/a.md' }],
      },
    ],
  },
  {
    // saving: every path of saveMaterial
    args: [
      {
        tabs: [
          tab('d1', 'docs', '$DIR/a.docx'),
          tab('m1', 'markdown', '$DIR/a.md'),
          tab('h1', 'html', '$DIR/a.html'),
          tab('k1', 'mindmap', '$DIR/a.xmind'),
          tab('s1', 'sheets', '$DIR/a.xlsx'),
          tab('clean', 'slides', '$DIR/clean.pptx', false),
          tab('nocontents', 'slides', '$DIR/nocontents.pptx'),
          tab('gone', 'slides', '$DIR/gone.pptx'),
          tab('pdf', 'pdf', '$DIR/a.pdf'),
          tab('odt', 'docs', '$DIR/a.odt'),
        ],
        contents: {
          d1: { id: 11 },
          m1: { id: 12 },
          h1: { id: 13 },
          k1: { id: 14 },
          s1: { id: 15 },
          clean: { id: 16 },
          gone: { id: 17, destroyed: true },
          pdf: { id: 18 },
          odt: { id: 19 },
        },
        save: ['docs', 'sheets', 'slides', 'markdown', 'html', 'mindmap'],
        saveResult: { html: false, mindmap: 'throws', sheets: 'throws' },
        steps: [
          { saveMaterial: '$DIR/a.docx' },
          { saveMaterial: '$DIR/a.md' },
          { saveMaterial: '$DIR/a.html' },
          { saveMaterial: '$DIR/a.xmind' },
          { saveMaterial: '$DIR/a.xlsx' },
          { saveMaterial: '$DIR/clean.pptx' },
          { saveMaterial: '$DIR/nocontents.pptx' },
          { saveMaterial: '$DIR/gone.pptx' },
          { saveMaterial: '$DIR/a.pdf' },
          { saveMaterial: '$DIR/a.odt' },
          { saveMaterial: '$DIR/not-open.docx' },
        ],
      },
    ],
  },
  {
    // following a never-saved document: its path, none, or no such tab
    args: [
      {
        tabs: [
          tab('u1', 'docs', undefined),
          tab('u2', 'docs', '$DIR/saved.docx'),
          tab('u3', 'docs', ''),
        ],
        contents: { u1: { id: 21 }, u2: { id: 22 }, u3: { id: 23 } },
        steps: [
          { pathOfUntitled: 21 },
          { pathOfUntitled: 22 },
          { pathOfUntitled: 23 },
          { pathOfUntitled: 99 },
          { showUntitled: 22 },
          { showUntitled: 99 },
        ],
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

const topic = (title: unknown, ...attached: Json[]): Json => ({
  title,
  ...(attached.length > 0 ? { children: { attached } } : {}),
})

interface ConvertScenario {
  engine?: Engine
  steps: Array<
    | { convert: { kind: string; path: string; untitled: string } }
    | { markdown: { outline: string; untitled: string } }
    | { slides: { outline: string; untitled: string } }
    | { build: string[] }
  >
}

async function runConvert(o: ConvertScenario, cx: TsContext): Promise<unknown[]> {
  return withEngine(o.engine, cx, async () => {
    const results: unknown[] = []
    for (const step of o.steps) {
      if ('convert' in step) {
        const { kind, path, untitled } = step.convert
        const result = await convert.convertSource(kind as never, path, { untitled })
        results.push(result.ok ? { ok: true, content: contentView(result.content) } : result)
      } else if ('markdown' in step) {
        results.push(
          await guarded(() =>
            convert.mapOutlineToSlidesMarkdown(step.markdown.outline, step.markdown.untitled),
          ),
        )
      } else if ('slides' in step) {
        results.push(
          await guarded(() =>
            convert
              .mapOutlineToSlides(step.slides.outline, step.slides.untitled)
              .map((slide) => slide.title),
          ),
        )
      } else {
        results.push(
          await guarded(async () =>
            hex(await convert.buildDeck(step.build.map((op) => ({ op })) as never)),
          ),
        )
      }
    }
    return results
  })
}

/** a conversion's content with its deck as hex */
function contentView(content: Json): unknown {
  const deck = content.deck
  return deck instanceof Uint8Array ? { ...content, deck: hex(deck) } : content
}

const MAP = [
  '- Central',
  '  - Branch A',
  '    - A1',
  '      - A1a',
  '    - A2',
  '  - Branch B',
].join('\n')

const NOTE_OUTLINE = [
  '- Central',
  '  - (boundary) Fenced',
  '  - Branch A',
  '    - (relationship) A to B',
  '    - (summary) kept',
  '    - A1',
  '- (boundary) Top',
  '- (relationshipx) not a mark',
  'plain line',
  '  -   spaced',
  '- crlf\r',
].join('\n')

const convertCases: Case[] = [
  {
    args: [
      {
        engine: {
          parse: { '/m/map.xmind': { ok: true, kind: 'text', text: MAP } },
        },
        steps: [
          { convert: { kind: 'mindmap-to-markdown', path: '/m/map.xmind', untitled: 'Untitled' } },
        ],
      },
    ],
  },
  {
    // a read that fails: thrown, redaction marks, other errors, no error text, not text, no text
    args: [
      {
        engine: {
          parse: {
            '/m/t.xmind': { throws: true },
            '/m/r.xmind': {
              ok: false,
              error: 'Redaction marks in this file could not be processed: line 3',
            },
            '/m/p.xmind': {
              ok: false,
              error: 'prefix Redaction marks in this file could not be processed',
            },
            '/m/o.xmind': { ok: false, error: 'bad zip' },
            '/m/e.xmind': { ok: false },
            '/m/i.xmind': { ok: true, kind: 'image' },
            '/m/n.xmind': { ok: true, kind: 'text' },
            '/m/s.xmind': { ok: true, kind: 'sheet', text: 'abc' },
          },
        },
        steps: ['t', 'r', 'p', 'o', 'e', 'i', 'n', 's'].map((n) => ({
          convert: { kind: 'mindmap-to-markdown', path: `/m/${n}.xmind`, untitled: 'U' },
        })),
      },
    ],
  },
  {
    // the map to a deck: one slide per branch, the central topic first
    args: [
      {
        engine: {
          parse: { '/m/map.xmind': { ok: true, kind: 'text', text: MAP } },
          root: topic(
            'Central',
            topic('Branch A', topic('A1', topic('A1a')), topic('A2')),
            topic('Branch B'),
          ),
          slides: { count: 3 },
        },
        steps: [
          { convert: { kind: 'mindmap-to-slides', path: '/m/map.xmind', untitled: 'Untitled' } },
        ],
      },
    ],
  },
  {
    // more slides than a deck takes; the cap itself is fine
    args: [
      {
        engine: {
          parse: { '/m/map.xmind': { ok: true, kind: 'text', text: MAP } },
          root: topic('Central'),
          slides: { count: 4 },
        },
        steps: [{ convert: { kind: 'mindmap-to-slides', path: '/m/map.xmind', untitled: 'U' } }],
      },
    ],
  },
  {
    args: [
      {
        engine: {
          parse: { '/m/map.xmind': { ok: true, kind: 'text', text: MAP } },
          root: topic('Central'),
          slides: { count: 3 },
        },
        steps: [{ convert: { kind: 'mindmap-to-slides', path: '/m/map.xmind', untitled: 'U' } }],
      },
    ],
  },
  {
    // everything that can fail on the way to a deck is 'failed'
    args: [
      {
        engine: {
          parse: { '/m/map.xmind': { ok: true, kind: 'text', text: MAP } },
          root: { throws: true },
        },
        steps: [{ convert: { kind: 'mindmap-to-slides', path: '/m/map.xmind', untitled: 'U' } }],
      },
    ],
  },
  {
    args: [
      {
        engine: {
          parse: { '/m/map.xmind': { ok: true, kind: 'text', text: MAP } },
          root: topic('Central'),
          slides: { count: 1, throws: true },
        },
        steps: [{ convert: { kind: 'mindmap-to-slides', path: '/m/map.xmind', untitled: 'U' } }],
      },
    ],
  },
  {
    args: [
      {
        engine: {
          parse: { '/m/map.xmind': { ok: true, kind: 'text', text: MAP } },
          root: topic('Central'),
          slides: { count: 2 },
          blankThrows: true,
        },
        steps: [{ convert: { kind: 'mindmap-to-slides', path: '/m/map.xmind', untitled: 'U' } }],
      },
    ],
  },
  {
    args: [
      {
        engine: {
          parse: { '/m/map.xmind': { ok: true, kind: 'text', text: MAP } },
          root: topic('Central'),
          slides: { count: 2 },
          txn: { op1: { applied: false, failures: [{ error: 'no such slide' }] } },
        },
        steps: [{ convert: { kind: 'mindmap-to-slides', path: '/m/map.xmind', untitled: 'U' } }],
      },
    ],
  },
  {
    // markdown to a map: the engine must take the text first
    args: [
      {
        engine: { parse: { '/m/a.md': { ok: true, kind: 'text', text: '# Title\n- a\n' } } },
        steps: [
          { convert: { kind: 'markdown-to-mindmap', path: '/m/a.md', untitled: 'Naamloos' } },
        ],
      },
    ],
  },
  {
    args: [
      {
        engine: {
          parse: { '/m/a.md': { ok: true, kind: 'text', text: '# Title' } },
          createThrows: true,
        },
        steps: [{ convert: { kind: 'markdown-to-mindmap', path: '/m/a.md', untitled: 'U' } }],
      },
    ],
  },
]

const markdownCases: Case[] = [
  {
    // the first sheet: the central topic, then each main branch with its bullets two spaces deeper
    args: [
      {
        engine: {
          root: topic(
            'Central',
            topic('Branch A', topic('A1', topic('A1a', topic('deep'))), topic('A2')),
            topic('Branch  B\n  two'),
            topic(undefined),
            topic(7),
          ),
        },
        steps: [{ markdown: { outline: MAP, untitled: 'Untitled' } }],
      },
    ],
  },
  {
    // boundary and relationship items are not topics: they are left out before the engine reads
    args: [
      {
        engine: { root: topic('  Spaced \t Title  ') },
        steps: [{ markdown: { outline: NOTE_OUTLINE, untitled: 'Untitled' } }],
      },
    ],
  },
  {
    // a topic without branches; a branch without children; attached that is not a list
    args: [
      {
        engine: { root: { title: 'Solo', children: { attached: 'nope' } } },
        steps: [{ markdown: { outline: '- Solo', untitled: 'U' } }],
      },
    ],
  },
  {
    args: [
      {
        engine: { root: topic('Root', topic('Leaf')) },
        steps: [{ markdown: { outline: '', untitled: 'U' } }],
      },
    ],
  },
  {
    // the reader that throws
    args: [
      {
        engine: { root: { throws: true } },
        steps: [{ markdown: { outline: 'x', untitled: 'U' } }],
      },
    ],
  },
].map((c) => c as Case)

const slidesCases: Case[] = [
  {
    args: [
      {
        engine: { root: topic('Central', topic('A'), topic('B')), slides: { count: 2 } },
        steps: [{ slides: { outline: MAP, untitled: 'U' } }],
      },
    ],
  },
  {
    args: [
      {
        engine: { root: topic('Central'), slides: { count: 5 } },
        steps: [{ slides: { outline: MAP, untitled: 'U' } }],
      },
    ],
  },
  {
    args: [
      {
        engine: { root: topic('Central'), slides: { count: 1, throws: true } },
        steps: [{ slides: { outline: MAP, untitled: 'U' } }],
      },
    ],
  },
]

const buildCases: Case[] = [
  { args: [{ steps: [{ build: [] }] }] },
  { args: [{ steps: [{ build: ['op0', 'op1', 'op2'] }] }] },
  {
    args: [
      {
        engine: { txn: { op1: { applied: false, failures: [{ error: 'bad op' }] } } },
        steps: [{ build: ['op0', 'op1', 'op2'] }],
      },
    ],
  },
  {
    args: [
      {
        engine: { txn: { op0: { applied: false } } },
        steps: [{ build: ['op0'] }],
      },
    ],
  },
  {
    args: [
      {
        engine: { txn: { op0: { applied: false, failures: [] } } },
        steps: [{ build: ['move'] }, { build: ['op0'] }],
      },
    ],
  },
  { args: [{ engine: { txn: { op0: { throws: true } } }, steps: [{ build: ['op0'] }] }] },
  { args: [{ engine: { blankThrows: true }, steps: [{ build: ['op0'] }] }] },
]

// ---------------------------------------------------------------------------
// markdownRedactionNotice
// ---------------------------------------------------------------------------

interface NoticeScenario {
  engine?: Engine
  injectParse?: boolean
  /** by path: injected `readBytes` as hex, or `{ throws: true }` */
  readBytes?: Record<string, string | { throws: true }>
  /** by path: the injected `stat` */
  stat?: Record<string, { size: number; mtimeMs?: number } | { throws: true }>
  steps: Array<{ notice: string } | { write: { path: string; text: string; mtimeMs?: number } }>
}

async function runNotice(o: NoticeScenario, cx: TsContext): Promise<unknown[]> {
  return withEngine(o.engine, cx, async () => {
    const results: unknown[] = []
    for (const step of o.steps) {
      if ('write' in step) {
        writeFile(step.write.path, step.write.text, step.write.mtimeMs)
        continue
      }
      const deps: Record<string, unknown> = {}
      if (o.injectParse) deps.parse = (path: string) => box.parse(path)
      const bytes = o.readBytes
      if (bytes) {
        deps.readBytes = async (path: string) => {
          cx.log('readBytes', path)
          const answer = byPath(bytes, path)
          if (typeof answer !== 'string') throw new Error('read failed')
          return new Uint8Array(Buffer.from(answer, 'hex'))
        }
      }
      const stat = o.stat
      if (stat) {
        deps.stat = async (path: string) => {
          cx.log('stat', path)
          const answer = byPath(stat, path)
          if (!answer || 'throws' in answer) throw new Error('stat failed')
          return { size: answer.size, mtimeMs: answer.mtimeMs }
        }
      }
      results.push(await convert.markdownRedactionNotice(step.notice, deps as never))
    }
    return results
  })
}

const utf8 = (s: string): string => Buffer.from(s).toString('hex')
const utf16le = (s: string): string => Buffer.from(s, 'utf16le').toString('hex')
const utf16be = (s: string): string => Buffer.from(s, 'utf16le').swap16().toString('hex')
const parsed = (t: string): Json => ({ ok: true, kind: 'text', text: t })

const noticeCases: Case[] = [
  {
    // the text the reader hands back against the file's own text, in each encoding
    args: [
      {
        injectParse: true,
        engine: {
          parse: {
            '/m/same.md': parsed('hello'),
            '/m/diff.md': parsed('he{{label}}'),
            '/m/bom.md': parsed('hello'),
            '/m/bom2.md': parsed('hello'),
            '/m/u16le.md': parsed('héllo'),
            '/m/u16be.md': parsed('héllo'),
            '/m/u32le.md': parsed('hello'),
            '/m/u32be.md': parsed('hello'),
            '/m/latin.md': parsed('caf\u00e9'),
            '/m/cp1252.md': parsed('\u201cq\u201d'),
            '/m/bad.md': { ok: false },
            '/m/notext.md': { ok: true, kind: 'text' },
            '/m/okfalse.md': { ok: false, text: 'zzz' },
            '/m/throws.md': { throws: true },
          },
        },
        readBytes: {
          '/m/same.md': utf8('hello'),
          '/m/diff.md': utf8('hello'),
          '/m/bom.md': `efbbbf${utf8('hello')}`,
          '/m/bom2.md': `efbbbfefbbbf${utf8('hello')}`,
          '/m/u16le.md': `fffe${utf16le('héllo')}`,
          '/m/u16be.md': `feff${utf16be('héllo')}`,
          '/m/u32le.md': `fffe0000${utf16le('hello')}`,
          '/m/u32be.md': `0000feff${utf8('hello')}`,
          '/m/latin.md': '636166e9',
          '/m/cp1252.md': '937194',
          '/m/bad.md': utf8('x'),
          '/m/notext.md': utf8('x'),
          '/m/okfalse.md': utf8('hello'),
          '/m/throws.md': utf8('x'),
        },
        steps: [
          '/m/same.md',
          '/m/diff.md',
          '/m/bom.md',
          '/m/bom2.md',
          '/m/u16le.md',
          '/m/u16be.md',
          '/m/u32le.md',
          '/m/u32be.md',
          '/m/latin.md',
          '/m/cp1252.md',
          '/m/bad.md',
          '/m/notext.md',
          '/m/okfalse.md',
          '/m/throws.md',
          '/m/unread.md',
        ].map((notice) => ({ notice })),
      },
    ],
  },
  {
    // the real file and its cache: the answer is kept by size and mtime
    args: [
      {
        engine: { parse: { 'a.md': parsed('X'), 'b.md': parsed('same') } },
        steps: [
          { notice: '$DIR/a.md' },
          { notice: '$DIR/a.md' },
          { write: { path: '$DIR/a.md', text: 'X', mtimeMs: 9000 } },
          { notice: '$DIR/a.md' },
          { notice: '$DIR/b.md' },
          { notice: '$DIR/missing.md' },
        ],
      },
    ],
    files: { 'a.md': { text: 'xx', mtimeMs: 4000 }, 'b.md': { text: 'same', mtimeMs: 4000 } },
  },
  {
    // an injected stat and no injected reader: keyed, parsed, read for real
    args: [
      {
        engine: { parse: { '$DIR/a.md': parsed('A'), '$DIR/c.md': parsed('C') } },
        stat: {
          '$DIR/a.md': { size: 1, mtimeMs: 1 },
          '$DIR/c.md': { size: 1 },
          '$DIR/d.md': { throws: true },
        },
        steps: [
          { notice: '$DIR/a.md' },
          { notice: '$DIR/a.md' },
          { notice: '$DIR/c.md' },
          { notice: '$DIR/c.md' },
          { notice: '$DIR/d.md' },
        ],
      },
    ],
    files: { 'a.md': 'a', 'c.md': 'c' },
  },
  {
    // an injected reader alone: no cache, no stat
    args: [
      {
        injectParse: false,
        engine: { parse: { '/m/a.md': parsed('A') } },
        readBytes: { '/m/a.md': utf8('a') },
        steps: [{ notice: '/m/a.md' }, { notice: '/m/a.md' }],
      },
    ],
  },
  {
    // the cache keeps 32 answers
    args: [
      {
        engine: {
          parse: Object.fromEntries(
            Array.from({ length: 34 }, (_, i) => [`n${i}.md`, parsed(i % 2 === 0 ? 'x' : 'y')]),
          ),
        },
        steps: [
          ...Array.from({ length: 34 }, (_, i) => ({ notice: `$DIR/n${i}.md` })),
          { notice: '$DIR/n0.md' },
          { notice: '$DIR/n1.md' },
          { notice: '$DIR/n2.md' },
          { notice: '$DIR/n33.md' },
        ],
      },
    ],
    files: Object.fromEntries(
      Array.from({ length: 34 }, (_, i) => [`n${i}.md`, { text: 'x', mtimeMs: 6000 }]),
    ),
  },
].map((c) => c as Case)

// ---------------------------------------------------------------------------
// queueConvertedContent
// ---------------------------------------------------------------------------

interface ConvertedTabScenario {
  webContentsId: number
  destroyed?: boolean
  /** `none`: no resolver; `tab`: `tab-<id>`; `empty`: an empty name; `throws` */
  resolver?: 'none' | 'tab' | 'empty' | 'throws'
  doc: {
    id: string
    kind: string
    markdown?: string
    deckHex?: string
    slideCount?: number
    outline?: string
    sources: string[]
    createdAt: number
  }
}

/** a conversion's content as the session and the window hand it over */
function contentOf(spec: ConvertedTabScenario['doc']): Json {
  const target = (api.CONVERT_TARGETS as Record<string, string>)[spec.kind]
  if (spec.kind === 'mindmap-to-markdown')
    return { kind: spec.kind, target, markdown: spec.markdown }
  if (spec.kind === 'mindmap-to-slides') {
    const deck = new Uint8Array(Buffer.from(spec.deckHex ?? '', 'hex'))
    return { kind: spec.kind, target, deck, slideCount: spec.slideCount }
  }
  return { kind: spec.kind, target, outline: spec.outline }
}

async function runConvertedTab(o: ConvertedTabScenario, cx: TsContext): Promise<unknown> {
  const contents = {
    id: o.webContentsId,
    isDestroyed: () => o.destroyed ?? false,
    once: (event: string) => cx.log('once', event),
  }
  const resolver = o.resolver ?? 'none'
  handoff.setGenerateTabIdResolver(
    resolver === 'none'
      ? null
      : (id: number) => {
          if (resolver === 'throws') throw new Error('no tab')
          return resolver === 'empty' ? '' : `tab-${id}`
        },
  )
  try {
    const answer: Json = {}
    await withNow(cx.now, async () => {
      try {
        convertedTab.queueConvertedContent(
          contents as never,
          {
            id: o.doc.id,
            content: contentOf(o.doc),
            sources: o.doc.sources,
            createdAt: o.doc.createdAt,
          } as never,
        )
      } catch (error) {
        answer.error = message(error)
      }
    })
    answer.markdown = markdownSeed.takeMarkdownSeed(o.webContentsId)
    answer.mindmap = mindmapSeed.takeMindmapSeed(o.webContentsId)
    const deck = slidesSeed.takeSlidesSeed(o.webContentsId)
    answer.slides = deck ? hex(deck) : null
    answer.events = handoff
      .generateConvertedEvents()
      .filter((e: { webContentsId: number }) => e.webContentsId === o.webContentsId)
    return answer
  } finally {
    handoff.setGenerateTabIdResolver(null)
  }
}

let tabId = 9100
const tabCase = (
  over: Partial<ConvertedTabScenario>,
  doc: Partial<ConvertedTabScenario['doc']>,
): Case => ({
  args: [
    {
      webContentsId: (tabId += 1),
      doc: {
        id: 'conv-1',
        kind: 'mindmap-to-markdown',
        markdown: '# map\n',
        sources: ['/m/map.xmind'],
        createdAt: 5,
        ...doc,
      },
      ...over,
    },
  ],
})

const convertedTabCases: Case[] = [
  tabCase({}, {}),
  tabCase({}, { kind: 'mindmap-to-slides', deckHex: 'dec003', slideCount: 3 }),
  tabCase({}, { kind: 'markdown-to-mindmap', outline: '- a\n- b', sources: ['/m/a.md'] }),
  tabCase({ destroyed: true }, {}),
  tabCase({ resolver: 'tab' }, { sources: ['/m/map.xmind', '', '/m/other.xmind'] }),
  tabCase({ resolver: 'empty' }, { kind: 'markdown-to-mindmap', outline: 'x' }),
  tabCase({ resolver: 'throws' }, { kind: 'mindmap-to-slides', deckHex: '01', slideCount: 1 }),
]

// ---------------------------------------------------------------------------
// GenerateSession
// ---------------------------------------------------------------------------

type Ref = { path: string } | { untitled: { webContentsId: number; title: string } }

type SessionStep =
  | { state: true }
  | { reset: { refs: Ref[]; kind?: string } }
  | { refresh: true }
  | { setKind: unknown }
  | { setConvert: unknown }
  | { addPaths: unknown[] }
  | { remove: unknown }
  | { save: unknown }
  | { make: unknown }
  | { closed: true }

interface SessionScenario {
  lang?: 'en' | 'ko'
  refs: Ref[]
  kind?: string
  canConvert?: boolean
  hasNotice?: boolean
  recheckDelayMs?: number
  /** by path: the answers of consecutive calls; the last repeats */
  inspect?: Record<string, Array<Json | { throws: true }>>
  /** by webContents id: the same, `null` for still untitled */
  pathOfUntitled?: Record<string, Array<string | null | { throws: true }>>
  saveActionFor?: Record<string, 'save' | 'show' | 'throws'>
  saveMaterial?: Record<string, 'saved' | 'shown' | 'failed' | 'throws'>
  showUntitledThrows?: boolean
  openTarget?: 'throws'
  convert?: Record<
    string,
    | { ok: true; content: ConvertedTabScenario['doc'] }
    | { ok: false; problem: string }
    | { throws: true }
  >
  openConverted?: 'throws'
  notice?: Record<string, boolean | 'throws'>
  ids?: string[]
  now?: number
  steps: SessionStep[]
}

/** a step's argument; `{"$undefined": true}` is `undefined` */
const arg = (value: unknown): unknown =>
  value && typeof value === 'object' && '$undefined' in value ? undefined : value

/** the doc a conversion's `openConvertedTab` got, with its deck as hex */
function docView(doc: { content: Json } & Json): unknown {
  return { ...doc, content: contentView(doc.content) }
}

async function runSession(o: SessionScenario, cx: TsContext): Promise<unknown[]> {
  const counts: Record<string, number> = {}
  const nth = <T>(table: Record<string, T[]> | undefined, name: string, key: string) => {
    const list = table?.[key]
    if (!list || list.length === 0) return undefined
    const at = `${name}:${key}`
    const i = counts[at] ?? 0
    counts[at] = i + 1
    return list[Math.min(i, list.length - 1)]
  }
  const ids = [...(o.ids ?? [])]
  const deps = {
    lang: () => o.lang ?? 'en',
    inspect: async (path: string) => {
      cx.log('inspect', path)
      const answer = nth(o.inspect, 'inspect', path)
      if (!answer || 'throws' in answer) throw new Error(`inspect failed: ${path}`)
      return answer
    },
    pathOfUntitled: async (id: number) => {
      cx.log('pathOfUntitled', id)
      const answer = nth(o.pathOfUntitled, 'untitled', String(id))
      if (answer === undefined) return null
      if (answer !== null && typeof answer === 'object') throw new Error('pathOfUntitled failed')
      return answer
    },
    saveActionFor: async (path: string) => {
      cx.log('saveActionFor', path)
      const answer = o.saveActionFor?.[path] ?? 'show'
      if (answer === 'throws') throw new Error('saveActionFor failed')
      return answer
    },
    saveMaterial: async (path: string) => {
      cx.log('saveMaterial', path)
      const answer = o.saveMaterial?.[path] ?? 'saved'
      if (answer === 'throws') throw new Error('saveMaterial failed')
      return answer
    },
    showUntitled: async (id: number) => {
      cx.log('showUntitled', id)
      if (o.showUntitledThrows) throw new Error('showUntitled failed')
    },
    openTargetTab: (handoffToOpen: unknown) => {
      cx.log('openTargetTab', handoffToOpen)
      if (o.openTarget === 'throws') throw new Error('no tab could open')
    },
    ...(o.canConvert
      ? {
          convert: async (kind: string, path: string) => {
            cx.log('convert', kind, path)
            const answer = o.convert?.[path]
            if (!answer || 'throws' in answer) throw new Error('convert failed')
            return answer.ok ? { ok: true, content: contentOf(answer.content) } : answer
          },
          openConvertedTab: (doc: { content: Json } & Json) => {
            cx.log('openConvertedTab', docView(doc))
            if (o.openConverted === 'throws') throw new Error('no tab could open')
          },
        }
      : {}),
    ...(o.hasNotice
      ? {
          redactionNotice: async (path: string) => {
            cx.log('redactionNotice', path)
            const answer = o.notice?.[path] ?? false
            if (answer === 'throws') throw new Error('notice failed')
            return answer
          },
        }
      : {}),
    push: (state: unknown) => cx.log('push', state),
    close: () => cx.log('close'),
    newId: () => ids.shift() ?? 'id',
    now: () => o.now ?? 0,
    ...(o.recheckDelayMs === undefined ? {} : { recheckDelayMs: o.recheckDelayMs }),
  }
  const realTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    cx.log('sleep', ms)
    return realTimeout(fn, 0)
  }) as never
  try {
    const session = new sessionModule.GenerateSession(deps as never, {
      refs: o.refs,
      ...(o.kind ? { kind: o.kind as never } : {}),
    })
    const results: unknown[] = []
    for (const step of o.steps) {
      results.push(
        await guarded(async () => {
          if ('state' in step) return session.state()
          if ('reset' in step) return session.reset(step.reset.refs, step.reset.kind as never)
          if ('refresh' in step) return session.refresh()
          if ('setKind' in step) return session.setKind(arg(step.setKind))
          if ('setConvert' in step) return session.setConvert(arg(step.setConvert))
          if ('addPaths' in step) return session.addPaths(step.addPaths)
          if ('remove' in step) return session.remove(arg(step.remove))
          if ('save' in step) return session.save(arg(step.save))
          if ('make' in step) return session.make(arg(step.make))
          return session.isClosed
        }),
      )
    }
    return results
  } finally {
    globalThis.setTimeout = realTimeout
  }
}

const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const dotExt = (path: string): string => {
  const name = base(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** a material the file reader gave: readable, `text` characters long */
const ok = (path: string, over: Json = {}): Json => ({
  key: path,
  name: base(path),
  path,
  ext: dotExt(path),
  unsaved: false,
  textLength: 100,
  sizeBytes: 1000,
  ...over,
})

const unsavedAt = (path: string): Json => ok(path, { unsaved: true, textLength: 0 })
const outOf = (path: string, problem: string, over: Json = {}): Json =>
  ok(path, { problem, textLength: 0, ...over })

const p = (path: string): Ref => ({ path })
const sess = (o: SessionScenario): Case => ({ args: [o] })
const MAKE_IDS = ['id-1', 'id-2', 'id-3']

const A = '/m/a.txt'
const B = '/m/b.md'
const C = '/m/c.pdf'
const MAP_X = '/m/map.xmind'
const NOTE_MD = '/m/note.md'
const doc = (over: Partial<ConvertedTabScenario['doc']>): ConvertedTabScenario['doc'] => ({
  id: 'unused',
  kind: 'mindmap-to-markdown',
  markdown: '# from the map',
  sources: [],
  createdAt: 0,
  ...over,
})

const sessionCases: Case[] = [
  // nothing is read yet: every row is being checked
  sess({ refs: [p(A), p(B)], steps: [{ state: true }, { make: 'go' }, { state: true }] }),
  // refreshed: ready rows, totals, notices by kind, the long-material warning
  sess({
    refs: [p(A), p(C)],
    inspect: {
      [A]: [ok(A, { textLength: 9000 })],
      [C]: [ok(C, { textLength: 95000, sizeBytes: 5000 })],
    },
    steps: [
      { refresh: true },
      { state: true },
      { setKind: 'mindmap' },
      { state: true },
      { setKind: 'html' },
      { setKind: 'pdf' },
      { setKind: 5 },
      { setKind: { $undefined: true } },
      { state: true },
    ],
  }),
  sess({
    refs: [p(A)],
    lang: 'ko',
    inspect: { [A]: [ok(A, { textLength: 120000 })] },
    steps: [{ refresh: true }, { state: true }],
  }),
  // make: the default request in each language, and the text the person wrote
  sess({
    refs: [p(A)],
    inspect: { [A]: [ok(A)] },
    ids: MAKE_IDS,
    now: 1700,
    steps: [{ refresh: true }, { make: '' }, { closed: true }, { make: 'again' }],
  }),
  sess({
    refs: [p(A), p(B)],
    lang: 'ko',
    kind: 'mindmap',
    inspect: { [A]: [ok(A)], [B]: [ok(B)] },
    ids: MAKE_IDS,
    now: 1800,
    steps: [{ refresh: true }, { make: ' \n\t ' }],
  }),
  sess({
    refs: [p(A)],
    kind: 'html',
    inspect: { [A]: [ok(A)] },
    ids: MAKE_IDS,
    steps: [{ refresh: true }, { make: '  write it short  ' }],
  }),
  // make that refuses: nothing readable, text the wrong type, text too long, unsaved
  sess({
    refs: [p(A)],
    inspect: { [A]: [outOf(A, 'missing')] },
    steps: [{ refresh: true }, { make: 'go' }, { state: true }],
  }),
  sess({
    refs: [p(A)],
    inspect: { [A]: [ok(A)] },
    steps: [
      { refresh: true },
      { make: 5 },
      { make: { $undefined: true } },
      { make: 'x'.repeat(32001) },
      { state: true },
    ],
  }),
  sess({
    refs: [p(A), p(C)],
    saveActionFor: { [C]: 'save' },
    inspect: { [A]: [ok(A)], [C]: [unsavedAt(C)] },
    steps: [{ refresh: true }, { state: true }, { make: 'go' }, { state: true }],
  }),
  // make: what goes wrong while the tab opens, or the files are read again
  sess({
    refs: [p(A)],
    inspect: { [A]: [ok(A)] },
    openTarget: 'throws',
    ids: MAKE_IDS,
    steps: [
      { refresh: true },
      { make: 'go' },
      { state: true },
      { setKind: 'html' },
      { state: true },
    ],
  }),
  sess({
    refs: [p(A)],
    inspect: { [A]: [ok(A), { throws: true }] },
    steps: [{ refresh: true }, { make: 'go' }, { state: true }],
  }),
  sess({
    refs: [p(A), p(B)],
    inspect: { [A]: [ok(A)], [B]: [{ throws: true }] },
    steps: [{ refresh: true }, { state: true }, { refresh: true }, { state: true }],
  }),
  // rows left out, with their reasons
  sess({
    refs: [p('/m/gone.txt'), p('/m/odd.exe'), p('/m/big.png'), p('/m/big.docx'), p('/m/huge.txt')],
    inspect: {
      '/m/gone.txt': [outOf('/m/gone.txt', 'missing', { sizeBytes: undefined })],
      '/m/odd.exe': [outOf('/m/odd.exe', 'unsupported', { sizeBytes: undefined })],
      '/m/big.png': [outOf('/m/big.png', 'too-large', { sizeBytes: 9999999 })],
      '/m/big.docx': [outOf('/m/big.docx', 'too-large', { sizeBytes: 9999999 })],
      '/m/huge.txt': [outOf('/m/huge.txt', 'too-large', { sizeBytes: 99999999 })],
    },
    steps: [{ refresh: true }, { state: true }, { make: 'go' }],
  }),
  // a document that was never saved
  sess({
    refs: [p(A), { untitled: { webContentsId: 7, title: 'Untitled 1' } }],
    inspect: { [A]: [ok(A)] },
    steps: [
      { refresh: true },
      { state: true },
      { make: 'go' },
      { save: 'untitled:7' },
      { state: true },
    ],
  }),
  sess({
    refs: [{ untitled: { webContentsId: 8, title: 'Untitled 2' } }],
    showUntitledThrows: true,
    steps: [{ refresh: true }, { save: 'untitled:8' }, { state: true }],
  }),
  sess({
    // saved since: it becomes a path row, and then a copy of another row folds away
    refs: [p(A), { untitled: { webContentsId: 9, title: 'Untitled 3' } }],
    pathOfUntitled: { '9': [null, A] },
    inspect: { [A]: [ok(A)] },
    steps: [{ refresh: true }, { state: true }, { refresh: true }, { state: true }],
  }),
  sess({
    refs: [p(A), { untitled: { webContentsId: 10, title: 'Untitled 4' } }],
    pathOfUntitled: { '10': ['/m/fresh.txt'] },
    inspect: { [A]: [ok(A)], '/m/fresh.txt': [ok('/m/fresh.txt')] },
    steps: [{ refresh: true }, { state: true }],
  }),
  sess({
    refs: [p(A), { untitled: { webContentsId: 11, title: 'Untitled 5' } }],
    pathOfUntitled: { '11': [{ throws: true }] },
    inspect: { [A]: [ok(A)] },
    steps: [{ refresh: true }, { state: true }],
  }),
  // adding and removing rows
  sess({
    refs: [p(A)],
    inspect: { [A]: [ok(A)], [B]: [ok(B)], '/m/d.txt': [ok('/m/d.txt')] },
    steps: [
      { refresh: true },
      { addPaths: [B, 7, '', null, B, A, '/m/d.txt'] },
      { state: true },
      { addPaths: [] },
      { addPaths: ['', 5] },
      { remove: 5 },
      { remove: { $undefined: true } },
      { remove: '/m/zzz' },
      { remove: B },
      { state: true },
    ],
  }),
  sess({
    refs: [p(A)],
    inspect: { [A]: [ok(A)], '/m/e.txt': [{ throws: true }] },
    steps: [{ refresh: true }, { addPaths: ['/m/e.txt'] }, { state: true }],
  }),
  sess({
    refs: [p(A), p(A), p('')],
    inspect: { [A]: [ok(A)] },
    steps: [{ refresh: true }, { state: true }],
  }),
  // the cap on materials
  sess({
    refs: Array.from({ length: 21 }, (_, i) => p(`/m/${i}.txt`)),
    inspect: Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`/m/${i}.txt`, [ok(`/m/${i}.txt`)]]),
    ),
    steps: [
      { refresh: true },
      { state: true },
      { make: 'go' },
      { remove: '/m/20.txt' },
      { state: true },
    ],
  }),
  // saving a row in place
  sess({
    refs: [p(A)],
    saveActionFor: { [A]: 'save' },
    saveMaterial: { [A]: 'saved' },
    inspect: { [A]: [unsavedAt(A), ok(A)] },
    steps: [{ refresh: true }, { state: true }, { save: A }, { state: true }, { save: A }],
  }),
  sess({
    // the tab reports clean a moment after the write: it is looked at again
    refs: [p(A)],
    saveMaterial: { [A]: 'saved' },
    recheckDelayMs: 0,
    inspect: { [A]: [unsavedAt(A), unsavedAt(A), ok(A)] },
    steps: [{ refresh: true }, { save: A }, { state: true }],
  }),
  sess({
    // the default wait is 600 ms
    refs: [p(A)],
    saveMaterial: { [A]: 'saved' },
    inspect: { [A]: [unsavedAt(A), unsavedAt(A)] },
    steps: [{ refresh: true }, { save: A }, { state: true }],
  }),
  sess({
    refs: [p(A)],
    saveMaterial: { [A]: 'shown' },
    inspect: { [A]: [unsavedAt(A)] },
    steps: [{ refresh: true }, { save: A }, { state: true }],
  }),
  sess({
    refs: [p(A)],
    saveMaterial: { [A]: 'failed' },
    inspect: { [A]: [unsavedAt(A)] },
    steps: [{ refresh: true }, { save: A }, { state: true }],
  }),
  sess({
    refs: [p(A)],
    saveMaterial: { [A]: 'throws' },
    saveActionFor: { [A]: 'throws' },
    inspect: { [A]: [unsavedAt(A)] },
    steps: [
      { refresh: true },
      { state: true },
      { save: A },
      { state: true },
      { save: 5 },
      { save: '/m/none' },
    ],
  }),
  sess({
    refs: [p(A)],
    inspect: { [A]: [unsavedAt(A), { throws: true }] },
    steps: [{ refresh: true }, { save: A }, { state: true }],
  }),
  // conversions without AI
  sess({
    refs: [p(MAP_X)],
    canConvert: true,
    hasNotice: true,
    inspect: { [MAP_X]: [ok(MAP_X)] },
    steps: [
      { state: true },
      { refresh: true },
      { state: true },
      { setConvert: 'markdown-to-mindmap' },
      { setConvert: 'mindmap-to-slides' },
      { state: true },
      { setKind: 'html' },
      { state: true },
      { setConvert: 'mindmap-to-slides' },
      { setConvert: null },
      { state: true },
      { setConvert: 'nonsense' },
      { setConvert: { $undefined: true } },
      { setConvert: 3 },
    ],
  }),
  sess({
    refs: [p(MAP_X)],
    hasNotice: true,
    inspect: { [MAP_X]: [ok(MAP_X)] },
    steps: [{ refresh: true }, { state: true }, { setConvert: 'mindmap-to-markdown' }],
  }),
  sess({
    refs: [p(MAP_X)],
    canConvert: true,
    inspect: { [MAP_X]: [ok(MAP_X)] },
    convert: {
      [MAP_X]: { ok: true, content: doc({ kind: 'mindmap-to-markdown', markdown: '# map' }) },
    },
    ids: MAKE_IDS,
    now: 4400,
    steps: [
      { refresh: true },
      { setConvert: 'mindmap-to-markdown' },
      { make: 'ignored words' },
      { closed: true },
    ],
  }),
  sess({
    refs: [p(MAP_X)],
    canConvert: true,
    inspect: { [MAP_X]: [ok(MAP_X)] },
    convert: {
      [MAP_X]: {
        ok: true,
        content: doc({ kind: 'mindmap-to-slides', deckHex: 'dec0de', slideCount: 4 }),
      },
    },
    ids: MAKE_IDS,
    steps: [{ refresh: true }, { setConvert: 'mindmap-to-slides' }, { make: '' }],
  }),
  sess({
    refs: [p(MAP_X)],
    canConvert: true,
    inspect: { [MAP_X]: [ok(MAP_X)] },
    convert: { [MAP_X]: { ok: false, problem: 'too-many-slides' } },
    steps: [
      { refresh: true },
      { setConvert: 'mindmap-to-slides' },
      { make: '' },
      { state: true },
      { setConvert: 'mindmap-to-markdown' },
      { state: true },
    ],
  }),
  sess({
    refs: [p(MAP_X)],
    canConvert: true,
    inspect: { [MAP_X]: [ok(MAP_X)] },
    convert: { [MAP_X]: { throws: true } },
    steps: [
      { refresh: true },
      { setConvert: 'mindmap-to-markdown' },
      { make: '' },
      { state: true },
    ],
  }),
  sess({
    refs: [p(MAP_X)],
    canConvert: true,
    inspect: { [MAP_X]: [ok(MAP_X)] },
    convert: { [MAP_X]: { ok: true, content: doc({}) } },
    openConverted: 'throws',
    ids: MAKE_IDS,
    steps: [
      { refresh: true },
      { setConvert: 'mindmap-to-markdown' },
      { make: '' },
      { state: true },
    ],
  }),
  sess({
    // the map is open with unsaved changes when "make" reads it again
    refs: [p(MAP_X)],
    canConvert: true,
    saveActionFor: { [MAP_X]: 'save' },
    inspect: { [MAP_X]: [ok(MAP_X), unsavedAt(MAP_X)] },
    convert: { [MAP_X]: { ok: true, content: doc({}) } },
    steps: [
      { refresh: true },
      { setConvert: 'mindmap-to-markdown' },
      { make: '' },
      { state: true },
    ],
  }),
  sess({
    // a second row takes the offer away: the chosen conversion waits, never turns into the AI
    refs: [p(MAP_X)],
    canConvert: true,
    inspect: { [MAP_X]: [ok(MAP_X)], [A]: [ok(A)] },
    steps: [
      { refresh: true },
      { setConvert: 'mindmap-to-markdown' },
      { addPaths: [A] },
      { state: true },
      { make: '' },
      { state: true },
      { remove: A },
      { state: true },
    ],
  }),
  sess({
    // markdown to a map: the notice about withheld spans
    refs: [p(NOTE_MD)],
    canConvert: true,
    hasNotice: true,
    notice: { [NOTE_MD]: true },
    inspect: { [NOTE_MD]: [ok(NOTE_MD)] },
    convert: {
      [NOTE_MD]: { ok: true, content: doc({ kind: 'markdown-to-mindmap', outline: '# note' }) },
    },
    ids: MAKE_IDS,
    steps: [
      { refresh: true },
      { setConvert: 'markdown-to-mindmap' },
      { state: true },
      { setConvert: null },
      { state: true },
      { setConvert: 'markdown-to-mindmap' },
      { make: '' },
    ],
  }),
  sess({
    refs: [p(NOTE_MD)],
    canConvert: true,
    hasNotice: true,
    notice: { [NOTE_MD]: 'throws' },
    inspect: { [NOTE_MD]: [ok(NOTE_MD)] },
    steps: [{ refresh: true }, { setConvert: 'markdown-to-mindmap' }, { state: true }],
  }),
  sess({
    refs: [p(NOTE_MD)],
    canConvert: true,
    hasNotice: true,
    saveActionFor: { [NOTE_MD]: 'show' },
    inspect: { [NOTE_MD]: [unsavedAt(NOTE_MD)] },
    steps: [{ refresh: true }, { setConvert: 'markdown-to-mindmap' }, { state: true }],
  }),
  sess({
    refs: [p('/m/other.markdown')],
    canConvert: true,
    hasNotice: true,
    notice: { '/m/other.markdown': true },
    inspect: { '/m/other.markdown': [outOf('/m/other.markdown', 'unreadable')] },
    steps: [{ refresh: true }, { state: true }],
  }),
  // starting over
  sess({
    refs: [p(A)],
    openTarget: 'throws',
    inspect: { [A]: [ok(A)], [B]: [ok(B)] },
    steps: [
      { refresh: true },
      { make: 'go' },
      { reset: { refs: [p(B)], kind: 'mindmap' } },
      { state: true },
      { reset: { refs: [p(A)] } },
      { state: true },
    ],
  }),
  // a conversion carries no plan usage, however long the map reads
  sess({
    refs: [p(MAP_X)],
    canConvert: true,
    inspect: { [MAP_X]: [ok(MAP_X, { textLength: 120000 })] },
    steps: [
      { refresh: true },
      { state: true },
      { setConvert: 'mindmap-to-markdown' },
      { state: true },
    ],
  }),
  // a ready row can be saved too: the save is in flight while the row is ready
  sess({
    refs: [p(A)],
    saveMaterial: { [A]: 'saved' },
    inspect: { [A]: [ok(A)] },
    steps: [{ refresh: true }, { save: A }, { state: true }],
  }),
  // a closed session stays quiet
  sess({
    refs: [p(A)],
    inspect: { [A]: [ok(A)] },
    ids: MAKE_IDS,
    steps: [{ refresh: true }, { make: 'go' }, { setKind: 'html' }, { remove: A }, { state: true }],
  }),
  // the reason of a failed conversion goes with the failure
  sess({
    refs: [p(MAP_X)],
    canConvert: true,
    inspect: { [MAP_X]: [ok(MAP_X)] },
    convert: { [MAP_X]: { ok: false, problem: 'redaction' } },
    steps: [
      { refresh: true },
      { setConvert: 'mindmap-to-slides' },
      { make: '' },
      { state: true },
      { setKind: 'html' },
      { state: true },
    ],
  }),
  // a row that was left out is not asked for again by "make"
  sess({
    refs: [p(A), p('/m/gone.txt')],
    inspect: { [A]: [ok(A)], '/m/gone.txt': [outOf('/m/gone.txt', 'missing')] },
    ids: MAKE_IDS,
    steps: [{ refresh: true }, { make: 'go' }],
  }),
  // an empty path is no path
  sess({
    refs: [p(A), { untitled: { webContentsId: 12, title: 'Untitled 6' } }],
    pathOfUntitled: { '12': [''] },
    inspect: { [A]: [ok(A)] },
    steps: [{ refresh: true }, { state: true }],
  }),
]

// ---------------------------------------------------------------------------
// the generate window
// ---------------------------------------------------------------------------

type WindowStep =
  | { configure: true }
  | {
      open: {
        refs: Ref[]
        kind?: string
        parent?: 'explicit' | 'explicit-destroyed'
        opener?: Json | null
      }
    }
  | { openPaths: { paths: string[]; parent?: 'explicit' | 'explicit-destroyed' } }
  | {
      openDocument: {
        webContentsId: number
        filePath?: string
        title: string
        parent?: 'explicit' | 'explicit-destroyed'
      }
    }
  | { close: true }
  | { contents: true }
  | { ipc: { channel: string; from: string; args?: unknown[] } }
  | { event: { window?: number; name: string; url?: string } }
  | { destroy: number }
  | { minimize: number }

type Texts = Record<string, Record<string, string>>

interface WindowScenario extends Omit<Partial<OpenScenario>, 'steps'> {
  lang?: 'en' | 'ko'
  theme?: string
  dark?: boolean
  darwin?: boolean
  rendererUrl?: string
  /** what `deps.parentWindow()` gives */
  parent?: 'live' | 'destroyed'
  canConvert?: boolean
  openTarget?: 'throws'
  openConverted?: 'throws'
  overlayThrows?: boolean
  dialog?: { canceled: boolean; filePaths: string[] }
  starred?: Record<string, string[]>
  openFiles?: Array<{ filePath?: string; dirty: boolean }>
  engine?: Engine
  texts: Texts
  steps: WindowStep[]
}

interface FakeWin {
  n: number
  webContents: {
    id: number
    send: (channel: string, state: unknown) => void
    setWindowOpenHandler: (handler: (details: { url: string }) => unknown) => void
    openHandler?: (details: { url: string }) => unknown
  }
  destroyed: boolean
  minimized: boolean
  onceListeners: Record<string, () => void>
  onListeners: Record<string, () => void>
  [method: string]: unknown
}

let windowRun = 0

async function runWindow(o: WindowScenario, cx: TsContext): Promise<unknown[]> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const windows: FakeWin[] = []
  const themeListeners: Array<(() => void) | null> = []
  let sends: unknown[] = []

  const fakeWindow = (n: number, webId: number): FakeWin => {
    const win: FakeWin = {
      n,
      webContents: {
        id: webId,
        send: (_channel, state) => sends.push(state),
        setWindowOpenHandler: (handler) => {
          win.webContents.openHandler = handler
        },
      },
      destroyed: false,
      minimized: false,
      onceListeners: {},
      onListeners: {},
      isDestroyed: () => win.destroyed,
      isMinimized: () => win.minimized,
      removeMenu: () => cx.log('win', n, 'removeMenu'),
      restore: () => cx.log('win', n, 'restore'),
      show: () => cx.log('win', n, 'show'),
      focus: () => cx.log('win', n, 'focus'),
      close: () => cx.log('win', n, 'close'),
      loadURL: (url: string) => cx.log('win', n, 'loadURL', url),
      loadFile: () => cx.log('win', n, 'loadFile'),
      setTitleBarOverlay: (overlay: unknown) => {
        cx.log('win', n, 'setTitleBarOverlay', overlay)
        if (o.overlayThrows) throw new Error('window is gone')
      },
      once: (event: string, listener: () => void) => {
        win.onceListeners[event] = listener
      },
      on: (event: string, listener: () => void) => {
        win.onListeners[event] = listener
      },
    }
    return win
  }
  const parentWin = fakeWindow(0, 100)
  parentWin.destroyed = o.parent === 'destroyed'
  const explicitLive = fakeWindow(50, 150)
  const explicitDestroyed = fakeWindow(51, 151)
  explicitDestroyed.destroyed = true
  const explicit = (kind: 'explicit' | 'explicit-destroyed' | undefined) =>
    kind === 'explicit'
      ? explicitLive
      : kind === 'explicit-destroyed'
        ? explicitDestroyed
        : undefined

  class FakeBrowserWindow {
    constructor(options: Json) {
      const n = windows.length + 1
      const win = fakeWindow(n, 200 + n)
      windows.push(win)
      const parent = options.parent as FakeWin | undefined
      const preferences = options.webPreferences as Json
      cx.log('new BrowserWindow', n, {
        ...options,
        ...(parent ? { parent: parent.n } : {}),
        webPreferences: {
          contextIsolation: preferences.contextIsolation,
          nodeIntegration: preferences.nodeIntegration,
          sandbox: preferences.sandbox,
        },
      })
      return win as never
    }
  }

  const base = makeOpenDeps({ tabs: [], ...o, steps: [] } as OpenScenario, cx)
  const deps = {
    parentWindow: () => (o.parent === undefined ? null : parentWin),
    lang: () => o.lang ?? 'en',
    theme: () => o.theme ?? 'dark',
    openTargetTab: (given: Json, opener: unknown) => {
      cx.log('openTargetTab', { ...given, id: 'ID' }, opener)
      if (o.openTarget === 'throws') throw new Error('no tab could open')
    },
    ...(o.canConvert
      ? {
          openConvertedTab: (given: { content: Json } & Json, opener: unknown) => {
            cx.log('openConvertedTab', { ...(docView(given) as Json), id: 'ID' }, opener)
            if (o.openConverted === 'throws') throw new Error('no tab could open')
          },
        }
      : {}),
    starredGroupPaths: (group: string) => {
      cx.log('starredGroupPaths', group)
      return o.starred?.[group] ?? []
    },
    tabIdFor: () => undefined,
    openMaterials: base,
  }

  useElectron({
    BrowserWindow: FakeBrowserWindow,
    dialog: {
      showOpenDialog: async (win: FakeWin, options: unknown) => {
        cx.log('dialog', win.n, options)
        return { canceled: o.dialog?.canceled ?? true, filePaths: o.dialog?.filePaths ?? [] }
      },
    },
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        cx.log('ipc.handle', channel)
        handlers.set(channel, handler)
      },
      removeHandler: () => {},
      on: () => {},
    },
    nativeTheme: {
      get shouldUseDarkColors() {
        return o.dark ?? false
      },
      on: (_event: string, listener: () => void) => {
        themeListeners.push(listener)
        cx.log('nativeTheme.on', themeListeners.length)
      },
      off: (_event: string, listener: () => void) => {
        const at = themeListeners.indexOf(listener)
        if (at < 0) return
        themeListeners[at] = null
        cx.log('nativeTheme.off', at + 1)
      },
    },
    shell: { openExternal: async (url: string) => cx.log('openExternal', url) },
  })

  // the file calls resolve in a microtask, so a step is over when the microtasks are
  const realStat = fsPromises.stat
  const realReadFile = fsPromises.readFile
  fsPromises.stat = (async (path: string) => statSync(path)) as never
  fsPromises.readFile = (async (path: string) => readFileSync(path)) as never
  syncBuiltinESMExports()
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', {
    value: o.darwin ? 'darwin' : 'linux',
    configurable: true,
  })
  const realUrl = process.env.ELECTRON_RENDERER_URL
  if (o.rendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
  else process.env.ELECTRON_RENDERER_URL = o.rendererUrl
  unsaved.setOpenFilesSource(o.openFiles ? () => o.openFiles ?? [] : null)
  // the engines and the clock answer for the refreshes that float on between steps too
  box.engine = o.engine ?? {}
  box.log = cx.log
  const realNow = Date.now
  Date.now = () => cx.now
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => cx.log('warn', args[0], message(args[1]))

  try {
    // a copy of the module of its own: its state (deps, window, session) starts empty
    const url = `../../../apps/shell/src/main/generate/generate-window.ts?case=${(windowRun += 1)}`
    const module = (await import(url)) as typeof generateWindow
    const results: unknown[] = []
    for (const step of o.steps) {
      sends = []
      const result = await guarded(async () => {
        if ('configure' in step) {
          const before = handlers.size
          module.configureGenerateWindow(deps as never)
          return handlers.size - before
        }
        if ('open' in step) {
          module.openGenerateWindow({
            refs: step.open.refs as never,
            ...(step.open.kind ? { kind: step.open.kind as never } : {}),
            ...(step.open.parent ? { parent: explicit(step.open.parent) as never } : {}),
            ...(step.open.opener === undefined ? {} : { opener: step.open.opener as never }),
          })
          return null
        }
        if ('openPaths' in step) {
          module.openGenerateWindowWithPaths(
            step.openPaths.paths,
            explicit(step.openPaths.parent) as never,
          )
          return null
        }
        if ('openDocument' in step) {
          module.openGenerateWindowForDocument({
            webContentsId: step.openDocument.webContentsId,
            ...(step.openDocument.filePath === undefined
              ? {}
              : { filePath: step.openDocument.filePath }),
            title: step.openDocument.title,
            parent: explicit(step.openDocument.parent) as never,
          })
          return null
        }
        if ('close' in step) {
          module.closeGenerateWindow()
          return null
        }
        if ('contents' in step) return module.generateWindowContents()?.id ?? null
        if ('ipc' in step) {
          const handler = handlers.get(step.ipc.channel)
          if (!handler) return { error: 'no handler' }
          const from = step.ipc.from
          const sender =
            from === 'home'
              ? parentWin.webContents
              : from.startsWith('window:')
                ? (windows[Number(from.slice(7)) - 1]?.webContents ?? { id: 998 })
                : { id: 999 }
          const answer = await handler({ sender }, ...(step.ipc.args ?? []).map(arg))
          return answer === undefined ? null : answer
        }
        if ('event' in step) {
          const { window, name, url: eventUrl } = step.event
          if (name === 'theme') {
            for (const listener of [...themeListeners]) listener?.()
            return null
          }
          const target = windows[(window ?? 1) - 1]
          if (!target) return { error: 'no window' }
          if (name === 'ready-to-show') target.onceListeners['ready-to-show']?.()
          else if (name === 'open') return target.webContents.openHandler?.({ url: eventUrl ?? '' })
          else target.onListeners[name]?.()
          return null
        }
        if ('destroy' in step) {
          const target = windows[step.destroy - 1]
          if (target) target.destroyed = true
          return null
        }
        const target = windows[step.minimize - 1]
        if (target) target.minimized = true
        return null
      })
      // what floats on (a refresh no step waited for) lands before the next step
      await new Promise((resolve) => setImmediate(resolve))
      results.push({ result, sends })
    }
    return results
  } finally {
    box.engine = {}
    box.log = () => {}
    Date.now = realNow
    console.warn = realWarn
    unsaved.setOpenFilesSource(null)
    if (realUrl === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = realUrl
    if (realPlatform) Object.defineProperty(process, 'platform', realPlatform)
    fsPromises.stat = realStat
    fsPromises.readFile = realReadFile
    syncBuiltinESMExports()
    useElectron({})
  }
}

const TEXTS: Texts = Object.fromEntries(
  (['en', 'ko'] as const).map((lang) => [
    lang,
    Object.fromEntries(
      ['windowTitle', 'dialogAddTitle', 'filterSupported', 'untitled'].map((key) => [
        key,
        strings.generateText(lang, key as never),
      ]),
    ),
  ]),
)

const win = (
  steps: WindowStep[],
  over: Partial<WindowScenario> = {},
  files?: Case['files'],
): Case => ({
  args: [{ lang: 'en', theme: 'dark', parent: 'live', ...over, texts: TEXTS, steps }],
  ...(files ? { files } : {}),
})

const configure: WindowStep = { configure: true }
const ipc = (channel: string, from = 'window:1', ...args: unknown[]): WindowStep => ({
  ipc: { channel, from, args },
})
const fromWindow = (n: number) => `window:${n}`
const textFile = (text = 'hello world'): { text: string; mtimeMs: number } => ({
  text,
  mtimeMs: 7_000,
})

const READ = (name: string, length = 11): Json => ({
  [name]: { ok: true, kind: 'text', text: 'x'.repeat(length) },
})

const windowCases: Case[] = [
  // before configure: nothing opens, nothing answers
  win([
    { open: { refs: [{ path: '/m/a.txt' }] } },
    ipc('generate:get-state'),
    { contents: true },
    { close: true },
    { openPaths: { paths: [] } },
  ]),
  // configure registers the handlers once; the first window, its options and what it shows
  win(
    [
      configure,
      configure,
      { openPaths: { paths: ['$DIR/a.txt', '$DIR/gone.txt'] } },
      ipc('generate:get-state'),
      ipc('generate:get-state', 'other'),
      ipc('generate:get-state', 'home'),
      ipc('generate:get-theme'),
      ipc('generate:get-theme', 'other'),
      { event: { window: 1, name: 'ready-to-show' } },
      { contents: true },
    ],
    { engine: { parse: READ('a.txt') } },
    { 'a.txt': textFile() },
  ),
  // macOS keeps its own frame; the Korean title; the dev server's page
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/a.txt'] } },
      { event: { name: 'theme' } },
      { event: { window: 1, name: 'ready-to-show' } },
    ],
    {
      darwin: true,
      dark: true,
      lang: 'ko',
      theme: 'light',
      rendererUrl: 'http://localhost:5173',
      engine: { parse: READ('a.txt') },
    },
    { 'a.txt': textFile() },
  ),
  win([configure, { openPaths: { paths: [] } }, { contents: true }], { rendererUrl: '' }),
  // the title band follows the theme; a window torn down meanwhile is left alone
  win(
    [
      configure,
      { open: { refs: [{ path: '/m/none.txt' }] } },
      { event: { name: 'theme' } },
      { destroy: 1 },
      { event: { name: 'theme' } },
      ipc('generate:get-state'),
      { contents: true },
      { close: true },
    ],
    { dark: true },
  ),
  win([configure, { open: { refs: [{ path: '/m/none.txt' }] } }, { event: { name: 'theme' } }], {
    overlayThrows: true,
  }),
  // no parent: the window stands alone; a parent the caller names wins over the shell's
  win([configure, { openPaths: { paths: [] } }], { parent: undefined }),
  win([
    configure,
    { openPaths: { paths: [], parent: 'explicit' } },
    { close: true },
    { openPaths: { paths: [], parent: 'explicit-destroyed' } },
  ]),
  win([configure, { openPaths: { paths: [] } }, { close: true }, { openPaths: { paths: [] } }], {
    parent: 'destroyed',
  }),
  // opened again while open: the same window starts over; a minimized one is restored first
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/a.txt'] } },
      { openPaths: { paths: ['$DIR/b.txt'] } },
      ipc('generate:get-state'),
      { minimize: 1 },
      {
        open: {
          refs: [{ path: '$DIR/a.txt' }],
          kind: 'html',
          opener: { kind: 'window', webContentsId: 7 },
        },
      },
      ipc('generate:get-state'),
    ],
    { engine: { parse: { ...READ('a.txt', 3), ...READ('b.txt', 4) } } },
    { 'a.txt': textFile(), 'b.txt': textFile() },
  ),
  // a window that was torn down is replaced; the old one's late 'closed' leaves the new one alone
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/a.txt'] } },
      { destroy: 1 },
      { openPaths: { paths: ['$DIR/a.txt'] } },
      { event: { window: 1, name: 'closed' } },
      ipc('generate:get-state', fromWindow(1)),
      ipc('generate:get-state', fromWindow(2)),
      { event: { window: 1, name: 'focus' } },
      { event: { window: 2, name: 'focus' } },
      { event: { window: 2, name: 'closed' } },
      ipc('generate:get-state', fromWindow(2)),
      { contents: true },
    ],
    { engine: { parse: READ('a.txt') } },
    { 'a.txt': textFile() },
  ),
  // what the window's page asks for
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/a.txt', '$DIR/b.md'] } },
      ipc('generate:set-kind', 'window:1', 'mindmap'),
      ipc('generate:set-kind', 'other', 'html'),
      ipc('generate:set-kind', 'window:1', 'bogus'),
      ipc('generate:set-convert', 'window:1', null),
      ipc('generate:set-convert', 'other', 'mindmap-to-markdown'),
      ipc('generate:remove-material', 'window:1', '$DIR/b.md'),
      ipc('generate:remove-material', 'other', '$DIR/a.txt'),
      ipc('generate:refresh'),
      ipc('generate:refresh', 'other'),
      ipc('generate:get-state'),
    ],
    { engine: { parse: { ...READ('a.txt'), ...READ('b.md', 5) } } },
    { 'a.txt': textFile(), 'b.md': textFile() },
  ),
  // the file picker: cancelled, and picked files that join the list
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/a.txt'] } },
      ipc('generate:add-materials'),
      ipc('generate:add-materials', 'other'),
      ipc('generate:get-state'),
    ],
    { dialog: { canceled: true, filePaths: ['$DIR/b.txt'] }, engine: { parse: READ('a.txt') } },
    { 'a.txt': textFile() },
  ),
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/a.txt'] } },
      ipc('generate:add-materials'),
      ipc('generate:get-state'),
    ],
    {
      lang: 'ko',
      dialog: { canceled: false, filePaths: ['$DIR/b.txt', '$DIR/gone.txt'] },
      engine: { parse: { ...READ('a.txt'), ...READ('b.txt', 6) } },
    },
    { 'a.txt': textFile(), 'b.txt': textFile() },
  ),
  win([configure, ipc('generate:add-materials')], {}),
  // "make": the tab opens and the window goes; a refusal keeps it
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/a.txt'] } },
      ipc('generate:make', 'other', ''),
      ipc('generate:make', 'window:1', 'a short deck'),
      ipc('generate:get-state'),
      { event: { window: 1, name: 'closed' } },
      ipc('generate:make'),
    ],
    { engine: { parse: READ('a.txt') } },
    { 'a.txt': textFile() },
  ),
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/gone.txt'] } },
      ipc('generate:make', 'window:1', 'go'),
      ipc('generate:get-state'),
    ],
    { engine: { parse: {} } },
  ),
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/a.txt'] } },
      ipc('generate:make', 'window:1', 'go'),
      ipc('generate:get-state'),
      ipc('generate:cancel', 'other'),
      ipc('generate:cancel'),
      ipc('generate:get-state'),
      { contents: true },
    ],
    { openTarget: 'throws', engine: { parse: READ('a.txt') } },
    { 'a.txt': textFile() },
  ),
  // saving a material the window lists as unsaved
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/a.docx', '$DIR/b.txt'] } },
      ipc('generate:get-state'),
      ipc('generate:save-material', 'other', '$DIR/a.docx'),
      ipc('generate:save-material', 'window:1', '$DIR/a.docx'),
      ipc('generate:get-state'),
    ],
    {
      openFiles: [{ filePath: '$DIR/a.docx', dirty: true }],
      tabs: [{ id: 't1', kind: 'docs', title: 'a', filePath: '$DIR/a.docx', dirty: true }],
      contents: { t1: { id: 31 } },
      save: ['docs'],
      engine: { parse: READ('b.txt') },
    },
    { 'a.docx': textFile(), 'b.txt': textFile() },
  ),
  // a document that was never saved
  win(
    [
      configure,
      { openDocument: { webContentsId: 31, title: 'Untitled 1' } },
      ipc('generate:get-state'),
      ipc('generate:save-material', 'window:1', 'untitled:31'),
    ],
    {
      tabs: [{ id: 't1', kind: 'docs', title: 'Untitled 1', dirty: true }],
      contents: { t1: { id: 31 } },
    },
  ),
  win(
    [
      configure,
      {
        openDocument: { webContentsId: 32, filePath: '$DIR/a.txt', title: 'A', parent: 'explicit' },
      },
      ipc('generate:make', 'window:1', 'from a document'),
      { close: true },
      {
        openDocument: {
          webContentsId: 33,
          filePath: '',
          title: 'Blank',
          parent: 'explicit-destroyed',
        },
      },
    ],
    { engine: { parse: READ('a.txt') } },
    { 'a.txt': textFile() },
  ),
  // Home's two channels
  win(
    [
      configure,
      ipc('generate:open-with-paths', 'home', [
        '$DIR/a.txt',
        7,
        '',
        'x'.repeat(4097),
        `/${'y'.repeat(4095)}`,
        '$DIR/b.txt',
      ]),
      ipc('generate:open-with-paths', 'home', 'nope'),
      { close: true },
      ipc('generate:open-with-paths', 'other', ['$DIR/a.txt']),
      { contents: true },
      ipc('generate:open-with-group', 'other', 'Starred'),
      ipc('generate:open-with-group', 'home', 7),
      ipc('generate:open-with-group', 'home', ''),
      ipc('generate:open-with-group', 'home', 'Starred'),
      { contents: true },
    ],
    {
      starred: { Starred: ['$DIR/a.txt'] },
      engine: { parse: { ...READ('a.txt'), ...READ('b.txt', 6) } },
    },
    { 'a.txt': textFile(), 'b.txt': textFile() },
  ),
  win([configure, ipc('generate:open-with-paths', 'home', ['$DIR/a.txt']), { contents: true }], {
    parent: 'destroyed',
  }),
  win([configure, ipc('generate:open-with-paths', 'home', ['$DIR/a.txt']), { contents: true }], {
    parent: undefined,
  }),
  // links in the window open in the browser only when they are safe
  win([
    configure,
    { open: { refs: [{ path: '/m/none.txt' }] } },
    { event: { window: 1, name: 'open', url: 'https://example.com/help' } },
    { event: { window: 1, name: 'open', url: ' http://example.com/x ' } },
    { event: { window: 1, name: 'open', url: 'javascript:alert(1)' } },
    { event: { window: 1, name: 'open', url: 'file:///etc/passwd' } },
    { event: { window: 1, name: 'open', url: 'not a url' } },
  ]),
  // conversions: the map offers three; "make" opens the result and closes
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/map.xmind'] } },
      ipc('generate:get-state'),
      ipc('generate:set-convert', 'window:1', 'mindmap-to-markdown'),
      ipc('generate:get-state'),
      ipc('generate:make', 'window:1', 'ignored'),
      ipc('generate:get-state'),
    ],
    {
      canConvert: true,
      lang: 'ko',
      engine: {
        parse: { 'map.xmind': { ok: true, kind: 'text', text: '- Central\n  - A' } },
      },
    },
    { 'map.xmind': textFile() },
  ),
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/note.md'] } },
      ipc('generate:set-convert', 'window:1', 'markdown-to-mindmap'),
      ipc('generate:get-state'),
      ipc('generate:make'),
    ],
    {
      canConvert: true,
      engine: { parse: { 'note.md': { ok: true, kind: 'text', text: '{{label}} text' } } },
    },
    { 'note.md': { text: 'secret text', mtimeMs: 8_000 } },
  ),
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/map.xmind'] } },
      ipc('generate:set-convert', 'window:1', 'mindmap-to-slides'),
      ipc('generate:make'),
      ipc('generate:get-state'),
    ],
    {
      canConvert: true,
      openConverted: 'throws',
      engine: {
        parse: { 'map.xmind': { ok: true, kind: 'text', text: '- Central\n  - A' } },
        root: topic('Central', topic('A')),
        slides: { count: 2 },
      },
    },
    { 'map.xmind': textFile() },
  ),
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/map.xmind'] } },
      ipc('generate:set-convert', 'window:1', 'mindmap-to-markdown'),
      ipc('generate:get-state'),
    ],
    {
      engine: { parse: { 'map.xmind': { ok: true, kind: 'text', text: '- Central' } } },
    },
    { 'map.xmind': textFile() },
  ),
]

// ---------------------------------------------------------------------------
// the group
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// cases added after the first fault run: appended, so the ledger's indexes hold
// ---------------------------------------------------------------------------

const valueCasesMore = [...valueCases, ...each([' mindmap-to-markdown'], [' slides '])]

const inspectCasesMore: Case[] = [
  {
    // a reader that says no gives no length, whatever else it hands back
    args: [
      {
        stat: { '/m/n.txt': { size: 3, mtimeMs: 1 } },
        engine: { parse: { '/m/n.txt': { ok: false, kind: 'text', text: 'abc' } } },
        injectParse: true,
        steps: [{ inspect: '/m/n.txt' }],
      },
    ],
  },
  {
    // the cache keeps 64 lengths: after 66 files the second one is read again
    args: [
      {
        engine: {
          parse: Object.fromEntries(
            Array.from({ length: 66 }, (_, i) => [`f${i}.txt`, text(i + 1)]),
          ),
        },
        steps: [
          ...Array.from({ length: 66 }, (_, i) => ({ inspect: `$DIR/f${i}.txt` })),
          { inspect: '$DIR/f1.txt' },
          { inspect: '$DIR/f64.txt' },
        ],
      },
    ],
    files: Object.fromEntries(
      Array.from({ length: 66 }, (_, i) => [`f${i}.txt`, { text: 'x', mtimeMs: 3000 }]),
    ),
  },
]

const openCasesMore: Case[] = [
  {
    // editors the host gave no save for: shown, never written
    args: [
      {
        tabs: [
          tab('m1', 'markdown', '$DIR/a.md'),
          tab('h1', 'html', '$DIR/a.html'),
          tab('k1', 'mindmap', '$DIR/a.xmind'),
        ],
        contents: { m1: { id: 41 }, h1: { id: 42 }, k1: { id: 43 } },
        save: [],
        steps: [
          { saveActionFor: '$DIR/a.md' },
          { saveActionFor: '$DIR/a.html' },
          { saveActionFor: '$DIR/a.xmind' },
          { saveMaterial: '$DIR/a.md' },
          { saveMaterial: '$DIR/a.html' },
          { saveMaterial: '$DIR/a.xmind' },
        ],
      },
    ],
  },
]

const markdownCasesMore: Case[] = [
  {
    // a mark counts only with a blank after it: a glued one is a topic
    args: [
      {
        engine: { root: topic('Central', topic('kept')) },
        steps: [
          {
            markdown: {
              outline:
                '- Central\n  - (boundary)glued\n  - (relationship)also\n  - (boundary) fenced\n  - kept',
              untitled: 'U',
            },
          },
        ],
      },
    ],
  },
  {
    // siblings below a bullet keep their order
    args: [
      {
        engine: {
          root: topic(
            'Central',
            topic('A', topic('A1', topic('x'), topic('y'), topic('z')), topic('A2')),
          ),
        },
        steps: [{ markdown: { outline: MAP, untitled: 'U' } }],
      },
    ],
  },
]

const noticeCasesMore: Case[] = [
  {
    // the cache keeps 32 answers: after 34 files the second one is read again
    args: [
      {
        engine: {
          parse: Object.fromEntries(
            Array.from({ length: 34 }, (_, i) => [`n${i}.md`, parsed(i % 2 === 0 ? 'x' : 'y')]),
          ),
        },
        steps: [
          ...Array.from({ length: 34 }, (_, i) => ({ notice: `$DIR/n${i}.md` })),
          { notice: '$DIR/n1.md' },
          { notice: '$DIR/n33.md' },
        ],
      },
    ],
    files: Object.fromEntries(
      Array.from({ length: 34 }, (_, i) => [`n${i}.md`, { text: 'x', mtimeMs: 6000 }]),
    ),
  },
]

const sessionCasesMore: Case[] = [
  // a closed session stays quiet: a read after "make" pushes nothing
  sess({
    refs: [p(A)],
    inspect: { [A]: [ok(A)] },
    ids: MAKE_IDS,
    steps: [{ refresh: true }, { make: 'go' }, { refresh: true }, { state: true }],
  }),
  // "make" starts from a clean slate: the failure of an earlier save is gone from its first push
  sess({
    refs: [p(A)],
    saveActionFor: { [A]: 'save' },
    saveMaterial: { [A]: 'failed' },
    inspect: { [A]: [unsavedAt(A), ok(A)] },
    ids: MAKE_IDS,
    steps: [{ refresh: true }, { save: A }, { state: true }, { make: 'go' }],
  }),
]

const windowCasesMore: Case[] = [
  // a cancel from another page leaves the window; the window's own closes it
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/a.txt'] } },
      ipc('generate:cancel', 'other'),
      ipc('generate:get-state'),
      { contents: true },
      ipc('generate:cancel'),
      ipc('generate:get-state'),
      { contents: true },
    ],
    { engine: { parse: READ('a.txt') } },
    { 'a.txt': textFile() },
  ),
  // another page cannot choose a conversion; the window's page can
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/map.xmind'] } },
      ipc('generate:set-convert', 'other', 'mindmap-to-markdown'),
      ipc('generate:get-state'),
      ipc('generate:set-convert', 'window:1', 'mindmap-to-markdown'),
      ipc('generate:get-state'),
    ],
    {
      canConvert: true,
      engine: { parse: { 'map.xmind': { ok: true, kind: 'text', text: '- Central\n  - A' } } },
    },
    { 'map.xmind': textFile() },
  ),
  // a torn-down window's focus does not read the session of the window that replaced it
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/a.txt'] } },
      { destroy: 1 },
      { openPaths: { paths: ['$DIR/a.txt'] } },
      { event: { window: 1, name: 'focus' } },
      { event: { window: 2, name: 'focus' } },
    ],
    { engine: { parse: READ('a.txt') } },
    { 'a.txt': textFile() },
  ),
  // a closed window's focus reads nothing (a never-saved document is asked for its tab), and it has no contents
  win(
    [
      configure,
      { openDocument: { webContentsId: 31, title: 'Untitled 1' } },
      { close: true },
      { event: { window: 1, name: 'focus' } },
      { contents: true },
      ipc('generate:get-state'),
    ],
    {
      tabs: [{ id: 't1', kind: 'docs', title: 'Untitled 1', dirty: true }],
      contents: { t1: { id: 31 } },
    },
  ),
  // markdown to a map through the window: the engine is asked with the window's "untitled" text
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/note.md'] } },
      ipc('generate:set-convert', 'window:1', 'markdown-to-mindmap'),
      ipc('generate:make', 'window:1', ''),
      ipc('generate:get-state'),
    ],
    {
      canConvert: true,
      lang: 'ko',
      engine: { parse: { 'note.md': { ok: true, kind: 'text', text: '- one\n- two' } } },
    },
    { 'note.md': { text: '- one\n- two', mtimeMs: 8_000 } },
  ),
  // an editor's save that fails: the failure shows and nothing waits for another look
  win(
    [
      configure,
      { openPaths: { paths: ['$DIR/a.docx', '$DIR/b.md'] } },
      ipc('generate:get-state'),
      ipc('generate:save-material', 'window:1', '$DIR/a.docx'),
      ipc('generate:get-state'),
      ipc('generate:save-material', 'window:1', '$DIR/b.md'),
      ipc('generate:get-state'),
    ],
    {
      openFiles: [
        { filePath: '$DIR/a.docx', dirty: true },
        { filePath: '$DIR/b.md', dirty: true },
      ],
      tabs: [
        { id: 't1', kind: 'docs', title: 'a', filePath: '$DIR/a.docx', dirty: true },
        { id: 't2', kind: 'markdown', title: 'b', filePath: '$DIR/b.md', dirty: true },
      ],
      contents: { t1: { id: 31 }, t2: { id: 32 } },
      save: ['docs', 'markdown'],
      saveResult: { docs: 'throws', markdown: false },
      engine: { parse: {} },
    },
    { 'a.docx': textFile(), 'b.md': textFile() },
  ),
]

const stepsOf = (c: Case): WindowStep[] => (c.args[0] as WindowScenario).steps
const windowWith = (key: string, limit = Infinity): Case[] =>
  windowCases.filter((c) => stepsOf(c).some((step) => key in step)).slice(0, limit)

const attachableCases = each(
  ['png'],
  ['PNG'],
  ['.PNG'],
  ['docx'],
  ['pdf'],
  ['TXT'],
  ['md'],
  ['xls'],
  ['drawio.png'],
  ['..png'],
  [''],
  ['exe'],
)

export const group: Group = {
  // ---- limits
  'limits.LONG_MATERIAL_NOTICE_CHARS': constant('a limit', () => limits.LONG_MATERIAL_NOTICE_CHARS),
  'limits.USAGE_NOTICE_CHARS': constant('a limit', () => limits.USAGE_NOTICE_CHARS),
  'limits.MAX_MATERIALS': constant('a limit', () => limits.MAX_MATERIALS),
  'limits.MAX_MATERIAL_BYTES': constant('a limit', () => limits.MAX_MATERIAL_BYTES),
  'limits.MAX_IMAGE_MATERIAL_BYTES': constant('a limit', () => limits.MAX_IMAGE_MATERIAL_BYTES),
  'limits.MAX_REQUEST_TEXT_CHARS': constant('a limit', () => limits.MAX_REQUEST_TEXT_CHARS),

  // ---- title-bar
  'title-bar.GENERATE_TITLE_BAR_HEIGHT': constant(
    'the band height',
    () => titleBar.GENERATE_TITLE_BAR_HEIGHT,
  ),
  'title-bar.generateTitleBarOverlay': {
    ts: (a) => titleBar.generateTitleBarOverlay(a[0] as boolean),
    cases: each([true], [false]),
  },

  // ---- shared/generate-api, generate-default-prompts
  'generate-api.AI_TARGET_KINDS': constant('the kinds', () => [...api.AI_TARGET_KINDS]),
  'generate-api.CONVERT_KINDS': constant('the conversions', () => [...api.CONVERT_KINDS]),
  'generate-api.GENERATE_CHANNELS': constant('the channel names', () => api.GENERATE_CHANNELS),
  'generate-home-channels.GENERATE_HOME_CHANNELS': constant(
    'the channel names',
    () => homeChannels.GENERATE_HOME_CHANNELS,
  ),
  'generate-api.CONVERT_TARGETS': constant(
    'the editor of each conversion',
    () => api.CONVERT_TARGETS,
  ),
  'generate-default-prompts.DEFAULT_GENERATE_PROMPTS': constant(
    'the default requests',
    () => prompts.DEFAULT_GENERATE_PROMPTS,
  ),
  'generate-default-prompts.defaultGeneratePrompt': {
    ts: (a) => prompts.defaultGeneratePrompt(a[0] as never, a[1] as never),
    cases: each(
      ['en', 'slides'],
      ['en', 'html'],
      ['en', 'mindmap'],
      ['ko', 'slides'],
      ['ko', 'html'],
      ['ko', 'mindmap'],
    ),
  },

  // ---- file-parse/attachable
  'file-parse/attachable.ATTACHABLE_EXTS': constant('the list', () => [
    ...attachable.ATTACHABLE_EXTS,
  ]),
  'file-parse/attachable.ATTACHABLE_IMAGE_EXTS': constant('the list', () => [
    ...attachable.ATTACHABLE_IMAGE_EXTS,
  ]),
  'file-parse/attachable.ATTACHABLE_MAX_BYTES': constant(
    'the cap',
    () => attachable.ATTACHABLE_MAX_BYTES,
  ),
  'file-parse/attachable.ATTACHABLE_IMAGE_MAX_BYTES': constant(
    'the cap',
    () => attachable.ATTACHABLE_IMAGE_MAX_BYTES,
  ),
  'file-parse/attachable.attachableMaxBytes': {
    ts: (a) => attachable.attachableMaxBytes(a[0] as string),
    cases: attachableCases,
  },
  'file-parse/attachable.isAttachableExt': {
    ts: (a) => attachable.isAttachableExt(a[0] as string),
    cases: attachableCases,
  },

  // ---- materials
  'materials.IMAGE_MATERIAL_EXTS': constant('the list', () => [...materials.IMAGE_MATERIAL_EXTS]),
  'materials.SUPPORTED_MATERIAL_EXTS': constant('the list', () => [
    ...materials.SUPPORTED_MATERIAL_EXTS,
  ]),
  'materials.materialMaxBytes': {
    ts: (a) => materials.materialMaxBytes(a[0] as string),
    cases: maxBytesCases,
  },
  'materials.extOf': { ts: (a) => materials.extOf(a[0] as string), cases: extCases },
  'materials.materialKey': { ts: (a) => materials.materialKey(a[0] as string), cases: keyCases },
  'materials.untitledMaterial': {
    ts: (a) => materials.untitledMaterial(a[0] as number, a[1] as string),
    cases: untitledCases,
  },
  'materials.inspectMaterial': {
    ts: (a, cx) => runInspect(a[0] as InspectScenario, cx),
    cases: [...inspectCases, ...inspectCasesMore],
  },
  'materials.generateNotices': {
    ts: (a) => materials.generateNotices(a[0] as never, a[1] as number),
    cases: generateNoticeCases,
  },
  'materials.summarizeMaterials': {
    ts: (a) => materials.summarizeMaterials(a[0] as never, a[1] as never),
    cases: summaryCases,
  },

  // ---- request
  'request.isAiTargetKind': { ts: (a) => request.isAiTargetKind(a[0]), cases: valueCasesMore },
  'request.isConvertKind': { ts: (a) => request.isConvertKind(a[0]), cases: valueCasesMore },
  'request.availableConversions': {
    ts: (a) => request.availableConversions(a[0] as string[]),
    cases: conversionCases,
  },
  'request.validateGenerateRequest': {
    ts: (a) => request.validateGenerateRequest(a[0]),
    cases: validateCases,
  },
  'request.prepareGenerateRequest': {
    ts: (a, cx) => runPrepare(a[0], a[1] as PrepareScenario, cx),
    cases: prepareCases,
  },

  // ---- open-materials
  'open-materials.createOpenMaterials': {
    ts: (a, cx) => runOpen(a[0] as OpenScenario, cx),
    cases: [...openCases, ...openCasesMore],
  },

  // ---- convert
  'convert.convertSource': {
    ts: (a, cx) => runConvert(a[0] as ConvertScenario, cx),
    cases: convertCases,
  },
  'convert.mapOutlineToSlidesMarkdown': {
    ts: (a, cx) => runConvert(a[0] as ConvertScenario, cx),
    cases: [...markdownCases, ...markdownCasesMore],
  },
  'convert.mapOutlineToSlides': {
    ts: (a, cx) => runConvert(a[0] as ConvertScenario, cx),
    cases: slidesCases,
  },
  'convert.buildDeck': {
    ts: (a, cx) => runConvert(a[0] as ConvertScenario, cx),
    cases: buildCases,
  },
  'convert.markdownRedactionNotice': {
    ts: (a, cx) => runNotice(a[0] as NoticeScenario, cx),
    cases: [...noticeCases, ...noticeCasesMore],
  },

  // ---- converted-tab
  'converted-tab.queueConvertedContent': {
    ts: (a, cx) => runConvertedTab(a[0] as ConvertedTabScenario, cx),
    cases: convertedTabCases,
  },

  // ---- session
  'session.GenerateSession': {
    ts: (a, cx) => runSession(a[0] as SessionScenario, cx),
    cases: [...sessionCases, ...sessionCasesMore],
  },

  // ---- generate-window
  'generate-window.configureGenerateWindow': {
    ts: (a, cx) => runWindow(a[0] as WindowScenario, cx),
    cases: windowWith('configure', 4),
  },
  'generate-window.openGenerateWindow': {
    ts: (a, cx) => runWindow(a[0] as WindowScenario, cx),
    cases: [...windowCases, ...windowCasesMore],
  },
  'generate-window.openGenerateWindowWithPaths': {
    ts: (a, cx) => runWindow(a[0] as WindowScenario, cx),
    cases: windowWith('openPaths', 6),
  },
  'generate-window.openGenerateWindowForDocument': {
    ts: (a, cx) => runWindow(a[0] as WindowScenario, cx),
    cases: windowWith('openDocument'),
  },
  'generate-window.closeGenerateWindow': {
    ts: (a, cx) => runWindow(a[0] as WindowScenario, cx),
    cases: windowWith('close', 6),
  },
  'generate-window.generateWindowContents': {
    ts: (a, cx) => runWindow(a[0] as WindowScenario, cx),
    cases: windowWith('contents', 6),
  },
}
