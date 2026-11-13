/**
 * Group `a/user-skills`: the skills channels of the shell's main process
 * (`apps/shell/src/main/user-skills/user-skills-ipc.ts`, 32 invokes and the
 * events `skills:changed` and `skills:dropped`) and the template flow
 * (`template-tabs-ipc.ts`, 6 invokes and `skills:preview-ended`), configured
 * as the shell entry configures them: the entry's own statements
 * (`APP_SETTINGS_PATH`, `builtinSkillsDir`, `createUserSkillsService`,
 * `openSkillsSettings`, `registerUserSkillsIpc`, `createTemplateTabs`,
 * `registerTemplateTabsIpc`) run over the real modules and the fake Electron.
 *
 * What the Rust ports reach through batch hosts is stood in here:
 *
 * - `@seuoffice/ai-provider`: `prepareSkillImport`, `installImportedSkills`,
 *   `disposeSkillImport`, `checkGitHubSkillUpdate`, `applyGitHubSkillUpdate`,
 *   `exportSkillZip` and `exportSkillBundleZip` are forwarded to the case's
 *   stand-in (the Rust `SkillImporter` of crates/shell-ipc/a/src/probe/user_skills.rs
 *   is the same table, see its header for the `hosts.a.userSkills` keys); every
 *   other export is the real module's.
 * - the tab manager of the shell entry (`openTemplateCopyTab`, `tabManager`,
 *   `followOpenerProject`, `fileHasUnsavedChanges`): `hosts.a.userSkills.copyTabs`.
 * - `app.getAppPath()`: `hosts.a.userSkills.appPath`, `$DIR/app` by default.
 *
 * `os.homedir()` and `os.tmpdir()` are the case's `home` and `temp` folders
 * (patched while that folder is there), as `app.getPath` names them for the Rust side. The ids
 * `randomUUID()` makes in the IPC module and the entry are counted
 * (`00000000-0000-4000-8000-000000000001`, ...) and `Date.now()` is fixed, as
 * the Rust probe pins them, so a case can name the token of a preview.
 *
 * Not covered here (unit tests of the Rust port do): a window going away with
 * a preview waiting, a GitHub import or update check cancelled while it is on
 * the network (the harness waits for the workers, a stand-in that blocks until
 * the signal aborts would hold the Rust side), the busy answer for a second
 * GitHub call, and the preview tab closing unsaved (no case destroys a view).
 *
 * The drop queue is filled by the shell's drop handler, not by a channel: the
 * `a/skills-drop` trigger calls `userSkillsIpc.queueDropped(entry)` on both sides.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { SkillImportError } from '@seuoffice/ai-provider'
import { resetGenerateHandoffsForTest } from '@seuoffice/electron-utils/generate-handoff'
import {
  agentSkillNoticeDue,
  markAgentSkillNoticeSeen,
} from '../../../../apps/shell/src/main/app-settings.ts'
import { userSkillsManageGate } from '../../../../apps/shell/src/main/agent/agent-skills.ts'
import { atomicWriteFile } from '../../../../apps/shell/src/main/atomic-write.ts'
import { builtinSkillsDirFor } from '../../../../apps/shell/src/main/user-skills/builtin-dir.ts'
import { HOME_CHANNELS } from '../../../../apps/shell/src/shared/home-api.ts'
import type { Call, Case, Group, LoadContext, View } from '../../types.ts'
import { entryStatements } from './lib/entry-source.ts'
import os from 'node:os'

const REAL_HOMEDIR = os.homedir
const REAL_TMPDIR = os.tmpdir

const SERVICE = 'apps/shell/src/main/user-skills/user-skills-service.ts'
const SKILLS_IPC = 'apps/shell/src/main/user-skills/user-skills-ipc.ts'
const TABS = 'apps/shell/src/main/user-skills/template-tabs.ts'
const TABS_IPC = 'apps/shell/src/main/user-skills/template-tabs-ipc.ts'

/** The entry's statements, in its order */
const entryCode = entryStatements('apps/shell/src/main/index.ts', [
  'const APP_SETTINGS_PATH =',
  'const builtinSkillsDir =',
  'const userSkills = createUserSkillsService({',
  'function openSkillsSettings(',
  'const userSkillsIpc = registerUserSkillsIpc({',
  'const templateTabs = createTemplateTabs({',
  'registerTemplateTabsIpc(templateTabs)',
])

// ---- hosts.a.userSkills -----------------------------------------------------

interface CandidateSpec {
  key: string
  name?: string
  title?: string
  description?: string
  collision?: boolean
  problem?: string
  hasScripts?: boolean
  emptyBody?: boolean
}
interface ImportSpec {
  throw?: string
  importError?: string
  candidates?: CandidateSpec[]
  rootLicense?: string
}
interface CheckSpec extends ImportSpec {
  upToDate?: { commit?: string; locallyEdited?: boolean }
  changed?: {
    commit?: string
    locallyEdited?: boolean
    changedFiles?: { rel: string; change: string }[]
    update?: ImportSpec
  }
}
interface CopyTabsSpec {
  /** `null`: the tab could not open */
  open?: { tabId?: string; view?: number; ownsCopy?: boolean; throw?: string } | null
  files?: Record<string, string>
  openFiles?: { path: string; dirty: boolean }[] | 'fail'
  focusable?: string[]
}
interface Setup {
  appPath?: string
  prepare?: Record<string, ImportSpec>
  install?: { throw?: string; importError?: string; skipped?: string[] }
  check?: CheckSpec
  apply?: { throw?: string; importError?: string; name?: string }
  exportError?: string
  copyTabs?: CopyTabsSpec
}

