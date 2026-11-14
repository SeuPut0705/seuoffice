/**
 * Group `b2-cli`: `packages/cli/src/agent-skills.ts` (named `agent-skills.<export>`)
 * and `packages/cli/src/install.ts` (named `install.<export>`).
 *
 * - The environment, the home folder and the PowerShell run are arguments: the
 *   `env` is a plain object, the home is `$DIR/home`, and the PowerShell of the
 *   Windows PATH edit is a fake that logs `powershell` with the script and
 *   answers `{ ok, stdout }`. `existsSync` of the Homebrew probes is a list of
 *   the paths that exist.
 * - A ledger crosses as a list of `[path, entry]` pairs (a path holds `$DIR`,
 *   which a key of an object would not get), in the order of the object.
 *   `installSkill` and `uninstallSkill` change it in place, so they answer
 *   `{ value | error, ledger }`; the ledger after a failure is what the
 *   failure left. The clock of `installSkill` is the case's clock.
 * - A skill is `{ text }` or `{ hex }` (bytes that are not UTF-8).
 * - `links` of a case is a list of `[link, target]` pairs made before the call
 *   (the file list of a case holds no symlinks). A link left in the folder
 *   would stop the folder snapshot where its target is gone, so the link
 *   functions answer `links`, what each link of the case and each candidate's
 *   `seuoffice` was after the call (`file`, `-> target` or nothing), and remove
 *   the links.
 * - `buildSkillZip` answers the entries of the zip it wrote, read back by
 *   JSZip: the two writers deflate differently, so the bytes are not compared.
 */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import * as agent from '../../../packages/cli/src/agent-skills.ts'
import * as install from '../../../packages/cli/src/install.ts'
import type { Case, Group, TsContext } from '../types.ts'

const HOME = '$DIR/home'
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const AT = '2026-01-01T00:00:00.000Z'

type Env = Record<string, string>
const env = (value: unknown): NodeJS.ProcessEnv => value as NodeJS.ProcessEnv

// ---------------------------------------------------------------------------
// what a case sets up and reads back
// ---------------------------------------------------------------------------

function makeLinks(links: unknown): void {
  for (const [link, target] of (links ?? []) as [string, string][]) {
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link)
  }
}

/** what is at each path now, and the links removed so the folder can be read */
function observe(paths: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const path of paths) {
    let st
    try {
      st = lstatSync(path)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) {
      out[path] = `-> ${readlinkSync(path)}`
      unlinkSync(path)
    } else out[path] = st.isDirectory() ? 'dir' : 'file'
  }
  return out
}

function attempt(run: () => unknown): Record<string, unknown> {
  try {
    return { value: run() }
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown }
    return { error: { code: typeof e.code === 'string' ? e.code : null, message: e.message } }
  }
}

/** `new Date()` of the call reads the case's clock */
function withClock<T>(ms: number, run: () => T): T {
  const Real = Date
  class Clock extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(ms)
      else super(...(args as [number]))
    }
    static now(): number {
      return ms
    }
  }
  globalThis.Date = Clock as unknown as DateConstructor
  try {
    return run()
  } finally {
    globalThis.Date = Real
  }
}

type Ledger = [string, unknown][]
const ledgerOf = (pairs: unknown): agent.SkillLedger =>
  Object.fromEntries(pairs as Ledger) as agent.SkillLedger

type Bytes = { text?: string; hex?: string }
const bytesOf = (b: unknown): Buffer => {
  const spec = b as Bytes
  return spec.hex !== undefined
    ? Buffer.from(spec.hex, 'hex')
    : Buffer.from(spec.text ?? '', 'utf-8')
}

// ---------------------------------------------------------------------------
// skills and ledgers to build cases from
// ---------------------------------------------------------------------------

const skill = (version: string | null, name = 'seuoffice'): string =>
  [
    '---',
    `name: ${name}`,
    'description: Edit documents',
    ...(version === null ? [] : ['metadata:', `  version: '${version}'`]),
    '---',
    '# Body',
    '',
  ].join('\n')

const entry = (text: string, version = '1.0.0', channel = 'app'): unknown => ({
  version,
  sha256: sha(text),
  at: AT,
  channel,
})

const S = '$DIR/s'
const file = (name = 'seuoffice'): string => `${S}/${name}/SKILL.md`
const rel = (name = 'seuoffice'): string => `s/${name}/SKILL.md`
const BUNDLED = skill('2.0.0')

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))

// ---------------------------------------------------------------------------
// agent-skills: the table
// ---------------------------------------------------------------------------

const IDS = [
  'claude-code',
  'agents',
  'codex',
  'cursor',
  'gemini',
  'copilot',
  'opencode',
  'dsh',
  'windsurf',
  'nope',
]

const tableCases = (envs: Env[] = [{}]): Case[] =>
  IDS.flatMap((id) => envs.map((e): Case => ({ args: [id, e, HOME] })))

const OVERRIDES: Env = {
  CLAUDE_CONFIG_DIR: '$DIR/claude-cfg',
  CODEX_HOME: '$DIR/codex-home',
  XDG_CONFIG_HOME: '$DIR/xdg',
  DSH_HOME: '$DIR/dsh-home',
}
const EMPTY_OVERRIDES: Env = {
  CLAUDE_CONFIG_DIR: '',
  CODEX_HOME: '',
  XDG_CONFIG_HOME: '',
  DSH_HOME: '',
}

const dirs = (...names: string[]): Case['files'] =>
  Object.fromEntries(names.map((n) => [n, { dir: true as const }]))

