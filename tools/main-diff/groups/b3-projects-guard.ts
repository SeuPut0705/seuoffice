/**
 * Part `guard` of group `b3-projects`: apps/shell/src/main/projects/
 * context.ts, identity.ts, selection.ts, write-guard.ts and new-documents.ts.
 * The Rust side is crates/main-core/src/calls/b3_projects/guard.rs.
 *
 * Names that are not an export of their file:
 * - `write-guard.ProjectWriteRefused` takes `(reason, detail)` and answers
 *   `{ name, reason, message, isError }` of the error it builds.
 * - `new-documents.NewDocumentPlacer` is a scenario: `[fsCtx, cfg, ops]`. `cfg`
 *   is `{ projects: {id: root}, windows: {"<webContentsId>": {project?, doc?,
 *   fail?}}, refuse: [[target, 'exists' | 'bad-path' | 'plain']] }`; the guide
 *   it builds logs `projectRoot id` and `write id target length` and writes
 *   through a real `ProjectWriteGuard` unless the target is in `refuse`; the
 *   window hooks log `windowProject id` and `documentOf id`. `ops` run one
 *   after the other over one placer, each answering `{ op, value }` or `{ op,
 *   error }` (`code`, `message`, `refused`, `reason`).
 * - the selection and identity functions that change `settings` answer the
 *   part of it they touch: `{ list, outsideDocuments, optedOutDocuments,
 *   homeProjectId }`.
 *
 * The functions that touch the disk take `fsCtx = { dir, links?, platform? }`
 * as their first argument: `dir` is `$DIR`, `links` the links to make before
 * the call (`[[linkPath, target], ...]`; a case's files cannot hold a symbolic
 * link) and `platform` what the write guard is built with. Every path of the
 * other arguments that starts with `dir` is written below the real path of
 * `dir` (the project folders are canonical paths, and a temporary folder may
 * lie under a link), and the real path is written as `dir` again in what comes
 * back; a temp file's random name in a message is written `.<hex>.tmp`. Both
 * sides do the same.
 *
 * Which functions need Electron: none, but selection.ts reaches
 * agent-sessions.ts through paths.ts, so the fake of electron-fake.ts is
 * registered first.
 */
import '../electron-fake.ts'
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Case, FileSpec, FnSpec, Group, TsContext } from '../types.ts'

const context = await import('../../../apps/shell/src/main/projects/context.ts')
const identity = await import('../../../apps/shell/src/main/projects/identity.ts')
const selection = await import('../../../apps/shell/src/main/projects/selection.ts')
const writeGuard = await import('../../../apps/shell/src/main/projects/write-guard.ts')
const newDocuments = await import('../../../apps/shell/src/main/projects/new-documents.ts')
const folderFiles = await import('../../../apps/shell/src/main/projects/folder-files.ts')

type Platform = NodeJS.Platform
type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any
const platform = (value: unknown): Platform => value as Platform

function constant(value: unknown): FnSpec {
  return {
    ts: () => value,
    single: 'a constant',
    cases: [
      { args: [] },
      { args: [], files: { 'x.txt': 'x' }, note: 'the folder after the call differs' },
    ],
  }
}

// ---------------------------------------------------------------------------
// the disk, as every function that touches it sees it
// ---------------------------------------------------------------------------

interface FsCtx {
  dir: string
  links?: [string, string][]
  platform?: string
}

const D = '$DIR'
const P = `${D}/proj`
const fsCtx = (extra: Partial<FsCtx> = {}): FsCtx => ({ dir: D, ...extra })

function makeLinks(links: [string, string][] | undefined): void {
  for (const [link, target] of links ?? []) {
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link)
  }
}

const maskTmp = (text: string): string => text.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')

function deep(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === 'string') return map(value)
  if (Array.isArray(value)) return value.map((item) => deep(item, map))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item, map)]))
  }
  return value
}

interface Run {
  ctx: FsCtx
  guard: InstanceType<typeof writeGuard.ProjectWriteGuard>
  cx: TsContext
  /** a log line with the real folder written as `dir` */
  log: (...line: unknown[]) => void
  toDir: (text: string) => string
}

/** a function that touches the disk: `[fsCtx, ...args]`, see the header */
function onDisk(run: (run: Run, args: Any[]) => unknown): FnSpec['ts'] {
  return async (all, cx) => {
    const [ctx, ...rest] = all as [FsCtx, ...unknown[]]
    makeLinks(ctx.links)
    const real = realpathSync.native(ctx.dir)
    const toReal = (text: string): string =>
      text.startsWith(ctx.dir) ? real + text.slice(ctx.dir.length) : text
    const toDir = (text: string): string =>
      maskTmp(real === ctx.dir ? text : text.split(real).join(ctx.dir))
    const guard = new writeGuard.ProjectWriteGuard(platform(ctx.platform ?? process.platform))
    const log = (...line: unknown[]): void => cx.log(...line.map((item) => deep(item, toDir)))
    try {
      return deep(await run({ ctx, guard, cx, log, toDir }, deep(rest, toReal) as Any[]), toDir)
    } catch (error) {
      const failure = error as { code?: unknown; message: string }
      throw Object.assign(
        new Error(toDir(failure.message)),
        failure.code === undefined ? {} : { code: failure.code },
      )
    }
  }
}

/** `dataDir` argument: null is left out */
const dataDirOf = (value: unknown): string | undefined => (value ?? undefined) as string | undefined

/** the bytes `{ hex }` of a case names */
interface HexData {
  hex: string
}

/** `string | Uint8Array` as a case writes it: a string, or `{ hex }` */
const dataOf = (value: string | HexData): string | Uint8Array =>
  typeof value === 'string' ? value : Buffer.from(value.hex, 'hex')

const bytesOf = (value: string | HexData): Buffer =>
  typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value.hex, 'hex')

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

const hash = (text: string): string => folderFiles.hashText(text)

interface Texts {
  dataDir: string
  instructions: string | null
  memory: string | null
  agents: string | null
  claude: string | null
}

const texts = (over: Partial<Texts> = {}): Texts => ({
  dataDir: '.seuoffice',
  instructions: null,
  memory: null,
  agents: null,
  claude: null,
  ...over,
})
const record = (hashes: Record<string, string> = {}) => ({ decision: 'use', hashes })
const SWITCHES = { memoryEnabled: true, readAgentsFiles: true }
const NO_AGENTS = { memoryEnabled: true, readAgentsFiles: false }

const MEMORY_TEXT = '<!-- Memory kept by SeuOffice. -->\n- likes tables (2026-01-02)\n'
const MEMORY_HEADER_ONLY = '<!-- Memory kept by SeuOffice. -->\n\n'

const cutCases: [string, number][] = [
  ['hello', 10],
  ['hello', 5],
  ['hello', 3],
  ['hello', 0],
  ['', 0],
  ['a\u{1f600}b', 1],
  ['a\u{1f600}b', 2],
  ['a\u{1f600}b', 3],
  ['a\u{1f600}b', 4],
  ['\u{1f600}', 1],
  ['\u{1f600}\u{1f600}', 3],
  ['\u00e9\u0301x', 2],
]

const assembleCases: Case[] = [
  {
    args: [texts(), record(), SWITCHES],
    note: 'nothing to send, nothing recorded',
  },
  {
    args: [texts({ instructions: 'Be brief.\n' }), record(), SWITCHES],
    note: 'new instructions: a notice and a hash',
  },
  {
    args: [
      texts({ instructions: 'Be brief.\n' }),
      record({ instructions: hash('Be brief.\n') }),
      SWITCHES,
    ],
    note: 'instructions as recorded: no notice, no update',
  },
  {
    args: [
      texts({
        instructions: 'Be brief.',
        agents: 'Agents file.\n',
        claude: '  Claude file.  ',
        memory: MEMORY_TEXT,
      }),
      record(),
      SWITCHES,
    ],
    note: 'every source, in order, each under its file name',
  },
  {
    args: [
      texts({
        instructions: 'Be brief.',
        agents: 'Agents file.\n',
        claude: 'Claude file.',
        memory: MEMORY_TEXT,
      }),
      record(),
      NO_AGENTS,
    ],
    note: 'the root files are not read: no part, no hash',
  },
  {
    args: [texts({ instructions: '  \n\t\n' }), record(), SWITCHES],
    note: 'blank instructions: a hash but no notice and no instructions',
  },
  {
    args: [
      texts(),
      record({ instructions: hash('x'), agents: hash('y'), memory: hash('z') }),
      SWITCHES,
    ],
    note: 'files that are gone drop their hashes, in order',
  },
  {
    args: [
      texts(),
      record({ instructions: hash('x'), agents: hash('y'), claude: hash('c'), memory: hash('z') }),
      NO_AGENTS,
    ],
    note: 'a root file gone while not read: its hash stays',
  },
  {
    args: [texts({ memory: MEMORY_TEXT }), record(), SWITCHES],
    note: 'memory with content, new',
  },
  {
    args: [texts({ memory: MEMORY_HEADER_ONLY }), record(), SWITCHES],
    note: 'memory that is only a header: a hash, no notice, nothing sent',
  },
  {
    args: [texts({ memory: MEMORY_TEXT }), record({ memory: hash(MEMORY_TEXT) }), SWITCHES],
    note: 'memory as recorded',
  },
  {
    args: [texts({ memory: MEMORY_TEXT }), record(), SWITCHES, null, 10],
    note: 'memory over its own limit: memory-long',
  },
  {
    args: [texts({ memory: MEMORY_TEXT }), record(), SWITCHES, null, MEMORY_TEXT.length],
    note: 'memory exactly at its limit',
  },
  {
    args: [texts({ memory: `- ${'x'.repeat(8100)} (2026-01-02)` }), record(), SWITCHES],
    note: 'memory over the default limit',
  },
  {
    args: [
      texts({ instructions: 'a'.repeat(20), agents: 'b'.repeat(20), claude: 'c'.repeat(20) }),
      record({
        instructions: hash('a'.repeat(20)),
        agents: hash('b'.repeat(20)),
        claude: hash('c'.repeat(20)),
      }),
      SWITCHES,
      60,
    ],
    note: 'cut inside the second part: the third is not a source',
  },
  {
    args: [texts({ instructions: 'a'.repeat(20), agents: 'b'.repeat(20) }), record(), SWITCHES, 5],
    note: 'cut inside the first part',
  },
  {
    args: [texts({ instructions: 'a'.repeat(20), agents: 'b'.repeat(20) }), record(), SWITCHES, 0],
    note: 'a limit of nothing',
  },
  {
    args: [
      texts({ instructions: 'a'.repeat(20), agents: 'b'.repeat(20) }),
      record(),
      SWITCHES,
      1000,
    ],
    note: 'a limit above the text',
  },
  {
    args: [texts({ instructions: 'a'.repeat(20), agents: 'b'.repeat(20) }), record(), SWITCHES, 51],
    note: 'the cut falls exactly where the second part begins',
  },
  {
    args: [
      texts({ instructions: 'a'.repeat(20), agents: 'b'.repeat(20), claude: 'c'.repeat(20) }),
      record(),
      SWITCHES,
      84,
    ],
    note: 'the cut falls one short of the third part',
  },
  {
    args: [
      texts({ instructions: 'a'.repeat(20), agents: 'b'.repeat(20), claude: 'c'.repeat(20) }),
      record(),
      SWITCHES,
      85,
    ],
    note: 'the cut falls exactly where the third part begins',
  },
  {
    args: [texts({ instructions: '\u{1f600}'.repeat(20) }), record(), SWITCHES, 30],
    note: 'the cut falls between the halves of a pair: the pair goes',
  },
  {
    args: [texts({ instructions: '\u{1f600}'.repeat(20) }), record(), SWITCHES, 31],
    note: 'the cut falls after a whole pair',
  },
  {
    args: [
      texts({ dataDir: '.ieumoffice', instructions: 'Old folder.', memory: MEMORY_TEXT }),
      record(),
      SWITCHES,
    ],
    note: 'instructions named in the data folder they were read from',
  },
  {
    args: [
      texts({ instructions: 'Be brief.', memory: MEMORY_TEXT }),
      record({ instructions: hash('other'), memory: hash('other') }),
      SWITCHES,
      4,
      3,
    ],
    note: 'every notice at once: changed, memory-changed, truncated, memory-long',
  },
  {
    args: [
      texts({ instructions: 'Be brief.', agents: 'Agents.' }),
      record({ instructions: hash('Be brief.') }),
      SWITCHES,
    ],
    note: 'only the file that differs is a changed one',
  },
]

