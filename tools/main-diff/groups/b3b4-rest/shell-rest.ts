/**
 * Part `shell-rest` of group `b3b4-rest`: the rest of the shell's main modules
 * of batches B3 and B4 and the slides modules (dropped files, document links
 * in the shell, headless export, the slides print entry, the transaction core,
 * autofit write-back and the seed deck). The Rust side is
 * crates/main-core/src/calls/b3b4_rest/shell_rest.rs.
 *
 * Electron is the fake of electron-fake.ts. What the Rust ports take as a trait
 * (the pptx engine, the render layer, the session registry, the hidden-content
 * check, the make window) is a stub module here, in a copy of the module under
 * test (`loadPatched`: the source text with its relative imports made absolute
 * and the named imports pointed at a stub, written to tools/main-diff/out); the
 * stubs answer from the case and log each call as one line, as the Rust fakes
 * do. Modules that keep state at module level are loaded again for each case.
 *
 * - drop-open.partitionDropPayload: the payload as the preload sends it.
 * - dropped-files.handleDroppedFiles: `deps` answers from the case.
 * - shell/headless-export.*: a fake `HeadlessFs`, fake exporters and a stub of
 *   `fileHoldsHiddenContent` (the text of a file holding `HIDDEN` holds hidden
 *   content, one holding `THROW` makes the check throw).
 * - slides/print-window.printSlidesHtml: the window script of b2-print.
 * - session-txn.applyTxnToSession: the engine answers from `plans` (each call
 *   of `runTxn` takes the next) and `run`.
 * - autofit-writeback.*: the render slide and the model are JSON.
 * - seed-deck.openSlidesSeed: the engine and the session registry log.
 * - document-links-shell.scenario: steps over the configured module.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import '../../electron-fake.ts'
import type { Case, FnSpec, Group, TsContext } from '../../types.ts'

// loaded after electron-fake.ts has registered its hooks
const dropOpen = await import('../../../../packages/electron-utils/src/drop-open.ts')
const droppedFiles = await import('../../../../apps/shell/src/main/dropped-files.ts')
const handoff = await import('../../../../packages/electron-utils/src/generate-handoff.ts')
const seedQueue = await import('../../../../apps/slides/src/main/seed-queue.ts')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any

const repo = new URL('../../../../', import.meta.url)
const scratch = new URL('../../out/b3b4-shell-rest/', import.meta.url)
let scratchCount = 0
let scratchReady = false

function scratchFile(name: string, source: string): string {
  if (!scratchReady) {
    mkdirSync(fileURLToPath(scratch), { recursive: true })
    process.on('exit', () => rmSync(fileURLToPath(scratch), { recursive: true, force: true }))
    scratchReady = true
  }
  scratchCount += 1
  const path = fileURLToPath(new URL(`${scratchCount}-${name}`, scratch))
  writeFileSync(path, source)
  return pathToFileURL(path).href
}

/** `from` replaced by `to` where the source has it, or an error naming the file */
function must(src: string, from: string, to: string, file: string): string {
  if (!src.includes(from)) throw new Error(`${file}: no ${JSON.stringify(from)} to patch`)
  return src.split(from).join(to)
}

/**
 * The module at `file` (from the repository root) as a copy of its source:
 * `patch` first, then every relative import made absolute so the copy can sit
 * in the scratch folder.
 */
async function loadPatched(file: string, patch: (src: string) => string): Promise<J> {
  const original = new URL(file, repo)
  const dir = dirname(fileURLToPath(original))
  const src = patch(readFileSync(original, 'utf8')).replace(
    /(from\s+|import\()\s*'(\.{1,2}\/[^']+)'/g,
    (_m: string, pre: string, spec: string) => {
      const target = resolvePath(dir, spec)
      const withExt = /\.(ts|mts|js|json)$/.test(target) ? target : `${target}.ts`
      return `${pre}'${pathToFileURL(withExt).href}'`
    },
  )
  return import(scratchFile(basename(file).replace(/\.ts$/, '.mts'), src))
}

const g = globalThis as J
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value)

/** `Date.now()` of the case while `run` runs */
async function withNow<T>(now: number, run: () => Promise<T> | T): Promise<T> {
  const Real = Date
  class Clock extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(now)
      else super(...(args as [number]))
    }
    static now(): number {
      return now
    }
  }
  g.Date = Clock
  try {
    return await run()
  } finally {
    g.Date = Real
  }
}

// ---------------------------------------------------------------------------
// drop-open, dropped-files
// ---------------------------------------------------------------------------

const many = (n: number, make: (i: number) => string): string[] =>
  Array.from({ length: n }, (_, i) => make(i))

const DROPS: unknown[] = [
  [],
  null,
  'a.docx',
  { 0: 'a.docx' },
  42,
  ['/a/b.docx', '/a/c.xlsx', '/a/d.pptx'],
  ['  /a/b.docx  ', '/a/b.docx', '\u00a0/a/b.docx', '\ufeff/a/b.docx\ufeff'],
  ['/a/b.docx', 7, null, { x: 1 }, ['/a/c.docx'], true],
  ['', '   ', '\t\n'],
  ['/a/SKILL.md', '/a/sub/skill.md', 'skill.md', 'C:\\w\\Skill.MD', '/a/myskill.md'],
  ['/a/pack.zip', '/a/PACK.ZIP', '/a/pack.zip.bak'],
  ['/a/readme.md', '/a/readme.markdown'],
  ['/a/x.rtf', '/a/y.RTF', '/a/z.pps', '/a/w.xlsb', '/a/v.pages', '/a/u.key', '/a/t.numbers'],
  ['/a/x.rtf', '/a/y.PAGES', '/a/z.Pages', '/a/w.RTF'],
  ['/a/x.png', '/a/y.exe', '/a/z', '/a/dir/', 'docx', '.docx', '/a/x.docx.txt'],
  ['/a/x.drawio.svg', '/a/x.drawio.png', '/a/x.drawio', '/a/x.dio', '/a/x.svg', '/a/x.vsdx'],
  ['/a/x.hwp', '/a/x.hwpx', '/a/x.epub', '/a/x.xmind', '/a/x.mm', '/a/x.ods', '/a/x.odp'],
  ['/a/x.DOCX', '/a/x.Docx', '/a/x.doc', '/a/x.dot', '/a/x.odt', '/a/x.otp'],
  many(25, (i) => `/a/f${i}.docx`),
  many(25, (i) => `/a/f${i}.zip`),
  [...many(25, (i) => `/a/f${i}.docx`), '/a/late.rtf', '/a/late.zip'],
  [...many(21, (i) => `/a/s${i}.md`), '/a/z.zip'],
  ['/a/\u00e9\u{1F600}.docx', '/a/\u00e9.rtf', '/a/\u00e9.zip'],
  ['/a/x.docx\n', '/a/x.rtf\r\n', '/a/x.zip '],
  ['/a/x.docx', '/a/x.docx', '/a/x.docx ', ' /a/x.rtf', '/a/x.rtf'],
  ['/a/skill.md.zip', '/a/x.zip/skill.md', '\\skill.md', '/skill.mdx'],
]

const partition: FnSpec = {
  ts: (a) => dropOpen.partitionDropPayload(a[0]),
  cases: DROPS.map((payload): Case => ({ args: [payload] })),
}

/** the answers of `deps` of one case, by path */
interface DropWorld {
  /** paths that open (true) or do not (false); a path left out does not open */
  opens?: Record<string, boolean>
  /** `skillSourceOf` by path: 'source', 'none' (undefined) or 'reject' */
  skills?: Record<string, string>
}

async function runDropped(raw: unknown, world: DropWorld, cx: TsContext): Promise<void> {
  await droppedFiles.handleDroppedFiles(raw, {
    openDocumentPath: (path: string) => {
      cx.log('open', path)
      return world.opens?.[path] === true
    },
    revealShellWindow: () => cx.log('reveal'),
    showWarning: (message: string) => cx.log('warn', message),
    unsupportedMessage: (exts: string[]) => {
      cx.log('unsupportedMessage', exts)
      return `unsupported: ${exts.join(',')}`
    },
    skillSourceOf: async (path: string) => {
      cx.log('skillSourceOf', path)
      const answer = world.skills?.[path]
      if (answer === 'reject') throw new Error('unreadable')
      return answer === 'source' ? { name: `skills of ${path}` } : undefined
    },
    importSkills: (source: { name: string }) => cx.log('import', source.name),
    noSkillsFound: () => cx.log('noSkillsFound'),
  } as J)
}

const dropCase = (raw: unknown, world: DropWorld, note?: string): Case => ({
  args: [raw, world],
  ...(note ? { note } : {}),
})

const handleDropped: FnSpec = {
  ts: async (a, cx) => {
    await runDropped(a[0], a[1] as DropWorld, cx)
  },
  cases: [
    dropCase(['/a/b.docx'], { opens: { '/a/b.docx': true } }),
    dropCase(['/a/b.docx'], {}, 'the path did not open: no reveal'),
    dropCase(
      ['/a/b.docx', '/a/c.xlsx', '/a/d.pptx'],
      { opens: { '/a/c.xlsx': true } },
      'one of three opens: reveal once',
    ),
    dropCase(['/a/x.rtf', '/a/y.pages'], {}, 'unsupported only: one combined warning'),
    dropCase(['/a/b.docx', '/a/x.rtf'], { opens: { '/a/b.docx': true } }),
    dropCase(['/a/s.zip'], { skills: { '/a/s.zip': 'source' } }, 'a skill file imports'),
    dropCase(['/a/s.zip'], { skills: { '/a/s.zip': 'none' } }, 'no skill: the one notice'),
    dropCase(['/a/s.zip'], { skills: { '/a/s.zip': 'reject' } }, 'a rejection reads as none'),
    dropCase(['/a/s.zip'], {}, 'a path the table does not know is none'),
    dropCase(
      ['/a/s.zip', '/a/t.zip'],
      { skills: { '/a/s.zip': 'none', '/a/t.zip': 'source' } },
      'a miss and a find: no notice',
    ),
    dropCase(
      ['/a/s.zip', '/a/t.zip'],
      { skills: { '/a/s.zip': 'none', '/a/t.zip': 'none' } },
      'two misses: one notice',
    ),
    dropCase(
      ['/a/b.docx', '/a/s.zip'],
      { opens: { '/a/b.docx': true }, skills: { '/a/s.zip': 'none' } },
      'beside a document that opened the miss stays silent',
    ),
    dropCase(
      ['/a/b.docx', '/a/s.zip'],
      { skills: { '/a/s.zip': 'none' } },
      'a document that did not open gives no cover to the miss',
    ),
    dropCase(
      ['/a/x.rtf', '/a/s.zip'],
      { skills: { '/a/s.zip': 'none' } },
      'beside an unsupported warning the miss stays silent',
    ),
    dropCase(
      ['/a/SKILL.md', '/a/b.md'],
      { opens: { '/a/b.md': true }, skills: { '/a/SKILL.md': 'source' } },
      'SKILL.md goes to the skills preview, not the editor',
    ),
    dropCase([], {}),
    dropCase(null, {}),
    dropCase('/a/b.docx', { opens: { '/a/b.docx': true } }, 'not a list: nothing happens'),
    dropCase(
      [...many(25, (i) => `/a/f${i}.docx`)],
      Object.fromEntries(many(25, (i) => `/a/f${i}.docx`).map((path) => [path, true])),
      'only the first twenty are opened',
    ),
  ],
}