const presentCases: Case[] = [
  { args: ['claude-code', {}, HOME], files: dirs('home/.claude'), note: 'the default folder' },
  { args: ['claude-code', {}, HOME], note: 'nothing there' },
  {
    args: ['claude-code', { CLAUDE_CONFIG_DIR: '$DIR/cfg' }, HOME],
    files: dirs('cfg'),
    note: 'an override that exists',
  },
  {
    args: ['claude-code', { CLAUDE_CONFIG_DIR: '$DIR/cfg' }, HOME],
    files: dirs('home/.claude'),
    note: 'an override that does not exist: the default is not tried',
  },
  {
    args: ['claude-code', { CLAUDE_CONFIG_DIR: '' }, HOME],
    files: dirs('home/.claude'),
    note: 'an empty override is no override',
  },
  {
    args: ['agents', {}, HOME],
    files: dirs('home/.cursor'),
    note: 'the shared row counts a reader that is present',
  },
  { args: ['agents', {}, HOME], files: dirs('home/.agents'), note: 'the shared folder itself' },
  { args: ['agents', {}, HOME], files: dirs('home/.claude'), note: 'a tool with its own row' },
  { args: ['agents', {}, HOME], note: 'nothing' },
  {
    args: ['agents', { CODEX_HOME: '$DIR/cx' }, HOME],
    files: dirs('cx'),
    note: 'a reader found through its override',
  },
  { args: ['codex', {}, HOME], files: dirs('home/.agents'), note: 'a reader needs its own folder' },
  { args: ['cursor', {}, HOME], files: dirs('home/.cursor') },
  { args: ['gemini', {}, HOME], files: dirs('home/.gemini') },
  { args: ['copilot', {}, HOME], files: dirs('home/.copilot') },
  {
    args: ['opencode', { XDG_CONFIG_HOME: '$DIR/xdg' }, HOME],
    files: dirs('xdg/opencode'),
    note: 'XDG_CONFIG_HOME moves the folder',
  },
  { args: ['opencode', {}, HOME], files: dirs('home/.config/opencode') },
  { args: ['dsh', { DSH_HOME: '$DIR/d' }, HOME], files: dirs('d') },
  { args: ['dsh', {}, HOME], files: dirs('home/.dsh') },
  { args: ['windsurf', {}, HOME], files: dirs('home/.codeium/windsurf') },
  {
    args: ['windsurf', {}, HOME],
    files: { 'home/.codeium/windsurf': 'a file, not a folder' },
    note: 'a file is not a folder',
  },
  { args: ['nope', {}, HOME], files: dirs('home/.claude'), note: 'an id that is not in the table' },
]

const detectCases: Case[] = [
  { args: [{}, HOME], note: 'an empty home' },
  {
    args: [{}, HOME],
    files: dirs('home/.claude', 'home/.agents', 'home/.codeium/windsurf'),
    note: 'every row there is',
  },
  {
    args: [{}, HOME],
    files: dirs('home/.gemini'),
    note: 'a reader gives the shared row, never its own',
  },
  { args: [{}, HOME], files: dirs('home/.windsurf'), note: 'the wrong folder' },
  {
    args: [OVERRIDES, HOME],
    files: dirs('claude-cfg', 'codex-home'),
    note: 'overrides move the folders',
  },
  {
    args: [EMPTY_OVERRIDES, HOME],
    files: dirs('home/.claude'),
    note: 'empty overrides are none',
  },
]

const legacyLedger = (...names: string[]): Ledger =>
  names.map((n) => [`$DIR/home/${n}/skills/seuoffice/SKILL.md`, entry(BUNDLED)])

const legacyFiles = (...names: string[]): Case['files'] =>
  Object.fromEntries(names.map((n) => [`home/${n}/skills/seuoffice/SKILL.md`, BUNDLED]))

const legacyCases: Case[] = [
  { args: [[], {}, HOME, null], note: 'an empty ledger' },
  {
    args: [legacyLedger('.codex'), {}, HOME, null],
    files: legacyFiles('.codex'),
    note: 'a copy this app wrote, still there',
  },
  {
    args: [legacyLedger('.codex'), {}, HOME, null],
    note: 'the ledger remembers a copy whose folder is gone',
  },
  {
    args: [[], {}, HOME, null],
    files: legacyFiles('.codex'),
    note: 'a copy nobody remembers',
  },
  {
    args: [legacyLedger('.codex', '.cursor', '.gemini'), {}, HOME, 'agents'],
    files: legacyFiles('.codex', '.cursor', '.gemini'),
    note: 'the shared id lists every reader',
  },
  {
    args: [legacyLedger('.codex', '.cursor'), {}, HOME, 'cursor'],
    files: legacyFiles('.codex', '.cursor'),
    note: 'a reader id lists its own copy',
  },
  {
    args: [legacyLedger('.codex'), {}, HOME, 'claude-code'],
    files: legacyFiles('.codex'),
    note: 'a row of its own has none',
  },
  {
    args: [legacyLedger('.codex'), {}, HOME, 'nope'],
    files: legacyFiles('.codex'),
    note: 'an id outside the table has none',
  },
  {
    args: [[[`$DIR/home/.codex/skills/ieumoffice/SKILL.md`, entry(BUNDLED)]], {}, HOME, 'codex'],
    files: { 'home/.codex/skills/ieumoffice/SKILL.md': BUNDLED },
    note: 'a copy under the earlier name',
  },
  {
    args: [legacyLedger('.codex', '.dsh'), OVERRIDES, HOME, null],
    files: { 'codex-home/skills/seuoffice/SKILL.md': BUNDLED, 'dsh-home/skills/x': '' },
    note: 'overrides move the folders the copies are looked for in',
  },
  {
    args: [
      [
        ['$DIR/codex-home/skills/seuoffice/SKILL.md', entry(BUNDLED)],
        ['$DIR/dsh-home/skills/seuoffice/SKILL.md', entry(BUNDLED)],
      ],
      OVERRIDES,
      HOME,
      null,
    ],
    files: {
      'codex-home/skills/seuoffice/SKILL.md': BUNDLED,
      'dsh-home/skills/seuoffice/SKILL.md': BUNDLED,
    },
    note: 'two readers moved by their overrides',
  },
  {
    args: [[['$DIR/home/.codex/skills/seuoffice/SKILL.md', null]], {}, HOME, null],
    files: legacyFiles('.codex'),
    note: 'a ledger entry that is not true is no record',
  },
  {
    args: [[['$DIR/home/.codex/skills/seuoffice/SKILL.md', 'yes']], {}, HOME, null],
    files: legacyFiles('.codex'),
    note: 'any true entry is a record',
  },
  {
    args: [[['$DIR/home/.claude/skills/seuoffice/SKILL.md', entry(BUNDLED)]], {}, HOME, null],
    files: legacyFiles('.claude'),
    note: 'a row of its own is no legacy copy, whatever the ledger says',
  },
]

