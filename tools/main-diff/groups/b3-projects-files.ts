/**
 * Part `files` of group `b3-projects`: apps/shell/src/main/projects/
 * project-files.ts, project-index.ts, project-tools.ts and
 * project-dialog-text.ts, and the pieces of knowledge-base.ts and
 * file-parse's attachable.ts they call. The Rust side is
 * crates/main-core/src/calls/b3_projects/files.rs.
 *
 * Every collaborator a case names is a fake that logs each call as one line,
 * written the same on both sides:
 * - a resolver `{ answers?, fail? }`: `resolve paths`, then it rejects with
 *   `fail` or answers the `answers` (`path -> boolean`) as a Map;
 * - a lister `{ files?, fail? }` (`files`: relative names, each listed at
 *   `<root>/<name>` with mtime 1000): `list root`, then it rejects with
 *   `fail` or answers the files;
 * - a visibility `{ root, ignore?, fold?, ruleKey? }` is the guide's:
 *   `compileIgnore(ignore)` with `isAiVisiblePath` for `isVisible`.
 *
 * Names that are not an export of their file:
 * - `project-files.createCachedFileLister`: `[{ ttlMs? }, ops]`; an op is
 *   `{ vis, now, files?, fail? }` (one call of the lister, `now` the clock it
 *   reads: a number, or a list taken one per read) or `{ invalidate }`
 *   (`invalidate(root)`, `null` for none); answers `{ ok: relPaths }` or
 *   `{ error }` per op.
 * - `project-files.createContextFiles`: `[{ limit?, resolve?, list? }, vis]`.
 * - `project-index.projectFolderRoots`: `[dir, settingsText | null]`; the text
 *   is written to `<dir>/app-settings.json` first.
 * - `project-index.createProjectNameOnly`: `[{ roots, platform?, resolve? },
 *   batches]`; logs `roots` and the resolver's lines, answers one list per batch.
 * - `project-index.createRerankIgnoreFilter`: `[{ platform?, projects,
 *   fail? }, paths]`; a project is `{ id, path, missing?, ignore?, fold? }`;
 *   the guide logs `listProjects` and `aiVisibility id`.
 * - `project-tools.ProjectFolderTools`: a scenario `[cfg, ops]`, see `ToolsCfg`
 *   and `ToolOp`: the real `KbRunScopes` (scopes `scope-1`, ...), a fake guide,
 *   index store, resolvers, download question and open-file list, and the real
 *   `readKnowledgeFilePage` over the case's own `.txt`, `.md` and `.py` files.
 *   `$ROOT(name)` in a string of an op or of the config is the canonical path
 *   of `<dir>/<name>`.
 * - `project-dialog-text`: the dialogs take the language and the data; the
 *   `Intl` formatters are replaced for the call by deterministic ones, `mode`:
 *   `ok`, `numberThrows`, `dateThrows` or `bothThrow` (`n:<lang>:<number>` and
 *   `d:<lang>:<ISO time>:<dateStyle>/<timeStyle>`).
 *
 * Which functions need Electron: none, but paths.ts reaches agent-sessions.ts,
 * so the fake of electron-fake.ts is registered first.
 */
import '../electron-fake.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachableMaxBytes } from '../../../packages/file-parse/src/attachable.ts'
import { setOpenFilesSource } from '../../../packages/electron-utils/src/unsaved-files.ts'
import type { VisibleFile } from '../../../apps/shell/src/main/projects/project-files.ts'
import type { ProjectAiVisibility } from '../../../apps/shell/src/main/projects/project-guide.ts'
import type { Case, FileSpec, FnSpec, Group, TsContext } from '../types.ts'

// dynamic imports: electron-fake.ts registers its hooks when it runs, before these load
const projectFiles = await import('../../../apps/shell/src/main/projects/project-files.ts')
const projectIndex = await import('../../../apps/shell/src/main/projects/project-index.ts')
const projectTools = await import('../../../apps/shell/src/main/projects/project-tools.ts')
const dialogText = await import('../../../apps/shell/src/main/projects/project-dialog-text.ts')
const ignore = await import('../../../apps/shell/src/main/projects/ignore.ts')
const visibility = await import('../../../apps/shell/src/main/projects/visibility.ts')
const paths = await import('../../../apps/shell/src/main/projects/paths.ts')
const knowledgeBase = await import('../../../apps/shell/src/main/knowledge-base.ts')

type Platform = NodeJS.Platform

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))

/** a constant: its second case puts a file in the folder, so the two answers differ */
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
// fakes shared by the parts
// ---------------------------------------------------------------------------

interface VisCfg {
  root: string
  ignore?: string
  fold?: boolean
  ruleKey?: string
}

/** the guide's `aiVisibility` of one rule */
function makeVis(cfg: VisCfg): ProjectAiVisibility {
  const matcher = ignore.compileIgnore(cfg.ignore ?? '', { caseInsensitive: cfg.fold ?? false })
  return {
    root: cfg.root,
    matcher,
    isVisible: (rel: string, isDir = false) =>
      visibility.isAiVisiblePath(cfg.root, rel, matcher, isDir),
    ...(cfg.ruleKey === undefined ? {} : { ruleKey: cfg.ruleKey }),
  }
}

interface ResolverCfg {
  answers?: Record<string, boolean>
  fail?: string
}

function fakeResolver(cfg: ResolverCfg | null | undefined, cx: TsContext, label = 'resolve') {
  return async (given: readonly string[]): Promise<Map<string, boolean>> => {
    cx.log(label, [...given])
    if (cfg?.fail !== undefined) throw new Error(cfg.fail)
    return new Map(Object.entries(cfg?.answers ?? {}))
  }
}

/** a listed file as the lister answers it: the keys in the order `listVisibleFiles` writes them */
function vf(path: string, relPath: string, mtimeMs: number, cloudOnly = false): VisibleFile {
  const dot = relPath.lastIndexOf('.')
  return {
    path,
    relPath,
    ext: dot < 0 ? '' : relPath.slice(dot + 1).toLowerCase(),
    sizeBytes: 10,
    mtimeMs,
    cloudOnly,
  }
}

interface ListerCfg {
  files?: string[]
  fail?: string
}

