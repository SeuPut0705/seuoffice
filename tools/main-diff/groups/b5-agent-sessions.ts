/**
 * Group `b5-agent-sessions`: the agent sessions of the shell
 * (`agent-sessions`, `agent-session-folders`, `project-skills` of
 * apps/shell/src/main/agent), the runtime part of `shared/agent-api.ts`,
 * `agent-core/skill-mcp-refs`, and the small pieces of
 * `ai-provider/agent-session/{program-problem,skills}`.
 *
 * - `agent-api`, `agent-core/skill-mcp-refs`: plain functions and constants.
 *   A JSON `null` is `undefined` where the argument may be left out.
 * - `agent-session-folders`: the case's folder holds the session folders
 *   (`p/ieum-agent-xxxxxx`) with their marks and mtimes. `makeAgentSessionFolder`
 *   renames its random folder to `ieum-agent-FIXED1` and answers the mark it
 *   wrote. `sweepAgentSessionFolders` runs with `process.kill`, `execFile`,
 *   `Date.now`, `process.pid`, `process.uptime`, `process.platform` and
 *   `os.tmpdir` replaced by what the case says; each `execFile` and each
 *   callback it is given is one log line.
 * - `project-skills`: `process.platform` is the last argument where the Rust
 *   function takes it; the settings file is `settings.json` of the folder and
 *   the project folders of the approvals are fixed paths.
 * - `agent-sessions.createAgentManager`: a scenario, one manager over fakes
 *   the case describes, and a list of steps. Each call of a fake is one log
 *   line. `randomUUID` is `uuid-1`, `uuid-2`, ... (the first is the session
 *   id of the first start); `os.tmpdir` is the case's `tmp`; `fs.rmSync` and
 *   `fsPromises.rm` are fakes that log and remove the folder as the case says.
 *   What happens while a step of `start` waits is the case's `during` table.
 *   A session folder's random six letters read as `<rand>`.
 */
import crypto, { createHash } from 'node:crypto'
import fs, { readFileSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import childProcess from 'node:child_process'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import { dirname, join } from 'node:path'
import '../electron-fake.ts'
import type { Case, FileSpec, FnSpec, Group, TsContext } from '../types.ts'

// loaded after electron-fake.ts has registered its hooks
const refs = await import('../../../packages/agent-core/src/skill-mcp-refs.ts')
const api = await import('../../../apps/shell/src/shared/agent-api.ts')
const programProblem =
  await import('../../../packages/ai-provider/src/agent-session/program-problem.ts')
const sessionSkills = await import('../../../packages/ai-provider/src/agent-session/skills.ts')
const folders = await import('../../../apps/shell/src/main/agent/agent-session-folders.ts')
const projectSkills = await import('../../../apps/shell/src/main/agent/project-skills.ts')
const sessions = await import('../../../apps/shell/src/main/agent/agent-sessions.ts')
// apps/shell is CommonJS: it loads `@seuoffice/ai-provider/agent-session` as its own copy, whose
// `AgentProgramError` is the class its `instanceof` knows
const { AgentProgramError: SessionProgramError } = createRequire(
  new URL('../../../apps/shell/src/main/agent/agent-sessions.ts', import.meta.url),
)('@seuoffice/ai-provider/agent-session') as {
  AgentProgramError: typeof programProblem.AgentProgramError
}

// any: the specs hand JSON to functions that take their own types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))
const constant = (name: string, read: () => unknown): FnSpec => ({
  ts: read,
  cases: [{ args: [], note: name }],
  single: 'a constant',
})
/** `null` of a JSON argument is the `undefined` of the call */
const opt = <T>(value: T | null | undefined): T | undefined => value ?? undefined

const realRm = fsPromises.rm
const realRmSync = fs.rmSync
const realKill = process.kill
const realUptime = process.uptime
const realTmpdir = os.tmpdir
const realExecFile = childProcess.execFile
const realNow = Date.now
const realUuid = crypto.randomUUID

/** a session folder's random letters, in a text */
const maskRand = (text: string): string =>
  text.replace(/ieum-agent-[A-Za-z0-9]{6}/g, 'ieum-agent-<rand>')
const maskDeep = (value: unknown): unknown => {
  if (typeof value === 'string') return maskRand(value)
  if (Array.isArray(value)) return value.map(maskDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)]))
  }
  return value
}

/** the pieces of `process`, `Date` and `os` a call reads, replaced for the call */
interface Patch {
  platform?: string
  pid?: number
  uptime?: number
  now?: number
  tmpdir?: string
  env?: Record<string, string>
}
async function patched<T>(patch: Patch, run: () => Promise<T> | T): Promise<T> {
  const proc = process as unknown as Record<string, unknown>
  const saved = {
    platform: Object.getOwnPropertyDescriptor(process, 'platform'),
    pid: Object.getOwnPropertyDescriptor(process, 'pid'),
    env: process.env,
  }
  if (patch.platform !== undefined) {
    Object.defineProperty(process, 'platform', { value: patch.platform, configurable: true })
  }
  if (patch.pid !== undefined) {
    Object.defineProperty(process, 'pid', { value: patch.pid, configurable: true })
  }
  if (patch.uptime !== undefined) proc.uptime = () => patch.uptime
  if (patch.now !== undefined) Date.now = () => patch.now as number
  if (patch.tmpdir !== undefined) os.tmpdir = () => patch.tmpdir as string
  if (patch.env !== undefined) {
    proc.env = patch.env
  }
  syncBuiltinESMExports()
  try {
    return await run()
  } finally {
    if (saved.platform) Object.defineProperty(process, 'platform', saved.platform)
    if (saved.pid) Object.defineProperty(process, 'pid', saved.pid)
    proc.env = saved.env
    proc.uptime = realUptime
    Date.now = realNow
    os.tmpdir = realTmpdir
    syncBuiltinESMExports()
  }
}

// ---- agent-session/skills, program-problem ----

const problems: unknown[] = [
  { type: 'unsupported-path' },
  { type: 'exited' },
  { type: 'exited', exitCode: 3 },
  { type: 'no-answer', step: 'initialize/handshake' },
  { type: 'refused', step: 'turn/start' },
  { type: 'refused', step: 'a/b/c', code: -32600 },
  { type: 'no-model' },
]

const programErrorCases: Case[] = [
  ...problems.map((problem, i): Case => ({ args: [problem, `message ${i}`] })),
  { args: [{ type: 'no-model' }, ''], note: 'an empty message' },
]

// ---- agent-api ----

const prefsRaw: unknown[] = [
  null,
  {},
  [],
  'text',
  { provider: 'codex', mode: 'trust-project', recentFolders: ['/a', '/b'], warningAccepted: 1 },
  { provider: 'gemini', mode: 'ask-writes', recentFolders: ['/a'], warningAccepted: 2 },
  { provider: 'claude-code', mode: 'nope', recentFolders: [], warningAccepted: 0 },
  { recentFolders: ['/a', '', '/a', 5, null, '/b', '/c', '/d', '/e', '/f', '/g', '/h', '/i'] },
  { recentFolders: 'not a list', warningAccepted: 1.5 },
  { warningAccepted: '1' },
  { warningAccepted: -3 },
  { warningAccepted: 1e21 },
]

const folderPrefs = (recent: string[]): unknown => ({
  provider: 'codex',
  mode: 'ask-writes',
  recentFolders: recent,
  warningAccepted: 1,
})

const failures: unknown[] = [
  { reason: 'bad-folder' },
  { reason: 'not-connected' },
  { reason: 'not-accepted' },
  { reason: 'provider-blocked' },
  { reason: 'invalid-request' },
  { reason: 'stopped' },
  { reason: 'unknown' },
  { reason: 'run-error', kind: 'rate-limit' },
  { reason: 'run-error', kind: 'off-in-app' },
  { reason: 'prepare-failed', step: 'session-folder' },
  { reason: 'prepare-failed', step: 'user-mcp' },
  ...problems.map((problem) => ({ reason: 'program-problem', problem })),
]

// ---- agent-core/skill-mcp-refs ----

const textCases: string[] = [
  '',
  'no tools here',
  'call mcp__github__search_issues then mcp__github__get_issue and mcp__linear__list',
  'xmcp__no__tool and _mcp__no__tool and 9mcp__a__b',
  'mcp__a.b-c__tool.name and mcp__d__*',
  'mcp__half__ and mcp__only_one_part and mcp__x__',
  '(mcp__paren__call) `mcp__tick__call` "mcp__quote__call"',
  'mcp__a__b mcp__a__c mcp__b__a mcp__a__d',
  'mcp__a__b__c has a long tool name',
  'mcp__Über__tool and mcp__ok__tool',
]

const allowedCases: unknown[] = [
  null,
  '',
  'Read, Write',
  'mcp__a__t, mcp__b',
  'mcp__a__t mcp__b__*  mcp__c',
  ['mcp__x__y', 'Read', 'mcp__a'],
  ["'mcp__q__z'", '"mcp__r"', '`mcp__s`'],
  'mcp__ alone, mcp__a__ and mcp__b__c__d',
  ['mcp__a b', 'mcp__c,mcp__d'],
  [],
]

const usableCases: unknown[] = [
  null,
  { usable: [] },
  { usable: ['a', 'b'] },
  { usable: ['a'], throws: ['b'] },
  { usable: [], throws: ['a', 'b'] },
]
/** `isUsable` of a case: the names it answers true for, and the names it throws on */
const usableOf = (spec: J): ((name: string) => boolean) | undefined =>
  spec === null
    ? undefined
    : (name) => {
        if ((spec.throws ?? []).includes(name)) throw new Error('boom')
        return (spec.usable ?? []).includes(name)
      }

// ---- project-skills ----

const FOLDER = '/main-diff/p1'
const OTHER = '/main-diff/p2'
const FINGERPRINT_A = 'a'.repeat(64)

const skillSpec = (id: string, source = 'project') => ({
  id,
  name: `name-${id}`,
  title: `Title ${id}`,
  description: `Description ${id}`,
  dir: `$DIR/proj/.claude/skills/${id}`,
  source,
})
const skillFiles = (id: string, extra: Record<string, string> = {}): Record<string, string> => ({
  [`proj/.claude/skills/${id}/SKILL.md`]: `---\nname: ${id}\n---\nbody of ${id}\n`,
  [`proj/.claude/skills/${id}/scripts/run.sh`]: `echo ${id}\n`,
  ...Object.fromEntries(
    Object.entries(extra).map(([name, text]) => [`proj/.claude/skills/${id}/${name}`, text]),
  ),
})
const SKILL_A = skillSpec('a')
const SKILL_B = skillSpec('b')
const SKILL_USER = skillSpec('u', 'user')
const FILES_AB = { ...skillFiles('a'), ...skillFiles('b') }