/** `Date.now()` of the case */
const NOW = 1_700_000_000_000

const HOST = Symbol.for('ipc-diff.a.user-skills')
const AI_PROVIDER = 'ipc-diff:ai-provider'
/** the real module the stand-in re-exports, found when the specifier is first resolved */
let realAiProvider = ''
const FORWARDED = [
  'prepareSkillImport',
  'installImportedSkills',
  'disposeSkillImport',
  'checkGitHubSkillUpdate',
  'applyGitHubSkillUpdate',
  'exportSkillZip',
  'exportSkillBundleZip',
]
const forwarding = (names: string[]): string =>
  names
    .map(
      (n) =>
        `export const ${n} = (...args) => globalThis[Symbol.for('ipc-diff.a.user-skills')].${n}(...args)`,
    )
    .join('\n')

// synchronous hooks, as tools/main-diff/electron-fake.ts: they answer `import` and `require`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@seuoffice/ai-provider') {
      realAiProvider = next(specifier, context).url
      return { url: AI_PROVIDER, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === AI_PROVIDER) {
      const source = `export * from ${JSON.stringify(realAiProvider)}\n${forwarding(FORWARDED)}`
      return { format: 'module', source, shortCircuit: true }
    }
    return next(url, context)
  },
})

// ---- the ids ------------------------------------------------------------------

let counted = 0
const countedUuid = (): string => `00000000-0000-4000-8000-${String(++counted).padStart(12, '0')}`

/**
 * `randomUUID()` of node:crypto: counted when the IPC module calls it (a
 * preview's token), the platform's for everyone else (the settings file's
 * temporary name draws from it too, and the Rust side does not count that
 * one). Only the frames that are running count: a handler awaiting the
 * service is an `at async` frame of a stack that settings code runs in.
 */
function numberIpcUuids(): void {
  const crypto = createRequire(import.meta.url)('node:crypto') as Record<string, unknown>
  const real = (crypto.randomUUID as () => string).bind(crypto)
  const callerIsIpc = (): boolean =>
    (new Error().stack ?? '')
      .split('\n')
      .some((frame) => frame.includes('user-skills-ipc') && !frame.includes('at async'))
  Object.defineProperty(crypto, 'randomUUID', {
    value: () => (callerIsIpc() ? countedUuid() : real()),
    writable: true,
    configurable: true,
    enumerable: true,
  })
  syncBuiltinESMExports()
}
numberIpcUuids()

// ---- the stand-in of the import library ----------------------------------------

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

function failureOf(spec: { throw?: string; importError?: string }): Error | undefined {
  if (spec.throw !== undefined) return new Error(spec.throw)
  if (spec.importError !== undefined)
    return new SkillImportError(spec.importError as never, 'import failed')
  return undefined
}

