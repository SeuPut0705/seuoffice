/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Group `b5-agent`, part user-skills: `apps/shell/src/main/user-skills/*`
 * (builtin-dir, template-tabs, template-tabs-ipc, user-skills-ipc,
 * user-skills-service; index.ts only re-exports) and, in
 * `b5-agent-user-skills-pkg.ts`, the package functions they call.
 *
 * Names are `<ts-file>.<export>`. The service, the IPC layers and the template
 * tabs are compared as scenarios: a case is a list of steps over one set of
 * fakes, and the answer is the list of what each step answered; each call of a
 * fake is one log line, written by the Rust fakes of
 * calls/b5_agent/user_skills.rs the same way.
 *
 * - The library (`@seuoffice/ai-provider`'s `prepareSkillImport`,
 *   `installImportedSkills`, `disposeSkillImport`, `checkGitHubSkillUpdate`,
 *   `applyGitHubSkillUpdate`, `exportSkillZip`, `exportSkillBundleZip`) is a
 *   scripted fake on both sides: a resolve hook of this file answers the
 *   service's and the IPC layer's import of the package with a module that
 *   re-exports it and replaces those seven. `lib` of a case scripts them:
 *   `prepare`, `install`, `check`, `apply` are the value to answer or
 *   `{ throw: <kind of SkillImportError> }`; `discard` lists the folders the
 *   install hands to `discardReplaced`; `exportZip` is `{ throw }` or absent.
 * - A service step is `{ m: <method>, a: [arguments] }`. Template bytes are
 *   `{ hex }`. `prepare` and `checkUpdate` answer through `importPreviewOf`
 *   (token `tok`); a rejection is `{ threw: message }`.
 * - An IPC step is `{ ch, a, s?, bytes?, hold? }` (the sender id `s` defaults
 *   to 1); `{ drop }` queues a dropped file, `{ destroy }` destroys a window,
 *   `{ release }` lets the held library call go on. The token of the last
 *   preview or update is the string `$token` in later arguments and
 *   `<uuid>` in answers. A held GitHub call or update check must not have a
 *   skill-changing step between its call and its release.
 * - `$root` in opts is the case folder; a real path under it is written back
 *   as the case folder (a temporary folder may sit behind a link).
 */
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { useElectron } from '../electron-fake.ts'
import type { Case, FnSpec, Group, TsContext } from '../types.ts'
import { pkg } from './b5-agent-user-skills-pkg.ts'

// ---- the scripted library -------------------------------------------------

interface Box {
  lib: any
  /** the package as the service sees it: its `SkillImportError` is the class `failureOf` tests */
  real: any
}
const box: Box = { lib: undefined, real: undefined }
;(globalThis as Record<symbol, unknown>)[Symbol.for('main-diff.skill-library')] = box

const LIB_URL = 'main-diff:skill-library'
const REAL_URL = 'main-diff:real-ai-provider'
// The shell's modules are compiled to CommonJS: the module is one too.
const LIB_SOURCE = [
  `const real = require('${REAL_URL}')`,
  `const box = globalThis[Symbol.for('main-diff.skill-library')]`,
  `box.real = real`,
  `const out = { ...real }`,
  `for (const name of ${JSON.stringify([
    'prepareSkillImport',
    'installImportedSkills',
    'disposeSkillImport',
    'checkGitHubSkillUpdate',
    'applyGitHubSkillUpdate',
    'exportSkillZip',
    'exportSkillBundleZip',
  ])}) out[name] = (...args) => box.lib[name](...args)`,
  `module.exports = out`,
].join('\n')
let realProvider: { url: string; format?: string | null | undefined } | undefined
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === '@seuoffice/ai-provider' &&
      /user-skills\/user-skills-(service|ipc)\.ts(\?.*)?$/.test(context.parentURL ?? '')
    ) {
      realProvider = next(specifier, context)
      return { url: LIB_URL, format: 'commonjs', shortCircuit: true }
    }
    if (specifier === REAL_URL && realProvider) return { ...realProvider, shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === LIB_URL) return { format: 'commonjs', source: LIB_SOURCE, shortCircuit: true }
    return next(url, context)
  },
})

const builtinDir = await import('../../../apps/shell/src/main/user-skills/builtin-dir.ts')
const service = await import('../../../apps/shell/src/main/user-skills/user-skills-service.ts')
const skillsIpc = await import('../../../apps/shell/src/main/user-skills/user-skills-ipc.ts')
const templateTabs = await import('../../../apps/shell/src/main/user-skills/template-tabs.ts')
const templateTabsIpc =
  await import('../../../apps/shell/src/main/user-skills/template-tabs-ipc.ts')
const handoff = await import('../../../packages/electron-utils/src/generate-handoff.ts')

type Log = (...args: unknown[]) => void

/** the held library call a case releases */
interface Gate {
  hold: boolean
  release: (() => void) | undefined
  opened: Promise<void> | undefined
}

function fakeLibrary(script: any, log: Log, gate: Gate) {
  const answer = (value: any): any => {
    if (value === undefined) throw new Error('no script')
    if (value && typeof value === 'object' && 'throw' in value) {
      throw new box.real.SkillImportError(value.throw, 'scripted')
    }
    return JSON.parse(JSON.stringify(value))
  }
  const held = async (): Promise<void> => {
    if (!gate.hold) return
    gate.opened = new Promise<void>((resolve) => {
      gate.release = resolve
    })
    await gate.opened
  }
  return {
    async prepareSkillImport(source: any, env: any) {
      await held()
      log('prepareSkillImport', source, {
        appSkillsDir: env.appSkillsDir,
        homeDir: env.homeDir,
        tempDir: env.tempDir,
        signal: env.signal !== undefined,
      })
      return answer(script.prepare)
    },
    async installImportedSkills(imported: any, options: any) {
      log(
        'installImportedSkills',
        imported.candidates.map((c: any) => c.key),
        {
          appSkillsDir: options.appSkillsDir,
          selected: options.selected,
          onCollision: options.onCollision,
        },
      )
      for (const dir of script.discard ?? []) {
        try {
          await options.discardReplaced?.(dir)
          log('discard', dir, true)
        } catch {
          log('discard', dir, false)
        }
      }
      for (const written of script.write ?? []) writeFileSync(written.path, written.text)
      return answer(script.install)
    },
    async disposeSkillImport(imported: any) {
      log('disposeSkillImport', imported.tempDir ?? null)
      if (imported.tempDir) rmSync(imported.tempDir, { recursive: true, force: true })
    },
    async checkGitHubSkillUpdate(options: any) {
      await held()
      log('checkGitHubSkillUpdate', {
        skillDir: options.skillDir,
        appSkillsDir: options.appSkillsDir,
        tempDir: options.tempDir,
        signal: options.signal !== undefined,
      })
      return answer(script.check)
    },
    async applyGitHubSkillUpdate(check: any, options: any) {
      log('applyGitHubSkillUpdate', check.commit, {
        skillDir: options.skillDir,
        appSkillsDir: options.appSkillsDir,
      })
      for (const dir of script.discard ?? []) {
        try {
          await options.discardReplaced?.(dir)
          log('discard', dir, true)
        } catch {
          log('discard', dir, false)
        }
      }
      for (const written of script.write ?? []) writeFileSync(written.path, written.text)
      return answer(script.apply)
    },
    async exportSkillZip(dir: string, out: string) {
      log('exportSkillZip', dir, out)
      answer(script.exportZip ?? {})
    },
    async exportSkillBundleZip(dirs: string[], out: string) {
      log('exportSkillBundleZip', dirs, out)
      answer(script.exportZip ?? {})
    },
  }
}

// ---- shared helpers -------------------------------------------------------

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))
const md = (...lines: string[]): string => lines.join('\n')
const SKILL = md('---', 'name: s', 'description: Does s', '---', 'body')
const skillMd = (name: string, extra: string[] = [], body = 'body'): string =>
  md('---', `name: ${name}`, `description: About ${name}`, ...extra, '---', body)

/** `a.hex` objects become bytes, in any depth of one level */
const hexBytes = (value: any): any => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.hex === 'string' && Object.keys(value).length === 1) {
      return new Uint8Array(Buffer.from(value.hex, 'hex'))
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hexBytes(v)]))
  }
  return value
}
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/** a name made from the six random characters of `suggestName`, a whole JSON string */
const RANDOM_NAME = /"skill-[a-z0-9]{6}"/g

/** an answer with the case folder as it was written and a random name as `skill-<random>` */
function unreal(value: unknown, root: string): any {
  let real = root
  try {
    real = realpathSync(root)
  } catch {
    // the folder is gone: nothing to map
  }
  return JSON.parse(
    JSON.stringify(value ?? null)
      .split(real)
      .join(root)
      .replace(RANDOM_NAME, '"skill-<random>"'),
  )
}

