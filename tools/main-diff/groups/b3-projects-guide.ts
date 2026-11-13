/**
 * Part `guide` of group `b3-projects`: apps/shell/src/main/projects/
 * project-guide.ts. The Rust side is crates/main-core/src/calls/b3_projects/
 * guide.rs.
 *
 * `project-guide.scenario` runs a list of operations over one `ProjectGuide`
 * on the folders of the case and answers `[[op, result], ...]`, where `result`
 * is what the method answered, `null` for the operations that only change the
 * world or answer nothing, and `{ error, code, refused }` where it threw (the
 * message with a temp file's random name written `.<hex>.tmp`, the `code` of a
 * Node error, the `reason` of a `ProjectWriteRefused`).
 *
 * The scenario is `{ dir, platform, startMs, tickMs, ids, language, env, home,
 * userData, defaultParent, touchWriteMs, contextFiles, settings, trust, ops }`:
 * - `dir` is `$DIR`; every string of the scenario that starts with it is
 *   written below the real path of `dir` (the project folders are canonical
 *   paths and a temporary folder may lie under a link), and what comes back
 *   keeps the real path, which each side's comparison writes as `$DIR`; the
 *   keys of an object are such strings too (a stored record of a document is
 *   keyed by its path, written with the literal `$DIR`);
 * - `home`, `userData` and `defaultParent` default to `<dir>/home`,
 *   `<dir>/userData` and `<dir>/parent`, made before the run; the settings
 *   file is `<userData>/app-settings.json`, holding `{ projects: settings }`
 *   when `settings` is given;
 * - the clock reads `startMs`, then moves `tickMs` on each read; `ids` are the
 *   new ids in order (`extraN` after the last), each logged as `['newId', id]`;
 *   the time zone is UTC;
 * - `trust` are the answers of the trust prompt in order (`'use'`, `'without'`,
 *   `null` for a closed prompt; closed once they run out); each prompt is the
 *   log line `['trust', prompt]`;
 * - `contextFiles` (`{ probes, omitted }`) makes the context list the probes
 *   the project's visibility rule allows, logged as `['contextFiles', id, root,
 *   visible]`;
 * - each `console.warn` is the log line `['warn', label, message]`; the timer of
 *   `touch` is a fake the operations `touchTimer` and `fireTimer` read and fire;
 * - an `updateData` change logs `['change', current]` and answers by `mode`:
 *   `set` (the `text`), `append`, `keep` (null) or `throw` (`boom`).
 * An operation is a method of the guide (`listProjects`, `getProject`,
 * `defaultParent`, `setPinned`, `removeFromList`, `addFolder`, `relocate`,
 * `createProject`, `renameProject`, `retryUnwritable`, `installId`,
 * `projectRoot`, `trustState`, `isUnwritable`, `markUnwritable`, `writeData`,
 * `appendData`, `updateData`, `removeData`, `dataPath`, `writeNewDocument`,
 * `documentRelativePath`, `aiVisibility` (answers the root, rule key, patterns
 * and the visibility of each probe), `readContext`, `detail`, `getSettings`,
 * `setSettings`, `decideTrust`, `saveInstructions`, `addIgnore`, `removeIgnore`,
 * `editMemory`, `saveMemory`, `consolidate`, `undo`, `selection`,
 * `setSelection`, `recordOutsideChat`, `adoptHint`, `flushTouches`), or one
 * that changes or reads the world: `touchTimer`, `fireTimer`, `queueTrust`,
 * `clock`, `fsWrite`, `fsMkdir`, `fsRemove`, `fsLink`, `fsChmod`, `settingsFile`.
 *
 * Which functions need Electron: none, but folder-files.ts reaches
 * agent-sessions.ts, so the fake of electron-fake.ts is registered first.
 */
import '../electron-fake.ts'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname } from 'node:path'
import type { Case, FnSpec, Group, TsContext } from '../types.ts'

const guideModule = await import('../../../apps/shell/src/main/projects/project-guide.ts')
const { ProjectWriteRefused } = await import('../../../apps/shell/src/main/projects/write-guard.ts')

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

interface Scenario {
  dir: string
  platform?: string
  startMs?: number
  tickMs?: number
  ids?: string[]
  language?: string
  env?: Record<string, string>
  home?: string
  userData?: string
  defaultParent?: string
  touchWriteMs?: number
  contextFiles?: { probes: string[]; omitted: number } | null
  settings?: unknown
  trust?: (string | null)[]
  ops: Op[]
}

type Op = { op: string } & Record<string, Any>

const maskTmp = (text: string): string => text.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')

function deep(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === 'string') return map(value)
  if (Array.isArray(value)) return value.map((item) => deep(item, map))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [map(key), deep(item, map)]),
    )
  }
  return value
}

function failure(error: unknown): unknown {
  const failed = error as { message: string; code?: unknown; reason?: unknown }
  return {
    error: maskTmp(failed.message),
    code: typeof failed.code === 'string' ? failed.code : null,
    refused: error instanceof ProjectWriteRefused ? failed.reason : null,
  }
}

async function runScenario(raw: Scenario, cx: TsContext): Promise<unknown> {
  const dir = raw.dir
  const real = realpathSync(dir)
  // the keys of the stored records are paths too, and the case writes them with the literal `$DIR`
  const spec = deep(raw, (text) =>
    text.startsWith(dir)
      ? real + text.slice(dir.length)
      : text.startsWith('$DIR')
        ? real + text.slice('$DIR'.length)
        : text,
  ) as Scenario
  const home = spec.home ?? `${real}/home`
  const userData = spec.userData ?? `${real}/userData`
  const defaultParent = spec.defaultParent ?? `${real}/parent`
  for (const folder of [userData, home, defaultParent]) mkdirSync(folder, { recursive: true })
  const settingsPath = `${userData}/app-settings.json`
  if (spec.settings !== undefined && spec.settings !== null) {
    writeFileSync(settingsPath, JSON.stringify({ projects: spec.settings }))
  }

  const note = (...line: unknown[]): void => cx.log(...line)
  let clock = spec.startMs ?? 0
  const tick = spec.tickMs ?? 0
  const ids = [...(spec.ids ?? [])]
  let extra = 0
  const answers = [...(spec.trust ?? [])]
  const language = spec.language ?? 'en'
  const env = spec.env ?? {}

  let timer: { delay: number; fn: () => void; unref: () => void } | null = null
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const realWarn = console.warn
  const realZone = process.env.TZ
  process.env.TZ = 'UTC'
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    const handle = { delay, fn, unref: () => undefined }
    timer = handle
    return handle
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((handle: unknown) => {
    if (handle === timer) timer = null
  }) as unknown as typeof clearTimeout
  console.warn = (label: unknown, error: unknown) =>
    note('warn', label, maskTmp(error instanceof Error ? error.message : String(error)))

  try {
    const probes = spec.contextFiles?.probes ?? []
    const guide = new guideModule.ProjectGuide({
      settingsPath,
      homeDir: home,
      userData,
      defaultParentDir: () => defaultParent,
      platform: (spec.platform ?? 'linux') as NodeJS.Platform,
      env,
      now: () => {
        const at = clock
        clock += tick
        return new Date(at)
      },
      newId: () => {
        const id = ids.shift() ?? `extra${++extra}`
        note('newId', id)
        return id
      },
      language: () => language,
      contextFiles: spec.contextFiles
        ? async (request) => {
            const visible = probes.filter((probe) => request.visibility.isVisible(probe))
            note('contextFiles', request.id, request.root, visible)
            return {
              files: visible.map((relPath) => ({
                relPath,
                ext: extname(relPath),
                sizeBytes: 1,
                mtimeMs: 1,
                cloudOnly: false,
              })),
              omitted: spec.contextFiles!.omitted,
            }
          }
        : undefined,
      touchWriteMs: spec.touchWriteMs,
    })
    const ask = async (prompt: unknown) => {
      note('trust', JSON.parse(JSON.stringify(prompt)))
      return (answers.shift() ?? null) as 'use' | 'without' | null
    }
    const results: unknown[] = []
    for (const op of spec.ops) {
      let value: unknown
      try {
        value = await runOp(guide, op, ask, {
          note,
          setClock: (ms) => {
            clock = ms
          },
          pushAnswers: (list) => {
            answers.push(...list)
          },
          timer: () => timer,
          fire: () => {
            const fired = timer
            timer = null
            fired?.fn()
          },
          readSettingsFile: (): { projects?: unknown } =>
            JSON.parse(readFileSync(settingsPath, 'utf8')),
        })
      } catch (error) {
        value = failure(error)
      }
      results.push([op.op, value ?? null])
    }
    return results
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    console.warn = realWarn
    if (realZone === undefined) delete process.env.TZ
    else process.env.TZ = realZone
  }
}

