/**
 * Group `a/knowledge-base`: the `kb:*` channels of the shell entry
 * (`apps/shell/src/main/index.ts`) over `apps/shell/src/main/knowledge-base.ts`:
 * the run scopes, the starred corpus listing, search, paged reads and the one
 * write path of the ask panel.
 *
 * The shell entry starts the whole app when it is imported, so it is not
 * loaded. The `KbRunScopes` statement, the six `ipcMain.handle('kb:...')`
 * statements and `markdownDocxBytes` are taken from its source with the
 * TypeScript parser (each found exactly once), stripped of types, and run over
 * the names they use; so are `PROJECT_UNAVAILABLE`, `sanitizeFileBase` and
 * `uniquePathIn` from their own modules. `knowledge-base.ts` itself is the
 * real module, loaded afresh for each case.
 *
 * What the entry and that module reach beyond them is replaced by the world
 * the Rust `FakeKb` (crates/shell-ipc/a/src/probe/knowledge_base.rs) answers
 * from, `hosts.a.kb` (the table there): the file index, the unsaved-files
 * list, the parser, the project folder tools, the new-document placer, the
 * bundled CLI and the recent list. Each call is a line of the host log, named
 * as the Rust fake names it. The starred list is read from
 * userData/starred.json by the real `readStarredItems`.
 *
 * Two modules `knowledge-base.ts` imports are answered by a resolve hook
 * (`@seuoffice/electron-utils/unsaved-files`, `@seuoffice/file-parse`): stubs
 * whose functions forward to the world the group sets for each case. The
 * scopes are named `scope-1`, `scope-2`, ... as the probe's Rust side names
 * them (the real ones are random).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { dirname, extname, join } from 'node:path'
import { atomicWriteFile } from '../../../../apps/shell/src/main/atomic-write.ts'
import type * as KnowledgeBaseModule from '../../../../apps/shell/src/main/knowledge-base.ts'
import { readStarredItems, starredGroupMap } from '../../../../apps/docs/src/main/starred-files.ts'
import { UNSAVED_CHANGES_MESSAGE } from '../../../../packages/electron-utils/src/unsaved-files.ts'
import type { Call, Case, Group, View } from '../../types.ts'
import { entryStatements, runWith } from './lib/entry-source.ts'

const MODULE = 'apps/shell/src/main/knowledge-base.ts'
type KnowledgeBase = typeof KnowledgeBaseModule

/** a module's statements with `export` taken off, to run in the entry's scope */
const unexported = (file: string, starts: string[]): string =>
  entryStatements(file, starts).replace(/^export /gm, '')

const entryCode = [
  entryStatements('apps/shell/src/main/index.ts', [
    'const kbRunScopes =',
    "ipcMain.handle('kb:open-scope',",
    "ipcMain.handle('kb:close-scope',",
    "ipcMain.handle('kb:list',",
    "ipcMain.handle('kb:search',",
    "ipcMain.handle('kb:read',",
    "ipcMain.handle('kb:create-document',",
    'async function markdownDocxBytes(',
  ]),
  unexported('apps/shell/src/main/projects/project-tools.ts', [
    'export const PROJECT_UNAVAILABLE =',
  ]),
  unexported('apps/shell/src/main/mcp/tools/document-tools.ts', [
    'export function sanitizeFileBase(',
    'export function uniquePathIn(',
  ]),
].join('\n')

// ---- the world behind the two stubbed modules ---------------------------------------

const WORLD = Symbol.for('ipc-diff.a.knowledge-base')

interface Resolving {
  resolve(
    specifier: string,
    context: { parentURL?: string },
    next: (s: string, c: unknown) => unknown,
  ): unknown
  load(url: string, context: unknown, next: (u: string, c: unknown) => unknown): unknown
}
/** `module.registerHooks` is Node 22.15 and later; its types may be older than the runtime */
const { registerHooks } = nodeModule as unknown as { registerHooks(hooks: Resolving): unknown }

const stubs: Record<string, string> = {
  '@seuoffice/electron-utils/unsaved-files': [
    `const world = () => globalThis[Symbol.for('ipc-diff.a.knowledge-base')]`,
    `export const UNSAVED_CHANGES_MESSAGE = ${JSON.stringify(UNSAVED_CHANGES_MESSAGE)}`,
    `export const assertFileSaved = (...args) => world().assertFileSaved(...args)`,
    `export const withoutUnsavedFiles = (...args) => world().withoutUnsavedFiles(...args)`,
  ].join('\n'),
  '@seuoffice/file-parse': [
    `const world = () => globalThis[Symbol.for('ipc-diff.a.knowledge-base')]`,
    `export const attachableMaxBytes = (...args) => world().attachableMaxBytes(...args)`,
    `export const parseFileToText = (...args) => world().parseFileToText(...args)`,
  ].join('\n'),
}
const STUB_PREFIX = 'ipc-diff-a-kb:'