function serviceOf(opts: any, cx: TsContext, gate: Gate, root: string) {
  box.lib = fakeLibrary(opts.lib ?? {}, cx.log, gate)
  if (opts.plugins) {
    mkdirSync(join(root, 'home', '.claude', 'plugins'), { recursive: true })
    writeFileSync(
      join(root, 'home', '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify(opts.plugins),
    )
  }
  const trashFails: string[] = opts.trashFails ?? []
  return service.createUserSkillsService({
    homeDir: () => join(root, 'home'),
    builtinDir: () => (opts.builtin ? join(root, 'builtin') : undefined),
    settingsPath: () => join(root, 'settings.json'),
    tempDir: () => join(root, 'tmp'),
    trash: async (path: string) => {
      // the staging folder of an install is named by chance
      cx.log('trash', path.replace(/\.ieum-staging-[0-9a-f]{12}/, '.ieum-staging-RND'))
      if (trashFails.some((suffix) => path.endsWith(suffix))) throw new Error('trash refused')
      rmSync(path, { recursive: true, force: true })
    },
    fetch: async () => {
      throw new Error('no network')
    },
    aiFileMaxBytes: opts.aiMax,
  } as any)
}

const previewOf = (imported: any): any =>
  imported === undefined ? undefined : service.importPreviewOf(imported, 'tok')

/** the answer of a `checkUpdate` step, with the new version as its preview */
function checkSummary(answer: any): any {
  if (!answer.ok) return answer
  const check = answer.check
  const base = {
    status: check.status,
    record: check.record,
    commit: check.commit,
    locallyEdited: check.locallyEdited,
  }
  return {
    ok: true,
    check:
      check.status === 'changed'
        ? { ...base, changedFiles: check.changedFiles, update: previewOf(check.update) }
        : base,
  }
}

async function serviceStep(svc: any, step: any, root: string): Promise<any> {
  const a: any[] = (step.a ?? []).map(hexBytes)
  try {
    switch (step.m) {
      case 'prepare':
        return previewOf(await svc.prepare(a[0]))
      case 'dispose':
        await svc.dispose(a[0])
        return null
      case 'checkUpdate':
        return checkSummary(await svc.checkUpdate(a[0]))
      case 'install':
        return await svc.install(a[0], a[1])
      default:
        return unreal(await svc[step.m](...a), root)
    }
  } catch (error) {
    return { threw: (error as Error).message }
  }
}

// ---- user-skills-service --------------------------------------------------

const group: Group = { ...pkg }

group['builtin-dir.builtinSkillsDirFor'] = {
  ts: (args) => builtinDir.builtinSkillsDirFor(args[0] as never),
  cases: cases(
    [{ isPackaged: true, resourcesPath: '/app/resources', appPath: '/app/app.asar' }],
    [{ isPackaged: false, resourcesPath: '/app/resources', appPath: '/repo/apps/shell' }],
    [{ isPackaged: true, resourcesPath: '/r/', appPath: '/a' }],
  ),
}

group['user-skills-service.AI_SKILL_FILE_MAX_BYTES'] = {
  single: 'a fixed limit',
  ts: () => service.AI_SKILL_FILE_MAX_BYTES,
  cases: cases([]),
}

group['user-skills-service.SKILL_TEMPLATE_MAX_BYTES'] = {
  single: 'a fixed limit',
  ts: () => service.SKILL_TEMPLATE_MAX_BYTES,
  cases: cases([]),
}

group['user-skills-service.failureOf'] = {
  ts: (args) => {
    const e = args[0] as any
    const error = e.kind ? new box.real.SkillImportError(e.kind, 'x') : new Error('plain')
    return service.failureOf(error)
  },
  cases: cases([{ kind: 'not-found' }], [{ kind: 'too-large' }], [{}], [{ kind: 'needs-choice' }]),
}

group['user-skills-service.templateFileNameOf'] = {
  ts: (args) => service.templateFileNameOf(args[0] as string),
  cases: cases(
    ['report.docx'],
    ['C:\\Users\\me\\Report.DOCX'],
    ['/a/b/c.pdf'],
    ['.hidden.md'],
    ['a<b>:c.xlsx'],
    ['trailing. .txt '],
    ['noext'],
    ['.docx'],
    ['script.exe'],
    ['data.json'],
    ['x'.repeat(146) + '.docx'],
    ['x'.repeat(150) + '.md'],
    [''],
    ['dir/'],
    ['a\u0001b.txt'],
  ),
}

const CANDIDATE = (over: Record<string, unknown> = {}): any => ({
  key: 'k',
  rel: 'sub/k',
  dir: '/tmp/imp/sub/k',
  name: 'k',
  title: 'K',
  description: 'About k',
  files: 2,
  bytes: 20,
  hasScripts: false,
  hasTemplate: true,
  urls: ['https://example.com/a'],
  urlCount: 1,
  license: 'MIT',
  warnings: [{ messageKey: 'warnHideFromUser', file: 'SKILL.md', line: 3, excerpt: 'do not tell' }],
  warningCount: 1,
  collision: false,
  emptyBody: false,
  problem: undefined,
  ...over,
})

const IMPORT = (over: Record<string, unknown> = {}): any => ({
  origin: { kind: 'folder', folder: '/some/folder' },
  root: '/tmp/imp',
  candidates: [CANDIDATE()],
  rootLicense: undefined,
  tempDir: undefined,
  ...over,
})

group['user-skills-service.importPreviewOf'] = {
  ts: (args) => service.importPreviewOf(args[0] as never, args[1] as string),
  cases: cases(
    [IMPORT(), 'tok'],
    [
      IMPORT({
        origin: { kind: 'github', repo: 'o/r', ref: 'main', commit: 'abc', path: 'skills' },
        rootLicense: 'LICENSE',
        candidates: [
          CANDIDATE(),
          CANDIDATE({
            key: 'j',
            name: 'j',
            problem: 'duplicate',
            license: undefined,
            warnings: [],
          }),
        ],
      }),
      't2',
    ],
    [IMPORT({ origin: { kind: 'text' }, candidates: [] }), 't3'],
    [IMPORT({ origin: { kind: 'zip', file: '/a.zip' } }), 't4'],
    [IMPORT({ origin: { kind: 'skill-file', file: '/a/SKILL.md' } }), 't5'],
  ),
}

const HOME = 'home'
const APP = `${HOME}/.seuoffice/skills`
const SETTINGS = 'settings.json'
const BUILTIN = 'builtin'

/** the files of a library of several sources */
const LIBRARY: Record<string, string> = {
  [`${BUILTIN}/builtin-skills.json`]: JSON.stringify([
    { name: 'bi-one', source: 'o/r', path: 'p', commit: 'c', license: 'MIT', agentOnly: false },
    { name: 'bi-agent', agentOnly: true },
    { name: '' },
    'junk',
  ]),
  [`${BUILTIN}/bi-one/SKILL.md`]: skillMd('bi-one'),
  [`${BUILTIN}/bi-agent/SKILL.md`]: skillMd('bi-agent'),
  [`${APP}/mine/SKILL.md`]: skillMd('mine', [
    'metadata:',
    '  ieum-title: My skill',
    '  ieum-template: assets/t.docx',
  ]),
  [`${APP}/mine/assets/t.docx`]: 'DOCX-BYTES',
  [`${APP}/mine/notes.md`]: 'notes',
  [`${APP}/gh/SKILL.md`]: skillMd('gh'),
  [`${APP}/gh/.ieum-source.json`]: JSON.stringify({
    kind: 'github',
    repo: 'o/r',
    ref: 'main',
    path: 'skills/gh',
    commit: 'c1',
    installedAt: '2026-01-01T00:00:00Z',
    contentHash: 'h',
  }),
  [`${HOME}/.claude/skills/ext/SKILL.md`]: skillMd('ext'),
  [`${HOME}/.claude/skills/bi-one/SKILL.md`]: skillMd('bi-one'),
  [`${HOME}/.agents/skills/cx/SKILL.md`]: skillMd('cx'),
  [`${HOME}/.codex/skills/secret/SKILL.md`]: skillMd('secret'),
  [`${HOME}/plug-z/skills/pz/SKILL.md`]: skillMd('pz'),
  [`${HOME}/plug-a/skills/pa/SKILL.md`]: skillMd('pa'),
}

const withLibrary = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...LIBRARY,
  ...extra,
})

/** what the Claude plugin list of the case names, with the case folder written in */
const PLUGINS = {
  plugins: {
    'zeta@market': [{ installPath: '/nonexistent/old' }, { installPath: '$DIR/home/plug-z' }],
    'alpha@market': [{ installPath: '$DIR/home/plug-a' }],
    broken: 'x',
  },
}
const pluginsOf = (files: Record<string, unknown>): Record<string, unknown> =>
  `${HOME}/plug-z/skills/pz/SKILL.md` in files ? { plugins: PLUGINS } : {}

/** a service scenario case */
const scenario = (
  opts: Record<string, unknown>,
  steps: Array<{ m: string; a?: unknown[] }>,
  files: Record<string, string | { hex: string }> = {},
  note?: string,
): Case => ({
  args: [{ root: '$DIR', ...pluginsOf(files), ...opts }, steps],
  files,
  ...(note ? { note } : {}),
})

const owned = (name: string, extra: string[] = [], body = 'body') => ({
  [`${APP}/${name}/SKILL.md`]: skillMd(name, extra, body),
})