const rowsCases: Case[] = [
  { args: [[], {}, HOME], note: 'nothing' },
  {
    args: [legacyLedger('.codex'), {}, HOME],
    files: { ...dirs('home/.agents', 'home/.claude'), ...legacyFiles('.codex') },
    note: 'install rows first in table order, then the legacy copy in its place',
  },
  {
    args: [legacyLedger('.gemini', '.codex'), {}, HOME],
    files: { ...dirs('home/.codeium/windsurf'), ...legacyFiles('.codex', '.gemini') },
    note: 'legacy copies in table order, windsurf last',
  },
  {
    args: [legacyLedger('.cursor'), {}, HOME],
    files: legacyFiles('.cursor'),
    note: 'a legacy copy with the folder of its reader present: the shared row too',
  },
  {
    args: [[], OVERRIDES, HOME],
    files: dirs('claude-cfg', 'xdg/opencode'),
    note: 'overrides',
  },
]

// ---------------------------------------------------------------------------
// agent-skills: the front matter, hashes and versions
// ---------------------------------------------------------------------------

const FM = [
  skill('1.2.3'),
  skill('1.2.3').replace(/\n/g, '\r\n'),
  skill(null),
  skill('1.2'),
  skill('1.2.3', 'ieumoffice'),
  skill('10.20.30', 'something-else'),
  '# no front matter\n',
  '',
  '---\nname: a b\n---\n',
  '---\nname:\n---\n',
  '---\nname: seuoffice',
  '---\nname: seuoffice\nmetadata:\n  version: "3.4.5"\n---\nbody',
  '---\nname: seuoffice\nmetadata:\n  version: 3.4.5\n---\n',
  '---\nname: seuoffice\nversion: 3.4.5\n---\n',
  '---\nname: seuoffice\nmetadata:\n    version: 3.4.5   \n---\n',
  '---\nname:   seuoffice   \n---\n',
  '\uFEFF---\nname: seuoffice\n---\n',
  '\n---\nname: seuoffice\n---\n',
  '---\r\nname: seuoffice\r\nmetadata:\r\n  version: 1.0.0\r\n---\r\n',
  '---\nname: 서울\nmetadata:\n  version: 0.0.1\n---\n',
  '---\n---\nname: seuoffice\n',
  '---\nmetadata:\n  version: 1.0.0\nname: seuoffice\n---\n',
  '---\nname: seuoffice\nname: other\n---\n',
  '---\nname: seuoffice\nmetadata:\n  version: 1.0.0\n  version: 2.0.0\n---\n',
]

const COMPARE: [string, string][] = [
  ['1.0.0', '1.0.0'],
  ['1.0.0', '2.0.0'],
  ['2.0.0', '1.0.0'],
  ['1.2.0', '1.10.0'],
  ['10.0.0', '9.0.0'],
  ['1.0.1', '1.0.0'],
  ['1.0.0', '1.0.1'],
  ['x', '1.0.0'],
  ['1.0.0', 'x'],
  ['x', 'y'],
  ['', ''],
  [' 1.2.3 ', '1.2.3'],
  ['1.2.3-beta', '1.2.3'],
  ['1.2', '1.2.0'],
  ['1.2.99999999999999999999', '1.2.3'],
  ['01.2.3', '1.2.3'],
  ['\uFEFF1.2.3', '1.2.3'],
  ['x', '0.0.0'],
  ['0.0.0', 'x'],
]

// ---------------------------------------------------------------------------
// agent-skills: the state of a folder
// ---------------------------------------------------------------------------

const oldText = skill('1.0.0')
const NEWER = skill('3.0.0')
const stateCase = (
  files: Case['files'],
  ledger: Ledger = [],
  note = '',
  bundled: Bytes = { text: BUNDLED },
): Case => ({ args: [S, bundled, ledger], files, note })

const stateCases: Case[] = [
  stateCase({}, [], 'no folder'),
  stateCase({ [rel()]: BUNDLED }, [[file(), entry(BUNDLED, '2.0.0')]], 'written here, current'),
  stateCase({ [rel()]: oldText }, [[file(), entry(oldText)]], 'written here, older'),
  stateCase({ [rel()]: BUNDLED + 'edit' }, [[file(), entry(BUNDLED, '2.0.0')]], 'edited since'),
  stateCase({ [rel()]: oldText + 'edit' }, [[file(), entry(oldText)]], 'edited since, and older'),
  stateCase({ [rel()]: BUNDLED }, [], 'ours, nobody recorded it'),
  stateCase({ [rel()]: oldText }, [], 'ours, older, nobody recorded it'),
  stateCase({ [rel()]: NEWER }, [[file(), entry(NEWER, '3.0.0')]], 'newer, written here'),
  stateCase({ [rel()]: NEWER }, [], 'newer, foreign'),
  stateCase({ [rel('seuoffice')]: '# not a skill' }, [], 'a folder with other content'),
  stateCase({ 's/seuoffice/other.txt': 'x' }, [], 'a folder without SKILL.md'),
  stateCase({ [rel()]: { dir: true } }, [], 'SKILL.md is a folder'),
  stateCase({ [rel()]: skill('2.0.0', 'else') }, [], 'a skill of another name'),
  stateCase({ [rel()]: skill(null) }, [[file(), entry(skill(null), '')]], 'no version at all'),
  stateCase({ [rel()]: skill(null) }, [], 'no version, nobody recorded it: older, foreign'),
  stateCase({ [rel()]: BUNDLED }, [[file(), 'yes']], 'a record that is no entry: modified'),
  stateCase({ [rel()]: BUNDLED }, [[file(), null]], 'a null record is none'),
  stateCase(
    { [rel()]: BUNDLED },
    [[file(), { version: '2.0.0' }]],
    'a record without a hash: modified',
  ),
  stateCase(
    { [rel()]: BUNDLED },
    [[file(), { version: '2.0.0', sha256: 5 }]],
    'a hash that is not text: modified',
  ),
  stateCase(
    { [rel('ieumoffice')]: skill('2.0.0', 'ieumoffice') },
    [[file('ieumoffice'), entry(skill('2.0.0', 'ieumoffice'), '2.0.0')]],
    'only the earlier name is there, current: outdated and older',
  ),
  stateCase(
    { [rel('ieumoffice')]: skill('1.0.0', 'ieumoffice') },
    [[file('ieumoffice'), entry(skill('1.0.0', 'ieumoffice'))]],
    'only the earlier name, older: outdated',
  ),
  stateCase(
    { [rel('ieumoffice')]: skill('1.0.0', 'ieumoffice') },
    [],
    'only the earlier name, foreign: foreign and older',
  ),
  stateCase(
    { [rel('ieumoffice')]: skill('1.0.0', 'ieumoffice') + 'edit' },
    [[file('ieumoffice'), entry(skill('1.0.0', 'ieumoffice'))]],
    'only the earlier name, edited: modified and older',
  ),
  stateCase(
    { [rel('ieumoffice')]: skill('9.0.0', 'ieumoffice') },
    [],
    'only the earlier name, newer: as it is',
  ),
  stateCase(
    { [rel('ieumoffice')]: '# not a skill' },
    [],
    'the earlier name holds something else: missing',
  ),
  stateCase(
    { [rel('ieumoffice')]: skill('1.0.0', 'seuoffice') },
    [],
    'the earlier folder holds a skill named as the current one',
  ),
  stateCase(
    { [rel()]: BUNDLED, [rel('ieumoffice')]: skill('1.0.0', 'ieumoffice') },
    [[file(), entry(BUNDLED, '2.0.0')]],
    'the current folder decides',
  ),
  stateCase(
    { [rel()]: '# not ours', [rel('ieumoffice')]: skill('1.0.0', 'ieumoffice') },
    [],
    'the current folder is occupied: the earlier one is not looked at',
  ),
  stateCase(
    { [rel()]: BUNDLED },
    [[file(), entry(BUNDLED, '2.0.0')]],
    'bytes that are not UTF-8 in the bundled skill',
    { hex: Buffer.from(BUNDLED).toString('hex') + 'ff' },
  ),
  stateCase(
    { [rel()]: skill('2.0.0') },
    [[file(), entry(skill('2.0.0'), '2.0.0')]],
    'a bundled skill without a version reads 0.0.0: the installed one is newer',
    { text: '# no front matter' },
  ),
]