// ---------------------------------------------------------------------------
// identity, selection
// ---------------------------------------------------------------------------

const STAMP = '2026-01-01T00:00:00.000Z'
interface ListEntry {
  id: string
  path: string
  pinned: boolean
  lastUsedAt: string
}
const entry = (id: string, path: string, pinned = false): ListEntry => ({
  id,
  path,
  pinned,
  lastUsedAt: STAMP,
})

interface Chosen {
  projectId: string | null
  lastChatId?: string
}
interface SettingsIn {
  list: ListEntry[]
  outsideDocuments: Record<string, Chosen>
  optedOutDocuments: Record<string, { projectId: string }>
  homeProjectId?: string | null
}
const settings = (over: Partial<SettingsIn> = {}): SettingsIn => ({
  list: [],
  outsideDocuments: {},
  optedOutDocuments: {},
  ...over,
})

/** the part of the settings these functions touch */
const touched = (s: SettingsIn): unknown => ({
  list: s.list,
  outsideDocuments: s.outsideDocuments,
  optedOutDocuments: s.optedOutDocuments,
  homeProjectId: s.homeProjectId,
})

const projectJson = (id: string, name = 'Project'): string =>
  JSON.stringify({ version: 1, id, name, createdAt: STAMP })
interface ProjectFileIn {
  version: number
  id: string
  name: string
  createdAt: string
}
const projectFile = (id: string, name = 'Project'): ProjectFileIn => ({
  version: 1,
  id,
  name,
  createdAt: STAMP,
})

const classify = (input: Any): unknown =>
  identity.classifyFolder({
    ...input,
    platform: platform(input.platform ?? 'linux'),
  })

function classifyCase(
  root: string,
  file: ProjectFileIn | null,
  s: SettingsIn,
  over: { platform?: string; relocateId?: string } = {},
  files: Record<string, FileSpec> = {},
  note?: string,
): Case {
  const input: Any = { root, file, settings: s, ...over }
  return { args: [fsCtx(), input], files, note }
}

const A = `${D}/a`
const B = `${D}/b`
const listAt = (...items: [string, string][]) => items.map(([id, path]) => entry(id, path))

const classifyCases: Case[] = [
  classifyCase(A, null, settings(), {}, {}, 'a new folder without a project file'),
  classifyCase(A, projectFile('p9'), settings(), {}, {}, 'a new folder that brings its id'),
  classifyCase(A, null, settings({ list: listAt(['p1', A]) }), {}, {}, 'listed here, no file'),
  classifyCase(
    A,
    projectFile('p1'),
    settings({ list: listAt(['p1', A]) }),
    {},
    {},
    'listed here, the same id',
  ),
  classifyCase(
    A,
    projectFile('p2'),
    settings({ list: listAt(['p1', A]) }),
    {},
    {},
    'listed here under an id the folder no longer carries: stale, and new',
  ),
  classifyCase(
    B,
    projectFile('p1'),
    settings({ list: listAt(['p1', A]) }),
    {},
    { 'a/.seuoffice/project.json': projectJson('p1') },
    'the id is listed at a folder that still holds it: a copy',
  ),
  classifyCase(
    B,
    projectFile('p1'),
    settings({ list: listAt(['p1', A]) }),
    {},
    {},
    'the id is listed at a folder that is gone: moved',
  ),
  classifyCase(
    B,
    projectFile('p1'),
    settings({ list: listAt(['p1', A]) }),
    {},
    { 'a/.seuoffice/project.json': projectJson('p2') },
    'the listed folder holds another id now: moved',
  ),
  classifyCase(
    B,
    projectFile('p1'),
    settings({ list: listAt(['p1', A]) }),
    {},
    { a: 'a file where the folder was' },
    'the listed path is a file now: moved',
  ),
  classifyCase(
    B,
    projectFile('p1'),
    settings({ list: listAt(['p1', A], ['p2', B]) }),
    {},
    { 'a/.seuoffice/project.json': projectJson('p1') },
    'copied into a folder listed under another id: copy with a stale entry',
  ),
  classifyCase(
    B,
    projectFile('p1'),
    settings({ list: listAt(['p1', A], ['p2', B]) }),
    {},
    {},
    'moved into a folder listed under another id',
  ),
  classifyCase(
    B,
    null,
    settings({ list: listAt(['p1', A]) }),
    { relocateId: 'p1' },
    {},
    're-pick of a missing project: the folder has no file',
  ),
  classifyCase(
    B,
    projectFile('p1'),
    settings({ list: listAt(['p1', A]) }),
    { relocateId: 'p1' },
    {},
    're-pick with the same id',
  ),
  classifyCase(
    B,
    projectFile('p2'),
    settings({ list: listAt(['p1', A]) }),
    { relocateId: 'p1' },
    {},
    're-pick of a folder holding another project: refused',
  ),
  classifyCase(
    B,
    null,
    settings({ list: listAt(['p1', A], ['p2', B]) }),
    { relocateId: 'p1' },
    {},
    're-pick of a folder listed under another id: refused',
  ),
  classifyCase(
    A,
    null,
    settings({ list: listAt(['p1', A]) }),
    { relocateId: 'p1' },
    {},
    're-pick of the folder it is listed at',
  ),
  classifyCase(
    B,
    null,
    settings({ list: listAt(['p2', A]) }),
    { relocateId: 'p1' },
    {},
    're-pick of an id that is not listed: no entry taken over',
  ),
  classifyCase(
    A,
    null,
    settings({ list: listAt(['p1', A]) }),
    { relocateId: '' },
    {},
    'an empty id is no re-pick',
  ),
  classifyCase(
    `${D}/A`,
    null,
    settings({ list: listAt(['p1', A]) }),
    { platform: 'darwin' },
    {},
    'a folder listed under another letter case, on a folding platform',
  ),
  classifyCase(
    `${D}/A`,
    null,
    settings({ list: listAt(['p1', A]) }),
    { platform: 'linux' },
    {},
    'the same on a platform that does not fold',
  ),
]

const rebaseSettings = (): SettingsIn =>
  settings({
    list: listAt(['p1', '/work/new']),
    optedOutDocuments: {
      '/work/old/a.docx': { projectId: 'p1' },
      '/work/other/b.docx': { projectId: 'p1' },
      '/work/old/sub/c.docx': { projectId: 'p1' },
      '/work/old/d.docx': { projectId: 'p2' },
      '/work/old': { projectId: 'p1' },
      '/work/Old/e.docx': { projectId: 'p1' },
    },
  })

const rebaseCases: Case[] = [
  { args: [rebaseSettings(), 'p1', '/work/old', '/work/new', 'linux'], note: 'records follow' },
  { args: [rebaseSettings(), 'p2', '/work/old', '/work/new', 'linux'], note: 'another project' },
  { args: [rebaseSettings(), 'p1', '/work/old', '/work/new', 'darwin'], note: 'case folded' },
  { args: [rebaseSettings(), 'p1', '/nowhere', '/work/new', 'linux'], note: 'nothing inside' },
  { args: [rebaseSettings(), 'p1', '/work/old', '/work/old/inner', 'linux'], note: 'into itself' },
  { args: [settings(), 'p1', '/work/old', '/work/new', 'linux'], note: 'no records' },
  {
    args: [
      settings({
        optedOutDocuments: {
          '/w/o/1.docx': { projectId: 'p1' },
          '/w/o/2.docx': { projectId: 'p1' },
          '/w/n/2.docx': { projectId: 'p1' },
        },
      }),
      'p1',
      '/w/o',
      '/w/n',
      'linux',
    ],
    note: 'a record already at the new path is replaced and moves to the end',
  },
  {
    args: [
      settings({
        optedOutDocuments: { 'C:\\Work\\Old\\a.docx': { projectId: 'p1' } },
      }),
      'p1',
      'C:\\work\\old',
      'D:\\New',
      'win32',
    ],
    note: 'Windows paths',
  },
]

const W = '/work'
const WA = `${W}/a`
const WB = `${W}/b`
const sel = (over: Partial<SettingsIn> = {}): SettingsIn =>
  settings({
    list: listAt(['p1', WA], ['p2', WB], ['p3', `${WA}/inner`]),
    ...over,
  })
const doc = (docKey: string) => ({ kind: 'document', docKey })
const UNTITLED = { kind: 'untitled' }
const HOME = { kind: 'home' }

const pathKeyCases: Case[] = [
  { args: [{ '/a/b': 1, '/c': 2 }, '/a/b', 'linux'], note: 'the exact key' },
  { args: [{ '/a/b': 1, '/c': 2 }, '/A/B', 'darwin'], note: 'another spelling, folded' },
  { args: [{ '/a/b': 1, '/c': 2 }, '/A/B', 'linux'], note: 'another spelling, not folded' },
  { args: [{ '/a/b/': 1 }, '/a/b', 'linux'], note: 'a trailing separator' },
  { args: [{}, '/a', 'linux'], note: 'no keys' },
  { args: [{ '': 1 }, '', 'linux'], note: 'the empty key' },
  { args: [{ 'C:\\Work\\A.docx': 1 }, 'c:/work/a.docx', 'win32'], note: 'Windows' },
  {
    args: [{ '/x': 1, '/X': 2 }, '/X', 'darwin'],
    note: 'the exact key wins over an earlier spelling',
  },
]