group['user-skills-service.createUserSkillsService'] = {
  ts: async (args, cx) => {
    const [opts, steps] = args as [any, any[]]
    const gate: Gate = { hold: false, release: undefined, opened: undefined }
    const svc = serviceOf(opts, cx, gate, opts.root)
    const out: any[] = []
    for (const step of steps) out.push(await serviceStep(svc, step, opts.root))
    return out
  },
  cases: [
    scenario({ builtin: true }, [{ m: 'list' }, { m: 'enabledForAgent' }], withLibrary()),
    scenario({ builtin: true }, [{ m: 'enabledForAgent', a: ['$DIR/proj'] }], {
      ...withLibrary(),
      'proj/.claude/skills/pj/SKILL.md': skillMd('pj'),
      'proj/.agents/skills/pj/SKILL.md': skillMd('pj', [], 'second'),
    }),
    scenario({}, [{ m: 'list' }], {
      [`${APP}/bad/SKILL.md`]: md('---', 'name: bad', 'description: "\\U00110000"', '---', 'b'),
    }),
    scenario(
      { builtin: true },
      [
        { m: 'read', a: ['app:mine'] },
        { m: 'read', a: ['APP:Mine'] },
        { m: 'read', a: ['project:x'] },
        { m: 'read', a: ['nope'] },
        { m: 'read', a: ['builtin:bi-one'] },
        { m: 'read', a: ['user:ext'] },
      ],
      withLibrary(),
    ),
    scenario(
      { builtin: true },
      [
        { m: 'setState', a: ['user:ext', { enabled: true }] },
        { m: 'setState', a: ['user:ext', { invoke: 'manual' }] },
        { m: 'setState', a: ['user:ext', { enabled: false }] },
        { m: 'setState', a: ['user:ext', { invoke: 'auto' }] },
        { m: 'setState', a: ['app:mine', { enabled: false }] },
        { m: 'setState', a: ['app:mine', { editors: ['docs'] }] },
        { m: 'setState', a: ['builtin:bi-one', { editors: ['docs', 'sheets'] }] },
        { m: 'setState', a: ['builtin:bi-one', { editors: 'all' }] },
        { m: 'setState', a: ['nope:x', { enabled: true }] },
        { m: 'list' },
      ],
      withLibrary(),
    ),
    scenario(
      { builtin: true },
      [
        { m: 'hideBuiltin', a: ['builtin:bi-one'] },
        { m: 'setState', a: ['builtin:bi-one', { enabled: true }] },
        { m: 'hideBuiltin', a: ['builtin:bi-one'] },
        { m: 'hideBuiltin', a: ['app:mine'] },
        { m: 'hideBuiltin', a: ['builtin:missing'] },
        { m: 'unhideBuiltins', a: [['BI-ONE']] },
        { m: 'hideBuiltin', a: ['builtin:bi-agent'] },
        { m: 'unhideBuiltins' },
        { m: 'setState', a: ['user:broken', { enabled: true }] },
      ],
      withLibrary({ [`${HOME}/.claude/skills/broken/readme.md`]: 'no skill' }),
    ),
    scenario(
      { builtin: true },
      [
        { m: 'setState', a: ['builtin:bi-one', { enabled: false, invoke: 'manual' }] },
        { m: 'unhideBuiltins', a: [['other']] },
        { m: 'unhideBuiltins', a: [[]] },
      ],
      withLibrary(),
    ),
    scenario(
      {},
      [
        { m: 'remove', a: ['app:mine'] },
        { m: 'remove', a: ['user:ext'] },
        { m: 'remove', a: ['app:missing'] },
        { m: 'setState', a: ['app:gh', { enabled: false }] },
        { m: 'remove', a: ['app:gh'] },
        { m: 'list' },
      ],
      withLibrary(),
    ),
    scenario(
      { trashFails: ['mine'] },
      [{ m: 'remove', a: ['app:mine'] }, { m: 'list' }],
      withLibrary(),
    ),
    scenario(
      { builtin: true },
      [
        { m: 'copyToMine', a: ['builtin:bi-one'] },
        { m: 'copyToMine', a: ['builtin:bi-one'] },
        { m: 'copyToMine', a: ['builtin:bi-one', true] },
        { m: 'copyToMine', a: ['app:mine'] },
        { m: 'copyToMine', a: ['user:ext'] },
        { m: 'copyToMine', a: ['missing:x'] },
        { m: 'list' },
      ],
      withLibrary(),
    ),
    scenario(
      { builtin: true },
      [
        { m: 'setState', a: ['user:ext', { editors: ['docs'], enabled: true }] },
        { m: 'copyToMine', a: ['user:ext'] },
        { m: 'read', a: ['app:ext'] },
      ],
      withLibrary({
        [`${HOME}/.claude/skills/ext/SKILL.md`]: skillMd('ext', [
          'metadata:',
          '  ieum-editors: sheets',
        ]),
      }),
    ),
    scenario(
      {},
      [
        { m: 'suggestName', a: ['Weekly Report'] },
        { m: 'suggestName', a: ['Mine'] },
        { m: 'suggestName', a: ['seuoffice'] },
      ],
      withLibrary({ [`${HOME}/.seuoffice/skills/weekly-report/x`]: 'x' }),
    ),
    scenario(
      {},
      [
        { m: 'checkName', a: ['good-name'] },
        { m: 'checkName', a: ['mine'] },
        { m: 'checkName', a: ['mine', 'app:mine'] },
        { m: 'checkName', a: ['Bad Name'] },
        { m: 'checkName', a: ['gh', 'app:mine'] },
        { m: 'checkName', a: ['', 'user:x'] },
        { m: 'checkName', a: ['seuoffice'] },
      ],
      withLibrary(),
    ),
    // ---- save
    scenario(
      { builtin: true },
      [
        { m: 'save', a: [{ title: 'Brand New', description: 'Makes it', body: 'Do the thing' }] },
        { m: 'save', a: [{ title: 'Brand New', description: 'Makes it', body: 'again' }] },
        {
          m: 'save',
          a: [
            {
              title: '',
              name: 'plain-name',
              description: '  Makes  ',
              body: 'b',
              editors: ['docs', 'sheets'],
            },
          ],
        },
        { m: 'save', a: [{ title: 'x', description: '   ', body: 'b' }] },
        { m: 'save', a: [{ title: 'x', description: 'd', body: '  \n ' }] },
        { m: 'save', a: [{ title: 'x', name: 'Bad Name', description: 'd', body: 'b' }] },
        { m: 'save', a: [{ title: 'x', name: 'seuoffice', description: 'd', body: 'b' }] },
        { m: 'save', a: [{ title: 'x', name: 'bi-one', description: 'd', body: 'b' }] },
        {
          m: 'save',
          a: [{ title: 'x', name: 'bi-one', description: 'd', body: 'b', turnOffSameName: true }],
        },
        { m: 'list' },
      ],
      withLibrary(),
    ),
    scenario(
      {},
      [
        {
          m: 'save',
          a: [
            {
              id: 'app:csv',
              title: 'T',
              description: 'D',
              body: 'B',
              editors: ['docs', 'sheets'],
            },
          ],
        },
        {
          m: 'save',
          a: [{ id: 'app:one', title: 'T', description: 'D', body: 'B', editors: 'all' }],
        },
        { m: 'read', a: ['app:csv'] },
        { m: 'read', a: ['app:one'] },
      ],
      withLibrary({
        [`${APP}/csv/SKILL.md`]: skillMd('csv', ['metadata:', '  ieum-editors: docs,sheets']),
        [`${APP}/one/SKILL.md`]: skillMd('one', ['metadata:', '  ieum-editors: docs']),
      }),
    ),
    scenario(
      { builtin: true },
      [
        {
          m: 'save',
          a: [
            {
              id: 'app:mine',
              title: 'Renamed',
              description: 'New desc',
              body: 'New body',
              editors: 'all',
            },
          ],
        },
        { m: 'read', a: ['app:mine'] },
        {
          m: 'save',
          a: [{ id: 'app:mine', name: 'moved', title: 'Moved', description: 'D', body: 'B' }],
        },
        {
          m: 'save',
          a: [{ id: 'app:moved', name: 'gh', title: 'Moved', description: 'D', body: 'B' }],
        },
        {
          m: 'save',
          a: [{ id: 'app:moved', name: 'ext', title: 'M', description: 'D', body: 'B' }],
        },
        {
          m: 'save',
          a: [
            {
              id: 'app:moved',
              name: 'ext',
              title: 'M',
              description: 'D',
              body: 'B',
              turnOffSameName: true,
            },
          ],
        },
        {
          m: 'save',
          a: [{ id: 'app:moved', name: 'Bad Name', title: 'M', description: 'D', body: 'B' }],
        },
        { m: 'save', a: [{ id: 'user:ext', title: 'M', description: 'D', body: 'B' }] },
        { m: 'save', a: [{ id: 'app:ghost', title: 'M', description: 'D', body: 'B' }] },
        { m: 'list' },
      ],
      withLibrary(),
    ),
    scenario(
      {},
      [
        { m: 'setState', a: ['app:mine', { invoke: 'manual' }] },
        {
          m: 'save',
          a: [{ id: 'app:mine', name: 'mine2', title: 'T', description: 'D', body: 'B' }],
        },
        { m: 'list' },
      ],
      withLibrary(),
    ),
    // ---- saveFromCard
    scenario(
      { builtin: true },
      [
        {
          m: 'saveFromCard',
          a: [
            {
              title: 'Card',
              name: 'card-one',
              description: 'D',
              body: 'B',
              invoke: 'manual',
              template: { bytes: { hex: '504b0304' }, fileName: 'Form.DOCX' },
            },
          ],
        },
        { m: 'read', a: ['app:card-one'] },
        {
          m: 'saveFromCard',
          a: [
            {
              title: 'Card',
              name: 'card-one',
              description: 'D2',
              body: 'B2',
              invoke: 'auto',
              targetId: 'app:card-one',
            },
          ],
        },
        {
          m: 'saveFromCard',
          a: [
            {
              title: 'Card',
              name: 'card-two',
              description: 'D',
              body: 'B',
              invoke: 'auto',
              template: { bytes: 'not bytes', fileName: 'a.docx' },
            },
          ],
        },
        {
          m: 'saveFromCard',
          a: [
            {
              title: 'Card',
              name: 'card-two',
              description: 'D',
              body: 'B',
              invoke: 'auto',
              template: { bytes: { hex: '00' }, fileName: 'a.exe' },
            },
          ],
        },
        {
          m: 'saveFromCard',
          a: [{ title: 'Card', name: '', description: 'D', body: 'B', invoke: 'auto' }],
        },
        {
          m: 'saveFromCard',
          a: [
            {
              title: 'Card',
              name: 'bi-one',
              description: 'D',
              body: 'B',
              invoke: 'auto',
              targetId: 'builtin:bi-one',
            },
          ],
        },
        {
          m: 'saveFromCard',
          a: [
            {
              title: 'Card',
              name: 'bi-one',
              description: 'D',
              body: 'B',
              invoke: 'auto',
              targetId: 'builtin:bi-one',
              overwrite: true,
            },
          ],
        },
        {
          m: 'saveFromCard',
          a: [
            {
              title: 'Card',
              name: 'bi-one',
              description: 'D',
              body: 'B',
              invoke: 'auto',
              targetId: 'builtin:bi-one',
              overwrite: true,
              turnOffSameName: true,
            },
          ],
        },
        {
          m: 'saveFromCard',
          a: [
            {
              title: 'Card',
              name: 'x',
              description: 'D',
              body: 'B',
              invoke: 'auto',
              targetId: 'project:x',
            },
          ],
        },
        {
          m: 'saveFromCard',
          a: [
            {
              title: 'Card',
              name: 'x',
              description: 'D',
              body: 'B',
              invoke: 'auto',
              targetId: 'app:ghost',
            },
          ],
        },
        { m: 'list' },
      ],
      withLibrary(),
    ),
    scenario(
      {},
      [
        {
          m: 'saveFromCard',
          a: [
            {
              title: 'Edit',
              name: 'mine',
              description: 'D',
              body: 'B',
              invoke: 'manual',
              targetId: 'app:mine',
              template: { bytes: { hex: 'aabb' }, fileName: 'new.xlsx' },
              editors: ['sheets'],
            },
          ],
        },
        { m: 'read', a: ['app:mine'] },
        { m: 'templateFile', a: ['app:mine'] },
        {
          m: 'saveFromCard',
          a: [
            {
              title: 'Edit',
              name: 'mine',
              description: 'D',
              body: 'B',
              invoke: 'auto',
              targetId: 'app:mine',
              editors: 'all',
            },
          ],
        },
      ],
      withLibrary(),
    ),
    scenario(
      {},
      [
        {
          m: 'saveFromCard',
          a: [
            {
              title: 'Copy',
              name: 'ext',
              description: 'D',
              body: 'B',
              invoke: 'auto',
              targetId: 'user:ext',
            },
          ],
        },
        { m: 'list' },
      ],
      {
        [`${HOME}/.claude/skills/ext/SKILL.md`]: skillMd('ext'),
        [`${HOME}/.claude/skills/ext/big.bin`]: 'x',
      },
    ),
    // ---- imports
    scenario(
      {
        lib: {
          prepare: IMPORT({
            tempDir: '$DIR/tmp/import-1',
            candidates: [CANDIDATE({ dir: '$DIR/tmp/import-1/k' })],
          }),
        },
      },
      [
        { m: 'prepare', a: [{ kind: 'folder', folder: '$DIR/some' }] },
        { m: 'dispose', a: [IMPORT({ tempDir: '$DIR/tmp/import-1' })] },
        { m: 'dispose', a: [IMPORT()] },
      ],
      { 'tmp/import-1/k/SKILL.md': SKILL },
    ),
    scenario({ lib: { prepare: { throw: 'bad-address' } } }, [
      { m: 'prepare', a: [{ kind: 'github', address: 'nope' }] },
    ]),
    scenario({}, [{ m: 'prepare', a: [{ kind: 'text', text: 'x' }] }]),
    scenario(
      {
        lib: {
          install: {
            installed: [
              {
                key: 'mine',
                name: 'mine',
                dir: '$DIR/home/.seuoffice/skills/mine',
                replaced: true,
              },
              {
                key: 'fresh',
                name: 'fresh',
                dir: '$DIR/home/.seuoffice/skills/fresh',
                replaced: false,
              },
            ],
            skipped: ['s'],
          },
          discard: ['$DIR/old/one'],
        },
      },
      [
        { m: 'setState', a: ['app:mine', { invoke: 'manual', enabled: false }] },
        {
          m: 'install',
          a: [
            IMPORT({
              candidates: [
                CANDIDATE({ key: 'mine', name: 'mine' }),
                CANDIDATE({ key: 'fresh', name: 'fresh' }),
              ],
            }),
            { selected: ['mine', 'fresh'], onCollision: { mine: 'replace' } },
          ],
        },
        { m: 'list' },
      ],
      { ...withLibrary(), ...owned('fresh'), 'old/one/f': 'f' },
    ),
    scenario({ lib: { install: { throw: 'needs-choice' } } }, [
      { m: 'install', a: [IMPORT(), { selected: ['k'], onCollision: {} }] },
    ]),
    scenario(
      {
        lib: {
          install: {
            installed: [
              {
                key: 'mine',
                name: 'mine-renamed',
                dir: '$DIR/home/.seuoffice/skills/mine',
                replaced: true,
              },
            ],
            skipped: [],
          },
        },
      },
      [
        { m: 'setState', a: ['app:mine', { invoke: 'manual' }] },
        {
          m: 'install',
          a: [
            IMPORT({ candidates: [CANDIDATE({ key: 'mine', name: 'mine' })] }),
            { selected: ['mine'], onCollision: { mine: 'replace' } },
          ],
        },
        { m: 'list' },
      ],
      { ...withLibrary(), [`${APP}/mine/SKILL.md`]: skillMd('mine-renamed') },
    ),
    scenario(
      {
        lib: {
          install: {
            installed: [
              {
                key: 'mine',
                name: 'mine',
                dir: '$DIR/home/.seuoffice/skills/mine',
                replaced: true,
              },
            ],
            skipped: [],
          },
        },
      },
      [
        {
          m: 'install',
          a: [
            IMPORT({ candidates: [CANDIDATE({ key: 'mine', name: 'mine' })] }),
            { selected: ['mine'], onCollision: { mine: 'replace' } },
          ],
        },
        { m: 'read', a: ['app:mine'] },
      ],
      { [`${APP}/mine/SKILL.md`]: skillMd('mine', ['metadata:', '  ieum-editors: docs']) },
    ),
    // ---- reading an import
    scenario(
      {},
      [
        { m: 'readImported', a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/k' })] }), 'k'] },
        {
          m: 'readImported',
          a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/k' })] }), 'zzz'],
        },
        {
          m: 'readImported',
          a: [
            IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/k', problem: 'too-large' })] }),
            'k',
          ],
        },
        {
          m: 'readImported',
          a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/none' })] }), 'k'],
        },
        {
          m: 'readImported',
          a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/nomd' })] }), 'k'],
        },
        {
          m: 'readImported',
          a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/long' })] }), 'k'],
        },
        {
          m: 'readImported',
          a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/pair' })] }), 'k'],
        },
      ],
      {
        'imp/k/SKILL.md': skillMd('k', [], 'imported body'),
        'imp/k/notes.txt': 'n',
        'imp/k/.ieum-source.json': '{}',
        'imp/k/bin.dat': 'b',
        'imp/k/sub/more.json': '{}',
        'imp/nomd/other.txt': 'x',
        'imp/long/SKILL.md': skillMd('k', [], 'y'.repeat(20_050)),
        'imp/pair/SKILL.md': skillMd('k', [], 'z'.repeat(19_999) + '\ud83d\ude00' + 'tail'),
      },
    ),
    scenario(
      {},
      [
        {
          m: 'readImportedFile',
          a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/k' })] }), 'k', 'notes.txt'],
        },
        {
          m: 'readImportedFile',
          a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/k' })] }), 'k', 'sub/more.json'],
        },
        {
          m: 'readImportedFile',
          a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/k' })] }), 'k', '../x.txt'],
        },
        {
          m: 'readImportedFile',
          a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/k' })] }), 'k', 'bin.dat'],
        },
        {
          m: 'readImportedFile',
          a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/k' })] }), 'k', 'missing.txt'],
        },
        {
          m: 'readImportedFile',
          a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/k' })] }), 'k', 'sub'],
        },
        {
          m: 'readImportedFile',
          a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/k' })] }), 'zz', 'notes.txt'],
        },
        {
          m: 'readImportedFile',
          a: [
            IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/k', problem: 'too-large' })] }),
            'k',
            'notes.txt',
          ],
        },
        {
          m: 'readImportedFile',
          a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/big' })] }), 'k', 'big.txt'],
        },
        {
          m: 'readImportedFile',
          a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/big' })] }), 'k', 'bad.md'],
        },
        {
          m: 'readImportedFile',
          a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/k' })] }), 'k', 'sub\\more.json'],
        },
        {
          m: 'readImportedFile',
          a: [IMPORT({ candidates: [CANDIDATE({ dir: '$DIR/imp/k' })] }), 'k', './notes.txt'],
        },
      ],
      {
        'imp/k/SKILL.md': SKILL,
        'imp/k/notes.txt': 'notes text',
        'imp/k/bin.dat': 'b',
        'imp/k/sub/more.json': '{"a":1}',
        'imp/big/big.txt': 'q'.repeat(90_000),
        'imp/big/bad.md': Buffer.from([0x41, 0xff, 0x42]).toString('latin1'),
      },
    ),
    // ---- updates
    scenario(
      {
        lib: {
          check: {
            status: 'changed',
            record: {
              kind: 'github',
              repo: 'o/r',
              ref: 'main',
              path: 'skills/gh',
              commit: 'c1',
              installedAt: 'i',
              contentHash: 'h',
            },
            commit: 'c2',
            locallyEdited: false,
            changedFiles: [{ rel: 'SKILL.md', change: 'modified' }],
            update: IMPORT({
              origin: { kind: 'github', repo: 'o/r', ref: 'main', commit: 'c2', path: 'skills/gh' },
              tempDir: '$DIR/tmp/check',
            }),
          },
        },
      },
      [
        { m: 'checkUpdate', a: ['app:gh'] },
        { m: 'checkUpdate', a: ['app:mine'] },
        { m: 'checkUpdate', a: ['user:ext'] },
        { m: 'checkUpdate', a: ['app:ghost'] },
      ],
      withLibrary(),
    ),
    scenario(
      {
        lib: {
          check: {
            status: 'up-to-date',
            record: {
              kind: 'github',
              repo: 'o/r',
              ref: 'main',
              path: 'p',
              commit: 'c1',
              installedAt: 'i',
              contentHash: 'h',
            },
            commit: 'c1',
            locallyEdited: true,
          },
        },
      },
      [{ m: 'checkUpdate', a: ['app:gh'] }],
      withLibrary(),
    ),
    scenario(
      { lib: { check: { throw: 'rate-limited' } } },
      [{ m: 'checkUpdate', a: ['app:gh'] }],
      withLibrary(),
    ),
    scenario(
      {
        lib: {
          apply: { key: 'gh', name: 'gh', dir: '$DIR/home/.seuoffice/skills/gh', replaced: true },
          discard: ['$DIR/trashed'],
        },
      },
      [
        { m: 'setState', a: ['app:gh', { invoke: 'manual' }] },
        {
          m: 'applyUpdate',
          a: [
            'app:gh',
            {
              status: 'changed',
              record: { repo: 'o/r' },
              commit: 'c2',
              locallyEdited: false,
              changedFiles: [],
              update: IMPORT({ tempDir: '$DIR/tmp/check' }),
            },
          ],
        },
        {
          m: 'applyUpdate',
          a: [
            'app:ghost',
            {
              status: 'changed',
              record: { repo: 'o/r' },
              commit: 'c3',
              locallyEdited: false,
              changedFiles: [],
              update: IMPORT({ tempDir: '$DIR/tmp/check2' }),
            },
          ],
        },
        {
          m: 'applyUpdate',
          a: [
            'user:ext',
            {
              status: 'changed',
              record: { repo: 'o/r' },
              commit: 'c4',
              locallyEdited: false,
              changedFiles: [],
              update: IMPORT(),
            },
          ],
        },
        { m: 'list' },
      ],
      { ...withLibrary(), 'tmp/check/x': 'x', 'tmp/check2/y': 'y', 'trashed/z': 'z' },
    ),
    scenario(
      { lib: { apply: { throw: 'too-large' } } },
      [
        {
          m: 'applyUpdate',
          a: [
            'app:gh',
            {
              status: 'changed',
              record: { repo: 'o/r' },
              commit: 'c5',
              locallyEdited: false,
              changedFiles: [],
              update: IMPORT(),
            },
          ],
        },
      ],
      withLibrary(),
    ),
    scenario(
      {
        lib: {
          apply: {
            key: 'gh',
            name: 'gh-new',
            dir: '$DIR/home/.seuoffice/skills/gh',
            replaced: true,
          },
        },
      },
      [
        { m: 'setState', a: ['app:gh', { enabled: false }] },
        {
          m: 'applyUpdate',
          a: [
            'app:gh',
            {
              status: 'changed',
              record: { repo: 'o/r' },
              commit: 'c6',
              locallyEdited: false,
              changedFiles: [],
              update: IMPORT(),
            },
          ],
        },
        { m: 'list' },
      ],
      { ...withLibrary(), [`${APP}/gh/SKILL.md`]: skillMd('gh-new') },
    ),
    // ---- export
    scenario(
      {},
      [
        { m: 'exportInfo', a: ['app:mine'] },
        { m: 'exportInfo', a: ['app:gh'] },
        { m: 'exportInfo', a: ['user:ext'] },
        { m: 'exportInfo', a: ['app:ghost'] },
        { m: 'exportTo', a: ['app:mine', '$DIR/out.zip'] },
        { m: 'exportTo', a: ['user:ext', '$DIR/out.zip'] },
        { m: 'exportTo', a: ['app:ghost', '$DIR/out.zip'] },
        { m: 'exportBundleTo', a: [['app:mine', 'app:gh'], '$DIR/b.zip'] },
        { m: 'exportBundleTo', a: [['app:mine', 'user:ext'], '$DIR/b.zip'] },
        { m: 'exportBundleTo', a: [['app:mine', 'app:ghost'], '$DIR/b.zip'] },
      ],
      withLibrary(),
    ),
    scenario(
      { lib: { exportZip: { throw: 'failed' } } },
      [
        { m: 'exportTo', a: ['app:mine', '$DIR/out.zip'] },
        { m: 'exportBundleTo', a: [['app:mine'], '$DIR/b.zip'] },
      ],
      withLibrary(),
    ),
    scenario(
      {},
      [
        { m: 'exportInfo', a: ['app:empty'] },
        { m: 'exportInfo', a: ['app:cr'] },
      ],
      {
        [`${APP}/empty/readme.md`]: 'no skill',
        ...owned('cr', ['metadata:', '  ieum-title: Con/Title']),
      },
    ),
    // ---- folders and AI reads
    scenario(
      { builtin: true },
      [
        { m: 'folderOf', a: ['app:mine'] },
        { m: 'folderOf', a: ['user:ext'] },
        { m: 'folderOf', a: ['builtin:bi-one'] },
        { m: 'folderOf', a: ['plugin:alpha:pa'] },
        { m: 'folderOf', a: ['nope:x'] },
      ],
      withLibrary(),
    ),
    scenario(
      { builtin: true },
      [
        { m: 'aiRead', a: ['app:mine'] },
        { m: 'aiRead', a: ['builtin:bi-agent'] },
        { m: 'aiRead', a: ['user:ext'] },
        { m: 'aiRead', a: ['app:ghost'] },
        { m: 'aiRead', a: ['app:broken'] },
        { m: 'aiRead', a: ['app:notpl'] },
        { m: 'setState', a: ['user:ext', { enabled: true }] },
        { m: 'aiRead', a: ['user:ext'] },
        { m: 'aiRead', a: ['app:badfm'] },
      ],
      withLibrary({
        [`${APP}/broken/readme.md`]: 'x',
        ...owned('notpl', ['metadata:', '  ieum-template: assets/gone.docx'], 'uses mcp__srv__t'),
        [`${APP}/badfm/SKILL.md`]: 'no front matter',
        [`${APP}/mine/scripts/run.sh`]: 'echo',
        [`${APP}/mine/data.csv`]: 'a,b',
      }),
    ),
    scenario(
      { builtin: true },
      [
        { m: 'templateFile', a: ['app:mine'] },
        { m: 'templateFile', a: ['app:ghost'] },
        { m: 'templateFile', a: ['builtin:bi-agent'] },
        { m: 'templateFile', a: ['app:notpl'] },
        { m: 'templateFile', a: ['app:gone'] },
        { m: 'templateFile', a: ['app:badext'] },
        { m: 'templateFile', a: ['user:ext'] },
        { m: 'templateFile', a: ['app:broken'] },
        { m: 'templateFile', a: ['app:dirtpl'] },
      ],
      withLibrary({
        [`${APP}/broken/readme.md`]: 'x',
        ...owned('notpl'),
        ...owned('gone', ['metadata:', '  ieum-template: assets/gone.docx']),
        ...owned('badext', ['metadata:', '  ieum-template: assets/run.exe']),
        [`${APP}/badext/assets/run.exe`]: 'MZ',
        ...owned('dirtpl', ['metadata:', '  ieum-template: assets/folder.docx']),
        [`${APP}/dirtpl/assets/folder.docx/inner.txt`]: 'x',
      }),
    ),
    scenario(
      { builtin: true, aiMax: 10 },
      [
        { m: 'aiReadFile', a: ['app:mine', 'notes.md'] },
        { m: 'aiReadFile', a: ['app:mine', 'data.csv'] },
        { m: 'aiReadFile', a: ['app:mine', 'assets/t.docx'] },
        { m: 'aiReadFile', a: ['app:mine', '../gh/SKILL.md'] },
        { m: 'aiReadFile', a: ['app:mine', 'long.txt'] },
        { m: 'aiReadFile', a: ['app:mine', 'missing.md'] },
        { m: 'aiReadFile', a: ['user:ext', 'SKILL.md'] },
        { m: 'aiReadFile', a: ['builtin:bi-agent', 'SKILL.md'] },
        { m: 'aiReadFile', a: ['app:ghost', 'SKILL.md'] },
        { m: 'aiReadFile', a: ['app:mine', 'SKILL.md'] },
      ],
      withLibrary({
        [`${APP}/mine/data.csv`]: 'a,b',
        [`${APP}/mine/long.txt`]: 'this is longer than ten bytes',
      }),
    ),
    scenario(
      {},
      [{ m: 'aiReadFile', a: ['app:mine', 'notes.md'] }, { m: 'enabledForAgent' }],
      withLibrary(),
    ),
    scenario(
      { builtin: true },
      [
        { m: 'setState', a: ['plugin:zeta:pz', { enabled: true }] },
        { m: 'setState', a: ['plugin:alpha:pa', { enabled: true }] },
        { m: 'save', a: [{ title: 'P', name: 'pz', description: 'D', body: 'B' }] },
        { m: 'save', a: [{ title: 'P', name: 'pa', description: 'D', body: 'B' }] },
        { m: 'setState', a: ['user:ext', { enabled: true }] },
        { m: 'setState', a: ['user:ext', { editors: ['sheets'] }] },
        { m: 'setState', a: ['user:ext', { editors: ['docs'] }] },
        { m: 'list' },
      ],
      withLibrary({
        [`${HOME}/.claude/skills/ext/SKILL.md`]: skillMd('ext', [
          'metadata:',
          '  ieum-editors: sheets',
        ]),
      }),
    ),
    scenario(
      {
        lib: {
          install: {
            installed: [
              {
                key: 'mine',
                name: 'mine',
                dir: '$DIR/home/.seuoffice/skills/mine',
                replaced: true,
              },
            ],
            skipped: [],
          },
          write: [
            {
              path: '$DIR/home/.seuoffice/skills/mine/SKILL.md',
              text: skillMd('mine', ['metadata:', '  ieum-title: Fresh']),
            },
          ],
        },
      },
      [
        {
          m: 'install',
          a: [
            IMPORT({ candidates: [CANDIDATE({ key: 'mine', name: 'mine' })] }),
            { selected: ['mine'], onCollision: { mine: 'replace' } },
          ],
        },
        { m: 'read', a: ['app:mine'] },
      ],
      { [`${APP}/mine/SKILL.md`]: skillMd('mine', ['metadata:', '  ieum-editors: docs sheets']) },
    ),
    scenario(
      {
        lib: {
          install: {
            installed: [
              {
                key: 'mine',
                name: 'mine',
                dir: '$DIR/home/.seuoffice/skills/mine',
                replaced: true,
              },
            ],
            skipped: [],
          },
          write: [
            {
              path: '$DIR/home/.seuoffice/skills/mine/SKILL.md',
              text: skillMd('mine', ['metadata:', '  ieum-editors: pdf']),
            },
          ],
        },
      },
      [
        {
          m: 'install',
          a: [
            IMPORT({ candidates: [CANDIDATE({ key: 'mine', name: 'mine' })] }),
            { selected: ['mine'], onCollision: { mine: 'replace' } },
          ],
        },
        { m: 'read', a: ['app:mine'] },
      ],
      { [`${APP}/mine/SKILL.md`]: skillMd('mine', ['metadata:', '  ieum-editors: docs']) },
    ),
    scenario(
      {
        lib: {
          apply: { key: 'gh', name: 'gh', dir: '$DIR/home/.seuoffice/skills/gh', replaced: true },
          write: [{ path: '$DIR/home/.seuoffice/skills/gh/SKILL.md', text: skillMd('gh') }],
        },
      },
      [
        {
          m: 'applyUpdate',
          a: [
            'app:gh',
            {
              status: 'changed',
              record: { repo: 'o/r' },
              commit: 'c7',
              locallyEdited: false,
              changedFiles: [],
              update: IMPORT(),
            },
          ],
        },
        { m: 'read', a: ['app:gh'] },
      ],
      {
        ...withLibrary(),
        [`${APP}/gh/SKILL.md`]: skillMd('gh', ['metadata:', '  ieum-editors: hwp']),
      },
    ),
    scenario(
      { builtin: true },
      [
        { m: 'hideBuiltin', a: ['builtin:bi-one'] },
        { m: 'unhideBuiltins', a: [['BI-ONE']] },
        { m: 'list' },
        { m: 'hideBuiltin', a: ['builtin:bi-one'] },
        { m: 'unhideBuiltins', a: [['bi-one']] },
        { m: 'list' },
      ],
      withLibrary(),
    ),
    scenario(
      {},
      [
        { m: 'read', a: ['plugin:ZETA:pz'] },
        { m: 'setState', a: ['plugin:Alpha:pa', { enabled: true }] },
        { m: 'list' },
      ],
      withLibrary(),
    ),
  ],
}

// ---- user-skills-ipc ------------------------------------------------------

group['user-skills-ipc.DROPPED_SKILLS_MAX'] = {
  single: 'a fixed limit',
  ts: () => skillsIpc.DROPPED_SKILLS_MAX,
  cases: cases([]),
}

async function runIpc(args: unknown[], cx: TsContext): Promise<any> {
  const [opts, steps] = args as [any, any[]]
  const root: string = opts.root
  const gate: Gate = { hold: false, release: undefined, opened: undefined }
  const svc = serviceOf(opts, cx, gate, root)
  const handlers = new Map<string, (...a: any[]) => any>()
  const destroyed = new Set<number>()
  const listeners = new Map<number, Array<() => void>>()
  const senders = new Map<number, any>()
  const senderOf = (id: number): any => {
    let sender = senders.get(id)
    if (!sender) {
      sender = {
        id,
        isDestroyed: () => destroyed.has(id),
        once: (_event: string, listener: () => void) => {
          listeners.set(id, [...(listeners.get(id) ?? []), listener])
        },
        send: (channel: string, ...rest: unknown[]) => cx.log('send', id, channel, ...rest),
      }
      senders.set(id, sender)
    }
    return sender
  }
  const contents = ((opts.contents ?? []) as number[]).map((id) => senderOf(id))
  const dialogs = { open: [...(opts.dialogs?.open ?? [])], save: [...(opts.dialogs?.save ?? [])] }
  useElectron({
    ipcMain: {
      handle: (channel: string, fn: any) => handlers.set(channel, fn),
      on() {},
      removeHandler() {},
    },
    BrowserWindow: {
      fromWebContents: (wc: any) => (opts.parent ? { id: wc.id } : null),
    },
    dialog: {
      showOpenDialog: async (...given: unknown[]) => {
        cx.log('showOpenDialog', given.length === 2, given[given.length - 1])
        return dialogs.open.shift() ?? { canceled: true, filePaths: [] }
      },
      showSaveDialog: async (...given: unknown[]) => {
        cx.log('showSaveDialog', given.length === 2, given[given.length - 1])
        return dialogs.save.shift() ?? { canceled: true }
      },
    },
    shell: {
      openPath: async (path: string) => {
        cx.log('openPath', path)
        return opts.openPathError ?? ''
      },
    },
    webContents: { getAllWebContents: () => contents },
  })
  const manage = opts.manage ?? true
  const ipc = skillsIpc.registerUserSkillsIpc({
    service: svc,
    canManage: (sender: any, channel: string) => {
      cx.log('canManage', sender.id, channel)
      return Array.isArray(manage) ? manage.includes(channel) : manage
    },
    openSettings: () => cx.log('openSettings'),
    agentNoticeDue: () => {
      cx.log('agentNoticeDue')
      if (opts.notice === 'throw') throw new Error('settings unreadable')
      return opts.notice === true
    },
    markAgentNoticeSeen: () => {
      cx.log('markAgentNoticeSeen')
      if (opts.markThrows) throw new Error('unwritable')
    },
  } as any)
  const out: any[] = []
  let lastToken = ''
  let held: Promise<any> | undefined
  const fill = (value: any): any =>
    typeof value === 'string'
      ? value === '$token'
        ? lastToken
        : value
      : Array.isArray(value)
        ? value.map(fill)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]))
          : value
  const clean = (value: any): any => {
    const text = JSON.stringify(value ?? null)
    for (const match of text.match(UUID) ?? []) lastToken = match
    return unreal(JSON.parse(text.replace(UUID, '<uuid>')), root)
  }
  for (const step of steps) {
    if (step.drop) {
      ipc.queueDropped(step.drop)
      out.push(null)
    } else if (step.broadcast) {
      ipc.broadcastChanged()
      out.push(null)
    } else if (step.destroy !== undefined) {
      destroyed.add(step.destroy)
      for (const listener of listeners.get(step.destroy) ?? []) listener()
      listeners.delete(step.destroy)
      out.push(null)
    } else if (step.release) {
      gate.release?.()
      out.push(held ? clean(await held) : null)
      held = undefined
    } else {
      const handler = handlers.get(step.ch)
      if (!handler) throw new Error(`no handler ${step.ch}`)
      const event = { sender: senderOf(step.s ?? 1) }
      // the gate closes before the call starts: the library may be reached with no wait
      if (step.hold) gate.hold = true
      const call = Promise.resolve(handler(event, ...(step.a ?? []).map(fill).map(hexBytes)))
      if (step.hold) {
        held = call
        out.push({ held: true })
        await new Promise((resolve) => setImmediate(resolve))
        gate.hold = false
      } else {
        out.push(clean(await call))
      }
    }
  }
  return out
}