// ---------------------------------------------------------------------------
// shell/headless-export
// ---------------------------------------------------------------------------

const HIDDEN_STUB = `
const world = () => globalThis.__b3b4Hidden
export const HIDDEN_CONTENT_EXTENSIONS = ['docx', 'pptx', 'xlsx', 'xlsm', 'md', 'markdown', 'html', 'htm']
export async function fileHoldsHiddenContent(bytes, ext) {
  const text = new TextDecoder().decode(bytes)
  world().log('fileHoldsHiddenContent', text, ext)
  if (text.includes('THROW')) throw new Error('hidden check failed')
  return text.includes('HIDDEN')
}
`

let headlessModule: Promise<J> | undefined
function headless(): Promise<J> {
  headlessModule ??= (async () => {
    const stub = scratchFile('hidden-stub.mjs', HIDDEN_STUB)
    return loadPatched('apps/shell/src/main/headless-export.ts', (src) =>
      must(
        src,
        "from '@seuoffice/file-parse/hidden-content'",
        `from '${stub}'`,
        'headless-export.ts',
      ),
    )
  })()
  return headlessModule
}

interface FsWorld {
  now?: number
  files?: string[]
  dirs?: string[]
  /** the canonical path of a path, where it differs */
  real?: Record<string, string>
  /** the modification times, a file left out being fresh */
  mtimes?: Record<string, number>
  /** the text of a file `read` answers; a file left out cannot be read */
  texts?: Record<string, string>
  noMtime?: boolean
  noRead?: boolean
}

interface ExporterWorld {
  writes?: Array<{ path: string; mtime?: number }>
  product?: { paths: string[]; detail?: unknown }
  throws?: 'error' | 'string'
}

interface RunWorld extends FsWorld {
  exporter?: ExporterWorld
  /** the placeholder export is there; `throws` makes it fail */
  placeholders?: ExporterWorld | null
}

const MODULES = ['docs', 'sheets', 'slides', 'markdown', 'html', 'hwp', 'diagram']

/** the request as Rust writes it back: the keys in one order */
function request(r: J): J {
  return {
    input: r.input,
    targetFormat: r.targetFormat,
    outPath: r.outPath,
    json: r.json === true,
    ...(r.page !== undefined ? { page: r.page } : {}),
    ...(r.ops !== undefined ? { ops: r.ops } : {}),
    ...(r.batch !== undefined ? { batch: r.batch } : {}),
  }
}

function fakeFs(world: FsWorld, log: TsContext['log']): { fs: J; write: (w: J) => void } {
  const files = new Set(world.files ?? [])
  const dirs = new Set(world.dirs ?? [])
  const mtimes: Record<string, number> = { ...(world.mtimes ?? {}) }
  const now = world.now ?? 1_000_000
  const fs: J = {
    exists: (path: string) => {
      log('exists', path)
      return files.has(path) || dirs.has(path)
    },
    isFile: (path: string) => {
      log('isFile', path)
      return files.has(path)
    },
    realpath: (path: string) => {
      log('realpath', path)
      return world.real?.[path] ?? path
    },
  }
  if (!world.noMtime) {
    fs.mtimeMs = (path: string) => {
      log('mtimeMs', path)
      return mtimes[path] ?? now
    }
  }
  if (!world.noRead) {
    fs.read = (path: string) => {
      log('read', path)
      const text = world.texts?.[path]
      if (text === undefined) throw new Error(`cannot read ${path}`)
      return new TextEncoder().encode(text)
    }
  }
  const write = (w: ExporterWorld): void => {
    for (const out of w.writes ?? []) {
      files.add(out.path)
      if (out.mtime !== undefined) mtimes[out.path] = out.mtime
    }
  }
  return { fs, write }
}

const validatePaths: FnSpec = {
  ts: async (a, cx) => {
    const mod = await headless()
    const world = a[1] as FsWorld
    const { fs } = fakeFs(world, cx.log)
    return mod.validateHeadlessPaths(request(a[0] as J), fs)
  },
  cases: [],
}

const req = (r: J): J => ({ json: false, ...r })

const V_FILES: FsWorld = {
  files: [
    '/w/in.docx',
    '/w/in.xlsx',
    '/w/in.pptx',
    '/w/in.md',
    '/w/in.html',
    '/w/in.hwp',
    '/w/in.drawio',
  ],
  dirs: ['/w', '/w/out', '/w/dir.pdf'],
}

validatePaths.cases = [
  { args: [req({ input: '/w/in.docx', targetFormat: 'pdf', outPath: '/w/out.pdf' }), V_FILES] },
  { args: [req({ input: '/w/in.docx', targetFormat: 'pdf', outPath: '/w/out.pdf' }), {}] },
  {
    args: [req({ input: '/w/out', targetFormat: 'pdf', outPath: '/w/out.pdf' }), V_FILES],
    note: 'a directory is not a file',
  },
  {
    args: [
      req({ input: '/w/in.txt', targetFormat: 'pdf', outPath: '/w/out.pdf' }),
      { files: ['/w/in.txt'], dirs: ['/w'] },
    ],
    note: 'an unsupported input',
  },
  { args: [req({ input: '/w/in.docx', targetFormat: 'png', outPath: '/w/out.png' }), V_FILES] },
  { args: [req({ input: '/w/in.xlsx', targetFormat: 'html', outPath: '/w/out.html' }), V_FILES] },
  { args: [req({ input: '/w/in.md', targetFormat: 'pdf', outPath: '/w/out.pdf' }), V_FILES] },
  { args: [req({ input: '/w/in.html', targetFormat: 'docx', outPath: '/w/out.docx' }), V_FILES] },
  { args: [req({ input: '/w/in.hwp', targetFormat: 'pdf', outPath: '/w/out.pdf' }), V_FILES] },
  {
    args: [req({ input: '/w/in.docx', targetFormat: 'pdf', outPath: '/nope/out.pdf' }), V_FILES],
    note: 'no output directory',
  },
  {
    args: [req({ input: '/w/in.docx', targetFormat: 'pdf', outPath: '/w/dir.pdf' }), V_FILES],
    note: 'the output is a folder',
  },
  {
    args: [req({ input: '/w/in.docx', targetFormat: 'docx', outPath: '/w/in.docx' }), V_FILES],
    note: 'the input is the output (docx is not a docs target, so it is the target check)',
  },
  {
    args: [req({ input: '/w/in.html', targetFormat: 'docx', outPath: '/w/in.html' }), V_FILES],
    note: 'the output is the input',
  },
  {
    args: [req({ input: '/w/in.html', targetFormat: 'docx', outPath: '/w/./in.html' }), V_FILES],
    note: 'the same file by another spelling',
  },
  {
    args: [
      req({ input: '/w/in.html', targetFormat: 'docx', outPath: '/w/link.docx' }),
      {
        ...V_FILES,
        files: [...(V_FILES.files ?? []), '/w/link.docx'],
        real: { '/w/link.docx': '/w/in.html' },
      },
    ],
    note: 'a link to the input',
  },
  {
    args: [
      req({ input: '/w/in.html', targetFormat: 'docx', outPath: '/w/new.docx' }),
      { ...V_FILES, dirs: ['/w'], real: { '/w': '/elsewhere' } },
    ],
    note: 'the output does not exist yet: only its directory is canonical',
  },
  {
    args: [
      req({ input: '/w/in.html', targetFormat: 'docx', outPath: '/z/in.html' }),
      { ...V_FILES, dirs: ['/w', '/z'], real: { '/z': '/w' } },
    ],
    note: 'a new output whose directory is the input directory by a link',
  },
  { args: [req({ input: '/w/../w/in.DOCX', targetFormat: 'pdf', outPath: '/w/o.pdf' }), V_FILES] },
  {
    args: [
      req({ input: '/w/in.docx', targetFormat: 'pdf', outPath: '/w/out.pdf', page: 1 }),
      V_FILES,
    ],
    note: '--page on a document',
  },
  {
    args: [
      req({ input: '/w/in.docx', targetFormat: 'pdf', outPath: '/w/out.pdf', ops: 'o.json' }),
      V_FILES,
    ],
    note: '--ops on a document',
  },
  {
    args: [
      req({
        input: '/w/in.docx',
        targetFormat: 'pdf',
        outPath: '/w/out.pdf',
        batch: 'best-effort',
      }),
      V_FILES,
    ],
    note: '--batch on a document',
  },
  {
    args: [
      req({ input: '/w/in.docx', targetFormat: 'pdf', outPath: '/w/out.pdf', ops: 'o', page: 2 }),
      V_FILES,
    ],
    note: 'the first given switch is named',
  },
  {
    args: [
      req({ input: '/w/in.drawio', targetFormat: 'png', outPath: '/w/out.png', page: 2 }),
      V_FILES,
    ],
    note: '--page on a diagram picture',
  },
  {
    args: [
      req({ input: '/w/in.drawio', targetFormat: 'png', outPath: '/w/out.png', ops: 'o.json' }),
      V_FILES,
    ],
    note: '--ops where a picture is written',
  },
  {
    args: [
      req({
        input: '/w/in.drawio',
        targetFormat: 'pdf',
        outPath: '/w/out.pdf',
        batch: 'stop-on-error',
      }),
      V_FILES,
    ],
    note: '--batch where a document is written',
  },
  {
    args: [
      req({
        input: '/w/in.drawio',
        targetFormat: 'svg',
        outPath: '/w/out.svg',
        page: 1,
        ops: 'o',
        batch: 'best-effort',
      }),
      V_FILES,
    ],
    note: 'ops is the first wrong switch after page',
  },
  {
    args: [
      req({
        input: '/w/in.drawio',
        targetFormat: 'drawio',
        outPath: '/w/out.drawio',
        ops: 'o.json',
      }),
      V_FILES,
    ],
    note: 'ops for a diagram file with the right extension',
  },
  {
    args: [
      req({
        input: '/w/in.drawio',
        targetFormat: 'drawio',
        outPath: '/w/OUT.DRAWIO',
        ops: 'o.json',
      }),
      V_FILES,
    ],
    note: 'the extension is read case-blind',
  },
  {
    args: [
      req({ input: '/w/in.drawio', targetFormat: 'dio', outPath: '/w/out.drawio', ops: 'o.json' }),
      V_FILES,
    ],
    note: 'dio needs a .dio file',
  },
  {
    args: [
      req({
        input: '/w/in.drawio',
        targetFormat: 'drawio.svg',
        outPath: '/w/out.drawio.svg',
        batch: 'best-effort',
        page: 1,
      }),
      V_FILES,
    ],
    note: 'batch and page for drawio.svg with the right extension',
  },
  {
    args: [
      req({ input: '/w/in.drawio', targetFormat: 'drawio.png', outPath: '/w/out.png', page: 1 }),
      V_FILES,
    ],
    note: 'drawio.png written to a .png',
  },
]