function fakeLister(cfg: ListerCfg | null | undefined, cx: TsContext) {
  return async (vis: ProjectAiVisibility): Promise<VisibleFile[]> => {
    cx.log('list', vis.root)
    if (cfg?.fail !== undefined) throw new Error(cfg.fail)
    return (cfg?.files ?? []).map((name) => vf(`${vis.root}/${name}`, name, 1000))
  }
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
// project-files
// ---------------------------------------------------------------------------

const sec = (seconds: number): number => seconds * 1000

const TREE: Record<string, FileSpec> = {
  'p/a.docx': { text: 'A', mtimeMs: sec(3000) },
  'p/notes.txt': { text: 'hello', mtimeMs: sec(2000) },
  'p/REPORT.PDF': { text: '%PDF', mtimeMs: sec(4000) },
  'p/sub/b.md': { text: '# B', mtimeMs: sec(5000) },
  'p/sub/deep/c.txt': { text: 'c', mtimeMs: sec(5000) },
  'p/sub/data.bin': 'bin',
  'p/.hidden/x.docx': 'h',
  'p/.seuoffice/ignore': '*.log',
  'p/node_modules/m/x.docx': 'n',
  'p/~$lock.docx': 'lock',
  'p/secret/s.txt': { text: 's', mtimeMs: sec(1000) },
  'p/e\u0301.txt': { text: 'nfd', mtimeMs: sec(6000) },
}

const DEEP_DIR = Array.from({ length: 32 }, () => 'd').join('/')
const DEEP: Record<string, FileSpec> = {
  'p/top.txt': { text: 't', mtimeMs: sec(10) },
  [`p/${DEEP_DIR}/ok.txt`]: { text: 'ok', mtimeMs: sec(20) },
  [`p/${DEEP_DIR}/d/too.txt`]: { text: 'too deep', mtimeMs: sec(30) },
}

const P: VisCfg = { root: '$DIR/p' }
const withIgnore = (text: string, fold = false): VisCfg => ({ root: '$DIR/p', ignore: text, fold })

const LIST_CASES: Case[] = [
  { args: [P], files: TREE, note: 'every kind of entry: hidden, junk, unsupported, nfd name' },
  { args: [withIgnore('*.md\nsecret/')], files: TREE, note: 'ignore: a pattern and a folder' },
  { args: [withIgnore('A.DOCX', true)], files: TREE, note: 'ignore folds case' },
  { args: [withIgnore('A.DOCX', false)], files: TREE, note: 'ignore keeps case' },
  { args: [P], note: 'the folder is not there' },
  { args: [P], files: { 'p/x.bin': 'x' }, note: 'nothing supported' },
  { args: [P], files: DEEP, note: 'depth: 32 folders are walked, the 33rd is not' },
  {
    args: [P],
    files: {
      'p/b.txt': { text: 'a', mtimeMs: sec(7) },
      'p/a.txt': { text: 'b', mtimeMs: sec(7) },
      'p/B2.txt': { text: 'c', mtimeMs: sec(7) },
      'p/z.txt': { text: 'c', mtimeMs: sec(7) },
      'p/a1.txt': { text: 'd', mtimeMs: sec(8) },
      'p/dir/z.txt': { text: 'e', mtimeMs: sec(7) },
    },
    note: 'equal times are ordered by path',
  },
]

const IGNORED_CASES: Case[] = [
  {
    args: [withIgnore('*.md\nsecret/\n*.docx')],
    files: TREE,
    note: 'what ignore keeps from the AI, newest first',
  },
  { args: [P], files: TREE, note: 'no ignore: nothing' },
  {
    args: [withIgnore('*')],
    files: TREE,
    note: 'everything matches: hidden entries stay out',
  },
  { args: [withIgnore('A.DOCX', true)], files: TREE, note: 'case folded' },
  { args: [withIgnore('A.DOCX', false)], files: TREE, note: 'case kept' },
  { args: [P], note: 'no folder' },
]

const FILES_JSON = [
  vf('/p/a.docx', 'a.docx', 3000),
  vf('/p/b.md', 'b.md', 2000),
  vf('/p/sub/c.txt', 'sub/c.txt', 1000, true),
]

const CLOUD_CASES: Case[] = [
  { args: [[], {}], note: 'no file: no detector run' },
  {
    args: [FILES_JSON, { answers: { '/p/a.docx': true, '/p/b.md': false } }],
    note: 'a verdict each; a file without one is not on this PC',
  },
  { args: [FILES_JSON, { fail: 'detector down' }], note: 'a failed detector marks every file' },
  { args: [FILES_JSON.slice(0, 1), { answers: { '/p/a.docx': false } }], note: 'local' },
]

const ENTRY_CASES: Case[] = cases([FILES_JSON[0]], [FILES_JSON[2]], [vf('/x/Y.TXT', 'Y.TXT', 5.5)])

const MENTION_CASES: Case[] = [
  { args: [P, null, null], files: TREE, note: 'the default limit, the default walk' },
  { args: [P, 2, null], files: TREE, note: 'a limit' },
  { args: [P, 0, null], files: TREE, note: 'limit 0' },
  { args: [P, -1, null], files: TREE, note: 'a negative limit slices from the end' },
  { args: [P, 1.5, null], files: TREE, note: 'a fractional limit' },
  { args: [P, null, { files: ['x.docx', 'sub/y.md'] }], note: 'a lister' },
  { args: [P, null, { files: [] }], note: 'a lister with no file' },
  { args: [P, null, { fail: 'walk failed' }], note: 'a lister that fails' },
  {
    args: [P, 60, { files: Array.from({ length: 55 }, (_, i) => `f${i}.txt`) }],
    note: 'a limit past the default',
  },
  {
    args: [P, null, { files: Array.from({ length: 55 }, (_, i) => `f${i}.txt`) }],
    note: 'the default limit cuts',
  },
]

const CONTEXT_CASES: Case[] = [
  { args: [{ resolve: { answers: {} } }, P], files: TREE, note: 'real walk, none answered' },
  {
    args: [{ limit: 2, resolve: { answers: {} }, list: { files: ['a.docx', 'b.md', 'c.txt'] } }, P],
    note: 'omitted past the limit',
  },
  {
    args: [{ resolve: { fail: 'detector down' }, list: { files: ['a.docx', 'b.md'] } }, P],
    note: 'a failed detector marks every file',
  },
  { args: [{ resolve: {}, list: { files: [] } }, P], note: 'no file, no detector run' },
  {
    args: [{ limit: 0, resolve: {}, list: { files: ['a.docx'] } }, P],
    note: 'limit 0: all omitted',
  },
  { args: [{ resolve: {}, list: { fail: 'walk failed' } }, P], note: 'a walk that fails' },
  {
    args: [
      {
        resolve: { answers: { '$DIR/p/a.docx': false } },
        list: { files: ['a.docx', 'b.md'] },
      },
      P,
    ],
    note: 'one file is local',
  },
  {
    args: [{ limit: -1, resolve: {}, list: { files: ['a.docx', 'b.md', 'c.txt'] } }, P],
    note: 'a negative limit slices from the end',
  },
  {
    args: [{ resolve: {}, list: { files: Array.from({ length: 502 }, (_, i) => `f${i}.txt`) } }, P],
    note: 'the default limit of 500 files',
  },
]

interface CacheOp {
  vis: VisCfg
  now: number | number[]
  files?: string[]
  fail?: string
  invalidate?: undefined
}
interface InvalidateOp {
  invalidate: string | null
}

async function runCachedLister(
  cfg: { ttlMs?: number },
  ops: (CacheOp | InvalidateOp)[],
  cx: TsContext,
): Promise<unknown[]> {
  let current: CacheOp = { vis: P, now: 0 }
  let queue: number[] = []
  let last = 0
  const lister = projectFiles.createCachedFileLister({
    ...(cfg.ttlMs === undefined ? {} : { ttlMs: cfg.ttlMs }),
    now: () => {
      last = queue.shift() ?? last
      return last
    },
    list: fakeLister(
      {
        get files() {
          return current.files
        },
        get fail() {
          return current.fail
        },
      },
      cx,
    ),
  })
  const out: unknown[] = []
  for (const op of ops) {
    if ('invalidate' in op && op.invalidate !== undefined) {
      lister.invalidate(op.invalidate ?? undefined)
      out.push({ invalidated: op.invalidate })
      continue
    }
    if ('invalidate' in op) {
      lister.invalidate()
      out.push({ invalidated: null })
      continue
    }
    current = op as CacheOp
    queue = Array.isArray(current.now) ? [...current.now] : [current.now]
    out.push(
      await settle(async () => (await lister(makeVis(current.vis))).map((file) => file.relPath)),
    )
  }
  return out
}

const KEYED: VisCfg = { root: '/proj/a', ruleKey: 'k1' }
const KEYED2: VisCfg = { root: '/proj/a', ruleKey: 'k2' }
const OTHER: VisCfg = { root: '/proj/b', ruleKey: 'k1' }
const UNKEYED: VisCfg = { root: '/proj/a' }

const CACHED_CASES: Case[] = [
  { args: [{}, []], note: 'no operation' },
  {
    args: [
      {},
      [
        { vis: KEYED, now: 1000, files: ['a.txt'] },
        { vis: KEYED, now: 1000 + 4999, files: ['changed.txt'] },
        { vis: KEYED, now: 1000 + 5000, files: ['b.txt'] },
        { vis: KEYED, now: 1000 + 5000 + 4999, files: ['c.txt'] },
      ],
    ],
    note: 'a miss, a hit just inside the time, an expiry exactly at it, a hit again',
  },
  {
    args: [
      { ttlMs: 10 },
      [
        { vis: KEYED, now: 100, files: ['a.txt'] },
        { vis: KEYED, now: 109, files: ['x.txt'] },
        { vis: KEYED, now: 110, files: ['b.txt'] },
      ],
    ],
    note: 'a time of its own',
  },
  {
    args: [
      {},
      [
        { vis: UNKEYED, now: 0, files: ['a.txt'] },
        { vis: UNKEYED, now: 0, files: ['b.txt'] },
      ],
    ],
    note: 'a visibility without a rule key is never cached',
  },
  {
    args: [
      {},
      [
        { vis: KEYED, now: 0, files: ['a.txt'] },
        { vis: KEYED2, now: 1, files: ['b.txt'] },
        { vis: OTHER, now: 2, files: ['c.txt'] },
        { vis: KEYED, now: 3, files: ['x.txt'] },
      ],
    ],
    note: 'the key is the root and the rule: an edit is a new key',
  },
  {
    args: [
      {},
      [
        { vis: KEYED, now: 0, fail: 'walk failed' },
        { vis: KEYED, now: 1, files: ['a.txt'] },
        { vis: KEYED, now: 2, files: ['x.txt'] },
      ],
    ],
    note: 'a failed walk is not kept',
  },
  {
    args: [
      {},
      [
        { vis: KEYED, now: 0, files: ['a.txt'] },
        { vis: OTHER, now: 1, files: ['b.txt'] },
        { invalidate: '/proj/a' },
        { vis: KEYED, now: 2, files: ['a2.txt'] },
        { vis: OTHER, now: 3, files: ['x.txt'] },
        { invalidate: null },
        { vis: OTHER, now: 4, files: ['b2.txt'] },
      ],
    ],
    note: 'invalidate one root, then every root',
  },
  {
    args: [
      { ttlMs: 0 },
      [
        { vis: KEYED, now: 5, files: ['a.txt'] },
        { vis: KEYED, now: 5, files: ['b.txt'] },
      ],
    ],
    note: 'ttl 0: every call walks',
  },
  {
    args: [
      {},
      [
        { vis: KEYED, now: 0, files: ['a.txt'] },
        { vis: OTHER, now: 6000, files: ['b.txt'] },
        { vis: KEYED, now: 6001, files: ['c.txt'] },
      ],
    ],
    note: 'a call forgets every walk past the time, not only its own',
  },
]

// ---------------------------------------------------------------------------
// project-index
// ---------------------------------------------------------------------------

const SETTINGS_DIRS: Record<string, FileSpec> = {
  'one/x': { dir: true },
  'two/y': { dir: true },
  'file.txt': 'not a folder',
}

const settingsText = (entries: { id: string; path: string }[]): string =>
  JSON.stringify({
    projects: {
      list: entries.map((e) => ({ ...e, pinned: false, lastUsedAt: '2026-01-01T00:00:00.000Z' })),
    },
  })

const ROOTS_CASES: Case[] = [
  {
    args: [
      '$DIR',
      settingsText([
        { id: 'a', path: '$DIR/one' },
        { id: 'b', path: '$DIR/two' },
      ]),
    ],
    files: SETTINGS_DIRS,
    note: 'both folders exist',
  },
  {
    args: [
      '$DIR',
      settingsText([
        { id: 'a', path: '$DIR/one' },
        { id: 'gone', path: '$DIR/nowhere' },
        { id: 'f', path: '$DIR/file.txt' },
        { id: 'b', path: '$DIR/two' },
      ]),
    ],
    files: SETTINGS_DIRS,
    note: 'a missing folder and a file are not walked, the order is the list order',
  },
  { args: ['$DIR', null], note: 'no settings file' },
  { args: ['$DIR', '{"projects":{"list":"x"}}'], note: 'a malformed list' },
  { args: ['$DIR', settingsText([{ id: 'r', path: 'relative/dir' }])], note: 'a relative path' },
]

const MERGE_CASES: Case[] = cases(
  [['/home/me/docs'], ['/home/me/docs/proj', '/work/p1', '/work/p1', '/work/p2'], 'linux'],
  [['/home/me/Docs'], ['/home/me/docs/proj'], 'linux'],
  [['/home/me/Docs'], ['/home/me/docs/proj'], 'darwin'],
  [[], ['/a', '/a/b', '/c'], 'linux'],
  [['C:\\Users\\me'], ['c:\\users\\me\\p', 'D:\\p'], 'win32'],
  [['/a'], [], 'linux'],
  [['/a/b'], ['/a'], 'linux'],
)

interface NameOnlyCfg {
  roots: string[]
  platform?: Platform
  resolve?: ResolverCfg
}

async function runNameOnly(
  cfg: NameOnlyCfg,
  batches: string[][],
  cx: TsContext,
): Promise<unknown[]> {
  const nameOnly = projectIndex.createProjectNameOnly({
    projectRoots: () => {
      cx.log('roots')
      return cfg.roots
    },
    resolveCloudOnly: fakeResolver(cfg.resolve, cx),
    ...(cfg.platform === undefined ? {} : { platform: cfg.platform }),
  })
  const out: unknown[] = []
  for (const batch of batches) out.push(await settle(async () => [...(await nameOnly(batch))]))
  return out
}

const NAME_ONLY_CASES: Case[] = [
  { args: [{ roots: [] }, [['/a/x.docx']]], note: 'no project folder: nothing asked' },
  {
    args: [
      {
        roots: ['/work/p'],
        platform: 'linux',
        resolve: { answers: { '/work/p/a.docx': true, '/work/p/b.docx': false } },
      },
      [['/work/p/a.docx', '/work/p/b.docx', '/other/c.docx']],
    ],
    note: 'cloud-only and local inside a project; a path outside stays out',
  },
  {
    args: [
      { roots: ['/work/p'], platform: 'linux', resolve: { answers: {} } },
      [['/other/c.docx'], ['/work/p/a.docx', '/work/p/a.docx']],
    ],
    note: 'no path inside: no detector run; an undecided path is name-only, once',
  },
  {
    args: [
      { roots: ['/work/p'], platform: 'linux', resolve: { fail: 'detector down' } },
      [['/work/p/a.docx', '/other/b.docx', '/work/p/sub/c.docx']],
    ],
    note: 'a failed detector leaves every project path name-only',
  },
  {
    args: [
      { roots: ['C:\\Work\\P'], platform: 'win32', resolve: { answers: {} } },
      [['c:\\work\\p\\a.docx']],
    ],
    note: 'win32 folds case',
  },
  {
    args: [
      { roots: ['/work/P'], platform: 'linux', resolve: { answers: {} } },
      [['/work/p/a.docx']],
    ],
    note: 'linux keeps case',
  },
  {
    args: [
      { roots: ['/work/p'], platform: 'linux', resolve: { answers: { '/work/p': false } } },
      [['/work/p'], ['/work/p2/a.docx']],
    ],
    note: 'the folder itself is inside; a sibling with the same prefix is not',
  },
]

interface RerankCfg {
  platform?: Platform
  projects: { id: string; path: string; missing?: boolean; ignore?: string; fold?: boolean }[]
  fail?: string
}

async function runRerank(cfg: RerankCfg, given: string[], cx: TsContext): Promise<unknown> {
  const filter = projectIndex.createRerankIgnoreFilter({
    guide: {
      listProjects: async () => {
        cx.log('listProjects')
        return cfg.projects.map((p) => ({
          id: p.id,
          name: p.id,
          path: p.path,
          pinned: false,
          lastUsedAt: '2026-01-01T00:00:00.000Z',
          missing: p.missing ?? false,
          unwritable: false,
          syncFolder: false,
        }))
      },
      aiVisibility: async (id: string) => {
        cx.log('aiVisibility', id)
        if (cfg.fail === id) throw new Error('guide failed')
        const p = cfg.projects.find((q) => q.id === id)
        if (!p) return null
        return makeVis({ root: p.path, ignore: p.ignore ?? '', fold: p.fold ?? false })
      },
    },
    ...(cfg.platform === undefined ? {} : { platform: cfg.platform }),
  })
  return settle(() => filter(given))
}

const RERANK_CASES: Case[] = [
  {
    args: [{ platform: 'linux', projects: [] }, ['/a/x.docx', '/b/y.docx']],
    note: 'no project: every path passes',
  },
  {
    args: [
      {
        platform: 'linux',
        projects: [{ id: 'p1', path: '/work/p', ignore: '*.secret\nprivate/' }],
      },
      ['/work/p/a.docx', '/work/p/x.secret', '/work/p/private/b.docx', '/other/x.secret'],
    ],
    note: 'what ignore matches is dropped; a path outside every project passes',
  },
  {
    args: [
      {
        platform: 'linux',
        projects: [
          { id: 'p1', path: '/work/p', ignore: '*.secret' },
          { id: 'p2', path: '/work/q', ignore: '*.docx' },
          { id: 'p3', path: '/work/r', missing: true, ignore: '*' },
        ],
      },
      ['/work/p/a.secret', '/work/p/b.docx', '/work/q/c.docx', '/work/q/d.txt', '/work/r/e.txt'],
    ],
    note: 'each project its own rule; a missing project is left alone',
  },
  {
    args: [
      { platform: 'linux', projects: [{ id: 'p1', path: '/work/p', ignore: '*.secret' }] },
      ['/elsewhere/a.secret'],
    ],
    note: 'no project holds a path: the guide is not asked for a rule',
  },
  {
    args: [
      {
        platform: 'linux',
        fail: 'p2',
        projects: [
          { id: 'p1', path: '/work/p', ignore: '*.secret' },
          { id: 'p2', path: '/work/q', ignore: '*.docx' },
        ],
      },
      ['/work/p/a.secret', '/work/q/b.docx'],
    ],
    note: 'a rule that cannot be read fails the call, every project asked',
  },
  {
    args: [
      {
        platform: 'win32',
        projects: [{ id: 'p1', path: 'C:\\Work\\P', ignore: 'a.docx', fold: true }],
      },
      ['c:\\work\\p\\A.DOCX', 'c:\\work\\p\\sub\\a.docx', 'c:\\work\\p\\b.docx'],
    ],
    note: 'win32 folds case, here and in the rule',
  },
  {
    args: [
      { platform: 'darwin', projects: [{ id: 'p1', path: '/Work/P', ignore: '/a.docx' }] },
      ['/work/p/a.docx', '/work/p/sub/a.docx'],
    ],
    note: 'an anchored rule on darwin',
  },
]

// ---------------------------------------------------------------------------
// project-tools
// ---------------------------------------------------------------------------

interface ToolsCfg {
  /** the case's folder, `$DIR` */
  dir: string
  platform: Platform
  /** project id -> its folder under `dir` and its rule; `fails` makes the guide throw */
  projects: Record<
    string,
    { dir: string; ignore?: string; fold?: boolean; ruleKey?: string; fails?: boolean }
  >
  /** the index: rows it holds, the paths it says are indexed as on disk; null = unavailable */
  store: null | {
    rows: {
      path: string
      name: string
      ext: string
      mtimeMs: number
      snippet: string[] | null
    }[]
    indexed: string[]
    ignoreWithin?: boolean
  }
  cloud: ResolverCfg
  listCloud: ResolverCfg | null
  ask: boolean | 'throws'
  /** the open files with unsaved changes: their paths; `throws`; or `{ after, paths }`: none for the first `after` questions */
  open: null | string[] | 'throws' | { after: number; paths: string[] }
}

type ToolOp =
  | { op: 'openScope'; owner: number; raw: unknown }
  | { op: 'closeScope'; owner: number; raw: unknown }
  | { op: 'isAvailable'; projectId: unknown }
  | { op: 'listFiles'; owner: number; raw: unknown }
  | { op: 'search'; owner: number; raw: unknown }
  | { op: 'read'; owner: number; raw: unknown }
  | { op: 'readPath'; owner: number; projectId: string; path: string; offset: number }
  | { op: 'visibleTest'; projectId: string; paths: string[] }
  | { op: 'removeProject'; id: string }

async function runTools(cfg: ToolsCfg, ops: ToolOp[], cx: TsContext): Promise<unknown[]> {
  const rootOf = (name: string): string => paths.canonicalPath(join(cfg.dir, name))
  const expand = (value: unknown): unknown => {
    if (typeof value === 'string')
      return value.replace(/\$ROOT\((\w+)\)/g, (_, name: string) => rootOf(name))
    if (Array.isArray(value)) return value.map(expand)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [expand(k) as string, expand(v)]),
      )
    return value
  }
  const projects = { ...cfg.projects }
  let counter = 0
  const scopes = new knowledgeBase.KbRunScopes(() => `scope-${++counter}`)
  const guide = {
    aiVisibility: async (id: string) => {
      cx.log('aiVisibility', id)
      if (!Object.hasOwn(projects, id)) return null
      const p = projects[id]!
      if (p.fails) throw new Error('guide failed')
      return makeVis({
        root: rootOf(p.dir),
        ignore: p.ignore ?? '',
        fold: p.fold ?? false,
        ...(p.ruleKey === undefined ? {} : { ruleKey: p.ruleKey }),
      })
    },
  }
  const rows = cfg.store ? (expand(cfg.store.rows) as NonNullable<ToolsCfg['store']>['rows']) : []
  const indexed = cfg.store ? (expand(cfg.store.indexed) as string[]) : []
  const store = () =>
    cfg.store === null
      ? null
      : {
          search: (
            query: string,
            opts: {
              offset?: number
              limit?: number
              exts?: readonly string[]
              within?: (path: string) => boolean
            },
          ) => {
            cx.log('search', query, {
              offset: opts.offset,
              limit: opts.limit,
              ...(opts.exts ? { exts: [...opts.exts] } : {}),
            })
            const kept = rows.filter(
              (row) =>
                (!opts.exts || opts.exts.includes(row.ext)) &&
                (cfg.store?.ignoreWithin || opts.within!(row.path)),
            )
            const offset = opts.offset ?? 0
            return {
              hits: kept.slice(offset, offset + (opts.limit ?? 20)).map((row) => ({
                path: row.path,
                name: row.name,
                ext: row.ext,
                mtimeMs: row.mtimeMs,
                sizeBytes: 0,
                snippet: row.snippet === null ? null : row.snippet.map((text) => ({ text })),
                needles: [],
              })),
              total: kept.length,
            }
          },
          pathsIndexedAsOnDisk: (given: readonly string[]) => {
            cx.log('indexed', [...given])
            return given.filter((path) => indexed.includes(path))
          },
        }
  const tools = new projectTools.ProjectFolderTools({
    guide,
    scopes,
    store: store as never,
    resolveCloudOnly: fakeResolver(expandResolver(cfg.cloud, expand), cx),
    ...(cfg.listCloud === null
      ? {}
      : { listCloudOnly: fakeResolver(expandResolver(cfg.listCloud, expand), cx, 'list-resolve') }),
    askDownload: async (ask) => {
      cx.log('ask', ask)
      if (cfg.ask === 'throws') throw new Error('ask failed')
      return cfg.ask
    },
    platform: cfg.platform,
  })
  const open = cfg.open === null ? null : (expand(cfg.open) as NonNullable<ToolsCfg['open']>)
  let questions = 0
  setOpenFilesSource(
    open === null
      ? null
      : open === 'throws'
        ? () => {
            throw new Error('open files failed')
          }
        : () => {
            const list = Array.isArray(open)
              ? open
              : (questions++, questions > open.after ? open.paths : [])
            return list.map((filePath) => ({ filePath, dirty: true }))
          },
  )
  const out: unknown[] = []
  try {
    for (const raw of ops) {
      const op = expand(raw) as ToolOp
      switch (op.op) {
        case 'openScope':
          out.push(await settle(() => tools.openScope(op.owner, op.raw)))
          break
        case 'closeScope':
          out.push(await settle(() => tools.closeScope(op.owner, op.raw)))
          break
        case 'isAvailable':
          out.push(await settle(() => tools.isAvailable(op.projectId)))
          break
        case 'listFiles':
          out.push(await settle(() => tools.listFiles(op.owner, op.raw)))
          break
        case 'search':
          out.push(await settle(() => tools.search(op.owner, op.raw)))
          break
        case 'read':
          out.push(await settle(() => tools.read(op.owner, op.raw)))
          break
        case 'readPath':
          out.push(await settle(() => tools.readPath(op.owner, op.projectId, op.path, op.offset)))
          break
        case 'visibleTest':
          out.push(
            await settle(async () => {
              const test = await tools.visibleTest(op.projectId)
              return test === null ? null : op.paths.map((path) => test(path))
            }),
          )
          break
        case 'removeProject':
          delete projects[op.id]
          out.push({ ok: null })
          break
      }
    }
  } finally {
    setOpenFilesSource(null)
  }
  return out
}