const ipcCase = (
  opts: Record<string, unknown>,
  steps: Array<Record<string, unknown>>,
  files: Record<string, string | { hex: string }> = {},
): Case => ({ args: [{ root: '$DIR', ...pluginsOf(files), ...opts }, steps], files })

const CH = (name: string) => `skills:${name}`
const OK_IMPORT = (extra: Record<string, unknown> = {}) =>
  IMPORT({
    tempDir: '$DIR/tmp/imp',
    candidates: [CANDIDATE({ key: 'k', name: 'k', dir: '$DIR/imp/k' })],
    ...extra,
  })
const IMP_FILES = { 'imp/k/SKILL.md': SKILL, 'imp/k/notes.txt': 'notes', 'tmp/imp/x': 'x' }

group['user-skills-ipc.registerUserSkillsIpc'] = {
  ts: runIpc,
  cases: [
    ipcCase(
      { builtin: true, contents: [7, 8] },
      [
        { ch: CH('list') },
        { ch: CH('read'), a: ['app:mine'] },
        { ch: CH('read'), a: ['nocolon'] },
        { ch: CH('read'), a: [5] },
        { ch: CH('read'), a: ['app:ghost'] },
        { ch: CH('suggest-name'), a: ['Weekly Report'] },
        { ch: CH('suggest-name'), a: [42] },
        { ch: CH('check-name'), a: ['good-name'] },
        { ch: CH('check-name'), a: [5] },
        { ch: CH('check-name'), a: ['mine', 'app:mine'] },
        { ch: CH('ai-read'), a: ['app:mine'] },
        { ch: CH('ai-read'), a: [null] },
        { ch: CH('ai-read-file'), a: ['app:mine', 'notes.md'] },
        { ch: CH('ai-read-file'), a: ['app:mine', 5] },
        { ch: CH('ai-read-file'), a: ['app:mine', 'x'.repeat(4097)] },
        { ch: CH('open-settings') },
        { ch: CH('agent-notice') },
      ],
      withLibrary(),
    ),
    ipcCase({ notice: true }, [{ ch: CH('agent-notice') }, { ch: CH('agent-notice-seen') }]),
    ipcCase({ notice: 'throw', markThrows: true }, [
      { ch: CH('agent-notice') },
      { ch: CH('agent-notice-seen') },
    ]),
    ipcCase({}, [{ ch: CH('list') }], {
      [`${APP}/bad/SKILL.md`]: md('---', 'name: bad', 'description: "\\U00110000"', '---', 'b'),
    }),
    ipcCase({ contents: [7, 8] }, [
      { destroy: 8 },
      {
        ch: CH('save-from-card'),
        a: [
          {
            title: 'Card',
            name: 'card',
            description: 'D',
            body: 'B',
            invoke: 'manual',
            template: { bytes: { hex: '0102' }, fileName: 'a.docx' },
          },
        ],
      },
      {
        ch: CH('save-from-card'),
        a: [{ title: 'Card', name: 'card', description: 'D', body: 'B', invoke: 'manual' }],
      },
      { ch: CH('save-from-card'), a: ['junk'] },
      {
        ch: CH('save-from-card'),
        a: [
          {
            title: 'x',
            name: 'n',
            description: 'D',
            body: 'B',
            template: { bytes: { hex: '01' }, fileName: '' },
          },
        ],
      },
      { ch: CH('read'), a: ['app:card'] },
    ]),
    ipcCase(
      {
        builtin: true,
        manage: [
          CH('set-state'),
          CH('hide-builtin'),
          CH('unhide-builtins'),
          CH('remove'),
          CH('copy-to-mine'),
          CH('save'),
        ],
        contents: [7],
      },
      [
        { ch: CH('set-state'), a: ['user:ext', { enabled: true }] },
        { ch: CH('set-state'), a: ['user:ext', {}] },
        { ch: CH('set-state'), a: ['user:ext', { enabled: false }], s: 2 },
        { ch: CH('set-state'), a: ['app:ghost', { enabled: false }] },
        { ch: CH('hide-builtin'), a: ['builtin:bi-one'] },
        { ch: CH('hide-builtin'), a: ['bad'] },
        { ch: CH('unhide-builtins'), a: [['bi-one', 5]] },
        { ch: CH('unhide-builtins'), a: ['bi-one'] },
        { ch: CH('unhide-builtins') },
        { ch: CH('copy-to-mine'), a: ['user:ext', true] },
        { ch: CH('copy-to-mine'), a: ['user:ext'] },
        { ch: CH('copy-to-mine'), a: [7] },
        { ch: CH('remove'), a: ['app:ext'] },
        { ch: CH('remove'), a: ['app:ext'] },
        { ch: CH('save'), a: [{ title: 'S', name: 'saved', description: 'D', body: 'B' }] },
        { ch: CH('save'), a: [{ title: 'S' }] },
        { ch: CH('import-text'), a: ['text'] },
        { ch: CH('export-info'), a: ['app:mine'] },
      ],
      withLibrary(),
    ),
    ipcCase(
      {
        contents: [7],
        dialogs: {
          open: [
            { canceled: false, filePaths: ['$DIR/some/folder'] },
            { canceled: true, filePaths: ['$DIR/x'] },
            { canceled: false, filePaths: [] },
          ],
          save: [],
        },
        parent: true,
        lib: { prepare: OK_IMPORT() },
      },
      [
        { ch: CH('import-folder') },
        { ch: CH('import-folder') },
        { ch: CH('import-folder') },
        { ch: CH('read-import'), a: ['$token', 'k'] },
        { ch: CH('read-import'), a: ['$token', 'k'], s: 2 },
        { ch: CH('read-import'), a: ['$token', 5] },
        { ch: CH('read-import'), a: [5, 'k'] },
        { ch: CH('read-import-file'), a: ['$token', 'k', 'notes.txt'] },
        { ch: CH('read-import-file'), a: ['$token', 'k', 5] },
        { ch: CH('read-import-file'), a: ['$token', 'nope', 'notes.txt'], s: 3 },
        { ch: CH('cancel-import'), a: ['$token'], s: 2 },
        { ch: CH('cancel-import'), a: ['$token'] },
        { ch: CH('cancel-import'), a: [9] },
        { ch: CH('cancel-import'), a: [null] },
        { ch: CH('cancel-import') },
      ],
      IMP_FILES,
    ),
    ipcCase(
      {
        dialogs: { open: [{ canceled: false, filePaths: ['$DIR/a.zip'] }] },
        lib: { prepare: OK_IMPORT({ origin: { kind: 'zip', file: '$DIR/a.zip' } }) },
      },
      [{ ch: CH('import-zip') }, { ch: CH('import-zip') }],
      IMP_FILES,
    ),
    ipcCase(
      { lib: { prepare: OK_IMPORT({ origin: { kind: 'text' } }) } },
      [
        { ch: CH('import-text'), a: ['---\nname: x\n---'] },
        { ch: CH('import-text'), a: [5] },
        { ch: CH('import-text'), a: ['y'.repeat(2_000_001)] },
        { ch: CH('take-dropped') },
        { drop: { kind: 'no-skills' } },
        { drop: { kind: 'zip', file: '$DIR/a.zip' } },
        { drop: { kind: 'skill-file', file: '$DIR/SKILL.md' } },
        { ch: CH('take-dropped') },
        { ch: CH('take-dropped') },
        { ch: CH('take-dropped') },
        { ch: CH('take-dropped') },
      ],
      IMP_FILES,
    ),
    ipcCase(
      {
        contents: [7, 8],
        lib: { prepare: OK_IMPORT({ origin: { kind: 'folder', folder: '$DIR/f' } }) },
      },
      [
        ...Array.from({ length: 22 }, (_, i) => ({
          drop: { kind: 'zip', file: `$DIR/z${i}.zip` },
        })),
        { destroy: 8 },
        { ch: CH('take-dropped') },
        { ch: CH('take-dropped') },
      ],
      IMP_FILES,
    ),
    ipcCase(
      {
        lib: { prepare: { throw: 'unsafe' } },
        dialogs: { open: [{ canceled: false, filePaths: ['$DIR/z.zip'] }] },
      },
      [{ ch: CH('import-zip') }],
    ),
    ipcCase(
      {
        contents: [7],
        lib: {
          prepare: OK_IMPORT({
            origin: { kind: 'github', repo: 'o/r', ref: 'main', commit: 'abc', path: '' },
          }),
        },
      },
      [
        { ch: CH('import-github'), a: ['https://github.com/o/r'] },
        { ch: CH('import-github'), a: [5] },
        { ch: CH('import-github'), a: ['x'.repeat(2049)] },
        { ch: CH('import-github'), a: ['o/r'], hold: true },
        { ch: CH('import-github'), a: ['o/r'] },
        { ch: CH('cancel-import') },
        { release: true },
        { ch: CH('import-github'), a: ['o/r'], hold: true },
        { destroy: 1 },
        { release: true },
        { ch: CH('import-github'), a: ['o/r'], s: 3 },
      ],
      IMP_FILES,
    ),
    ipcCase({ lib: { prepare: { throw: 'not-found' } } }, [
      { ch: CH('import-github'), a: ['o/r'] },
      { ch: CH('import-github'), a: ['o/r'] },
    ]),
    ipcCase(
      {
        contents: [7],
        lib: {
          prepare: OK_IMPORT(),
          install: {
            installed: [
              { key: 'k', name: 'k', dir: '$DIR/home/.seuoffice/skills/k', replaced: false },
            ],
            skipped: ['s'],
          },
        },
        dialogs: {
          open: [
            { canceled: false, filePaths: ['$DIR/f'] },
            { canceled: false, filePaths: ['$DIR/f'] },
          ],
        },
      },
      [
        { ch: CH('import-folder') },
        { ch: CH('install'), a: [{ token: '$token', selected: ['k'], onCollision: {} }], s: 2 },
        { ch: CH('install'), a: [{ token: 'nope', selected: ['k'], onCollision: {} }] },
        { ch: CH('install'), a: ['junk'] },
        { ch: CH('install'), a: [{ token: '$token', selected: ['k'], onCollision: {} }] },
        { ch: CH('install'), a: [{ token: '$token', selected: ['k'], onCollision: {} }] },
        { ch: CH('list') },
      ],
      { ...IMP_FILES, [`${APP}/k/SKILL.md`]: skillMd('k') },
    ),
    ipcCase(
      {
        lib: { prepare: OK_IMPORT(), install: { throw: 'needs-choice' } },
        dialogs: { open: [{ canceled: false, filePaths: ['$DIR/f'] }] },
      },
      [
        { ch: CH('import-folder') },
        { ch: CH('install'), a: [{ token: '$token', selected: ['k'], onCollision: {} }] },
        { ch: CH('read-import'), a: ['$token', 'k'] },
        { ch: CH('cancel-import'), a: ['$token'] },
        { ch: CH('read-import'), a: ['$token', 'k'] },
      ],
      IMP_FILES,
    ),
    ipcCase(
      {
        lib: { prepare: OK_IMPORT(), install: { throw: 'too-large' } },
        dialogs: { open: [{ canceled: false, filePaths: ['$DIR/f'] }] },
      },
      [
        { ch: CH('import-folder') },
        { ch: CH('install'), a: [{ token: '$token', selected: ['k'], onCollision: {} }] },
        { ch: CH('read-import'), a: ['$token', 'k'] },
      ],
      IMP_FILES,
    ),
    ipcCase(
      {
        contents: [7],
        lib: {
          check: {
            status: 'changed',
            record: {
              kind: 'github',
              repo: 'o/r',
              ref: 'main',
              path: 'skills/gh',
              commit: 'c1',
              installedAt: 'i',
              contentHash: 'h',
            },
            commit: 'c2',
            locallyEdited: true,
            changedFiles: [{ rel: 'a.md', change: 'added' }],
            update: OK_IMPORT({
              origin: { kind: 'github', repo: 'o/r', ref: 'main', commit: 'c2', path: 'skills/gh' },
            }),
          },
          apply: { key: 'gh', name: 'gh', dir: '$DIR/home/.seuoffice/skills/gh', replaced: true },
        },
      },
      [
        { ch: CH('check-update'), a: ['app:gh'] },
        { ch: CH('check-update'), a: [5] },
        { ch: CH('check-update'), a: ['app:ghost'] },
        { ch: CH('apply-update'), a: ['$token'], s: 2 },
        { ch: CH('apply-update'), a: [5] },
        { ch: CH('apply-update'), a: ['$token'] },
        { ch: CH('apply-update'), a: ['$token'] },
        { ch: CH('check-update'), a: ['app:gh'] },
        { ch: CH('cancel-update'), a: ['$token'], s: 2 },
        { ch: CH('cancel-update'), a: [5] },
        { ch: CH('cancel-update'), a: ['$token'] },
        { ch: CH('cancel-update'), a: ['$token'] },
        { ch: CH('check-update'), a: ['app:gh'], hold: true },
        { ch: CH('check-update'), a: ['app:gh'] },
        { destroy: 1 },
        { release: true },
        { ch: CH('check-update'), a: ['app:gh'], hold: true },
        { ch: CH('cancel-import') },
        { release: true },
      ],
      { ...IMP_FILES, ...withLibrary() },
    ),
    ipcCase(
      {
        lib: {
          check: {
            status: 'up-to-date',
            record: {
              kind: 'github',
              repo: 'o/r',
              ref: 'main',
              path: 'p',
              commit: 'c1',
              installedAt: 'i',
              contentHash: 'h',
            },
            commit: 'c1',
            locallyEdited: false,
          },
        },
      },
      [
        { ch: CH('check-update'), a: ['app:gh'] },
        { ch: CH('check-update'), a: ['app:mine'] },
      ],
      withLibrary(),
    ),
    ipcCase(
      { lib: { check: { throw: 'network' } } },
      [
        { ch: CH('check-update'), a: ['app:gh'] },
        { ch: CH('check-update'), a: ['app:gh'] },
      ],
      withLibrary(),
    ),
    ipcCase(
      {
        contents: [7],
        parent: true,
        dialogs: {
          save: [
            { canceled: false, filePath: '$DIR/out.zip' },
            { canceled: true },
            { canceled: false },
            { canceled: false, filePath: '$DIR/b.zip' },
            { canceled: true, filePath: '$DIR/b.zip' },
          ],
        },
      },
      [
        { ch: CH('export-info'), a: ['app:mine'] },
        { ch: CH('export-info'), a: ['user:ext'] },
        { ch: CH('export-info'), a: [3] },
        { ch: CH('export-zip'), a: ['app:mine'] },
        { ch: CH('export-zip'), a: ['app:mine'] },
        { ch: CH('export-zip'), a: ['app:mine'] },
        { ch: CH('export-zip'), a: ['user:ext'] },
        { ch: CH('export-zip'), a: [3] },
        { ch: CH('export-bundle'), a: [['app:mine'], 'ignored'] },
        { ch: CH('export-bundle'), a: [['app:mine', 'app:gh'], 'My skills and more'] },
        { ch: CH('export-bundle'), a: [['app:mine', 'app:gh'], 7] },
        { ch: CH('export-bundle'), a: [['app:mine', 'app:gh'], 'x'.repeat(400)] },
        { ch: CH('export-bundle'), a: [[], 'x'] },
        { ch: CH('export-bundle'), a: [['user:ext'], 'x'] },
      ],
      withLibrary(),
    ),
    ipcCase(
      {
        dialogs: { save: [{ canceled: false, filePath: '$DIR/out.zip' }] },
        lib: { exportZip: { throw: 'failed' } },
      },
      [{ ch: CH('export-zip'), a: ['app:mine'] }],
      withLibrary(),
    ),
    ipcCase(
      { builtin: true },
      [
        { ch: CH('open-folder'), a: ['app:mine'] },
        { ch: CH('open-folder'), a: ['builtin:bi-one'] },
        { ch: CH('open-folder'), a: [3] },
        { ch: CH('open-folder'), a: ['user:ext'], s: 2 },
      ],
      withLibrary(),
    ),
    ipcCase(
      { openPathError: 'could not open', builtin: true },
      [{ ch: CH('open-folder'), a: ['app:mine'] }],
      withLibrary(),
    ),
    ipcCase(
      { manage: false },
      [
        { ch: CH('set-state'), a: ['app:mine', { enabled: false }] },
        { ch: CH('import-folder') },
        { ch: CH('import-zip') },
        { ch: CH('import-github'), a: ['o/r'] },
        { ch: CH('take-dropped') },
        { ch: CH('read-import'), a: ['t', 'k'] },
        { ch: CH('read-import-file'), a: ['t', 'k', 'r'] },
        { ch: CH('cancel-import'), a: ['t'] },
        { ch: CH('install'), a: [{}] },
        { ch: CH('check-update'), a: ['app:gh'] },
        { ch: CH('apply-update'), a: ['t'] },
        { ch: CH('cancel-update'), a: ['t'] },
        { ch: CH('export-info'), a: ['app:mine'] },
        { ch: CH('export-zip'), a: ['app:mine'] },
        { ch: CH('export-bundle'), a: [['app:mine'], 'x'] },
        { ch: CH('open-folder'), a: ['app:mine'] },
        { ch: CH('hide-builtin'), a: ['builtin:x'] },
        { ch: CH('unhide-builtins') },
        { ch: CH('remove'), a: ['app:mine'] },
        { ch: CH('copy-to-mine'), a: ['user:x'] },
        { ch: CH('save'), a: [{}] },
        { ch: CH('import-text'), a: ['t'] },
      ],
      withLibrary(),
    ),
    ipcCase({ contents: [7, 8] }, [{ broadcast: true }, { destroy: 8 }, { broadcast: true }]),
  ],
}

