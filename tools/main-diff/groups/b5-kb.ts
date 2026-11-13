/**
 * Group `b5-kb`: apps/shell/src/main/knowledge-base.ts. The Rust side is
 * crates/main-core/src/calls/b5_kb.rs. `KB_READ_MAX_BYTES` and `kbReadMaxBytes`
 * are compared by group `b3-projects` (part `files`) and not listed here.
 *
 * `@seuoffice/file-parse` is not loadable here and is not held by main-core:
 * the module is loaded as a copy per case (its text cache starts afresh) with
 * `parseFileToText` a deterministic stand-in, by the extension of the path,
 * each call logging `['parse', path]`:
 *
 * - `.txt`, `.md`: `{ ok, kind: 'text', text }`, the file as UTF-8;
 * - `.png`: `{ ok, kind: 'image' }`; `.empty`: text without a `text`;
 *   `.kindless`: text without a `kind`;
 * - `.bad`: `{ ok: false, error: 'broken file' }`; `.mute`: `{ ok: false }`;
 *   `.badtext`: `{ ok: false, kind: 'text', text, error: 'bad but text' }`;
 * - `.boom`: throws `parser crashed`; any other: `{ ok: false, error: 'unsupported' }`.
 *
 * The open-files source (`@seuoffice/electron-utils/unsaved-files`) is the
 * real one, set per case: `open` is null (none), `'throws'`, or the list of
 * paths open with unsaved changes; each question logs `['openFiles']`.
 *
 * A `NaN` in a case's arguments is `null` for the Rust side, which reads a
 * missing number as `NaN`.
 *
 * Scenarios (names that are not an export of the file's functions as such):
 * - `readKnowledgeFileText`, `readKnowledgeFilePage`,
 *   `readKnowledgeOrProjectPage`: `[ops]` over one text cache; an op is
 *   `{ read, offset?, starred?, project? }`, `{ write, text, mtimeMs? }`,
 *   `{ grow, size }` (a file of that size, never read), `{ remove }` or
 *   `{ open }`; a read answers `{ ok }` or `{ error }`. `project` is
 *   `{ result }` or `{ throws }`, logging `['readProject', path, offset]`.
 * - `KbRunScopes`: `[cfg, ops]`, scopes named `scope-1`, ...; cfg `{ max?,
 *   defaultIds? }`; an op is `{ open: [owner, group, groups] }`, `{ openProject:
 *   [owner, projectId, starred?, groups?] }`, `{ toolsOpen: [owner, projectId] }`
 *   (what the project tools call), `{ close: [owner, scope] }`, `{ narrow:
 *   [owner, raw, paths, groups] }` (logs `['groups']` when it asks for them),
 *   `{ projectOf: [owner, raw] }`; with `defaultIds` the ids are the real ones
 *   and `{ openDefault }` answers their shape, `{ distinct }` whether all differ.
 * - `searchKnowledgeBase`, `searchSavedKnowledgeBase`,
 *   `searchSavedKnowledgeWithProject`: `[cfg, query, starred, limit]`, cfg
 *   `{ rows, fail?, open?, within?, indexed? }`: the index answers `rows` (a
 *   `within` narrows them), logging `['search', q, limit, 'plain' | 'within']`;
 *   `within` is `{ visible, failOn? }` (logging `['within', path]`) or null;
 *   `indexed` the paths `indexedAsOnDisk` keeps (logging `['indexed', paths]`).
 * - `createKnowledgeDocument`: `[cfg, req]`, see `CreateCfg`.
 */
import '../electron-fake.ts'
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { setOpenFilesSource } from '../../../packages/electron-utils/src/unsaved-files.ts'
import type { Case, FileSpec, FnSpec, Group, TsContext } from '../types.ts'
import { g, loadPatched, must, repoUrl } from './b5-agent-apps-lib.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any

const constant = (value: unknown): FnSpec => ({
  ts: () => value,
  single: 'a constant',
  cases: [
    { args: [] },
    { args: [], files: { 'x.txt': 'x' }, note: 'the folder after the call differs' },
  ],
})

// ---------------------------------------------------------------------------
// the module, the parser and the open files
// ---------------------------------------------------------------------------

type Log = (...args: unknown[]) => void

/** `parseFileToText` of the stand-in, by extension */
function fakeParse(log: Log) {
  return async (path: string): Promise<unknown> => {
    log('parse', path)
    switch (extname(path)) {
      case '.txt':
      case '.md':
        return { ok: true, kind: 'text', text: readFileSync(path, 'utf8') }
      case '.png':
        return { ok: true, kind: 'image' }
      case '.empty':
        return { ok: true, kind: 'text' }
      case '.kindless':
        return { ok: true, text: 'x' }
      case '.bad':
        return { ok: false, error: 'broken file' }
      case '.mute':
        return { ok: false }
      case '.badtext':
        return { ok: false, kind: 'text', text: 'zzz', error: 'bad but text' }
      case '.boom':
        throw new Error('parser crashed')
      default:
        return { ok: false, error: 'unsupported' }
    }
  }
}

/** a copy of knowledge-base.ts with its own text cache and the stand-in parser */
async function freshKb(log: Log): Promise<J> {
  g.__b5Kb = { parse: fakeParse(log) }
  return loadPatched('apps/shell/src/main/knowledge-base.ts', (src) =>
    must(
      src,
      "import { attachableMaxBytes, parseFileToText } from '@seuoffice/file-parse'",
      [
        `import { attachableMaxBytes } from '${repoUrl('packages/file-parse/src/attachable.ts')}'`,
        'const parseFileToText = (path: string): any => (globalThis as any).__b5Kb.parse(path)',
      ].join('\n'),
      'knowledge-base.ts',
    ),
  )
}

type OpenSpec = null | 'throws' | string[] | undefined

function setOpen(spec: OpenSpec, log: Log): void {
  if (spec === null || spec === undefined) return setOpenFilesSource(null)
  setOpenFilesSource(() => {
    log('openFiles')
    if (spec === 'throws') throw new Error('no list')
    return spec.map((filePath) => ({ filePath, dirty: true }))
  })
}