const containerCases: Case[] = [
  { args: [`${WA}/x.docx`, sel(), 'linux'], note: 'inside a project' },
  { args: [`${WA}/inner/y.docx`, sel(), 'linux'], note: 'the nearest of nested projects' },
  { args: [`${WB}/x.docx`, sel(), 'linux'], note: 'another project' },
  { args: [`${W}/c/x.docx`, sel(), 'linux'], note: 'outside' },
  { args: [WA, sel(), 'linux'], note: 'the project folder itself is not inside' },
  { args: [`${WA}x/y.docx`, sel(), 'linux'], note: 'a sibling that starts with the same letters' },
  { args: [`${WA.toUpperCase()}/x.docx`, sel(), 'darwin'], note: 'folded' },
  { args: [`${WA.toUpperCase()}/x.docx`, sel(), 'linux'], note: 'not folded' },
  {
    args: [
      `${WA}/inner/y.docx`,
      settings({ list: listAt(['p3', `${WA}/inner`], ['p1', WA]) }),
      'linux',
    ],
    note: 'the nearest wins whatever the list order',
  },
  {
    args: [
      `${WA}/\u{1f600}/y.docx`,
      settings({ list: listAt(['p1', WA], ['p2', `${WA}/\u{1f600}`]) }),
      'linux',
    ],
    note: 'a longer path by code units',
  },
  { args: ['', sel(), 'linux'], note: 'an empty path' },
]

const selectionForCases: Case[] = [
  { args: [sel(), doc(`${WA}/x.docx`), 'linux'], note: 'inside a project' },
  {
    args: [
      sel({ optedOutDocuments: { [`${WA}/x.docx`]: { projectId: 'p1' } } }),
      doc(`${WA}/x.docx`),
      'linux',
    ],
    note: 'inside, set to no project',
  },
  {
    args: [
      sel({ optedOutDocuments: { [`${WA}/X.docx`]: { projectId: 'p1' } } }),
      doc(`${WA}/x.docx`),
      'darwin',
    ],
    note: 'inside, set to no project under another spelling',
  },
  {
    args: [sel({ optedOutDocuments: { '': { projectId: 'p1' } } }), doc(`${WA}/x.docx`), 'linux'],
    note: 'an empty key is no mark',
  },
  { args: [sel(), doc(`${W}/c/x.docx`), 'linux'], note: 'outside, nothing remembered' },
  {
    args: [
      sel({ outsideDocuments: { [`${W}/c/x.docx`]: { projectId: 'p2', lastChatId: 'chat1' } } }),
      doc(`${W}/c/x.docx`),
      'linux',
    ],
    note: 'outside, a choice and its chat',
  },
  {
    args: [
      sel({ outsideDocuments: { [`${W}/c/x.docx`]: { projectId: 'p2' } } }),
      doc(`${W}/c/x.docx`),
      'linux',
    ],
    note: 'outside, a choice without a chat',
  },
  {
    args: [
      sel({ outsideDocuments: { [`${W}/c/x.docx`]: { projectId: 'gone', lastChatId: 'chat1' } } }),
      doc(`${W}/c/x.docx`),
      'linux',
    ],
    note: 'outside, a project no longer listed',
  },
  {
    args: [
      sel({ outsideDocuments: { [`${W}/c/x.docx`]: { projectId: null, lastChatId: 'chat1' } } }),
      doc(`${W}/c/x.docx`),
      'linux',
    ],
    note: 'outside, no project chosen',
  },
  {
    args: [
      sel({ outsideDocuments: { [`${W}/c/x.docx`]: { projectId: 'p2', lastChatId: '' } } }),
      doc(`${W}/c/x.docx`),
      'linux',
    ],
    note: 'outside, an empty chat id',
  },
  {
    args: [
      sel({ outsideDocuments: { [`${W}/C/X.docx`]: { projectId: 'p2', lastChatId: 'chat1' } } }),
      doc(`${W}/c/x.docx`),
      'darwin',
    ],
    note: 'outside, another spelling',
  },
  { args: [sel(), UNTITLED, 'linux'], note: 'untitled' },
  { args: [sel(), { kind: 'untitled', projectId: 'p2' }, 'linux'], note: 'untitled in a project' },
  {
    args: [sel(), { kind: 'untitled', projectId: 'gone' }, 'linux'],
    note: 'untitled, project not listed',
  },
  { args: [sel(), { kind: 'untitled', projectId: null }, 'linux'], note: 'untitled, null project' },
  { args: [sel(), { kind: 'untitled', projectId: '' }, 'linux'], note: 'untitled, empty project' },
  { args: [sel({ homeProjectId: 'p1' }), HOME, 'linux'], note: 'home, a listed project' },
  { args: [sel({ homeProjectId: 'gone' }), HOME, 'linux'], note: 'home, a project not listed' },
  { args: [sel({ homeProjectId: null }), HOME, 'linux'], note: 'home, none chosen' },
  { args: [sel(), HOME, 'linux'], note: 'home, nothing remembered' },
]

const recordSelectionCases: Case[] = [
  { args: [sel(), HOME, 'p2', 'linux'], note: 'home keeps the choice' },
  { args: [sel({ homeProjectId: 'p1' }), HOME, null, 'linux'], note: 'home keeps none' },
  { args: [sel(), UNTITLED, 'p2', 'linux'], note: 'untitled keeps nothing' },
  { args: [sel(), doc(`${WA}/x.docx`), null, 'linux'], note: 'inside: set to no project' },
  {
    args: [
      sel({
        optedOutDocuments: { [`${WA}/X.docx`]: { projectId: 'p1' }, '/z': { projectId: 'p2' } },
      }),
      doc(`${WA}/x.docx`),
      null,
      'darwin',
    ],
    note: 'inside: set again under another spelling, the record moves to the end',
  },
  {
    args: [
      sel({
        optedOutDocuments: { [`${WA}/x.docx`]: { projectId: 'p1' }, '/z': { projectId: 'p2' } },
      }),
      doc(`${WA}/x.docx`),
      'p1',
      'linux',
    ],
    note: 'inside: back to its project undoes the mark',
  },
  {
    args: [
      sel({ optedOutDocuments: { [`${WA}/x.docx`]: { projectId: 'p1' } } }),
      doc(`${WA}/x.docx`),
      'p2',
      'linux',
    ],
    note: 'inside: another project is kept as nothing',
  },
  {
    args: [sel(), doc(`${WA}/x.docx`), 'p1', 'linux'],
    note: 'inside: its own project, no mark to undo',
  },
  { args: [sel(), doc(`${W}/c/x.docx`), 'p2', 'linux'], note: 'outside: a choice' },
  { args: [sel(), doc(`${W}/c/x.docx`), null, 'linux'], note: 'outside: no project' },
  {
    args: [
      sel({ outsideDocuments: { [`${W}/c/x.docx`]: { projectId: 'p2', lastChatId: 'chat1' } } }),
      doc(`${W}/c/x.docx`),
      'p2',
      'linux',
    ],
    note: 'outside: the same project keeps its chat',
  },
  {
    args: [
      sel({ outsideDocuments: { [`${W}/c/x.docx`]: { projectId: 'p2', lastChatId: 'chat1' } } }),
      doc(`${W}/c/x.docx`),
      'p1',
      'linux',
    ],
    note: 'outside: another project drops the chat',
  },
  {
    args: [
      sel({ outsideDocuments: { [`${W}/c/x.docx`]: { projectId: 'p2', lastChatId: 'chat1' } } }),
      doc(`${W}/c/x.docx`),
      null,
      'linux',
    ],
    note: 'outside: none drops the chat',
  },
  {
    args: [
      sel({
        outsideDocuments: {
          [`${W}/C/X.docx`]: { projectId: 'p2', lastChatId: 'chat1' },
          '/other': { projectId: 'p1' },
        },
      }),
      doc(`${W}/c/x.docx`),
      'p2',
      'darwin',
    ],
    note: 'outside: another spelling is replaced and the record moves to the end',
  },
  {
    args: [
      sel({ outsideDocuments: { [`${W}/c/x.docx`]: { projectId: 'p2', lastChatId: '' } } }),
      doc(`${W}/c/x.docx`),
      'p2',
      'linux',
    ],
    note: 'outside: an empty chat id is dropped',
  },
]

const outsideChatCases: Case[] = [
  { args: [sel(), `${W}/c/x.docx`, 'p2', 'chat1', 'linux'], note: 'a document outside' },
  { args: [sel(), `${WA}/x.docx`, 'p2', 'chat1', 'linux'], note: 'a document inside a project' },
  { args: [sel(), `${W}/c/x.docx`, 'gone', 'chat1', 'linux'], note: 'a project not listed' },
  {
    args: [
      sel({
        outsideDocuments: {
          [`${W}/C/x.docx`]: { projectId: 'p1' },
          '/other': { projectId: 'p2' },
        },
      }),
      `${W}/c/x.docx`,
      'p2',
      'chat9',
      'darwin',
    ],
    note: 'an earlier spelling is replaced and the record moves to the end',
  },
  {
    args: [
      sel({ outsideDocuments: { [`${W}/c/x.docx`]: { projectId: 'p1', lastChatId: 'old' } } }),
      `${W}/c/x.docx`,
      'p1',
      'new',
      'linux',
    ],
    note: 'the chat is replaced',
  },
]

const dropCases: Case[] = [
  {
    args: [
      sel({
        homeProjectId: 'p1',
        optedOutDocuments: {
          [`${WA}/a.docx`]: { projectId: 'p1' },
          [`${WB}/b.docx`]: { projectId: 'p2' },
          [`${WA}/c.docx`]: { projectId: 'p1' },
        },
        outsideDocuments: {
          '/o/1': { projectId: 'p1', lastChatId: 'c' },
          '/o/2': { projectId: 'p2' },
          '/o/3': { projectId: null },
          '/o/4': { projectId: 'p1' },
        },
      }),
      'p1',
    ],
    note: 'the entry, its records and the home choice go',
  },
  {
    args: [sel({ homeProjectId: 'p2', outsideDocuments: { '/o/1': { projectId: 'p1' } } }), 'p1'],
    note: 'the home choice of another project stays',
  },
  { args: [sel(), 'gone'], note: 'a project that is not listed' },
  { args: [settings(), 'p1'], note: 'an empty list' },
  { args: [sel({ homeProjectId: null }), 'p2'], note: 'a null home choice stays null' },
]