// ---- template-tabs --------------------------------------------------------

group['template-tabs.copyFileNameOf'] = {
  ts: (args) => templateTabs.copyFileNameOf(args[0] as string, args[1] as string),
  cases: cases(
    ['Quarterly report', '.docx'],
    ['a/b\\c:d*e?f', '.xlsx'],
    ['', '.md'],
    ['  ...hidden...  ', '.txt'],
    ['x'.repeat(200), '.pdf'],
    ['tab\tand\nnewline', '.html'],
    ['trailing dots...', '.hwp'],
  ),
}

/** the tab fakes of a scenario, shared by the tabs and the tabs IPC */
function tabsEnv(opts: any, cx: TsContext, root: string) {
  const destroyed = new Set<number>()
  const listeners = new Map<number, Array<() => void>>()
  let ids = 0
  let dirs = 0
  const owners = new Map<number, any>()
  const ownerOf = (id: number): any => {
    let owner = owners.get(id)
    if (!owner) {
      owner = {
        id,
        isDestroyed: () => destroyed.has(id),
        send: (channel: string, payload: unknown) => cx.log('send', id, channel, payload),
      }
      owners.set(id, owner)
    }
    return owner
  }
  const deps: any = {
    makeCopyDir: async () => {
      const dir = join(root, 'copies', `c${++dirs}`)
      if (opts.makeDirThrows) throw new Error('no space')
      mkdirSync(dir, { recursive: true })
      cx.log('makeCopyDir', dir)
      return dir
    },
    writeFile: async (path: string, bytes: Uint8Array) => {
      cx.log('writeFile', path, toHex(bytes))
      if (opts.writeThrows) throw new Error('read-only')
      writeFileSync(path, bytes)
    },
    readFile: async (path: string) => {
      cx.log('readFile', path)
      return new Uint8Array(readFileSync(path))
    },
    removeDir: async (path: string) => {
      cx.log('removeDir', path)
      rmSync(path, { recursive: true, force: true })
    },
    templateFileOf: async (skillId: string) => {
      cx.log('templateFileOf', skillId)
      const entry = (opts.skills ?? {})[skillId]
      if (!entry) return { ok: false, reason: 'not-found' }
      if (entry.throw) throw new Error('lookup failed')
      return entry
    },
    openCopy: async (copy: any) => {
      cx.log('openCopy', { ...copy, bytes: toHex(copy.bytes) })
      const open = opts.open ?? {}
      if (open.throw) throw new Error('window failed')
      if (open.none) return null
      const id = open.contentsId
      const contents = {
        id,
        isDestroyed: () => destroyed.has(id),
        once: (_event: string, listener: () => void) => {
          listeners.set(id, [...(listeners.get(id) ?? []), listener])
        },
      }
      return { tabId: open.tabId, contents, ownsCopy: open.ownsCopy }
    },
    focusTab: (tabId: string) => {
      cx.log('focusTab', tabId)
      return (opts.focusable ?? []).includes(tabId)
    },
    newId: () => `id-${++ids}`,
    now: () => cx.now,
  }
  if (opts.current !== undefined) {
    deps.currentDocumentOf = async (openerId: number) => {
      cx.log('currentDocumentOf', openerId)
      if (opts.current === 'throw') throw new Error('no document')
      return opts.current === 'unsaved' ? 'unsaved' : { path: opts.current }
    }
  }
  if (opts.copyOpened) {
    deps.copyOpenedFor = (contents: any, openerId: number) =>
      cx.log('copyOpenedFor', contents.id, openerId)
  }
  const destroy = (id: number): void => {
    destroyed.add(id)
    for (const listener of listeners.get(id) ?? []) listener()
    listeners.delete(id)
  }
  return { deps, ownerOf, destroy }
}