/** the fingerprint of the files a case seeds, as `projectSkillsFingerprint` makes it */
function fingerprintOf(skills: { id: string; files: Record<string, string> }[]): string {
  const hash = createHash('sha256')
  const walk = (tree: Map<string, unknown>, prefix: string): void => {
    const names = [...tree.keys()].sort((a, b) => a.localeCompare(b))
    for (const name of names) {
      const child = tree.get(name)
      if (child instanceof Map) walk(child as Map<string, unknown>, `${prefix}${name}/`)
      else {
        hash.update(`${prefix}${name}\0`)
        hash.update(
          createHash('sha256')
            .update(child as string)
            .digest(),
        )
      }
    }
  }
  for (const skill of [...skills].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(`skill\0${skill.id}\0`)
    const root = new Map<string, unknown>()
    for (const [rel, text] of Object.entries(skill.files)) {
      const parts = rel.split('/')
      let at = root
      for (const part of parts.slice(0, -1)) {
        if (!(at.get(part) instanceof Map)) at.set(part, new Map())
        at = at.get(part) as Map<string, unknown>
      }
      at.set(parts[parts.length - 1]!, text)
    }
    walk(root, '')
  }
  return hash.digest('hex')
}
const rel = (id: string, extra: Record<string, string> = {}): Record<string, string> =>
  Object.fromEntries(
    Object.entries(skillFiles(id, extra)).map(([path, text]) => [
      path.slice(`proj/.claude/skills/${id}/`.length),
      text,
    ]),
  )
const FP_A = fingerprintOf([{ id: 'a', files: rel('a') }])
const FP_AB = fingerprintOf([
  { id: 'a', files: rel('a') },
  { id: 'b', files: rel('b') },
])

const settingsOf = (approvals: unknown): Record<string, string> => ({
  'settings.json': JSON.stringify({ other: 1, agentProjectSkills: approvals }),
})
const SETTINGS = '$DIR/settings.json'

/** `process.platform` for a call of project-skills */
const onPlatform = <T>(platform: string, run: () => T): Promise<T> => patched({ platform }, run)