const unregisteredCtx = (platformName = 'linux') => ({
  homeDir: `${D}/home`,
  userData: `${D}/data`,
  platform: platformName,
})

const unregisteredFiles = (over: Record<string, FileSpec> = {}): Record<string, FileSpec> => ({
  'work/proj/.seuoffice/project.json': projectJson('p7', 'Seven'),
  'work/proj/sub/deep/doc.docx': 'x',
  'work/plain/doc.docx': 'x',
  'home/.keep': 'x',
  'data/.keep': 'x',
  ...over,
})

const unregisteredCase = (
  docKey: string,
  s: SettingsIn,
  files: Record<string, FileSpec>,
  note: string,
  options: { links?: [string, string][]; platform?: string } = {},
): Case => ({
  args: [
    fsCtx(options.links === undefined ? {} : { links: options.links }),
    docKey,
    s,
    unregisteredCtx(options.platform),
  ],
  files,
  note,
})

const unregisteredCases: Case[] = [
  unregisteredCase(
    `${D}/work/proj/sub/deep/doc.docx`,
    settings(),
    unregisteredFiles(),
    'a project folder above the document',
  ),
  unregisteredCase(
    `${D}/work/proj/doc.docx`,
    settings(),
    unregisteredFiles(),
    'the document is in the project folder',
  ),
  unregisteredCase(
    `${D}/work/plain/doc.docx`,
    settings(),
    unregisteredFiles(),
    'no project above the document',
  ),
  unregisteredCase(
    `${D}/work/proj/sub/deep/doc.docx`,
    settings({ list: listAt(['p7', `${D}/work/proj`]) }),
    unregisteredFiles(),
    'the project is registered: stops at it',
  ),
  unregisteredCase(
    `${D}/work/proj/sub/deep/doc.docx`,
    settings({ list: listAt(['p9', `${D}/work`]) }),
    unregisteredFiles({ 'work/.seuoffice/project.json': projectJson('p8') }),
    'a registered folder above the document is the stop',
  ),
  unregisteredCase(
    `${D}/work/proj/inner/deep/doc.docx`,
    settings(),
    unregisteredFiles({
      'work/proj/inner/.seuoffice/project.json': projectJson('p6', 'Inner'),
      'work/proj/inner/deep/doc.docx': 'x',
    }),
    'the nearest of two projects',
  ),
  unregisteredCase(
    `${D}/work/proj/inner/deep/doc.docx`,
    settings({ list: listAt(['p6', `${D}/work/proj/inner`]) }),
    unregisteredFiles({
      'work/proj/inner/.seuoffice/project.json': projectJson('p6', 'Inner'),
      'work/proj/inner/deep/doc.docx': 'x',
    }),
    'a project in between is registered: it stops the search',
  ),
  unregisteredCase(
    `${D}/work/proj/sub/deep/doc.docx`,
    settings({ list: listAt(['p9', `${D}/work/plain`]) }),
    unregisteredFiles(),
    'a registered folder beside the project is no stop',
  ),
  unregisteredCase(
    `${D}/work/proj/sub/deep/doc.docx`,
    settings(),
    unregisteredFiles({ 'work/proj/.seuoffice/project.json': '{"id":"bad id"}' }),
    'a project file with a bad id is no project',
  ),
  unregisteredCase(
    `${D}/work/proj/sub/deep/doc.docx`,
    settings(),
    unregisteredFiles({ 'work/proj/.seuoffice/project.json': '{"id":"p7"}' }),
    'a project file without a name takes the folder name',
  ),
  unregisteredCase(
    `${D}/home/docs/doc.docx`,
    settings(),
    unregisteredFiles({ 'home/.seuoffice/project.json': projectJson('h1') }),
    'the home folder is never a project',
  ),
  unregisteredCase(
    `${D}/data/x/doc.docx`,
    settings(),
    unregisteredFiles({ 'data/.seuoffice/project.json': projectJson('d1') }),
    'the app data folder is never a project',
  ),
  unregisteredCase(
    `${D}/home/.claude/x/doc.docx`,
    settings(),
    unregisteredFiles({ 'home/.claude/.seuoffice/project.json': projectJson('c1') }),
    'a protected folder is never a project',
  ),
  unregisteredCase(
    `${D}/linked/deep/doc.docx`,
    settings(),
    unregisteredFiles(),
    'a project file reached through a link reads as absent',
    { links: [[`${D}/work/lnk/.seuoffice`, `${D}/work/proj/.seuoffice`]] },
  ),
  unregisteredCase(
    `${D}/work/lnk/doc.docx`,
    settings(),
    unregisteredFiles(),
    'the data folder of the document folder is a link',
    { links: [[`${D}/work/lnk/.seuoffice`, `${D}/work/proj/.seuoffice`]] },
  ),
  unregisteredCase(
    `${D}/work/proj/sub/deep/doc.docx`,
    settings(),
    unregisteredFiles(),
    'Windows rules on a POSIX folder',
    { platform: 'win32' },
  ),
]

// ---------------------------------------------------------------------------
// write-guard
// ---------------------------------------------------------------------------

const proj = (files: Record<string, FileSpec> = {}): Record<string, FileSpec> => ({
  'proj/readme.md': 'x',
  ...files,
})
const DATA = 'proj/.seuoffice'
const LOCKED: FileSpec = { dir: true, mode: 0o555 }
const BAD_RELS = [
  '',
  '../x',
  'a/../x',
  '/abs',
  '\\abs',
  'C:evil',
  'c:\\x',
  'a/./b',
  './a',
  'a//b',
  'a\\..\\b',
  'a:b',
  'x.',
  'x ',
  'a\u0001b',
  '.',
  '..',
  'a/',
]

const refusedCases = (build: (rel: string) => unknown[]): Case[] =>
  BAD_RELS.map((rel) => ({
    args: build(rel),
    files: proj(),
    note: `the path ${JSON.stringify(rel)}`,
  }))

/** the cases every data function shares: its way through the folders */
function wayCases(build: (root: string, rel: string, dataDir?: string) => unknown[]): Case[] {
  const at = (
    root: string,
    rel: string,
    files: Record<string, FileSpec>,
    note: string,
    options: { links?: [string, string][]; platform?: string } = {},
  ): Case => ({
    args: [
      fsCtx({
        ...(options.links === undefined ? {} : { links: options.links }),
        ...(options.platform === undefined ? {} : { platform: options.platform }),
      }),
      ...build(root, rel),
    ],
    files,
    note,
  })
  return [
    at(`${D}/nope`, 'm.md', {}, 'the project folder does not exist'),
    at(P, 'm.md', { proj: 'a file' }, 'the project folder is a file'),
    at(`${D}/alias`, 'm.md', proj(), 'the project folder is reached through a link', {
      links: [[`${D}/alias`, P]],
    }),
    at('proj', 'm.md', proj(), 'a relative project folder'),
    at(`${P}/`, 'm.md', proj(), 'a trailing separator on the root'),
    at(P, 'm.md', proj({ [DATA]: 'a file' }), 'the data folder is a file'),
    at(P, 'm.md', proj({ elsewhere: { dir: true } }), 'the data folder is a link', {
      links: [[`${P}/.seuoffice`, `${D}/elsewhere`]],
    }),
    at(
      P,
      'chats/c.jsonl',
      proj({ [`${DATA}/keep`]: 'k', elsewhere: { dir: true } }),
      'a folder on the way is a link',
      { links: [[`${P}/.seuoffice/chats`, `${D}/elsewhere`]] },
    ),
    at(P, 'chats/c.jsonl', proj({ [`${DATA}/chats`]: 'a file' }), 'a folder on the way is a file'),
    at(P, 'm.md', proj({ [`${DATA}/keep`]: 'k', 'target.md': 'secret' }), 'the target is a link', {
      links: [[`${P}/.seuoffice/m.md`, `${D}/target.md`]],
    }),
    at(P, 'm.md', proj({ [`${DATA}/keep`]: 'k' }), 'the target is a dangling link', {
      links: [[`${P}/.seuoffice/m.md`, `${D}/gone.md`]],
    }),
    at(P, 'm.md', proj({ [`${DATA}/m.md/inner`]: 'x' }), 'the target is a folder'),
    at(`${P}/sub`, 'm.md', proj({ 'proj/sub/x': 'x' }), 'a project folder below another'),
    at(P, 'm.md', proj({ 'proj/.ieumoffice/project.json': '{}' }), 'an older data folder'),
    at(P, `${'a'.repeat(300)}/m.md`, proj(), 'a name past the limit of the file system'),
    at(P, 'm.md', proj({ [`${DATA}/m.md`]: 'x' }), 'a file in the data folder is replaced'),
    at(
      P.replace('proj', 'PROJ'),
      'm.md',
      proj(),
      'the project folder in another letter case, on a folding platform',
      { platform: 'darwin' },
    ),
    at(
      P.replace('proj', 'PROJ'),
      'm.md',
      proj(),
      'the project folder in another letter case, on a platform that does not fold',
      { platform: 'linux' },
    ),
    at(P, 'm.md', proj(), 'Windows rules', { platform: 'win32' }),
  ]
}

const writeDataCases: Case[] = [
  {
    args: [fsCtx(), P, 'project.json', '{"id":"p1"}\n'],
    files: proj(),
    note: 'creates the data folder',
  },
  { args: [fsCtx(), P, 'chats/c1.json', '{}'], files: proj(), note: 'creates two levels' },
  {
    args: [fsCtx(), P, 'memory.md', 'new'],
    files: proj({ [`${DATA}/memory.md`]: 'old', [`${DATA}/keep.txt`]: 'k' }),
    note: 'replaces a file and leaves the others',
  },
  { args: [fsCtx(), P, 'bin.dat', { hex: '00ff10' }], files: proj(), note: 'bytes' },
  { args: [fsCtx(), P, 'e\u0301.md', '\u00e9'], files: proj(), note: 'a decomposed name' },
  { args: [fsCtx(), P, 'a\\b.md', 'x'], files: proj(), note: 'either slash separates' },
  {
    args: [fsCtx(), P, 'a.md', 'x'],
    files: proj({ 'proj/.ieumoffice/project.json': '{}' }),
    note: 'a project an older version made keeps its data folder',
  },
  {
    args: [fsCtx(), P, 'a.md', 'x', '.ieumoffice'],
    files: proj(),
    note: 'the data folder an operation resolved',
  },
  { args: [fsCtx(), P, 'a.md', 'x', '.genoffice'], files: proj(), note: 'not a data folder name' },
  { args: [fsCtx(), P, 'a.md', 'x', ''], files: proj(), note: 'an empty data folder name' },
  {
    args: [fsCtx(), P, 'a.md', 'x', '../evil'],
    files: proj(),
    note: 'a data folder name with a way out',
  },
  ...refusedCases((rel) => [fsCtx(), P, rel, 'x']),
  ...wayCases((root, rel) => [root, rel, 'text']),
  {
    args: [fsCtx(), P, 'm.md', 'x'],
    files: proj({ [DATA]: LOCKED }),
    note: 'a read-only data folder',
  },
  {
    args: [fsCtx(), P, 'm.md', 'x'],
    files: { proj: LOCKED, 'proj/readme.md': 'x' },
    note: 'a read-only project folder, no data folder yet',
  },
  {
    args: [fsCtx(), P, 'm.md', 'x'],
    files: proj({ [`${DATA}/m.md`]: { text: 'old', mode: 0o444 } }),
    note: 'a read-only file is replaced by a rename',
  },
]