function expandResolver(cfg: ResolverCfg, expand: (value: unknown) => unknown): ResolverCfg {
  return expand(cfg) as ResolverCfg
}

const TOOL_FILES: Record<string, FileSpec> = {
  'p/a.docx': { text: 'not a document', mtimeMs: sec(3000) },
  'p/notes.txt': { text: 'hello world', mtimeMs: sec(2000) },
  'p/sub/b.md': { text: '# B\nbody', mtimeMs: sec(5000) },
  'p/other/c.md': { text: 'other', mtimeMs: sec(4000) },
  'p/sub/deep/d.txt': { text: 'deep', mtimeMs: sec(1000) },
  'p/secret/s.txt': { text: 'secret', mtimeMs: sec(1500) },
  'p/skip.log': { text: 'log', mtimeMs: sec(1200) },
  // the newest files, in the order they used to be written in
  'p/data.bin': { text: 'binary', mtimeMs: sec(6000) },
  'p/script.py': { text: 'print(1)', mtimeMs: sec(6100) },
  'p/colon:name.txt': { text: 'colon', mtimeMs: sec(6200) },
  'p/dots.txt.': { text: 'dots', mtimeMs: sec(6300) },
  'p/.seuoffice/ignore': 'secret/',
  'p/.git/config': 'git',
  'p/long.txt': { text: `${'a'.repeat(24000)}${'b'.repeat(100)}`, mtimeMs: sec(900) },
  'p/emoji.txt': { text: `${'a'.repeat(23999)}\u{1F600}tail`, mtimeMs: sec(800) },
  'p/empty.txt': { text: '', mtimeMs: sec(700) },
  'p/sub/folder.txt/inner.txt': { text: 'inside a folder named like a file', mtimeMs: sec(600) },
  'p/hard.txt': { text: 'hard linked', mtimeMs: sec(500) },
  'outside.txt': { text: 'outside', mtimeMs: sec(400) },
  'file.txt': 'a file used as a project folder',
}