const runExport: FnSpec = {
  ts: async (a, cx) => {
    const mod = await headless()
    const world = a[1] as RunWorld
    const { fs, write } = fakeFs(world, cx.log)
    const hidden = { log: cx.log }
    g.__b3b4Hidden = hidden
    const exporter = world.exporter ?? {}
    const exporters: J = {}
    for (const name of MODULES) {
      exporters[name] = async (input: string, outPath: string, format: string, r: J) => {
        cx.log('export', name, input, outPath, format, r)
        write(exporter)
        if (exporter.throws === 'error') throw new Error('export failed')
        if (exporter.throws === 'string') throw 'export failed as text'
        return exporter.product
      }
    }
    const placeholders =
      world.placeholders === undefined || world.placeholders === null
        ? undefined
        : async (input: string, outPath: string, format: string) => {
            cx.log('placeholders', input, outPath, format)
            write(world.placeholders as ExporterWorld)
            if ((world.placeholders as ExporterWorld).throws === 'error')
              throw new Error('placeholder failed')
          }
    return withNow(world.now ?? 1_000_000, () =>
      mod.runHeadlessExport(request(a[0] as J), exporters, fs, placeholders),
    )
  },
  cases: [],
}

const R_BASE: RunWorld = {
  files: ['/w/in.docx', '/w/in.xlsx', '/w/in.md', '/w/in.html', '/w/in.drawio'],
  dirs: ['/w'],
  texts: {
    '/w/in.docx': 'clean',
    '/w/in.xlsx': 'clean',
    '/w/in.md': 'clean',
    '/w/in.html': 'clean',
  },
  exporter: { writes: [{ path: '/w/out.pdf' }] },
}
const pdfReq = req({ input: '/w/in.docx', targetFormat: 'pdf', outPath: '/w/out.pdf' })
const run = (r: J, w: RunWorld, note?: string): Case => ({
  args: [r, w],
  ...(note ? { note } : {}),
})

runExport.cases = [
  run(pdfReq, R_BASE),
  run(pdfReq, {}, 'the input is missing: the outcome, not a throw'),
  run(pdfReq, { ...R_BASE, exporter: {} }, 'success reported but nothing written'),
  run(
    pdfReq,
    { ...R_BASE, exporter: { writes: [{ path: '/w/out.pdf', mtime: 500_000 }] } },
    'a stale file: older than the start by more than the slack',
  ),
  run(
    pdfReq,
    { ...R_BASE, exporter: { writes: [{ path: '/w/out.pdf', mtime: 998_000 }] } },
    'exactly at the slack: not stale',
  ),
  run(
    pdfReq,
    { ...R_BASE, exporter: { writes: [{ path: '/w/out.pdf', mtime: 997_999 }] } },
    'one millisecond past the slack: stale',
  ),
  run(
    pdfReq,
    { ...R_BASE, noMtime: true, exporter: { writes: [{ path: '/w/out.pdf', mtime: 1 }] } },
    'no mtime probe: the stale check is skipped',
  ),
  run(pdfReq, { ...R_BASE, exporter: { throws: 'error' } }, 'the exporter throws an Error'),
  run(pdfReq, { ...R_BASE, exporter: { throws: 'string' } }, 'the exporter throws a string'),
  run(
    pdfReq,
    {
      ...R_BASE,
      exporter: {
        writes: [{ path: '/w/p1.pdf' }, { path: '/w/p2.pdf' }],
        product: { paths: ['/w/p1.pdf', '/w/./p2.pdf'], detail: { pages: 2 } },
      },
    },
    'an exporter that reports its files and detail',
  ),
  run(
    pdfReq,
    {
      ...R_BASE,
      exporter: {
        writes: [{ path: '/w/p1.pdf' }],
        product: { paths: ['/w/p1.pdf'] },
      },
    },
    'reported files without detail',
  ),
  run(
    pdfReq,
    {
      ...R_BASE,
      exporter: {
        writes: [{ path: '/w/p1.pdf' }],
        product: { paths: ['/w/p1.pdf', '/w/gone.pdf'] },
      },
    },
    'one of the reported files was not written',
  ),
  run(
    pdfReq,
    {
      ...R_BASE,
      mtimes: { '/w/p2.pdf': 1 },
      exporter: {
        writes: [{ path: '/w/p1.pdf' }, { path: '/w/p2.pdf' }],
        product: { paths: ['/w/p1.pdf', '/w/p2.pdf'] },
      },
    },
    'the second reported file is stale',
  ),
  run(
    pdfReq,
    {
      ...R_BASE,
      dirs: ['/w', '/w/d'],
      exporter: { writes: [], product: { paths: ['/w/d'] } },
    },
    'a reported path that is a folder',
  ),
  run(
    req({ input: '/w/in.drawio', targetFormat: 'png', outPath: '/w/out.png', page: 2 }),
    { ...R_BASE, exporter: { writes: [{ path: '/w/out.png' }] } },
    'the request reaches the exporter',
  ),
  run(
    req({ input: '/w/in.xlsx', targetFormat: 'pdf', outPath: '/w/out.pdf' }),
    { ...R_BASE, exporter: { writes: [{ path: '/w/out.pdf' }] }, texts: { '/w/in.xlsx': 'plain' } },
    'a clean workbook is read and exported',
  ),
  run(
    req({ input: '/w/in.xlsx', targetFormat: 'pdf', outPath: '/w/out.pdf' }),
    { ...R_BASE, texts: { '/w/in.xlsx': 'a HIDDEN cell' } },
    'hidden content: refused before any window',
  ),
  run(
    req({ input: '/w/in.md', targetFormat: 'pdf', outPath: '/w/out.pdf' }),
    { ...R_BASE, texts: { '/w/in.md': 'HIDDEN span' } },
    'hidden content in markdown',
  ),
  run(
    req({ input: '/w/in.html', targetFormat: 'docx', outPath: '/w/out.docx' }),
    { ...R_BASE, texts: { '/w/in.html': 'HIDDEN' }, placeholders: {} },
    'hidden content in html: not a docs input, refused',
  ),
  run(
    req({ input: '/w/in.docx', targetFormat: 'html', outPath: '/w/out.html' }),
    {
      ...R_BASE,
      texts: { '/w/in.docx': 'HIDDEN' },
      placeholders: { writes: [{ path: '/w/out.html' }] },
    },
    'a Word document to html: written as placeholders',
  ),
  run(
    req({ input: '/w/in.docx', targetFormat: 'md', outPath: '/w/out.md' }),
    {
      ...R_BASE,
      texts: { '/w/in.docx': 'HIDDEN' },
      placeholders: { writes: [{ path: '/w/out.md' }] },
    },
    'a Word document to md',
  ),
  run(
    req({ input: '/w/in.docx', targetFormat: 'md', outPath: '/w/out.md' }),
    { ...R_BASE, texts: { '/w/in.docx': 'HIDDEN' } },
    'placeholders wanted and none given',
  ),
  run(
    req({ input: '/w/in.docx', targetFormat: 'md', outPath: '/w/out.md' }),
    { ...R_BASE, texts: { '/w/in.docx': 'HIDDEN' }, placeholders: { throws: 'error' } },
    'the placeholder export throws',
  ),
  run(
    req({ input: '/w/in.docx', targetFormat: 'md', outPath: '/w/out.md' }),
    { ...R_BASE, texts: { '/w/in.docx': 'HIDDEN' }, placeholders: {} },
    'the placeholder export writes nothing',
  ),
  run(
    req({ input: '/w/in.docx', targetFormat: 'md', outPath: '/w/out.md' }),
    {
      ...R_BASE,
      texts: { '/w/in.docx': 'clean' },
      placeholders: { writes: [{ path: '/w/out.md' }] },
      exporter: { writes: [{ path: '/w/out.md' }] },
    },
    'a clean Word document goes to the exporter even when placeholders exist',
  ),
  run(
    pdfReq,
    { ...R_BASE, noRead: true, texts: { '/w/in.docx': 'HIDDEN' } },
    'no read probe: the hidden check is skipped',
  ),
  run(pdfReq, { ...R_BASE, texts: { '/w/in.docx': 'a THROW' } }, 'the hidden check throws'),
  run(pdfReq, { ...R_BASE, texts: {} }, 'the file cannot be read'),
  run(
    req({ input: '/w/in.drawio', targetFormat: 'pdf', outPath: '/w/out.pdf' }),
    { ...R_BASE, texts: {} },
    'a diagram is not a hidden-content format: not read',
  ),
  run(
    req({ input: '/w/in.docx', targetFormat: 'png', outPath: '/w/out.png' }),
    R_BASE,
    'a bad target is the validation failure',
  ),
  run(
    req({ input: '/w/IN.DOCX', targetFormat: 'pdf', outPath: '/w/out.pdf' }),
    {
      ...R_BASE,
      files: [...(R_BASE.files ?? []), '/w/IN.DOCX'],
      texts: { '/w/IN.DOCX': 'HIDDEN' },
    },
    'an upper-case extension is read case-blind',
  ),
]

// ---------------------------------------------------------------------------
// slides/print-window
// ---------------------------------------------------------------------------

interface Script {
  loadFile?: 'throws'
  exec?: 'rejected' | 'throws' | 'pending'
  print?: 'throws' | { success?: boolean; reason?: string }
  showThrows?: boolean
  focusThrows?: boolean
  destroyed?: boolean
  isDestroyedThrows?: boolean
  destroyThrows?: boolean
}