const appendCases: Case[] = [
  { args: [fsCtx(), P, 'chats/c.jsonl', '{"a":1}\n'], files: proj(), note: 'creates the file' },
  {
    args: [fsCtx(), P, 'c.jsonl', '{"b":2}\n'],
    files: proj({ [`${DATA}/c.jsonl`]: '{"a":1}\n' }),
    note: 'appends',
  },
  {
    args: [fsCtx(), P, 'c.jsonl', '\u00e9\u{1f600}\n'],
    files: proj({ [`${DATA}/c.jsonl`]: '' }),
    note: 'appends non-ASCII text to an empty file',
  },
  {
    args: [fsCtx(), P, 'chats/c.jsonl', 'x'],
    files: proj({
      [`${DATA}/chats/c.jsonl`]: 'a',
      'proj/other.jsonl': { link: `${DATA}/chats/c.jsonl` },
    }),
    note: 'a file with a second name is refused',
  },
  {
    args: [fsCtx(), P, 'c.jsonl', 'x'],
    files: proj({ [`${DATA}/c.jsonl`]: { text: 'a', mode: 0o444 } }),
    note: 'a read-only file',
  },
  {
    args: [fsCtx(), P, 'c.jsonl', 'x', '.ieumoffice'],
    files: proj({ 'proj/.ieumoffice/c.jsonl': 'a' }),
    note: 'in the older data folder',
  },
  { args: [fsCtx(), P, 'c.jsonl', 'x', 'chats'], files: proj(), note: 'not a data folder name' },
  ...refusedCases((rel) => [fsCtx(), P, rel, 'x']),
  ...wayCases((root, rel) => [root, rel, 'text']),
  {
    args: [fsCtx(), P, 'm.md', 'x'],
    files: proj({ [DATA]: LOCKED }),
    note: 'a read-only data folder',
  },
]

type Change =
  | { kind: 'set'; text: string }
  | { kind: 'null' }
  | { kind: 'undefined' }
  | { kind: 'append'; text: string }
  | { kind: 'throw'; message: string }
  | { kind: 'late'; text: string }

const SET: Change = { kind: 'set', text: 'changed' }

const updateCases: Case[] = [
  { args: [fsCtx(), P, 'memory.md', SET], files: proj(), note: 'a file that is not there yet' },
  {
    args: [fsCtx(), P, 'memory.md', { kind: 'null' }],
    files: proj(),
    note: 'nothing to write: the folder is not made',
  },
  {
    args: [fsCtx(), P, 'memory.md', { kind: 'undefined' }],
    files: proj({ [`${DATA}/memory.md`]: 'kept' }),
    note: 'undefined leaves the file',
  },
  {
    args: [fsCtx(), P, 'memory.md', SET],
    files: proj({ [`${DATA}/memory.md`]: 'old' }),
    note: 'replaces',
  },
  {
    args: [fsCtx(), P, 'memory.md', { kind: 'append', text: ' more' }],
    files: proj({ [`${DATA}/memory.md`]: 'old' }),
    note: 'builds on the current text',
  },
  {
    args: [fsCtx(), P, 'memory.md', { kind: 'append', text: 'first' }],
    files: proj(),
    note: 'builds on an absent file',
  },
  {
    args: [fsCtx(), P, 'memory.md', { kind: 'late', text: 'after a wait' }],
    files: proj({ [`${DATA}/memory.md`]: 'old' }),
    note: 'a change that answers late',
  },
  {
    args: [fsCtx(), P, 'memory.md', { kind: 'set', text: '' }],
    files: proj({ [`${DATA}/memory.md`]: 'old' }),
    note: 'an empty text is a text',
  },
  {
    args: [fsCtx(), P, 'memory.md', { kind: 'null' }],
    files: proj({ [`${DATA}/memory.md`]: { hex: 'ff41' } }),
    note: 'a file that is not UTF-8 reads with replacement characters',
  },
  {
    args: [fsCtx(), P, 'memory.md', { kind: 'null' }],
    files: proj({ [`${DATA}/memory.md`]: '\ufeffbom' }),
    note: 'a byte order mark stays',
  },
  {
    args: [fsCtx(), P, 'memory.md', { kind: 'throw', message: 'boom' }],
    files: proj({ [`${DATA}/memory.md`]: 'old' }),
    note: 'what the change throws comes back and nothing is written',
  },
  {
    args: [fsCtx(), P, 'x.md', SET, '.ieumoffice'],
    files: proj({ 'proj/.ieumoffice/x.md': 'old' }),
    note: 'in the older data folder',
  },
  { args: [fsCtx(), P, 'x.md', SET, 'chats'], files: proj(), note: 'not a data folder name' },
  ...refusedCases((rel) => [fsCtx(), P, rel, SET]),
  ...wayCases((root, rel) => [root, rel, SET]),
  {
    args: [fsCtx(), P, 'm.md', SET],
    files: proj({ [`${DATA}/m.md`]: 'old', [DATA]: LOCKED }),
    note: 'a read-only data folder: the read works, the write does not',
  },
  {
    args: [fsCtx(), P, 'm.md', { kind: 'set', text: 'x' }],
    files: proj({ [`${DATA}/m.md`]: { text: 'old', mode: 0 } }),
    note: 'a file that cannot be read',
  },
]

const removeCases: Case[] = [
  {
    args: [fsCtx(), P, 'old.bak.md'],
    files: proj({ [`${DATA}/old.bak.md`]: 'x', [`${DATA}/keep.md`]: 'k' }),
    note: 'removes one file',
  },
  {
    args: [fsCtx(), P, 'old.bak.md'],
    files: proj({ [`${DATA}/keep.md`]: 'k' }),
    note: 'a missing file',
  },
  { args: [fsCtx(), P, 'old.bak.md'], files: proj(), note: 'no data folder: none is made' },
  {
    args: [fsCtx(), P, 'chats/old.bak.md'],
    files: proj({ [`${DATA}/chats/old.bak.md`]: 'x' }),
    note: 'in a subfolder',
  },
  {
    args: [fsCtx(), P, 'old.bak.md', '.ieumoffice'],
    files: proj({ 'proj/.ieumoffice/old.bak.md': 'x' }),
    note: 'in the older data folder',
  },
  { args: [fsCtx(), P, 'old.bak.md', 'chats'], files: proj(), note: 'not a data folder name' },
  ...refusedCases((rel) => [fsCtx(), P, rel]),
  ...wayCases((root, rel) => [root, rel]),
  {
    args: [fsCtx(), P, 'm.md'],
    files: proj({ [`${DATA}/m.md`]: 'x', [DATA]: LOCKED }),
    note: 'a read-only data folder',
  },
]

const dataPathCases: Case[] = [
  { args: [fsCtx(), P, 'project.json'], files: proj(), note: 'the current data folder' },
  { args: [fsCtx(), P, 'chats/c.json'], files: proj(), note: 'a nested file' },
  {
    args: [fsCtx(), P, 'project.json'],
    files: proj({ 'proj/.ieumoffice/project.json': '{}' }),
    note: 'a project that keeps its older data folder',
  },
  {
    args: [fsCtx(), P, 'project.json'],
    files: proj({ 'proj/.ieumoffice': { dir: true }, [`${DATA}/x`]: 'y' }),
    note: 'the current folder holds data, the older one is empty',
  },
  { args: [fsCtx(), P, 'project.json', '.ieumoffice'], files: proj(), note: 'a name given' },
  {
    args: [fsCtx(), P, 'project.json', '.nope'],
    files: proj(),
    note: 'a name that is not a data folder',
  },
  {
    args: [fsCtx(), `${D}/nope`, 'project.json'],
    note: 'a folder that is not there: nothing is touched',
  },
  ...refusedCases((rel) => [fsCtx(), P, rel]),
]

const NEW_FILES = proj({ 'proj/docs/keep.txt': 'k' })