// ---------------------------------------------------------------------------
// agent-skills: install and uninstall
// ---------------------------------------------------------------------------

type Links = [string, string][]
const installCase = (
  files: Case['files'],
  ledger: Ledger = [],
  note = '',
  channel: string | null = null,
  links: Links = [],
  skills = S,
  bundled: Bytes = { text: BUNDLED },
): Case => ({ args: [skills, bundled, ledger, channel, links], files, note })

const installCases: Case[] = [
  installCase({}, [], 'no folder yet: made, written, remembered'),
  installCase({ [rel()]: oldText }, [[file(), entry(oldText)]], 'an older copy is replaced'),
  installCase({}, [], 'the zip channel', 'zip'),
  installCase({}, [['$DIR/other/seuoffice/SKILL.md', entry(oldText)]], 'other entries stay first'),
  installCase(
    { [rel('ieumoffice')]: skill('1.0.0', 'ieumoffice') },
    [[file('ieumoffice'), entry(skill('1.0.0', 'ieumoffice'))]],
    'an earlier copy nobody changed goes with its folder',
  ),
  installCase(
    { [rel('ieumoffice')]: skill('1.0.0', 'ieumoffice') + 'edit' },
    [[file('ieumoffice'), entry(skill('1.0.0', 'ieumoffice'))]],
    'an earlier copy somebody changed stays',
  ),
  installCase(
    { [rel('ieumoffice')]: skill('1.0.0', 'ieumoffice'), 's/ieumoffice/notes.txt': 'mine' },
    [[file('ieumoffice'), entry(skill('1.0.0', 'ieumoffice'))]],
    'an earlier copy goes, its folder stays because it holds another file',
  ),
  installCase(
    { [rel('ieumoffice')]: skill('1.0.0', 'ieumoffice') },
    [],
    'an earlier copy this app did not write is never touched',
  ),
  installCase({}, [[file('ieumoffice'), entry(oldText)]], 'a remembered earlier copy that is gone'),
  installCase({ 'elsewhere.md': 'somebody else' }, [], 'SKILL.md is a symlink: refused', null, [
    [file(), '$DIR/elsewhere.md'],
  ]),
  installCase({ 's/seuoffice': 'a file in the way' }, [], 'the folder is a file'),
  installCase({ [rel()]: { dir: true } }, [], 'SKILL.md is a folder'),
  installCase({ s: { dir: true, mode: 0o555 } }, [], 'the skills folder cannot be written'),
  installCase(
    {
      [rel('ieumoffice')]: skill('1.0.0', 'ieumoffice'),
      's/ieumoffice': { dir: true, mode: 0o555 },
    },
    [[file('ieumoffice'), entry(skill('1.0.0', 'ieumoffice'))]],
    'the earlier copy cannot be removed: the ledger already holds the new one',
  ),
  installCase(
    { 'real.md': skill('1.0.0', 'ieumoffice') },
    [[file('ieumoffice'), entry(skill('1.0.0', 'ieumoffice'))]],
    'an earlier copy that is a symlink is not removed',
    null,
    [[file('ieumoffice'), '$DIR/real.md']],
  ),
  installCase({}, [], 'unicode and spaces in the folder', null, [], '$DIR/스킬 폴더'),
  installCase({}, [], 'bytes that are not UTF-8', null, [], S, { hex: '2d2d2dff0a' }),
  installCase({}, [['$DIR/x', 'a record of something else']], 'a ledger of strange entries'),
]

const uninstallCase = (files: Case['files'], ledger: Ledger = [], note = ''): Case => ({
  args: [S, ledger],
  files,
  note,
})