const baseCfg = (over: Partial<ToolsCfg> = {}): ToolsCfg => ({
  dir: '$DIR',
  platform: 'linux',
  projects: { p: { dir: 'p' } },
  store: null,
  cloud: { answers: {} },
  listCloud: null,
  ask: true,
  open: null,
  ...over,
})

const LOCAL = (...names: string[]): ResolverCfg => ({
  answers: Object.fromEntries(names.map((name) => [`$ROOT(p)/${name}`, false])),
})

const scoped = (extra: Record<string, unknown> = {}) => ({ scope: 'scope-1', ...extra })
const open1: ToolOp = { op: 'openScope', owner: 1, raw: { projectId: 'p' } }

const read = (relPath: unknown, extra: Record<string, unknown> = {}): ToolOp => ({
  op: 'read',
  owner: 1,
  raw: scoped({ relPath, ...extra }),
})

const TOOLS_CASES: Case[] = [
  {
    args: [
      baseCfg({
        projects: {
          p: { dir: 'p' },
          gone: { dir: 'nowhere' },
          f: { dir: 'file.txt' },
          bad: { dir: 'p', fails: true },
        },
      }),
      [
        { op: 'openScope', owner: 1, raw: { projectId: 'p' } },
        { op: 'openScope', owner: 2, raw: { projectId: 'p' } },
        { op: 'openScope', owner: 1, raw: { projectId: 'gone' } },
        { op: 'openScope', owner: 1, raw: { projectId: 'f' } },
        { op: 'openScope', owner: 1, raw: { projectId: 'unknown' } },
        { op: 'openScope', owner: 1, raw: { projectId: 'bad' } },
        { op: 'openScope', owner: 1, raw: { projectId: 5 } },
        { op: 'openScope', owner: 1, raw: { projectId: '' } },
        { op: 'openScope', owner: 1, raw: [] },
        { op: 'openScope', owner: 1, raw: null },
        { op: 'openScope', owner: 1, raw: { projectId: 'constructor' } },
        { op: 'isAvailable', projectId: 'p' },
        { op: 'isAvailable', projectId: 'gone' },
        { op: 'isAvailable', projectId: 7 },
        { op: 'isAvailable', projectId: 'bad' },
      ],
    ],
    files: TOOL_FILES,
    note: 'opening a scope: listed and present, missing, a file, unknown, a guide that fails, odd ids',
  },
  {
    args: [
      baseCfg(),
      [
        open1,
        { op: 'listFiles', owner: 1, raw: scoped() },
        { op: 'listFiles', owner: 2, raw: scoped() },
        { op: 'closeScope', owner: 2, raw: { scope: 'scope-1' } },
        { op: 'listFiles', owner: 1, raw: scoped({ limit: 1 }) },
        { op: 'listFiles', owner: 1, raw: {} },
        { op: 'listFiles', owner: 1, raw: null },
        { op: 'listFiles', owner: 1, raw: { scope: 7 } },
        { op: 'listFiles', owner: 1, raw: { scope: 'nope' } },
        { op: 'closeScope', owner: 1, raw: { scope: 'scope-1' } },
        { op: 'listFiles', owner: 1, raw: scoped() },
        { op: 'closeScope', owner: 1, raw: { scope: 5 } },
        { op: 'closeScope', owner: 1, raw: 'x' },
      ],
    ],
    files: TOOL_FILES,
    note: 'scope lifecycle: another window cannot use or close it, close, odd scopes',
  },
  {
    args: [
      baseCfg(),
      [
        open1,
        { op: 'removeProject', id: 'p' },
        { op: 'listFiles', owner: 1, raw: scoped() },
        { op: 'search', owner: 1, raw: scoped({ query: 'x' }) },
        { op: 'read', owner: 1, raw: scoped({ relPath: 'notes.txt' }) },
        { op: 'isAvailable', projectId: 'p' },
        { op: 'visibleTest', projectId: 'p', paths: [] },
      ],
    ],
    files: TOOL_FILES,
    note: 'a project removed mid-run is refused by every tool',
  },
  {
    args: [
      baseCfg(),
      [
        ...Array.from({ length: 17 }, () => open1),
        { op: 'listFiles', owner: 1, raw: { scope: 'scope-1', limit: 1 } },
        { op: 'listFiles', owner: 1, raw: { scope: 'scope-2', limit: 1 } },
        { op: 'listFiles', owner: 1, raw: { scope: 'scope-17', limit: 1 } },
      ],
    ],
    files: TOOL_FILES,
    note: 'the oldest scope is dropped past sixteen',
  },
  {
    args: [
      baseCfg({ cloud: { answers: {} }, listCloud: null }),
      [
        open1,
        { op: 'listFiles', owner: 1, raw: scoped() },
        { op: 'listFiles', owner: 1, raw: scoped({ prefix: 'sub' }) },
        { op: 'listFiles', owner: 1, raw: scoped({ prefix: './Sub/' }) },
        { op: 'listFiles', owner: 1, raw: scoped({ prefix: '.\\sub\\deep' }) },
        { op: 'listFiles', owner: 1, raw: scoped({ prefix: 'zzz' }) },
        { op: 'listFiles', owner: 1, raw: scoped({ prefix: 5 }) },
        { op: 'listFiles', owner: 1, raw: scoped({ offset: 2, limit: 3 }) },
        { op: 'listFiles', owner: 1, raw: scoped({ offset: 1.9, limit: '1.9' }) },
        { op: 'listFiles', owner: 1, raw: scoped({ limit: 'x' }) },
        { op: 'listFiles', owner: 1, raw: scoped({ limit: -5 }) },
        { op: 'listFiles', owner: 1, raw: scoped({ limit: true, offset: null }) },
        { op: 'listFiles', owner: 1, raw: scoped({ limit: [3] }) },
        { op: 'listFiles', owner: 1, raw: scoped({ limit: [1, 2] }) },
        { op: 'listFiles', owner: 1, raw: scoped({ offset: 99 }) },
      ],
    ],
    files: TOOL_FILES,
    note: 'list: prefixes, paging and the number each field is read as; the resolver is asked per page',
  },
  {
    args: [
      baseCfg({
        platform: 'darwin',
        projects: { p: { dir: 'p', ignore: '*.log\nsecret/', fold: true } },
        cloud: { fail: 'unused' },
        listCloud: { answers: { '$ROOT(p)/notes.txt': false, '$ROOT(p)/sub/b.md': true } },
      }),
      [
        open1,
        { op: 'listFiles', owner: 1, raw: scoped() },
        { op: 'listFiles', owner: 1, raw: scoped({ prefix: 'SUB' }) },
        { op: 'listFiles', owner: 1, raw: scoped({ prefix: 'sub', limit: 1 }) },
      ],
    ],
    files: TOOL_FILES,
    note: 'darwin folds the prefix; a list resolver of its own; ignored files are not listed',
  },
  {
    args: [
      baseCfg({ listCloud: { fail: 'list detector down' } }),
      [open1, { op: 'listFiles', owner: 1, raw: scoped({ limit: 2 }) }],
    ],
    files: TOOL_FILES,
    note: 'a failed list resolver marks the page as not on this PC',
  },
  {
    args: [
      baseCfg({ cloud: { answers: { '$ROOT(p)/a.docx': false } } }),
      [open1, { op: 'listFiles', owner: 1, raw: scoped({ limit: 1 }) }],
    ],
    files: TOOL_FILES,
    note: 'without a list resolver the read resolver marks the page',
  },
  {
    args: [
      baseCfg({
        store: {
          rows: [
            {
              path: '$ROOT(p)/notes.txt',
              name: 'notes',
              ext: 'txt',
              mtimeMs: 1,
              snippet: ['he', 'llo'],
            },
            { path: '$ROOT(p)/sub/b.md', name: 'b', ext: 'md', mtimeMs: 2, snippet: ['# B'] },
            { path: '$ROOT(p)/a.docx', name: 'a', ext: 'docx', mtimeMs: 3, snippet: null },
            {
              path: '$ROOT(p)/secret/s.txt',
              name: 's',
              ext: 'txt',
              mtimeMs: 4,
              snippet: ['hidden'],
            },
            { path: '$DIR/outside.txt', name: 'outside', ext: 'txt', mtimeMs: 5, snippet: ['out'] },
            { path: '$ROOT(p)/.git/config', name: 'config', ext: '', mtimeMs: 6, snippet: ['git'] },
          ],
          indexed: ['$ROOT(p)/notes.txt', '$ROOT(p)/a.docx', '$ROOT(p)/sub/b.md'],
        },
        projects: { p: { dir: 'p', ignore: 'secret/' } },
        cloud: { answers: { '$ROOT(p)/notes.txt': false } },
        open: ['$ROOT(p)/sub/b.md'],
      }),
      [
        open1,
        { op: 'search', owner: 1, raw: scoped({ query: '  hello  ' }) },
        { op: 'search', owner: 1, raw: scoped({ query: 'x', exts: ['.TXT', '', 5, 'md'] }) },
        { op: 'search', owner: 1, raw: scoped({ query: 'x', exts: 'txt' }) },
        { op: 'search', owner: 1, raw: scoped({ query: 'x', exts: ['', 7] }) },
        { op: 'search', owner: 1, raw: scoped({ query: 'x', offset: 1, limit: 1 }) },
        { op: 'search', owner: 1, raw: scoped({ query: 'x', limit: 0 }) },
        { op: 'search', owner: 1, raw: scoped({ query: '' }) },
        { op: 'search', owner: 1, raw: scoped({ query: '   ' }) },
        { op: 'search', owner: 1, raw: scoped({ query: 7 }) },
        { op: 'search', owner: 1, raw: scoped({ query: `  ${'w'.repeat(250)}  ` }) },
        { op: 'search', owner: 1, raw: { query: 'x' } },
      ],
    ],
    files: TOOL_FILES,
    note: 'search: the query, extensions and paging; only visible files are ranked; excerpts only from saved, indexed files',
  },
  {
    args: [
      baseCfg({
        store: {
          rows: [
            { path: '$ROOT(p)/notes.txt', name: 'notes', ext: 'txt', mtimeMs: 1, snippet: ['a'] },
            { path: '$DIR/outside.txt', name: 'outside', ext: 'txt', mtimeMs: 5, snippet: ['out'] },
            { path: '$ROOT(p)/.git/config', name: 'config', ext: '', mtimeMs: 6, snippet: ['git'] },
          ],
          indexed: ['$ROOT(p)/notes.txt'],
          ignoreWithin: true,
        },
        listCloud: { fail: 'detector down' },
      }),
      [open1, { op: 'search', owner: 1, raw: scoped({ query: 'x' }) }],
    ],
    files: TOOL_FILES,
    note: 'hits the index let through that are not visible are dropped; a failed resolver marks every hit',
  },
  {
    args: [
      baseCfg({
        store: {
          rows: [
            { path: '$ROOT(p)/notes.txt', name: 'notes', ext: 'txt', mtimeMs: 1, snippet: ['a'] },
          ],
          indexed: ['$ROOT(p)/notes.txt'],
        },
        open: 'throws',
      }),
      [open1, { op: 'search', owner: 1, raw: scoped({ query: 'x' }) }],
    ],
    files: TOOL_FILES,
    note: 'when the open files are unknown no excerpt is quoted',
  },
  {
    args: [
      baseCfg({
        store: {
          rows: [
            {
              path: '$ROOT(p)/notes.txt',
              name: 'notes',
              ext: 'txt',
              mtimeMs: 1,
              snippet: ['not indexed'],
            },
          ],
          indexed: [],
        },
        platform: 'win32',
      }),
      [
        open1,
        { op: 'search', owner: 1, raw: scoped({ query: 'x' }) },
        {
          op: 'visibleTest',
          projectId: 'p',
          paths: ['$ROOT(p)/notes.txt', '$ROOT(p)/.git/config', '$DIR/outside.txt'],
        },
        { op: 'visibleTest', projectId: 'nope', paths: ['x'] },
      ],
    ],
    files: TOOL_FILES,
    note: 'win32; a row not indexed as on disk; the visible test',
  },
  {
    args: [
      baseCfg({
        projects: { p: { dir: 'p', ignore: 'secret/\n*.log' } },
        cloud: LOCAL('notes.txt'),
      }),
      [
        open1,
        read('notes.txt'),
        read('notes.txt', { offset: 6 }),
        read('notes.txt', { offset: 999 }),
        read('notes.txt', { offset: -3 }),
        read('notes.txt', { offset: 'x' }),
        read('empty.txt'),
        read('./notes.txt'),
        read('././notes.txt'),
        read('  .\\notes.txt  '),
        read('$ROOT(p)/notes.txt'),
        read('sub/b.md'),
        read('sub/../notes.txt'),
        read('sub/./b.md'),
        read(''),
        read('   '),
        read(7),
        read('..'),
        read('../outside.txt'),
        read('$DIR/outside.txt'),
        read('/etc/passwd'),
        read('C:\\Windows\\win.ini'),
        read('c:rel'),
        read('/'),
      ],
    ],
    files: TOOL_FILES,
    note: 'read: paging and the way the path is given',
  },
  {
    args: [
      baseCfg({
        projects: { p: { dir: 'p', ignore: 'secret/\n*.log\n/sub/folder.txt/' } },
        cloud: LOCAL('a.docx', 'data.bin', 'hard.txt'),
      }),
      [
        open1,
        read('.seuoffice/ignore'),
        read('.git/config'),
        read('secret/s.txt'),
        read('skip.log'),
        read('nothere.txt'),
        read('sub'),
        read('sub/folder.txt/inner.txt'),
        read('sub/folder.txt'),
        read('data.bin'),
        read('a.docx'),
        read('hard.txt'),
        read('nothere/deeper/x.txt'),
      ],
    ],
    files: { ...TOOL_FILES, 'hard.link': { link: 'p/hard.txt' } },
    note: 'read: hidden, ignored, absent, a folder, unsupported, unreadable, a second hard link',
  },
  {
    args: [
      baseCfg({
        projects: { p: { dir: 'p' } },
        cloud: LOCAL('notes.txt', 'long.txt', 'emoji.txt'),
      }),
      [
        open1,
        read('long.txt'),
        read('long.txt', { offset: 24000 }),
        read('long.txt', { offset: 24100 }),
        read('long.txt', { offset: 30000 }),
        read('emoji.txt', { offset: 23999 }),
        read('emoji.txt', { offset: 24001 }),
        { op: 'readPath', owner: 1, projectId: 'p', path: '$ROOT(p)/notes.txt', offset: 5 },
        { op: 'readPath', owner: 1, projectId: 'p', path: 'notes.txt', offset: 1.5 },
        { op: 'readPath', owner: 1, projectId: 'p', path: '$DIR/outside.txt', offset: 0 },
        { op: 'readPath', owner: 1, projectId: 'nope', path: '$ROOT(p)/notes.txt', offset: 0 },
        { op: 'readPath', owner: 1, projectId: 'p', path: '$ROOT(p)/notes.txt', offset: -1 },
      ],
    ],
    files: TOOL_FILES,
    note: 'pages of a long text, a code point at the cut, and the read by path',
  },
  {
    args: [
      baseCfg({ ask: true }),
      [
        open1,
        read('notes.txt'),
        read('sub/b.md'),
        { op: 'readPath', owner: 4, projectId: 'p', path: '$ROOT(p)/notes.txt', offset: 0 },
      ],
    ],
    files: TOOL_FILES,
    note: 'a file not on this PC: the person agrees',
  },
  {
    args: [baseCfg({ ask: false }), [open1, read('notes.txt')]],
    files: TOOL_FILES,
    note: 'a file not on this PC: the person declines',
  },
  {
    args: [baseCfg({ ask: 'throws' }), [open1, read('notes.txt')]],
    files: TOOL_FILES,
    note: 'a question that fails counts as no',
  },
  {
    args: [baseCfg({ cloud: { fail: 'detector down' }, ask: false }), [open1, read('notes.txt')]],
    files: TOOL_FILES,
    note: 'a failed detector asks first',
  },
  {
    args: [
      baseCfg({ cloud: LOCAL('notes.txt'), ask: false }),
      [open1, read('notes.txt'), read('sub/b.md')],
    ],
    files: TOOL_FILES,
    note: 'a local file opens without a question; another one asks',
  },
  {
    args: [
      baseCfg({ cloud: LOCAL('notes.txt', 'sub/b.md'), open: ['$ROOT(p)/notes.txt'] }),
      [open1, read('notes.txt'), read('sub/b.md')],
    ],
    files: TOOL_FILES,
    note: 'a file open with unsaved changes is refused',
  },
  {
    args: [baseCfg({ cloud: LOCAL('notes.txt'), open: 'throws' }), [open1, read('notes.txt')]],
    files: TOOL_FILES,
    note: 'unknown open files count as unsaved',
  },
  {
    args: [
      baseCfg({ cloud: LOCAL('notes.txt'), open: { after: 1, paths: ['$ROOT(p)/notes.txt'] } }),
      [open1, read('notes.txt')],
    ],
    files: TOOL_FILES,
    note: 'saved when asked first, unsaved when the page is read: the page refuses',
  },
  {
    args: [
      baseCfg({
        platform: 'win32',
        cloud: LOCAL('notes.txt'),
      }),
      [
        open1,
        read('notes.txt'),
        read('notes.txt.'),
        read('notes.txt '),
        read('notes.txt:stream'),
        read('sub\\b.md'),
        read('con'),
      ],
    ],
    files: TOOL_FILES,
    note: 'win32: a name with a trailing dot, space or stream is another spelling and not found',
  },
  {
    args: [
      baseCfg({
        platform: 'linux',
        cloud: LOCAL('notes.txt'),
      }),
      [open1, read('notes.txt.'), read('notes.txt:stream'), read('sub\\b.md')],
    ],
    files: TOOL_FILES,
    note: 'linux: the same names are plain names',
  },
  {
    args: [
      baseCfg({
        projects: { p: { dir: 'p', ignore: 'notes.txt', fold: true } },
        platform: 'darwin',
      }),
      [open1, read('NOTES.TXT'), read('Notes.txt'), read('sub/B.MD')],
    ],
    files: TOOL_FILES,
    note: 'darwin: a rule that folds case judges the spelling given and the spelling on disk',
  },
  {
    args: [
      baseCfg({ platform: 'win32', cloud: LOCAL('colon:name.txt', 'notes.txt') }),
      [open1, read('colon:name.txt'), read('dots.txt.'), read('notes.txt')],
    ],
    files: TOOL_FILES,
    note: 'win32: a name with a colon or a trailing dot is refused though such a file is there',
  },
  {
    args: [
      baseCfg({ platform: 'linux', cloud: LOCAL('colon:name.txt', 'script.py') }),
      [open1, read('colon:name.txt'), read('script.py'), read('dots.txt.')],
    ],
    files: TOOL_FILES,
    note: 'linux: those names are plain; a text format the tree does not list is unreadable',
  },
  {
    args: [baseCfg({ open: ['$ROOT(p)/notes.txt'] }), [open1, read('notes.txt')]],
    files: TOOL_FILES,
    note: 'unsaved changes are refused before the download question',
  },
  {
    args: [
      baseCfg({
        platform: 'darwin',
        projects: { p: { dir: 'p', ignore: 'notes.txt', fold: false } },
        cloud: LOCAL('notes.txt'),
      }),
      [open1, read('NOTES.TXT'), read('notes.txt')],
    ],
    files: TOOL_FILES,
    note: 'the spelling on disk is judged too (a disk that ignores case)',
  },
  {
    args: [
      baseCfg({
        platform: 'darwin',
        projects: { p: { dir: 'p', fold: true } },
        cloud: { answers: {} },
        listCloud: null,
      }),
      [
        open1,
        { op: 'listFiles', owner: 1, raw: scoped({ prefix: 'mixed' }) },
        { op: 'listFiles', owner: 1, raw: scoped({ prefix: 'MIXED/up' }) },
        { op: 'listFiles', owner: 1, raw: scoped({ prefix: 'Mixed/Up' }) },
      ],
    ],
    files: { ...TOOL_FILES, 'p/Mixed/Up.md': { text: 'mixed case', mtimeMs: sec(7000) } },
    note: 'darwin: a prefix is compared with the folded path of a file named with capitals',
  },
  {
    args: [
      baseCfg(),
      [
        open1,
        read('.seuoffice/nope.md'),
        read('sub/.nope.md'),
        read('.git/missing.txt'),
        read('node_modules/x.md'),
        read('sub/nope.md'),
      ],
    ],
    files: TOOL_FILES,
    note: 'read: a hidden name is refused as hidden before the disk is asked, absent or not',
  },
]