const newDocCase = (
  target: string,
  files: Record<string, FileSpec>,
  note: string,
  options: { root?: string; links?: [string, string][]; platform?: string; data?: unknown } = {},
): Case => ({
  args: [
    fsCtx({
      ...(options.links === undefined ? {} : { links: options.links }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    }),
    options.root ?? P,
    target,
    options.data ?? 'new document',
  ],
  files,
  note,
})

const newDocumentCases: Case[] = [
  newDocCase(`${P}/a.docx`, NEW_FILES, 'in the project folder'),
  newDocCase(`${P}/docs/a.docx`, NEW_FILES, 'in a folder below it'),
  newDocCase(`${P}/docs/a.docx`, NEW_FILES, 'bytes', { data: { hex: '504b0304ff' } }),
  newDocCase(`${P}/docs/a.docx`, NEW_FILES, 'Windows rules', { platform: 'win32' }),
  newDocCase(`${P}/docs/a.docx`, NEW_FILES, 'folding rules', { platform: 'darwin' }),
  newDocCase(`${P}/missing/a.docx`, NEW_FILES, 'the folder is missing'),
  newDocCase(`${P}/missing/deeper/a.docx`, NEW_FILES, 'two folders are missing'),
  newDocCase(`${P}/a.docx`, proj({ 'a.docx': 'x' }), 'the name is taken (not in the project)'),
  newDocCase(`${P}/docs/keep.txt`, NEW_FILES, 'the name is taken'),
  newDocCase(`${P}/docs`, NEW_FILES, 'the name is a folder'),
  newDocCase(
    `${P}/docs/a.docx`,
    proj({ 'proj/docs': 'a file' }),
    'a file where the folder should be',
  ),
  newDocCase(`${P}/docs/a.docx`, proj({ elsewhere: { dir: true } }), 'the folder is a link', {
    links: [[`${P}/docs`, `${D}/elsewhere`]],
  }),
  newDocCase(`${P}/a.docx`, proj({ 'target.docx': 'x' }), 'the name is a link', {
    links: [[`${P}/a.docx`, `${D}/target.docx`]],
  }),
  newDocCase(`${P}/a.docx`, proj(), 'the name is a dangling link', {
    links: [[`${P}/a.docx`, `${D}/gone.docx`]],
  }),
  newDocCase(
    `${P}/docs/a.docx`,
    proj({ 'proj/docs/x': 'x', elsewhere: { dir: true } }),
    'the folder below a link below the folder',
    { links: [[`${P}/docs/in`, `${D}/elsewhere`]] },
  ),
  newDocCase(`${P}/.seuoffice/a.docx`, proj({ [`${DATA}/k`]: 'k' }), 'inside the data folder'),
  newDocCase(
    `${P}/.ieumoffice/a.docx`,
    proj({ 'proj/.ieumoffice/k': 'k' }),
    'inside the older data folder',
  ),
  newDocCase(
    `${P}/.seuoffice/sub/a.docx`,
    proj({ [`${DATA}/sub/k`]: 'k' }),
    'deep in the data folder',
  ),
  newDocCase(`${D}/other/a.docx`, proj({ 'other/k': 'k' }), 'outside the project folder'),
  newDocCase(
    `${D}/proj2/a.docx`,
    proj({ 'proj2/k': 'k' }),
    'a folder that starts with the same name',
  ),
  newDocCase(P, proj(), 'the project folder itself'),
  newDocCase('proj/a.docx', proj(), 'a relative target'),
  newDocCase('a.docx', proj(), 'a bare file name'),
  newDocCase(`${P}/docs/../a.docx`, NEW_FILES, 'a target with ..'),
  newDocCase(`${P}/./a.docx`, NEW_FILES, 'a target with .'),
  newDocCase(`${P}/docs\\..\\a.docx`, NEW_FILES, 'a target with .. and the other slash'),
  newDocCase(`${P}/a.`, proj(), 'a name with a trailing dot'),
  newDocCase(`${P}/a b `, proj(), 'a name with a trailing space'),
  newDocCase(`${P}/a:b.docx`, proj(), 'a name with a colon'),
  newDocCase(`${P}/a\u0001.docx`, proj(), 'a name with a control character'),
  newDocCase('C:\\x\\a.docx', proj(), 'a Windows drive path on a POSIX folder'),
  newDocCase('\\\\srv\\share\\a.docx', proj(), 'a share path on a POSIX folder'),
  newDocCase('C:evil', proj(), 'a drive-relative name'),
  newDocCase('', proj(), 'an empty target'),
  newDocCase(`${P}/a.docx`, {}, 'the project folder is missing', { root: `${D}/nope` }),
  newDocCase(`${P}/a.docx`, { proj: 'a file' }, 'the project folder is a file'),
  newDocCase(`${D}/alias/a.docx`, proj(), 'the project folder is reached through a link', {
    root: `${D}/alias`,
    links: [[`${D}/alias`, P]],
  }),
  newDocCase(`${P}/a.docx`, proj(), 'a relative project folder', { root: 'proj' }),
  newDocCase(
    `${P}/docs/a.docx`,
    proj({ 'proj/docs/k': 'k', proj: LOCKED }),
    'a read-only project folder',
  ),
  newDocCase(
    `${P}/docs/a.docx`,
    { 'proj/docs/k': 'k', 'proj/docs': LOCKED },
    'a read-only target folder',
  ),
  newDocCase(`${P}/${'n'.repeat(300)}.docx`, proj(), 'a name past the limit of the file system'),
  newDocCase(`${P}/e\u0301.docx`, proj(), 'a decomposed name'),
  newDocCase(
    `${P}/DOCS/a.docx`,
    NEW_FILES,
    'the folder in another letter case, on a platform that does not fold',
    {
      platform: 'linux',
    },
  ),
  newDocCase(
    `${P}/DOCS/a.docx`,
    NEW_FILES,
    'the folder in another letter case, on a folding platform',
    {
      platform: 'darwin',
    },
  ),
]

const projectFolderCases: Case[] = (
  [
    [`${D}/parent`, 'New project', { 'parent/x': 'x' }, 'a new folder'],
    [`${D}/parent`, 'e\u0301', { 'parent/x': 'x' }, 'a decomposed name'],
    [`${D}/parent`, '\u{1f600} Project', { 'parent/x': 'x' }, 'a name with an emoji'],
    [`${D}/parent`, 'taken', { 'parent/taken/x': 'x' }, 'a folder of that name is there'],
    [`${D}/parent`, 'taken', { 'parent/taken': 'a file' }, 'a file of that name is there'],
    [
      `${D}/parent`,
      'Taken',
      { 'parent/taken/x': 'x' },
      'another letter case of a name that is there',
    ],
    [`${D}/parent`, '', { 'parent/x': 'x' }, 'an empty name'],
    [`${D}/parent`, '.', { 'parent/x': 'x' }, 'a dot'],
    [`${D}/parent`, '..', { 'parent/x': 'x' }, 'two dots'],
    [`${D}/parent`, 'a/b', { 'parent/x': 'x' }, 'a slash'],
    [`${D}/parent`, 'a\\b', { 'parent/x': 'x' }, 'a backslash'],
    [`${D}/parent`, 'a:b', { 'parent/x': 'x' }, 'a colon'],
    [`${D}/parent`, 'con', { 'parent/x': 'x' }, 'a reserved name'],
    [`${D}/parent`, 'LPT1.txt', { 'parent/x': 'x' }, 'a reserved name with an extension'],
    [`${D}/parent`, 'dots.', { 'parent/x': 'x' }, 'a trailing dot'],
    [`${D}/parent`, 'space ', { 'parent/x': 'x' }, 'a trailing space'],
    [`${D}/parent`, ' lead', { 'parent/x': 'x' }, 'a leading space'],
    [`${D}/parent`, 'a\u0001b', { 'parent/x': 'x' }, 'a control character'],
    [`${D}/parent`, 'x'.repeat(255), { 'parent/x': 'x' }, 'a name of the longest length'],
    [`${D}/parent`, 'x'.repeat(256), { 'parent/x': 'x' }, 'a name past the longest length'],
    ['parent', 'New project', {}, 'a relative parent'],
    [`${D}/nope`, 'New project', {}, 'the parent is missing'],
    [`${D}/parent`, 'New project', { parent: 'a file' }, 'the parent is a file'],
    [`${D}/parent`, 'New project', { parent: LOCKED, 'parent/x': 'x' }, 'a read-only parent'],
    [
      `${D}/e\u0301dir`,
      'New project',
      { 'e\u0301dir/x': 'x' },
      'a decomposed parent comes back composed',
    ],
  ] as [string, string, Record<string, FileSpec>, string][]
)
  .map(([parent, name, files, note]): Case => ({ args: [fsCtx(), parent, name], files, note }))
  .concat([
    {
      args: [fsCtx({ links: [[`${D}/alias`, `${D}/parent`]] }), `${D}/alias`, 'Through a link'],
      files: { 'parent/x': 'x' },
      note: 'the parent is a link: the folder is made under the real path',
    },
    {
      args: [fsCtx({ links: [[`${D}/parent/there`, `${D}/elsewhere`]] }), `${D}/parent`, 'there'],
      files: { 'parent/x': 'x', elsewhere: { dir: true } },
      note: 'a link of that name is there',
    },
    {
      args: [fsCtx({ links: [[`${D}/parent/there`, `${D}/gone`]] }), `${D}/parent`, 'there'],
      files: { 'parent/x': 'x' },
      note: 'a dangling link of that name is there',
    },
  ])

const REASONS = [
  'bad-path',
  'outside',
  'link',
  'not-a-folder',
  'root-moved',
  'exists',
  'missing-folder',
  'hard-link',
]

const refusedErrorCases: Case[] = [
  ...REASONS.map((reason): Case => ({ args: [reason, `${D}/proj/x`], note: reason })),
  { args: ['bad-path', ''], note: 'an empty detail' },
  { args: ['exists', 'a (2).docx\n'], note: 'a detail with a line feed' },
]

// ---------------------------------------------------------------------------
// new-documents
// ---------------------------------------------------------------------------

const folderCases: Case[] = [
  {
    args: ['/work/p', '/work/p/docs/a.docx', 'linux'],
    note: 'a document in a folder below the root',
  },
  { args: ['/work/p', '/work/p/docs/deep/a.docx', 'linux'], note: 'two folders down' },
  { args: ['/work/p', '/work/p/a.docx', 'linux'], note: 'a document in the root' },
  { args: ['/work/p', '/work/q/a.docx', 'linux'], note: 'a document in another folder' },
  { args: ['/work/p', '/work/p', 'linux'], note: 'the root itself' },
  { args: ['/work/p', null, 'linux'], note: 'no document' },
  { args: ['/work/p', undefined, 'linux'], note: 'no document given' },
  { args: ['/work/p', '', 'linux'], note: 'an empty document path' },
  { args: ['/work/p', '/work/p/.seuoffice/a.docx', 'linux'], note: 'in the data folder' },
  { args: ['/work/p', '/work/p/.seuoffice/sub/a.docx', 'linux'], note: 'deep in the data folder' },
  { args: ['/work/p', '/work/p/.ieumoffice/a.docx', 'linux'], note: 'in the older data folder' },
  {
    args: ['/work/p', '/work/p/docs/.seuoffice/a.docx', 'linux'],
    note: 'a data-named folder below a folder',
  },
  {
    args: ['/work/p', '/WORK/P/Docs/a.docx', 'darwin'],
    note: 'folded: the result keeps the root spelling, the rest as given',
  },
  { args: ['/work/p', '/WORK/P/Docs/a.docx', 'linux'], note: 'not folded' },
  {
    args: ['/work/p', '/work/p/.SEUOFFICE/a.docx', 'darwin'],
    note: 'the data folder in another letter case',
  },
  { args: ['C:\\Work\\P', 'c:\\work\\p\\Docs\\a.docx', 'win32'], note: 'Windows' },
  {
    args: ['C:\\Work\\P', 'C:\\Work\\P\\.seuoffice\\a.docx', 'win32'],
    note: 'Windows, in the data folder',
  },
  { args: ['/work/p', '/work/p/e\u0301/a.docx', 'linux'], note: 'a decomposed folder' },
]

const bareCases: Case[] = [
  ...[
    'a.docx',
    'a (2).docx',
    '.hidden',
    'no extension',
    'e\u0301.docx',
    '\u{1f600}.docx',
    '...',
  ].map((name): Case => ({ args: [name], note: 'a bare name' })),
  ...['', '.', '..', 'a/b.docx', 'a\\b.docx', '/a.docx', 'C:a.docx', 'a:b', '../a', 'a/'].map(
    (name): Case => ({ args: [name], note: 'not a bare name' }),
  ),
]

const numberedCases: Case[] = [
  ['a.docx', 1],
  ['a.docx', 2],
  ['a.docx', 10],
  ['a.docx', 0],
  ['a.docx', -3],
  ['a.docx', 1.5],
  ['archive.tar.gz', 3],
  ['noext', 2],
  ['.hidden', 2],
  ['.hidden.txt', 2],
  ['a.', 2],
  ['', 2],
  ['e\u0301.docx', 2],
  ['\u{1f600}.md', 4],
  ['a (2).docx', 2],
].map(([name, n]): Case => ({ args: [name, n] }))

// the placer scenario

interface Cfg {
  projects?: Record<string, string>
  windows?: Record<string, { project?: string | null; doc?: string | null; fail?: string }>
  refuse?: [string, string][]
}

const placerCase = (
  cfg: Cfg,
  ops: unknown[],
  files: Record<string, FileSpec>,
  note: string,
): Case => ({
  args: [fsCtx(), cfg, ops],
  files,
  note,
})

const PROJECTS = { p1: P, p2: `${D}/proj2` }
const DOC_FILES = proj({
  'proj/docs/a.docx': 'a',
  'proj2/readme.md': 'x',
  'proj/.seuoffice/k': 'k',
})
const WINDOWS = {
  '1': { project: 'p1', doc: `${P}/docs/a.docx` },
  '2': { project: 'p1', doc: null },
  '3': { project: 'p2', doc: `${P}/docs/a.docx` },
  '4': { project: null },
  '5': { project: 'p1', doc: `${P}/.seuoffice/x.docx` },
  '6': { project: 'p1', doc: `${D}/elsewhere/x.docx` },
  '7': { project: 'zz', doc: null },
}

const placerCases: Case[] = [
  placerCase(
    { projects: PROJECTS, windows: WINDOWS },
    [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ op: 'placementFor', id })),
    DOC_FILES,
    'where each window writes: its document folder, the top, none',
  ),
  placerCase(
    { projects: PROJECTS, windows: WINDOWS },
    [
      { op: 'writeFor', id: 1, fileName: 'new.docx', text: 'one' },
      { op: 'writeFor', id: 1, fileName: 'new.docx', text: 'two' },
      { op: 'writeFor', id: 1, fileName: 'new.docx', text: 'three' },
      { op: 'writeFor', id: 4, fileName: 'new.docx', text: 'none' },
      { op: 'writeFor', id: 2, fileName: 'top.docx', text: 'top' },
    ],
    DOC_FILES,
    'files take the first free name; no project writes nothing',
  ),
  placerCase(
    { projects: PROJECTS, windows: WINDOWS },
    [
      { op: 'writeFor', id: 1, fileName: 'a.docx', text: 'x' },
      { op: 'writeFor', id: 1, fileName: 'dir.d', text: 'x' },
      { op: 'writeFor', id: 1, fileName: 'noext', text: 'x' },
      { op: 'writeFor', id: 1, fileName: 'noext', text: 'y' },
      { op: 'writeFor', id: 1, fileName: '.hidden', text: 'x' },
      { op: 'writeFor', id: 1, fileName: '.hidden', text: 'y' },
    ],
    DOC_FILES,
    'numbering of names with and without an extension, and of a taken name',
  ),
  placerCase(
    { projects: PROJECTS, windows: WINDOWS },
    ['../x.docx', 'a/b.docx', 'a\\b.docx', 'C:x.docx', '.', '..', '', 'a:b'].map((fileName) => ({
      op: 'writeFor',
      id: 1,
      fileName,
      text: 'x',
    })),
    DOC_FILES,
    'a file name that is not bare is refused before anything is asked',
  ),
  placerCase(
    {
      projects: PROJECTS,
      windows: WINDOWS,
      refuse: [
        [`${P}/docs/b.docx`, 'exists'],
        [`${P}/docs/b (2).docx`, 'exists'],
      ],
    },
    [{ op: 'writeFor', id: 1, fileName: 'b.docx', text: 'x' }],
    DOC_FILES,
    'a name taken in between: the next one is tried',
  ),
  placerCase(
    { projects: PROJECTS, windows: WINDOWS, refuse: [[`${P}/docs/b.docx`, 'bad-path']] },
    [
      { op: 'writeFor', id: 1, fileName: 'b.docx', text: 'x' },
      { op: 'writeFor', id: 1, fileName: 'c.docx', text: 'x' },
    ],
    DOC_FILES,
    'another refusal ends the write',
  ),
  placerCase(
    { projects: PROJECTS, windows: WINDOWS, refuse: [[`${P}/docs/b.docx`, 'plain']] },
    [{ op: 'writeFor', id: 1, fileName: 'b.docx', text: 'x' }],
    DOC_FILES,
    'any other failure ends the write',
  ),
  placerCase(
    { projects: PROJECTS, windows: WINDOWS },
    [
      {
        op: 'write',
        placement: { projectId: 'p1', root: P, dir: `${P}/docs` },
        fileName: 'w.docx',
        text: 'x',
      },
      {
        op: 'write',
        placement: { projectId: 'zz', root: P, dir: `${P}/docs` },
        fileName: 'w.docx',
        text: 'x',
      },
      {
        op: 'write',
        placement: { projectId: 'p1', root: P, dir: `${P}/nope` },
        fileName: 'w.docx',
        text: 'x',
      },
      {
        op: 'write',
        placement: { projectId: 'p1', root: P, dir: `${P}/.seuoffice` },
        fileName: 'w.docx',
        text: 'x',
      },
      {
        op: 'write',
        placement: { projectId: 'p1', root: P, dir: `${D}/proj2` },
        fileName: 'w.docx',
        text: 'x',
      },
    ],
    DOC_FILES,
    'a placement written to directly: an unknown project, a missing folder, the data folder, another project folder',
  ),
  placerCase(
    { projects: PROJECTS, windows: WINDOWS },
    [
      {
        op: 'write',
        placement: { projectId: 'p1', root: P, dir: `${P}/docs` },
        fileName: 'full.docx',
        text: 'x',
      },
    ],
    {
      ...DOC_FILES,
      ...Object.fromEntries(
        Array.from({ length: 1000 }, (_, i): [string, FileSpec] => [
          `proj/docs/${i === 0 ? 'full.docx' : `full (${i + 1}).docx`}`,
          '',
        ]),
      ),
    },
    'every one of the 1000 names is taken',
  ),
  placerCase(
    { projects: PROJECTS, windows: WINDOWS },
    [
      { op: 'preset', id: 2, opener: { kind: 'window', webContentsId: 1 } },
      { op: 'placementFor', id: 2 },
      { op: 'presetProjectOf', id: 2 },
      { op: 'saveDialogFolder', id: 2 },
      { op: 'forget', id: 2 },
      { op: 'placementFor', id: 2 },
      { op: 'presetProjectOf', id: 2 },
    ],
    DOC_FILES,
    'a tab a create flow opened keeps its opener folder until it closes',
  ),
  placerCase(
    { projects: PROJECTS, windows: WINDOWS },
    [
      { op: 'preset', id: 3, opener: { kind: 'window', webContentsId: 1 } },
      { op: 'placementFor', id: 3 },
      { op: 'presetProjectOf', id: 3 },
      {
        op: 'preset',
        id: 2,
        placement: { projectId: 'p1', root: `${D}/proj-moved`, dir: `${D}/proj-moved` },
      },
      { op: 'placementFor', id: 2 },
      { op: 'presetProjectOf', id: 2 },
    ],
    DOC_FILES,
    'a preset of another project, or of a root that changed, is not used',
  ),
  placerCase(
    { projects: { p1: P }, windows: WINDOWS },
    [
      {
        op: 'preset',
        id: 2,
        placement: { projectId: 'p2', root: `${D}/proj2`, dir: `${D}/proj2` },
      },
      { op: 'presetProjectOf', id: 2 },
      { op: 'presetProjectOf', id: 9 },
    ],
    DOC_FILES,
    'a preset of a project that is not listed',
  ),
  placerCase(
    { projects: PROJECTS, windows: WINDOWS },
    [
      { op: 'preset', id: 2, reject: 'the opener failed' },
      { op: 'presetProjectOf', id: 2 },
      { op: 'placementFor', id: 2 },
      { op: 'preset', id: 2, placement: null },
      { op: 'presetProjectOf', id: 2 },
      { op: 'preset', id: 2, opener: null },
      { op: 'preset', id: 2, opener: { kind: 'home' }, homeId: 4 },
      { op: 'presetProjectOf', id: 2 },
    ],
    DOC_FILES,
    'a placement that failed or is null presets nothing',
  ),
  placerCase(
    { projects: PROJECTS, windows: { ...WINDOWS, '8': { project: 'p1', fail: 'window gone' } } },
    [
      { op: 'placementFor', id: 8 },
      { op: 'writeFor', id: 8, fileName: 'x.docx', text: 'x' },
      { op: 'saveDialogFolder', id: 8 },
      { op: 'preset', id: 2, opener: { kind: 'window', webContentsId: 8 } },
      { op: 'presetProjectOf', id: 2 },
    ],
    DOC_FILES,
    'a window that cannot say its project',
  ),
  placerCase(
    { projects: PROJECTS, windows: WINDOWS },
    [
      { op: 'placementOfOpener', opener: null },
      { op: 'placementOfOpener' },
      { op: 'placementOfOpener', opener: { kind: 'home' } },
      { op: 'placementOfOpener', opener: { kind: 'home' }, homeId: null },
      { op: 'placementOfOpener', opener: { kind: 'home' }, homeId: 2 },
      { op: 'placementOfOpener', opener: { kind: 'window', webContentsId: 1 }, homeId: 2 },
      { op: 'placementOfOpener', opener: { kind: 'window', webContentsId: 4 } },
    ],
    DOC_FILES,
    'who opened it: nobody, the home ask with and without an id, a window',
  ),
  placerCase(
    {
      projects: { p1: '', p2: P },
      windows: { '1': { project: 'p1' }, '2': { project: '' }, '3': { project: 'p2' } },
    },
    [
      { op: 'placementFor', id: 1 },
      { op: 'placementFor', id: 2 },
      { op: 'placementFor', id: 3 },
      { op: 'saveDialogFolder', id: 3 },
    ],
    DOC_FILES,
    'an empty project id or root is none',
  ),
  placerCase(
    { projects: PROJECTS, windows: WINDOWS },
    [
      { op: 'saveDialogFolder', id: 1 },
      { op: 'saveDialogFolder', id: 2 },
      { op: 'saveDialogFolder', id: 5 },
      { op: 'saveDialogFolder', id: 6 },
      { op: 'saveDialogFolder', id: 4 },
    ],
    DOC_FILES,
    'the folder the save dialog opens in',
  ),
  placerCase(
    { projects: PROJECTS, windows: WINDOWS },
    [
      {
        op: 'preset',
        id: 3,
        placement: { projectId: 'p1', root: `${D}/proj2`, dir: `${D}/proj2` },
      },
      { op: 'placementFor', id: 3 },
      { op: 'presetProjectOf', id: 3 },
    ],
    DOC_FILES,
    'a preset of another project with the same root is not used',
  ),
]