const uninstallCases: Case[] = [
  uninstallCase({}, [], 'nothing written here'),
  uninstallCase({ [rel()]: BUNDLED }, [], 'a copy nobody remembers stays'),
  uninstallCase(
    { [rel()]: BUNDLED },
    [[file(), entry(BUNDLED, '2.0.0')]],
    'removed with its folder',
  ),
  uninstallCase(
    { [rel()]: BUNDLED, 's/seuoffice/notes.txt': 'mine' },
    [[file(), entry(BUNDLED, '2.0.0')]],
    'the folder stays because it holds another file',
  ),
  uninstallCase(
    { [rel()]: BUNDLED, [rel('ieumoffice')]: skill('1.0.0', 'ieumoffice') },
    [
      [file(), entry(BUNDLED, '2.0.0')],
      [file('ieumoffice'), entry(skill('1.0.0', 'ieumoffice'))],
      ['$DIR/keep/seuoffice/SKILL.md', entry(BUNDLED)],
    ],
    'the current and the earlier copy; another ledger entry stays',
  ),
  uninstallCase({}, [[file(), entry(BUNDLED)]], 'remembered, but already gone'),
  uninstallCase(
    { [rel()]: { dir: true } },
    [[file(), entry(BUNDLED)]],
    'SKILL.md is a folder: the removal throws',
  ),
  uninstallCase(
    { 's/seuoffice': 'a file where the folder was' },
    [[file(), entry(BUNDLED)]],
    'the folder is a file: not a directory',
  ),
  uninstallCase(
    { [rel()]: BUNDLED, 's/seuoffice': { dir: true, mode: 0o555 } },
    [[file(), entry(BUNDLED)]],
    'the folder cannot be written: the removal throws',
  ),
  uninstallCase(
    { [rel()]: BUNDLED, [rel('ieumoffice')]: skill('1.0.0', 'ieumoffice') },
    [
      [file('ieumoffice'), entry(skill('1.0.0', 'ieumoffice'))],
      [file(), entry(BUNDLED)],
    ],
    'the ledger order does not matter: the current name goes first',
  ),
]

const ZIPS: Bytes[] = [
  { text: BUNDLED },
  { text: '' },
  { text: '한글 skill\n'.repeat(50) },
  { hex: 'ff00fe' },
]

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

const BIN = '$DIR/bin'
const LAUNCHER = '$DIR/app/cli/seuoffice'

interface LinkOptions {
  launcher: string
  platform: string
  candidateDirs?: string[]
  env: Env
  ps?: { ok: boolean; stdout: string }
  links?: Links
}

const launcherFiles: Case['files'] = {
  'app/cli/seuoffice': '#!/bin/sh\n',
  'app/cli/seuoffice.cjs': '',
}

function linkCase(o: Partial<LinkOptions>, files: Case['files'] = launcherFiles, note = ''): Case {
  const options: LinkOptions = {
    launcher: LAUNCHER,
    platform: 'darwin',
    candidateDirs: [BIN],
    env: {},
    ...o,
  }
  return { args: [options], files: { ...launcherFiles, ...files }, note }
}

/** the link functions: the answer, then what each link was and the links removed */
function linkRun(
  a: unknown[],
  cx: TsContext,
  run: (opts: install.InstallOptions) => install.InstallOutcome,
): unknown {
  const o = a[0] as LinkOptions
  makeLinks(o.links)
  const opts: install.InstallOptions = {
    launcher: o.launcher,
    platform: o.platform as NodeJS.Platform,
    env: env(o.env),
    runPowerShell: (script) => {
      cx.log('powershell', script)
      return o.ps ?? { ok: false, stdout: '' }
    },
  }
  if (o.candidateDirs) opts.candidateDirs = o.candidateDirs
  const out = attempt(() => run(opts))
  const paths = [
    ...(o.links ?? []).map(([link]) => link),
    ...(o.candidateDirs ?? []).map((dir) => join(dir, 'seuoffice')),
  ]
  return { ...out, links: observe(paths) }
}

const linkCases = (): Case[] => [
  linkCase({}, { bin: { dir: true } }, 'a writable folder: linked'),
  linkCase({ links: [[`${BIN}/seuoffice`, LAUNCHER]] }, { bin: { dir: true } }, 'already linked'),
  linkCase(
    { links: [[`${BIN}/seuoffice`, '$DIR/old/cli/seuoffice']] },
    { bin: { dir: true }, 'old/cli/seuoffice': '', 'old/cli/seuoffice.cjs': '' },
    'a link to another install of the app: replaced',
  ),
  linkCase(
    { links: [[`${BIN}/seuoffice`, '../app/cli/seuoffice']] },
    { bin: { dir: true } },
    'a relative link to our launcher: ours, relinked as an absolute one',
  ),
  linkCase(
    { links: [[`${BIN}/seuoffice`, '$DIR/old/cli/ieumoffice']] },
    { bin: { dir: true }, 'old/cli/ieumoffice': '', 'old/cli/genoffice.cjs': '' },
    'a link under the earlier command name with the earlier bundle: ours',
  ),
  linkCase(
    { links: [[`${BIN}/seuoffice`, '$DIR/old/cli/seuoffice']] },
    { bin: { dir: true }, 'old/cli/seuoffice': '', 'old/cli/seuoffice.cmd': '' },
    'a launcher with a Windows twin beside it: ours',
  ),
  linkCase(
    { links: [[`${BIN}/seuoffice`, '$DIR/old/cli/seuoffice']] },
    { bin: { dir: true }, 'old/cli/seuoffice': '' },
    'a launcher with nothing of ours beside it: foreign',
  ),
  linkCase(
    { links: [[`${BIN}/seuoffice`, '$DIR/old/cli/genoffice']] },
    { bin: { dir: true }, 'old/cli/genoffice': '', 'old/cli/seuoffice.cjs': '' },
    'the upstream launcher is never ours',
  ),
  linkCase(
    { links: [[`${BIN}/seuoffice`, '$DIR/gone']] },
    { bin: { dir: true } },
    'a dangling link: replaced',
  ),
  linkCase({}, { 'bin/seuoffice': 'a file' }, 'a regular file: occupied'),
  linkCase(
    { candidateDirs: [BIN, '$DIR/bin2'] },
    { 'bin/seuoffice': 'a file', bin2: { dir: true } },
    'an occupied name is skipped: the next folder takes the link',
  ),
  linkCase(
    { candidateDirs: [BIN, '$DIR/bin2'], links: [[`${BIN}/seuoffice`, '$DIR/old/cli/seuoffice']] },
    { 'old/cli/seuoffice': '', bin: { dir: true }, 'bin2/x': '' },
    'a foreign link is skipped too',
  ),
  linkCase(
    { candidateDirs: [BIN, '$DIR/bin2'] },
    { 'bin/seuoffice': 'a file', 'bin2/seuoffice': 'another' },
    'two occupied names: the first is reported',
  ),
  linkCase({}, { bin: { dir: true, mode: 0o555 } }, 'a folder that cannot be written'),
  linkCase({}, {}, 'a folder that is not there is not made'),
  linkCase({ candidateDirs: [] }, {}, 'no folder to try: /usr/local/bin is named'),
  linkCase(
    { candidateDirs: ['$DIR/home/.local/bin'], env: { HOME: '$DIR/home', PATH: '/usr/bin' } },
    { home: { dir: true } },
    'a per-user folder is made, and the shell is told',
  ),
  linkCase(
    {
      candidateDirs: ['$DIR/home/.local/bin'],
      env: { HOME: '$DIR/home', PATH: '/usr/bin:$DIR/home/.local/bin/' },
    },
    { home: { dir: true } },
    'a per-user folder already on the PATH: no hint',
  ),
  linkCase(
    {
      candidateDirs: ['$DIR/xdg'],
      env: { XDG_BIN_HOME: '$DIR/xdg', HOME: '$DIR/home', PATH: '' },
    },
    { xdg: { dir: true } },
    'XDG_BIN_HOME: the hint names the path as it is',
  ),
  linkCase(
    {
      candidateDirs: ['$DIR/home/.local/bin'],
      env: { HOME: '$DIR/home', PATH: '/usr/bin' },
    },
    { 'home/.local': 'a file in the way' },
    'a per-user folder that cannot be made',
  ),
  linkCase(
    { candidateDirs: [BIN], env: { HOME: '$DIR/home', PATH: '/usr/bin' } },
    { bin: { dir: true } },
    'a system folder gets no hint',
  ),
  linkCase({ platform: 'linux' }, { bin: { dir: true } }, 'linux works like macOS'),
  linkCase({ platform: 'freebsd' }, {}, 'a platform without a way'),
  linkCase(
    { platform: 'win32', launcher: 'C:\\Program Files\\SeuOffice\\resources\\cli\\seuoffice.cmd' },
    {},
    'windows: the script is run, the answer is not ok',
  ),
  linkCase(
    {
      platform: 'win32',
      launcher: "C:\\Users\\it's me\\cli\\seuoffice.cmd",
      ps: { ok: true, stdout: 'linked\r\n' },
    },
    {},
    'windows: linked, a quote in the folder is doubled',
  ),
  linkCase(
    {
      platform: 'win32',
      launcher: 'D:\\cli\\seuoffice.cmd',
      ps: { ok: true, stdout: ' present \n' },
    },
    {},
    'windows: present',
  ),
  linkCase(
    {
      platform: 'win32',
      launcher: 'D:\\cli\\seuoffice.cmd',
      ps: { ok: true, stdout: '' },
    },
    {},
    'windows: any other output is linked (or missing)',
  ),
  linkCase(
    { launcher: '$DIR/앱 폴더/cli/seuoffice' },
    { bin: { dir: true }, '앱 폴더/cli/seuoffice': '' },
    'a unicode launcher path with a space',
  ),
  linkCase(
    { links: [[`${BIN}/seuoffice`, '../old/cli/seuoffice']] },
    { bin: { dir: true }, 'old/cli/seuoffice': '' },
    'a relative link to a foreign launcher is read against its own folder: occupied',
  ),
]