// ---------------------------------------------------------------------------
// project-dialog-text
// ---------------------------------------------------------------------------

type IntlMode = 'ok' | 'numberThrows' | 'dateThrows' | 'bothThrow'

/** `run` with `Intl.NumberFormat` and `Intl.DateTimeFormat` replaced by the spec's deterministic ones */
function withIntl<T>(mode: IntlMode, run: () => T): T {
  const intl = Intl as unknown as Record<string, unknown>
  const real = { number: intl.NumberFormat, date: intl.DateTimeFormat }
  intl.NumberFormat = function (lang: string) {
    if (mode === 'numberThrows' || mode === 'bothThrow') throw new RangeError('number format')
    return { format: (count: number) => `n:${lang}:${count}` }
  }
  intl.DateTimeFormat = function (lang: string, options: { dateStyle: string; timeStyle: string }) {
    if (mode === 'dateThrows' || mode === 'bothThrow') throw new RangeError('date format')
    return {
      format: (at: Date) =>
        `d:${lang}:${at.toISOString()}:${options.dateStyle}/${options.timeStyle}`,
    }
  }
  try {
    return run()
  } finally {
    intl.NumberFormat = real.number
    intl.DateTimeFormat = real.date
  }
}

type Lang = 'en' | 'ko'
const lang = (value: unknown): Lang => value as Lang