/** `hosts.a.userSkills` as the functions of `@seuoffice/ai-provider` the service calls */
function importerHost(setup: Setup, log: unknown[]) {
  let stage = 0
  /** the import a spec found, made on disk under `tempDir` */
  const found = (spec: ImportSpec, origin: Record<string, unknown>, tempDir: string) => {
    const root = join(tempDir, `import-${++stage}`)
    const listed = spec.candidates ?? [{ key: '.', name: 'demo' }]
    const candidates = listed.map((item) => {
      const key = item.key
      const name = item.name ?? 'demo'
      const description = item.description ?? `About ${name}`
      const dir = key === '.' ? root : join(root, key)
      const skillMd = `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}\n`
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), skillMd)
      return {
        key,
        rel: key === '.' ? '' : key,
        dir,
        name,
        title: item.title ?? name,
        description,
        files: 1,
        bytes: Buffer.byteLength(skillMd),
        hasScripts: item.hasScripts ?? false,
        hasTemplate: false,
        urls: [] as string[],
        urlCount: 0,
        license: undefined,
        warnings: [] as unknown[],
        warningCount: 0,
        collision: item.collision ?? false,
        emptyBody: item.emptyBody ?? false,
        problem: item.problem,
      }
    })
    return { origin, root, candidates, rootLicense: spec.rootLicense, tempDir: undefined }
  }
  const github = (commit: string) => ({
    kind: 'github',
    repo: 'o/r',
    ref: 'main',
    commit,
    path: '',
  })
  const record = (commit: string) => ({
    repo: 'o/r',
    ref: 'main',
    path: '',
    commit,
    installedAt: '2026-01-01T00:00:00Z',
    contentHash: 'h',
  })
  const writeZip = (out: string, dirs: string[]): void => {
    if (setup.exportError !== undefined) throw new Error(setup.exportError)
    writeFileSync(out, `zip:${dirs.join('\n')}`)
  }
  return {
    async prepareSkillImport(
      source: { kind: string },
      env: { appSkillsDir: string; tempDir: string },
    ) {
      log.push(['skills.prepareSkillImport', source, env.appSkillsDir])
      const spec = setup.prepare?.[source.kind] ?? {}
      const failure = failureOf(spec)
      if (failure) throw failure
      const s = source as Record<string, string>
      const origin: Record<string, unknown> =
        source.kind === 'folder'
          ? { kind: 'folder', folder: s.folder }
          : source.kind === 'zip'
            ? { kind: 'zip', file: s.file }
            : source.kind === 'skill-file'
              ? { kind: 'skill-file', file: s.file }
              : source.kind === 'text'
                ? { kind: 'text' }
                : github('c1')
      return found(spec, origin, env.tempDir)
    },
    async installImportedSkills(
      imported: { candidates: { key: string; name: string }[] },
      options: { appSkillsDir: string; selected: string[]; onCollision: Record<string, string> },
    ) {
      log.push(['skills.installImportedSkills', options.selected, options.onCollision])
      const spec = setup.install ?? {}
      const failure = failureOf(spec)
      if (failure) throw failure
      return {
        installed: imported.candidates
          .filter((c) => options.selected.includes(c.key))
          .map((c) => ({
            key: c.key,
            name: c.name,
            dir: join(options.appSkillsDir, c.name),
            replaced: false,
          })),
        skipped: spec.skipped ?? [],
      }
    },
    async disposeSkillImport(imported: {
      origin: { kind: string }
      root: string
      candidates: { key: string }[]
    }) {
      log.push([
        'skills.disposeSkillImport',
        imported.origin.kind,
        imported.candidates.map((c) => c.key),
      ])
      rmSync(imported.root, { recursive: true, force: true })
    },
    async checkGitHubSkillUpdate(options: { skillDir: string; tempDir: string }) {
      log.push(['skills.checkGitHubSkillUpdate', options.skillDir])
      const spec = setup.check ?? {}
      const failure = failureOf(spec)
      if (failure) throw failure
      if (spec.changed !== undefined) {
        const commit = spec.changed.commit ?? 'c2'
        return {
          status: 'changed',
          record: record(commit),
          commit,
          locallyEdited: spec.changed.locallyEdited ?? false,
          changedFiles: (spec.changed.changedFiles ?? []).map((c) => ({
            rel: c.rel,
            change: c.change,
          })),
          update: found(spec.changed.update ?? {}, github(commit), options.tempDir),
        }
      }
      const commit = spec.upToDate?.commit ?? 'c1'
      return {
        status: 'up-to-date',
        record: record(commit),
        commit,
        locallyEdited: spec.upToDate?.locallyEdited ?? false,
      }
    },
    async applyGitHubSkillUpdate(check: { commit: string }, options: { skillDir: string }) {
      log.push(['skills.applyGitHubSkillUpdate', options.skillDir, check.commit])
      const spec = setup.apply ?? {}
      const failure = failureOf(spec)
      if (failure) throw failure
      return {
        key: '.',
        name: spec.name ?? basename(options.skillDir),
        dir: options.skillDir,
        replaced: true,
      }
    },
    async exportSkillZip(dir: string, out: string) {
      log.push(['skills.exportSkillZip', dir, out])
      writeZip(out, [dir])
    },
    async exportSkillBundleZip(dirs: string[], out: string) {
      log.push(['skills.exportSkillBundleZip', dirs, out])
      writeZip(out, dirs)
    },
  }
}

// ---- the world of a case ----------------------------------------------------------

interface UserSkillsIpc {
  queueDropped(entry: unknown): void
}
let userSkillsIpc: UserSkillsIpc | undefined