/** logs `loadFile` with the folder's random part cut off, and the file's text */
function logLoad(path: string, log: TsContext['log']): void {
  const at = path.lastIndexOf('/')
  const dir = path.slice(0, at)
  const dirBase = dir.slice(dir.lastIndexOf('/') + 1)
  log('loadFile', dirBase.slice(0, -6), path.slice(at + 1), readFileSync(path, 'utf8'))
}

function dialogWindow(script: Script, log: TsContext['log']): J {
  let destroyed = script.destroyed === true
  const report = typeof script.print === 'object' ? script.print : {}
  return {
    async loadFile(path: string) {
      logLoad(path, log)
      if (script.loadFile === 'throws') throw new Error('load failed')
    },
    webContents: {
      executeJavaScript(js: string, gesture?: boolean) {
        log('executeJavaScript', js, gesture)
        if (script.exec === 'throws') throw new Error('probe threw')
        if (script.exec === 'rejected') return Promise.reject(new Error('probe rejected'))
        if (script.exec === 'pending') return new Promise<unknown>(() => undefined)
        return Promise.resolve(undefined)
      },
      print(options: unknown, callback: (ok: boolean, reason: string) => void) {
        log('print', options)
        if (script.print === 'throws') throw new Error('print threw')
        callback(report.success === true, report.reason ?? '')
      },
    },
    show() {
      log('show')
      if (script.showThrows) throw new Error('show threw')
    },
    focus() {
      log('focus')
      if (script.focusThrows) throw new Error('focus threw')
    },
    isDestroyed() {
      log('isDestroyed')
      if (script.isDestroyedThrows) throw new Error('isDestroyed threw')
      return destroyed
    },
    destroy() {
      log('destroy')
      destroyed = true
      if (script.destroyThrows) throw new Error('destroy threw')
    },
  }
}

const maskRand = (text: string): string =>
  text.replace(/\/(seuoffice-slides-print-)[A-Za-z0-9]{6}/g, '/$1<rand>')

/**
 * `console.error` of the readiness probe goes to the log, and the probe's 5 s
 * timer fires on the next turn instead of after 5 s.
 */
async function withProbe<T>(cx: TsContext, run: () => Promise<T>): Promise<T> {
  const realError = console.error
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  console.error = (message: unknown, error: unknown) =>
    cx.log('console.error', message, error instanceof Error ? error.message : String(error))
  globalThis.setTimeout = ((fn: () => void) => {
    const timer = { cleared: false }
    setImmediate(() => {
      if (!timer.cleared) fn()
    })
    return timer
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((timer?: { cleared: boolean }) => {
    if (timer) timer.cleared = true
  }) as unknown as typeof clearTimeout
  try {
    return await run()
  } finally {
    console.error = realError
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
}

const slidesPrint = await import('../../../../apps/slides/src/main/print-window.ts')

const printSlides: FnSpec = {
  ts: (a, cx) =>
    withProbe(cx, async () => {
      try {
        const result = await slidesPrint.printSlidesHtml(
          a[0] as string,
          dialogWindow(a[1] as Script, cx.log),
          orUndefined(a[2] as NodeJS.Platform | null),
        )
        return JSON.parse(maskRand(JSON.stringify(result)))
      } catch (error) {
        if (error instanceof Error) error.message = maskRand(error.message)
        throw error
      }
    }),
  cases: [
    ['<p>x</p>', { print: { success: true } }, 'linux'],
    ['<p>x</p>', { print: { success: true } }, 'darwin'],
    ['<p>x</p>', { print: { success: true } }, 'win32'],
    ['<p>x</p>', { print: { success: true } }, null],
    ['<p>caf\u00e9 \u{1F600}</p>', { print: { success: true } }, 'linux'],
    ['<p>x</p>', { print: { success: false, reason: 'Print job canceled' } }, 'linux'],
    ['<p>x</p>', { print: { success: false, reason: 'print job canceled' } }, 'linux'],
    ['<p>x</p>', { print: { success: false, reason: 'Driver failure' } }, 'linux'],
    ['<p>x</p>', { print: { success: false, reason: '' } }, 'linux'],
    ['<p>x</p>', {}, 'linux'],
    ['<p>x</p>', { loadFile: 'throws' }, 'linux'],
    ['<p>x</p>', { exec: 'rejected', print: { success: true } }, 'linux'],
    ['<p>x</p>', { exec: 'pending', print: { success: true } }, 'linux'],
    ['<p>x</p>', { exec: 'throws', print: { success: true } }, 'linux'],
    ['<p>x</p>', { print: 'throws' }, 'linux'],
    ['<p>x</p>', { showThrows: true, print: { success: true } }, 'win32'],
    ['<p>x</p>', { focusThrows: true, print: { success: true } }, 'win32'],
    ['<p>x</p>', { destroyed: true, print: { success: true } }, 'linux'],
    ['<p>x</p>', { destroyThrows: true, print: { success: true } }, 'linux'],
    ['<p>x</p>', { isDestroyedThrows: true, print: { success: true } }, 'linux'],
  ].map((args): Case => ({ args })),
}

// ---------------------------------------------------------------------------
// session-txn
// ---------------------------------------------------------------------------

const TXN_STUB = `
const w = () => globalThis.__b3b4Txn
export const materializeSlide = (opened, index) => { w().log('materializeSlide', index) }
export const slideDurableId = (slide) => slide.durableId
export const runTxn = (opened, req) => {
  w().log('runTxn', req)
  return w().plans.shift() ?? { applied: true }
}
export const applyAutofitResize = (session, index, id, rendered) => {
  w().log('applyAutofitResize', index, id, rendered)
  return { resized: rendered }
}
export const syncAutofitScale = (session, index, id, rendered) => {
  w().log('syncAutofitScale', index, id, rendered)
  return { synced: rendered }
}
export const buildAllRenderSlides = (opened, fit) => {
  w().log('buildAllRenderSlides', fit)
  return [{ all: fit }]
}
export const markMetaDirty = () => { w().log('markMetaDirty') }
export const rebuildSlide = (session, index) => {
  w().log('rebuildSlide', index)
  return { slide: index, rev: ++w().rev }
}
export const rebuildSlideWithReparse = (session, index) => { w().log('rebuildSlideWithReparse', index) }
`

let txnModule: Promise<J> | undefined
function txn(): Promise<J> {
  txnModule ??= (async () => {
    const stub = scratchFile('txn-stub.mjs', TXN_STUB)
    return loadPatched('apps/slides/src/main/session-txn.ts', (src) => {
      let out = src
      for (const spec of [
        '@seuoffice/pptx-engine',
        '@seuoffice/pptx-ops',
        './autofit-writeback',
        './session-state',
      ]) {
        out = must(out, `from '${spec}'`, `from '${stub}'`, 'session-txn.ts')
      }
      return out
    })
  })()
  return txnModule
}

interface TxnWorld {
  /** the request, as the renderer sent it */
  req: unknown
  /** the durable ids of the deck's slides, in order */
  slides?: string[]
  /** what each call of `runTxn` answers, in order (a call past the list applies) */
  plans?: J[]
  /** what `history.run` answers */
  run?: J
}

const txnScenario: FnSpec = {
  ts: async (a, cx) => {
    const mod = await txn()
    const world = a[0] as TxnWorld
    g.__b3b4Txn = { log: cx.log, plans: clone(world.plans ?? []), rev: 0 }
    const session = {
      opened: { deck: { slides: (world.slides ?? []).map((durableId) => ({ durableId })) } },
      fitWidthPx: 960,
    }
    const history = {
      push: () => cx.log('history.push'),
      drop: () => cx.log('history.drop'),
      run: (_session: unknown, req: unknown) => {
        cx.log('history.run', req)
        return clone(world.run ?? { applied: true })
      },
    }
    return mod.applyTxnToSession(session, world.req, history)
  },
  cases: [],
}

const op = (o: J): J => o
const setText = (el: string, slide = 1): J =>
  op({ op: 'setText', target: { slide, el }, text: 'x' })
const recOf = (o: J, slideId?: string, extra: J = {}): J => ({
  op: o,
  ...(slideId !== undefined ? { slideId } : {}),
  ...extra,
})
const DECK3 = ['s1', 's2', 's3']
const okRun = (records: J[], extra: J = {}): J => ({ applied: true, records, ...extra })
const txnCase = (world: TxnWorld, note: string): Case => ({
  args: [{ slides: DECK3, ...world }],
  note,
})
const ops = (n: number): J[] => Array.from({ length: n }, (_, i) => op({ op: 'setNotes', i }))

txnScenario.cases = [
  txnCase({ req: { ops: [] } }, '0 ops'),
  txnCase({ req: { ops: ops(51) } }, '51 ops'),
  txnCase({ req: { ops: ops(50) } }, '50 ops go on'),
  txnCase({ req: null }, 'no request at all'),
  txnCase({ req: { ops: 'setNotes' } }, 'ops that are not a list'),
  txnCase({ req: { ops: { length: 3 } } }, 'ops that look like a list'),
  txnCase({ req: { dryRun: true } }, 'no ops, dry run'),
  txnCase(
    { req: { ops: ops(2), dryRun: true }, plans: [{ applied: true, plan: ['a', 'b'] }] },
    'a dry run without failures',
  ),
  txnCase(
    {
      req: { ops: ops(2), dryRun: true },
      plans: [{ applied: false, plan: ['a'], failures: [{ index: 1, error: 'bad', extra: 'x' }] }],
    },
    'a dry run with failures: only index and error are given',
  ),
  txnCase(
    { req: { ops: ops(1), dryRun: true }, plans: [{ applied: true }] },
    'a dry run with no plan answers an empty plan',
  ),
  txnCase(
    { req: { ops: ops(1), dryRun: true }, plans: [{ plan: [], failures: [] }] },
    'an empty failures list is left out of a dry run',
  ),
  txnCase(
    { req: { ops: ops(1), dryRun: 1, isolation: 'per_op' }, plans: [{ plan: ['p'] }] },
    'a dry run flag that is only truthy, with per_op',
  ),
  txnCase(
    { req: { ops: ops(1), dryRun: 0 }, plans: [{ plan: ['p'] }], run: okRun([]) },
    'a falsy dry run flag is a real run',
  ),
  txnCase(
    {
      req: { ops: ops(2) },
      plans: [{ failures: [{ index: 0, error: 'e0' }] }],
    },
    'atomic: one invalid op refuses the run before history is pushed',
  ),
  txnCase(
    {
      req: { ops: ops(2), isolation: 'per_op' },
      plans: [{ failures: [{ index: 0, error: 'e0' }] }],
      run: okRun([]),
    },
    'per_op: one of two invalid still runs',
  ),
  txnCase(
    {
      req: { ops: ops(2), isolation: 'per_op' },
      plans: [
        {
          failures: [
            { index: 0, error: 'e0' },
            { index: 1, error: 'e1' },
          ],
        },
      ],
    },
    'per_op: all invalid refuses the run',
  ),
  txnCase(
    {
      req: { ops: ops(2), isolation: 'anything else' },
      plans: [{ failures: [{ index: 1, error: 'e' }] }],
    },
    'an unknown isolation is atomic',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      plans: [{}],
      run: { applied: false, failures: [{ index: 0, error: 'rolled back' }] },
    },
    'the run fails: history is dropped',
  ),
  txnCase(
    { req: { ops: ops(1) }, plans: [{}], run: { applied: false } },
    'the run fails with no failures',
  ),
  txnCase(
    {
      req: { ops: ops(1), isolation: 'per_op' },
      plans: [{}],
      run: { applied: false, failures: [] },
    },
    'the run fails with an empty failures list: it is given as it is',
  ),
  txnCase({ req: { ops: ops(1) }, run: okRun([]) }, 'applied with no records'),
  txnCase({ req: { ops: ops(1) }, run: { applied: true } }, 'applied with records left out'),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([recOf(op({ op: 'setNotes', target: { slide: 2 } }), 's2')], {
        failures: [{ index: 3, error: 'later', extra: 1 }],
      }),
    },
    'applied with failures reported: a target with a slide only',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([recOf(setText('e1'), 's2', { created: ['n1', 'n2'] })], { failures: [] }),
    },
    'a text op on a slide that is found: rebuilt, resized, synced',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([recOf(setText('e1'), 'gone')]),
    },
    'a record whose slide is gone is skipped',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([recOf(setText('e1'))]),
    },
    'a record with no slide id is skipped',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([recOf(setText('e1'), '')]),
    },
    'a record with an empty slide id is skipped',
  ),
  txnCase(
    {
      req: { ops: ops(2) },
      run: okRun([
        recOf(op({ op: 'setTableStyle', target: { slide: 1, el: 'tb' } }), 's1'),
        recOf(op({ op: 'setChart', target: { slide: 3 } }), 's3'),
      ]),
    },
    'table style and chart reparse the page',
  ),
  txnCase(
    {
      req: { ops: ops(3) },
      run: okRun([
        recOf(setText('e1'), 's1'),
        recOf(op({ op: 'setTableStyle', target: { slide: 1, el: 'tb' } }), 's1'),
        recOf(setText('e2'), 's1'),
      ]),
    },
    'a reparse drops the render kept for the slide',
  ),
  txnCase(
    {
      req: { ops: ops(2) },
      run: okRun([recOf(setText('e1'), 's1'), recOf(setText('e2'), 's1')]),
    },
    'two text ops on one slide rebuild it once',
  ),
  txnCase(
    {
      req: { ops: ops(2) },
      run: okRun([recOf(setText('e1'), 's1'), recOf(setText('e2'), 's2')]),
    },
    'two text ops on two slides rebuild each',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([recOf(op({ op: 'setText', target: { slide: 1 }, text: 'x' }), 's1')]),
    },
    'a text op with no element is skipped',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([recOf(op({ op: 'setText', target: { slide: 1, el: 'e1' }, group: 'g' }), 's1')]),
    },
    'a text op in a group is skipped',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([recOf(op({ op: 'setText', target: { slide: 1, el: 'e1' }, group: '' }), 's1')]),
    },
    'an empty group does not skip',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([recOf(op({ op: 'setShape', target: { slide: 1, el: 'e1' } }), 's1')]),
    },
    'another op is left alone',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([recOf(setText('e1'), 's1', { after: { levelDirty: true } })]),
    },
    'a text op that changed the level is skipped',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([recOf(setText('e1'), 's1', { after: { levelDirty: false } })]),
    },
    'a text op whose level is clean goes on',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([
        recOf(op({ op: 'setFont', target: { slide: 1, el: 'e1' }, font: 'x' }), 's1', {
          after: { levelDirty: true },
        }),
      ]),
    },
    'levelDirty is read for text ops only',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([
        recOf(
          op({
            op: 'setParagraphFormat',
            target: { slide: 1, el: 'e1' },
            format: { indentDelta: 1 },
          }),
          's2',
        ),
      ]),
    },
    'an indent change materializes the slide',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([
        recOf(
          op({
            op: 'setParagraphFormat',
            target: { slide: 1, el: 'e1' },
            format: { indentDelta: 0 },
          }),
          's2',
        ),
      ]),
    },
    'a zero indent change does not',
  ),
  txnCase(
    {
      req: { ops: ops(3) },
      run: okRun([
        recOf(setText('e1'), 's1'),
        recOf(
          op({
            op: 'setParagraphFormat',
            target: { slide: 1, el: 'e1' },
            format: { indentDelta: -1 },
          }),
          's1',
        ),
        recOf(op({ op: 'setFont', target: { slide: 1, el: 'e1' } }), 's1'),
      ]),
    },
    'materializing drops the render kept for the slide',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([recOf(op({ op: 'setParagraphFormat', target: { slide: 1, el: 'e1' } }), 's3')]),
    },
    'a paragraph format with no format',
  ),
  txnCase(
    {
      req: { ops: ops(2) },
      run: okRun([
        recOf(op({ op: 'addSlide' }), 's1', { created: [] }),
        recOf(op({ op: 'setNotes', target: { slide: 'abc', el: 'x' } }), 's1', { created: ['a'] }),
      ]),
    },
    'records: an op with no target, a string slide, an empty created list',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([recOf(op({ target: { slide: 4 } }), 's1')]),
    },
    'an op with no name leaves the key out',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([recOf(op({ op: 'setNotes', target: { el: 'e' } }), 's1')]),
    },
    'a target with no slide prints undefined',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      run: okRun([recOf(op({ op: 'setNotes', target: { slide: 2.5, el: 0 } }), 's1')]),
    },
    'a fractional slide and an element of zero',
  ),
  txnCase(
    {
      req: { ops: ops(2), isolation: 'per_op' },
      plans: [{ failures: [{ index: 1, error: 'p' }] }],
      run: okRun([recOf(setText('e1'), 's1')], { failures: [{ index: 1, error: 'r' }] }),
    },
    'a partial per_op run reports its failures with the records',
  ),
  txnCase(
    {
      req: { ops: ops(1) },
      slides: ['', 's1'],
      run: okRun([recOf(setText('e1'), '')]),
    },
    'an empty slide id finds no slide even where a slide has an empty durable id',
  ),
]