function placerScenario(): FnSpec['ts'] {
  return onDisk(async ({ ctx, guard, log, toDir }, args) => {
    const [cfg, ops] = args as [Cfg, Any[]]
    const projects = cfg.projects ?? {}
    const windows = cfg.windows ?? {}
    const refuse = new Map(cfg.refuse ?? [])
    const placer = new newDocuments.NewDocumentPlacer({
      guide: {
        projectRoot: (id: string) => {
          log('projectRoot', id)
          return projects[id] ?? null
        },
        writeNewDocument: async (id: string, target: string, data: Uint8Array) => {
          log('write', id, target, data.length)
          const kind = refuse.get(target)
          if (kind === 'exists') throw new writeGuard.ProjectWriteRefused('exists', target)
          if (kind === 'bad-path') throw new writeGuard.ProjectWriteRefused('bad-path', target)
          if (kind === 'plain') throw new Error('the guide failed')
          const root = projects[id]
          if (root === undefined) throw new Error(`unknown project ${id}`)
          await guard.writeNewDocument(root, target, data)
          return { status: 'ok' as const }
        },
      },
      windowProject: async (id: number) => {
        log('windowProject', id)
        const window = windows[String(id)]
        if (window?.fail !== undefined) throw new Error(window.fail)
        return window?.project ?? null
      },
      documentOf: (id: number) => {
        log('documentOf', id)
        return windows[String(id)]?.doc ?? null
      },
      platform: platform(ctx.platform ?? process.platform),
    })
    const out: unknown[] = []
    for (const op of ops) {
      const entry: Record<string, unknown> = { op: op.op }
      try {
        let value: unknown
        if (op.op === 'placementFor') value = await placer.placementFor(op.id)
        else if (op.op === 'placementOfOpener') {
          value = await placer.placementOfOpener(op.opener, op.homeId ?? null)
        } else if (op.op === 'preset') {
          const placement =
            op.reject !== undefined
              ? Promise.reject(new Error(op.reject))
              : 'opener' in op
                ? placer.placementOfOpener(op.opener, op.homeId ?? null)
                : Promise.resolve(op.placement)
          placer.preset(op.id, placement)
          // the port takes the placement as settled
          await placement.then(
            () => undefined,
            () => undefined,
          )
        } else if (op.op === 'presetProjectOf') value = await placer.presetProjectOf(op.id)
        else if (op.op === 'forget') placer.forget(op.id)
        else if (op.op === 'saveDialogFolder') value = await placer.saveDialogFolder(op.id)
        else if (op.op === 'writeFor') {
          value = await placer.writeFor(op.id, op.fileName, Buffer.from(op.text, 'utf8'))
        } else if (op.op === 'write') {
          value = await placer.write(op.placement, op.fileName, Buffer.from(op.text, 'utf8'))
        } else throw new Error(`no such op ${op.op}`)
        if (value !== undefined) entry.value = value
      } catch (error) {
        const failure = error as { code?: unknown; message: string }
        entry.error = {
          code: typeof failure.code === 'string' ? failure.code : null,
          message: toDir(failure.message),
          refused: error instanceof writeGuard.ProjectWriteRefused,
          reason: error instanceof writeGuard.ProjectWriteRefused ? error.reason : null,
        }
      }
      out.push(entry)
    }
    return out
  })
}

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