const resultOf = (value: any): any =>
  value && value.bytes instanceof Uint8Array ? { ...value, bytes: toHex(value.bytes) } : value

const TPL: Record<string, any> = {
  'skill:t': {
    ok: true,
    path: '$DIR/skills/t/assets/form.docx',
    fileName: 'form.docx',
    title: 'Form',
  },
  'skill:sheet': {
    ok: true,
    path: '$DIR/skills/t/assets/data.xlsx',
    fileName: 'Data.xlsx',
    title: 'Data',
  },
  'skill:md': {
    ok: true,
    path: '$DIR/skills/t/assets/note.md',
    fileName: 'note.md',
    title: 'Note',
  },
  'skill:missing': {
    ok: true,
    path: '$DIR/skills/t/assets/none.docx',
    fileName: 'none.docx',
    title: 'None',
  },
  'skill:odd': {
    ok: true,
    path: '$DIR/skills/t/assets/odd.bin',
    fileName: 'odd.bin',
    title: 'Odd',
  },
  'skill:off': { ok: false, reason: 'disabled' },
  'skill:throw': { throw: true },
}
const TPL_FILES = {
  'skills/t/assets/form.docx': { hex: '504b0304' },
  'skills/t/assets/data.xlsx': { hex: 'aabbcc' },
  'skills/t/assets/note.md': '# note',
  'skills/t/assets/odd.bin': 'x',
}
const CHIPS = [{ id: 'app:mine', source: 'app', title: 'Mine' }]
const tabsCase = (
  opts: Record<string, unknown>,
  steps: Array<Record<string, unknown>>,
  files: Record<string, any> = TPL_FILES,
): Case => ({ args: [{ root: '$DIR', skills: TPL, ...opts }, steps], files })

