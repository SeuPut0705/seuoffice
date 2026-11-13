/**
 * Group `a/integrations`: Settings > Integrations
 * (`apps/shell/src/main/integrations-ipc.ts`), configured as the shell entry
 * configures it: `APP_SETTINGS_PATH` and the `registerIntegrationsIpc({...})`
 * call are the entry's own statements; the bundled files are found under the
 * case's folder (`apps/` is the entry's `APPS_ROOT`, `Resources/` its
 * `process.resourcesPath` when packaged); the shell window is the one the
 * shared `mainWindow` host names, as in the Rust fakes.
 *
 * `@seuoffice/cli/agent-skills` and `inspectCliLink` of
 * `@seuoffice/cli/install` are what the Rust port reaches through its
 * `AgentSkills` host. A resolve hook answers the two specifiers with stubs
 * that re-export the real modules and forward the functions the host stands
 * for to one object per case, built from the case's `hosts.a.integrations`
 * (crates/shell-ipc/a/src/probe/integrations.rs is the same table in Rust,
 * see its header for the keys). Each call logs one line named
 * `agentSkills.<function>`; the ledger is logged as its sorted keys.
 * `bundledSkillFrom`'s version is the first `version:` line, its hash the byte
 * count and a byte sum; an install records `{version, sha256}` in the ledger
 * and the saved zip holds `zip:<version>:<sha256>`.
 */
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import type { Call, Case, Group } from '../../types.ts'
import type * as IntegrationsModule from '../../../../apps/shell/src/main/integrations-ipc.ts'
import { entryStatements, runWith } from './lib/entry-source.ts'

const MODULE = 'apps/shell/src/main/integrations-ipc.ts'
type IntegrationsIpc = typeof IntegrationsModule

const entryCode = entryStatements('apps/shell/src/main/index.ts', [
  'const APP_SETTINGS_PATH =',
  'registerIntegrationsIpc({',
])

interface Target {
  id: string
  label: string
  skillsDir: string
  legacy?: boolean
}
interface StateSpec {
  status: string
  installedVersion?: string
  older?: boolean
}
/** `hosts.a.integrations` */
interface Setup {
  appsRoot?: string
  resourcesPath?: string
  packaged?: boolean
  appImage?: string
  targets?: Target[]
  detected?: string[]
  rows?: string[]
  legacy?: string[]
  states?: Record<string, StateSpec>
  link?: Record<string, unknown>
  installError?: Record<string, string>
  zipError?: string
}
type Ledger = Record<string, unknown>
interface Bundled {
  bytes: Uint8Array
  text: string
  version: string
  sha256: string
}

/** the object the stubs forward to: the current case's stand-in */
const HOST = Symbol.for('ipc-diff.a.integrations')

const AGENT_SKILLS = 'ipc-diff:agent-skills'
const CLI_INSTALL = 'ipc-diff:cli-install'
const realFile = (name: string): string =>
  new URL(`../../../../packages/cli/src/${name}.ts`, import.meta.url).href
const forwarding = (names: string[]): string =>
  names
    .map(
      (n) =>
        `export const ${n} = (...args) => globalThis[Symbol.for('ipc-diff.a.integrations')].${n}(...args)`,
    )
    .join('\n')
const SOURCES: Record<string, string> = {
  [AGENT_SKILLS]: [
    `export * from ${JSON.stringify(realFile('agent-skills'))}`,
    forwarding([
      'agentTarget',
      'bundledSkillFrom',
      'buildSkillZip',
      'detectAgents',
      'installSkill',
      'legacySkillCopies',
      'readInstallState',
      'skillFilesWritten',
      'skillRows',
      'uninstallSkill',
    ]),
  ].join('\n'),
  [CLI_INSTALL]: [
    `export * from ${JSON.stringify(realFile('install'))}`,
    forwarding(['inspectCliLink']),
  ].join('\n'),
}
const SPECIFIERS: Record<string, string> = {
  '@seuoffice/cli/agent-skills': AGENT_SKILLS,
  '@seuoffice/cli/install': CLI_INSTALL,
}