/** `{ ok }` or `{ error }` of one call */
async function settle(run: () => unknown): Promise<unknown> {
  try {
    return { ok: (await run()) ?? null }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

// ---------------------------------------------------------------------------
// listKnowledgeFiles
// ---------------------------------------------------------------------------

const D = '$DIR/'

const CORPUS: Record<string, FileSpec> = {
  'contracts/lease.docx': 'lease',
  'contracts/REPORT.PDF': 'pdf!',
  'contracts/sub/archive.tar.GZ': 'tar',
  'notes/noext': 'no extension',
  'notes/.gitignore': 'ignored',
  'notes/\u00c9t\u00e9.DOCX': 'accents',
  'notes/dir.txt': { dir: true },
  'solo.md': '# solo',
  'empty.txt': '',
}

const listCases: Case[] = [
  {
    args: [
      [
        'contracts/lease.docx',
        'contracts/REPORT.PDF',
        'contracts/sub/archive.tar.GZ',
        'notes/noext',
        'notes/.gitignore',
        'notes/\u00c9t\u00e9.DOCX',
        'solo.md',
        'empty.txt',
      ].map((name) => D + name),
    ],
    files: CORPUS,
    note: 'every kind of name: extension case, many dots, none, a leading dot',
  },
  {
    args: [[D + 'notes/dir.txt', D + 'missing.txt', D + 'solo.md', D + 'solo.md']],
    files: CORPUS,
    note: 'a folder and a missing file drop out; a path listed twice is listed twice',
  },
  { args: [[]], note: 'no starred files' },
  { args: [[D + 'gone.docx']], note: 'the only starred file is gone' },
]

// ---------------------------------------------------------------------------
// the search
// ---------------------------------------------------------------------------

interface Row {
  path: string
  name: string
  ext: string
  snippetText?: string | null
}

interface WithinCfg {
  visible: string[]
  failOn?: string
}

interface SearchCfg {
  rows?: Row[]
  fail?: string
  open?: OpenSpec
  within?: WithinCfg | null
  indexed?: string[]
}

const row = (path: string, snippetText?: string | null): Row => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return {
    path: D + path,
    name,
    ext: name.slice(name.lastIndexOf('.') + 1),
    ...(snippetText === undefined ? {} : { snippetText }),
  }
}

const ROWS: Row[] = [
  row('a/one.txt', 'first <b>hit</b>'),
  row('b/two.docx', 'second'),
  row('a/one.txt', 'the same file again'),
  row('c/three.md'),
  row('c/null.md', null),
  row('d/four.pdf', 'fourth'),
]

const STARRED = ['a/one.txt', 'c/three.md', 'c/null.md', 'd/four.pdf', 'e/missing.txt'].map(
  (name) => D + name,
)

function indexOf(cfg: SearchCfg, log: Log) {
  return (q: string, limit: number, within?: (path: string) => boolean): Row[] => {
    log('search', q, limit, within === undefined ? 'plain' : 'within')
    if (cfg.fail !== undefined) throw new Error(cfg.fail)
    return (cfg.rows ?? [])
      .filter((hit) => within === undefined || within(hit.path))
      .slice(0, limit)
  }
}

function withinOf(cfg: WithinCfg | null | undefined, log: Log) {
  if (!cfg) return null
  return (path: string): boolean => {
    log('within', path)
    if (path === cfg.failOn) throw new Error('within failed')
    return cfg.visible.includes(path)
  }
}

const q200 = 'q'.repeat(200)

/** `[cfg, query, starred, limit]` */
const queryCases: unknown[][] = [
  [{ rows: ROWS }, 'hit', STARRED, 10],
  [{ rows: ROWS }, '  padded  ', STARRED, 10],
  [{ rows: ROWS }, '', STARRED, 10],
  [{ rows: ROWS }, ' \t\n\u00a0\ufeff ', STARRED, 10],
  [{ rows: ROWS }, `  ${'q'.repeat(250)}  `, STARRED, 10],
  [{ rows: ROWS }, `${q200}x`, STARRED, 10],
  [{ rows: ROWS }, `${'q'.repeat(199)} q`, STARRED, 10],
  [{ rows: ROWS }, 'hit', STARRED, 2],
  [{ rows: ROWS }, 'hit', STARRED, 1],
  [{ rows: ROWS }, 'hit', STARRED, 0],
  [{ rows: ROWS }, 'hit', STARRED, -3],
  [{ rows: ROWS }, 'hit', STARRED, NaN],
  [{ rows: ROWS }, 'hit', STARRED, 1.5],
  [{ rows: ROWS }, 'hit', [], 10],
  [{ rows: ROWS }, 'hit', [D + 'b/two.docx'], 10],
  [{ rows: [] }, 'hit', STARRED, 10],
  [{ rows: ROWS, fail: 'index is closed' }, 'hit', STARRED, 10],
  [{ rows: ROWS, fail: 'never asked' }, '   ', STARRED, 10],
  [
    {
      rows: Array.from({ length: 205 }, (_, n) => row(`f/${n}.txt`, `s${n}`)),
    },
    'many',
    Array.from({ length: 205 }, (_, n) => `${D}f/${n}.txt`),
    300,
  ],
]

/** the open files each saved-search case sets */
const savedCases: unknown[][] = [
  [{ rows: ROWS }, 'hit', STARRED, 10],
  [{ rows: ROWS, open: [D + 'a/one.txt'] }, 'hit', STARRED, 10],
  [{ rows: ROWS, open: [D + 'b/two.docx'] }, 'hit', STARRED, 10],
  [{ rows: ROWS, open: [D + 'a/../a/one.txt'] }, 'hit', STARRED, 10],
  [{ rows: ROWS, open: 'throws' }, 'hit', STARRED, 10],
  [{ rows: ROWS, open: [D + 'c/three.md', D + 'd/four.pdf'] }, 'hit', STARRED, 1],
  [{ rows: ROWS, open: [D + 'a/one.txt'] }, '', STARRED, 10],
  [{ rows: ROWS, open: 'throws' }, '   ', STARRED, 10],
  [{ rows: ROWS, open: [] }, 'hit', STARRED, 0],
  [{ rows: ROWS, fail: 'index is closed' }, 'hit', STARRED, 10],
]

const PROJECT_ROWS: Row[] = [
  row('a/one.txt', 'starred'),
  row('p/in.txt', 'project, indexed'),
  row('p/stale.txt', 'project, indexed before the edit'),
  row('p/open.txt', 'project, open with changes'),
  row('p/hidden.txt', 'project, not visible'),
  row('other/x.txt', 'nobody'),
  row('p/in.txt', 'project, again'),
  row('p/sub/deep.md', 'project, deep'),
]

const PROJECT_VISIBLE = ['p/in.txt', 'p/stale.txt', 'p/open.txt', 'p/sub/deep.md'].map(
  (name) => D + name,
)
const PROJECT_INDEXED = ['p/in.txt', 'p/open.txt', 'p/sub/deep.md'].map((name) => D + name)
const PROJECT_STARRED = [D + 'a/one.txt', D + 'a/gone.txt']

const projectCfg = (over: Partial<SearchCfg> = {}): SearchCfg => ({
  rows: PROJECT_ROWS,
  within: { visible: PROJECT_VISIBLE },
  indexed: PROJECT_INDEXED,
  ...over,
})

const projectCases: unknown[][] = [
  [projectCfg(), 'text', PROJECT_STARRED, 10],
  [projectCfg({ within: null }), 'text', PROJECT_STARRED, 10],
  [projectCfg({ open: [D + 'p/open.txt'] }), 'text', PROJECT_STARRED, 10],
  [projectCfg({ open: [D + 'a/one.txt'] }), 'text', PROJECT_STARRED, 10],
  [projectCfg({ open: 'throws' }), 'text', PROJECT_STARRED, 10],
  [projectCfg({ open: 'throws', within: null }), 'text', PROJECT_STARRED, 10],
  [projectCfg(), 'text', PROJECT_STARRED, 2],
  [projectCfg(), 'text', PROJECT_STARRED, 0],
  [projectCfg(), 'text', PROJECT_STARRED, NaN],
  [projectCfg(), 'text', [], 10],
  [projectCfg(), '', PROJECT_STARRED, 10],
  [projectCfg({ open: 'throws' }), '  ', PROJECT_STARRED, 10],
  [projectCfg({ open: [D + 'p/open.txt'], within: null }), '', PROJECT_STARRED, 10],
  [projectCfg(), `  ${'q'.repeat(250)}`, PROJECT_STARRED, 10],
  [projectCfg({ indexed: [] }), 'text', PROJECT_STARRED, 10],
  [projectCfg({ within: { visible: PROJECT_VISIBLE, failOn: D + 'p/open.txt' } }), 'text', [], 10],
  [projectCfg({ within: { visible: [] } }), 'text', PROJECT_STARRED, 10],
  [projectCfg({ fail: 'index is closed' }), 'text', PROJECT_STARRED, 10],
  [projectCfg({ fail: 'index is closed', within: null }), 'text', PROJECT_STARRED, 10],
]

// ---------------------------------------------------------------------------
// the reads
// ---------------------------------------------------------------------------

interface ReadOp {
  read?: string
  offset?: number
  starred?: boolean
  project?: { result?: unknown; throws?: string } | null
  write?: string
  text?: string
  mtimeMs?: number
  grow?: string
  size?: number
  remove?: string
  open?: OpenSpec
}

type ReadKind = 'text' | 'page' | 'orProject'

function readSpec(kind: ReadKind, cases: Case[]): FnSpec {
  return {
    ts: async (a, cx: TsContext) => {
      const kb = await freshKb(cx.log)
      const out: unknown[] = []
      try {
        setOpen(null, cx.log)
        for (const op of a[0] as ReadOp[]) {
          if (op.open !== undefined) {
            setOpen(op.open, cx.log)
            out.push(null)
          } else if (op.write !== undefined) {
            writeFileSync(op.write, op.text ?? '')
            if (op.mtimeMs !== undefined) utimesSync(op.write, op.mtimeMs / 1000, op.mtimeMs / 1000)
            out.push(null)
          } else if (op.grow !== undefined) {
            const fd = openSync(op.grow, 'w')
            ftruncateSync(fd, op.size ?? 0)
            closeSync(fd)
            out.push(null)
          } else if (op.remove !== undefined) {
            rmSync(op.remove, { force: true })
            out.push(null)
          } else {
            const path = op.read as string
            const offset = op.offset ?? 0
            out.push(
              await settle(() => {
                if (kind === 'text') return kb.readKnowledgeFileText(path)
                if (kind === 'page') return kb.readKnowledgeFilePage(path, offset)
                const project = op.project
                const readProject = project
                  ? async (p: string, o: number) => {
                      cx.log('readProject', p, o)
                      if (project.throws !== undefined) throw new Error(project.throws)
                      return project.result
                    }
                  : null
                return kb.readKnowledgeOrProjectPage(path, offset, op.starred ?? false, readProject)
              }),
            )
          }
        }
      } finally {
        setOpenFilesSource(null)
      }
      return out
    },
    cases,
  }
}

const A = D + 'a.txt'
const B = D + 'b.md'
const read = (path: string, offset?: number): ReadOp =>
  offset === undefined ? { read: path } : { read: path, offset }
const write = (path: string, text: string, mtimeMs?: number): ReadOp => ({
  write: path,
  text,
  ...(mtimeMs === undefined ? {} : { mtimeMs }),
})

const SEC = 1_700_000_000_000

/** a file of this size is made, read and removed, so the case's folder stays small */
const sized = (name: string, size: number): ReadOp[] => [
  { grow: D + name, size },
  read(D + name),
  { remove: D + name },
]

const textCases: Case[] = [
  { args: [[read(A)]], files: { 'a.txt': 'alpha' }, note: 'parsed text' },
  { args: [[read(A), read(A)]], files: { 'a.txt': 'alpha' }, note: 'the second read is cached' },
  {
    args: [[read(A), write(A, 'bravo', SEC + 1000), read(A)]],
    files: { 'a.txt': { text: 'alpha', mtimeMs: SEC } },
    note: 'same size, later mtime: parsed again',
  },
  {
    args: [[read(A), write(A, 'bravo', SEC), read(A)]],
    files: { 'a.txt': { text: 'alpha', mtimeMs: SEC } },
    note: 'same size and mtime: still cached',
  },
  {
    args: [[read(A), write(A, 'alpha!', SEC), read(A)]],
    files: { 'a.txt': { text: 'alpha', mtimeMs: SEC } },
    note: 'same mtime, other size: parsed again',
  },
  { args: [[read(D + 'none.txt')]], note: 'no such file' },
  { args: [[read(D + 'dir.bad')]], files: { 'dir.bad': { dir: true } }, note: 'a folder' },
  {
    args: [[read(A), { open: [A] }, read(A), { open: null }, read(A)]],
    files: { 'a.txt': 'alpha' },
    note: 'unsaved: refused even when cached; saved again: cached',
  },
  {
    args: [[{ open: 'throws' }, read(A), { open: [B] }, read(A)]],
    files: { 'a.txt': 'alpha' },
    note: 'a list that cannot be read counts as unsaved',
  },
  {
    args: [sized('big.txt', 50 * 1024 * 1024 + 1)],
    note: 'one byte over the cap: refused before the parse',
  },
  {
    args: [sized('cap.bad', 50 * 1024 * 1024)],
    note: 'exactly the cap: it reaches the parser',
  },
  {
    args: [sized('big.bad', 75 * 1024 * 1024 + 700_000)],
    note: 'the sizes are rounded to megabytes',
  },
  {
    args: [sized('big.pdf', 60 * 1024 * 1024)],
    note: 'a format read at any size has no cap',
  },
  {
    args: [[read(D + 'pic.png'), read(D + 'x.bad'), read(D + 'x.mute'), read(D + 'x.empty')]],
    files: { 'pic.png': 'png', 'x.bad': 'b', 'x.mute': 'm', 'x.empty': 'e' },
    note: 'not text, not ok, no message, no text',
  },
  {
    args: [[read(D + 'x.kindless'), read(D + 'x.badtext'), read(D + 'x.boom'), read(D + 'x.zip')]],
    files: { 'x.kindless': 'k', 'x.badtext': 't', 'x.boom': 'b', 'x.zip': 'z' },
    note: 'no kind, ok false with text, the parser throws, an unknown format',
  },
  {
    args: [[read(D + 'x.bad'), read(D + 'x.bad')]],
    files: { 'x.bad': 'b' },
    note: 'a failure is not cached',
  },
  {
    args: [
      [
        ...Array.from({ length: 9 }, (_, n) => read(`${D}f${n}.txt`)),
        read(`${D}f8.txt`),
        read(`${D}f0.txt`),
        read(`${D}f1.txt`),
      ],
    ],
    files: Object.fromEntries(Array.from({ length: 9 }, (_, n) => [`f${n}.txt`, `text ${n}`])),
    note: 'eight stay: the ninth evicts the first, which then evicts the second',
  },
  {
    args: [
      [
        ...Array.from({ length: 8 }, (_, n) => read(`${D}f${n}.txt`)),
        write(`${D}f0.txt`, 'new text', SEC + 5000),
        read(`${D}f0.txt`),
        read(`${D}f8.txt`),
        read(`${D}f0.txt`),
        read(`${D}f1.txt`),
      ],
    ],
    files: {
      ...Object.fromEntries(Array.from({ length: 9 }, (_, n) => [`f${n}.txt`, `text ${n}`])),
    },
    note: 'a refreshed entry keeps its place in the order, so it is the next one out',
  },
  {
    args: [[read(A), { remove: A }, read(A)]],
    files: { 'a.txt': 'alpha' },
    note: 'deleted after it was cached: the stat fails',
  },
  { args: [[read(A), read(B)]], files: { 'a.txt': 'alpha', 'b.md': '# b' }, note: 'two files' },
]

const long = (n: number): string => Array.from({ length: n }, (_, i) => String(i % 10)).join('')

const pageCases: Case[] = [
  { args: [[read(A)]], files: { 'a.txt': 'alpha' }, note: 'a short file' },
  { args: [[read(A, 2)]], files: { 'a.txt': 'alpha' }, note: 'from an offset' },
  {
    args: [[read(A, 5), read(A, 6), read(A, 99)]],
    files: { 'a.txt': 'alpha' },
    note: 'at the end',
  },
  {
    args: [[read(A, 0), read(A, 24_000), read(A, 24_000.9), read(A, 23_999.5)]],
    files: { 'a.txt': long(24_005) },
    note: 'a chunk is 24,000 characters; the offset is floored',
  },
  {
    args: [[read(A, 0)]],
    files: { 'a.txt': long(24_000) },
    note: 'exactly one chunk',
  },
  {
    args: [[read(A, -7), read(A, NaN), read(A, Infinity), read(A, -Infinity)]],
    files: { 'a.txt': 'alpha' },
    note: 'a negative or non-finite offset starts at 0',
  },
  {
    args: [[read(A, 2), read(A, 4), read(A, 6)]],
    files: { 'a.txt': '\u{1F600}\u{1F600}ab' },
    note: 'lengths and offsets count UTF-16 units',
  },
  {
    args: [[read(A, 0), read(A, 0.5), read(A, 1)]],
    files: { 'a.txt': '' },
    note: 'an empty text',
  },
  {
    args: [[read(A, 0), { open: [A] }, read(A, 0)]],
    files: { 'a.txt': 'alpha' },
    note: 'unsaved: refused',
  },
  { args: [[read(D + 'none.txt', 0)]], note: 'no such file' },
  { args: [[read(D + 'x.bad', 0)]], files: { 'x.bad': 'b' }, note: 'the parser refused' },
]

const OK_PAGE = { status: 'ok', text: 'project text', totalChars: 12, offset: 3 }
const proj = (result: unknown): ReadOp['project'] => ({ result })
const orProject = (over: Partial<ReadOp>): ReadOp => ({ read: D + 'p/in.txt', offset: 4, ...over })

const orProjectCases: Case[] = [
  {
    args: [[orProject({ starred: true, project: proj(OK_PAGE) }), read(D + 'p/in.txt')]],
    files: { 'p/in.txt': 'starred text' },
    note: 'a starred file reads as before, the project is not asked',
  },
  {
    args: [[orProject({ starred: true, project: null, offset: 3 })]],
    files: { 'p/in.txt': 'starred text' },
    note: 'a starred file, no project',
  },
  {
    args: [[orProject({ starred: true, project: null }), orProject({ starred: true })]],
    files: { 'p/in.txt': 'starred text' },
    note: 'starred reads share the text cache',
  },
  { args: [[orProject({ project: null })]], note: 'not starred, no project' },
  { args: [[orProject({ project: proj(OK_PAGE) })]], note: 'the project reads' },
  {
    args: [[orProject({ project: proj({ ...OK_PAGE, offset: 7.5, text: '' }) })]],
    note: 'the page is the project’s answer as it is',
  },
  { args: [[orProject({ project: proj({ status: 'declined' }) })]], note: 'download declined' },
  ...(
    ['unsaved', 'too-large', 'unreadable', 'outside', 'hidden', 'ignored', 'not-found'] as const
  ).map((reason): Case => ({
    args: [[orProject({ project: proj({ status: 'refused', reason }) })]],
    note: `refused: ${reason}`,
  })),
  {
    args: [
      [
        orProject({
          read: D + 'p/big.pdf',
          project: proj({ status: 'refused', reason: 'too-large' }),
        }),
      ],
    ],
    note: 'too large: the cap of a format read at any size',
  },
  {
    args: [
      [
        orProject({
          read: D + 'p/pic.png',
          project: proj({ status: 'refused', reason: 'too-large' }),
        }),
      ],
    ],
    note: 'too large: the cap of a picture',
  },
  { args: [[orProject({ project: { throws: 'project read failed' } })]], note: 'the read throws' },
  {
    args: [[orProject({ starred: true, read: D + 'x.bad', project: proj(OK_PAGE) })]],
    files: { 'x.bad': 'b' },
    note: 'a starred read that fails does not fall back to the project',
  },
]

// ---------------------------------------------------------------------------
// the scopes
// ---------------------------------------------------------------------------

type Pairs = [string, string][]

interface ScopeOp {
  open?: [number, unknown, Pairs]
  openProject?: [number, string, unknown?, Pairs?]
  toolsOpen?: [number, string]
  close?: [number, unknown]
  narrow?: [number, unknown, string[], Pairs]
  projectOf?: [number, unknown]
  openDefault?: [number, unknown, Pairs]
  distinct?: true
}

interface ScopeCfg {
  max?: number
  defaultIds?: boolean
}

const scopesSpec = (cases: Case[]): FnSpec => ({
  ts: async (a, cx: TsContext) => {
    const kb = await freshKb(cx.log)
    const cfg = a[0] as ScopeCfg
    let made = 0
    const scopes = cfg.defaultIds
      ? new kb.KbRunScopes()
      : new kb.KbRunScopes(() => `scope-${++made}`, cfg.max)
    const defaults: string[] = []
    const out: unknown[] = []
    for (const op of a[1] as ScopeOp[]) {
      out.push(
        await settle(() => {
          if (op.open) return scopes.open(op.open[0], op.open[1], new Map(op.open[2]))
          if (op.openProject) {
            const [owner, project, starred, groups] = op.openProject
            if (starred === undefined && groups === undefined) {
              return scopes.openProject(owner, project)
            }
            return scopes.openProject(owner, project, starred, groups ? new Map(groups) : undefined)
          }
          if (op.toolsOpen) return scopes.openProject(op.toolsOpen[0], op.toolsOpen[1], 'none')
          if (op.close) return scopes.close(op.close[0], op.close[1])
          if (op.narrow) {
            const [owner, raw, paths, groups] = op.narrow
            return scopes.narrow(owner, raw, paths, () => {
              cx.log('groups')
              return new Map(groups)
            })
          }
          if (op.projectOf) return scopes.projectOf(op.projectOf[0], op.projectOf[1])
          if (op.openDefault) {
            const id: string = scopes.open(
              op.openDefault[0],
              op.openDefault[1],
              new Map(op.openDefault[2]),
            )
            defaults.push(id)
            return { length: id.length, hex: /^[0-9a-f]+$/.test(id) }
          }
          if (op.distinct) return new Set(defaults).size === defaults.length
          throw new Error('unknown op')
        }),
      )
    }
    return out
  },
  cases,
})

const GROUPS: Pairs = [
  ['/a', 'work'],
  ['/b', 'work'],
  ['/c', 'play'],
]
const PATHS = ['/a', '/b', '/c', '/d']
const scope = (id: string): unknown => ({ scope: id })
const open1 = (group: unknown, groups: Pairs = GROUPS): ScopeOp => ({ open: [1, group, groups] })

const scopeCases: Case[] = [
  {
    args: [
      {},
      [
        open1('work'),
        { narrow: [1, scope('scope-1'), PATHS, GROUPS] },
        { narrow: [1, scope('scope-1'), PATHS, [['/a', 'work']]] },
        { narrow: [1, scope('scope-1'), PATHS, []] },
        { projectOf: [1, scope('scope-1')] },
      ],
    ],
    note: 'a group scope narrows to the members it has now',
  },
  {
    args: [
      {},
      [
        open1('work'),
        { narrow: [2, scope('scope-1'), PATHS, GROUPS] },
        { projectOf: [2, scope('scope-1')] },
        { close: [2, 'scope-1'] },
        { narrow: [1, scope('scope-1'), PATHS, GROUPS] },
        { close: [1, 'scope-1'] },
        { narrow: [1, scope('scope-1'), PATHS, GROUPS] },
      ],
    ],
    note: 'another window can neither use nor close a scope',
  },
  {
    args: [
      {},
      [
        { narrow: [1, undefined, PATHS, GROUPS] },
        { narrow: [1, null, PATHS, GROUPS] },
        { narrow: [1, 'scope-1', PATHS, GROUPS] },
        { narrow: [1, [], PATHS, GROUPS] },
        { narrow: [1, {}, PATHS, GROUPS] },
        { narrow: [1, { other: 1 }, PATHS, GROUPS] },
        { narrow: [1, 5, PATHS, GROUPS] },
        { projectOf: [1, undefined] },
        { projectOf: [1, {}] },
        { projectOf: [1, [scope('x')]] },
      ],
    ],
    note: 'a call without a scope is an unscoped ask and never asks for the groups',
  },
  {
    args: [
      {},
      [
        { narrow: [1, scope('nope'), PATHS, GROUPS] },
        { narrow: [1, scope(''), PATHS, GROUPS] },
        { narrow: [1, scope(null as unknown as string), PATHS, GROUPS] },
        { narrow: [1, scope(5 as unknown as string), PATHS, GROUPS] },
        { narrow: [1, { scope: { x: 1 } }, PATHS, GROUPS] },
        { narrow: [1, { scope: ['scope-1'] }, PATHS, GROUPS] },
        { projectOf: [1, scope('nope')] },
        { projectOf: [1, scope(false as unknown as string)] },
      ],
    ],
    note: 'a scope main does not hold is refused, never read as unscoped',
  },
  {
    args: [
      {},
      [
        open1('gone'),
        open1(''),
        open1(null),
        open1(undefined),
        open1(5),
        open1(['work']),
        open1({ group: 'work' }),
        open1('work', []),
        open1('', [['/e', '']]),
        open1('play', GROUPS),
        { narrow: [1, scope('scope-1'), PATHS, GROUPS] },
      ],
    ],
    note: 'a group with no starred files is refused; no scope is minted for a refusal',
  },
  {
    args: [
      {},
      [
        { openProject: [1, 'p1', 'all'] },
        { openProject: [1, 'p2', 'none'] },
        { openProject: [1, 'p3', { group: 'work' }, GROUPS] },
        { openProject: [1, 'p4'] },
        { openProject: [1, 'p5', { group: 'gone' }, GROUPS] },
        { openProject: [1, 'p6', { group: 'work' }] },
        { openProject: [1, 'p7', { group: '' }, GROUPS] },
        open1('work'),
        ...[1, 2, 3, 4, 5].flatMap((n): ScopeOp[] => [
          { narrow: [1, scope(`scope-${n}`), PATHS, GROUPS] },
          { projectOf: [1, scope(`scope-${n}`)] },
        ]),
      ],
    ],
    note: 'a project scope: all, none, a group, the default none, refused groups',
  },
  {
    args: [
      {},
      [
        { toolsOpen: [7, 'p9'] },
        { projectOf: [7, scope('scope-1')] },
        { projectOf: [8, scope('scope-1')] },
        { narrow: [7, scope('scope-1'), PATHS, GROUPS] },
        { close: [8, 'scope-1'] },
        { projectOf: [7, scope('scope-1')] },
        { close: [7, 'scope-1'] },
        { projectOf: [7, scope('scope-1')] },
      ],
    ],
    note: 'the scope the project tools open reads no starred file',
  },
  {
    args: [
      {},
      [
        open1('work'),
        { close: [1, 5] },
        { close: [1, null] },
        { close: [1, undefined] },
        { close: [1, { scope: 'scope-1' }] },
        { close: [1, 'nope'] },
        { narrow: [1, scope('scope-1'), PATHS, GROUPS] },
      ],
    ],
    note: 'closing anything but an own scope id does nothing',
  },
  {
    args: [
      {},
      [
        ...Array.from({ length: 17 }, (): ScopeOp => open1('work')),
        { narrow: [1, scope('scope-1'), PATHS, GROUPS] },
        { narrow: [1, scope('scope-2'), PATHS, GROUPS] },
        { narrow: [1, scope('scope-17'), PATHS, GROUPS] },
        open1('work'),
        { narrow: [1, scope('scope-2'), PATHS, GROUPS] },
        { narrow: [1, scope('scope-3'), PATHS, GROUPS] },
      ],
    ],
    note: 'sixteen are held: the seventeenth drops the oldest',
  },
  {
    args: [
      { max: 2 },
      [
        open1('work'),
        open1('work'),
        { close: [1, 'scope-1'] },
        open1('work'),
        open1('work'),
        ...[1, 2, 3, 4].map((n): ScopeOp => ({ projectOf: [1, scope(`scope-${n}`)] })),
      ],
    ],
    note: 'a closed scope frees its place; the limit is the constructor’s',
  },
  {
    args: [
      { max: 0 },
      [open1('work'), { projectOf: [1, scope('scope-1')] }, { openProject: [1, 'p', 'all'] }],
    ],
    note: 'nothing is held with a limit of 0, and the scope is still handed out',
  },
  {
    args: [{ max: -1 }, [open1('work'), open1('work'), { projectOf: [1, scope('scope-2')] }]],
    note: 'a negative limit empties the map',
  },
  {
    args: [
      { max: 1.5 },
      [
        open1('work'),
        open1('work'),
        open1('work'),
        ...[1, 2, 3].map((n): ScopeOp => ({ projectOf: [1, scope(`scope-${n}`)] })),
      ],
    ],
    note: 'a fractional limit holds one',
  },
  {
    args: [
      { defaultIds: true },
      [
        { openDefault: [1, 'work', GROUPS] },
        { openDefault: [1, 'work', GROUPS] },
        { distinct: true },
      ],
    ],
    note: 'the default ids are 24 random bytes in hex, all different',
  },
]

// ---------------------------------------------------------------------------
// parseKbOpenScope, parseKbCreateRequest
// ---------------------------------------------------------------------------

const openScopeCases: Case[] = [
  [],
  [null],
  ['work'],
  [''],
  [5],
  [0],
  [true],
  [[]],
  [['work']],
  [{}],
  [{ group: 'work' }],
  [{ group: null }],
  [{ group: 'work', projectId: 'p1' }],
  [{ projectId: 'p1' }],
  [{ projectId: '' }],
  [{ projectId: 5 }],
  [{ group: 5, projectId: null }],
  [{ group: { x: 1 }, projectId: 'p1', extra: 1 }],
].map((args): Case => ({ args }))

const content2M = 'x'.repeat(2_000_000)
const createRequestCases: Case[] = [
  [],
  [null],
  ['md'],
  [5],
  [[]],
  [{}],
  [{ format: 'md' }],
  [{ format: 'MD', content: 'a' }],
  [{ format: 'txt', content: 'a' }],
  [{ format: 5, content: 'a' }],
  [{ format: 'md', content: 'hello' }],
  [{ format: 'docx', content: 'hello', title: 'Plan' }],
  [{ format: 'md', content: 'hello', title: 5 }],
  [{ format: 'md', content: 5, title: 'T' }],
  [{ format: 'md', content: null }],
  [{ format: 'md', content: '' }],
  [{ format: 'md', content: ' \t\r\n\u00a0\u2028\ufeff' }],
  [{ format: 'md', content: '\u0085' }],
  [{ format: 'md', content: '  padded  ', title: '  T  ' }],
  [{ format: 'md', content: 'a', title: 'T', extra: true }],
  [{ format: 'docx', content: content2M, title: 'edge' }],
  [{ format: 'docx', content: `${content2M}x`, title: 'over' }],
  [{ format: 'md', content: '\u{1F600}'.repeat(1_000_001) }],
  [{ format: 'md', content: '\u{1F600}'.repeat(1_000_000) }],
  [{ format: 'txt', content: ' ' }],
  [{ content: ' ' }],
].map((args): Case => ({ args }))

// ---------------------------------------------------------------------------
// createKnowledgeDocument
// ---------------------------------------------------------------------------

interface CreateCfg {
  /** the case's folder: `docs` is the default folder, `project` the project's */
  root: string
  dir?: string
  taken?: string[]
  sanitizeFail?: string
  dirFail?: string
  writeFail?: string
  docxFail?: string
  recordFail?: string
  project?: null | {
    taken?: string[]
    writeFail?: string
    docxFail?: string
    recordFail?: string
  }
}

const takenName = (name: string): string => name.replace(/(\.[^.]*)$/, '-2$1')

function createDeps(cfg: CreateCfg, log: Log) {
  const dir = cfg.dir ?? join(cfg.root, 'docs')
  const writeAt = (path: string, data: string | Uint8Array): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data)
  }
  return {
    dir: () => {
      log('dir')
      if (cfg.dirFail !== undefined) throw new Error(cfg.dirFail)
      return dir
    },
    uniquePath: (folder: string, fileName: string) => {
      log('uniquePath', folder, fileName)
      return join(folder, (cfg.taken ?? []).includes(fileName) ? takenName(fileName) : fileName)
    },
    sanitizeBase: (title: string) => {
      log('sanitizeBase', title)
      if (cfg.sanitizeFail !== undefined) throw new Error(cfg.sanitizeFail)
      return title.replace(/[^A-Za-z0-9 ]/g, '_').trim() || 'Untitled'
    },
    writeText: async (path: string, text: string) => {
      log('writeText', path, text)
      if (cfg.writeFail !== undefined) throw new Error(cfg.writeFail)
      writeAt(path, text)
    },
    markdownToDocx: async (markdown: string, out: string) => {
      log('markdownToDocx', markdown, out)
      if (cfg.docxFail !== undefined) throw new Error(cfg.docxFail)
      writeAt(out, `DOCX:${markdown}`)
    },
    recordRecent: (path: string) => {
      log('recordRecent', path)
      const fail = cfg.project ? cfg.project.recordFail : cfg.recordFail
      if (fail !== undefined) throw new Error(fail)
    },
    ...(cfg.project
      ? {
          project: {
            write: async (fileName: string, bytes: Uint8Array) => {
              log('project.write', fileName, Buffer.from(bytes).toString('hex'))
              const project = cfg.project as NonNullable<CreateCfg['project']>
              if (project.writeFail !== undefined) throw new Error(project.writeFail)
              const path = join(
                cfg.root,
                'project',
                (project.taken ?? []).includes(fileName) ? takenName(fileName) : fileName,
              )
              writeAt(path, bytes)
              return path
            },
            docxBytes: async (markdown: string) => {
              log('project.docxBytes', markdown)
              const project = cfg.project as NonNullable<CreateCfg['project']>
              if (project.docxFail !== undefined) throw new Error(project.docxFail)
              return Buffer.from(`DOCX:${markdown}`)
            },
          },
        }
      : {}),
  }
}