interface World {
  note: (...line: unknown[]) => void
  setClock: (ms: number) => void
  pushAnswers: (list: (string | null)[]) => void
  timer: () => { delay: number } | null
  fire: () => void
  readSettingsFile: () => { projects?: unknown }
}

async function runOp(
  guide: InstanceType<typeof guideModule.ProjectGuide>,
  op: Op,
  ask: Any,
  world: World,
): Promise<unknown> {
  switch (op.op) {
    case 'listProjects':
      return guide.listProjects()
    case 'getProject':
      return guide.getProject(op.id)
    case 'defaultParent':
      return guide.getDefaultParentFolder()
    case 'setPinned':
      return guide.setPinned(op.id, op.pinned)
    case 'removeFromList':
      return guide.removeFromList(op.id)
    case 'addFolder':
      return guide.addFolder(op.path, ask)
    case 'relocate':
      return guide.relocateProject(op.id, op.path, ask)
    case 'createProject':
      return guide.createProject(op.args, ask)
    case 'renameProject':
      return guide.renameProject(op.id, op.name)
    case 'retryUnwritable':
      return guide.retryUnwritable(op.id)
    case 'installId':
      return guide.installId()
    case 'projectRoot':
      return guide.projectRoot(op.id)
    case 'trustState':
      return guide.trustState(op.id)
    case 'isUnwritable':
      return guide.isUnwritable(op.id)
    case 'markUnwritable':
      return guide.markUnwritable(op.id)
    case 'writeData':
      return guide.writeData(op.id, op.rel, op.text, op.dataDir ?? undefined)
    case 'appendData':
      return guide.appendData(op.id, op.rel, op.text, op.dataDir ?? undefined)
    case 'updateData':
      return guide.updateData(
        op.id,
        op.rel,
        (current) => {
          world.note('change', current)
          if (op.mode === 'set') return op.text
          if (op.mode === 'append') return (current ?? '') + (op.text ?? '')
          if (op.mode === 'keep') return null
          throw new Error('boom')
        },
        op.dataDir ?? undefined,
      )
    case 'removeData':
      return guide.removeData(op.id, op.rel, op.dataDir ?? undefined)
    case 'dataPath':
      return guide.dataPath(op.id, op.rel, op.dataDir ?? undefined)
    case 'writeNewDocument':
      return guide.writeNewDocument(op.id, op.target, Buffer.from(op.text, 'utf8'))
    case 'documentRelativePath':
      return guide.documentRelativePath(op.id, op.doc)
    case 'aiVisibility': {
      const visibility = await guide.aiVisibility(op.id)
      if (visibility === null) return null
      return {
        root: visibility.root,
        ruleKey: visibility.ruleKey,
        patterns: visibility.matcher.patterns,
        visible: (op.probes ?? []).map(([rel, isDir]: [string, boolean?]) =>
          visibility.isVisible(rel, isDir ?? false),
        ),
      }
    }
    case 'readContext':
      return guide.readContext(op.id)
    case 'detail':
      return guide.getProjectDetail(op.id)
    case 'getSettings':
      return guide.getSettings(op.id)
    case 'setSettings':
      return guide.setSettings(op.id, op.patch)
    case 'decideTrust':
      return guide.decideTrust(op.id, op.decision, ask)
    case 'saveInstructions':
      return guide.saveInstructions(op.id, op.text)
    case 'addIgnore':
      return guide.addIgnore(op.id, op.rel)
    case 'removeIgnore':
      return guide.removeIgnore(op.id, op.rel)
    case 'editMemory':
      return guide.editMemory(op.id, op.change, op.by)
    case 'saveMemory':
      return guide.saveMemory(op.id, op.text)
    case 'consolidate':
      return guide.applyMemoryConsolidation({ projectId: op.id, entries: op.entries })
    case 'undo':
      return guide.undoMemoryConsolidation({ projectId: op.id, backupName: op.backupName })
    case 'selection':
      return guide.getSelection(op.target)
    case 'setSelection':
      return guide.setSelection(op.target, op.projectId)
    case 'recordOutsideChat':
      return guide.recordOutsideChat(op.doc, op.projectId, op.chatId)
    case 'adoptHint':
      return guide.adoptFolderHint(op.doc, ask)
    case 'flushTouches':
      return guide.flushTouches()
    case 'touchTimer': {
      const timer = world.timer()
      return timer ? { armed: true, delay: timer.delay } : null
    }
    case 'fireTimer':
      return world.fire()
    case 'queueTrust':
      return world.pushAnswers(op.answers)
    case 'clock':
      return world.setClock(op.ms)
    case 'fsWrite':
      mkdirSync(dirname(op.path), { recursive: true })
      return writeFileSync(op.path, op.text)
    case 'fsMkdir':
      return mkdirSync(op.path, { recursive: true })
    case 'fsRemove':
      return rmSync(op.path, { recursive: true, force: true })
    case 'fsLink':
      return symlinkSync(op.target, op.path)
    case 'fsChmod':
      return chmodSync(op.path, op.mode)
    case 'settingsFile':
      return world.readSettingsFile().projects
    default:
      throw new Error(`unknown op ${op.op}`)
  }
}

// ---------------------------------------------------------------------------
// the cases
// ---------------------------------------------------------------------------

const D = '$DIR'
const NOW = 1_794_452_400_000
const OLD = '2026-01-01T00:00:00.000Z'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