async function runTabs(args: unknown[], cx: TsContext): Promise<any> {
  const [opts, steps] = args as [any, any[]]
  handoff.resetGenerateHandoffsForTest()
  const env = tabsEnv(opts, cx, opts.root)
  const tabs = templateTabs.createTemplateTabs(env.deps)
  const out: any[] = []
  for (const step of steps) {
    const a: any[] = (step.a ?? []).map(hexBytes)
    try {
      if (step.destroy !== undefined) {
        env.destroy(step.destroy)
        out.push(null)
      } else if (step.m === 'openPreview') {
        out.push(unreal(await tabs.openPreview(env.ownerOf(a[0]), a[1]), opts.root))
      } else if (step.m === 'openPreviewIds') {
        out.push(tabs.openPreviewIds())
      } else {
        out.push(unreal(resultOf(await (tabs as any)[step.m](...a)), opts.root))
      }
    } catch (error) {
      out.push({ threw: (error as Error).message })
    }
  }
  return out
}

const PREVIEW = (over: Record<string, unknown> = {}) => ({
  bytes: { hex: '0102' },
  fileName: 'Doc.DOCX',
  title: 'Doc',
  tabTitle: 'Template preview - Doc',
  text: 'clear it',
  originalRedacted: false,
  proposal: { name: 'x' },
  ...over,
})