const req = (format: 'md' | 'docx', title: string, content: string) => ({ title, format, content })
const MD = '# Plan\n\ntext'

const rawCreateCases: Case[] = [
  { args: [{}, req('md', 'My Plan', MD)], note: 'markdown to the default folder' },
  { args: [{}, req('docx', 'My Plan', MD)], note: 'word through the CLI to the free path' },
  {
    args: [{ taken: ['My Plan.md'] }, req('md', 'My Plan', MD)],
    note: 'the name is taken: the free path',
  },
  { args: [{}, req('md', '', MD)], note: 'no title' },
  { args: [{}, req('md', 'a/b: c?', MD)], note: 'the title is sanitized by the dependency' },
  { args: [{ dir: D + 'deep/er' }, req('md', 'T', MD)], note: 'another folder' },
  {
    args: [{ project: {} }, req('md', 'My Plan', MD)],
    note: 'a project: the bytes of the markdown, no folder of the default',
  },
  {
    args: [{ project: {} }, req('docx', 'My Plan', MD)],
    note: 'a project: the document is made first, then written',
  },
  {
    args: [{ project: { taken: ['My Plan.md'] } }, req('md', 'My Plan', MD)],
    note: 'a project: the guard picks a free name',
  },
  { args: [{ project: {} }, req('md', 'T', '\u00e9\u{1F600}')], note: 'a project: UTF-8 bytes' },
  { args: [{ sanitizeFail: 'bad title' }, req('md', 'T', MD)], note: 'sanitize throws' },
  {
    args: [{ sanitizeFail: 'bad title', project: {} }, req('md', 'T', MD)],
    note: 'sanitize throws, a project',
  },
  { args: [{ dirFail: 'no folder' }, req('md', 'T', MD)], note: 'the folder cannot be named' },
  {
    args: [{ dirFail: 'no folder', project: {} }, req('md', 'T', MD)],
    note: 'a project: the default folder is never asked',
  },
  { args: [{ writeFail: 'disk full' }, req('md', 'T', MD)], note: 'the write fails' },
  { args: [{ docxFail: 'cli failed' }, req('docx', 'T', MD)], note: 'the conversion fails' },
  {
    args: [{ docxFail: 'cli failed' }, req('md', 'T', MD)],
    note: 'the conversion is not used for markdown',
  },
  {
    args: [{ writeFail: 'disk full' }, req('docx', 'T', MD)],
    note: 'the text write is not used for word',
  },
  {
    args: [{ recordFail: 'recent list broken' }, req('md', 'T', MD)],
    note: 'the file is written before the record fails',
  },
  {
    args: [{ recordFail: 'recent list broken' }, req('docx', 'T', MD)],
    note: 'word: the same',
  },
  {
    args: [{ project: { writeFail: 'guard refused' } }, req('md', 'T', MD)],
    note: 'a project: the write fails',
  },
  {
    args: [{ project: { writeFail: 'guard refused' } }, req('docx', 'T', MD)],
    note: 'a project: the write fails after the document was made',
  },
  {
    args: [{ project: { docxFail: 'cli failed' } }, req('docx', 'T', MD)],
    note: 'a project: the document cannot be made, nothing is written',
  },
  {
    args: [{ project: { docxFail: 'cli failed' } }, req('md', 'T', MD)],
    note: 'a project: markdown needs no conversion',
  },
  {
    args: [{ project: { recordFail: 'recent list broken' } }, req('md', 'T', MD)],
    note: 'a project: the file is written before the record fails',
  },
]