const chat = (n: number, title: string, updatedAt = '2026-03-04T05:06:07.000Z') => ({
  id: `c${n}`,
  title,
  updatedAt,
})

const PROMPT_MIN = {
  projectId: 'p1',
  name: 'Budget',
  folderPath: '/work/Budget',
  instructions: null,
  memory: null,
  agents: null,
  claude: null,
  foreignChats: [] as ReturnType<typeof chat>[],
}
const PROMPT_FULL = {
  ...PROMPT_MIN,
  instructions: '  Be brief.  ',
  memory: 'Remember the budget.',
  agents: 'x'.repeat(1500),
  claude: `${'y'.repeat(1499)}\u{1F600}z`,
  foreignChats: [chat(1, 'First'), chat(2, ''), chat(3, '   '), chat(4, 'bad', 'not a date')],
}
const MANY_CHATS = Array.from({ length: 21 }, (_, i) => chat(i, `Chat ${i}`))

const TRUST_CASES: Case[] = [
  { args: ['en', PROMPT_MIN, 'ok'], note: 'nothing but the hints' },
  { args: ['ko', PROMPT_MIN, 'ok'], note: 'ko' },
  { args: ['en', PROMPT_FULL, 'ok'], note: 'every text, chats with odd titles and a bad date' },
  { args: ['ko', PROMPT_FULL, 'ok'], note: 'ko, every text' },
  {
    args: [
      'en',
      { ...PROMPT_MIN, instructions: 'z'.repeat(1501), memory: `${'m'.repeat(3000)}` },
      'ok',
    ],
    note: 'texts cut at 1500 characters with the count of the rest',
  },
  {
    args: ['ko', { ...PROMPT_MIN, instructions: 'z'.repeat(1501) }, 'numberThrows'],
    note: 'a count the host cannot format is written as it is',
  },
  {
    args: ['en', { ...PROMPT_MIN, instructions: '  \n\t ', memory: '', agents: ' ' }, 'ok'],
    note: 'blank texts are left out',
  },
  {
    args: ['en', { ...PROMPT_MIN, foreignChats: MANY_CHATS.slice(0, 20) }, 'ok'],
    note: 'twenty chats: all listed',
  },
  {
    args: ['en', { ...PROMPT_MIN, foreignChats: MANY_CHATS }, 'ok'],
    note: 'twenty-one chats: one left out',
  },
  {
    args: ['ko', { ...PROMPT_MIN, foreignChats: MANY_CHATS }, 'ok'],
    note: 'ko, one left out',
  },
  {
    args: [
      'en',
      { ...PROMPT_MIN, foreignChats: [chat(1, 'T'), chat(2, 'U', '2026-03-04')] },
      'dateThrows',
    ],
    note: 'a date the host cannot format is written as an ISO time',
  },
  {
    args: [
      'en',
      {
        ...PROMPT_MIN,
        foreignChats: [chat(1, 'c'.repeat(130)), chat(2, `${'d'.repeat(119)}\u{1F600}e`)],
      },
      'ok',
    ],
    note: 'titles cut at 120 characters',
  },
  {
    args: ['en', { ...PROMPT_MIN, name: '{count} {name}', folderPath: 'C:\\x' }, 'bothThrow'],
    note: 'a name with placeholders is not expanded again',
  },
]