async function load(cx: LoadContext): Promise<void> {
  const hostsA = (cx.case.hosts?.a ?? {}) as { userSkills?: Setup }
  const setup = hostsA.userSkills ?? {}
  const copyTabs = setup.copyTabs ?? {}
  const log = cx.electron.log

  // the folders `app.getPath` names, while the case's folder is there:
  // outside a case (the harness makes its folders between cases, after the
  // case's own is gone) the real ones answer (as groups/m/print/host.ts does)
  const home = join(cx.dir, 'home')
  const temp = join(cx.dir, 'temp')
  os.homedir = () => (existsSync(home) ? home : REAL_HOMEDIR())
  os.tmpdir = () => (existsSync(temp) ? temp : REAL_TMPDIR())
  syncBuiltinESMExports()
  counted = 0
  Date.now = () => NOW
  ;(globalThis as Record<symbol, unknown>)[HOST] = importerHost(setup, log)

  // the hand-off queue is module state shared by the group's cases
  resetGenerateHandoffsForTest()

  // the shell window and the agent window: the shared mainWindow host (the first Shell view by default)
  const views = cx.case.views ?? [{ view: 1, window: 1, surface: 'Shell' }]
  const shared = (cx.case.hosts?.shared ?? {}) as { mainWindow?: Record<string, unknown> }
  const named = shared.mainWindow
  const main =
    typeof named?.view === 'number' && typeof named?.window === 'number'
      ? views.find((v) => v.view === named.view && (v.window ?? v.view) === named.window)
      : views.find((v) => (v.surface ?? 'Shell') === 'Shell')
  const windows = cx.electron.BrowserWindow as { fromId(id: number): unknown }
  const shellWindow = main ? windows.fromId(main.window ?? main.view) : null
  const agentView = views.find((v) => v.surface === 'ShellAgent')
  const agentContents = agentView ? cx.electron.contents(agentView.view) : undefined

  const app = {
    ...(cx.electron.app as Record<string, unknown>),
    getAppPath: () => setup.appPath ?? join(cx.dir, 'app'),
  }
  const files = copyTabs.files ?? {}
  const focusable = copyTabs.focusable ?? []
  const tabManager = {
    openHomeTab: () => log.push(['shellWindow.showHomeTab']),
    list: () => focusable.map((id) => ({ id })),
    activateTab: (id: string) => log.push(['tabManager.activateTab', id]),
    describeWebContents: (id: number) => {
      log.push(['tabManager.describeWebContents', id])
      return files[String(id)] === undefined ? undefined : { filePath: files[String(id)] }
    },
  }
  const openTemplateCopyTab = async (copy: {
    editor: string
    path: string
    dir: string
    bytes: Uint8Array
    fileName: string
    title: string
  }) => {
    log.push([
      'templateTabs.openCopy',
      {
        editor: copy.editor,
        path: copy.path,
        dir: copy.dir,
        bytes: hex(copy.bytes),
        fileName: copy.fileName,
        title: copy.title,
      },
    ])
    const open = copyTabs.open
    if (open === null) return null
    if (open?.throw !== undefined) throw new Error(open.throw)
    return {
      tabId: open?.tabId ?? 'tab-1',
      contents: cx.electron.contents(open?.view ?? 4),
      ownsCopy: open?.ownsCopy === true,
    }
  }
  const followOpenerProject = (contents: { id: number }, opener: { webContentsId: number }) =>
    log.push(['followOpenerProject', contents.id, opener.webContentsId])
  const fileHasUnsavedChanges = async (path: string) => {
    log.push(['fileHasUnsavedChanges'])
    const open = copyTabs.openFiles ?? []
    return open === 'fail' ? true : open.some((f) => f.path === path && f.dirty)
  }

  const service = await cx.fresh<{ createUserSkillsService: unknown }>(SERVICE)
  const ipc = await cx.fresh<{ registerUserSkillsIpc: unknown }>(SKILLS_IPC)
  const tabs = await cx.fresh<{ createTemplateTabs: unknown }>(TABS)
  const tabsIpc = await cx.fresh<{ registerTemplateTabsIpc: unknown }>(TABS_IPC)
  const names: Record<string, unknown> = {
    app,
    join,
    homedir,
    tmpdir,
    shell: cx.electron.shell,
    HOME_CHANNELS,
    builtinSkillsDirFor,
    createUserSkillsService: service.createUserSkillsService,
    registerUserSkillsIpc: ipc.registerUserSkillsIpc,
    createTemplateTabs: tabs.createTemplateTabs,
    registerTemplateTabsIpc: tabsIpc.registerTemplateTabsIpc,
    userSkillsManageGate,
    isAgentWindowContents: (sender: unknown) =>
      agentContents !== undefined && sender === agentContents,
    agentSkillNoticeDue,
    markAgentSkillNoticeSeen,
    shellWindow,
    tabManager,
    openTemplateCopyTab,
    followOpenerProject,
    fileHasUnsavedChanges,
    detachedDocumentFor: () => undefined,
    randomUUID: countedUuid,
    mkdirSync,
    readFileSync,
    rmSync,
    atomicWriteFile,
  }
  // the entry's statements declare their consts in one scope; the last one is read back
  const code = `${entryCode}\nreturn { userSkillsIpc }`
  // the Function constructor answers what the last statement of `code` returns
  const run = new Function(...Object.keys(names), code) as (...args: unknown[]) => {
    userSkillsIpc: UserSkillsIpc
  }
  userSkillsIpc = run(...Object.values(names)).userSkillsIpc
}

// ---- the cases ---------------------------------------------------------------------

const SHELL = 1
const DOCS = 2
const AGENT = 3
const COPY = 4
const views: View[] = [
  { view: SHELL, window: 1, surface: 'Shell' },
  { view: DOCS, window: 2, surface: 'Docs' },
  { view: AGENT, window: 3, surface: 'ShellAgent' },
  { view: COPY, window: 4, surface: 'Docs' },
]

const call = (view: number, channel: string, ...args: unknown[]): Call => ({ channel, view, args })
const shell = (channel: string, ...args: unknown[]): Call => call(SHELL, channel, ...args)
const docs = (channel: string, ...args: unknown[]): Call => call(DOCS, channel, ...args)
const agent = (channel: string, ...args: unknown[]): Call => call(AGENT, channel, ...args)
const copy = (channel: string, ...args: unknown[]): Call => call(COPY, channel, ...args)
const drop = (entry: Record<string, unknown>): Call => ({
  channel: 'a/skills-drop',
  kind: 'trigger',
  name: 'a/skills-drop',
  view: DOCS,
  args: [entry],
})

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const undef = { $: 'u' }