const many = (count: number, prefix: string, text = 'x'): Record<string, string> =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}.txt`, text]))

const projectCases = {
  of: cases([[SKILL_A, SKILL_USER, SKILL_B]], [[]], [[SKILL_USER]], [[SKILL_B, SKILL_A]]),
  fingerprint: [
    { args: [[]] },
    { args: [[SKILL_A]], files: skillFiles('a') },
    { args: [[SKILL_A, SKILL_B]], files: FILES_AB },
    { args: [[SKILL_B, SKILL_A]], files: FILES_AB, note: 'the ids order them, not the list' },
    { args: [[SKILL_A]], files: skillFiles('a', { 'extra.txt': 'more' }) },
    { args: [[SKILL_A]], note: 'the folder is not there' },
    { args: [[SKILL_A]], files: { 'proj/.claude/skills/a': { dir: true } } },
    { args: [[{ ...SKILL_A, dir: '$DIR/proj/file.txt' }]], files: { 'proj/file.txt': 'x' } },
    { args: [[SKILL_A]], files: many(400, 'proj/.claude/skills/a/f'), note: '400 files' },
    { args: [[SKILL_A]], files: many(401, 'proj/.claude/skills/a/f'), note: '401 files' },
    {
      args: [[SKILL_A, SKILL_B]],
      files: { ...many(250, 'proj/.claude/skills/a/f'), ...many(250, 'proj/.claude/skills/b/f') },
      note: 'one budget for all the skills',
    },
    {
      args: [[SKILL_A]],
      files: { 'proj/.claude/skills/a/big.bin': 'x'.repeat(16 * 1024 * 1024) },
      note: 'exactly 16 MiB',
    },
    {
      args: [[SKILL_A]],
      files: { 'proj/.claude/skills/a/big.bin': 'x'.repeat(16 * 1024 * 1024 + 1) },
      note: 'one byte more',
    },
    {
      args: [[SKILL_A]],
      files: {
        'proj/.claude/skills/a/B.txt': '1',
        'proj/.claude/skills/a/a.txt': '2',
        'proj/.claude/skills/a/C.txt': '3',
        'proj/.claude/skills/a/d/x.txt': '4',
      },
      note: 'names in collation order',
    },
  ] as Case[],
  approved: [
    { args: [SETTINGS, FOLDER, 'linux'] },
    { args: [SETTINGS, FOLDER, 'linux'], files: settingsOf({ [FOLDER]: FP_A }) },
    { args: [SETTINGS, OTHER, 'linux'], files: settingsOf({ [FOLDER]: FP_A }) },
    { args: [SETTINGS, `${FOLDER}/`, 'linux'], files: settingsOf({ [FOLDER]: FP_A }) },
    { args: [SETTINGS, `${FOLDER}/../p1`, 'linux'], files: settingsOf({ [FOLDER]: FP_A }) },
    { args: [SETTINGS, FOLDER, 'linux'], files: settingsOf({ [FOLDER]: 'ABCDEF' }) },
    { args: [SETTINGS, FOLDER, 'linux'], files: settingsOf({ [FOLDER]: 'A'.repeat(64) }) },
    { args: [SETTINGS, FOLDER, 'linux'], files: settingsOf({ [FOLDER]: 'a'.repeat(63) }) },
    { args: [SETTINGS, FOLDER, 'linux'], files: settingsOf({ [FOLDER]: 5 }) },
    {
      args: ['$DIR/s.json', 'rel/folder', 'linux'],
      files: { 's.json': JSON.stringify({ agentProjectSkills: { 'rel/folder': FP_A } }) },
    },
    { args: [SETTINGS, FOLDER, 'linux'], files: settingsOf([FP_A]) },
    { args: [SETTINGS, FOLDER, 'linux'], files: settingsOf(null) },
    { args: [SETTINGS, FOLDER, 'linux'], files: settingsOf(FP_A) },
    { args: [SETTINGS, '/Main-Diff/P1', 'win32'], files: settingsOf({ '/main-diff/p1': FP_A }) },
    { args: [SETTINGS, '/Main-Diff/P1', 'linux'], files: settingsOf({ '/main-diff/p1': FP_A }) },
    { args: [SETTINGS, FOLDER, 'linux'], files: { 'settings.json': '{ not json' } },
  ] as Case[],
  write: [
    { args: [SETTINGS, FOLDER, FP_A, 'linux'] },
    { args: [SETTINGS, OTHER, FP_AB, 'linux'], files: settingsOf({ [FOLDER]: FP_A }) },
    {
      args: [SETTINGS, FOLDER, FP_AB, 'linux'],
      files: settingsOf({ [FOLDER]: FP_A, [OTHER]: FP_A }),
    },
    {
      args: [SETTINGS, FOLDER, null, 'linux'],
      files: settingsOf({ [FOLDER]: FP_A, [OTHER]: FP_AB }),
    },
    { args: [SETTINGS, FOLDER, '', 'linux'], files: settingsOf({ [FOLDER]: FP_A }) },
    { args: [SETTINGS, FOLDER, null, 'linux'] },
    { args: [SETTINGS, '/Main-Diff/P1', FP_A, 'win32'] },
    { args: [SETTINGS, '/Main-Diff/P1', FP_A, 'linux'] },
    {
      args: [SETTINGS, OTHER, FP_A, 'linux'],
      files: settingsOf({ 'rel/key': FP_A, [FOLDER]: 'nope' }),
    },
  ] as Case[],
  allowed: [
    {
      args: [SETTINGS, FOLDER, [SKILL_A], 'linux'],
      files: { ...settingsOf({ [FOLDER]: FP_A }), ...skillFiles('a') },
    },
    {
      args: [SETTINGS, FOLDER, [SKILL_A], 'linux'],
      files: { ...settingsOf({ [FOLDER]: FP_A }), ...skillFiles('a', { 'new.txt': 'n' }) },
      note: 'a file was added since',
    },
    {
      args: [SETTINGS, FOLDER, [SKILL_A], 'linux'],
      files: skillFiles('a'),
      note: 'never turned on',
    },
    {
      args: [SETTINGS, FOLDER, [SKILL_A], 'linux'],
      files: { ...settingsOf({ [FOLDER]: FP_AB }), ...skillFiles('a') },
    },
    {
      args: [SETTINGS, FOLDER, [SKILL_A, SKILL_USER], 'linux'],
      files: { ...settingsOf({ [FOLDER]: FP_A }), ...skillFiles('a'), ...skillFiles('u') },
      note: 'a user skill is not a project skill',
    },
    { args: [SETTINGS, FOLDER, [], 'linux'], files: settingsOf({ [FOLDER]: FP_A }) },
    {
      args: [SETTINGS, OTHER, [SKILL_A], 'linux'],
      files: { ...settingsOf({ [FOLDER]: FP_A }), ...skillFiles('a') },
    },
    {
      args: [SETTINGS, '/Main-Diff/P1', [SKILL_A], 'win32'],
      files: { ...settingsOf({ '/main-diff/p1': FP_A }), ...skillFiles('a') },
    },
  ] as Case[],
  view: [
    { args: [SETTINGS, FOLDER, [SKILL_A, SKILL_B], 'linux'], files: FILES_AB },
    {
      args: [SETTINGS, FOLDER, [SKILL_A, SKILL_B], 'linux'],
      files: { ...settingsOf({ [FOLDER]: FP_AB }), ...FILES_AB },
    },
    {
      args: [SETTINGS, FOLDER, [SKILL_A, SKILL_B], 'linux'],
      files: { ...settingsOf({ [FOLDER]: FP_A }), ...FILES_AB },
    },
    { args: [SETTINGS, FOLDER, [], 'linux'], files: settingsOf({ [FOLDER]: FP_A }) },
    { args: [SETTINGS, FOLDER, [], 'linux'], note: 'nothing to turn on' },
    {
      args: [SETTINGS, FOLDER, [SKILL_A], 'linux'],
      files: settingsOf({ [FOLDER]: FP_A }),
      note: 'the files are gone',
    },
    {
      args: [SETTINGS, FOLDER, [SKILL_A, SKILL_USER, SKILL_B], 'linux'],
      files: { ...FILES_AB, ...skillFiles('u') },
    },
  ] as Case[],
  set: [
    { args: [SETTINGS, FOLDER, [SKILL_A], true, 'linux'], files: skillFiles('a') },
    {
      args: [SETTINGS, FOLDER, [SKILL_A], false, 'linux'],
      files: { ...settingsOf({ [FOLDER]: FP_A }), ...skillFiles('a') },
    },
    { args: [SETTINGS, FOLDER, [], true, 'linux'], files: settingsOf({ [FOLDER]: FP_A }) },
    {
      args: [SETTINGS, FOLDER, [SKILL_A], true, 'linux'],
      files: settingsOf({ [OTHER]: FP_AB }),
      note: 'the files are gone',
    },
    { args: [SETTINGS, '/Main-Diff/P1', [SKILL_A, SKILL_B], true, 'win32'], files: FILES_AB },
    {
      args: [SETTINGS, FOLDER, [SKILL_A, SKILL_B], true, 'linux'],
      files: { ...FILES_AB, ...settingsOf({ [FOLDER]: FP_A, [OTHER]: FP_A }) },
    },
  ] as Case[],
}

// ---- agent-session-folders ----

const NOW = 1_794_452_400_000
const HOUR = 3_600_000
const owner = (pid: unknown, createdAt: unknown): string => JSON.stringify({ pid, createdAt })
type Spec = FileSpec
/** a session folder: its mark (or none), a file, and the mtime of every entry */
function folder(
  name: string,
  mark: string | null,
  mtimeMs: number,
  extra: Record<string, Spec> = {},
): Record<string, Spec> {
  const out: Record<string, Spec> = {}
  if (mark !== null) out[`p/ieum-agent-${name}/owner.json`] = { text: mark, mtimeMs }
  for (const [path, spec] of Object.entries(extra)) out[`p/ieum-agent-${name}/${path}`] = spec
  out[`p/ieum-agent-${name}`] = { dir: true, mtimeMs }
  return out
}
const make = (extra: Record<string, unknown> = {}) => ({
  parent: '$DIR/p',
  tmp: '$DIR/t',
  pid: 4242,
  ...extra,
})
const sweep = (extra: Record<string, unknown> = {}) => ({
  parent: '$DIR/p',
  tmp: '$DIR/p',
  now: NOW,
  alive: [] as number[] | null,
  kill: { alive: [] as number[], eperm: [] as number[] },
  startTimes: null as unknown,
  platform: 'linux',
  pid: 7000,
  uptime: 100,
  env: {} as Record<string, string>,
  exec: null as string | null,
  ...extra,
})
const CREATED = NOW - 2 * HOUR
const DEAD = owner(100, CREATED)
const fresh = NOW - HOUR
const old = NOW - 25 * HOUR

const makeCases: Case[] = [
  { args: [make()], files: { p: { dir: true } } },
  { args: [make({ pid: 1 })], files: { p: { dir: true } } },
  { args: [make({ parent: null })], files: { t: { dir: true } }, note: 'the temporary folder' },
  { args: [make({ parent: '$DIR/nowhere' })] },
  { args: [make({ parent: '$DIR/file.txt' })], files: { 'file.txt': 'x' } },
]

/** the same two folders under every owner state, all old: removed or kept by their marks */
const marks: [string, unknown, unknown][] = [
  ['aaaaaa', 0, CREATED],
  ['bbbbbb', -5, CREATED],
  ['cccccc', 1.5, CREATED],
  ['dddddd', '12', CREATED],
  ['eeeeee', 12, undefined],
  ['ffffff', 12, 'late'],
  ['gggggg', 12, null],
  ['hhhhhh', null, CREATED],
]
const markFiles = (mtime: number): Record<string, Spec> =>
  Object.assign(
    {},
    ...marks.map(([name, pid, createdAt]) => folder(name, owner(pid, createdAt), mtime)),
  )
const SWEEP_PS = '  200 01:02:03\n  300 2-03:04:05\n   99 12:34\nnot a line\n\n  400 5-6:07\n'

const sweepCases: Case[] = [
  { args: [sweep()], files: folder('aaaaaa', DEAD, fresh), note: 'its owner is gone' },
  {
    args: [sweep({ alive: [100], startTimes: [[100, CREATED - 1000]] })],
    files: folder('aaaaaa', DEAD, fresh),
    note: 'it runs, it started first',
  },
  {
    args: [sweep({ alive: [100], startTimes: [[100, CREATED + 6 * 60_000]] })],
    files: folder('aaaaaa', DEAD, fresh),
    note: 'the number is another process',
  },
  {
    args: [sweep({ alive: [100], startTimes: [[100, CREATED + 4 * 60_000]] })],
    files: folder('aaaaaa', DEAD, fresh),
  },
  {
    args: [sweep({ alive: [100], startTimes: [[100, CREATED + 5 * 60_000]] })],
    files: folder('aaaaaa', DEAD, fresh),
    note: 'the slack itself',
  },
  {
    args: [sweep({ alive: [100], startTimes: [] })],
    files: folder('aaaaaa', DEAD, fresh),
    note: 'its start is not known',
  },
  {
    args: [
      sweep({
        alive: [100, 101],
        startTimes: [
          [100, CREATED + HOUR],
          [101, CREATED],
        ],
      }),
    ],
    files: {
      ...folder('aaaaaa', DEAD, fresh),
      ...folder('bbbbbb', owner(101, CREATED), fresh),
      ...folder('cccccc', DEAD, fresh),
    },
    note: 'two folders of one process',
  },
  {
    args: [sweep()],
    files: folder('aaaaaa', null, old, { 'a.txt': { text: 'x', mtimeMs: old } }),
    note: 'unmarked, a day old',
  },
  {
    args: [sweep()],
    files: folder('aaaaaa', null, NOW - 23 * HOUR, {
      'a.txt': { text: 'x', mtimeMs: NOW - 23 * HOUR },
    }),
  },
  {
    args: [sweep()],
    files: folder('aaaaaa', null, NOW - 24 * HOUR, {
      'a.txt': { text: 'x', mtimeMs: NOW - 24 * HOUR },
    }),
    note: 'exactly a day',
  },
  {
    args: [sweep()],
    files: folder('aaaaaa', null, old, { 'a.txt': { text: 'x', mtimeMs: NOW } }),
    note: 'a file changed since',
  },
  { args: [sweep()], files: folder('aaaaaa', '{ not json', old) },
  { args: [sweep()], files: markFiles(old), note: 'a bad mark is no mark, old' },
  { args: [sweep()], files: markFiles(fresh), note: 'a bad mark is no mark, new' },
  {
    args: [sweep()],
    files: folder('aaaaaa', '{"pid":12,"createdAt":1e999}', fresh),
    note: 'a time that is not finite is no mark',
  },
  {
    args: [sweep({ startTimes: [[100, 1]] })],
    files: folder('aaaaaa', DEAD, fresh),
    note: 'nothing runs: no start times are asked for',
  },
  {
    args: [sweep()],
    files: folder('aaaaaa', null, fresh, { 'a.txt': { text: 'x', mtimeMs: old } }),
    note: 'the folder changed after its file',
  },
  {
    args: [sweep()],
    files: folder('aaaaaa', DEAD, fresh, {
      'sub/x.txt': { text: 'x', mtimeMs: fresh },
      'sub/deep/y.txt': { text: 'y', mtimeMs: fresh },
      'sub/deep': { dir: true, mtimeMs: fresh },
      sub: { dir: true, mtimeMs: fresh },
    }),
    note: 'folders inside go first',
  },
  { args: [sweep()], files: folder('aaaaaa', DEAD, fresh, many(255, 'f')), note: '256 entries' },
  {
    args: [sweep()],
    files: folder('aaaaaa', DEAD, fresh, many(256, 'f')),
    note: '257 entries: not ours',
  },
  {
    args: [sweep()],
    files: Object.assign(
      {},
      ...Array.from({ length: 101 }, (_, i) =>
        folder(`${String(i).padStart(6, '0')}`.padEnd(6, '0'), DEAD, fresh),
      ),
    ),
    note: '101 folders: the 101st waits',
  },
  {
    args: [sweep()],
    files: {
      ...folder('abcdef', DEAD, fresh),
      ...folder('abc', DEAD, fresh),
      'p/ieum-agent-abcdefg/owner.json': DEAD,
      'p/ieum-agent-abc_ef/owner.json': DEAD,
      'p/other-abcdef/owner.json': DEAD,
      'p/ieum-agent-abcdef.txt/owner.json': DEAD,
    },
    note: 'only names of the pattern',
  },
  { args: [sweep()], files: { 'p/ieum-agent-abcdef': 'a file' }, note: 'a file is not a folder' },
  { args: [sweep({ parent: '$DIR/nowhere' })] },
  {
    args: [sweep({ parent: null })],
    files: folder('aaaaaa', DEAD, fresh),
    note: 'the temporary folder',
  },
  {
    args: [sweep({ now: null })],
    files: folder('aaaaaa', null, old, { 'a.txt': { text: 'x', mtimeMs: old } }),
    note: 'the clock',
  },
  {
    args: [sweep({ alive: [100] })],
    files: folder('aaaaaa', DEAD, fresh),
    note: 'alive, started per the option: none',
  },
  {
    args: [sweep({ alive: null, kill: { alive: [200], eperm: [300] }, exec: SWEEP_PS })],
    files: {
      ...folder('aaaaaa', DEAD, fresh),
      ...folder('bbbbbb', owner(200, NOW - 2 * HOUR), fresh),
      ...folder('cccccc', owner(300, NOW - 183_000_000), fresh),
      ...folder('dddddd', owner(400, NOW - 3 * HOUR), fresh),
    },
    note: 'the system says how long each has run',
  },
  {
    args: [sweep({ alive: null, kill: { alive: [200], eperm: [] }, exec: null })],
    files: folder('bbbbbb', owner(200, CREATED), fresh),
    note: 'ps fails',
  },
  {
    args: [sweep({ alive: null, kill: { alive: [7000], eperm: [] } })],
    files: folder('aaaaaa', owner(7000, NOW - 50_000), fresh),
    note: 'this process, from its own clock',
  },
  {
    args: [sweep({ alive: null, kill: { alive: [7000], eperm: [] } })],
    files: folder('aaaaaa', owner(7000, CREATED), fresh),
    note: 'this process started after the folder',
  },
  {
    args: [sweep({ alive: null, kill: { alive: [200, 7000], eperm: [] }, exec: '200 04:00\n' })],
    files: {
      ...folder('aaaaaa', owner(200, CREATED), fresh),
      ...folder('bbbbbb', owner(7000, NOW - 50_000), fresh),
    },
    note: 'this process and another',
  },
  {
    args: [
      sweep({
        platform: 'win32',
        alive: null,
        kill: { alive: [200, 300], eperm: [] },
        env: { SystemRoot: 'D:\\Win' },
        exec: '200 1794452300000\r\n300 1794400000000\r\nnoise\r\n',
      }),
    ],
    files: {
      ...folder('aaaaaa', owner(200, NOW - 2 * HOUR), fresh),
      ...folder('bbbbbb', owner(300, NOW - 2 * HOUR), fresh),
      ...folder('cccccc', owner(300, NOW - 2 * HOUR), fresh),
    },
    note: 'Windows PowerShell',
  },
  {
    args: [
      sweep({
        platform: 'win32',
        alive: null,
        kill: { alive: [200], eperm: [] },
        env: {},
        exec: null,
      }),
    ],
    files: folder('aaaaaa', owner(200, CREATED), fresh),
    note: 'no system folder named',
  },
  {
    args: [
      sweep({
        platform: 'win32',
        alive: null,
        kill: { alive: [200], eperm: [] },
        env: { SystemRoot: 'relative', windir: 'E:\\W' },
        exec: '200 1\n',
      }),
    ],
    files: folder('aaaaaa', owner(200, CREATED), fresh),
    note: 'the second variable is the one that counts',
  },
]

// ---- the scripts of the specs of this part ----

async function runMake(o: J, cx: TsContext): Promise<unknown> {
  return patched({ pid: o.pid, now: cx.now, tmpdir: o.tmp }, async () => {
    let dir: string
    try {
      dir = await folders.makeAgentSessionFolder(opt(o.parent))
    } catch (error) {
      // the system names the letters it tried; Node on Linux names the template
      const failed = error as Error
      failed.message = maskRand(failed.message)
      throw failed
    }
    const mark = readFileSync(join(dir, 'owner.json'), 'utf8')
    renameSync(dir, join(dirname(dir), 'ieum-agent-FIXED1'))
    return { dir: maskRand(dir), owner: mark }
  })
}

async function runSweep(o: J, cx: TsContext): Promise<unknown> {
  const proc = process as unknown as Record<string, unknown>
  const fakeKill = ((pid: number) => {
    if (o.kill.alive.includes(pid)) return true
    const error = new Error('kill') as Error & { code: string }
    error.code = o.kill.eperm.includes(pid) ? 'EPERM' : 'ESRCH'
    throw error
  }) as unknown as typeof process.kill
  const fakeExec = ((
    file: string,
    args: string[],
    options: unknown,
    done: (e: Error | null, out: string) => void,
  ) => {
    cx.log('exec', file, args, options)
    if (o.exec === null) done(new Error('exec'), '')
    else done(null, o.exec)
  }) as unknown as typeof childProcess.execFile
  const options = {
    parent: opt(o.parent),
    now: opt(o.now),
    alive: o.alive
      ? (pid: number): boolean => {
          cx.log('alive', pid)
          return o.alive.includes(pid)
        }
      : undefined,
    startTimes: o.startTimes
      ? async (pids: readonly number[]): Promise<ReadonlyMap<number, number>> => {
          cx.log('startTimes', [...pids])
          return new Map(o.startTimes as [number, number][])
        }
      : undefined,
  }
  proc.kill = fakeKill
  childProcess.execFile = fakeExec
  try {
    return await patched(
      {
        platform: o.platform,
        pid: o.pid,
        uptime: o.uptime,
        now: cx.now,
        tmpdir: o.tmp,
        env: o.env,
      },
      async () => {
        syncBuiltinESMExports()
        await folders.sweepAgentSessionFolders(options)
      },
    )
  } finally {
    proc.kill = realKill
    childProcess.execFile = realExecFile
    syncBuiltinESMExports()
  }
}

// ---- agent-sessions: the pure functions ----

const skillEntry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `skill-${id}`,
  source: 'user',
  plugin: undefined,
  title: `Title ${id}`,
  description: `Does ${id}`,
  invoke: 'auto',
  skillMd: `/bundle/${id}/skills/skill-${id}/SKILL.md`,
  ...extra,
})

const protectedCases = cases(
  ['/home/u', '/data/app'],
  ['/Users/x/', '/ud'],
  ['/h//u/./', '/a/../b'],
  ['C:/Users/u', 'C:/ud'],
)

const folderProblemFiles: Case['files'] = {
  'proj/a.txt': 'x',
  'file.txt': 'x',
  'home/.claude/x': 'x',
  'home/.claude2/x': 'x',
  'home/work/x': 'x',
  'Home/x': 'x',
}
const guards = ['$DIR/home/.claude', '$DIR/home/.codex']
const problemCases: Case[] = [
  { args: ['', '/h', [], 'linux'] },
  { args: ['rel/path', '/h', [], 'linux'] },
  { args: ['$DIR/missing', '/h', [], 'linux'] },
  { args: ['$DIR/file.txt', '/h', [], 'linux'], files: folderProblemFiles },
  { args: ['/', '/h', [], 'linux'] },
  { args: ['$DIR/home', '$DIR/home', guards, 'linux'], files: folderProblemFiles },
  { args: ['$DIR/home/', '$DIR/home', guards, 'linux'], files: folderProblemFiles },
  { args: ['$DIR/home/.claude', '$DIR/home', guards, 'linux'], files: folderProblemFiles },
  { args: ['$DIR/home/.claude/..', '$DIR/home', guards, 'linux'], files: folderProblemFiles },
  {
    args: ['$DIR', '$DIR/home', guards, 'linux'],
    files: folderProblemFiles,
    note: 'holds a protected folder',
  },
  {
    args: ['$DIR/home/.claude2', '$DIR/home', guards, 'linux'],
    files: folderProblemFiles,
    note: 'a name that starts the same',
  },
  { args: ['$DIR/home/work', '$DIR/home', guards, 'linux'], files: folderProblemFiles },
  { args: ['$DIR/proj', '/h', [], 'linux'], files: folderProblemFiles },
  { args: ['$DIR/proj', '/h', [], 'win32'], files: folderProblemFiles },
  {
    args: ['$DIR/Home', '$DIR/home', guards, 'win32'],
    files: folderProblemFiles,
    note: 'Windows folds case',
  },
  { args: ['$DIR/Home', '$DIR/home', guards, 'linux'], files: folderProblemFiles },
]

/** a text whose pretty JSON is exactly `size` characters long */
const jsonOfSize = (size: number): unknown => ({ k: 'x'.repeat(size - 13) })
const previewCases = cases(
  [{}],
  [{ a: 1, b: [1, 2, { c: null }], d: 'text' }],
  [{ text: 'x'.repeat(3000) }],
  [jsonOfSize(2000)],
  [jsonOfSize(2001)],
  [{ unicode: '한글 문서', nested: { deep: { deeper: [true, false] } } }],
  [{ list: Array.from({ length: 200 }, (_, i) => i) }],
)

const codexSkillCases = cases(
  [[]],
  [[skillEntry('a')]],
  [[skillEntry('a', { title: 'skill-a' })]],
  [[skillEntry('a', { title: '' })]],
  [[skillEntry('a', { invoke: 'manual' }), skillEntry('b')]],
  [[skillEntry('a', { title: '  Spread \n over   lines ', description: 'one\n\ttwo   three ' })]],
  [[skillEntry('a', { description: '   ' })]],
  [[skillEntry('a', { skillMd: '' }), skillEntry('b')]],
  [[skillEntry('a', { skillMd: 'SKILL.md' })]],
)

const PROJ = '$DIR/proj'
const LONG_NOTE = `${'long note line\n'.repeat(2500)}`
const instructionFiles = {
  both: { 'proj/CLAUDE.md': 'Claude notes\n', 'proj/AGENTS.md': 'Agents notes\n' },
  blank: { 'proj/CLAUDE.md': ' \n\t\n', 'proj/AGENTS.md': 'Only agents\n' },
  long: { 'proj/CLAUDE.md': LONG_NOTE, 'proj/AGENTS.md': `${LONG_NOTE}tail` },
  exact: { 'proj/CLAUDE.md': 'y'.repeat(32_000) },
  over: { 'proj/CLAUDE.md': 'y'.repeat(32_001) },
  pair: { 'proj/CLAUDE.md': `${'a'.repeat(31_999)}\u{1F600}tail` },
  dir: { 'proj/CLAUDE.md/x': 'a file in a folder named like a note' },
}
/** a note that is a link to a file outside the project folder */
const outsideLong = { 'outside.md': LONG_NOTE, 'proj/x': 'x' }
const instructionCases: Case[] = [
  { args: ['claude-code', PROJ, 'ko', false, [], [], 'linux'], files: { proj: { dir: true } } },
  { args: ['claude-code', PROJ, 'en', true, [], [], 'linux'], files: instructionFiles.both },
  { args: ['codex', PROJ, 'ko', true, [], [], 'linux'], files: instructionFiles.both },
  {
    args: ['claude-code', PROJ, 'ko', false, [], ['github', 'linear'], 'linux'],
    files: instructionFiles.blank,
  },
  {
    args: [
      'codex',
      PROJ,
      'ko',
      false,
      [skillEntry('a'), skillEntry('b', { invoke: 'manual' })],
      ['one'],
      'linux',
    ],
    files: instructionFiles.both,
  },
  {
    args: ['claude-code', PROJ, 'ko', false, [skillEntry('a')], [], 'linux'],
    files: instructionFiles.both,
    note: 'Claude Code finds the skills itself',
  },
  { args: ['claude-code', PROJ, 'ko', false, [], [], 'linux'], files: instructionFiles.long },
  { args: ['codex', PROJ, 'ko', false, [], [], 'linux'], files: instructionFiles.long },
  { args: ['claude-code', PROJ, 'ko', false, [], [], 'linux'], files: instructionFiles.exact },
  { args: ['claude-code', PROJ, 'ko', false, [], [], 'linux'], files: instructionFiles.over },
  {
    args: ['claude-code', PROJ, 'ko', false, [], [], 'linux'],
    files: instructionFiles.pair,
    note: 'the cut keeps a pair whole',
  },
  {
    args: ['claude-code', PROJ, 'ko', false, [], [], 'linux'],
    files: instructionFiles.dir,
    note: 'a folder is no note',
  },
  { args: ['claude-code', PROJ, 'ko', false, [], [], 'win32'], files: instructionFiles.long },
  {
    args: [
      'claude-code',
      PROJ,
      'ko',
      false,
      [],
      [],
      'linux',
      [['$DIR/proj/CLAUDE.md', '$DIR/outside.md']],
    ],
    files: outsideLong,
    note: 'a link out of the folder',
  },
  {
    args: [
      'claude-code',
      PROJ,
      'ko',
      false,
      [],
      [],
      'linux',
      [['$DIR/proj/CLAUDE.md', '$DIR/inside.md']],
    ],
    files: { 'inside.md': LONG_NOTE, 'proj/x': 'x' },
    note: 'a link to a file in the case folder but out of the project',
  },
  {
    args: [
      'claude-code',
      PROJ,
      'ko',
      false,
      [],
      [],
      'linux',
      [['$DIR/proj/CLAUDE.md', '$DIR/proj/real.md']],
    ],
    files: { 'proj/real.md': LONG_NOTE },
    note: 'a link that stays inside',
  },
  {
    args: [
      'claude-code',
      PROJ,
      'ko',
      false,
      [],
      [],
      'linux',
      [['$DIR/proj/CLAUDE.md', '$DIR/proj/..x/note.md']],
    ],
    files: { 'proj/..x/note.md': LONG_NOTE },
    note: 'a folder named like a step up',
  },
  { args: ['claude-code', '$DIR/nowhere', 'ko', true, [], [], 'linux'], note: 'no folder' },
]

const openableFiles: Case['files'] = {
  'proj/a.txt': 'x',
  'proj/sub/b.md': 'x',
  'proj/dir/c': 'x',
  'outside.txt': 'x',
}
const openableCases: Case[] = [
  { args: [PROJ, 'a.txt', 'linux'], files: openableFiles },
  { args: [PROJ, 'sub/b.md', 'linux'], files: openableFiles },
  { args: [PROJ, '$DIR/proj/a.txt', 'linux'], files: openableFiles },
  { args: [PROJ, 'sub/../a.txt', 'win32'], files: openableFiles },
  { args: [PROJ, '../outside.txt', 'linux'], files: openableFiles },
  { args: [PROJ, '$DIR/outside.txt', 'linux'], files: openableFiles },
  { args: [PROJ, 'dir', 'linux'], files: openableFiles },
  { args: [PROJ, 'nope.txt', 'linux'], files: openableFiles },
  { args: [PROJ, '', 'linux'], files: openableFiles },
  { args: [PROJ, '..', 'linux'], files: openableFiles },
  { args: [PROJ, '$DIR/proj', 'linux'], files: openableFiles },
  {
    args: [PROJ, '$DIR/proj2/a.txt', 'linux'],
    files: { ...openableFiles, 'proj2/a.txt': 'x' },
    note: 'a folder named like the project',
  },
]

const errorDescriptors: unknown[] = [
  { class: 'program', problem: { type: 'exited', exitCode: 2 }, message: 'exit' },
  { class: 'program', problem: { type: 'no-model' }, message: 'no model', kind: 'rate-limit' },
  { class: 'error', message: 'plain' },
  { class: 'error', message: 'limit', kind: 'rate-limit' },
  { class: 'error', message: 'limit', kind: 'made-up' },
  { class: 'error', message: 'limit', kind: 5 },
  { class: 'error', message: 'fs', code: 'ENOENT' },
  { class: 'error', message: 'named', name: 'TypeError' },
  { class: 'error', message: 'unsafe words', name: 'Bad Name!', code: 'x y z' },
  { class: 'error', message: 'run', kind: 'off-in-app', name: 'AiRunError' },
  { class: 'value', value: 'a string' },
  { class: 'value', value: null },
  { class: 'value', value: 7 },
  { class: 'value', value: { kind: 'signed-out' } },
  { class: 'value', value: { kind: 'nope' } },
]

/** the throwable a descriptor says */
function thrownOf(t: J): unknown {
  if (t.class === 'program') {
    return new SessionProgramError(t.problem, t.message ?? '')
  }
  if (t.class === 'value') return t.value
  const error = new Error(t.message ?? '') as Error & Record<string, unknown>
  if (t.name !== undefined) error.name = t.name
  if (t.code !== undefined) error.code = t.code
  if (t.kind !== undefined) error.kind = t.kind
  return error
}

/** the links a case asks for before the call, as `[path, target]` pairs; the Rust side makes the same */
function makeLinks(links: [string, string][] | undefined): void {
  for (const [path, target] of links ?? []) {
    try {
      symlinkSync(target, path)
    } catch {
      /* a system that does not link */
    }
  }
}

// ---- agent-sessions: the manager ----

const sleepTick = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
}

async function runManager(o: J, cx: TsContext): Promise<unknown> {
  const log = (...line: unknown[]): void => cx.log(...line.map(maskDeep))
  let counter = 0
  const state = { settings: o.settings, statuses: o.statuses, openDocuments: [...o.openDocuments] }
  const onEvents: ((event: unknown) => void)[] = []
  const asksBySession = new Map<string, (request: unknown, signal: unknown) => Promise<unknown>>()
  const asks: { signal: { aborted: boolean; listeners: (() => void)[] } }[] = []
  const deferred: unknown[][] = []
  const slow: { path: string; resolve: () => void }[] = []
  let manager: J

  const runOp = (op: J, onEvent?: (event: unknown) => void): void => {
    switch (op.op) {
      case 'stop':
        manager.stop(op.owner, op.session)
        break
      case 'stopOwner':
        manager.stopOwner(op.owner)
        break
      case 'stopAll':
        manager.stopAll()
        break
      case 'event':
        onEvent?.(op.event)
        break
      case 'setSettings':
        state.settings = op.settings
        break
      case 'setStatuses':
        state.statuses = op.statuses
        break
    }
  }
  const during = (step: string, onEvent?: (event: unknown) => void): void => {
    for (const op of o.during?.[step] ?? []) runOp(op, onEvent)
  }
  const session = (provider: string, spec: J) => ({
    provider,
    send: async (text: string): Promise<void> => {
      log('session.send', provider, text)
      if (spec.sendError) throw new Error(spec.sendError)
    },
    answer: (id: string, answer: unknown): void => log('session.answer', provider, id, answer),
    setOpenDocuments: (paths: string[]): void => log('session.setOpenDocuments', provider, paths),
    stop: (): void => log('session.stop', provider),
  })
  const runner =
    (provider: string, spec: J = {}) =>
    async (options: unknown, onEvent: (event: unknown) => void) => {
      log(provider === 'claude-code' ? 'claude' : 'codex', options)
      onEvents.push(onEvent)
      during('runner', onEvent)
      if (spec.setSettings !== undefined) state.settings = spec.setSettings
      if (spec.throw) throw thrownOf(spec.throw)
      return session(provider, spec)
    }

  const deps: J = {
    runners: {
      claude: runner('claude-code', o.runner.claude),
      codex: runner('codex', o.runner.codex),
    },
    statuses: () => state.statuses,
    aiSettings: () => state.settings,
    openDocuments: () => [...state.openDocuments],
    userData: o.userData,
    homeDir: o.homeDir,
    language: () => o.language,
    platform: o.platform,
    emit: (owner: number, id: string, event: unknown): void => log('emit', owner, id, event),
  }
  if (o.appMcp) {
    deps.startAppMcp = async (root: string, who: unknown) => {
      log('startAppMcp', root, who)
      during('app-tools')
      if (o.appMcp.throw) throw thrownOf(o.appMcp.throw)
      return { url: o.appMcp.url, token: o.appMcp.token, stop: async () => log('appMcp.stop') }
    }
  }
  if (o.relays) {
    deps.startRelays = async (who: { sessionId: string }, ask: never) => {
      log('startRelays', who)
      asksBySession.set(who.sessionId, ask)
      during('user-mcp')
      if (o.relays.throw) throw thrownOf(o.relays.throw)
      return {
        relays: o.relays.relays,
        keepResultsInside: o.relays.keepResultsInside,
        stop: async () => log('relays.stop'),
      }
    }
  }
  if (o.buildSkills) {
    deps.buildSkills = async (root: string) => {
      log('buildSkills', root)
      during('skills')
      if (o.buildSkills.throw) throw thrownOf(o.buildSkills.throw)
      return o.buildSkills.bundle ?? undefined
    }
  }
  const fakeRm = async (path: string, options: unknown): Promise<void> => {
    log('rm', path, options)
    if (o.rm === 'slow') {
      await new Promise<void>((resolve) => slow.push({ path, resolve }))
      return
    }
    if (o.rm === 'fail') throw new Error('rm failed')
    realRmSync(path, options as never)
  }
  const fakeRmSync = (path: string, options: unknown): void => {
    log('rmSync', path, options)
    if (o.rmSync === 'fail') throw new Error('rmSync failed')
    realRmSync(path, options as never)
  }

  let uuids = 0
  ;(crypto as unknown as { randomUUID: () => string }).randomUUID = () => `uuid-${++uuids}`
  ;(fsPromises as unknown as { rm: unknown }).rm = fakeRm
  ;(fs as unknown as { rmSync: unknown }).rmSync = fakeRmSync
  os.tmpdir = () => o.tmp
  syncBuiltinESMExports()
  try {
    manager = sessions.createAgentManager(deps)
    const out: unknown[] = []
    for (const step of o.steps) {
      const entry: J = { op: step.op }
      try {
        switch (step.op) {
          case 'start':
            entry.result = await manager.start(step.owner, step.request)
            break
          case 'send':
            await manager.send(step.owner, step.session, step.text)
            break
          case 'answer':
            manager.answer(step.owner, step.session, step.request, step.answer)
            break
          case 'stop':
            manager.stop(step.owner, step.session)
            break
          case 'stopOwner':
            manager.stopOwner(step.owner)
            break
          case 'stopAll':
            manager.stopAll()
            break
          case 'projectRootOf':
            entry.value = manager.projectRootOf(step.owner, step.session)
            break
          case 'skillsOf':
            entry.value = manager.skillsOf(step.owner, step.session)
            break
          case 'event':
            onEvents[step.runner]!(step.event)
            break
          case 'relayAsk': {
            const ask = asksBySession.get(step.session)!
            const signal = {
              aborted: Boolean(step.aborted),
              listeners: [] as (() => void)[],
              addEventListener(_type: string, listener: () => void): void {
                this.listeners.push(listener)
              },
              removeEventListener(_type: string, listener: () => void): void {
                this.listeners = this.listeners.filter((known) => known !== listener)
              },
            }
            const index = asks.push({ signal }) - 1
            void ask(step.request, signal).then((answer) =>
              deferred.push(['relay.answer', index, answer]),
            )
            entry.ask = index
            break
          }
          case 'abortAsk': {
            const known = asks[step.ask]!
            known.signal.aborted = true
            for (const listener of [...known.signal.listeners]) listener()
            break
          }
          case 'finishRm':
            for (const { path, resolve } of slow.splice(0)) {
              realRmSync(path, { recursive: true, force: true })
              resolve()
            }
            break
          case 'setOpenDocuments':
            state.openDocuments = [...step.paths]
            break
          case 'setSettings':
            state.settings = step.settings
            break
          case 'setStatuses':
            state.statuses = step.statuses
            break
          default:
            throw new Error(`no such step: ${step.op}`)
        }
      } catch (error) {
        entry.error = (error as Error).message
      }
      await sleepTick()
      for (const line of deferred.splice(0)) log(...line)
      out.push(entry)
    }
    let left: string[] = []
    try {
      left = readdirSync(o.tmp).map(maskRand).sort()
    } catch {
      /* no temporary folder */
    }
    realRmSync(o.tmp, { recursive: true, force: true })
    return { steps: maskDeep(out), left }
  } finally {
    crypto.randomUUID = realUuid
    fsPromises.rm = realRm
    fs.rmSync = realRmSync
    os.tmpdir = realTmpdir
    syncBuiltinESMExports()
  }
}

const PROJECT_FILES: Case['files'] = {
  'proj/CLAUDE.md': 'Project notes\n',
  'ud/x': 'x',
  'ud/sub/x': 'x',
  'home/x': 'x',
  'home/.claude/x': 'x',
  t: { dir: true },
}
const READY = {
  'claude-code': { provider: 'claude-code', state: 'ready' },
  codex: { provider: 'codex', state: 'ready' },
}
const METERED = {
  'claude-code': { provider: 'claude-code', state: 'ready' },
  codex: { provider: 'codex', state: 'metered', meteredAccepted: true },
}
const APP_SETTINGS = {
  providers: {
    'claude-code': { model: 'opus', effort: 'high', cliPath: '/bin/claude' },
    codex: { model: 'gpt-5' },
  },
  meteredAccepted: { codex: true },
}
const OFF_CLAUDE = { ...APP_SETTINGS, subscriptionOff: { 'claude-code': true } }
const OFF_CODEX = { ...APP_SETTINGS, subscriptionOff: { codex: true } }
const scenario = (extra: Record<string, unknown> = {}): unknown[] => [
  {
    userData: '$DIR/ud',
    homeDir: '$DIR/home',
    platform: 'linux',
    tmp: '$DIR/t',
    language: 'ko',
    settings: APP_SETTINGS,
    statuses: READY,
    openDocuments: [] as string[],
    appMcp: null,
    relays: null,
    buildSkills: null,
    runner: {},
    rm: 'fast',
    rmSync: 'ok',
    during: {},
    steps: [] as unknown[],
    ...extra,
  },
]
const start = (provider = 'claude-code', owner = 1, extra: Record<string, unknown> = {}) => ({
  op: 'start',
  owner,
  request: { provider, projectRoot: '$DIR/proj', mode: 'ask-commands', ...extra },
})
const APP_MCP = { url: 'http://127.0.0.1:7/mcp', token: 'tok-app' }
const RELAYS = {
  relays: [
    { name: 'github', url: 'http://127.0.0.1:7/a', token: 'tok-a', tools: ['search', 'get'] },
    { name: 'linear', url: 'http://127.0.0.1:7/b', token: 'tok-b', tools: [] },
  ],
  keepResultsInside: ['linear'],
}
const BUNDLE = {
  bundle: {
    dir: '$DIR/bundle',
    skills: [skillEntry('a'), skillEntry('b', { invoke: 'manual', plugin: 'plug' })],
    skipped: [],
  },
}
const ALL_DEPS = { appMcp: APP_MCP, relays: RELAYS, buildSkills: BUNDLE }
const sid = (n: number): string => `uuid-${n}`
const at = (op: string, extra: Record<string, unknown> = {}) => ({
  op,
  owner: 1,
  session: sid(1),
  ...extra,
})
const ask = (n: number, extra: Record<string, unknown> = {}) => ({
  op: 'relayAsk',
  session: sid(1),
  request: { exposedName: `mcp__github__tool${n}`, server: 'github', input: { n, query: 'q' } },
  ...extra,
})
const runnerOf = (provider: string, spec: unknown) => ({
  [provider === 'claude-code' ? 'claude' : 'codex']: spec,
})

const managerCases: Case[] = [
  {
    args: scenario({
      steps: [
        start(),
        at('projectRootOf'),
        at('projectRootOf', { owner: 2 }),
        at('skillsOf'),
        at('stop'),
        at('projectRootOf'),
        at('stop'),
      ],
    }),
    files: PROJECT_FILES,
    note: 'a plain start, its folder, the end',
  },
  {
    args: scenario({
      statuses: METERED,
      steps: [
        start('codex', 1, { codex: { webSearch: 'live', network: true } }),
        start('codex', 1),
        start('codex', 2, { codex: { webSearch: 'disabled', network: false } }),
        { op: 'setStatuses', statuses: READY },
        start('codex', 2, { codex: { webSearch: 'cached', network: true } }),
        { op: 'stopAll' },
      ],
    }),
    files: PROJECT_FILES,
    note: 'Codex: the remembered choices and the metered login',
  },
  {
    args: scenario({
      ...ALL_DEPS,
      steps: [
        start(),
        start('codex', 2, { codex: { webSearch: 'live', network: true } }),
        at('skillsOf'),
        { op: 'stopAll' },
      ],
    }),
    files: PROJECT_FILES,
    note: 'the app tools, the relays and the skills',
  },
  {
    args: scenario({
      ...ALL_DEPS,
      buildSkills: { bundle: null },
      steps: [start(), at('skillsOf'), { op: 'stopAll' }],
    }),
    files: PROJECT_FILES,
    note: 'no skills built',
  },
  {
    args: scenario({
      appMcp: APP_MCP,
      relays: { relays: [], keepResultsInside: [] },
      steps: [start(), at('stop')],
    }),
    files: PROJECT_FILES,
    note: 'relays with none on',
  },
  {
    args: scenario({
      steps: [
        {
          op: 'start',
          owner: 1,
          request: { provider: 'claude-code', projectRoot: '$DIR/missing', mode: 'ask-commands' },
        },
        {
          op: 'start',
          owner: 1,
          request: { provider: 'claude-code', projectRoot: '$DIR/ud', mode: 'ask-commands' },
        },
        {
          op: 'start',
          owner: 1,
          request: { provider: 'claude-code', projectRoot: '$DIR/ud/sub', mode: 'ask-commands' },
        },
        {
          op: 'start',
          owner: 1,
          request: { provider: 'claude-code', projectRoot: '$DIR/home', mode: 'ask-commands' },
        },
        {
          op: 'start',
          owner: 1,
          request: {
            provider: 'claude-code',
            projectRoot: '$DIR/home/.claude',
            mode: 'ask-commands',
          },
        },
        {
          op: 'start',
          owner: 1,
          request: {
            provider: 'claude-code',
            projectRoot: '$DIR/proj/../proj',
            mode: 'ask-commands',
          },
        },
        {
          op: 'start',
          owner: 1,
          request: { provider: 'claude-code', projectRoot: 'relative', mode: 'ask-commands' },
        },
      ],
    }),
    files: PROJECT_FILES,
    note: 'folders that cannot be a project',
  },
  {
    args: scenario({
      statuses: {},
      steps: [
        start(),
        {
          op: 'setStatuses',
          statuses: { 'claude-code': { provider: 'claude-code', state: 'signed-out' } },
        },
        start(),
        {
          op: 'setStatuses',
          statuses: { codex: { provider: 'codex', state: 'metered', meteredAccepted: true } },
        },
        { op: 'setSettings', settings: { ...APP_SETTINGS, meteredAccepted: {} } },
        start('codex'),
        { op: 'setSettings', settings: OFF_CODEX },
        start('codex'),
        { op: 'setSettings', settings: APP_SETTINGS },
        start('codex'),
      ],
    }),
    files: PROJECT_FILES,
    note: 'not connected',
  },
  {
    args: scenario({
      appMcp: { ...APP_MCP, throw: { class: 'error', message: 'no port', code: 'EADDRINUSE' } },
      steps: [start()],
    }),
    files: PROJECT_FILES,
    note: 'the app tools fail to start',
  },
  {
    args: scenario({
      appMcp: APP_MCP,
      relays: { ...RELAYS, throw: { class: 'error', message: 'relay', name: 'RelayError' } },
      steps: [start()],
    }),
    files: PROJECT_FILES,
    note: 'the relays fail after the app tools started',
  },
  {
    args: scenario({
      ...ALL_DEPS,
      buildSkills: { throw: { class: 'value', value: 'a string' } },
      steps: [start('codex')],
    }),
    files: PROJECT_FILES,
    note: 'the skills fail, a string is thrown',
  },
  {
    args: scenario({ tmp: '$DIR/nowhere', appMcp: APP_MCP, steps: [start()] }),
    files: PROJECT_FILES,
    note: 'no session folder can be made',
  },
  {
    args: scenario({
      ...ALL_DEPS,
      runner: runnerOf('claude-code', {
        throw: {
          class: 'program',
          problem: { type: 'refused', step: 'a/b', code: 4 },
          message: 'refused',
        },
      }),
      steps: [start()],
    }),
    files: PROJECT_FILES,
    note: 'the program refuses',
  },
  {
    args: scenario({
      appMcp: APP_MCP,
      runner: runnerOf('claude-code', {
        throw: { class: 'error', message: 'slow down', kind: 'rate-limit', name: 'AiRunError' },
      }),
      steps: [start()],
    }),
    files: PROJECT_FILES,
    note: 'a run error the window knows',
  },
  {
    args: scenario({
      runner: runnerOf('codex', {
        throw: { class: 'error', message: 'strange', kind: 'invented' },
      }),
      steps: [start('codex'), start('codex', 1, { codex: { webSearch: 'live', network: false } })],
    }),
    files: PROJECT_FILES,
    note: 'a run error it does not',
  },
  {
    args: scenario({
      runner: runnerOf('claude-code', { throw: { class: 'value', value: { kind: 'signed-out' } } }),
      steps: [start()],
    }),
    files: PROJECT_FILES,
    note: 'a thrown value with a kind',
  },
  {
    args: scenario({
      appMcp: APP_MCP,
      during: { 'app-tools': [{ op: 'setSettings', settings: OFF_CLAUDE }] },
      steps: [start(), at('projectRootOf')],
    }),
    files: PROJECT_FILES,
    note: 'turned off while the servers start',
  },
  {
    args: scenario({
      runner: runnerOf('claude-code', { setSettings: OFF_CLAUDE }),
      appMcp: APP_MCP,
      steps: [start(), at('projectRootOf')],
    }),
    files: PROJECT_FILES,
    note: 'turned off while the runner works',
  },
  {
    args: scenario({
      buildSkills: BUNDLE,
      during: {
        skills: [
          {
            op: 'setStatuses',
            statuses: { ...READY, 'claude-code': { provider: 'claude-code', state: 'off' } },
          },
        ],
      },
      steps: [start()],
    }),
    files: PROJECT_FILES,
    note: 'the window saw it off',
  },
  {
    args: scenario({
      appMcp: APP_MCP,
      during: { 'app-tools': [{ op: 'setSettings', settings: OFF_CODEX }] },
      steps: [start()],
    }),
    files: PROJECT_FILES,
    note: 'another program turned off',
  },
  {
    args: scenario({
      appMcp: APP_MCP,
      during: { 'app-tools': [{ op: 'stop', owner: 1, session: sid(1) }] },
      steps: [start(), at('projectRootOf')],
    }),
    files: PROJECT_FILES,
    note: 'stopped while the app tools start',
  },
  {
    args: scenario({
      ...ALL_DEPS,
      during: { 'user-mcp': [{ op: 'stopOwner', owner: 1 }] },
      steps: [start()],
    }),
    files: PROJECT_FILES,
    note: 'the owner went while the relays start',
  },
  {
    args: scenario({ ...ALL_DEPS, during: { skills: [{ op: 'stopAll' }] }, steps: [start()] }),
    files: PROJECT_FILES,
    note: 'the app quit while the skills are built',
  },
  {
    args: scenario({
      ...ALL_DEPS,
      during: { runner: [{ op: 'stop', owner: 1, session: sid(1) }] },
      steps: [start()],
    }),
    files: PROJECT_FILES,
    note: 'stopped while the runner works: its program ends',
  },
  {
    args: scenario({
      ...ALL_DEPS,
      during: { runner: [{ op: 'stop', owner: 2, session: sid(1) }] },
      steps: [start(), at('projectRootOf')],
    }),
    files: PROJECT_FILES,
    note: 'another owner cannot stop it',
  },
  {
    args: scenario({
      ...ALL_DEPS,
      during: { runner: [{ op: 'event', event: { type: 'ended' } }] },
      steps: [start(), at('projectRootOf')],
    }),
    files: PROJECT_FILES,
    note: 'the program ended while the runner worked',
  },
  {
    args: scenario({
      appMcp: APP_MCP,
      during: {
        runner: [{ op: 'event', event: { type: 'started', provider: 'claude-code', skills: [] } }],
      },
      steps: [start(), at('projectRootOf')],
    }),
    files: PROJECT_FILES,
    note: 'an event that does not end it',
  },
  {
    args: scenario({
      ...ALL_DEPS,
      during: {
        'app-tools': [{ op: 'stop', owner: 1, session: sid(1) }],
        'user-mcp': [{ op: 'stopAll' }],
      },
      steps: [start()],
    }),
    files: PROJECT_FILES,
    note: 'stopped twice',
  },
  {
    args: scenario({
      openDocuments: ['/docs/a.docx'],
      steps: [
        start(),
        at('send', { text: 'hello' }),
        { op: 'setOpenDocuments', paths: ['/docs/a.docx', '/docs/b.docx'] },
        at('send', { text: 'again' }),
        at('send', { text: 'a third time' }),
        { op: 'setOpenDocuments', paths: ['/docs/a.docx'] },
        at('send', { text: 'closed' }),
        {
          op: 'setOpenDocuments',
          paths: ['/docs/c.docx', '/docs/b.docx', '/docs/a.docx', '/docs/d.docx'],
        },
        at('send', { text: 'two new' }),
        at('send', { text: 'wrong owner', owner: 2 }),
        at('send', { text: 'wrong session', session: 'nope' }),
      ],
    }),
    files: PROJECT_FILES,
    note: 'messages and the documents opened since',
  },
  {
    args: scenario({
      platform: 'win32',
      openDocuments: ['C:/Docs/A.docx'],
      steps: [
        start(),
        {
          op: 'setOpenDocuments',
          paths: ['c:\\docs\\a.docx', 'C:\\Docs\\B.docx', 'c:/docs/b.docx'],
        },
        at('send', { text: 'windows' }),
      ],
    }),
    files: PROJECT_FILES,
    note: 'Windows paths are the same document in any case',
  },
  {
    args: scenario({
      openDocuments: ['/docs/a.docx'],
      steps: [
        start(),
        { op: 'setOpenDocuments', paths: ['/docs/A.docx', '/docs/a.docx'] },
        at('send', { text: 'case' }),
      ],
    }),
    files: PROJECT_FILES,
    note: 'case counts elsewhere',
  },
  {
    args: scenario({
      runner: runnerOf('claude-code', { sendError: 'broken pipe' }),
      steps: [start(), at('send', { text: 'hi' }), at('send', { text: 'hi again' })],
    }),
    files: PROJECT_FILES,
    note: 'the program refuses a message',
  },
  {
    args: scenario({
      steps: [
        start(),
        { op: 'setSettings', settings: OFF_CLAUDE },
        at('send', { text: 'too late' }),
        at('send', { text: 'gone' }),
        at('projectRootOf'),
      ],
    }),
    files: PROJECT_FILES,
    note: 'turned off since the session started',
  },
  {
    args: scenario({
      steps: [
        start(),
        {
          op: 'setStatuses',
          statuses: { ...READY, 'claude-code': { provider: 'claude-code', state: 'off' } },
        },
        at('send', { text: 'too late' }),
      ],
    }),
    files: PROJECT_FILES,
    note: 'the status says off',
  },
  {
    args: scenario({
      steps: [
        start(),
        at('answer', { request: 'req-1', answer: { allow: true } }),
        at('answer', { request: 'req-2', answer: { allow: false, message: 'no' }, owner: 2 }),
        at('answer', { request: 'req-3', answer: { allow: true, scope: 'session' } }),
        at('answer', {
          request: 'req-4',
          answer: { allow: false, message: 'no' },
          session: 'nope',
        }),
      ],
    }),
    files: PROJECT_FILES,
    note: 'answers for the program',
  },
  {
    args: scenario({
      ...ALL_DEPS,
      steps: [
        start(),
        ask(1),
        ask(2),
        ask(3),
        ask(4),
        ask(5),
        at('answer', { request: sid(2), answer: { allow: true, scope: 'session' } }),
        at('answer', { request: sid(3), answer: { allow: true } }),
        at('answer', { request: sid(4), answer: { allow: false, message: 'refused' } }),
        at('answer', { request: sid(5), answer: { allow: true, scope: 'forever' } }),
        at('answer', { request: sid(5), answer: { allow: false } }),
        { op: 'abortAsk', ask: 4 },
        { op: 'abortAsk', ask: 0 },
        ask(6, { aborted: true }),
        at('stop'),
        ask(7),
      ],
    }),
    files: PROJECT_FILES,
    note: 'the relays ask',
  },
  {
    args: scenario({
      settings: { providers: {} },
      steps: [start(), start('codex', 1, { codex: { webSearch: 'live', network: true } })],
    }),
    files: PROJECT_FILES,
    note: 'a program with no settings of its own',
  },
  {
    args: scenario({
      ...ALL_DEPS,
      openDocuments: [],
      steps: [
        start('codex'),
        {
          op: 'relayAsk',
          session: sid(1),
          request: {
            exposedName: 'mcp__github__big',
            server: 'github',
            input: { text: 'x'.repeat(3000) },
          },
        },
        {
          op: 'relayAsk',
          session: sid(1),
          request: { exposedName: 'mcp__linear__none', server: 'linear', input: {} },
        },
        at('answer', { request: sid(3), answer: { allow: false }, owner: 2 }),
        { op: 'abortAsk', ask: 1 },
        at('answer', { request: sid(3), answer: { allow: true } }),
        at('stop'),
      ],
    }),
    files: PROJECT_FILES,
    note: 'a question for Codex; an abort; a late answer',
  },
  {
    args: scenario({
      ...ALL_DEPS,
      steps: [start(), ask(1), ask(2), at('stopOwner', { owner: 1 }), ask(3)],
    }),
    files: PROJECT_FILES,
    note: 'questions waiting when the owner goes',
  },
  {
    args: scenario({
      rm: 'slow',
      steps: [start(), start('claude-code', 2), at('stop'), { op: 'stopAll' }, { op: 'finishRm' }],
    }),
    files: PROJECT_FILES,
    note: 'a removal still running when the app quits',
  },
  {
    args: scenario({
      rm: 'slow',
      steps: [start(), start('claude-code', 2), at('stop'), { op: 'finishRm' }, { op: 'stopAll' }],
    }),
    files: PROJECT_FILES,
    note: 'a removal finished before the app quits',
  },
  {
    args: scenario({
      rm: 'fail',
      rmSync: 'fail',
      steps: [start(), start('codex', 2), { op: 'stopAll' }, { op: 'stopAll' }],
    }),
    files: PROJECT_FILES,
    note: 'a folder that cannot be removed',
  },
  {
    args: scenario({
      rm: 'fail',
      steps: [start(), at('stop'), { op: 'stopAll' }],
    }),
    files: PROJECT_FILES,
    note: 'the asynchronous removal failed, the quit removes it',
  },
  {
    args: scenario({
      steps: [
        start(),
        start('codex', 1),
        start('claude-code', 2),
        { op: 'stopOwner', owner: 1 },
        { op: 'projectRootOf', owner: 2, session: sid(3) },
        { op: 'stopOwner', owner: 5 },
        { op: 'stopAll' },
      ],
    }),
    files: PROJECT_FILES,
    note: 'two owners',
  },
  {
    args: scenario({
      ...ALL_DEPS,
      steps: [
        start(),
        { op: 'event', runner: 0, event: { type: 'text', text: 'hi' } },
        at('projectRootOf'),
        { op: 'event', runner: 0, event: { type: 'ended' } },
        at('projectRootOf'),
        { op: 'event', runner: 0, event: { type: 'ended' } },
        at('send', { text: 'to nobody' }),
      ],
    }),
    files: PROJECT_FILES,
    note: 'the program ends on its own',
  },
  {
    args: scenario({
      steps: [
        start(),
        start('codex', 1),
        { op: 'event', runner: 1, event: { type: 'turn-done', ok: true } },
        { op: 'event', runner: 1, event: { type: 'error', message: 'x' } },
        at('projectRootOf'),
        { op: 'stop', owner: 1, session: sid(2) },
      ],
    }),
    files: PROJECT_FILES,
    note: 'events that leave it running',
  },
  {
    args: scenario({
      ...ALL_DEPS,
      platform: 'win32',
      steps: [start(), start('codex', 2), { op: 'stopAll' }],
    }),
    files: PROJECT_FILES,
    note: 'Windows',
  },
]
export const group: Group = {
  // ---- packages/ai-provider/src/agent-session ----
  'ai-provider/agent-session/skills.AGENT_SKILL_PLUGIN_NAME': constant(
    'the plugin name of the skill copy',
    () => sessionSkills.AGENT_SKILL_PLUGIN_NAME,
  ),
  'ai-provider/agent-session/program-problem.AgentProgramError': {
    ts: (a) => {
      const error = new programProblem.AgentProgramError(a[0] as never, a[1] as string)
      return {
        name: error.name,
        message: error.message,
        problem: error.problem,
        isError: error instanceof Error,
      }
    },
    cases: programErrorCases,
  },

  // ---- packages/agent-core/src/skill-mcp-refs ----
  'agent-core/skill-mcp-refs.SKILL_SKIPPED_STEPS_SENTENCE': constant(
    'the sentence every skill gets',
    () => refs.SKILL_SKIPPED_STEPS_SENTENCE,
  ),
  'agent-core/skill-mcp-refs.mcpServerUnusableLine': {
    ts: (a) => refs.mcpServerUnusableLine(a[0] as string),
    cases: cases(['github'], ['my server'], [''], ['a.b']),
  },
  'agent-core/skill-mcp-refs.mcpServersInText': {
    ts: (a) => refs.mcpServersInText(a[0] as string),
    cases: textCases.map((text) => ({ args: [text] })),
  },
  'agent-core/skill-mcp-refs.mcpServersInAllowedTools': {
    ts: (a) => refs.mcpServersInAllowedTools(opt(a[0] as string | string[] | null)),
    cases: allowedCases.map((value) => ({ args: [value] })),
  },
  'agent-core/skill-mcp-refs.mcpServersOfSkill': {
    ts: (a) => refs.mcpServersOfSkill(a[0] as string, opt(a[1] as string | string[] | null)),
    cases: cases(
      ['', null],
      ['calls mcp__b__x and mcp__c__y', 'mcp__a__t'],
      ['calls mcp__b__x', ['mcp__b', 'mcp__a__t']],
      ['no tools', 'Read, Write'],
      ['mcp__a__x mcp__b__y', 'mcp__b__z mcp__c'],
      ['mcp__same__x', 'mcp__same'],
    ),
  },
  'agent-core/skill-mcp-refs.unusableMcpServers': {
    ts: (a) => refs.unusableMcpServers(a[0] as string[], usableOf(a[1] as J)),
    cases: usableCases.flatMap((usable) => [
      { args: [[], usable] },
      { args: [['a', 'b', 'c'], usable] },
    ]),
  },
  'agent-core/skill-mcp-refs.skillStepsNote': {
    ts: (a) => refs.skillStepsNote(a[0] as string[], usableOf(a[1] as J)),
    cases: usableCases.flatMap((usable) => [
      { args: [[], usable] },
      { args: [['a', 'b'], usable] },
    ]),
  },
  'agent-core/skill-mcp-refs.mcpServerListOf': {
    ts: (a) => refs.mcpServerListOf(a[0]),
    cases: cases(
      [null],
      ['github'],
      [{}],
      [[]],
      [['a', 'b', 'a', '', 5, null, 'c', ['d']]],
      [[{ name: 'x' }, 'y']],
    ),
  },

  // ---- apps/shell/src/shared/agent-api ----
  'agent-api.AGENT_CHANNELS': constant('the channels', () => api.AGENT_CHANNELS),
  'agent-api.AGENT_PROVIDERS': constant('the programs', () => api.AGENT_PROVIDERS),
  'agent-api.AGENT_MODES': constant('the permission modes', () => api.AGENT_MODES),
  'agent-api.AGENT_BLOCKED_PROVIDERS': constant('none blocked', () => api.AGENT_BLOCKED_PROVIDERS),
  'agent-api.AGENT_WARNING_VERSION': constant(
    'the version of the warning',
    () => api.AGENT_WARNING_VERSION,
  ),
  'agent-api.AGENT_RECENT_LIMIT': constant('how many recent folders', () => api.AGENT_RECENT_LIMIT),
  'agent-api.DEFAULT_AGENT_PREFS': constant('the defaults', () => api.DEFAULT_AGENT_PREFS),
  'agent-api.AGENT_CODEX_WEB_SEARCH': constant(
    'the web search choices',
    () => api.AGENT_CODEX_WEB_SEARCH,
  ),
  'agent-api.DEFAULT_AGENT_PROJECT_PREFS': constant(
    'the defaults of a folder',
    () => api.DEFAULT_AGENT_PROJECT_PREFS,
  ),
  'agent-api.AGENT_RUN_ERROR_KINDS': constant('the run errors', () => api.AGENT_RUN_ERROR_KINDS),
  'agent-api.agentProjectPrefsPatch': {
    ts: (a) => api.agentProjectPrefsPatch(a[0]),
    cases: cases(
      [null],
      [{}],
      [[]],
      ['text'],
      [{ codexWebSearch: 'live' }],
      [{ codexWebSearch: 'cached', codexNetwork: true }],
      [{ codexWebSearch: 'bogus', codexNetwork: true }],
      [{ codexNetwork: 'yes' }],
      [{ codexWebSearch: 5, codexNetwork: false }],
      [{ codexNetwork: false, codexWebSearch: 'disabled', other: 1 }],
    ),
  },
  'agent-api.agentStartFailureCode': {
    ts: (a) => api.agentStartFailureCode(a[0] as never),
    cases: failures.map((failure) => ({ args: [failure] })),
  },
  'agent-api.normalizeAgentPrefs': {
    ts: (a) => api.normalizeAgentPrefs(a[0]),
    cases: prefsRaw.map((raw) => ({ args: [raw] })),
  },
  'agent-api.withRecentFolder': {
    ts: (a) => api.withRecentFolder(a[0] as never, a[1] as string),
    cases: cases(
      [folderPrefs(['/a', '/b']), '/c'],
      [folderPrefs(['/a', '/b']), '/A'],
      [folderPrefs([]), '/x'],
      [folderPrefs(['/1', '/2', '/3', '/4', '/5', '/6', '/7', '/8']), '/new'],
      [folderPrefs(['/b', '/a', '/c']), '/a'],
      [folderPrefs(['/Ünï', '/b']), '/üNï'],
    ),
  },

  // ---- apps/shell/src/main/agent/project-skills ----
  'project-skills.PROJECT_SKILLS_KEY': constant(
    'the key in app-settings',
    () => projectSkills.PROJECT_SKILLS_KEY,
  ),
  'project-skills.projectSkillsOf': {
    ts: (a) => projectSkills.projectSkillsOf(a[0] as never),
    cases: projectCases.of,
  },
  'project-skills.projectSkillsFingerprint': {
    ts: (a) => projectSkills.projectSkillsFingerprint(a[0] as never),
    cases: projectCases.fingerprint,
  },
  'project-skills.approvedFingerprint': {
    ts: (a) =>
      onPlatform(a[2] as string, () =>
        projectSkills.approvedFingerprint(a[0] as string, a[1] as string),
      ),
    cases: projectCases.approved,
  },
  'project-skills.writeProjectSkillsApproval': {
    ts: (a) =>
      onPlatform(a[3] as string, () =>
        projectSkills.writeProjectSkillsApproval(
          a[0] as string,
          a[1] as string,
          a[2] as string | null,
        ),
      ),
    cases: projectCases.write,
  },
  'project-skills.projectSkillsAllowed': {
    ts: (a) =>
      onPlatform(a[3] as string, () =>
        projectSkills.projectSkillsAllowed(a[0] as string, a[1] as string, a[2] as never),
      ),
    cases: projectCases.allowed,
  },
  'project-skills.projectSkillsView': {
    ts: (a) =>
      onPlatform(a[3] as string, () =>
        projectSkills.projectSkillsView(a[0] as string, a[1] as string, a[2] as never),
      ),
    cases: projectCases.view,
  },
  'project-skills.setProjectSkills': {
    ts: (a) =>
      onPlatform(a[4] as string, () =>
        projectSkills.setProjectSkills(
          a[0] as string,
          a[1] as string,
          a[2] as never,
          a[3] as boolean,
        ),
      ),
    cases: projectCases.set,
  },

  // ---- apps/shell/src/main/agent/agent-session-folders ----
  'agent-session-folders.makeAgentSessionFolder': {
    ts: (a, cx) => runMake(a[0], cx),
    cases: makeCases,
  },
  'agent-session-folders.sweepAgentSessionFolders': {
    ts: (a, cx) => runSweep(a[0], cx),
    cases: sweepCases,
  },

  // ---- apps/shell/src/main/agent/agent-sessions ----
  'agent-sessions.agentStartFailed': {
    ts: (a) => sessions.agentStartFailed(thrownOf(a[0])),
    cases: errorDescriptors.map((descriptor) => ({ args: [descriptor] })),
  },
  'agent-sessions.agentProtectedPaths': {
    ts: (a) => sessions.agentProtectedPaths(a[0] as string, a[1] as string),
    cases: protectedCases,
  },
  'agent-sessions.projectFolderProblem': {
    ts: (a) =>
      sessions.projectFolderProblem(
        a[0] as string,
        a[1] as string,
        a[2] as string[],
        a[3] as NodeJS.Platform,
      ),
    cases: problemCases,
  },
  'agent-sessions.relayInputPreview': {
    ts: (a) => sessions.relayInputPreview(a[0] as Record<string, unknown>),
    cases: previewCases,
  },
  'agent-sessions.codexSkillInstructions': {
    ts: (a) => sessions.codexSkillInstructions(a[0] as never),
    cases: codexSkillCases,
  },
  'agent-sessions.agentInstructions': {
    ts: (a) => {
      makeLinks(a[7] as [string, string][] | undefined)
      return patched({ platform: a[6] as string }, () =>
        sessions.agentInstructions(
          a[0] as never,
          a[1] as string,
          a[2] as string,
          a[3] as boolean,
          a[4] as never,
          a[5] as string[],
        ),
      )
    },
    cases: instructionCases,
  },
  'agent-sessions.agentInstructionsAndCuts': {
    ts: (a) => {
      makeLinks(a[7] as [string, string][] | undefined)
      return patched({ platform: a[6] as string }, () =>
        sessions.agentInstructionsAndCuts(
          a[0] as never,
          a[1] as string,
          a[2] as string,
          a[3] as boolean,
          a[4] as never,
          a[5] as string[],
        ),
      )
    },
    cases: instructionCases,
  },
  'agent-sessions.openableProjectFile': {
    ts: (a) =>
      sessions.openableProjectFile(a[0] as string, a[1] as string, a[2] as NodeJS.Platform),
    cases: openableCases,
  },
  'agent-sessions.createAgentManager': {
    ts: (a, cx) => runManager(a[0], cx),
    cases: managerCases,
  },
}