const guardCall = (call: (guard: Run['guard'], args: Any[], run: Run) => unknown): FnSpec['ts'] =>
  onDisk((run, args) => call(run.guard, args, run))

/** what a change answers: the new text, or nothing to write */
type Changed = string | null | undefined | Promise<string | null | undefined>

/** the change a case describes, with `change` logged */
function changeOf(spec: Change, log: Run['log']): (current: string | null) => Changed {
  return (current) => {
    log('change', current)
    switch (spec.kind) {
      case 'set':
        return spec.text
      case 'null':
        return null
      case 'undefined':
        return undefined
      case 'append':
        return (current ?? '') + spec.text
      case 'throw':
        throw new Error(spec.message)
      case 'late':
        return Promise.resolve(spec.text)
    }
  }
}

export const guard: Group = {
  'context.INSTRUCTIONS_LIMIT_CHARS': constant(context.INSTRUCTIONS_LIMIT_CHARS),
  'context.cutAt': {
    ts: ([text, limit]) => context.cutAt(text as string, limit as number),
    cases: cutCases.map(([text, limit]) => ({ args: [text, limit] })),
  },
  'context.assembleTrustedContext': {
    ts: ([t, r, s, limit, memoryLimit]) =>
      context.assembleTrustedContext(
        t as never,
        r as never,
        s as never,
        (limit ?? undefined) as number | undefined,
        (memoryLimit ?? undefined) as number | undefined,
      ),
    cases: assembleCases,
  },

  'identity.classifyFolder': { ts: onDisk((_, [input]) => classify(input)), cases: classifyCases },
  'identity.rebaseOptOuts': {
    ts: ([s, id, oldRoot, newRoot, plat]) => {
      identity.rebaseOptOuts(
        s as never,
        id as string,
        oldRoot as string,
        newRoot as string,
        platform(plat),
      )
      return touched(s as SettingsIn)
    },
    cases: rebaseCases,
  },

  'selection.findPathKey': {
    ts: ([record, path, plat]) =>
      selection.findPathKey(record as Record<string, unknown>, path as string, platform(plat)),
    cases: pathKeyCases,
  },
  'selection.containerOf': {
    ts: ([docKey, s, plat]) => selection.containerOf(docKey as string, s as never, platform(plat)),
    cases: containerCases,
  },
  'selection.selectionFor': {
    ts: ([s, target, plat]) => selection.selectionFor(s as never, target as never, platform(plat)),
    cases: selectionForCases,
  },
  'selection.recordSelection': {
    ts: ([s, target, projectId, plat]) => {
      selection.recordSelection(
        s as never,
        target as never,
        projectId as string | null,
        platform(plat),
      )
      return touched(s as SettingsIn)
    },
    cases: recordSelectionCases,
  },
  'selection.recordOutsideChat': {
    ts: ([s, docKey, projectId, chatId, plat]) => {
      selection.recordOutsideChat(
        s as never,
        docKey as string,
        projectId as string,
        chatId as string,
        platform(plat),
      )
      return touched(s as SettingsIn)
    },
    cases: outsideChatCases,
  },
  'selection.dropFromList': {
    ts: ([s, id]) => {
      selection.dropFromList(s as never, id as string)
      return touched(s as SettingsIn)
    },
    cases: dropCases,
  },
  'selection.findUnregisteredProject': {
    ts: onDisk((_, [docKey, s, ctx]) => selection.findUnregisteredProject(docKey, s, ctx)),
    cases: unregisteredCases,
  },

  'write-guard.ProjectWriteRefused': {
    ts: onDisk((_, [reason, detail]) => {
      const error = new writeGuard.ProjectWriteRefused(reason, detail)
      return {
        name: error.name,
        reason: error.reason,
        message: error.message,
        isError: error instanceof Error,
      }
    }),
    cases: refusedErrorCases.map((c) => ({ ...c, args: [fsCtx(), ...c.args] })),
  },
  'write-guard.dataPath': {
    ts: guardCall((guard, [root, rel, dataDir]) => guard.dataPath(root, rel, dataDirOf(dataDir))),
    cases: dataPathCases,
  },
  'write-guard.writeData': {
    ts: guardCall((guard, [root, rel, data, dataDir]) =>
      guard.writeData(root, rel, dataOf(data), dataDirOf(dataDir)),
    ),
    cases: writeDataCases,
  },
  'write-guard.appendData': {
    ts: guardCall((guard, [root, rel, text, dataDir]) =>
      guard.appendData(root, rel, text, dataDirOf(dataDir)),
    ),
    cases: appendCases,
  },
  // the hard-link cases of `appendData` alone, for the Windows comparison
  'write-guard.appendData.hardLinks': {
    ts: guardCall((guard, [root, rel, text, dataDir]) =>
      guard.appendData(root, rel, text, dataDirOf(dataDir)),
    ),
    cases: [
      {
        args: [fsCtx(), P, 'c.jsonl', 'x'],
        files: proj({ [`${DATA}/c.jsonl`]: 'a' }),
        note: 'a file with one name',
      },
      {
        args: [fsCtx(), P, 'chats/c.jsonl', 'x'],
        files: proj({
          [`${DATA}/chats/c.jsonl`]: 'a',
          'proj/other.jsonl': { link: `${DATA}/chats/c.jsonl` },
        }),
        note: 'a file with a second name is refused',
      },
      {
        args: [fsCtx(), P, 'c.jsonl', 'x'],
        files: proj({ [`${DATA}/c.jsonl`]: 'a', 'outside.jsonl': { link: `${DATA}/c.jsonl` } }),
        note: 'the second name is outside the project',
      },
    ],
  },
  'write-guard.updateData': {
    ts: guardCall(async (guard, [root, rel, change, dataDir], run) =>
      guard.updateData(root, rel, changeOf(change as Change, run.log), dataDirOf(dataDir)),
    ),
    cases: updateCases,
  },
  'write-guard.removeData': {
    ts: guardCall((guard, [root, rel, dataDir]) => guard.removeData(root, rel, dataDirOf(dataDir))),
    cases: removeCases,
  },
  'write-guard.writeNewDocument': {
    ts: guardCall((guard, [root, target, data]) =>
      guard.writeNewDocument(root, target, bytesOf(data)),
    ),
    cases: newDocumentCases,
  },
  'write-guard.createProjectFolder': {
    ts: guardCall((guard, [parent, name]) => guard.createProjectFolder(parent, name)),
    cases: projectFolderCases,
  },

  'new-documents.NEW_DOCUMENT_NAME_ATTEMPTS': constant(newDocuments.NEW_DOCUMENT_NAME_ATTEMPTS),
  'new-documents.newDocumentFolder': {
    ts: ([root, docPath, plat]) =>
      newDocuments.newDocumentFolder(
        root as string,
        docPath as string | null | undefined,
        platform(plat),
      ),
    cases: folderCases,
  },
  'new-documents.isBareFileName': {
    ts: ([name]) => newDocuments.isBareFileName(name as string),
    cases: bareCases,
  },
  'new-documents.numberedFileName': {
    ts: ([name, n]) => newDocuments.numberedFileName(name as string, n as number),
    cases: numberedCases,
  },
  'new-documents.NewDocumentPlacer': { ts: placerScenario(), cases: placerCases },
}