registerHooks({
  resolve(specifier, context, next) {
    // the loader writes the case's query of a fresh import as %3F
    if (
      specifier in stubs &&
      /\/apps\/shell\/src\/main\/knowledge-base\.ts(%3F|\?|$)/.test(context.parentURL ?? '')
    ) {
      return { url: STUB_PREFIX + encodeURIComponent(specifier), shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (!url.startsWith(STUB_PREFIX)) return next(url, context)
    return {
      format: 'module',
      source: stubs[decodeURIComponent(url.slice(STUB_PREFIX.length))],
      shortCircuit: true,
    }
  },
})

/** `hosts.a.kb` (the table in probe/knowledge_base.rs) */
interface Config {
  index?: {
    hits?: { path: string; name: string; ext: string; snippet?: string[] }[]
    stale?: string[]
  } | null
  unsaved?: string[]
  maxBytes?: Record<string, number | null>
  parsed?: ({ path: string } & Record<string, unknown>)[]
  projects?: Record<
    string,
    {
      available?: boolean
      visible?: string[]
      read?: ({ path: string } & Record<string, unknown>)[]
    }
  >
  placement?: { projectId?: string; root?: string; dir?: string; error?: string } | null
  writeError?: string
  defaultSaveDir?: string | { error: string }
  docxError?: string
}

/** by path, written as a table in the cases */
type Table = Record<string, Record<string, unknown>>

/** `Config` with the parser's answers and the project reads written as tables */
type KbInput = Omit<Config, 'parsed' | 'projects'> & {
  parsed?: Table
  projects?: Record<string, { available?: boolean; visible?: string[]; read?: Table }>
}

/** the conversion's temporary folder is named at random */
const outName = (out: string): string =>
  out.replace(/\/seuoffice-kb-docx-[^/]+\//, '/seuoffice-kb-docx-X/')

// ---- the cases ----------------------------------------------------------------------

const views: View[] = [
  { view: 1, window: 1, surface: 'Shell' },
  { view: 2, window: 2, surface: 'Docs' },
  { view: 3, window: 3, surface: 'Shell' },
]
const call = (view: number, channel: string, ...args: unknown[]): Call => ({
  channel,
  view,
  args,
})
const sh = (channel: string, ...args: unknown[]): Call => call(1, channel, ...args)
const dc = (channel: string, ...args: unknown[]): Call => call(2, channel, ...args)
const sh3 = (channel: string, ...args: unknown[]): Call => call(3, channel, ...args)
const undef = { $: 'u' }
const date = (v: number) => ({ $: 'd', v })

const open = (...args: unknown[]) => sh('kb:open-scope', ...args)
const list = (...args: unknown[]) => sh('kb:list', ...args)
const search = (...args: unknown[]) => sh('kb:search', ...args)
const read = (...args: unknown[]) => sh('kb:read', ...args)
const create = (...args: unknown[]) => sh('kb:create-document', ...args)
const inScope = (scope: unknown, rest: Record<string, unknown> = {}) => ({ scope, ...rest })

const F = (rel: string): string => `$DIR/docs/${rel}`
const LEASE = F('contracts/lease.docx')
const NDA = F('contracts/nda.txt')
const TODO = F('notes/todo.md')
const ARCHIVE = F('notes/Archive.tar.GZ')
const README = F('notes/README')
const HIDDEN = F('notes/.hidden')
const GONE = F('notes/gone.txt')
const NOTES_DIR = F('notes/sub')
const KO = F('ko.txt')
const BIG = F('big.txt')

const corpus: Record<string, string> = {
  'docs/contracts/lease.docx': 'lease',
  'docs/contracts/nda.txt': 'nda',
  'docs/notes/todo.md': '# todo\n',
  'docs/notes/Archive.tar.GZ': 'archive',
  'docs/notes/README': 'readme',
  'docs/notes/.hidden': 'hidden',
  'docs/notes/sub/inner.txt': 'inner',
  'docs/ko.txt': 'ko',
  'docs/big.txt': 'big',
}

const starredFile = (items: unknown) => ({ 'userData/starred.json': JSON.stringify(items) })
const items = [
  { path: LEASE, group: 'contracts' },
  { path: NDA, group: 'contracts' },
  { path: TODO, group: 'notes' },
  { path: README },
  { path: GONE, group: 'notes' },
  { path: NOTES_DIR },
  { path: ARCHIVE, group: 'notes' },
  { path: HIDDEN },
  { path: KO },
  { path: BIG },
]
const starred = { ...corpus, ...starredFile({ version: 1, items }) }

/** a table by path, as the list the case carries (an object's keys are not `$DIR`-replaced) */
const entries = (table: Table | undefined) =>
  table && Object.entries(table).map(([path, value]) => ({ path, ...value }))

const kb = (config: KbInput) => ({
  a: {
    kb: {
      ...config,
      parsed: entries(config.parsed),
      projects:
        config.projects &&
        Object.fromEntries(
          Object.entries(config.projects).map(([id, project]) => [
            id,
            { ...project, read: entries(project.read) },
          ]),
        ),
    },
  },
})

const hit = (path: string, name: string, ext: string, snippet?: string[]) => ({
  path,
  name,
  ext,
  ...(snippet ? { snippet } : {}),
})
const indexHits = [
  hit(LEASE, 'lease.docx', 'docx', ['the ', 'lease']),
  hit(F('other/stray.txt'), 'stray.txt', 'txt', ['not starred']),
  hit(NDA, 'nda.txt', 'txt', ['non-disclosure']),
  hit(LEASE, 'lease.docx', 'docx', ['the same file again']),
  hit(TODO, 'todo.md', 'md'),
  hit(ARCHIVE, 'Archive.tar.GZ', 'tar.gz', []),
  hit(README, 'README', '', ['read me']),
]

const PROJ = '$DIR/proj'
const projectHits = [
  hit(`${PROJ}/plan.txt`, 'plan.txt', 'txt', ['the plan']),
  hit(`${PROJ}/stale.txt`, 'stale.txt', 'txt', ['changed since the scan']),
  hit(`${PROJ}/unsaved.txt`, 'unsaved.txt', 'txt', ['being edited']),
  hit(`${PROJ}-hidden/x.txt`, 'x.txt', 'txt', ['a folder of another name']),
  hit(`${PROJ}/sub/deep.md`, 'deep.md', 'md', ['deep']),
]
const projectIndex = {
  hits: [...indexHits, ...projectHits],
  stale: [`${PROJ}/stale.txt`],
}
const projectWorld: KbInput = {
  index: projectIndex,
  unsaved: [`${PROJ}/unsaved.txt`, NDA],
  projects: {
    p1: {
      available: true,
      visible: [`${PROJ}/`],
      read: {
        [`${PROJ}/plan.txt`]: {
          status: 'ok',
          text: 'the plan, in full',
          totalChars: 17,
          offset: 0,
        },
        [`${PROJ}/cloud.txt`]: { status: 'declined' },
        [`${PROJ}/outside.txt`]: { status: 'refused', reason: 'outside' },
        [`${PROJ}/hidden.txt`]: { status: 'refused', reason: 'hidden' },
        [`${PROJ}/ignored.txt`]: { status: 'refused', reason: 'ignored' },
        [`${PROJ}/missing.txt`]: { status: 'refused', reason: 'not-found' },
        [`${PROJ}/unsaved.txt`]: { status: 'refused', reason: 'unsaved' },
        [`${PROJ}/large.txt`]: { status: 'refused', reason: 'too-large' },
        [`${PROJ}/large.big`]: { status: 'refused', reason: 'too-large' },
        [`${PROJ}/large.zip`]: { status: 'refused', reason: 'too-large' },
        [`${PROJ}/broken.txt`]: { status: 'refused', reason: 'unreadable' },
        [`${PROJ}/odd.txt`]: { status: 'refused', reason: 'a reason nobody lists' },
        [LEASE]: { status: 'ok', text: 'read as a project file', totalChars: 22, offset: 5 },
        [TODO]: { status: 'refused', reason: 'hidden' },
      },
    },
    p2: { available: true, read: {} },
  },
  maxBytes: { big: 80 * 1024 * 1024, zip: null },
  parsed: {
    [LEASE]: { ok: true, kind: 'text', text: 'the lease, read from the starred file' },
    [TODO]: { ok: true, kind: 'text', text: 'todo' },
  },
}

const manyPaths = Array.from({ length: 25 }, (_, i) => `$DIR/many/f${i + 1}.txt`)
const manyFiles = Object.fromEntries(
  manyPaths.slice(0, 9).map((p) => [p.replace('$DIR/', ''), `file ${p}`]),
)
const manyStarred = starredFile({ version: 1, items: manyPaths.map((path) => ({ path })) })
const manyHits = manyPaths.map((path, i) => hit(path, `f${i + 1}.txt`, 'txt', [`snippet ${i + 1}`]))
const manyParsed = Object.fromEntries(
  manyPaths
    .slice(0, 9)
    .map((p, i) => [p, { ok: true, kind: 'text', text: `text of file ${i + 1}` }]),
)

const alphabet = Array.from({ length: 60_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(
  '',
)

const defaultDir = { documents: { dir: true as const } }

const cases: Case[] = [
  // ---- the corpus listing and the starred store ----
  {
    note: 'list: every starred file that is still a file, in the starred order; a scope-less call of any shape lists all',
    views,
    files: starred,
    calls: [
      list(),
      call(2, 'kb:list'),
      list(null),
      list('a string'),
      list(inScope(undef)),
      list(inScope(undef, { other: 1 })),
    ],
  },
  {
    note: 'starred.json in the legacy flat shape: a bare path, an object, junk entries',
    views,
    files: {
      ...corpus,
      ...starredFile([
        LEASE,
        { path: NDA, group: 'x' },
        3,
        null,
        { path: 5 },
        [TODO],
        { group: 'g' },
      ]),
    },
    calls: [list(), open('x'), open('contracts')],
  },
  {
    note: 'groups are trimmed; blank and non-string ones mean ungrouped',
    views,
    files: {
      ...corpus,
      ...starredFile({
        version: 1,
        items: [
          { path: LEASE, group: ' work ' },
          { path: NDA, group: '   ' },
          { path: TODO, group: 7 },
          { path: README, group: 'work' },
          { path: KO },
        ],
      }),
    },
    calls: [
      open('work'),
      open(' work '),
      open(''),
      list(inScope('scope-1')),
      list(inScope('scope-1', { extra: true })),
    ],
  },
  {
    note: 'no starred.json: nothing listed, no group to open',
    views,
    files: corpus,
    calls: [list(), open('contracts'), open({ group: 'contracts' })],
  },
  {
    note: 'a corrupt starred.json, and one whose items is not a list',
    views,
    files: { ...corpus, 'userData/starred.json': '{oops' },
    calls: [list(), open('contracts')],
  },
  {
    note: 'items that is not a list reads as empty',
    views,
    files: { ...corpus, ...starredFile({ version: 1, items: { path: LEASE } }) },
    calls: [list()],
  },
  {
    note: 'the extension is what follows the first dot, lower case: a name with none has none',
    views,
    files: {
      ...corpus,
      ...starredFile([ARCHIVE, README, HIDDEN, LEASE, NOTES_DIR, GONE, '$DIR/docs/notes/']),
    },
    calls: [list()],
  },
  // ---- open-scope ----
  {
    note: 'a group scope narrows list to the group as the starred store has it now; a call without it lists all',
    views,
    files: starred,
    calls: [
      open('contracts'),
      open('notes'),
      list(inScope('scope-1')),
      list(inScope('scope-2')),
      list(),
    ],
  },
  {
    note: 'a group with no starred files, and values that are no group at all',
    views,
    files: starred,
    calls: [
      open('nothing'),
      open(5),
      open(null),
      open(),
      open(undef),
      open(['contracts']),
      open(true),
      open(''),
      open(date(0)),
      open({}),
      open({ group: null }),
      open({ group: undef }),
      open({ group: 'contracts' }),
      open({ projectId: '' }),
      open({ projectId: 5, group: 'notes' }),
      open({ projectId: ['p1'], group: 'notes' }),
      { channel: 'kb:open-scope', view: 1, args: [{ $: 'b', k: 'u8', i: 0 }], buffers: ['0102'] },
      open('contracts', 'a second argument'),
    ],
  },
  {
    note: 'a home ask with a project: the scope holds the project and every starred file, or one group',
    views,
    files: starred,
    hosts: kb(projectWorld),
    calls: [
      open({ projectId: 'p1' }),
      open({ projectId: 'p1', group: null }),
      open({ projectId: 'p1', group: 'notes' }),
      open({ projectId: 'p2', group: 'contracts' }),
      open({ projectId: 'p1', group: 'nothing' }),
      open({ projectId: 'p1', group: 5 }),
      open({ projectId: 'p1', group: '' }),
      open({ projectId: 'gone' }),
      open({ projectId: 'gone', group: 'nothing' }),
      list(inScope('scope-1')),
      list(inScope('scope-3')),
      list(inScope('scope-4')),
    ],
  },
  {
    note: 'only the scope the same view opened works; another window, the docs view or a wrong value is refused',
    views,
    files: starred,
    calls: [
      open('contracts'),
      sh3('kb:list', inScope('scope-1')),
      dc('kb:list', inScope('scope-1')),
      list(inScope('scope-9')),
      list(inScope(null)),
      list(inScope(5)),
      list(inScope('')),
      list(inScope(['scope-1'])),
      list(inScope({ id: 'scope-1' })),
      list(inScope('scope-1')),
    ],
  },
  {
    note: 'a view cannot close the scope of another; the owner can, and what it closed is refused',
    views,
    files: starred,
    calls: [
      open('contracts'),
      sh3('kb:close-scope', 'scope-1'),
      list(inScope('scope-1')),
      sh('kb:close-scope', 'scope-1'),
      list(inScope('scope-1')),
      sh('kb:close-scope', 'scope-1'),
      sh('kb:close-scope'),
      sh('kb:close-scope', 5),
      sh('kb:close-scope', null),
      sh('kb:close-scope', { scope: 'scope-1' }),
      sh('kb:close-scope', 'never opened'),
    ],
  },
  {
    note: 'main holds 16 scopes: the oldest is dropped past that, and then refused',
    views,
    files: starred,
    calls: [
      ...Array.from({ length: 17 }, () => open('contracts')),
      list(inScope('scope-1')),
      list(inScope('scope-2')),
      list(inScope('scope-17')),
      open('notes'),
      list(inScope('scope-2')),
      list(inScope('scope-3')),
    ],
  },
  // ---- search ----
  {
    note: 'search: the indexed hits that are starred, each file once, the excerpts joined; a file the index holds as it was on disk only',
    views,
    files: starred,
    hosts: kb({ index: { hits: indexHits, stale: [README] } }),
    calls: [
      search({ q: 'lease' }),
      search({ q: '  lease  ' }),
      call(2, 'kb:search', { q: 'lease' }),
    ],
  },
  {
    note: 'search without a usable query or an index answers nothing; the index is not asked',
    views,
    files: starred,
    hosts: kb({ index: { hits: indexHits } }),
    calls: [
      search({ q: '' }),
      search({ q: '   ' }),
      search({ q: 5 }),
      search({ limit: 3 }),
      search({}),
      search(),
      search(null),
      search('lease'),
      search(['lease']),
      search({ q: '\u00a0\ufeff' }),
    ],
  },
  {
    note: 'no file index at all: nothing is searched',
    views,
    files: starred,
    calls: [search({ q: 'lease' })],
  },
  {
    note: 'a long query is cut at 200 characters before the index sees it',
    views,
    files: starred,
    hosts: kb({ index: { hits: indexHits } }),
    calls: [search({ q: `  ${'x'.repeat(250)}  ` }), search({ q: `${'y'.repeat(199)}  z` })],
  },
  {
    note: 'limit: what Number() makes of it, at least 1, at most 20, 8 when it is no finite number',
    views,
    files: { ...starred, ...manyFiles, ...manyStarred },
    hosts: kb({ index: { hits: manyHits } }),
    calls: [
      search({ q: 'f' }),
      search({ q: 'f', limit: 3 }),
      search({ q: 'f', limit: '4' }),
      search({ q: 'f', limit: 0 }),
      search({ q: 'f', limit: -2 }),
      search({ q: 'f', limit: null }),
      search({ q: 'f', limit: true }),
      search({ q: 'f', limit: 'abc' }),
      search({ q: 'f', limit: undef }),
      search({ q: 'f', limit: 100 }),
      search({ q: 'f', limit: 21 }),
      search({ q: 'f', limit: 20.9 }),
      search({ q: 'f', limit: 7.9 }),
      search({ q: 'f', limit: [5] }),
      search({ q: 'f', limit: ['6'] }),
      search({ q: 'f', limit: [] }),
      search({ q: 'f', limit: [1, 2] }),
      search({ q: 'f', limit: {} }),
      search({ q: 'f', limit: date(7) }),
      search({ q: 'f', limit: '0x9' }),
      search({ q: 'f', limit: '1e1' }),
      search({ q: 'f', limit: '  12  ' }),
      search({ q: 'f', limit: '' }),
    ],
  },
  {
    note: 'a starred file open with unsaved changes is left out of the excerpts',
    views,
    files: starred,
    hosts: kb({ index: { hits: indexHits }, unsaved: [LEASE] }),
    calls: [search({ q: 'lease' })],
  },
  {
    note: 'a group scope searches its group only; a scope main does not hold is refused after the index was asked',
    views,
    files: starred,
    hosts: kb({ index: { hits: indexHits } }),
    calls: [
      open('contracts'),
      open('notes'),
      search({ q: 'lease', scope: 'scope-1' }),
      search({ q: 'lease', scope: 'scope-2' }),
      search({ q: 'lease' }),
      search({ q: 'lease', scope: 'scope-7' }),
      dc('kb:search', { q: 'lease', scope: 'scope-1' }),
    ],
  },
  {
    note: 'a project scope searches the project folder too: only visible files, indexed as on disk, not open unsaved',
    views,
    files: starred,
    hosts: kb(projectWorld),
    calls: [
      open({ projectId: 'p1' }),
      open({ projectId: 'p1', group: 'notes' }),
      open({ projectId: 'p2' }),
      search({ q: 'plan', scope: 'scope-1' }),
      search({ q: 'plan', scope: 'scope-2', limit: 2 }),
      search({ q: 'plan', scope: 'scope-3' }),
      search({ q: 'plan' }),
    ],
  },
  {
    note: 'a project that has no visible test any more searches the starred files alone',
    views,
    files: starred,
    hosts: kb({
      ...projectWorld,
      projects: { p1: { available: true }, p2: { available: true, visible: [] } },
    }),
    calls: [
      open({ projectId: 'p1' }),
      open({ projectId: 'p2' }),
      search({ q: 'plan', scope: 'scope-1' }),
      search({ q: 'plan', scope: 'scope-2' }),
    ],
  },
  // ---- read ----
  {
    note: 'read a starred file: a page of its text, from an offset as Number() and floor make it, the cache served the second time',
    views,
    files: starred,
    hosts: kb({
      parsed: { [LEASE]: { ok: true, kind: 'text', text: '0123456789abcdefghij' } },
    }),
    calls: [
      read({ path: LEASE }),
      read({ path: LEASE, offset: 0 }),
      read({ path: LEASE, offset: 5 }),
      read({ path: LEASE, offset: 19 }),
      read({ path: LEASE, offset: 20 }),
      read({ path: LEASE, offset: 100 }),
      read({ path: LEASE, offset: -3 }),
      read({ path: LEASE, offset: '4' }),
      read({ path: LEASE, offset: null }),
      read({ path: LEASE, offset: 'x' }),
      read({ path: LEASE, offset: 1.7 }),
      read({ path: LEASE, offset: [2] }),
      read({ path: LEASE, offset: true }),
      read({ path: LEASE, offset: date(3) }),
      read({ path: LEASE, offset: undef }),
      read({ path: LEASE, offset: {} }),
      read({ path: LEASE, offset: '1e1' }),
      call(2, 'kb:read', { path: LEASE, offset: 6 }),
    ],
  },
  {
    note: 'a long text is paged in 24000 characters; the reader knows the total',
    views,
    files: starred,
    hosts: kb({ parsed: { [BIG]: { ok: true, kind: 'text', text: alphabet } } }),
    calls: [
      read({ path: BIG }),
      read({ path: BIG, offset: 24000 }),
      read({ path: BIG, offset: 48000 }),
      read({ path: BIG, offset: 59999 }),
      read({ path: BIG, offset: 60000 }),
      read({ path: BIG, offset: 60001 }),
    ],
  },
  {
    note: 'offsets count UTF-16 units: Korean is one each, an emoji two',
    views,
    files: starred,
    hosts: kb({ parsed: { [KO]: { ok: true, kind: 'text', text: '한글🙂abc' } } }),
    calls: [
      read({ path: KO }),
      read({ path: KO, offset: 2 }),
      read({ path: KO, offset: 4 }),
      read({ path: KO, offset: 7 }),
    ],
  },
  {
    note: 'nine files read, the first one is parsed again; one that is read again at once is not',
    views,
    files: { ...starred, ...manyFiles, ...manyStarred },
    hosts: kb({ parsed: manyParsed }),
    calls: [
      ...manyPaths.slice(0, 9).map((path) => read({ path })),
      read({ path: manyPaths[8] }),
      read({ path: manyPaths[0] }),
      read({ path: manyPaths[1] }),
      read({ path: manyPaths[0] }),
    ],
  },
  {
    note: 'a path that is not starred, or no path, is outside the knowledge base',
    views,
    files: starred,
    hosts: kb({ parsed: { [LEASE]: { ok: true, kind: 'text', text: 'lease' } } }),
    calls: [
      read({ path: F('other/stray.txt') }),
      read({ path: '' }),
      read({ path: 5 }),
      read({}),
      read(),
      read(null),
      read(LEASE),
      read([LEASE]),
      read({ path: `${LEASE}/` }),
      read({ path: LEASE.toUpperCase() }),
    ],
  },
  {
    note: 'a starred file open with unsaved changes is not read, before the cache; a missing one fails at the disk',
    views,
    files: starred,
    hosts: kb({
      unsaved: [LEASE],
      parsed: {
        [NDA]: { ok: true, kind: 'text', text: 'nda' },
        [LEASE]: { ok: true, kind: 'text', text: 'lease' },
      },
    }),
    calls: [
      read({ path: LEASE }),
      read({ path: NDA }),
      read({ path: GONE }),
      read({ path: NOTES_DIR }),
    ],
  },
  {
    note: 'what the parser gives: its message, no text, a kind that is not text, empty text',
    views,
    files: starred,
    hosts: kb({
      parsed: {
        [LEASE]: { ok: false, error: 'the parser gave up' },
        [NDA]: { ok: true, kind: 'image' },
        [TODO]: { ok: true, kind: 'text' },
        [README]: { ok: true, kind: 'text', text: '' },
        [HIDDEN]: { ok: false, error: '' },
        [KO]: { ok: true, kind: 'text', text: null, error: 'text is null' },
      },
    }),
    calls: [
      read({ path: LEASE }),
      read({ path: NDA }),
      read({ path: TODO }),
      read({ path: README }),
      read({ path: HIDDEN }),
      read({ path: KO }),
      read({ path: ARCHIVE }),
    ],
  },
  {
    note: 'read under a scope: a group scope reads its group only, a refused scope is refused before anything is read',
    views,
    files: starred,
    hosts: kb(projectWorld),
    calls: [
      open('contracts'),
      read({ path: LEASE, scope: 'scope-1' }),
      read({ path: TODO, scope: 'scope-1' }),
      read({ path: LEASE, scope: 'scope-5' }),
      read({ path: '', scope: 'scope-5' }),
      dc('kb:read', { path: LEASE, scope: 'scope-1' }),
      sh3('kb:read', { path: LEASE, scope: 'scope-1' }),
    ],
  },
  {
    note: "read in a project scope: a starred file reads as before, anything else is the project folder's to decide",
    views,
    files: starred,
    hosts: kb(projectWorld),
    calls: [
      open({ projectId: 'p1' }),
      open({ projectId: 'p1', group: 'contracts' }),
      read({ path: `${PROJ}/plan.txt`, scope: 'scope-1' }),
      read({ path: `${PROJ}/plan.txt`, scope: 'scope-1', offset: 3.5 }),
      read({ path: LEASE, scope: 'scope-1' }),
      read({ path: LEASE, scope: 'scope-2' }),
      read({ path: TODO, scope: 'scope-2' }),
      read({ path: `${PROJ}/plan.txt`, scope: 'scope-2' }),
      read({ path: `${PROJ}/cloud.txt`, scope: 'scope-1' }),
      read({ path: `${PROJ}/nothing-said.txt`, scope: 'scope-1' }),
    ],
  },
  {
    note: "a project read that is refused: the reason decides the message; the size cap is the format's",
    views,
    files: starred,
    hosts: kb(projectWorld),
    calls: [
      open({ projectId: 'p1' }),
      ...['outside', 'hidden', 'ignored', 'missing', 'unsaved', 'large', 'broken', 'odd'].map(
        (name) => read({ path: `${PROJ}/${name}.txt`, scope: 'scope-1' }),
      ),
      read({ path: `${PROJ}/large.big`, scope: 'scope-1' }),
      read({ path: `${PROJ}/large.zip`, scope: 'scope-1' }),
    ],
  },
  // ---- create-document ----
  {
    note: 'create md: written to the default folder, a taken name gets -2, -3; the recent list is told',
    views,
    files: { ...defaultDir, 'documents/Report.md': 'taken', 'documents/Report-2.md': 'taken too' },
    hosts: kb({ defaultSaveDir: '$DIR/documents' }),
    calls: [
      create({ title: 'Report', format: 'md', content: '# Hello\n' }),
      create({ title: 'Report', format: 'md', content: 'again' }),
      create({ title: 'Fresh', format: 'md', content: '한글 🙂' }),
      create({ title: 'Fresh', format: 'md', content: 'and again' }),
    ],
  },
  {
    note: 'create docx: the bundled CLI is asked for the markdown, at the free path',
    views,
    files: { ...defaultDir, 'documents/Memo.docx': 'taken' },
    hosts: kb({ defaultSaveDir: '$DIR/documents' }),
    calls: [
      create({ title: 'Memo', format: 'docx', content: '# Memo\n\nBody' }),
      create({ title: 'Memo', format: 'docx', content: 'second' }),
    ],
  },
  {
    note: 'titles become file names: unsafe characters, length, dots and blanks',
    views,
    files: defaultDir,
    hosts: kb({ defaultSaveDir: '$DIR/documents' }),
    calls: [
      create({ format: 'md', content: 'no title' }),
      create({ title: '', format: 'md', content: 'empty title' }),
      create({ title: '   ', format: 'md', content: 'blank title' }),
      create({ title: 5, format: 'md', content: 'number title' }),
      create({ title: '..', format: 'md', content: 'dots' }),
      create({ title: ' . x . ', format: 'md', content: 'dotted' }),
      create({ title: '...x...', format: 'md', content: 'more dots' }),
      create({ title: 'a/b\\c:d*e?f"g<h>i|j', format: 'md', content: 'unsafe' }),
      create({ title: '\u0001x\u001f', format: 'md', content: 'control' }),
      create({ title: 'a'.repeat(100), format: 'md', content: 'long' }),
      create({ title: `  ${'b'.repeat(79)}  c`, format: 'md', content: 'cut then trimmed' }),
      create({ title: 'name.with.dots', format: 'md', content: 'inner dots' }),
      create({ title: '\u00a0nbsp\u00a0', format: 'md', content: 'nbsp' }),
      create({ title: '\ufeffbom\u3000', format: 'md', content: 'bom' }),
      create({ title: '제안서 최종', format: 'docx', content: '한글' }),
    ],
  },
  {
    note: 'a malformed request is refused with a message before anything is written',
    views,
    files: defaultDir,
    hosts: kb({ defaultSaveDir: '$DIR/documents' }),
    calls: [
      create(),
      create(null),
      create('x'),
      create(['md']),
      create({}),
      create({ format: 'pdf', content: 'x' }),
      create({ format: 'MD', content: 'x' }),
      create({ format: 'md' }),
      create({ format: 'md', content: '' }),
      create({ format: 'md', content: ' \n\t\u00a0\ufeff' }),
      create({ format: 'md', content: 5 }),
      create({ format: 'docx', content: ['x'] }),
      create({ format: 'md', content: 'a'.repeat(2_000_001) }),
      create({ format: 'md', content: '🙂'.repeat(1_000_001) }),
      dc('kb:create-document', { title: 'From docs', format: 'md', content: 'x' }),
    ],
  },
  {
    note: 'the default folder cannot be had: the error reaches the panel, nothing is recorded',
    views,
    files: defaultDir,
    hosts: kb({ defaultSaveDir: { error: 'no folder to save in' } }),
    calls: [create({ title: 'Lost', format: 'md', content: 'x' })],
  },
  {
    note: 'no default folder is named',
    views,
    calls: [create({ title: 'Lost', format: 'docx', content: 'x' })],
  },
  {
    note: 'the CLI fails: the error reaches the panel, nothing is recorded',
    views,
    files: defaultDir,
    hosts: kb({ defaultSaveDir: '$DIR/documents', docxError: 'the CLI is not there' }),
    calls: [create({ title: 'Lost', format: 'docx', content: 'x' })],
  },
  {
    note: 'a project chosen at home: md goes to its folder through the write guard; the guard picks the path',
    views,
    files: { proj: { dir: true as const } },
    hosts: kb({
      placement: { projectId: 'p1', root: PROJ, dir: `${PROJ}/Inbox` },
      defaultSaveDir: '$DIR/documents',
    }),
    calls: [
      create({ title: 'Plan', format: 'md', content: '# Plan\n' }),
      create({ title: 'Plan', format: 'md', content: 'the same name again' }),
    ],
  },
  {
    note: 'a project chosen at home: docx is made in a temporary folder first, then written by the guard; the folder is gone after',
    views,
    files: { proj: { dir: true as const }, temp: { dir: true as const } },
    hosts: kb({
      placement: { projectId: 'p1', root: PROJ, dir: PROJ },
    }),
    calls: [create({ title: 'Plan', format: 'docx', content: '# Plan\n' })],
  },
  {
    note: 'a project document: the CLI fails, and the temporary folder is still removed',
    views,
    files: { proj: { dir: true as const }, temp: { dir: true as const } },
    hosts: kb({
      placement: { projectId: 'p1', root: PROJ, dir: PROJ },
      docxError: 'no CLI',
    }),
    calls: [create({ title: 'Plan', format: 'docx', content: 'x' })],
  },
  {
    note: 'a project document: the write guard refuses, nothing goes elsewhere; so does a placement that throws',
    views,
    files: { proj: { dir: true as const }, documents: { dir: true as const } },
    hosts: kb({
      placement: { projectId: 'p1', root: PROJ, dir: PROJ },
      writeError: 'the folder is read-only',
      defaultSaveDir: '$DIR/documents',
    }),
    calls: [create({ title: 'Plan', format: 'md', content: 'x' })],
  },
  {
    note: 'the placement throws',
    views,
    hosts: kb({ placement: { error: 'the window is gone' }, defaultSaveDir: '$DIR/documents' }),
    calls: [create({ title: 'Plan', format: 'md', content: 'x' })],
  },
  {
    note: 'a request that fails to parse does not ask for the placement',
    views,
    hosts: kb({ placement: { error: 'asked' } }),
    calls: [create({ format: 'md', content: '' })],
  },
]

export const group: Group = {
  batch: 'A',
  async load(cx) {
    // the case's own hosts.a, as `Config` describes it
    const hostsA = (cx.case.hosts?.a ?? {}) as { kb?: Config }
    const config = hostsA.kb ?? {}
    const log = (...line: unknown[]): void => {
      cx.electron.log.push(line)
    }
    const unsaved = config.unsaved ?? []
    const projects = config.projects ?? {}
    const { app } = cx.electron as unknown as { app: { getPath(name: string): string } }
    const userData = app.getPath('userData')
    const temp = app.getPath('temp')
    const store = join(userData, 'starred.json')
    const mod = await cx.fresh<KnowledgeBase>(MODULE)

    ;(globalThis as Record<symbol, unknown>)[WORLD] = {
      async assertFileSaved(path: string): Promise<void> {
        log('withoutUnsavedFiles', [path])
        if (unsaved.includes(path)) throw new Error(UNSAVED_CHANGES_MESSAGE)
      },
      async withoutUnsavedFiles<T>(items: readonly T[], pathOf: (item: T) => string): Promise<T[]> {
        log('withoutUnsavedFiles', items.map(pathOf))
        return items.filter((item) => !unsaved.includes(pathOf(item)))
      },
      attachableMaxBytes(ext: string): number {
        log('attachableMaxBytes', ext)
        const key = ext.replace(/^\./, '').toLowerCase()
        const caps = config.maxBytes ?? {}
        if (Object.hasOwn(caps, key)) return caps[key] ?? Number.POSITIVE_INFINITY
        return 20 * 1024 * 1024
      },
      async parseFileToText(path: string): Promise<unknown> {
        log('parseFileToText', path)
        return config.parsed?.find((entry) => entry.path === path) ?? { ok: false }
      },
    }

    let minted = 0
    class Scopes extends mod.KbRunScopes {
      constructor() {
        super(() => `scope-${++minted}`)
      }
    }

    const index = config.index
    const fileIndexStore = index
      ? {
          search(
            q: string,
            options: { limit: number; within?: (path: string) => boolean },
          ): { hits: unknown[] } {
            log('fileIndexStore.search', q, options.limit, options.within !== undefined)
            const hits = (index.hits ?? [])
              .filter((h) => !options.within || options.within(h.path))
              .slice(0, options.limit)
              .map((h) => ({
                path: h.path,
                name: h.name,
                ext: h.ext,
                ...(h.snippet ? { snippet: h.snippet.map((text) => ({ text })) } : {}),
              }))
            return { hits }
          },
          pathsIndexedAsOnDisk(paths: readonly string[]): string[] {
            log('fileIndexStore.pathsIndexedAsOnDisk', [...paths])
            return paths.filter((path) => !(index.stale ?? []).includes(path))
          },
        }
      : null

    const projectFolderServices = () => ({
      tools: {
        async isAvailable(id: string): Promise<boolean> {
          log('projectFolderTools.isAvailable', id)
          return projects[id]?.available === true
        },
        async visibleTest(id: string): Promise<((path: string) => boolean) | null> {
          log('projectFolderTools.visibleTest', id)
          const visible = projects[id]?.visible
          return Array.isArray(visible)
            ? (path) => visible.some((prefix) => path.startsWith(prefix))
            : null
        },
        async readPath(owner: number, id: string, path: string, offset: number): Promise<unknown> {
          log('projectFolderTools.readPath', owner, id, path, offset)
          const found = projects[id]?.read?.find((entry) => entry.path === path)
          if (!found) return { status: 'refused', reason: 'outside' }
          const { path: _path, ...read } = found
          return read
        },
      },
    })

    const newDocuments = {
      async placementFor(id: number): Promise<unknown> {
        log('newDocuments.placementFor', id)
        const placement = config.placement
        if (placement && placement.error !== undefined) throw new Error(placement.error)
        return placement && typeof placement === 'object'
          ? { projectId: placement.projectId, root: placement.root, dir: placement.dir }
          : null
      },
      async write(
        placement: { projectId: string; root: string; dir: string },
        fileName: string,
        bytes: Uint8Array,
      ): Promise<string> {
        log(
          'newDocuments.write',
          placement.projectId,
          placement.root,
          placement.dir,
          fileName,
          Buffer.from(bytes).toString('utf8'),
        )
        if (config.writeError !== undefined) throw new Error(config.writeError)
        const path = join(placement.dir, fileName)
        mkdirSync(placement.dir, { recursive: true })
        writeFileSync(path, bytes)
        return path
      },
    }

    const defaultSaveDir = (): string => {
      log('defaultSaveDir')
      const dir = config.defaultSaveDir
      if (typeof dir === 'string') return dir
      if (dir && typeof dir.error === 'string') throw new Error(dir.error)
      throw new Error('no default save folder')
    }

    const createFileViaCli = async (
      _runner: unknown,
      request: { type: string; input: { name: string; content: string }; out: string },
    ): Promise<void> => {
      log(
        'createFileViaCli',
        request.type,
        request.input.name,
        request.input.content,
        outName(request.out),
      )
      if (config.docxError !== undefined) throw new Error(config.docxError)
      mkdirSync(dirname(request.out), { recursive: true })
      writeFileSync(request.out, `DOCX:${request.input.content}`)
    }

    runWith(entryCode, {
      ipcMain: cx.electron.ipcMain,
      KbRunScopes: Scopes,
      parseKbOpenScope: mod.parseKbOpenScope,
      listKnowledgeFiles: mod.listKnowledgeFiles,
      searchSavedKnowledgeWithProject: mod.searchSavedKnowledgeWithProject,
      readKnowledgeOrProjectPage: mod.readKnowledgeOrProjectPage,
      parseKbCreateRequest: mod.parseKbCreateRequest,
      createKnowledgeDocument: mod.createKnowledgeDocument,
      KB_NOT_IN_BASE: mod.KB_NOT_IN_BASE,
      // docs-main's readers over userData/starred.json
      readStarredFiles: () => readStarredItems(store).map((item) => item.path),
      readStarredGroupMap: () => starredGroupMap(readStarredItems(store)),
      fileIndexStore,
      ensureFileIndexer: () => ({
        refreshIfStale: (maxAgeMs: number) => log('fileIndexer.refreshIfStale', maxAgeMs),
      }),
      projectFolderServices,
      newDocuments,
      defaultSaveDir,
      atomicWriteFile,
      createFileViaCli,
      bundledCliRunner: () => ({}),
      recordRecentFile: (path: string) => log('recordRecentFile', path),
      // markdownDocxBytes works in the app's temporary folder
      mkdtempSync,
      readFileSync,
      rmSync,
      existsSync,
      extname,
      join,
      tmpdir: () => temp,
    })
  },
  cases,
  single: {
    'kb:close-scope':
      'it answers undefined whatever it is given; what it did shows in the calls after it',
  },
}