// ---------------------------------------------------------------------------
// autofit-writeback
// ---------------------------------------------------------------------------

const AUTOFIT_STUB = `
const w = () => globalThis.__b3b4Autofit
export const patchBodyPrAutofit = (xml, scale, red) => {
  w().log('patchBodyPrAutofit', xml, scale, red)
  return 'PATCH(' + xml + '|' + scale + '|' + red + ')'
}
export const matchesElementRef = (el, ref) => el.id === ref || el.refId === ref
export const EMU_PER_PX_96 = 9525
export const layoutText = (options) => {
  // a copy: the module changes the body after the call, and the log must show it as it was asked
  w().log('layoutText', JSON.parse(JSON.stringify(options)))
  return w().refit
}
export const makeViewport = (size, fit) => ({ size, fit })
export const getFontMetrics = () => 'metrics'
export const rebuildSlide = (session, index) => {
  w().log('rebuildSlide', index)
  return w().rebuilt.length ? w().rebuilt.shift() : null
}
`

let autofitModule: Promise<J> | undefined
function autofit(): Promise<J> {
  autofitModule ??= (async () => {
    const stub = scratchFile('autofit-stub.mjs', AUTOFIT_STUB)
    return loadPatched('apps/slides/src/main/autofit-writeback.ts', (src) => {
      let out = src
      for (const spec of [
        '@seuoffice/pptx-engine/identity',
        '@seuoffice/pptx-engine',
        '@seuoffice/pptx-render',
        './session-state',
      ]) {
        out = must(out, `from '${spec}'`, `from '${stub}'`, 'autofit-writeback.ts')
      }
      return out
    })
  })()
  return autofitModule
}

interface AutofitWorld {
  /** the deck's slides: `{ elements: [...] }` as the model keeps them */
  slides: J[]
  size?: { cx: number }
  fitWidthPx?: number
  index?: number
  sourceId: string
  /** the render slide handed in; null is none */
  rendered: J
  /** what each call of `rebuildSlide` answers, in order; none left answers null */
  rebuilt?: J[]
  /** what `layoutText` answers */
  refit?: J
}

function autofitRun(name: 'applyAutofitResize' | 'syncAutofitScale'): FnSpec {
  return {
    ts: async (a, cx) => {
      const mod = await autofit()
      const world = clone(a[0] as AutofitWorld)
      g.__b3b4Autofit = { log: cx.log, rebuilt: world.rebuilt ?? [], refit: world.refit }
      const session = {
        opened: { deck: { slides: world.slides, size: world.size ?? { cx: 9525 * 960 } } },
        fitWidthPx: world.fitWidthPx ?? 960,
      }
      const result = mod[name](session, world.index ?? 0, world.sourceId, world.rendered)
      return { result, slides: world.slides }
    },
    cases: [],
  }
}

const node = (sourceId: string, o: J = {}): J => ({
  sourceId,
  type: 'text',
  box: { w: 200, h: 50 },
  text: {
    lines: [{ align: 'left', runs: [{ x: 10, widthPx: 100 }] }],
    insets: { l: 7, t: 4, r: 7, b: 4 },
    contentHeight: 40,
    wrap: true,
    fontScale: 1,
    ...o.text,
  },
  ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'text')),
})
const el = (id: string, text: J | null, o: J = {}): J => ({
  id,
  type: 'text',
  transform: { offset: { x: 1000, y: 2000, cx: 1905000, cy: 476250 }, rot: 0 },
  ...(text ? { text } : {}),
  anchor: { originalXml: '<a:bodyPr/>' },
  ...o,
})
const slideOf = (...elements: J[]): J => ({ elements })
const rs = (...nodes: J[]): J => ({ nodes })

const resizeBody = { autofit: 'resize', fontScale: 1 }
const shrinkBody = (extra: J = {}): J => ({ autofit: 'shrink', ...extra })
const aCase = (world: AutofitWorld, note: string): Case => ({ args: [world], note })