const file = (text: string) => ({ text, mtimeMs: NOW })
const SKILLS = 'home/.seuoffice/skills'
const skillMd = (name: string, description: string, body = 'Do it.\n', extra = ''): string =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}`
const own = (name: string, description = `About ${name}`) => ({
  [`${SKILLS}/${name}/SKILL.md`]: file(skillMd(name, description)),
})
const alpha = {
  ...own('alpha', 'First skill'),
  [`${SKILLS}/alpha/notes.txt`]: file('hello'),
}
const github = {
  [`${SKILLS}/ghs/SKILL.md`]: file(skillMd('ghs', 'From GitHub')),
  [`${SKILLS}/ghs/.ieum-source.json`]: file(
    '{"kind":"github","repo":"o/r","ref":"main","path":"","commit":"c1","installedAt":"2026-01-01T00:00:00Z","contentHash":"h"}',
  ),
}
const template = {
  [`${SKILLS}/tpl/SKILL.md`]: file(
    skillMd('tpl', 'A template', 'Use it\n', 'metadata:\n  ieum-template: assets/letter.docx\n'),
  ),
  [`${SKILLS}/tpl/assets/letter.docx`]: file('letter-bytes'),
}

const settings = (value: unknown) => ({ 'userData/app-settings.json': file(JSON.stringify(value)) })
const hosts = (userSkills: Setup = {}, shared: unknown = {}) => ({ a: { userSkills }, shared })
const dialogs = (setup: { open?: unknown[]; save?: unknown[] }, userSkills: Setup = {}) =>
  hosts(userSkills, { dialogs: setup })
const out = { out: { dir: true as const } }

const ids = (...names: string[]): string[] => names.map((n) => `app:${n}`)

const importInstall = [
  shell('skills:import-text', 'text'),
  shell('skills:install', { token: uuid(1), selected: ['.'], onCollision: {} }),
]

const bytes = (i: number) => ({ $: 'b', k: 'u8', i })

const bare: Case[] = [
  {
    note: 'any window lists and reads skills; the AI reads one and its files, checked again',
    views,
    files: alpha,
    calls: [
      docs('skills:list'),
      docs('skills:read', 'app:alpha'),
      docs('skills:read', 'app:missing'),
      docs('skills:read', 3),
      docs('skills:ai-read', 'app:alpha'),
      agent('skills:ai-read', 'nocolon'),
      docs('skills:ai-read-file', 'app:alpha', 'notes.txt'),
      docs('skills:ai-read-file', 'app:alpha', '../x.txt'),
      docs('skills:ai-read-file', 'app:alpha'),
      agent('skills:ai-read-file', 'app:alpha', 'SKILL.md'),
    ],
  },
  {
    note: 'names are suggested and checked against the skills there are',
    views,
    files: alpha,
    calls: [
      docs('skills:suggest-name', 'Alpha helper'),
      docs('skills:suggest-name', 'Release notes helper'),
      docs('skills:check-name', 'alpha'),
      docs('skills:check-name', 'fresh-one'),
      docs('skills:check-name', 'alpha', 'app:alpha'),
      docs('skills:check-name', null),
      docs('skills:check-name', ''),
    ],
  },
  {
    note: 'saving, state changes, copying and removing tell every window; others are refused',
    views,
    files: { ...alpha, ...out },
    calls: [
      shell('skills:save', { title: 'Beta', name: 'beta', description: 'second', body: 'Do beta' }),
      docs('skills:save', { title: 'Gamma', name: 'gamma', description: 'third', body: 'x' }),
      agent('skills:remove', 'app:beta'),
      shell('skills:save', { title: 1 }),
      shell('skills:list'),
      shell('skills:set-state', 'app:beta', { enabled: false }),
      shell('skills:set-state', 'app:beta', {}),
      shell('skills:set-state', 'app:absent', { enabled: true }),
      shell('skills:hide-builtin', 'builtin:nothing'),
      shell('skills:hide-builtin', 5),
      shell('skills:unhide-builtins'),
      shell('skills:unhide-builtins', ['x', 3]),
      shell('skills:unhide-builtins', 'all'),
      shell('skills:copy-to-mine', 'app:alpha'),
      shell('skills:copy-to-mine', 'app:alpha', true),
      shell('skills:copy-to-mine', 5),
      shell('skills:remove', 'app:beta'),
      shell('skills:remove', 'app:beta'),
      shell('skills:remove', undef),
      docs('skills:list'),
    ],
  },
  {
    note: 'a skill card saves its template bytes; a bad card is invalid',
    views,
    files: { [`${SKILLS}`]: { dir: true as const } },
    calls: [
      {
        channel: 'skills:save-from-card',
        view: DOCS,
        args: [
          {
            title: 'Card',
            name: 'card-skill',
            description: 'from a card',
            body: 'Do it',
            template: { fileName: 't.docx', bytes: bytes(0) },
          },
        ],
        buffers: ['010203'],
      },
      docs('skills:save-from-card', {
        title: 'Plain card',
        name: 'plain-card',
        description: 'no template',
        body: 'Do it',
      }),
      docs('skills:save-from-card', { title: 1 }),
      docs('skills:list'),
    ],
  },
  {
    note: 'a pasted skill waits under a token for its own window, is read, then installed once',
    views,
    calls: [
      ...importInstall.slice(0, 1),
      agent('skills:read-import', uuid(1), '.'),
      shell('skills:read-import', uuid(1), '.'),
      shell('skills:read-import', uuid(1), 'zzz'),
      shell('skills:read-import', uuid(1), 5),
      shell('skills:read-import-file', uuid(1), '.', 'SKILL.md'),
      shell('skills:read-import-file', uuid(1), '.', 5),
      docs('skills:read-import', uuid(1), '.'),
      ...importInstall.slice(1),
      shell('skills:install', { token: uuid(1), selected: ['.'] }),
      shell('skills:import-text', 'again'),
      shell('skills:cancel-import', uuid(2)),
      shell('skills:cancel-import'),
      shell('skills:cancel-import', 7),
      shell('skills:read-import', uuid(2), '.'),
      shell('skills:import-text', 7),
    ],
  },
  {
    note: 'an install that needs a choice keeps the preview open; any other failure disposes it',
    views,
    hosts: hosts({
      prepare: {
        text: {
          candidates: [
            { key: 'a', name: 'alpha', collision: true },
            { key: 'b', name: 'beta' },
          ],
        },
      },
      install: { importError: 'needs-choice' },
    }),
    calls: [
      shell('skills:import-text', 'text'),
      shell('skills:install', { token: uuid(1), selected: ['a', 'b'], onCollision: {} }),
      shell('skills:install', { token: uuid(1), selected: ['a'], onCollision: { a: 'skip' } }),
      shell('skills:read-import', uuid(1), 'a'),
    ],
  },
  {
    note: 'the installed skills and those skipped, with a replace choice',
    views,
    hosts: hosts({
      prepare: {
        text: {
          candidates: [
            { key: 'a', name: 'alpha', collision: true },
            { key: 'b', name: 'beta' },
          ],
        },
      },
      install: { skipped: ['b'] },
    }),
    calls: [
      shell('skills:import-text', 'text'),
      shell('skills:install', {
        token: uuid(1),
        selected: ['a', 'b'],
        onCollision: { a: 'replace' },
      }),
      shell('skills:install', undef),
      shell('skills:install', { token: '' }),
    ],
  },
  {
    note: 'an install that throws answers the failure and disposes the preview',
    views,
    hosts: hosts({ install: { throw: 'disk full' } }),
    calls: [
      shell('skills:import-text', 'text'),
      shell('skills:install', { token: uuid(1), selected: ['.'] }),
      shell('skills:install', { token: uuid(1), selected: ['.'] }),
    ],
  },
  {
    note: 'folder and zip imports ask the person; a cancel prepares nothing',
    views,
    hosts: dialogs({
      open: [['$DIR/picked/folder'], null, ['$DIR/picked/skills.zip']],
    }),
    calls: [
      shell('skills:import-folder'),
      shell('skills:import-folder'),
      shell('skills:import-zip'),
      shell('skills:import-zip'),
      docs('skills:import-folder'),
      docs('skills:import-zip'),
    ],
  },
  {
    note: 'a library that rejects with a kind, or with anything else, answers it as a failure',
    views,
    hosts: {
      ...dialogs(
        { open: [['$DIR/picked/skills.zip'], ['$DIR/picked/folder']] },
        { prepare: { zip: { importError: 'no-skills' }, folder: { throw: 'unreadable' } } },
      ),
    },
    calls: [shell('skills:import-zip'), shell('skills:import-folder')],
  },
  {
    note: 'a skill file dropped on any window waits in the queue for the settings screen',
    views,
    calls: [
      drop({ kind: 'zip', file: '$DIR/drop/a.zip' }),
      drop({ kind: 'no-skills' }),
      drop({ kind: 'skill-file', file: '$DIR/drop/SKILL.md' }),
      docs('skills:take-dropped'),
      shell('skills:take-dropped'),
      shell('skills:take-dropped'),
      shell('skills:take-dropped'),
      shell('skills:take-dropped'),
    ],
  },
  {
    note: 'the queue keeps the last twenty drops',
    views,
    calls: [
      ...Array.from({ length: 22 }, (_, n) => drop({ kind: 'zip', file: `$DIR/drop/${n}.zip` })),
      ...Array.from({ length: 21 }, () => shell('skills:take-dropped')),
    ],
  },
  {
    note: 'a GitHub import: the shell window and the agent window may, each previews under its own token',
    views,
    calls: [
      shell('skills:import-github', 'o/r'),
      shell('skills:import-github', 5),
      shell('skills:import-github', 'x'.repeat(2049)),
      docs('skills:import-github', 'o/r'),
      agent('skills:import-github', 'o/r'),
      agent('skills:read-import', uuid(2), '.'),
      shell('skills:read-import', uuid(2), '.'),
      agent('skills:cancel-import', uuid(2)),
      agent('skills:install', { token: uuid(1), selected: ['.'] }),
    ],
  },
  {
    note: 'a GitHub import that the library rejects is a failure of its kind',
    views,
    hosts: hosts({ prepare: { github: { importError: 'bad-address' } } }),
    calls: [shell('skills:import-github', 'nonsense'), shell('skills:import-github', 'o/r')],
  },
  {
    note: 'an update found, held under a token, applied once by its owner',
    views,
    files: { ...github, ...own('plain') },
    hosts: hosts({
      check: {
        changed: {
          commit: 'c2',
          locallyEdited: true,
          changedFiles: [{ rel: 'SKILL.md', change: 'modified' }],
        },
      },
    }),
    calls: [
      shell('skills:check-update', 'app:ghs'),
      docs('skills:check-update', 'app:ghs'),
      shell('skills:check-update', 'app:plain'),
      shell('skills:check-update', 'app:absent'),
      shell('skills:check-update', 'nocolon'),
      agent('skills:apply-update', uuid(1)),
      shell('skills:apply-update', uuid(1)),
      shell('skills:apply-update', uuid(1)),
      shell('skills:apply-update', 5),
    ],
  },
  {
    note: 'a current skill is up to date; a found update can be dropped',
    views,
    files: github,
    hosts: hosts({ check: { upToDate: { commit: 'c1', locallyEdited: true } } }),
    calls: [shell('skills:check-update', 'app:ghs')],
  },
  {
    note: 'cancelling a found update disposes its files; a token is the owner’s alone',
    views,
    files: github,
    hosts: hosts({ check: { changed: { commit: 'c3' } } }),
    calls: [
      shell('skills:check-update', 'app:ghs'),
      docs('skills:cancel-update', uuid(1)),
      shell('skills:cancel-update', 5),
      shell('skills:cancel-update', uuid(1)),
      shell('skills:apply-update', uuid(1)),
    ],
  },
  {
    note: 'a check that fails and an update that cannot be applied are failures',
    views,
    files: github,
    hosts: hosts({ check: { throw: 'offline' } }),
    calls: [shell('skills:check-update', 'app:ghs')],
  },
  {
    note: 'an update whose apply is rejected with a kind answers it',
    views,
    files: github,
    hosts: hosts({ check: { changed: {} }, apply: { importError: 'trash-failed' } }),
    calls: [
      shell('skills:check-update', 'app:ghs'),
      shell('skills:apply-update', uuid(1)),
      shell('skills:apply-update', uuid(1)),
    ],
  },
  {
    note: 'a skill is exported to the zip the person names; one or several',
    views,
    files: { ...alpha, ...own('beta'), ...out },
    hosts: dialogs({
      save: ['$DIR/out/alpha.zip', null, '$DIR/out/bundle.zip', '$DIR/out/one.zip'],
    }),
    calls: [
      shell('skills:export-info', 'app:alpha'),
      shell('skills:export-info', 'app:absent'),
      shell('skills:export-info', 5),
      shell('skills:export-zip', 'app:alpha'),
      shell('skills:export-zip', 'app:alpha'),
      shell('skills:export-zip', 5),
      shell('skills:export-bundle', ids('alpha', 'beta', 'alpha'), 'My skills'),
      shell('skills:export-bundle', ids('alpha')),
      shell('skills:export-bundle', []),
      shell('skills:export-bundle', ids('absent')),
      docs('skills:export-zip', 'app:alpha'),
    ],
  },
  {
    note: 'a zip writer that rejects is a failure',
    views,
    files: { ...alpha, ...out },
    hosts: dialogs({ save: ['$DIR/out/a.zip', '$DIR/out/b.zip'] }, { exportError: 'disk full' }),
    calls: [
      shell('skills:export-zip', 'app:alpha'),
      shell('skills:export-bundle', ids('alpha'), 'x'),
    ],
  },
  {
    note: 'a skill folder opens in the OS',
    views,
    files: alpha,
    calls: [
      shell('skills:open-folder', 'app:alpha'),
      shell('skills:open-folder', 'app:absent'),
      shell('skills:open-folder', 5),
      docs('skills:open-folder', 'app:alpha'),
    ],
  },
  {
    note: 'the OS refuses to open the folder',
    views,
    files: alpha,
    hosts: hosts({}, { osShell: { openPath: 'no application' } }),
    calls: [shell('skills:open-folder', 'app:alpha')],
  },
  {
    note: 'the settings open on the skills page of the shell window',
    views,
    calls: [docs('skills:open-settings'), agent('skills:open-settings')],
  },
  {
    note: 'the agent notice is due once the warning was accepted, until it is seen',
    views,
    files: settings({ agent: { warningAccepted: 1 } }),
    calls: [
      agent('skills:agent-notice'),
      agent('skills:agent-notice-seen'),
      agent('skills:agent-notice'),
    ],
  },
  {
    note: 'no accepted warning: no notice; an unwritable settings folder is swallowed',
    views,
    calls: [docs('skills:agent-notice'), docs('skills:agent-notice-seen')],
  },

  // ---- the template flow ----
  {
    note: 'a template opens as a copy in a new tab; its request is taken once, by that tab, for its editor',
    views,
    files: template,
    hosts: hosts({ copyTabs: { open: { tabId: 'tab-1', view: COPY } } }),
    calls: [
      docs('skills:open-template', {
        skillId: 'app:tpl',
        text: 'make it',
        chips: [{ id: 'app:tpl', source: 'app', title: 'Tpl' }],
      }),
      docs('skills:take-handoff', 'docs'),
      copy('skills:take-handoff', 'sheets'),
      copy('skills:take-handoff', 'nonsense'),
      copy('skills:take-handoff', 'docs'),
      copy('skills:take-handoff', 'docs'),
    ],
  },
  {
    note: 'a template request names a skill that has one, or is refused; a tab that cannot open leaves nothing',
    views,
    files: { ...template, ...own('plain') },
    hosts: hosts({ copyTabs: { open: null } }),
    calls: [
      docs('skills:open-template', { skillId: 'app:absent', text: 'x', chips: [] }),
      docs('skills:open-template', { skillId: 'app:plain', text: 'x', chips: [] }),
      docs('skills:open-template', { skillId: 1 }),
      docs('skills:open-template', { skillId: 'app:tpl', text: 'x', chips: [] }),
    ],
  },
  {
    note: 'the asking tab’s file goes along only when saved without unsaved changes',
    views,
    files: template,
    hosts: hosts({
      copyTabs: {
        open: { tabId: 'tab-1', view: COPY },
        files: { [String(DOCS)]: '$DIR/docs/a.docx' },
        openFiles: [{ path: '$DIR/docs/a.docx', dirty: true }],
      },
    }),
    calls: [
      copy('skills:open-template', { skillId: 'app:tpl', text: 'x', chips: [], withCurrent: true }),
      docs('skills:open-template', { skillId: 'app:tpl', text: 'x', chips: [], withCurrent: true }),
    ],
  },
  {
    note: 'a saved file with no unsaved changes is attached for the new tab',
    views,
    files: template,
    hosts: hosts({
      copyTabs: {
        open: { tabId: 'tab-1', view: COPY },
        files: { [String(DOCS)]: '$DIR/docs/a.docx' },
        openFiles: [{ path: '$DIR/docs/a.docx', dirty: false }],
      },
    }),
    calls: [
      docs('skills:open-template', { skillId: 'app:tpl', text: 'x', chips: [], withCurrent: true }),
      copy('skills:take-handoff', 'docs'),
    ],
  },
  {
    note: 'a shell that cannot say which files are unsaved refuses to attach',
    views,
    files: template,
    hosts: hosts({
      copyTabs: {
        files: { [String(DOCS)]: '$DIR/docs/a.docx' },
        openFiles: 'fail',
      },
    }),
    calls: [
      docs('skills:open-template', { skillId: 'app:tpl', text: 'x', chips: [], withCurrent: true }),
    ],
  },
  {
    note: 'a preview keeps the original for its tab and tells the owner once when it ends',
    views,
    hosts: hosts({ copyTabs: { open: { tabId: 'tab-1', view: COPY } } }),
    calls: [
      {
        channel: 'skills:open-preview',
        view: DOCS,
        args: [
          {
            bytes: bytes(0),
            fileName: 'report.docx',
            title: 'Report',
            tabTitle: 'Template preview - Report',
            text: 'clear it',
            originalRedacted: false,
            proposal: { name: 'report' },
          },
        ],
        buffers: ['040506'],
      },
      docs('skills:preview-original', uuid(1)),
      copy('skills:preview-original', uuid(1)),
      copy('skills:take-handoff', 'docs'),
      docs('skills:finish-preview', { previewId: uuid(1), outcome: 'saved' }),
      copy('skills:finish-preview', {
        previewId: uuid(1),
        outcome: 'saved',
        skillId: 'app:made',
        title: 'Made',
      }),
      copy('skills:finish-preview', { previewId: uuid(1), outcome: 'unsaved' }),
    ],
  },
  {
    note: 'an original that may withhold something is not handed back; bad input is invalid',
    views,
    hosts: hosts({ copyTabs: { open: { tabId: 'tab-1', view: COPY } } }),
    calls: [
      {
        channel: 'skills:open-preview',
        view: DOCS,
        args: [
          {
            bytes: bytes(0),
            fileName: 'report.docx',
            title: 'Report',
            tabTitle: 'Template preview - Report',
            text: 'clear it',
            originalRedacted: true,
            proposal: { name: 'report' },
            draft: { title: 'Draft' },
          },
        ],
        buffers: ['040506'],
      },
      copy('skills:preview-original', uuid(1)),
      docs('skills:open-preview', { fileName: 'a.docx' }),
      copy('skills:preview-original', 5),
      copy('skills:finish-preview', { previewId: uuid(1), outcome: 'later' }),
      docs('skills:take-handoff', 5),
    ],
  },
  {
    note: 'a preview of a file no editor opens is refused',
    views,
    calls: [
      {
        channel: 'skills:open-preview',
        view: DOCS,
        args: [
          {
            bytes: bytes(0),
            fileName: 'report.exe',
            title: 'Report',
            tabTitle: 'Template preview - Report',
            text: 'x',
            originalRedacted: false,
            proposal: {},
          },
        ],
        buffers: ['00'],
      },
    ],
  },
  {
    note: 'a tab is focused while it is still there',
    views,
    hosts: hosts({ copyTabs: { focusable: ['tab-1'] } }),
    calls: [
      docs('skills:focus-tab', 'tab-1'),
      docs('skills:focus-tab', 'tab-9'),
      docs('skills:focus-tab', 5),
      docs('skills:focus-tab', 'x'.repeat(65)),
    ],
  },
]

/**
 * The settings file is written by every change, which needs its folder (the
 * entry creates it at start); the case about the unwritable folder keeps it away.
 * `home` and `temp` are there in every case: `os.homedir()` and `os.tmpdir()`
 * name them only while they are (see `load`), and the real folders must not answer
 */
const cases: Case[] = bare.map((c) => ({
  ...c,
  files: {
    home: { dir: true as const },
    temp: { dir: true as const },
    ...(c.note?.startsWith('no accepted warning') ? {} : { userData: { dir: true as const } }),
    ...c.files,
  },
}))

export const group: Group = {
  batch: 'A',
  load,
  triggers: {
    'a/skills-drop': (_cx, _view, args) => {
      userSkillsIpc?.queueDropped(args[0])
    },
  },
  cases,
  single: {
    'skills:agent-notice-seen':
      'answers undefined whatever the file; the folder tells the cases apart',
    'skills:open-settings':
      'answers undefined whatever the window; the events and the host log tell the cases apart',
  },
}