const projectFile = (id: string, name: string, createdAt = '2025-05-05T05:05:05.000Z'): string =>
  JSON.stringify({ version: 1, id, name, createdAt })

const MEMORY_HEADER = '<!-- Memory kept by SeuOffice. You may edit or delete it. -->'
const MEMORY = `${MEMORY_HEADER}\n- prefers tables (2026-01-02)\n- writes in Korean (2026-01-03)\n`
const AGENTS = 'Agents file.\n'

const run = (ops: Op[], extra: Partial<Scenario> = {}): unknown[] => [
  { dir: D, platform: 'linux', startMs: NOW, tickMs: 0, ids: [], trust: [], ops, ...extra },
]

const stored = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  installId: 'inst-1',
  list: [],
  trust: {},
  outsideDocuments: {},
  optedOutDocuments: {},
  settings: {},
  syncNoticeShown: [],
  ...extra,
})

const entry = (id: string, rel: string, extra: Record<string, unknown> = {}) => ({
  id,
  path: `${D}/${rel}`,
  pinned: false,
  lastUsedAt: OLD,
  ...extra,
})

const used = (hashes: Record<string, string> = {}) => ({ decision: 'use', hashes })
const without = (hashes: Record<string, string> = {}) => ({ decision: 'without', hashes })

const op = (name: string, extra: Record<string, unknown> = {}): Op => ({ op: name, ...extra })
const settingsFile = op('settingsFile')

const scenario = (note: string, args: unknown[], files?: Case['files']): Case => ({
  args,
  files,
  note,
})

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

const alpha = {
  'alpha/.seuoffice/project.json': projectFile('p1', 'Alpha Project'),
  'alpha/a.txt': 'a',
}