group['template-tabs.createTemplateTabs'] = {
  ts: runTabs,
  cases: [
    tabsCase({ open: { tabId: 'tab-1', contentsId: 101 } }, [
      { m: 'openTemplate', a: [{ skillId: 'skill:t', text: 'fill it', chips: CHIPS }] },
      { m: 'takeHandoff', a: ['docs', 101] },
      { m: 'takeHandoff', a: ['docs', 101] },
    ]),
    tabsCase(
      { open: { tabId: 'tab-2', contentsId: 102 }, current: '/docs/mine.docx', copyOpened: true },
      [
        {
          m: 'openTemplate',
          a: [{ skillId: 'skill:t', text: 'with doc', chips: [], withCurrent: true }, 9],
        },
        { m: 'takeHandoff', a: ['sheets', 102] },
        { m: 'takeHandoff', a: ['docs', 102] },
      ],
    ),
    tabsCase({ open: { tabId: 'tab-3', contentsId: 103 }, current: 'unsaved' }, [
      {
        m: 'openTemplate',
        a: [{ skillId: 'skill:t', text: 'x', chips: [], withCurrent: true }, 9],
      },
      {
        m: 'openTemplate',
        a: [{ skillId: 'skill:md', text: 'x', chips: [], withCurrent: true }, 9],
      },
      { m: 'openTemplate', a: [{ skillId: 'skill:t', text: 'x', chips: [], withCurrent: true }] },
    ]),
    tabsCase({ open: { tabId: 'tab-4', contentsId: 104 }, current: 'throw' }, [
      {
        m: 'openTemplate',
        a: [{ skillId: 'skill:sheet', text: 'x', chips: [], withCurrent: true }, 9],
      },
    ]),
    tabsCase({ open: { tabId: 'tab-4b', contentsId: 1040 } }, [
      {
        m: 'openTemplate',
        a: [{ skillId: 'skill:sheet', text: 'x', chips: [], withCurrent: true }, 9],
      },
    ]),
    tabsCase({ open: { tabId: 'tab-5', contentsId: 105 } }, [
      { m: 'openTemplate', a: [{ skillId: 'skill:off', text: 'x', chips: [] }] },
      { m: 'openTemplate', a: [{ skillId: 'skill:nope', text: 'x', chips: [] }] },
      { m: 'openTemplate', a: [{ skillId: 'skill:throw', text: 'x', chips: [] }] },
      { m: 'openTemplate', a: [{ skillId: 'skill:missing', text: 'x', chips: [] }] },
      { m: 'openTemplate', a: [{ skillId: 'skill:odd', text: 'x', chips: [] }] },
    ]),
    tabsCase({ open: { none: true } }, [
      { m: 'openTemplate', a: [{ skillId: 'skill:t', text: 'x', chips: [] }] },
    ]),
    tabsCase({ open: { throw: true } }, [
      { m: 'openTemplate', a: [{ skillId: 'skill:t', text: 'x', chips: [] }] },
    ]),
    tabsCase({ open: { tabId: 'tab-6', contentsId: 106 }, writeThrows: true }, [
      { m: 'openTemplate', a: [{ skillId: 'skill:t', text: 'x', chips: [] }] },
    ]),
    tabsCase({ open: { tabId: 'tab-6b', contentsId: 1060 }, makeDirThrows: true }, [
      { m: 'openTemplate', a: [{ skillId: 'skill:t', text: 'x', chips: [] }] },
    ]),
    tabsCase({ open: { tabId: 'tab-7', contentsId: 107 } }, [
      { m: 'openTemplate', a: [{ skillId: 'skill:t', text: 'x', chips: [] }] },
      { destroy: 107 },
      { m: 'takeHandoff', a: ['docs', 107] },
    ]),
    tabsCase({ open: { tabId: 'tab-8', contentsId: 108, ownsCopy: true } }, [
      { m: 'openTemplate', a: [{ skillId: 'skill:t', text: 'x', chips: [] }] },
      { destroy: 108 },
    ]),
    tabsCase({ open: { tabId: 'tab-9', contentsId: 109 }, focusable: ['tab-9'] }, [
      { m: 'openPreview', a: [5, PREVIEW()] },
      { m: 'openPreviewIds' },
      { m: 'takeHandoff', a: ['docs', 109] },
      { m: 'previewOriginal', a: [109, 'id-1'] },
      { m: 'previewOriginal', a: [110, 'id-1'] },
      { m: 'previewOriginal', a: [109, 'nope'] },
      { m: 'finishPreview', a: [110, { previewId: 'id-1', outcome: 'saved' }] },
      {
        m: 'finishPreview',
        a: [109, { previewId: 'id-1', outcome: 'saved', skillId: 'app:x', title: 'X' }],
      },
      { m: 'finishPreview', a: [109, { previewId: 'id-1', outcome: 'saved' }] },
      { destroy: 109 },
      { m: 'openPreviewIds' },
      { m: 'focusTab', a: ['tab-9'] },
      { m: 'focusTab', a: ['gone'] },
    ]),
    tabsCase({ open: { tabId: 'tab-10', contentsId: 111 } }, [
      {
        m: 'openPreview',
        a: [5, PREVIEW({ originalRedacted: true, draft: { a: 1 }, fileName: 'x.md' })],
      },
      { m: 'previewOriginal', a: [111, 'id-1'] },
      { m: 'takeHandoff', a: ['markdown', 111] },
      { destroy: 111 },
    ]),
    tabsCase({ open: { tabId: 'tab-11', contentsId: 112 } }, [
      { m: 'openPreview', a: [5, PREVIEW({ fileName: 'noeditor.bin' })] },
      { m: 'openPreview', a: [5, PREVIEW({ fileName: 'noext', tabTitle: '...' })] },
      { m: 'openPreview', a: [5, PREVIEW({ tabTitle: 'a/b:c' })] },
      { m: 'openPreviewIds' },
    ]),
    tabsCase({ open: { tabId: 'tab-12', contentsId: 113 } }, [
      { m: 'openPreview', a: [5, PREVIEW()] },
      { m: 'finishPreview', a: [113, { previewId: 'id-1', outcome: 'unsaved' }] },
      { destroy: 113 },
    ]),
    tabsCase({ open: { tabId: 'tab-13', contentsId: 114 } }, [
      { m: 'openPreview', a: [5, PREVIEW()] },
      { destroy: 5 },
      { destroy: 114 },
    ]),
    tabsCase({ open: { tabId: 'tab-14', contentsId: 115 } }, [
      {
        m: 'openCopy',
        a: [
          {
            bytes: { hex: 'ff00' },
            fileName: 'copy.pptx',
            title: 'Copy',
            text: 'edit',
            chips: CHIPS,
          },
        ],
      },
      { m: 'takeHandoff', a: ['slides', 115] },
      {
        m: 'openCopy',
        a: [{ bytes: { hex: '00' }, fileName: 'copy.zip', title: 'Copy', text: 'edit', chips: [] }],
      },
    ]),
    tabsCase({ open: { tabId: 'tab-15', contentsId: 116 } }, [
      { m: 'focusTab', a: ['x'] },
      { m: 'takeHandoff', a: ['pdf', 999] },
    ]),
  ],
}

// ---- template-tabs-ipc ----------------------------------------------------

async function runTabsIpc(args: unknown[], cx: TsContext): Promise<any> {
  const [opts, steps] = args as [any, any[]]
  handoff.resetGenerateHandoffsForTest()
  const env = tabsEnv(opts, cx, opts.root)
  const tabs = templateTabs.createTemplateTabs(env.deps)
  const handlers = new Map<string, (...a: any[]) => any>()
  useElectron({
    ipcMain: {
      handle: (channel: string, fn: any) => handlers.set(channel, fn),
      on() {},
      removeHandler() {},
    },
  })
  templateTabsIpc.registerTemplateTabsIpc(tabs)
  const out: any[] = []
  for (const step of steps) {
    if (step.destroy !== undefined) {
      env.destroy(step.destroy)
      out.push(null)
      continue
    }
    const handler = handlers.get(`skills:${step.ch}`)
    if (!handler) throw new Error(`no handler ${step.ch}`)
    const event = { sender: env.ownerOf(step.s ?? 1) }
    const answer = await handler(event, ...(step.a ?? []).map(hexBytes))
    out.push(unreal(resultOf(answer), opts.root))
  }
  return out
}

group['template-tabs-ipc.registerTemplateTabsIpc'] = {
  ts: runTabsIpc,
  cases: [
    tabsCase({ open: { tabId: 'tab-1', contentsId: 201 }, current: '/docs/a.docx' }, [
      {
        ch: 'open-template',
        a: [{ skillId: 'skill:t', text: 'fill', chips: CHIPS, withCurrent: true }],
        s: 4,
      },
      { ch: 'open-template', a: ['junk'] },
      { ch: 'open-template', a: [{ skillId: 'nocolon', text: 'x', chips: [] }] },
      { ch: 'open-template', a: [{ skillId: 'skill:throw', text: 'x', chips: [] }] },
      { ch: 'open-template', a: [{ skillId: 'skill:off', text: 'x', chips: [] }] },
      { ch: 'take-handoff', a: ['docs'], s: 201 },
      { ch: 'take-handoff', a: ['nonsense'], s: 201 },
      { ch: 'take-handoff', a: ['docs'], s: 201 },
    ]),
    tabsCase({ open: { tabId: 'tab-2', contentsId: 202 }, focusable: ['tab-2'] }, [
      { ch: 'open-preview', a: [PREVIEW()], s: 6 },
      { ch: 'open-preview', a: [{ ...PREVIEW(), bytes: 'no' }] },
      { ch: 'open-preview', a: [{ ...PREVIEW(), proposal: 5 }] },
      { ch: 'preview-original', a: ['id-1'], s: 202 },
      { ch: 'preview-original', a: ['id-1'], s: 203 },
      { ch: 'preview-original', a: [5], s: 202 },
      { ch: 'preview-original', a: ['x'.repeat(129)], s: 202 },
      {
        ch: 'finish-preview',
        a: [{ previewId: 'id-1', outcome: 'saved', skillId: 'app:k' }],
        s: 202,
      },
      { ch: 'finish-preview', a: ['junk'], s: 202 },
      { ch: 'finish-preview', a: [{ previewId: 'nope', outcome: 'unsaved' }], s: 202 },
      { ch: 'focus-tab', a: ['tab-2'] },
      { ch: 'focus-tab', a: ['gone'] },
      { ch: 'focus-tab', a: [5] },
      { ch: 'focus-tab', a: ['x'.repeat(65)] },
    ]),
    tabsCase({ open: { tabId: 'tab-3', contentsId: 204 } }, [
      { ch: 'open-preview', a: [PREVIEW({ originalRedacted: true })], s: 7 },
      { ch: 'preview-original', a: ['id-1'], s: 204 },
      { destroy: 204 },
      { ch: 'preview-original', a: ['id-1'], s: 204 },
    ]),
  ],
}

export { group }
export type { FnSpec }