// synchronous hooks, as tools/main-diff/electron-fake.ts: they answer `import` and `require`
registerHooks({
  resolve(specifier, context, next) {
    const url = SPECIFIERS[specifier]
    if (url !== undefined) return { url, shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    const source = SOURCES[url]
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return next(url, context)
  },
})

const skillFile = (dir: string): string => `${dir}/seuoffice/SKILL.md`

/** The stand-in of `@seuoffice/cli/agent-skills` and `inspectCliLink` for one case */
function agentSkillsHost(setup: Setup, log: unknown[]) {
  const row = (id: string) => {
    const t = (setup.targets ?? []).find((x) => x.id === id)
    if (!t) return undefined
    return {
      id: t.id,
      label: t.label,
      skillsDir: t.skillsDir,
      ...(t.legacy ? { legacy: true } : {}),
    }
  }
  const rowsOf = (ids: string[] | undefined) => (ids ?? []).flatMap((id) => row(id) ?? [])
  const states = new Map(Object.entries(setup.states ?? {}))
  const keys = (ledger: Ledger): string[] => Object.keys(ledger).sort()
  const within = (dir: string, ledger: Ledger): string[] =>
    Object.keys(ledger).filter((k) => k.startsWith(`${dir}/`))
  const installError = setup.installError ?? {}

  return {
    bundledSkillFrom(bytes: Uint8Array): Bundled {
      const text = Buffer.from(bytes).toString('utf-8')
      let sum = 0
      for (const b of bytes) sum = (sum + b) % 65521
      return {
        bytes,
        text,
        version: /^version:[ \t]*(\S*)/m.exec(text)?.[1] ?? '',
        sha256: `${bytes.length}:${sum}`,
      }
    },
    detectAgents() {
      log.push(['agentSkills.detectAgents'])
      return rowsOf(setup.detected)
    },
    agentTarget(id: unknown) {
      // a value that is no string names no row; the Rust port never asks the host about it
      if (typeof id !== 'string') return undefined
      log.push(['agentSkills.agentTarget', id])
      return row(id)
    },
    skillRows(ledger: Ledger) {
      log.push(['agentSkills.skillRows', keys(ledger)])
      return rowsOf(setup.rows)
    },
    legacySkillCopies(ledger: Ledger, _env: unknown, _home: unknown, only: string) {
      log.push(['agentSkills.legacySkillCopies', keys(ledger), only])
      return rowsOf(setup.legacy)
    },
    skillFilesWritten(dir: string, ledger: Ledger) {
      log.push(['agentSkills.skillFilesWritten', dir, keys(ledger)])
      return within(dir, ledger)
    },
    readInstallState(dir: string, bundled: Bundled, ledger: Ledger) {
      log.push(['agentSkills.readInstallState', dir, bundled.version, keys(ledger)])
      const s = states.get(dir)
      if (!s) return { status: 'missing', path: skillFile(dir) }
      return {
        status: s.status,
        path: skillFile(dir),
        ...(s.installedVersion === undefined ? {} : { installedVersion: s.installedVersion }),
        ...(s.older === undefined ? {} : { older: s.older }),
      }
    },
    installSkill(dir: string, bundled: Bundled, ledger: Ledger): string {
      log.push(['agentSkills.installSkill', dir, bundled.version, keys(ledger)])
      const failure = installError[dir]
      if (typeof failure === 'string') throw new Error(failure)
      const path = skillFile(dir)
      ledger[path] = { version: bundled.version, sha256: bundled.sha256 }
      states.set(dir, { status: 'installed', installedVersion: bundled.version })
      return path
    },
    uninstallSkill(dir: string, ledger: Ledger): boolean {
      log.push(['agentSkills.uninstallSkill', dir, keys(ledger)])
      const gone = within(dir, ledger)
      for (const k of gone) delete ledger[k]
      if (gone.length > 0) states.set(dir, { status: 'missing' })
      return gone.length > 0
    },
    async buildSkillZip(bundled: Bundled): Promise<Buffer> {
      log.push(['agentSkills.buildSkillZip', bundled.version, bundled.sha256])
      if (typeof setup.zipError === 'string') throw new Error(setup.zipError)
      return Buffer.from(`zip:${bundled.version}:${bundled.sha256}`)
    },
    inspectCliLink(opts: { launcher: string }) {
      log.push(['agentSkills.inspectCliLink', opts.launcher])
      return { ...(setup.link ?? { status: 'missing' }) }
    },
  }
}

// ---- the cases -------------------------------------------------------------------

/** every path of an agent is fixed and absolute: the stand-in reads and writes no disk */
const HOME = '/seu-test/home'
const CLAUDE = `${HOME}/.claude/skills`
const SHARED = `${HOME}/.agents/skills`
const CODEX = `${HOME}/.codex/skills`
const GEMINI = `${HOME}/.gemini/skills`
const PICKED = '/seu-test/picked'
const PICKED_TOO = '/seu-test/picked-too'

const targets: Target[] = [
  { id: 'claude-code', label: 'Claude Code', skillsDir: CLAUDE },
  { id: 'agents', label: 'Shared folder (~/.agents)', skillsDir: SHARED },
  { id: 'codex', label: 'Codex', skillsDir: CODEX, legacy: true },
  { id: 'gemini', label: 'Gemini CLI', skillsDir: GEMINI, legacy: true },
]

const SKILL = "---\nname: seuoffice\nversion: 2.0.0\nmetadata:\n  cli: '>=1.4.0'\n---\nbody\n"
const SKILL_UNQUOTED = '---\nname: seuoffice\nversion: 3.1.0\nmetadata:\n  cli: >= 2.0.1\n---\n'
const SKILL_DOUBLE = '---\nname: seuoffice\nversion:\t4.0.0\nmetadata:\n  cli: ">=0.9.12"\n---\n'
const SKILL_PLAIN = '---\nname: seuoffice\nversion: 2.1.0\n---\nno requirement\n'

/** the bundled files an unpackaged shell reads (`APPS_ROOT/../skills`, `../packages/cli`) */
const bundle = (skill = SKILL, packageJson?: string) => ({
  userData: { dir: true },
  'skills/seuoffice/SKILL.md': skill,
  ...(packageJson === undefined ? {} : { 'packages/cli/package.json': packageJson }),
})
/** the same, packaged (`process.resourcesPath/cli`) under `root` */
const packagedBundle = (root: string, packageJson: string) => ({
  [`${root}/cli/skills/seuoffice/SKILL.md`]: SKILL,
  [`${root}/cli/package.json`]: packageJson,
})
const entry = (dir: string, version = '1.0.0') => ({
  [skillFile(dir)]: { version, sha256: 'abc' },
})
const stored = (ledger: unknown) => ({
  'userData/app-settings.json': JSON.stringify({ lang: 'ko', agentSkillInstalls: ledger }),
})
const folders = { downloads: { dir: true } }

const hosts = (integrations: Setup = {}, shared: unknown = {}) => ({
  shared,
  a: {
    integrations: {
      appsRoot: '$DIR/apps',
      resourcesPath: '$DIR/Resources',
      targets,
      detected: ['claude-code', 'agents'],
      rows: ['claude-code', 'agents', 'codex'],
      legacy: ['codex', 'gemini'],
      ...integrations,
    },
  },
})
const dialogs = (dialogsHost: { open?: unknown[]; save?: unknown[] }, integrations?: Setup) =>
  hosts(integrations, { dialogs: dialogsHost })

const undef = { $: 'u' }
const call = (channel: string, ...args: unknown[]): Call => ({ channel, args })
const status = (): Call => call('integrations:status')
const install = (...target: unknown[]): Call => call('integrations:install-skill', ...target)
const uninstall = (...id: unknown[]): Call => call('integrations:uninstall-skill', ...id)
const pick = (...title: unknown[]): Call => call('integrations:pick-skill-dir', ...title)
const saveZip = (...title: unknown[]): Call => call('integrations:save-skill-zip', ...title)
const copy = (...text: unknown[]): Call => call('integrations:copy-text', ...text)

const installed: StateSpec = { status: 'installed', installedVersion: '2.0.0' }
const outdated: StateSpec = { status: 'outdated', installedVersion: '1.0.0', older: true }

const bare: Case[] = [
  // ---- status
  {
    note: 'every row with its state; the ledger is read for the probe',
    files: {
      ...bundle(SKILL, '{"name":"@seuoffice/cli","version":"0.10.0"}'),
      ...stored({ ...entry(CLAUDE, '2.0.0'), ...entry(CODEX) }),
    },
    hosts: hosts({
      link: { status: 'linked', location: '/usr/local/bin/seuoffice' },
      states: { [CLAUDE]: installed, [CODEX]: outdated },
    }),
    calls: [status()],
  },
  {
    note: 'nothing detected and no link',
    files: bundle(SKILL, '{"version":"0.10.0"}'),
    hosts: hosts({ rows: [] }),
    calls: [status()],
  },
  {
    note: 'no package.json and a skill that needs no command line',
    files: bundle(SKILL_PLAIN),
    calls: [status()],
  },
  {
    note: 'a package.json that is not JSON, an unquoted requirement',
    files: bundle(SKILL_UNQUOTED, '{oops'),
    calls: [status()],
  },
  {
    note: 'a numeric version is read as text, a requirement in double quotes, a tab after version:',
    files: bundle(SKILL_DOUBLE, '{"version":3}'),
    calls: [status()],
  },
  {
    note: 'a null version is empty',
    files: bundle(SKILL, '{"version":null}'),
    calls: [status()],
  },
  {
    note: 'a package.json holding null is empty',
    files: bundle(SKILL, 'null'),
    calls: [status()],
  },
  {
    note: 'packaged from a plain install: the files are under Resources/cli, the link is not ephemeral',
    files: packagedBundle('Resources', '{"version":"0.10.0"}'),
    hosts: hosts({ packaged: true }),
    calls: [status()],
  },
  {
    note: 'packaged and started from an AppImage: ephemeral',
    files: packagedBundle('Resources', '{"version":"0.10.0"}'),
    hosts: hosts({ packaged: true, appImage: '/tmp/.mount_seuoff/AppRun' }),
    calls: [status()],
  },
  {
    note: 'packaged and read from a mounted image: ephemeral',
    files: packagedBundle('.mount_seu1/Resources', '{"version":"0.10.0"}'),
    hosts: hosts({ packaged: true, resourcesPath: '$DIR/.mount_seu1/Resources' }),
    calls: [status()],
  },
  {
    note: 'an AppImage variable means nothing outside a packaged app',
    files: bundle(SKILL, '{"version":"0.10.0"}'),
    hosts: hosts({ appImage: '/tmp/.mount_seuoff/AppRun' }),
    calls: [status()],
  },
  {
    note: 'an empty AppImage variable is no mount',
    files: packagedBundle('Resources', '{"version":"0.10.0"}'),
    hosts: hosts({ packaged: true, appImage: '' }),
    calls: [status()],
  },
  {
    note: 'no bundled skill file: the probe throws',
    hosts: hosts(),
    calls: [status()],
  },

  // ---- install-skill
  {
    note: 'an agent row installs the skill, writes the ledger and answers its state',
    files: { ...bundle(), ...stored({ ...entry(CODEX) }) },
    calls: [install({ agentId: 'claude-code' }), status()],
  },
  {
    note: 'targets that name nothing, a falsy folder, a folder that is no string',
    files: bundle(),
    calls: [
      install({ agentId: 'nope' }),
      install({}),
      install({ dir: '', agentId: 'claude-code' }),
      install({ dir: 0 }),
      install({ dir: 5 }),
      install({ dir: ['x'] }),
    ],
  },
  {
    note: 'no target at all',
    files: bundle(),
    calls: [install(), install(null)],
  },
  {
    note: 'a folder of a detected agent is vouched, also written differently',
    files: bundle(),
    calls: [
      install({ dir: CLAUDE }),
      install({ dir: `${SHARED}/` }),
      install({ dir: `${CLAUDE}/../skills` }),
    ],
  },
  {
    note: 'a folder nobody vouched for, a relative one, an agent that is not detected',
    files: bundle(),
    calls: [
      install({ dir: '/seu-test/elsewhere' }),
      install({ dir: 'relative/skills' }),
      install({ dir: CODEX }),
    ],
  },
  {
    note: 'the picked folder is vouched until the next pick cancels',
    files: bundle(),
    hosts: dialogs({ open: [[PICKED], null] }),
    calls: [
      install({ dir: PICKED }),
      pick('Pick a folder'),
      install({ dir: PICKED }),
      install({ dir: PICKED_TOO }),
      pick('Again'),
      install({ dir: PICKED }),
    ],
  },
  {
    note: 'only the last picked folder is vouched',
    files: bundle(),
    hosts: dialogs({ open: [[PICKED], [PICKED_TOO]] }),
    calls: [pick('One'), pick('Two'), install({ dir: PICKED }), install({ dir: PICKED_TOO })],
  },
  {
    note: 'a legacy row takes a write when this app wrote a copy there before',
    files: { ...bundle(), ...stored({ ...entry(CODEX) }) },
    hosts: hosts({ states: { [CODEX]: outdated } }),
    calls: [install({ agentId: 'codex' })],
  },
  {
    note: 'a legacy row with no copy of ours is refused',
    files: { ...bundle(), ...stored({}) },
    calls: [install({ agentId: 'codex' }), install({ agentId: 'gemini' })],
  },
  {
    note: 'the shared row brings along the outdated copies and leaves the edited one',
    files: { ...bundle(), ...stored({ ...entry(CODEX), ...entry(GEMINI) }) },
    hosts: hosts({
      states: { [CODEX]: outdated, [GEMINI]: { status: 'modified', installedVersion: '1.0.0' } },
    }),
    calls: [install({ agentId: 'agents' }), status()],
  },
  {
    note: 'a failing older copy fails the install and nothing is saved',
    files: { ...bundle(), ...stored({ ...entry(CODEX) }) },
    hosts: hosts({
      states: { [CODEX]: outdated },
      installError: { [CODEX]: 'EACCES: permission denied' },
    }),
    calls: [install({ agentId: 'agents' })],
  },
  {
    note: 'a refused install writes no ledger',
    files: bundle(),
    hosts: hosts({ installError: { [CLAUDE]: 'the skill folder is a symlink' } }),
    calls: [install({ agentId: 'claude-code' })],
  },
  {
    note: 'no bundled skill file: the install throws after the target is checked',
    calls: [install({ agentId: 'claude-code' }), install({ agentId: 'nope' })],
  },
  {
    note: 'a ledger that is no object starts over, the other settings stay',
    files: { ...bundle(), ...stored([1]) },
    calls: [install({ agentId: 'claude-code' })],
  },

  // ---- uninstall-skill
  {
    note: 'a copy of ours is removed and the ledger saved',
    files: { ...bundle(), ...stored({ ...entry(CLAUDE, '2.0.0'), ...entry(CODEX) }) },
    hosts: hosts({ states: { [CLAUDE]: installed } }),
    calls: [uninstall('claude-code'), status()],
  },
  {
    note: 'nothing of ours there: the ledger is not written',
    files: bundle(),
    hosts: hosts({ states: { [CLAUDE]: { status: 'foreign', installedVersion: '2.0.0' } } }),
    calls: [uninstall('claude-code')],
  },
  {
    note: 'an id that is no row',
    files: bundle(),
    calls: [uninstall('nope'), uninstall()],
  },
  {
    note: 'a legacy row is removed too',
    files: { ...bundle(), ...stored({ ...entry(CODEX) }) },
    hosts: hosts({ states: { [CODEX]: outdated } }),
    calls: [uninstall('codex')],
  },

  // ---- pick-skill-dir
  {
    note: 'the title is made a string; a cancelled, an empty and an exhausted dialog answer null',
    hosts: dialogs({ open: [[PICKED], null, [], [PICKED_TOO, PICKED], [PICKED]] }),
    calls: [pick('Pick a folder'), pick(undef), pick(null), pick(7), pick({ x: 1 }), pick([1, 2])],
  },
  {
    note: 'without a shell window the dialog has no parent',
    hosts: hosts({}, { dialogs: { open: [[PICKED]] }, mainWindow: { view: 9, window: 9 } }),
    calls: [pick('Pick')],
  },
  {
    note: 'the dialog is the shell window, whoever asks',
    views: [
      { view: 1, window: 1, surface: 'Shell' },
      { view: 2, window: 2, surface: 'Docs' },
    ],
    hosts: hosts({}, { dialogs: { open: [[PICKED]] }, mainWindow: { view: 2, window: 2 } }),
    calls: [pick('Pick')],
  },

  // ---- save-skill-zip
  {
    note: 'the zip is written where the dialog says; a cancel and an empty path write nothing',
    files: { ...bundle(), ...folders },
    hosts: dialogs({ save: ['$DIR/downloads/out.zip', null, ''] }),
    calls: [saveZip('Save the skill'), saveZip(), saveZip(5)],
  },
  {
    note: 'a zip that cannot be built throws after the dialog',
    files: { ...bundle(), ...folders },
    hosts: dialogs({ save: ['$DIR/downloads/out.zip'] }, { zipError: 'zip failed' }),
    calls: [saveZip('Save')],
  },
  {
    note: 'a path that cannot be written throws',
    files: bundle(),
    hosts: dialogs({ save: ['$DIR/missing/out.zip'] }),
    calls: [saveZip('Save')],
  },
  {
    note: 'no bundled skill file: no dialog is opened',
    hosts: dialogs({ save: ['$DIR/out.zip'] }),
    calls: [saveZip('Save')],
  },
  {
    note: 'the save dialog has no parent without a shell window',
    files: bundle(),
    hosts: hosts({}, { dialogs: { save: ['$DIR/out.zip'] }, mainWindow: { view: 9, window: 9 } }),
    calls: [saveZip('Save')],
  },

  // ---- copy-text
  {
    note: 'only a string reaches the clipboard',
    calls: [copy('seuoffice --help'), copy(42), copy(), copy(''), copy(['a'])],
  },
]

/** a case that names no hosts gets the default table */
const cases: Case[] = bare.map((c) => ({ ...c, hosts: c.hosts ?? hosts() }))

export const group: Group = {
  batch: 'A',
  async load(cx) {
    const hostsA = (cx.case.hosts?.a ?? {}) as { integrations?: Setup }
    const setup = hostsA.integrations ?? {}
    const globals = globalThis as Record<symbol, unknown>
    const app = cx.electron.app as { isPackaged: boolean }
    globals[HOST] = agentSkillsHost(setup, cx.electron.log)
    app.isPackaged = setup.packaged === true
    Object.defineProperty(process, 'resourcesPath', {
      value: setup.resourcesPath ?? '',
      configurable: true,
      writable: true,
    })
    if (setup.appImage === undefined) delete process.env.APPIMAGE
    else process.env.APPIMAGE = setup.appImage

    // the shell window: the shared mainWindow host, the first Shell view by default
    const views = cx.case.views ?? [{ view: 1, window: 1, surface: 'Shell' }]
    const shared = (cx.case.hosts?.shared ?? {}) as { mainWindow?: Record<string, unknown> }
    const named = shared.mainWindow
    const main =
      typeof named?.view === 'number' && typeof named?.window === 'number'
        ? views.find((v) => v.view === named.view && (v.window ?? v.view) === named.window)
        : views.find((v) => (v.surface ?? 'Shell') === 'Shell')
    const windows = cx.electron.BrowserWindow as { fromId(id: number): unknown }
    const shellWindow = main ? windows.fromId(main.window ?? main.view) : null

    const mod = await cx.fresh<IntegrationsIpc>(MODULE)
    runWith(entryCode, {
      join,
      app: cx.electron.app,
      APPS_ROOT: setup.appsRoot,
      shellWindow,
      registerIntegrationsIpc: mod.registerIntegrationsIpc,
    })
  },
  cases,
  single: {
    'integrations:copy-text':
      'answers undefined whatever the text; the clipboard log tells the cases apart',
  },
}