const cases: Case[] = [
  scenario(
    'the list: pinned first, newest first, a missing folder, pins, unwritable, removal',
    run(
      [
        op('listProjects'),
        op('getProject', { id: 'p1' }),
        op('getProject', { id: 'nope' }),
        op('defaultParent'),
        op('setPinned', { id: 'p2', pinned: true }),
        op('listProjects'),
        op('setPinned', { id: 'nope', pinned: true }),
        op('markUnwritable', { id: 'p1' }),
        op('markUnwritable', { id: 'p1' }),
        op('listProjects'),
        op('removeFromList', { id: 'p3' }),
        op('listProjects'),
        op('isUnwritable', { id: 'p1' }),
        op('removeFromList', { id: 'p1' }),
        op('isUnwritable', { id: 'p1' }),
        settingsFile,
      ],
      {
        settings: stored({
          list: [
            entry('p1', 'alpha', { lastUsedAt: '2026-03-01T00:00:00.000Z' }),
            entry('p2', 'beta', { lastUsedAt: '2026-05-01T00:00:00.000Z' }),
            entry('p3', 'gamma', { pinned: true, lastUsedAt: '2026-02-01T00:00:00.000Z' }),
            entry('p4', 'gone', { lastUsedAt: '2026-04-01T00:00:00.000Z' }),
            entry('p5', 'delta', { lastUsedAt: '2026-05-01T00:00:00.000Z' }),
          ],
          trust: { p1: used(), p3: used() },
        }),
      },
    ),
    {
      'alpha/.seuoffice/project.json': projectFile('p1', 'Alpha Project'),
      'beta/b.txt': 'b',
      'gamma/.seuoffice/project.json': projectFile('p3', 'Gamma'),
      'delta/d.txt': 'd',
    },
  ),
  scenario(
    'an empty registry: the install id is made once and stored',
    run(
      [
        op('listProjects'),
        op('installId'),
        op('installId'),
        op('trustState', { id: 'nope' }),
        op('projectRoot', { id: 'nope' }),
        op('isUnwritable', { id: 'nope' }),
        settingsFile,
      ],
      { ids: ['inst-new', 'unused'] },
    ),
  ),
  scenario(
    'every refusal of "add folder", then a good folder',
    run(
      [
        op('addFolder', { path: 'proj' }),
        op('addFolder', { path: 5 }),
        op('addFolder', { path: `${D}/nothing` }),
        op('addFolder', { path: `${D}/afile.txt` }),
        op('addFolder', { path: `${D}/home` }),
        op('addFolder', { path: `${D}/userData` }),
        op('addFolder', { path: `${D}/home/.claude/sub` }),
        op('addFolder', { path: D }),
        op('addFolder', { path: '/' }),
        op('addFolder', { path: `${D}/proj` }),
        op('addFolder', { path: `${D}/proj` }),
        op('listProjects'),
      ],
      { ids: ['n1', 'n2'], settings: stored() },
    ),
    { 'proj/a.txt': 'x', 'afile.txt': 'x', 'home/.claude/sub/x': 'x' },
  ),
  scenario(
    'the trust prompt: use, without, closed, asked again, nothing to ask',
    run(
      [
        op('addFolder', { path: `${D}/fa` }),
        op('addFolder', { path: `${D}/fb` }),
        op('addFolder', { path: `${D}/fc` }),
        op('listProjects'),
        op('queueTrust', { answers: ['use'] }),
        op('addFolder', { path: `${D}/fc` }),
        op('addFolder', { path: `${D}/fd` }),
        op('addFolder', { path: `${D}/fe` }),
        op('addFolder', { path: `${D}/fa` }),
        op('readContext', { id: 'n1' }),
        op('readContext', { id: 'n2' }),
        op('readContext', { id: 'n4' }),
        settingsFile,
      ],
      {
        ids: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'],
        settings: stored(),
        trust: ['use', 'without', null],
      },
    ),
    {
      'fa/AGENTS.md': 'Use tabs.\n',
      'fb/CLAUDE.md': 'Prefer short answers.\n',
      'fc/.seuoffice/instructions.md': 'Answer in Korean.\n',
      'fd/plain.txt': 'x',
      'fe/.seuoffice/memory.md': MEMORY,
    },
  ),
  scenario(
    'a chat another install wrote is shown in the prompt',
    run([op('addFolder', { path: `${D}/ff` }), op('readContext', { id: 'n1' }), settingsFile], {
      ids: ['n1'],
      settings: stored(),
      trust: ['without'],
    }),
    {
      'ff/.seuoffice/chats/c1.json': JSON.stringify({
        id: 'c1',
        projectId: 'n1',
        title: 'Plan',
        updatedAt: OLD,
        origin: 'other-install',
      }),
      'ff/.seuoffice/chats/c1.jsonl': `${JSON.stringify({ origin: 'other-install', text: 'hi' })}\n`,
    },
  ),
  scenario(
    'identity: a copy takes a new id, a moved folder keeps its own, a known one is existing',
    run(
      [
        op('addFolder', { path: `${D}/copy` }),
        op('addFolder', { path: `${D}/moved` }),
        op('addFolder', { path: `${D}/orig` }),
        op('getSettings', { id: 'p1-copy' }),
        op('listProjects'),
        settingsFile,
      ],
      {
        ids: ['p1-copy'],
        settings: stored({
          list: [entry('p1', 'orig'), entry('p2', 'gone2')],
          trust: { p1: used({ agents: sha(AGENTS) }), p2: used() },
          settings: { p1: { memoryEnabled: false, readAgentsFiles: true } },
          optedOutDocuments: { [`${D}/gone2/doc.docx`]: { projectId: 'p2' } },
        }),
      },
    ),
    {
      'orig/.seuoffice/project.json': projectFile('p1', 'Original'),
      'orig/AGENTS.md': AGENTS,
      'copy/.seuoffice/project.json': projectFile('p1', 'Original'),
      'copy/AGENTS.md': AGENTS,
      'moved/.seuoffice/project.json': projectFile('p2', 'Mover'),
      'moved/doc.txt': 'x',
    },
  ),
  scenario(
    'a folder whose project.json names another id replaces the stale entry at its path',
    run([op('addFolder', { path: `${D}/proj` }), op('listProjects'), settingsFile], {
      settings: stored({ list: [entry('p1', 'proj')], trust: { p1: used() } }),
    }),
    { 'proj/.seuoffice/project.json': projectFile('p2', 'Renamed Elsewhere') },
  ),
  scenario(
    'relocate: the same project moves, another project is refused, an unknown id throws',
    run(
      [
        op('relocate', { id: 'p3', path: `${D}/other` }),
        op('relocate', { id: 'p3', path: `${D}/p4dir` }),
        op('relocate', { id: 'p3', path: `${D}/found` }),
        op('relocate', { id: 'p3', path: `${D}/found` }),
        op('relocate', { id: 'p3', path: 5 }),
        op('relocate', { id: 'nope', path: `${D}/found` }),
        op('relocate', { id: 'nope', path: 5 }),
        op('listProjects'),
      ],
      {
        settings: stored({
          list: [entry('p3', 'lost'), entry('p4', 'p4dir')],
          trust: { p3: used(), p4: used() },
        }),
      },
    ),
    {
      'found/x.txt': 'x',
      'other/.seuoffice/project.json': projectFile('p9', 'Other'),
      'p4dir/.seuoffice/project.json': projectFile('p4', 'Four'),
    },
  ),
  scenario(
    'a copy whose project.json cannot be written is listed unwritable until the id is fixed',
    run(
      [
        op('addFolder', { path: `${D}/copyro` }),
        op('listProjects'),
        op('retryUnwritable', { id: 'c2' }),
        op('removeFromList', { id: 'p1' }),
        op('fsChmod', { path: `${D}/copyro/.seuoffice`, mode: 0o755 }),
        op('retryUnwritable', { id: 'c2' }),
        op('isUnwritable', { id: 'c2' }),
        op('readContext', { id: 'c2' }),
      ],
      {
        ids: ['c2'],
        settings: stored({ list: [entry('p1', 'orig')], trust: { p1: used() } }),
      },
    ),
    {
      'orig/.seuoffice/project.json': projectFile('p1', 'Original'),
      'copyro/.seuoffice': { dir: true, mode: 0o555 },
      'copyro/.seuoffice/project.json': projectFile('p1', 'Original'),
    },
  ),
  scenario(
    'new project: the name rules, the folder, an existing folder, the parent',
    run(
      [
        op('createProject', { args: { name: '' } }),
        op('createProject', { args: { name: '..' } }),
        op('createProject', { args: { name: 'a/b' } }),
        op('createProject', { args: { name: 'bad?name' } }),
        op('createProject', { args: { name: 'x'.repeat(129) } }),
        op('createProject', { args: { name: 123 } }),
        op('createProject', { args: { name: '  Plan  ' } }),
        op('createProject', { args: { name: 'Plan' } }),
        op('createProject', { args: { name: 'Old' } }),
        op('createProject', { args: { name: 'Old', useExisting: true } }),
        op('createProject', { args: { name: 'Elsewhere', parentDir: `${D}/missing` } }),
        op('createProject', { args: { name: 'Elsewhere', parentDir: 'relative' } }),
        op('createProject', { args: { name: 'Elsewhere', parentDir: `${D}/home/.claude` } }),
        op('createProject', { args: { name: 'Sub', parentDir: `${D}/afile.txt` } }),
        op('createProject', { args: { name: 'Spaced  Out' } }),
        op('createProject', { args: { name: 'Default One', parentDir: null } }),
        op('createProject', { args: { name: 'n'.repeat(128) } }),
        op('listProjects'),
        settingsFile,
      ],
      { ids: ['np1', 'np2', 'np3', 'np4', 'np5', 'np6'], settings: stored() },
    ),
    { 'parent/Old/keep.txt': 'x', 'afile.txt': 'x' },
  ),
  scenario(
    'rename and retry: the file keeps its creation time, a missing one is made',
    run(
      [
        op('renameProject', { id: 'p1', name: 'New  Name\n' }),
        op('renameProject', { id: 'p2', name: 'Beta' }),
        op('renameProject', { id: 'p1', name: '   ' }),
        op('renameProject', { id: 'nope', name: 'x' }),
        op('renameProject', { id: 'p1', name: 'L'.repeat(200) }),
        op('markUnwritable', { id: 'p1' }),
        op('renameProject', { id: 'p1', name: 'Blocked' }),
        op('retryUnwritable', { id: 'p1' }),
        op('retryUnwritable', { id: 'nope' }),
        op('listProjects'),
      ],
      {
        settings: stored({
          list: [entry('p1', 'alpha'), entry('p2', 'beta')],
          trust: { p1: used(), p2: used() },
        }),
      },
    ),
    {
      'alpha/.seuoffice/project.json': projectFile('p1', 'Alpha', '2020-02-02T02:02:02.000Z'),
      'beta/b.txt': 'b',
    },
  ),
  scenario(
    'context: trusted texts, a file changed outside, long memory and instructions',
    run(
      [
        op('readContext', { id: 'p1' }),
        op('readContext', { id: 'p2' }),
        op('readContext', { id: 'p3' }),
        op('readContext', { id: 'p4' }),
        op('readContext', { id: 'nope' }),
        op('fsWrite', { path: `${D}/alpha/.seuoffice/instructions.md`, text: 'Changed.\n' }),
        op('readContext', { id: 'p1' }),
        op('readContext', { id: 'p1' }),
        op('fsWrite', {
          path: `${D}/alpha/.seuoffice/memory.md`,
          text: `${MEMORY_HEADER}\n- ${'long '.repeat(2000)}\n`,
        }),
        op('readContext', { id: 'p1' }),
        op('fsWrite', {
          path: `${D}/alpha/.seuoffice/instructions.md`,
          text: 'I'.repeat(40_000),
        }),
        op('readContext', { id: 'p1' }),
        op('setSettings', { id: 'p1', patch: { readAgentsFiles: false } }),
        op('readContext', { id: 'p1' }),
        op('setSettings', { id: 'p1', patch: { memoryEnabled: false } }),
        op('markUnwritable', { id: 'p1' }),
        op('readContext', { id: 'p1' }),
        settingsFile,
      ],
      {
        settings: stored({
          list: [
            entry('p1', 'alpha'),
            entry('p2', 'beta'),
            entry('p3', 'ghost'),
            entry('p4', 'beta2'),
          ],
          trust: {
            p1: used({
              instructions: sha('Be brief.\n'),
              memory: sha(MEMORY),
              agents: sha(AGENTS),
            }),
            p2: without(),
            p3: used(),
          },
        }),
      },
    ),
    {
      'alpha/.seuoffice/project.json': projectFile('p1', 'Alpha Project'),
      'alpha/.seuoffice/instructions.md': 'Be brief.\n',
      'alpha/.seuoffice/memory.md': MEMORY,
      'alpha/AGENTS.md': AGENTS,
      'beta/.seuoffice/instructions.md': 'Hidden by trust.\n',
      'beta/AGENTS.md': AGENTS,
      'beta2/AGENTS.md': AGENTS,
    },
  ),
  scenario(
    'context files and the ignore rule',
    run(
      [
        op('readContext', { id: 'p1' }),
        op('aiVisibility', {
          id: 'p1',
          probes: [
            ['a.md'],
            ['secret.txt'],
            ['.hidden'],
            ['.seuoffice/x'],
            ['sub/deep.md'],
            ['sub', true],
          ],
        }),
        op('addIgnore', { id: 'p1', rel: 'sub' }),
        op('readContext', { id: 'p1' }),
        op('aiVisibility', { id: 'p1', probes: [['sub/deep.md'], ['SECRET.txt']] }),
        op('aiVisibility', { id: 'nope' }),
      ],
      {
        contextFiles: {
          probes: ['a.md', 'secret.txt', '.hidden', 'sub/deep.md'],
          omitted: 3,
        },
        settings: stored({ list: [entry('p1', 'alpha')], trust: { p1: used() } }),
      },
    ),
    {
      'alpha/.seuoffice/project.json': projectFile('p1', 'Alpha'),
      'alpha/.seuoffice/ignore': 'secret.txt\n',
      'alpha/a.md': 'a',
      'alpha/secret.txt': 's',
      'alpha/.hidden': 'h',
      'alpha/sub/deep.md': 'd',
    },
  ),
  scenario(
    'the ignore rule folds case on macOS',
    run(
      [
        op('addIgnore', { id: 'p1', rel: 'Sub/Deep.md' }),
        op('aiVisibility', { id: 'p1', probes: [['sub/deep.md'], ['Sub/Deep.md'], ['other.md']] }),
      ],
      {
        platform: 'darwin',
        settings: stored({ list: [entry('p1', 'alpha')], trust: { p1: used() } }),
      },
    ),
    { 'alpha/.seuoffice/project.json': projectFile('p1', 'Alpha') },
  ),
  scenario(
    'sync folders: the notice once, the service, the list flag',
    run(
      [
        op('listProjects'),
        op('readContext', { id: 'p1' }),
        op('readContext', { id: 'p1' }),
        op('readContext', { id: 'p2' }),
        op('addFolder', { path: `${D}/od/second` }),
        settingsFile,
      ],
      {
        env: { OneDrive: `${D}/od` },
        ids: ['s1'],
        settings: stored({
          list: [entry('p1', 'od/proj'), entry('p2', 'plain')],
          trust: { p1: used(), p2: used() },
        }),
      },
    ),
    { 'od/proj/a.txt': 'a', 'od/second/b.txt': 'b', 'plain/c.txt': 'c' },
  ),
  scenario(
    'sync folders on macOS: Google Drive under CloudStorage',
    run(
      [
        op('addFolder', { path: `${D}/home/Library/CloudStorage/GoogleDrive-me/proj` }),
        op('listProjects'),
        op('readContext', { id: 'g1' }),
      ],
      { platform: 'darwin', ids: ['g1'], settings: stored() },
    ),
    { 'home/Library/CloudStorage/GoogleDrive-me/proj/a.txt': 'a' },
  ),
  scenario(
    'use times: written at most once per interval, the rest wait for the timer',
    run(
      [
        op('readContext', { id: 'p1' }),
        op('settingsFile'),
        op('readContext', { id: 'p1' }),
        op('touchTimer'),
        op('listProjects'),
        op('settingsFile'),
        op('readContext', { id: 'p2' }),
        op('touchTimer'),
        op('settingsFile'),
        op('readContext', { id: 'p2' }),
        op('touchTimer'),
        op('fireTimer'),
        op('touchTimer'),
        op('settingsFile'),
        op('setSelection', { target: { kind: 'untitled', projectId: null }, projectId: 'p1' }),
        op('touchTimer'),
        op('flushTouches'),
        op('touchTimer'),
        op('settingsFile'),
        op('flushTouches'),
      ],
      {
        tickMs: 1000,
        touchWriteMs: 10_000,
        settings: stored({
          list: [entry('p1', 'alpha'), entry('p2', 'beta')],
          trust: { p1: used(), p2: used() },
        }),
      },
    ),
    { 'alpha/a.txt': 'a', 'beta/b.txt': 'b' },
  ),
  scenario(
    'use times at the edge of the interval',
    run(
      [
        op('readContext', { id: 'p1' }),
        op('clock', { ms: NOW + 9999 }),
        op('readContext', { id: 'p1' }),
        op('touchTimer'),
        op('settingsFile'),
        op('clock', { ms: NOW + 10_000 }),
        op('readContext', { id: 'p1' }),
        op('touchTimer'),
        op('settingsFile'),
      ],
      {
        touchWriteMs: 10_000,
        settings: stored({ list: [entry('p1', 'alpha')], trust: { p1: used() } }),
      },
    ),
    { 'alpha/a.txt': 'a' },
  ),
  scenario(
    'a new id that is already used is skipped, an invalid one throws',
    run(
      [
        op('addFolder', { path: `${D}/plain1` }),
        op('addFolder', { path: `${D}/plain2` }),
        op('addFolder', { path: `${D}/plain3` }),
        op('listProjects'),
      ],
      {
        ids: ['p1', 'p7', 'fresh1', 'bad id', 'fresh2'],
        settings: stored({ list: [entry('p1', 'alpha')], trust: { p7: used() } }),
      },
    ),
    { 'plain1/a.txt': 'a', 'plain2/b.txt': 'b', 'plain3/c.txt': 'c' },
  ),
  scenario(
    'the project screen: detail, conflict copies, settings',
    run(
      [
        op('detail', { id: 'p1' }),
        op('detail', { id: 'nope' }),
        op('getSettings', { id: 'p1' }),
        op('setSettings', { id: 'p1', patch: { memoryEnabled: false } }),
        op('setSettings', { id: 'p1', patch: { readAgentsFiles: 'no', memoryEnabled: null } }),
        op('setSettings', { id: 'p1', patch: { readAgentsFiles: false } }),
        op('setSettings', { id: 'p2', patch: {} }),
        op('getSettings', { id: 'nope' }),
        op('detail', { id: 'p1' }),
        settingsFile,
      ],
      {
        settings: stored({
          list: [entry('p1', 'alpha'), entry('p2', 'beta')],
          trust: { p1: used() },
        }),
      },
    ),
    {
      'alpha/.seuoffice/project.json': projectFile('p1', 'Alpha Project'),
      'alpha/.seuoffice/instructions.md': 'Do X.\n',
      'alpha/.seuoffice/memory.md': MEMORY,
      'alpha/.seuoffice/memory (conflict).md': '- conflicting (2026-01-04)\n',
      'alpha/.seuoffice/memory.20260101-101010.bak.md': '- old\n',
      'alpha/.seuoffice/memory.old.md': '- older\n',
      'alpha/AGENTS.md': AGENTS,
      'alpha/CLAUDE.md': 'Claude file.\n',
      'beta/b.txt': 'b',
    },
  ),
  scenario(
    'trust from the project screen: without, use with a prompt, closed, nothing to ask',
    run(
      [
        op('decideTrust', { id: 'p1', decision: 'use' }),
        op('decideTrust', { id: 'p1', decision: 'use' }),
        op('decideTrust', { id: 'p1', decision: 'without' }),
        op('decideTrust', { id: 'p1', decision: 'use' }),
        op('decideTrust', { id: 'p1', decision: 'use' }),
        op('decideTrust', { id: 'p2', decision: 'use' }),
        op('decideTrust', { id: 'p3', decision: 'without' }),
        op('decideTrust', { id: 'nope', decision: 'use' }),
        op('trustState', { id: 'p1' }),
        op('trustState', { id: 'p2' }),
        op('trustState', { id: 'p3' }),
        settingsFile,
      ],
      {
        trust: ['use', null, 'without'],
        settings: stored({
          list: [entry('p1', 'fa'), entry('p2', 'fb'), entry('p3', 'fb')],
          trust: { p1: without({ agents: 'old-hash' }) },
        }),
      },
    ),
    { 'fa/AGENTS.md': 'Use tabs.\n', 'fb/plain.txt': 'x' },
  ),
  scenario(
    'instructions and ignore lines: the folder is made by the first write',
    run(
      [
        op('saveInstructions', { id: 'p1', text: 'Hello\n' }),
        settingsFile,
        op('addIgnore', { id: 'p1', rel: 'sub/b.txt' }),
        op('addIgnore', { id: 'p1', rel: 'sub/b.txt' }),
        op('addIgnore', { id: 'p1', rel: '' }),
        op('addIgnore', { id: 'p1', rel: '/abs' }),
        op('addIgnore', { id: 'p1', rel: 'C:x' }),
        op('addIgnore', { id: 'p1', rel: '../x' }),
        op('addIgnore', { id: 'p1', rel: 'a\\..\\b' }),
        op('addIgnore', { id: 'p1', rel: 'a*.txt' }),
        op('removeIgnore', { id: 'p1', rel: 'sub/b.txt' }),
        op('removeIgnore', { id: 'p1', rel: 'sub/b.txt' }),
        op('removeIgnore', { id: 'p1', rel: 'a*.txt' }),
        op('removeIgnore', { id: 'p1', rel: '..' }),
        op('removeIgnore', { id: 'p2', rel: 'x' }),
        op('addIgnore', { id: 'p2', rel: 'x' }),
        op('saveInstructions', { id: 'nope', text: 'x' }),
      ],
      {
        settings: stored({
          list: [entry('p1', 'alpha'), entry('p2', 'beta')],
          trust: { p1: used(), p2: used() },
        }),
      },
    ),
    { 'alpha/a.txt': 'a', 'alpha/sub/b.txt': 'b', 'beta/b.txt': 'b' },
  ),
  scenario(
    'memory edits: add, replace, remove, the refusals',
    run(
      [
        op('editMemory', { id: 'p1', change: { op: 'add', text: 'new fact' }, by: 'ai' }),
        op('editMemory', { id: 'p1', change: { op: 'add', text: 'new fact' }, by: 'ai' }),
        op('editMemory', { id: 'p1', change: { op: 'add', text: '  ' }, by: 'ai' }),
        op('editMemory', {
          id: 'p1',
          change: { op: 'replace', old: 'zzz', new: 'y' },
          by: 'person',
        }),
        op('editMemory', {
          id: 'p1',
          change: { op: 'replace', old: 'prefers tables', new: 'prefers charts' },
          by: 'person',
        }),
        op('editMemory', {
          id: 'p1',
          change: { op: 'remove', text: 'writes in Korean' },
          by: 'person',
        }),
        op('editMemory', { id: 'p1', change: { op: 'remove', text: 'zzz' }, by: 'person' }),
        op('editMemory', { id: 'p2', change: { op: 'add', text: 'x' }, by: 'ai' }),
        op('editMemory', { id: 'p3', change: { op: 'add', text: 'x' }, by: 'ai' }),
        op('editMemory', { id: 'p2', change: { op: 'add', text: 'by person' }, by: 'person' }),
        op('markUnwritable', { id: 'p1' }),
        op('editMemory', { id: 'p1', change: { op: 'add', text: 'x' }, by: 'person' }),
        op('saveMemory', { id: 'p1', text: 'x' }),
        op('editMemory', { id: 'nope', change: { op: 'add', text: 'x' }, by: 'person' }),
        op('saveMemory', { id: 'p3', text: `${MEMORY_HEADER}\n- edited by hand\n` }),
        op('detail', { id: 'p1' }),
        settingsFile,
      ],
      {
        settings: stored({
          list: [entry('p1', 'alpha'), entry('p2', 'beta'), entry('p3', 'gamma')],
          trust: { p1: used(), p2: without(), p3: used() },
          settings: { p3: { memoryEnabled: false, readAgentsFiles: true } },
        }),
      },
    ),
    {
      'alpha/.seuoffice/project.json': projectFile('p1', 'Alpha'),
      'alpha/.seuoffice/memory.md': MEMORY,
      'beta/b.txt': 'b',
      'gamma/g.txt': 'g',
    },
  ),
  scenario(
    'a new memory file starts with the header in the screen language',
    run(
      [
        op('editMemory', { id: 'p1', change: { op: 'add', text: '기억할 것' }, by: 'ai' }),
        op('editMemory', { id: 'p1', change: { op: 'remove', text: 'zzz' }, by: 'person' }),
      ],
      {
        language: 'ko-KR',
        settings: stored({ list: [entry('p1', 'alpha')], trust: { p1: used() } }),
      },
    ),
    { 'alpha/a.txt': 'a' },
  ),
  scenario(
    'consolidation: a backup first, the newest three stay, the undo line restores it',
    run(
      [
        op('consolidate', { id: 'p1', entries: ['a', 'b\nc', '- d (2025-01-01)', '', '  '] }),
        op('undo', { id: 'p1', backupName: 'memory.20261112-030001.bak.md' }),
        op('undo', { id: 'p1', backupName: 'memory.20261112-030001.bak.md' }),
        op('consolidate', { id: 'p1', entries: ['only'] }),
        op('undo', { id: 'p1', backupName: 'memory.20261112-030001.bak.md' }),
        op('undo', { id: 'p1', backupName: 'memory.20261112-030002.bak.md' }),
        op('undo', { id: 'p1', backupName: 'not a name' }),
        op('undo', { id: 'p1', backupName: null }),
        op('undo', { id: 'nope', backupName: 'memory.20261112-030001.bak.md' }),
        op('consolidate', { id: 'nope', entries: [] }),
        op('consolidate', { id: 'p1', entries: 'nope' }),
        op('consolidate', { id: 'p1', entries: [1] }),
        op('markUnwritable', { id: 'p1' }),
        op('consolidate', { id: 'p1', entries: ['x'] }),
        op('undo', { id: 'p1', backupName: 'memory.20261112-030001.bak.md' }),
        settingsFile,
      ],
      {
        settings: stored({ list: [entry('p1', 'alpha')], trust: { p1: used() } }),
      },
    ),
    {
      'alpha/.seuoffice/project.json': projectFile('p1', 'Alpha'),
      'alpha/.seuoffice/memory.md': MEMORY,
      'alpha/.seuoffice/memory.20260101-000001.bak.md': '- one\n',
      'alpha/.seuoffice/memory.20260101-000002.bak.md': '- two\n',
      'alpha/.seuoffice/memory.20260101-000003.bak.md': '- three\n',
      'alpha/.seuoffice/memory.20261112-030000.bak.md': '- same second\n',
    },
  ),
  scenario(
    'consolidation of a project without memory, and the clock moving between runs',
    run(
      [
        op('consolidate', { id: 'p1', entries: ['first'] }),
        op('clock', { ms: NOW + 90_000 }),
        op('consolidate', { id: 'p1', entries: ['second'] }),
        op('undo', { id: 'p1', backupName: 'memory.20261112-030130.bak.md' }),
        op('detail', { id: 'p1' }),
      ],
      {
        tickMs: 0,
        language: 'ko',
        settings: stored({ list: [entry('p1', 'alpha')], trust: { p1: used() } }),
      },
    ),
    { 'alpha/a.txt': 'a' },
  ),
  scenario(
    'writes into the data folder: each kind, the paths, the refusals',
    run(
      [
        op('writeData', { id: 'p1', rel: 'notes/a.md', text: 'hi' }),
        op('appendData', { id: 'p1', rel: 'chats/c.jsonl', text: 'l1\n' }),
        op('appendData', { id: 'p1', rel: 'chats/c.jsonl', text: 'l2\n' }),
        op('updateData', { id: 'p1', rel: 'notes/a.md', mode: 'append', text: '!' }),
        op('updateData', { id: 'p1', rel: 'notes/a.md', mode: 'keep' }),
        op('updateData', { id: 'p1', rel: 'new.md', mode: 'set', text: 'N' }),
        op('updateData', { id: 'p1', rel: 'absent.md', mode: 'keep' }),
        op('removeData', { id: 'p1', rel: 'new.md' }),
        op('removeData', { id: 'p1', rel: 'new.md' }),
        op('dataPath', { id: 'p1', rel: 'x/y.md' }),
        op('dataPath', { id: 'p1', rel: '../x' }),
        op('dataPath', { id: 'nope', rel: 'x' }),
        op('writeData', { id: 'p1', rel: 'project.json', text: 'x' }),
        op('writeData', { id: 'p1', rel: 'Project.JSON', text: 'x' }),
        op('writeData', { id: 'p1', rel: 'sub\\PROJECT.json', text: 'x' }),
        op('appendData', { id: 'p1', rel: 'project.json', text: 'x' }),
        op('updateData', { id: 'p1', rel: 'project.json', mode: 'set', text: 'x' }),
        op('removeData', { id: 'p1', rel: 'project.json' }),
        op('writeData', { id: 'nope', rel: 'a', text: 'x' }),
        op('writeData', { id: 'p1', rel: 'old.md', text: 'old', dataDir: '.ieumoffice' }),
        op('writeData', { id: 'p1', rel: 'bad.md', text: 'x', dataDir: 'bogus' }),
        op('dataPath', { id: 'p1', rel: 'x', dataDir: '.ieumoffice' }),
        op('writeNewDocument', { id: 'p1', target: `${D}/alpha/new.docx`, text: 'doc' }),
        op('writeNewDocument', { id: 'p1', target: `${D}/alpha/new.docx`, text: 'doc' }),
        op('writeNewDocument', { id: 'p1', target: `${D}/alpha/.seuoffice/x.docx`, text: 'x' }),
        op('writeNewDocument', { id: 'p1', target: `${D}/other/x.docx`, text: 'x' }),
        op('writeNewDocument', { id: 'nope', target: `${D}/alpha/x.docx`, text: 'x' }),
        op('documentRelativePath', { id: 'p1', doc: `${D}/alpha/sub/doc.docx` }),
        op('documentRelativePath', { id: 'p1', doc: `${D}/other/doc.docx` }),
        op('documentRelativePath', { id: 'nope', doc: `${D}/alpha/doc.docx` }),
        op('updateData', { id: 'p1', rel: 'notes/a.md', mode: 'throw' }),
        op('isUnwritable', { id: 'p1' }),
        op('writeData', { id: 'p1', rel: 'after.md', text: 'x' }),
      ],
      {
        settings: stored({ list: [entry('p1', 'alpha')], trust: { p1: used() } }),
      },
    ),
    { 'alpha/a.txt': 'a', 'other/o.txt': 'o' },
  ),
  scenario(
    'a project.json that names another id is fixed only when that id is a listed project elsewhere',
    run(
      [
        op('saveInstructions', { id: 'p2', text: 'two' }),
        op('saveInstructions', { id: 'p1', text: 'one' }),
        op('saveInstructions', { id: 'p3', text: 'three' }),
        op('saveInstructions', { id: 'p4', text: 'four' }),
        op('saveInstructions', { id: 'p5', text: 'five' }),
      ],
      {
        settings: stored({
          list: [
            entry('p1', 'orig'),
            entry('p2', 'copy'),
            entry('p3', 'bad'),
            entry('p4', 'other'),
            entry('p5', 'empty'),
          ],
          trust: { p1: used(), p2: used(), p3: used(), p4: used(), p5: used() },
        }),
      },
    ),
    {
      'orig/.seuoffice/project.json': projectFile('p1', 'Orig'),
      'copy/.seuoffice/project.json': projectFile('p1', 'Orig'),
      'bad/.seuoffice/project.json': '{not json',
      'other/.seuoffice/project.json': projectFile('zzz', 'Z'),
      'empty/.seuoffice/project.json': projectFile('p5', 'Empty'),
    },
  ),
  scenario(
    'a data folder that cannot be written marks the project unwritable until it is retried',
    run(
      [
        op('saveInstructions', { id: 'p1', text: 'a' }),
        op('saveInstructions', { id: 'p1', text: 'b' }),
        op('isUnwritable', { id: 'p1' }),
        op('readContext', { id: 'p1' }),
        op('addIgnore', { id: 'p1', rel: 'x' }),
        op('retryUnwritable', { id: 'p1' }),
        op('fsRemove', { path: `${D}/alpha/.seuoffice` }),
        op('retryUnwritable', { id: 'p1' }),
        op('saveInstructions', { id: 'p1', text: 'c' }),
        op('readContext', { id: 'p1' }),
      ],
      {
        settings: stored({ list: [entry('p1', 'alpha')], trust: { p1: used() } }),
      },
    ),
    { 'alpha/.seuoffice': 'a file where the data folder belongs' },
  ),
  scenario(
    'a project an older version made keeps its data folder name',
    run(
      [
        op('detail', { id: 'p1' }),
        op('readContext', { id: 'p1' }),
        op('saveInstructions', { id: 'p1', text: 'new text\n' }),
        op('editMemory', { id: 'p1', change: { op: 'add', text: 'old home' }, by: 'person' }),
        op('consolidate', { id: 'p1', entries: ['x'] }),
        op('listProjects'),
      ],
      {
        settings: stored({ list: [entry('p1', 'alpha')], trust: { p1: used() } }),
      },
    ),
    {
      'alpha/.ieumoffice/project.json': projectFile('p1', 'Legacy'),
      'alpha/.ieumoffice/instructions.md': 'old text\n',
      'alpha/.ieumoffice/memory.md': MEMORY,
    },
  ),
  scenario(
    'selection: inside, outside, untitled, home; the choices that are remembered',
    run(
      [
        op('selection', { target: { kind: 'document', path: `${D}/proj/a.docx` } }),
        op('selection', { target: { kind: 'document', path: `${D}/proj/b.docx` } }),
        op('selection', { target: { kind: 'document', path: `${D}/other/a.docx` } }),
        op('selection', { target: { kind: 'document', path: `${D}/hintfolder/sub/x.docx` } }),
        op('selection', { target: { kind: 'untitled', projectId: 'p1' } }),
        op('selection', { target: { kind: 'untitled', projectId: null } }),
        op('selection', { target: { kind: 'home' } }),
        op('selection', { target: { kind: 'document', path: 'relative.docx' } }),
        op('setSelection', {
          target: { kind: 'document', path: `${D}/proj/a.docx` },
          projectId: null,
        }),
        op('setSelection', {
          target: { kind: 'document', path: `${D}/proj/a.docx` },
          projectId: 'p1',
        }),
        op('setSelection', {
          target: { kind: 'document', path: `${D}/other/a.docx` },
          projectId: 'p2',
        }),
        op('setSelection', { target: { kind: 'home' }, projectId: 'p2' }),
        op('setSelection', { target: { kind: 'home' }, projectId: null }),
        op('setSelection', {
          target: { kind: 'document', path: `${D}/proj/a.docx` },
          projectId: 'p2',
        }),
        op('setSelection', { target: { kind: 'untitled', projectId: null }, projectId: 'nope' }),
        op('recordOutsideChat', { doc: `${D}/other/a.docx`, projectId: 'p2', chatId: 'chat2' }),
        op('recordOutsideChat', { doc: `${D}/other/a.docx`, projectId: 'p2', chatId: 'bad id' }),
        op('recordOutsideChat', { doc: 'relative.docx', projectId: 'p2', chatId: 'chat3' }),
        op('selection', { target: { kind: 'document', path: `${D}/other/a.docx` } }),
        settingsFile,
      ],
      {
        settings: stored({
          list: [entry('p1', 'proj'), entry('p2', 'proj2')],
          trust: { p1: used(), p2: used() },
          outsideDocuments: { [`${D}/other/a.docx`]: { projectId: 'p1', lastChatId: 'chat1' } },
          optedOutDocuments: { [`${D}/proj/b.docx`]: { projectId: 'p1' } },
          homeProjectId: 'p1',
        }),
      },
    ),
    {
      'proj/.seuoffice/project.json': projectFile('p1', 'Proj'),
      'proj/a.docx': 'a',
      'proj2/.seuoffice/project.json': projectFile('p2', 'Proj Two'),
      'other/a.docx': 'o',
      'hintfolder/.seuoffice/project.json': projectFile('h0', 'Hinted'),
      'hintfolder/sub/x.docx': 'x',
    },
  ),
  scenario(
    'the folder hint: "[use]" adds the folder and the document uses it',
    run(
      [
        op('adoptHint', { doc: `${D}/other/a.docx` }),
        op('adoptHint', { doc: `${D}/hintfolder/sub/x.docx` }),
        op('selection', { target: { kind: 'document', path: `${D}/hintfolder/sub/x.docx` } }),
        op('listProjects'),
        op('adoptHint', { doc: 'relative.docx' }),
        settingsFile,
      ],
      { ids: ['h1'], settings: stored(), trust: ['use'] },
    ),
    {
      'other/a.docx': 'o',
      'hintfolder/.seuoffice/project.json': projectFile('h1', 'Hinted'),
      'hintfolder/.seuoffice/instructions.md': 'Hint rules.\n',
      'hintfolder/sub/x.docx': 'x',
    },
  ),
  scenario(
    'the hint with a closed trust prompt leaves the document alone',
    run(
      [
        op('adoptHint', { doc: `${D}/hintfolder/sub/x.docx` }),
        op('selection', { target: { kind: 'document', path: `${D}/hintfolder/sub/x.docx` } }),
        op('listProjects'),
      ],
      { ids: ['h1'], settings: stored(), trust: [null] },
    ),
    {
      'hintfolder/.seuoffice/project.json': projectFile('h1', 'Hinted'),
      'hintfolder/AGENTS.md': AGENTS,
      'hintfolder/sub/x.docx': 'x',
    },
  ),
  scenario(
    'an update that keeps the text does not make project.json',
    run(
      [
        op('updateData', { id: 'p1', rel: 'absent.md', mode: 'keep' }),
        op('updateData', { id: 'p1', rel: 'notes/a.md', mode: 'keep' }),
      ],
      { settings: stored({ list: [entry('p1', 'alpha')], trust: { p1: used() } }) },
    ),
    { 'alpha/a.txt': 'a', 'alpha/.seuoffice/notes/a.md': 'kept' },
  ),
  scenario(
    'the hint takes back the "no project" record of the document it adopts',
    run(
      [
        op('adoptHint', { doc: `${D}/hintfolder/sub/x.docx` }),
        op('selection', { target: { kind: 'document', path: `${D}/hintfolder/sub/x.docx` } }),
        settingsFile,
      ],
      {
        ids: ['h1'],
        settings: stored({
          optedOutDocuments: { [`${D}/hintfolder/sub/x.docx`]: { projectId: 'h1' } },
        }),
        trust: ['use'],
      },
    ),
    {
      'hintfolder/.seuoffice/project.json': projectFile('h1', 'Hinted'),
      'hintfolder/.seuoffice/instructions.md': 'Hint rules.\n',
      'hintfolder/sub/x.docx': 'x',
    },
  ),
]

export const guide: Group = {
  'project-guide.scenario': {
    ts: (args, cx) => runScenario(args[0] as Scenario, cx),
    cases,
  },
  'project-guide.PROJECT_TOUCH_WRITE_MS': constant(guideModule.PROJECT_TOUCH_WRITE_MS),
  'project-guide.MEMORY_BACKUPS_KEPT': constant(guideModule.MEMORY_BACKUPS_KEPT),
  'project-guide.MEMORY_SOFT_LIMIT_CHARS': constant(guideModule.MEMORY_SOFT_LIMIT_CHARS),
  'project-guide.INSTRUCTIONS_LIMIT_CHARS': constant(guideModule.INSTRUCTIONS_LIMIT_CHARS),
}