const SHOWN_CASES: Case[] = cases(
  ['short', null],
  ['  padded  ', null],
  ['x'.repeat(1500), null],
  ['x'.repeat(1501), null],
  [`${'a'.repeat(1499)}\u{1F600}b`, null],
  ['abcdef', 5],
  ['abcdef', 6],
  ['abcdef', 0],
  ['', 3],
  ['\u{1F600}\u{1F600}\u{1F600}', 2],
  ['  \u{FEFF}x  ', 5],
)

const CHOICE_CASES: Case[] = cases([0], [1], [2], [3], [-1], [0.5], [100], [4])

const DOWNLOAD_CASES: Case[] = cases(
  ['en', 'report.docx'],
  ['ko', '\uBCF4\uACE0\uC11C.docx'],
  ['en', ''],
  ['en', '{file} {name} $& $1'],
)

const EXISTING_CASES: Case[] = cases(
  ['en', '/work/Budget'],
  ['ko', 'D:\\docs\\Budget'],
  ['en', '/work/Budget/'],
  ['en', 'C:\\'],
  ['en', '///'],
  ['en', ''],
  ['en', 'plain'],
  ['ko', '/a\\b/c\\'],
)

const PICKER_CASES: Case[] = cases(
  ['en', 'add'],
  ['en', 'relocate'],
  ['en', 'parent'],
  ['ko', 'add'],
  ['ko', 'relocate'],
  ['ko', 'parent'],
)