const resizeSpec = autofitRun('applyAutofitResize')
resizeSpec.cases = [
  aCase(
    { slides: [slideOf(el('e1', resizeBody))], sourceId: 'e1', rendered: null },
    'no render slide: nothing happens',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(node('e1', { text: { contentHeight: 90 } })),
      rebuilt: [rs(node('e1'))],
    },
    'the box grows with the content (height only, wrapped body)',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(node('e1', { text: { contentHeight: 38 } })),
    },
    'needed height within a pixel of the box: unchanged',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(node('e1', { text: { contentHeight: 38.9 } })),
    },
    'a hair under a pixel off: unchanged',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(node('e1', { text: { contentHeight: 39 } })),
      rebuilt: [rs(node('e1'))],
    },
    'exactly a pixel off: written',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(
        node('e1', {
          text: {
            wrap: false,
            contentHeight: 40,
            lines: [
              {
                align: 'left',
                runs: [
                  { x: 10, widthPx: 100 },
                  { x: 120, widthPx: 80 },
                ],
              },
            ],
          },
        }),
      ),
      rebuilt: [rs(node('e1'))],
    },
    'a nowrap body follows its widest line: left aligned',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(
        node('e1', {
          text: { wrap: false, lines: [{ align: 'right', runs: [{ x: 10, widthPx: 60 }] }] },
        }),
      ),
      rebuilt: [rs(node('e1'))],
    },
    'a nowrap body shrinks around its right edge',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(
        node('e1', {
          text: { wrap: false, lines: [{ align: 'center', runs: [{ x: 10, widthPx: 60 }] }] },
        }),
      ),
      rebuilt: [rs(node('e1'))],
    },
    'a nowrap body shrinks around its center',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(
        node('e1', {
          text: { wrap: false, lines: [{ align: 'justify', runs: [{ x: 10, widthPx: 60 }] }] },
        }),
      ),
      rebuilt: [rs(node('e1'))],
    },
    'another alignment does not shift',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(node('e1', { text: { wrap: false, lines: [] } })),
      rebuilt: [rs(node('e1'))],
    },
    'a nowrap body with no lines keeps the insets alone',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(
        node('e1', {
          text: {
            wrap: false,
            lines: [{ align: 'left', runs: [] }, { runs: [{ x: 50, widthPx: 0 }] }],
          },
        }),
      ),
      rebuilt: [rs(node('e1'))],
    },
    'runs that span nothing: the content width is zero',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(
        node('e1', {
          text: {
            wrap: false,
            vert: 'vert270',
            contentHeight: 40,
            lines: [{ runs: [{ x: 0, widthPx: 500 }] }],
          },
        }),
      ),
    },
    'a vertical body keeps its width (and its height matches): unchanged',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(
        node('e1', {
          text: { wrap: false, vert: '', lines: [{ runs: [{ x: 0, widthPx: 100 }] }] },
        }),
      ),
      rebuilt: [rs(node('e1'))],
    },
    'an empty vert counts as none',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      fitWidthPx: 480,
      rendered: rs(node('e1', { text: { contentHeight: 90 } })),
      rebuilt: [rs(node('e1'))],
    },
    'the scale halves the pixels: the size doubles in EMU',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(
        node('e1', { text: { contentHeight: -100, insets: { l: 0, t: 0, r: 0, b: 0 } } }),
      ),
      rebuilt: [rs(node('e1'))],
    },
    'a size that rounds to nothing is at least one EMU',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(node('e1', { text: { contentHeight: 90 } })),
    },
    'the rebuild answers nothing',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody()))],
      sourceId: 'e1',
      rendered: rs(node('e1', { text: { contentHeight: 90 } })),
    },
    'a shrink body is not resized',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', { fontScale: 1 }))],
      sourceId: 'e1',
      rendered: rs(node('e1', { text: { contentHeight: 90 } })),
    },
    'a body with no autofit is not resized',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', null))],
      sourceId: 'e1',
      rendered: rs(node('e1', { text: { contentHeight: 90 } })),
    },
    'an element with no text',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody, { type: 'picture' }))],
      sourceId: 'e1',
      rendered: rs(node('e1', { text: { contentHeight: 90 } })),
    },
    'a picture is not a text element',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody, { type: 'shape' }))],
      sourceId: 'e1',
      rendered: rs(node('e1', { type: 'shape', text: { contentHeight: 90 } })),
      rebuilt: [rs(node('e1'))],
    },
    'a shape counts',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'zz',
      rendered: rs(node('e1', { text: { contentHeight: 90 } })),
    },
    'no such element',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody, { refId: 'ref-1' }))],
      sourceId: 'ref-1',
      rendered: rs(node('e1', { text: { contentHeight: 90 } })),
      rebuilt: [rs(node('e1'))],
    },
    'an element found by its reference, its node by its id',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      index: 5,
      sourceId: 'e1',
      rendered: rs(node('e1', { text: { contentHeight: 90 } })),
    },
    'no such slide',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(node('other', { text: { contentHeight: 90 } })),
    },
    'the render slide has no node of the element',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs({ sourceId: 'e1', type: 'picture', box: { w: 200, h: 50 } }),
    },
    'the node is a picture',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs({ sourceId: 'e1', type: 'text', box: { w: 200, h: 50 } }),
    },
    'the node has no text layout',
  ),
  aCase(
    {
      slides: [slideOf(el('e0', null), el('e1', resizeBody, { dirtyTransform: false }))],
      sourceId: 'e1',
      rendered: rs(node('e1', { text: { contentHeight: 90 } })),
      rebuilt: [rs(node('e1'))],
    },
    'the second element of a slide',
  ),
  aCase(
    {
      slides: [
        slideOf(el('e1', resizeBody)),
        slideOf(el('e1', resizeBody, { transform: { offset: { x: 5, y: 6 } } })),
      ],
      index: 1,
      sourceId: 'e1',
      rendered: rs(node('e1', { text: { contentHeight: 90 } })),
      rebuilt: [rs(node('e1'))],
    },
    'an offset with no size yet: cx and cy are added after y',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(node('e1', { text: { contentHeight: 41 } })),
      rebuilt: [rs(node('e1'))],
    },
    'needed height exactly a pixel under the box (49 against 50): written',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(node('e1', { text: { contentHeight: 41.5 } })),
    },
    'half a pixel under: unchanged',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(
        node('e1', {
          text: {
            wrap: false,
            lines: [{ align: 'right', runs: [{ x: 10, widthPx: 60.0001 }] }],
          },
        }),
      ),
      rebuilt: [rs(node('e1'))],
    },
    'a right-aligned nowrap body whose shift is a fraction of an EMU: the offset is rounded',
  ),
]

const syncSpec = autofitRun('syncAutofitScale')
syncSpec.cases = [
  aCase(
    { slides: [slideOf(el('e1', shrinkBody()))], sourceId: 'e1', rendered: null },
    'no render slide',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody({ fontScale: 0.9 })))],
      sourceId: 'e1',
      rendered: rs(node('e1')),
      refit: { fontScale: 0.9 },
    },
    'the stored scale is the refit scale: unchanged',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody({ fontScale: 0.9 })))],
      sourceId: 'e1',
      rendered: rs(node('e1')),
      refit: { fontScale: 0.8 },
      rebuilt: [rs(node('e1', { text: { fontScale: 0.8 } }))],
    },
    'a new scale is written back and the page patched',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody({ fontScale: 0.9 })))],
      sourceId: 'e1',
      rendered: rs(node('e1')),
      refit: { fontScale: 0.896 },
    },
    'a change under the threshold is not written',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody({ fontScale: 0.9 })))],
      sourceId: 'e1',
      rendered: rs(node('e1')),
      refit: { fontScale: 0.895 },
      rebuilt: [rs(node('e1'))],
    },
    'a change of the threshold is written',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody()))],
      sourceId: 'e1',
      rendered: rs(node('e1')),
      refit: { fontScale: 1 },
    },
    'no stored scale reads as 1',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody()))],
      sourceId: 'e1',
      rendered: rs(node('e1')),
      refit: { fontScale: 0.7, lnSpcReduction: 0.1 },
      rebuilt: [rs(node('e1'))],
    },
    'the line spacing reduction is written too',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody({ fontScale: 0.7, lnSpcReduction: 0.1 })))],
      sourceId: 'e1',
      rendered: rs(node('e1')),
      refit: { fontScale: 0.7 },
      rebuilt: [rs(node('e1'))],
    },
    'a refit with no reduction deletes the stored one',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody({ fontScale: 0.7, lnSpcReduction: 0.1 })))],
      sourceId: 'e1',
      rendered: rs(node('e1')),
      refit: { fontScale: 0.7, lnSpcReduction: 0.1 },
    },
    'both the same: unchanged',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody({ fontScale: 0.7, lnSpcReduction: 0.1 })))],
      sourceId: 'e1',
      rendered: rs(node('e1')),
      refit: { fontScale: 0.7, lnSpcReduction: 0.2 },
      rebuilt: [rs(node('e1'))],
    },
    'only the reduction differs',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody({ fontScale: 0.7 })))],
      sourceId: 'e1',
      rendered: rs(node('e1')),
      refit: { fontScale: 0.5 },
    },
    'the rebuild answers nothing: the render handed in is kept',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', resizeBody))],
      sourceId: 'e1',
      rendered: rs(node('e1')),
      refit: { fontScale: 0.5 },
    },
    'a resize body is not synced',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', null))],
      sourceId: 'e1',
      rendered: rs(node('e1')),
      refit: { fontScale: 0.5 },
    },
    'an element with no text',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody(), { type: 'table' }))],
      sourceId: 'e1',
      rendered: rs(node('e1')),
      refit: { fontScale: 0.5 },
    },
    'a table is not a text element',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody({ fontScale: 0.7 }), { type: 'shape' }))],
      sourceId: 'e1',
      fitWidthPx: 640,
      rendered: rs(node('e1', { type: 'shape', box: { w: 120, h: 33 } })),
      refit: { fontScale: 0.6 },
      rebuilt: [rs(node('e1'))],
    },
    'a shape: the layout is asked for the node box',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody()))],
      sourceId: 'zz',
      rendered: rs(node('e1')),
      refit: { fontScale: 0.5 },
    },
    'no such element',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody()))],
      index: 2,
      sourceId: 'e1',
      rendered: rs(node('e1')),
      refit: { fontScale: 0.5 },
    },
    'no such slide',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody()))],
      sourceId: 'e1',
      rendered: rs(node('other')),
      refit: { fontScale: 0.5 },
    },
    'no node of the element',
  ),
  aCase(
    {
      slides: [slideOf(el('e1', shrinkBody()))],
      sourceId: 'e1',
      rendered: rs({ sourceId: 'e1', type: 'text', box: { w: 10, h: 10 } }),
      refit: { fontScale: 0.5 },
    },
    'the node has no text layout',
  ),
]