const ourCases: Case[] = [
  { args: [LAUNCHER, LAUNCHER, []], files: launcherFiles, note: 'the launcher itself' },
  { args: ['$DIR/none', LAUNCHER, []], files: launcherFiles, note: 'a target that is not there' },
  {
    args: ['$DIR/old/cli/seuoffice', LAUNCHER, []],
    files: { ...launcherFiles, 'old/cli/seuoffice': '', 'old/cli/seuoffice.cjs': '' },
    note: 'another install with the bundle',
  },
  {
    args: ['$DIR/old/cli/seuoffice', LAUNCHER, []],
    files: { ...launcherFiles, 'old/cli/seuoffice': '' },
    note: 'another install without',
  },
  {
    args: ['$DIR/old/cli/seuoffice', LAUNCHER, []],
    files: { ...launcherFiles, 'old/cli/seuoffice': '', 'old/cli/ieumoffice.cmd': '' },
    note: 'a Windows twin under the earlier name',
  },
  {
    args: ['$DIR/old/cli/ieumoffice', LAUNCHER, []],
    files: { 'old/cli/ieumoffice': '', 'old/cli/genoffice.cjs': '' },
    note: 'the earlier name, the launcher itself is not there',
  },
  {
    args: ['$DIR/old/cli/genoffice', LAUNCHER, []],
    files: { ...launcherFiles, 'old/cli/genoffice': '', 'old/cli/seuoffice.cjs': '' },
    note: 'an upstream launcher',
  },
  {
    args: ['$DIR/link', LAUNCHER, [['$DIR/link', LAUNCHER]]],
    files: launcherFiles,
    note: 'a link to the launcher resolves to it',
  },
  {
    args: ['$DIR/link', '$DIR/missing-launcher', [['$DIR/link', LAUNCHER]]],
    files: launcherFiles,
    note: 'the launcher to compare is not there: the name decides',
  },
  {
    args: ['$DIR/custom/launcher', '$DIR/custom/launcher', []],
    files: { 'custom/launcher': '' },
    note: 'the launcher itself under a name that is not ours',
  },
  {
    args: ['$DIR/custom/launcher', '$DIR/custom/other', []],
    files: { 'custom/launcher': '', 'custom/other': '' },
    note: 'another file under a name that is not ours',
  },
]

// ---------------------------------------------------------------------------
// the spec
// ---------------------------------------------------------------------------