const TEXT_CASES: Case[] = cases(
  ['en', 'trustTitle', null],
  ['ko', 'trustTitle', null],
  ['en', 'trustMessage', { name: 'Budget' }],
  ['ko', 'trustMoreChars', { count: '1,234' }],
  ['en', 'trustMoreChats', { count: 5 }],
  ['en', 'trustMoreChats', {}],
  ['en', 'trustMoreChats', { count: null }],
  ['en', 'trustMessage', { name: '{count}' }],
  ['en', 'noSuchKey', null],
  ['ko', 'noSuchKey', { a: 1 }],
  ['en', 'trustMoreChats', { count: 1e21 }],
  ['ko', 'cancel', null],
)

// ---------------------------------------------------------------------------
// the group
// ---------------------------------------------------------------------------

const KB_CASES: Case[] = cases(
  ['a.docx'],
  ['b.PDF'],
  ['c.png'],
  ['d.txt'],
  ['noext'],
  ['.hidden'],
  ['x.tar.gz'],
  ['dir/e.PNG'],
  ['f.XLSM'],
  ['g.hwpx'],
  ['h.hwp'],
)

const ATTACHABLE_CASES: Case[] = cases(
  ['png'],
  ['.PNG'],
  ['docx'],
  ['.PDF'],
  ['txt'],
  [''],
  ['..png'],
  ['jpeg'],
  ['xmind'],
)

export const files: Group = {
  'project-files.PROJECT_CONTEXT_FILES_LIMIT': constant(projectFiles.PROJECT_CONTEXT_FILES_LIMIT),
  'project-files.PROJECT_FILE_LIST_CACHE_MS': constant(projectFiles.PROJECT_FILE_LIST_CACHE_MS),
  'project-files.PROJECT_MENTION_FILES_LIMIT': constant(projectFiles.PROJECT_MENTION_FILES_LIMIT),
  'project-files.listVisibleFiles': {
    ts: (a) => projectFiles.listVisibleFiles(makeVis(a[0] as VisCfg)),
    cases: LIST_CASES,
  },
  'project-files.listIgnoredFiles': {
    ts: (a) => projectFiles.listIgnoredFiles(makeVis(a[0] as VisCfg)),
    cases: IGNORED_CASES,
  },
  'project-files.withCloudFlags': {
    ts: (a, cx) =>
      projectFiles.withCloudFlags(a[0] as VisibleFile[], fakeResolver(a[1] as ResolverCfg, cx)),
    cases: CLOUD_CASES,
  },
  'project-files.toEntry': {
    ts: (a) => projectFiles.toEntry(a[0] as VisibleFile),
    cases: ENTRY_CASES,
  },
  'project-files.projectMentionFiles': {
    ts: (a, cx) =>
      projectFiles.projectMentionFiles(
        makeVis(a[0] as VisCfg),
        (a[1] as number | null) ?? undefined,
        a[2] === null ? undefined : fakeLister(a[2] as ListerCfg, cx),
      ),
    cases: MENTION_CASES,
  },
  'project-files.createContextFiles': {
    ts: async (a, cx) => {
      const cfg = a[0] as {
        limit?: number
        resolve?: ResolverCfg
        list?: ListerCfg
      }
      const vis = makeVis(a[1] as VisCfg)
      const contextFiles = projectFiles.createContextFiles({
        resolveCloudOnly: fakeResolver(cfg.resolve, cx),
        ...(cfg.limit === undefined ? {} : { limit: cfg.limit }),
        ...(cfg.list === undefined ? {} : { list: fakeLister(cfg.list, cx) }),
      })
      return settle(() => contextFiles({ id: 'p', root: vis.root, visibility: vis }))
    },
    cases: CONTEXT_CASES,
  },
  'project-files.createCachedFileLister': {
    ts: (a, cx) =>
      runCachedLister(a[0] as { ttlMs?: number }, a[1] as (CacheOp | InvalidateOp)[], cx),
    cases: CACHED_CASES,
  },

  'project-index.projectFolderRoots': {
    ts: (a) => {
      const path = join(a[0] as string, 'app-settings.json')
      if (a[1] !== null) writeFileSync(path, a[1] as string)
      return projectIndex.projectFolderRoots(path)
    },
    cases: ROOTS_CASES,
  },
  'project-index.mergeIndexRoots': {
    ts: (a) => projectIndex.mergeIndexRoots(a[0] as string[], a[1] as string[], a[2] as Platform),
    cases: MERGE_CASES,
  },
  'project-index.createProjectNameOnly': {
    ts: (a, cx) => runNameOnly(a[0] as NameOnlyCfg, a[1] as string[][], cx),
    cases: NAME_ONLY_CASES,
  },
  'project-index.createRerankIgnoreFilter': {
    ts: (a, cx) => runRerank(a[0] as RerankCfg, a[1] as string[], cx),
    cases: RERANK_CASES,
  },

  'project-tools.PROJECT_SCOPE_UNKNOWN': constant(projectTools.PROJECT_SCOPE_UNKNOWN),
  'project-tools.PROJECT_UNAVAILABLE': constant(projectTools.PROJECT_UNAVAILABLE),
  'project-tools.PROJECT_LIST_DEFAULT_LIMIT': constant(projectTools.PROJECT_LIST_DEFAULT_LIMIT),
  'project-tools.PROJECT_SEARCH_DEFAULT_LIMIT': constant(projectTools.PROJECT_SEARCH_DEFAULT_LIMIT),
  'project-tools.ProjectFolderTools': {
    ts: (a, cx) => runTools(a[0] as ToolsCfg, a[1] as ToolOp[], cx),
    cases: TOOLS_CASES,
  },

  'project-dialog-text.PROJECT_DIALOG_STRINGS': constant(dialogText.PROJECT_DIALOG_STRINGS),
  'project-dialog-text.TRUST_TEXT_SHOWN_CHARS': constant(dialogText.TRUST_TEXT_SHOWN_CHARS),
  'project-dialog-text.TRUST_CHATS_SHOWN': constant(dialogText.TRUST_CHATS_SHOWN),
  'project-dialog-text.projectDialogText': {
    ts: (a) =>
      dialogText.projectDialogText(
        lang(a[0]),
        a[1] as never,
        (a[2] ?? undefined) as Record<string, string | number> | undefined,
      ),
    cases: TEXT_CASES,
  },
  'project-dialog-text.shownText': {
    ts: (a) => dialogText.shownText(a[0] as string, (a[1] as number | null) ?? undefined),
    cases: SHOWN_CASES,
  },
  'project-dialog-text.shownExcerpt': {
    ts: (a) => dialogText.shownExcerpt(a[0] as string, (a[1] as number | null) ?? undefined),
    cases: SHOWN_CASES,
  },
  'project-dialog-text.trustPromptOptions': {
    ts: (a) =>
      withIntl(a[2] as IntlMode, () => dialogText.trustPromptOptions(lang(a[0]), a[1] as never)),
    cases: TRUST_CASES,
  },
  'project-dialog-text.trustChoiceOf': {
    ts: (a) => dialogText.trustChoiceOf(a[0] as number),
    cases: CHOICE_CASES,
  },
  'project-dialog-text.downloadPromptOptions': {
    ts: (a) => dialogText.downloadPromptOptions(lang(a[0]), a[1] as string),
    cases: DOWNLOAD_CASES,
  },
  'project-dialog-text.useExistingPromptOptions': {
    ts: (a) => dialogText.useExistingPromptOptions(lang(a[0]), a[1] as string),
    cases: EXISTING_CASES,
  },
  'project-dialog-text.folderPickerOptions': {
    ts: (a) => dialogText.folderPickerOptions(lang(a[0]), a[1] as never),
    cases: PICKER_CASES,
  },

  'knowledge-base.KB_READ_MAX_BYTES': constant(knowledgeBase.KB_READ_MAX_BYTES),
  'knowledge-base.kbReadMaxBytes': {
    ts: (a) => knowledgeBase.kbReadMaxBytes(a[0] as string),
    cases: KB_CASES,
  },
  'attachable.attachableMaxBytes': {
    ts: (a) => attachableMaxBytes(a[0] as string),
    cases: ATTACHABLE_CASES,
  },
}