// ---------------------------------------------------------------------------
// seed-deck
// ---------------------------------------------------------------------------

const SEED_STUB = `
const w = () => globalThis.__b3b4Seed
export const openPptx = async (bytes) => {
  w().log('openPptx', Buffer.from(bytes).toString('hex'))
  if (w().openThrows) throw new Error('not a deck')
  return w().opened
}
export const shapedMetricsReady = async () => { w().log('shapedMetricsReady') }
export const buildAllRenderSlides = (opened, fit) => {
  w().log('buildAllRenderSlides', opened, fit)
  return w().slides
}
export const markMetaDirty = (session) => { w().log('markMetaDirty', session) }
export const scheduleHistoryNotify = (session) => { w().log('scheduleHistoryNotify', session) }
export const sessions = { set: (id, session) => { w().log('sessions.set', id, session) } }
`

interface SeedWorld {
  /** the id the deck is queued under; none queues nothing */
  queueId?: number
  /** the id the pending open is taken for */
  takeId: number
  deck?: string
  options?: J
  opened?: J
  slides?: J[]
  defaultFont?: string | null
  openThrows?: boolean
  /** the view is gone by the time the deferred message runs */
  destroyedBefore?: boolean
  /** the pending open is taken twice */
  again?: boolean
  fit?: number
  destroyedAtQueue?: boolean
}

const seedScenario: FnSpec = {
  ts: async (a, cx) => {
    const world = a[0] as SeedWorld
    const stub = scratchFile('seed-stub.mjs', SEED_STUB)
    const mod = await loadPatched('apps/slides/src/main/seed-deck.ts', (src) => {
      let out = src
      for (const spec of ['@seuoffice/pptx-engine', './session-state', './shaped-metrics']) {
        out = must(out, `from '${spec}'`, `from '${stub}'`, 'seed-deck.ts')
      }
      return out
    })
    g.__b3b4Seed = {
      log: cx.log,
      opened: world.opened ?? { deck: { size: { cx: 9144000, cy: 5143500 } } },
      slides: world.slides ?? [{ id: 'r1' }],
      openThrows: world.openThrows === true,
    }
    const contents = (id: number, destroyed = false) => {
      const wc = {
        id,
        destroyed,
        isDestroyed: () => wc.destroyed,
        once: (event: string) => cx.log('once', id, event),
        send: (channel: string, payload: unknown) => cx.log('send', id, channel, payload),
      }
      return wc
    }
    if (world.queueId !== undefined) {
      seedQueue.queueSlidesSeedFor(
        contents(world.queueId, world.destroyedAtQueue === true) as J,
        Uint8Array.from(Buffer.from(world.deck ?? '504b0304', 'hex')),
        world.options ?? {},
      )
    }
    const wc = contents(world.takeId)
    const defaultFontOf = (opened: unknown) => {
      cx.log('defaultFontOf', opened)
      return world.defaultFont === null ? undefined : (world.defaultFont ?? 'Calibri')
    }
    const results: unknown[] = []
    const take = async (): Promise<void> => {
      try {
        results.push(await mod.openSlidesSeed(wc, world.fit ?? 960, defaultFontOf))
      } catch (error) {
        results.push({ threw: (error as Error).message })
      }
    }
    await take()
    if (world.destroyedBefore) wc.destroyed = true
    if (world.again) await take()
    await flush()
    return results
  },
  cases: [],
}

let seedIds = 700
const sCase = (world: Partial<SeedWorld>, note: string): Case => {
  seedIds += 2
  const base: SeedWorld = { queueId: seedIds, takeId: seedIds }
  const full = { ...base, ...world }
  // an id the case did not choose follows the case's own
  if (world.takeId === undefined) full.takeId = full.queueId ?? seedIds
  return { args: [full], note }
}

seedScenario.cases = [
  sCase({}, 'a queued deck opens as a new unsaved session'),
  sCase({ queueId: undefined }, 'nothing queued: null, and nothing is called'),
  sCase({ takeId: 9001 }, 'a deck queued for another view is not taken'),
  sCase({ again: true }, 'the deck is taken once'),
  sCase(
    { options: { askPathOnFirstSave: true, suggestedName: 'Copy of Skill.pptx' } },
    'the first save asks where',
  ),
  sCase({ options: { askPathOnFirstSave: true } }, 'asks where with no suggested name'),
  sCase(
    { options: { askPathOnFirstSave: false, suggestedName: 'ignored.pptx' } },
    'a suggested name without the ask is not kept',
  ),
  sCase(
    { options: { recoveryId: { kind: 'slides', filePath: '/w/deck.pptx' } } },
    'a restored deck keeps its recovery slot',
  ),
  sCase(
    { options: { recoveryId: { kind: 'slides', untitledId: 'u1', ext: '.pptx' } } },
    'a restored untitled deck',
  ),
  sCase({ options: { password: 'secret' } }, 'an encrypted copy keeps its password'),
  sCase({ options: { password: '' } }, 'an empty password is kept'),
  sCase(
    {
      options: {
        askPathOnFirstSave: true,
        suggestedName: 'x.pptx',
        recoveryId: { kind: 'slides', filePath: '/w/d.pptx' },
        password: 'p',
      },
      fit: 640,
    },
    'every option at once, at another width',
  ),
  sCase({ defaultFont: null }, 'a deck with no default font'),
  sCase({ slides: [], opened: { deck: { size: { cx: 1, cy: 2 } } } }, 'a deck with no slides'),
  sCase({ openThrows: true }, 'a deck that cannot be opened rejects'),
  sCase({ destroyedBefore: true }, 'the view is gone before the deferred message'),
  sCase({ destroyedAtQueue: true }, 'a view destroyed at queueing never gets a deck'),
  sCase({ deck: '', options: {} }, 'an empty deck'),
  sCase(
    { options: { askPathOnFirstSave: false, suggestedName: 'kept-only-with-ask.pptx' } },
    'a suggested name beside an ask of false is not on the session',
  ),
]

// ---------------------------------------------------------------------------
// document-links-shell
// ---------------------------------------------------------------------------

const SHELL_STUB = `
export const openGenerateWindowForDocument = (request) => globalThis.__b3b4Shell.openGenerate(request)
`

interface DocSpec {
  wc: number
  filePath?: string
  title: string
}

interface ShellWorld {
  now: number
  menuKind: string | null
  /** the active document of each kind */
  active: Record<string, DocSpec | null>
  /** the document behind each webContents */
  docs: Record<string, DocSpec | null>
  /** the shell tab id of each webContents */
  tabs: Record<string, string>
  /** a webContents whose parent window is there */
  parents: Record<string, boolean>
  destroyed: number[]
}

type Step = [string, ...unknown[]]

const shellScenario: FnSpec = {
  ts: async (a, cx) => {
    const world = clone(a[0] as ShellWorld)
    const steps = a[1] as Step[]
    const userData = a[2] as string
    const linksFile = a[3] as unknown
    if (linksFile !== null)
      writeFileSync(`${userData}/document-links.json`, JSON.stringify(linksFile))
    const stub = scratchFile('shell-stub.mjs', SHELL_STUB)
    const mod = await loadPatched('apps/shell/src/main/document-links-shell.ts', (src) =>
      must(src, "from './generate/generate-window'", `from '${stub}'`, 'document-links-shell.ts'),
    )
    handoff.resetGenerateHandoffsForTest()
    const listeners = new Map<number, Array<() => void>>()
    const contentsById = new Map<number, J>()
    const contents = (id: number): J => {
      let wc = contentsById.get(id)
      if (!wc) {
        wc = {
          id,
          isDestroyed: () => world.destroyed.includes(id),
          once: (event: string, fn: () => void) => {
            cx.log('once', id, event)
            listeners.set(id, [...(listeners.get(id) ?? []), fn])
          },
        }
        contentsById.set(id, wc)
      }
      return wc
    }
    const doc = (spec: DocSpec | null | undefined): J =>
      spec
        ? {
            webContents: contents(spec.wc),
            ...(spec.filePath !== undefined ? { filePath: spec.filePath } : {}),
            title: spec.title,
          }
        : undefined
    g.__b3b4Shell = {
      openGenerate: (request: J) =>
        cx.log('openGenerateWindow', {
          webContentsId: request.webContentsId,
          ...(request.filePath !== undefined ? { filePath: request.filePath } : {}),
          title: request.title,
          parent: request.parent === null ? null : 'window',
        }),
    }
    const results: unknown[] = []
    const out = await withNow(world.now, async () => {
      for (const [name, ...args] of steps) {
        const before = results.length
        switch (name) {
          case 'configure':
            mod.configureDocumentLinks({
              userDataPath: () => {
                cx.log('userDataPath')
                return userData
              },
              activeDocument: (kind: string) => {
                cx.log('activeDocument', kind)
                return doc(world.active[kind])
              },
              documentFor: (wc: J) => {
                cx.log('documentFor', wc.id)
                return doc(world.docs[String(wc.id)])
              },
              parentFor: (wc: J) => {
                cx.log('parentFor', wc.id)
                return world.parents[String(wc.id)] ? { window: wc.id } : null
              },
              openPath: (path: string) => cx.log('openPath', path),
              labels: () => {
                cx.log('labels')
                return { make: 'Make', sources: 'View Sources', derived: 'Made from This' }
              },
              tabIdFor: (id: number) => {
                cx.log('tabIdFor', id)
                return world.tabs[String(id)]
              },
              menuKind: () => {
                cx.log('menuKind')
                return world.menuKind ?? undefined
              },
              applyMenu: (kind: string) => cx.log('applyMenu', kind),
            })
            break
          case 'set':
            Object.assign(world, args[0] as object)
            break
          case 'note':
            mod.noteDocumentSaved(
              contents(args[0] as number),
              args[1] as string,
              args[2] === undefined || args[2] === null ? undefined : { mayBeOpen: args[2] },
            )
            break
          case 'converted':
            handoff.recordGenerateConverted({
              webContentsId: args[0] as number,
              target: 'markdown',
              kind: 'mindmap-to-markdown',
              sources: args[1] as string[],
              conversionId: 'c',
            })
            break
          case 'destroy':
            world.destroyed.push(args[0] as number)
            for (const fn of listeners.get(args[0] as number) ?? []) fn()
            listeners.delete(args[0] as number)
            break
          case 'moved':
            mod.documentLinkFileMoved(args[0] as string, args[1] as string)
            break
          case 'paths':
            results.push(mod.documentLinkPaths())
            break
          case 'sync':
            mod.syncDocumentLinks()
            break
          case 'make':
            mod.makeFromDocument(contents(args[0] as number))
            break
          case 'refresh':
            mod.refreshDocumentLinkMenu()
            break
          case 'links':
            results.push(mod.documentLinks()?.links() ?? null)
            break
          case 'menu': {
            const items = mod.documentLinkFileMenuItems(args[0] as string)
            results.push(items)
            // `clicks`: 'make', or `[group, index]` of a submenu
            for (const click of (args[1] as Array<string | [string, number]>) ?? []) {
              if (click === 'make') {
                items.find((item: J) => item.id === 'document-links-make')?.click()
              } else {
                const group = items.find((item: J) => item.id === `document-links-${click[0]}`)
                group?.submenu?.[click[1]]?.click()
              }
            }
            break
          }
          default:
            throw new Error(`no such step: ${name}`)
        }
        await flush()
        if (results.length === before) results.push(null)
      }
      return results
    })
    return out
  },
  cases: [],
}