const spec: Group = {
  // ---- agent-skills: the table ----
  'agent-skills.agentIds': {
    ts: () => agent.agentIds(),
    cases: cases([]),
    single: 'a constant: the table of agents',
  },
  'agent-skills.skillTargetIds': {
    ts: () => agent.skillTargetIds(),
    cases: cases([]),
    single: 'a constant: the table of agents without its readers',
  },
  'agent-skills.isSharedReader': {
    ts: (a) => agent.isSharedReader(a[0] as agent.AgentId),
    cases: IDS.map((id): Case => ({ args: [id] })),
  },
  'agent-skills.installRowFor': {
    ts: (a) => agent.installRowFor(a[0] as agent.AgentId),
    cases: IDS.map((id): Case => ({ args: [id] })),
  },
  'agent-skills.agentLabel': {
    ts: (a) => agent.agentLabel(a[0] as agent.AgentId),
    cases: IDS.map((id): Case => ({ args: [id] })),
  },
  'agent-skills.agentPresent': {
    ts: (a) => agent.agentPresent(a[0] as agent.AgentId, env(a[1]), a[2] as string),
    cases: presentCases,
  },
  'agent-skills.detectAgents': {
    ts: (a) => agent.detectAgents(env(a[0]), a[1] as string),
    cases: detectCases,
  },
  'agent-skills.agentConfigDir': {
    ts: (a) => agent.agentConfigDir(a[0] as agent.AgentId, env(a[1]), a[2] as string),
    cases: [...tableCases([{}, OVERRIDES, EMPTY_OVERRIDES])],
  },
  'agent-skills.agentTarget': {
    ts: (a) => agent.agentTarget(a[0] as agent.AgentId, env(a[1]), a[2] as string),
    cases: [...tableCases([{}, OVERRIDES, EMPTY_OVERRIDES])],
  },
  'agent-skills.legacySkillCopies': {
    ts: (a) =>
      agent.legacySkillCopies(
        ledgerOf(a[0]),
        env(a[1]),
        a[2] as string,
        (a[3] ?? undefined) as agent.AgentId | undefined,
      ),
    cases: legacyCases,
  },
  'agent-skills.skillRows': {
    ts: (a) => agent.skillRows(ledgerOf(a[0]), env(a[1]), a[2] as string),
    cases: rowsCases,
  },
  // ---- agent-skills: front matter, hashes, versions ----
  'agent-skills.parseSkillFrontmatter': {
    ts: (a) => agent.parseSkillFrontmatter(a[0] as string),
    cases: FM.map((text): Case => ({ args: [text] })),
  },
  'agent-skills.sha256': {
    ts: (a) => {
      const b = a[0] as string | Bytes
      return agent.sha256(typeof b === 'string' ? b : bytesOf(b))
    },
    cases: cases(
      [''],
      ['abc'],
      ['한글 \u{1F600}'],
      [{ hex: 'ff00fe' }],
      [{ text: 'abc' }],
      [{ hex: '' }],
    ),
  },
  'agent-skills.compareVersions': {
    ts: (a) => agent.compareVersions(a[0] as string, a[1] as string),
    cases: COMPARE.map(([x, y]): Case => ({ args: [x, y] })),
  },
  'agent-skills.ledgerFromSettings': {
    ts: (a) => agent.ledgerFromSettings(a[0] as Record<string, unknown>),
    cases: cases(
      [{}],
      [{ agentSkillInstalls: { '/a/seuoffice/SKILL.md': entry('x'), '/b': 'yes' } }],
      [{ agentSkillInstalls: null }],
      [{ agentSkillInstalls: [1, 2] }],
      [{ agentSkillInstalls: 'text' }],
      [{ agentSkillInstalls: 5 }],
      [{ agentSkillInstalls: {} }],
      [{ other: { agentSkillInstalls: {} } }],
      [{ agentSkillInstalls: { '2': 'b', a: 'c', '1': 'd' } }],
    ),
  },
  'agent-skills.bundledSkillFrom': {
    ts: (a) => {
      const b = agent.bundledSkillFrom(bytesOf(a[0]))
      return {
        bytes: Buffer.from(b.bytes).toString('hex'),
        text: b.text,
        version: b.version,
        sha256: b.sha256,
      }
    },
    cases: cases(
      [{ text: skill('1.2.3') }],
      [{ text: '# no front matter' }],
      [{ text: skill(null) }],
      [{ hex: '2d2d2d0aff0a' }],
      [{ text: '\uFEFF' + skill('1.2.3') }],
      [{ text: '' }],
    ),
  },
  'agent-skills.skillFilePath': {
    ts: (a) => agent.skillFilePath(a[0] as string),
    cases: cases(['/home/u/.claude/skills'], ['skills'], ['/a/b/'], ['/a//b/../c'], ['']),
  },
  'agent-skills.skillFilesWritten': {
    ts: (a) => agent.skillFilesWritten(a[0] as string, ledgerOf(a[1])),
    cases: cases(
      ['/s', []],
      ['/s', [['/s/seuoffice/SKILL.md', entry('a')]]],
      [
        '/s',
        [
          ['/s/ieumoffice/SKILL.md', entry('a')],
          ['/s/seuoffice/SKILL.md', entry('a')],
          ['/t/seuoffice/SKILL.md', entry('a')],
        ],
      ],
      [
        '/s',
        [
          ['/s/seuoffice/SKILL.md', null],
          ['/s/ieumoffice/SKILL.md', true],
        ],
      ],
      ['/s', [['/s/seuoffice/SKILL.md', '']]],
      ['/s', [['/s/seuoffice/SKILL.md', 0]]],
      ['/s', [['/s/seuoffice/SKILL.md', 'x']]],
      ['/s/', [['/s/seuoffice/SKILL.md', 'x']]],
    ),
  },
  'agent-skills.readInstallState': {
    ts: (a) =>
      agent.readInstallState(a[0] as string, agent.bundledSkillFrom(bytesOf(a[1])), ledgerOf(a[2])),
    cases: stateCases,
  },
  'agent-skills.installSkill': {
    ts: (a, cx) => {
      makeLinks(a[4])
      const ledger = ledgerOf(a[2])
      const bundled = agent.bundledSkillFrom(bytesOf(a[1]))
      const out = attempt(() =>
        withClock(cx.now, () =>
          agent.installSkill(a[0] as string, bundled, ledger, (a[3] ?? undefined) as 'app'),
        ),
      )
      return { ...out, ledger: Object.entries(ledger) }
    },
    cases: installCases,
  },
  'agent-skills.uninstallSkill': {
    ts: (a) => {
      const ledger = ledgerOf(a[1])
      const out = attempt(() => agent.uninstallSkill(a[0] as string, ledger))
      return { ...out, ledger: Object.entries(ledger) }
    },
    cases: uninstallCases,
  },
  'agent-skills.buildSkillZip': {
    ts: async (a) => {
      const bytes = await agent.buildSkillZip(agent.bundledSkillFrom(bytesOf(a[0])))
      const zip = await JSZip.loadAsync(bytes)
      const out = []
      for (const f of Object.values(zip.files)) {
        out.push({ name: f.name, dir: f.dir, text: f.dir ? '' : await f.async('string') })
      }
      return out
    },
    cases: ZIPS.map((z): Case => ({ args: [z] })),
  },
  'agent-skills.SKILL_NAME': {
    ts: () => agent.SKILL_NAME,
    cases: cases([]),
    single: 'a constant',
  },
  'agent-skills.LEDGER_KEY': {
    ts: () => agent.LEDGER_KEY,
    cases: cases([]),
    single: 'a constant',
  },
  'agent-skills.SHARED_AGENT_ID': {
    ts: () => agent.SHARED_AGENT_ID,
    cases: cases([]),
    single: 'a constant',
  },
  // ---- install ----
  'install.launcherFileName': {
    ts: (a) => install.launcherFileName(a[0] as string),
    cases: cases(['win32'], ['darwin'], ['linux'], [''], ['WIN32']),
  },
  'install.CLI_COMMAND': {
    ts: () => install.CLI_COMMAND,
    cases: cases([]),
    single: 'a constant',
  },
  'install.HOME_DIR_NAME': {
    ts: () => install.HOME_DIR_NAME,
    cases: cases([]),
    single: 'a constant',
  },
  'install.defaultCandidateDirs': {
    ts: (a) => {
      const exists = new Set(a[2] as string[])
      return install.defaultCandidateDirs(a[0] as NodeJS.Platform, env(a[1]), (p) => exists.has(p))
    },
    cases: cases(
      ['darwin', {}, []],
      ['darwin', { HOME: '/Users/u' }, []],
      ['darwin', { HOME: '/Users/u' }, ['/opt/homebrew/bin/brew']],
      ['darwin', { HOME: '/Users/u' }, ['/usr/local/bin/brew']],
      ['darwin', { HOME: '/Users/u', HOMEBREW_PREFIX: '/usr/local/' }, []],
      ['darwin', { HOME: '/Users/u', HOMEBREW_PREFIX: 'relative' }, []],
      ['darwin', { XDG_BIN_HOME: '/x/bin', HOME: '/Users/u' }, []],
      ['darwin', { XDG_BIN_HOME: 'x/bin', HOME: '/Users/u' }, []],
      ['darwin', { XDG_BIN_HOME: '/Users/u/.local/bin', HOME: '/Users/u' }, []],
      ['darwin', { XDG_BIN_HOME: '/x/bin', HOMEBREW_PREFIX: '/x' }, []],
      ['linux', { HOME: '/home/u' }, ['/home/linuxbrew/.linuxbrew/bin/brew']],
      ['linux', { HOME: '/home/u' }, ['/opt/homebrew/bin/brew']],
      ['linux', { HOME: '' }, []],
      ['win32', { HOME: 'C:\\Users\\u' }, []],
      ['freebsd', { HOME: '/home/u' }, []],
    ),
  },
  'install.homebrewBinDirs': {
    ts: (a) => {
      const exists = new Set(a[2] as string[])
      return install.homebrewBinDirs(a[0] as NodeJS.Platform, env(a[1]), (p) => exists.has(p))
    },
    cases: cases(
      ['darwin', {}, []],
      ['darwin', {}, ['/opt/homebrew/bin/brew']],
      ['darwin', {}, ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']],
      ['darwin', { HOMEBREW_PREFIX: '/opt/homebrew' }, ['/opt/homebrew/bin/brew']],
      ['darwin', { HOMEBREW_PREFIX: '/custom/brew///' }, ['/usr/local/bin/brew']],
      ['darwin', { HOMEBREW_PREFIX: 'relative' }, []],
      ['darwin', { HOMEBREW_PREFIX: '' }, []],
      ['darwin', { HOMEBREW_PREFIX: '/' }, []],
      ['linux', {}, ['/home/linuxbrew/.linuxbrew/bin/brew']],
      ['linux', {}, ['/opt/homebrew/bin/brew']],
      ['win32', { HOMEBREW_PREFIX: '/opt/homebrew' }, ['/opt/homebrew/bin/brew']],
    ),
  },
  'install.userBinDirs': {
    ts: (a) => install.userBinDirs(env(a[0])),
    cases: cases(
      [{}],
      [{ HOME: '/home/u' }],
      [{ HOME: '/home/u', XDG_BIN_HOME: '/x/bin' }],
      [{ HOME: '/home/u', XDG_BIN_HOME: 'relative' }],
      [{ HOME: '/home/u', XDG_BIN_HOME: '/home/u/.local/bin' }],
      [{ HOME: '', XDG_BIN_HOME: '' }],
      [{ XDG_BIN_HOME: '/x/bin' }],
      [{ HOME: '/home/u/' }],
    ),
  },
  'install.pathHint': {
    ts: (a) => install.pathHint(a[0] as string, env(a[1])),
    cases: cases(
      ['/home/u/.local/bin', { HOME: '/home/u', PATH: '/usr/bin' }],
      ['/home/u/.local/bin', { HOME: '/home/u', PATH: '/usr/bin:/home/u/.local/bin' }],
      ['/home/u/.local/bin/', { HOME: '/home/u', PATH: '/home/u/.local/bin' }],
      ['/home/u/.local/bin', { HOME: '/home/u', PATH: '/home/u/.local/bin//' }],
      ['/x/bin', { HOME: '/home/u', PATH: '/usr/bin' }],
      ['/x/bin', { PATH: '/usr/bin' }],
      ['/x/bin', {}],
      ['/home/user/bin', { HOME: '/home/u', PATH: '' }],
      ['/home/u/bin', { HOME: '/home/u/', PATH: '/usr/bin' }],
      ['/home/u', { HOME: '/home/u', PATH: '/usr/bin' }],
      ['/home/u/bin', { HOME: '', PATH: '/usr/bin' }],
      ['/홈/u/bin', { HOME: '/홈/u', PATH: '/usr/bin' }],
      ['', { PATH: '' }],
    ),
  },
  'install.installCliLink': {
    ts: (a, cx) => linkRun(a, cx, (opts) => install.installCliLink(opts)),
    cases: linkCases(),
  },
  'install.inspectCliLink': {
    ts: (a, cx) => linkRun(a, cx, (opts) => install.inspectCliLink(opts)),
    cases: linkCases(),
  },
  'install.isOurLauncher': {
    ts: (a) => {
      makeLinks(a[2])
      const value = install.isOurLauncher(a[0] as string, a[1] as string)
      return { value, links: observe(((a[2] ?? []) as Links).map(([link]) => link)) }
    },
    cases: ourCases,
  },
}

export const group: Group = spec