const createCases: Case[] = rawCreateCases.map((c) => ({
  ...c,
  args: [{ root: '$DIR', ...(c.args[0] as object) }, c.args[1]],
}))

// ---------------------------------------------------------------------------
// the group
// ---------------------------------------------------------------------------

/** the module a pure function is called on */
let shared: J
const sharedKb = async (log: Log): Promise<J> => (shared ??= await freshKb(log))

const searchSpec = (
  call: (kb: J, cfg: SearchCfg, a: unknown[], cx: TsContext) => unknown,
  cases: unknown[][],
): FnSpec => ({
  ts: async (a, cx: TsContext) => {
    const kb = await sharedKb(cx.log)
    const cfg = a[0] as SearchCfg
    try {
      setOpen(cfg.open, cx.log)
      return await call(kb, cfg, a, cx)
    } finally {
      setOpenFilesSource(null)
    }
  },
  cases: cases.map((args): Case => ({ args })),
})

export const group: Group = {
  'knowledge-base.KB_READ_CHUNK_CHARS': constant(24_000),
  'knowledge-base.KB_NOT_IN_BASE': constant('path is not in the knowledge base'),
  'knowledge-base.KB_SCOPE_UNKNOWN': constant('knowledge-base scope is not open'),
  'knowledge-base.KB_GROUP_EMPTY': constant('knowledge-base group has no starred files'),
  'knowledge-base.KB_DOWNLOAD_DECLINED': constant(
    'the person declined to download this file, which is not on this PC',
  ),
  'knowledge-base.KB_CREATE_MAX_CHARS': constant(2_000_000),
  'knowledge-base.listKnowledgeFiles': {
    ts: async (a, cx: TsContext) => (await sharedKb(cx.log)).listKnowledgeFiles(a[0] as string[]),
    cases: listCases,
  },
  'knowledge-base.searchKnowledgeBase': searchSpec(
    (kb, cfg, a, cx) =>
      kb.searchKnowledgeBase(
        indexOf(cfg, cx.log),
        a[1] as string,
        a[2] as string[],
        a[3] as number,
      ),
    queryCases,
  ),
  'knowledge-base.searchSavedKnowledgeBase': searchSpec(
    (kb, cfg, a, cx) =>
      kb.searchSavedKnowledgeBase(
        indexOf(cfg, cx.log),
        a[1] as string,
        a[2] as string[],
        a[3] as number,
      ),
    savedCases,
  ),
  'knowledge-base.readKnowledgeFileText': readSpec('text', textCases),
  'knowledge-base.readKnowledgeFilePage': readSpec('page', pageCases),
  'knowledge-base.KbRunScopes': scopesSpec(scopeCases),
  'knowledge-base.parseKbOpenScope': {
    ts: async (a, cx: TsContext) => (await sharedKb(cx.log)).parseKbOpenScope(a[0]),
    cases: openScopeCases,
  },
  'knowledge-base.searchSavedKnowledgeWithProject': searchSpec(
    (kb, cfg, a, cx) =>
      kb.searchSavedKnowledgeWithProject(
        indexOf(cfg, cx.log),
        a[1] as string,
        a[2] as string[],
        a[3] as number,
        withinOf(cfg.within, cx.log),
        (paths: readonly string[]) => {
          cx.log('indexed', [...paths])
          return paths.filter((path) => (cfg.indexed ?? []).includes(path))
        },
      ),
    projectCases,
  ),
  'knowledge-base.readKnowledgeOrProjectPage': readSpec('orProject', orProjectCases),
  'knowledge-base.parseKbCreateRequest': {
    ts: async (a, cx: TsContext) => (await sharedKb(cx.log)).parseKbCreateRequest(a[0]),
    cases: createRequestCases,
  },
  'knowledge-base.createKnowledgeDocument': {
    ts: async (a, cx: TsContext) =>
      (await sharedKb(cx.log)).createKnowledgeDocument(createDeps(a[0] as CreateCfg, cx.log), a[1]),
    cases: createCases,
  },
}