const DOCS = { wc: 1, filePath: '$DIR/made.pptx', title: 'made.pptx' }
const LINKS_FILE = {
  version: 1,
  links: [
    {
      derived: '$DIR/made.pptx',
      sources: ['$DIR/notes.md', '$DIR/gone.md'],
      createdAt: '2026-10-14T00:00:00.000Z',
      via: 'ai',
    },
    {
      derived: '$DIR/notes.md',
      sources: ['$DIR/base.docx'],
      createdAt: '2026-10-15T00:00:00.000Z',
      via: 'convert',
    },
  ],
}
const SHELL_FILES = { 'made.pptx': 'made', 'notes.md': 'notes', 'base.docx': 'base' }

const baseWorld = (o: Partial<ShellWorld> = {}): ShellWorld => ({
  now: 1_794_452_400_000,
  menuKind: 'slides',
  active: { slides: DOCS },
  docs: { '1': DOCS, '2': { wc: 2, title: 'Untitled' } },
  tabs: { '1': 'tab-1', '2': 'tab-2' },
  parents: { '1': true },
  destroyed: [],
  ...o,
})

const shellCase = (
  world: ShellWorld,
  steps: Step[],
  note: string,
  links: unknown = LINKS_FILE,
): Case => ({
  args: [world, steps, '$DIR', links],
  files: SHELL_FILES,
  note,
})

shellScenario.cases = [
  shellCase(baseWorld(), [['configure']], 'configured: the menu is built for the first time'),
  shellCase(
    baseWorld({ menuKind: null }),
    [['configure'], ['menu', 'slides']],
    'no menu kind: nothing is applied; the entries are still built',
  ),
  shellCase(
    baseWorld({ menuKind: 'home' }),
    [['configure'], ['refresh']],
    'a kind that is not an editor is never applied',
  ),
  shellCase(baseWorld({ menuKind: 'help' }), [['configure']], 'help is not an editor either'),
  shellCase(
    baseWorld(),
    [
      ['menu', 'slides'],
      ['make', 1],
      ['note', 1, '$DIR/x.pptx'],
      ['paths'],
      ['sync'],
      ['moved', 'a', 'b'],
    ],
    'before configure everything is a no-op',
  ),
  shellCase(
    baseWorld(),
    [['configure'], ['menu', 'slides']],
    'the entries of a document with sources and no derived',
  ),
  shellCase(
    baseWorld({
      active: { docs: { wc: 3, filePath: '$DIR/notes.md', title: 'notes.md' } },
      menuKind: 'docs',
    }),
    [['configure'], ['menu', 'docs']],
    'a document with a source and a derived one; a missing file is dimmed',
  ),
  shellCase(
    baseWorld({ active: { slides: { wc: 4, title: 'Untitled' } } }),
    [['configure'], ['menu', 'slides']],
    'an unsaved document: only the make entry',
  ),
  shellCase(
    baseWorld({ active: { slides: null } }),
    [['configure'], ['menu', 'slides']],
    'no active document: no entries',
  ),
  shellCase(
    baseWorld(),
    [['configure'], ['menu', 'slides', ['make']]],
    'the make entry opens the make window above the parent',
  ),
  shellCase(
    baseWorld({ parents: {} }),
    [['configure'], ['menu', 'slides', ['make']]],
    'the make window with no parent',
  ),
  shellCase(
    baseWorld({ docs: { '1': null } }),
    [['configure'], ['menu', 'slides', ['make']]],
    'the document behind the contents is gone: nothing opens',
  ),
  shellCase(
    baseWorld({ docs: { '1': { wc: 1, filePath: '', title: 'empty path' } } }),
    [['configure'], ['make', 1]],
    'an empty file path is not passed on',
  ),
  shellCase(
    baseWorld({ destroyed: [1] }),
    [['configure'], ['make', 1]],
    'a destroyed webContents makes nothing',
  ),
  shellCase(
    baseWorld(),
    [['configure'], ['menu', 'slides', [['sources', 0]]]],
    'a listed file that exists opens',
  ),
  shellCase(
    baseWorld(),
    [['configure'], ['menu', 'slides', [['sources', 1]]], ['menu', 'slides']],
    'a listed file deleted since the menu was built is not opened: the menu is built again',
  ),
  shellCase(
    baseWorld(),
    [['configure'], ['refresh'], ['refresh']],
    'refreshing again with the same document does nothing',
  ),
  shellCase(
    baseWorld(),
    [
      ['configure'],
      ['menu', 'slides'],
      ['refresh'],
      ['set', { active: { slides: { wc: 1, filePath: '$DIR/notes.md', title: 'n' } } }],
      ['refresh'],
    ],
    'another path rebuilds the menu',
  ),
  shellCase(
    baseWorld(),
    [
      ['configure'],
      ['menu', 'slides'],
      ['set', { active: { slides: { wc: 5, filePath: '$DIR/made.pptx', title: 'made.pptx' } } }],
      ['refresh'],
    ],
    'another webContents rebuilds the menu',
  ),
  shellCase(
    baseWorld(),
    [['configure'], ['menu', 'slides'], ['set', { active: { slides: null } }], ['refresh']],
    'the document is gone: the menu is rebuilt',
  ),
  shellCase(
    baseWorld(),
    [
      ['configure'],
      ['menu', 'slides'],
      [
        'set',
        { menuKind: 'docs', active: { docs: { wc: 1, filePath: '$DIR/made.pptx', title: 't' } } },
      ],
      ['refresh'],
    ],
    'another kind rebuilds the menu',
  ),
  shellCase(
    baseWorld({
      active: { slides: { wc: 6, title: 'Untitled' } },
      docs: { '6': { wc: 6, title: 'Untitled' } },
    }),
    [
      ['configure'],
      ['menu', 'slides'],
      ['note', 6, '$DIR/fresh.pptx'],
      ['links'],
      ['converted', 6, ['$DIR/notes.md']],
      ['links'],
      ['sync'],
      ['links'],
    ],
    'a first save, then a conversion that made it: a record is written and the menu is rebuilt',
  ),
  shellCase(
    baseWorld({ active: { slides: { wc: 6, title: 'Untitled' } } }),
    [['configure'], ['converted', 6, ['$DIR/notes.md']], ['note', 6, '$DIR/fresh.pptx'], ['links']],
    'the make event first, the save after',
  ),
  shellCase(
    baseWorld(),
    [['configure'], ['converted', 7, ['$DIR/notes.md']], ['links']],
    'an event of a tab that never saved: nothing is written',
  ),
  shellCase(
    baseWorld(),
    [
      ['configure'],
      ['note', 1, '$DIR/made.pptx', true],
      ['converted', 1, ['$DIR/notes.md']],
      ['links'],
    ],
    'a path that exists and is old: opened, not saved (mayBeOpen)',
  ),
  shellCase(
    baseWorld({ now: 4_000_000_000_000 }),
    [
      ['configure'],
      ['note', 1, '$DIR/made.pptx', true],
      ['converted', 1, ['$DIR/notes.md']],
      ['links'],
    ],
    'with the clock far on, an old file is not fresh',
  ),
  shellCase(
    baseWorld(),
    [
      ['configure'],
      ['note', 1, '$DIR/new.pptx', true],
      ['converted', 1, ['$DIR/notes.md']],
      ['links'],
    ],
    'a path not on disk yet is a save happening now',
  ),
  shellCase(
    baseWorld(),
    [
      ['configure'],
      ['note', 1, '$DIR/made.pptx', false],
      ['converted', 1, ['$DIR/notes.md']],
      ['links'],
    ],
    'mayBeOpen false counts as a save',
  ),
  shellCase(
    baseWorld({ destroyed: [1] }),
    [['configure'], ['note', 1, '$DIR/new.pptx'], ['converted', 1, ['$DIR/notes.md']], ['links']],
    'a destroyed webContents is not tracked',
  ),
  shellCase(
    baseWorld(),
    [
      ['configure'],
      ['note', 1, '$DIR/new.pptx'],
      ['destroy', 1],
      ['note', 1, '$DIR/other.pptx'],
      ['links'],
    ],
    'the destroyed listener forgets the tab',
  ),
  shellCase(
    baseWorld(),
    [
      ['configure'],
      ['paths'],
      ['moved', '$DIR/notes.md', '$DIR/moved.md'],
      ['paths'],
      ['links'],
      ['menu', 'slides'],
    ],
    'a file moved in the app: the records follow and the menu is rebuilt',
  ),
  shellCase(
    baseWorld(),
    [['configure'], ['moved', '$DIR/nothing.md', '$DIR/else.md'], ['paths']],
    'a move no record mentions changes nothing',
  ),
  shellCase(
    baseWorld(),
    [['configure'], ['menu', 'slides'], ['moved', '$DIR/made.pptx', '$DIR/renamed.pptx']],
    'the open document itself moved: the signature follows the records version',
  ),
]

export const part: Group = {
  'drop-open.partitionDropPayload': partition,
  'dropped-files.handleDroppedFiles': handleDropped,
  'shell/headless-export.validateHeadlessPaths': validatePaths,
  'shell/headless-export.runHeadlessExport': runExport,
  'slides/print-window.printSlidesHtml': printSlides,
  'session-txn.applyTxnToSession': txnScenario,
  'autofit-writeback.applyAutofitResize': resizeSpec,
  'autofit-writeback.syncAutofitScale': syncSpec,
  'seed-deck.openSlidesSeed': seedScenario,
  'document-links-shell.scenario': shellScenario,
}
