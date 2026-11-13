/**
 * Group `b5-agent`, part user-skills, the package half: the pure and folder
 * functions of `packages/ai-provider/src/user-skills/*` and the skill-editor
 * scope of `packages/agent-core/src/skill-editors.ts`, named
 * `ai-provider/user-skills/<ts-file>.<export>`.
 *
 * - Folders are the case's `files`; every path in an answer has the case folder
 *   written `$DIR`. The platform has no symbolic links in a case (a spec file
 *   cannot make one), so the link rules of `listSkillFolderFiles` are not
 *   compared.
 * - `suggestUserSkillName` gets its random part as the last argument.
 * - A skill is the JSON of `UserSkill`; `resolveUserSkillStates` reads the
 *   settings as the second argument.
 */
import { skillEditorScope } from '../../../packages/agent-core/src/skill-editors.ts'
import {
  BUILTIN_SKILLS_MANIFEST,
  IEUM_EDITORS_KEY,
  IEUM_SOURCE_FILE,
  IEUM_TEMPLATE_KEY,
  IEUM_TITLE_KEY,
  MAX_USER_SKILL_BYTES,
  MAX_USER_SKILL_FILES,
  NEW_USER_SKILL_NAME_MAX,
  SKILL_SCRIPT_EXTENSIONS,
  SKILL_SCRIPTS_FOLDER,
  SKILL_TEMPLATE_FOLDER,
  SKILL_TEXT_EXTENSIONS,
  USER_SKILL_PRIORITY,
  RESERVED_USER_SKILL_NAMES,
} from '../../../packages/ai-provider/src/user-skills/constants.ts'
import {
  parseSkillMd,
  renderSkillMd,
  withoutSkillEditors,
  type SkillMdInput,
} from '../../../packages/ai-provider/src/user-skills/frontmatter.ts'
import {
  isReservedUserSkillName,
  suggestUserSkillName,
  userSkillId,
  validateNewUserSkillName,
} from '../../../packages/ai-provider/src/user-skills/names.ts'
import {
  isInsideDir,
  isSkillScriptPath,
  listSkillFolderFiles,
  mcpServersOfSkillMd,
  normalizeSkillTemplatePath,
  readListedSkillMd,
  readUserSkillFolder,
  skillContentHash,
} from '../../../packages/ai-provider/src/user-skills/folder.ts'
import {
  codexHomeDir,
  isInsideCodexHome,
} from '../../../packages/ai-provider/src/user-skills/sources.ts'
import {
  initialUserSkillState,
  pickEnabledUserSkills,
  resolveUserSkillStates,
} from '../../../packages/ai-provider/src/user-skills/states.ts'
import {
  isoSeconds,
  readIeumSourceRecord,
  renderIeumSourceRecord,
} from '../../../packages/ai-provider/src/user-skills/source-record.ts'
import {
  skillBundleFileName,
  skillExportInfo,
} from '../../../packages/ai-provider/src/user-skills/export.ts'
import {
  commitSkillInstall,
  type SkillInstallPlan,
} from '../../../packages/ai-provider/src/user-skills/import.ts'
import type { UserSkill } from '../../../packages/ai-provider/src/user-skills/types.ts'
import type { Case, FnSpec, Group } from '../types.ts'

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))
const md = (...lines: string[]): string => lines.join('\n')

export const pkg: Group = {}
const add = (name: string, spec: FnSpec): void => {
  pkg[`ai-provider/user-skills/${name}`] = spec
}

// ---------------------------------------------------------------------------
// constants.ts
// ---------------------------------------------------------------------------

add('constants.values', {
  single: 'fixed values of the skills library',
  ts: () => ({
    NEW_USER_SKILL_NAME_MAX,
    MAX_USER_SKILL_BYTES,
    MAX_USER_SKILL_FILES,
    RESERVED: [...RESERVED_USER_SKILL_NAMES],
    SKILL_SCRIPT_EXTENSIONS: [...SKILL_SCRIPT_EXTENSIONS],
    SKILL_SCRIPTS_FOLDER,
    SKILL_TEXT_EXTENSIONS: [...SKILL_TEXT_EXTENSIONS],
    IEUM_SOURCE_FILE,
    BUILTIN_SKILLS_MANIFEST,
    SKILL_TEMPLATE_FOLDER,
    IEUM_TITLE_KEY,
    IEUM_TEMPLATE_KEY,
    IEUM_EDITORS_KEY,
    USER_SKILL_PRIORITY: [...USER_SKILL_PRIORITY],
  }),
  cases: cases([]),
})

// ---------------------------------------------------------------------------
// frontmatter.ts
// ---------------------------------------------------------------------------

add('frontmatter.parseSkillMd', {
  ts: (args) => parseSkillMd(args[0] as string),
  cases: cases(
    [md('---', 'name: pdf-notes', 'description: Make notes', '---', 'Body text', 'second')],
    ['no front matter at all'],
    [md('---', 'name: open', 'description: never closed')],
    ['\ufeff---\r\nname: crlf\r\ndescription: with BOM\r\n---\r\nbody\r\n'],
    [
      md(
        '---',
        'name: meta',
        'description: d',
        'metadata:',
        '  ieum-title: My title',
        '  ieum-template: assets/t.docx',
        '  ieum-editors: docs sheets',
        '  other: "x y"',
        '---',
        '',
      ),
    ],
    [
      md(
        '---',
        'name: "q\\u00e9\\x41\\n\\t"',
        "description: 'it''s fine'",
        'x: "a\\qb"',
        '---',
        'b',
      ),
    ],
    [
      md(
        '---',
        'name: blocks',
        'description: |',
        '  line one',
        '',
        '  line two',
        'folded: >-',
        '  a',
        '  b',
        '',
        '  c',
        'keep: |+',
        '  k',
        '',
        '',
        'explicit: |2',
        '    indented',
        '---',
        'b',
      ),
    ],
    [
      md(
        '---',
        'name: lists',
        'description: d',
        'allowed-tools:',
        '  - Read',
        '  - "mcp__srv__tool"',
        '  - Bash(git:*) # comment',
        'flow: [a, "b, c", \'d\']',
        'bad-flow: [a, "b',
        'nested:',
        '  - - x',
        'map-like:',
        '  child: 1',
        '---',
        'b',
      ),
    ],
    [
      md(
        '---',
        'name: deep',
        'description: d',
        'allowed-tools:',
        '  - Read',
        '    - Write',
        '---',
        'b',
      ),
    ],
    [
      md(
        '---',
        '# a comment',
        'name: commented # trailing',
        'description: long text',
        '  continued here',
        '',
        '  after blank',
        '- stray',
        'weird key: v',
        '---',
        'b',
      ),
    ],
    [md('---', 'name: bad', 'description: "\\U00110000"', '---', 'b')],
    [md('---', 'name: multi', 'description: "first', '  second', '', '  third"', '---', 'b')],
    [md('---', 'name: meta', 'metadata: scalar', 'description: d', '---', 'b')],
    [md('---', 'name: __proto__', '__proto__: x', 'description: d', '---', 'b')],
    [md('---', 'name: empty-value', 'description:', 'metadata:', '---', 'b')],
  ),
})

const renderInput = (raw: unknown): SkillMdInput => raw as SkillMdInput

add('frontmatter.renderSkillMd', {
  ts: (args) => renderSkillMd(renderInput(args[0]), args[1] as string | undefined),
  cases: cases(
    [{ name: 'a', description: 'About a', body: 'text\n' }],
    [{ name: 'a', description: 'About a', title: 'A title', template: 'assets/t.docx', body: 'x' }],
    [
      { name: 'a', description: 'About a', editors: 'docs sheets', body: 'x' },
      md('---', 'name: a', 'description: old', 'license: MIT', '---', 'old body'),
    ],
    [
      { name: 'a', description: 'old', editors: null, body: 'x' },
      md(
        '---',
        'name: a',
        'description: old',
        'metadata:',
        '  ieum-editors: docs',
        '  keep: me',
        '---',
        'old',
      ),
    ],
    [
      { name: 'a', description: 'old', title: 'T', body: 'x' },
      md(
        '---',
        '# header comment',
        "name: 'a'",
        'description: old # why',
        'metadata:',
        '  keep: me',
        '  ieum-title: T',
        '---',
        'old',
      ),
    ],
    [{ name: 'a', description: 'line one\nline two\n', body: 'x' }],
    [{ name: 'a', description: 'true', body: 'x' }],
    [{ name: 'a b', description: ': colon start', title: '  padded ', body: 'x' }],
    [
      {
        name: 'a',
        description: 'd',
        body: 'x',
        fields: { 'disable-model-invocation': true, extra: 'with: colon' },
      },
    ],
    [
      { name: 'a', description: 'd', title: 'T', body: 'x' },
      md('---', 'name: a', 'metadata: scalar', 'description: d', '---', 'x'),
    ],
    [
      { name: 'a', description: 'd', body: 'x' },
      md('---', 'name: a', 'metadata: scalar', 'description: d', '---', 'x'),
    ],
    [{ name: 'a', description: 'tail\n\n\n', body: 'x' }],
    [{ name: 'a', description: 'one\ntwo', body: 'x' }],
    [
      { name: 'a', description: 'old', title: 'T2', body: 'x' },
      md('---', 'name: a', 'description: old', 'metadata:', '  ieum-editors: docs', '---', 'old'),
    ],
    [
      { name: 'a', description: 'd', body: 'x' },
      md('---', 'name: a', 'description: "\\U00110000"', '---', 'x'),
    ],
  ),
})

add('frontmatter.withoutSkillEditors', {
  ts: (args) => withoutSkillEditors(args[0] as string),
  cases: cases(
    [
      md(
        '---',
        'name: a',
        'description: d',
        'metadata:',
        '  ieum-title: T',
        '  ieum-editors: docs',
        '---',
        'body',
      ),
    ],
    [md('---', 'name: a', 'description: d', '---', 'body')],
    ['not a skill file'],
    [md('---', 'description: d', 'metadata:', '  ieum-editors: docs', '---', 'body')],
  ),
})

// ---------------------------------------------------------------------------
// names.ts
// ---------------------------------------------------------------------------

add('names.isReservedUserSkillName', {
  ts: (args) => isReservedUserSkillName(args[0] as string),
  cases: cases(['seuoffice'], ['  GenOffice '], ['IeumOffice'], ['my-skill'], ['']),
})

add('names.validateNewUserSkillName', {
  ts: (args) => validateNewUserSkillName(args[0] as string),
  cases: cases(
    [''],
    ['a'.repeat(65)],
    ['Upper'],
    ['-start'],
    ['end-'],
    ['a--b'],
    ['seuoffice'],
    ['good-name-1'],
    ['a'.repeat(64)],
  ),
})

add('names.suggestUserSkillName', {
  ts: (args) =>
    suggestUserSkillName(args[0] as string, {
      taken: args[1] as string[],
      random: () => args[2] as string,
    }),
  cases: cases(
    ['Weekly Report', [], 'xyz123'],
    ['  Caf\u00e9 \u2013 Menu!  ', [], 'xyz123'],
    ['\ud55c\uae00 \uc81c\ubaa9', [], 'abc999'],
    ['Weekly Report', ['weekly-report', 'Weekly-Report-2'], 'xyz123'],
    ['seuoffice', [], 'q1w2e3'],
    ['x'.repeat(70), [], 'xyz123'],
    ['x'.repeat(64), ['x'.repeat(64)], 'xyz123'],
    ['a'.repeat(63) + '-b', [], 'xyz123'],
  ),
})

add('names.userSkillId', {
  ts: (args) => userSkillId(args[0] as never, args[1] as string, args[2] as string | undefined),
  cases: cases(['app', 'x'], ['plugin', 'x', 'p'], ['plugin', 'x'], ['builtin', 'y']),
})

// ---------------------------------------------------------------------------
// folder.ts
// ---------------------------------------------------------------------------

const SKILL = md('---', 'name: s', 'description: Does s', '---', 'body')

add('folder.listSkillFolderFiles', {
  ts: async (args) => {
    const limits = args[1] as { files: number; bytes: number } | undefined
    return listSkillFolderFiles(args[0] as string, limits)
  },
  cases: [
    {
      args: ['$DIR/s'],
      files: {
        's/SKILL.md': SKILL,
        's/z.txt': 'zz',
        's/a/b/c.md': 'abc',
        's/A.md': 'A',
        's/e': { dir: true },
      },
    },
    { args: ['$DIR/missing'] },
    { args: ['$DIR/s', { files: 1, bytes: 1000 }], files: { 's/a.txt': 'a', 's/b.txt': 'b' } },
    { args: ['$DIR/s', { files: 10, bytes: 3 }], files: { 's/a.txt': 'aaaa' } },
    { args: ['$DIR/s'], files: { 's/empty': { dir: true } } },
  ],
})

add('folder.isSkillScriptPath', {
  ts: (args) => isSkillScriptPath(args[0] as string),
  cases: cases(
    ['SKILL.md'],
    ['run.PY'],
    ['Scripts/helper.txt'],
    ['a/scripts'],
    ['a/b.exe'],
    ['docs/readme.md'],
  ),
})

add('folder.normalizeSkillTemplatePath', {
  ts: (args) => normalizeSkillTemplatePath(args[0] as string | undefined),
  cases: cases(
    [undefined],
    [''],
    ['assets/t.docx'],
    ['  assets/sub/t.docx '],
    ['assets'],
    ['other/t.docx'],
    ['assets/../t.docx'],
    ['assets//t.docx'],
    ['assets\\t.docx'],
    ['/assets/t.docx'],
    ['C:/assets/t.docx'],
  ),
})

add('folder.isInsideDir', {
  ts: (args) => isInsideDir(args[0] as string, args[1] as string),
  cases: cases(
    ['/a/b', '/a'],
    ['/a', '/a'],
    ['/a/../b', '/a'],
    ['/ab', '/a'],
    ['/a/b/../c', '/a/b'],
    ['/', '/a'],
  ),
})

const readOptions = (raw: unknown) => {
  const o = raw as { source: never; plugin?: string; agentOnly?: string[] }
  return {
    source: o.source,
    plugin: o.plugin,
    agentOnlyNames: o.agentOnly ? new Set(o.agentOnly) : undefined,
  }
}

add('folder.readUserSkillFolder', {
  ts: async (args) => readUserSkillFolder(args[0] as string, readOptions(args[1])),
  cases: [
    {
      args: ['$DIR/s', { source: 'app' }],
      files: {
        's/SKILL.md': md(
          '---',
          'name: s',
          'description: Does s',
          'metadata:',
          '  ieum-title: Nice title',
          '  ieum-template: assets/t.docx',
          '  ieum-editors: docs',
          '---',
          'body',
        ),
        's/assets/t.docx': 'DOCX',
        's/scripts/run.sh': 'echo',
        's/.ieum-source.json': '{}',
      },
    },
    { args: ['$DIR/seuoffice', { source: 'app' }], files: { 'seuoffice/SKILL.md': SKILL } },
    {
      args: ['$DIR/s', { source: 'app' }],
      files: { 's/SKILL.md': md('---', 'name: GenOffice', 'description: x', '---', 'b') },
    },
    { args: ['$DIR/s', { source: 'user' }], files: { 's/readme.md': 'no skill file' } },
    { args: ['$DIR/s', { source: 'user' }], files: { 's/SKILL.md': 'no front matter' } },
    {
      args: ['$DIR/folder-name', { source: 'codex' }],
      files: { 'folder-name/SKILL.md': md('---', 'name: bad name!', 'description: d', '---', 'b') },
    },
    {
      args: ['$DIR/s', { source: 'plugin', plugin: 'pl' }],
      files: {
        's/SKILL.md': md(
          '---',
          'name: s',
          'description: d',
          'allowed-tools: mcp__srv__x',
          '---',
          'uses mcp__other__y here',
        ),
      },
    },
    {
      args: ['$DIR/s', { source: 'builtin', agentOnly: ['s'] }],
      files: { 's/SKILL.md': SKILL, 's/assets/missing.docx': 'x' },
    },
    { args: ['$DIR/missing', { source: 'app' }] },
    {
      args: ['$DIR/s', { source: 'app' }],
      files: {
        's/SKILL.md': md(
          '---',
          'name: s',
          'description: d',
          'metadata:',
          '  ieum-template: ../x.docx',
          '---',
          'b',
        ),
      },
    },
    {
      args: ['$DIR/s', { source: 'app' }],
      files: { 's/SKILL.md': md('---', 'name: s', 'description: "\\U00110000"', '---', 'b') },
    },
  ],
})

add('folder.readListedSkillMd', {
  ts: (args) => readListedSkillMd(args[0] as string),
  cases: [
    { args: ['$DIR/s'], files: { 's/SKILL.md': SKILL } },
    { args: ['$DIR/s'], files: { 's/other.md': 'x' } },
    { args: ['$DIR/missing'] },
  ],
})

add('folder.mcpServersOfSkillMd', {
  ts: (args) => {
    const parsed = parseSkillMd(args[0] as string)
    return parsed ? mcpServersOfSkillMd(parsed) : null
  },
  cases: cases(
    [
      md(
        '---',
        'name: s',
        'description: d',
        'allowed-tools:',
        '  - mcp__one__a',
        '  - Read',
        '---',
        'mcp__two__b',
      ),
    ],
    [
      md(
        '---',
        'name: s',
        'description: d',
        'allowed-tools: mcp__three, mcp__four__x',
        '---',
        'plain',
      ),
    ],
    [md('---', 'name: s', 'description: d', '---', 'nothing here')],
    ['not front matter'],
  ),
})

add('folder.skillContentHash', {
  ts: async (args) => skillContentHash(args[0] as string),
  cases: [
    { args: ['$DIR/a'], files: { 'a/SKILL.md': SKILL, 'a/x/y.txt': 'y' } },
    {
      args: ['$DIR/a'],
      files: { 'a/SKILL.md': SKILL, 'a/x/y.txt': 'y', 'a/.ieum-source.json': '{"kind":"github"}' },
    },
    { args: ['$DIR/a'], files: { 'a/SKILL.md': SKILL, 'a/x/y.txt': 'z' } },
    { args: ['$DIR/missing'] },
  ],
})

// ---------------------------------------------------------------------------
// sources.ts: what this part owns (the Codex home guard)
// ---------------------------------------------------------------------------

add('sources.codexHomeDir', {
  ts: (args) => codexHomeDir(args[0] as string),
  cases: cases(['/home/u'], ['/home/u/'], ['/home/other'], ['/a/b/../c'], ['rel'], ['']),
})

add('sources.isInsideCodexHome', {
  ts: async (args) => isInsideCodexHome(args[0] as string, args[1] as string),
  cases: [
    { args: ['$DIR/home/.codex/skills', '$DIR/home'], files: { 'home/.codex/auth.json': '{}' } },
    { args: ['$DIR/home/.codex', '$DIR/home'], files: { 'home/.codex/auth.json': '{}' } },
    { args: ['$DIR/home/.claude/skills', '$DIR/home'], files: { 'home/.claude/x': 'x' } },
    { args: ['$DIR/home/.codexx', '$DIR/home'], files: { 'home/.codexx/x': 'x' } },
    { args: ['$DIR/home/.agents/../.codex/s', '$DIR/home'] },
  ],
})

// ---------------------------------------------------------------------------
// states.ts, skill-editors.ts
// ---------------------------------------------------------------------------

add('states.initialUserSkillState', {
  ts: (args) => initialUserSkillState(args[0] as never),
  cases: cases(['builtin'], ['app'], ['project'], ['user'], ['plugin'], ['codex']),
})

add('skill-editors.skillEditorScope', {
  ts: (args) => skillEditorScope(args[0] as never, args[1] as never),
  cases: cases(
    ['all', ['docs']],
    [['sheets', 'docs'], ['pdf']],
    [undefined, ['pdf', 'docs']],
    [undefined, undefined],
    [['nope'], ['docs']],
    [
      undefined,
      ['docs', 'sheets', 'slides', 'hwp', 'pdf', 'markdown', 'html', 'mindmap', 'epub', 'diagram'],
    ],
  ),
})

const skillOf = (
  over: Partial<UserSkill> & { id: string; source: UserSkill['source'] },
): UserSkill => {
  const { id, source, ...rest } = over
  const name = over.name ?? id.split(':').pop()!
  return {
    // the key order of `readUserSkillFolder`'s literal: `id` and `source` first
    id,
    source,
    plugin: undefined,
    name,
    folderName: name,
    dir: `/skills/${name}`,
    title: name,
    description: 'd',
    template: undefined,
    templateExists: false,
    hasScripts: false,
    mcpServers: [],
    github: false,
    agentOnly: false,
    fileEditors: undefined,
    files: 1,
    bytes: 10,
    unreadable: undefined,
    ...rest,
  }
}

const SKILLS = [
  skillOf({ id: 'builtin:alpha', source: 'builtin' }),
  skillOf({ id: 'app:alpha', source: 'app', fileEditors: ['docs'] }),
  skillOf({ id: 'user:beta', source: 'user' }),
  skillOf({ id: 'plugin:zz:beta', source: 'plugin', plugin: 'zz' }),
  skillOf({ id: 'plugin:aa:beta', source: 'plugin', plugin: 'AA' }),
  skillOf({ id: 'codex:beta', source: 'codex' }),
  skillOf({ id: 'project:gamma', source: 'project' }),
  skillOf({ id: 'project:broken', source: 'project', unreadable: 'unreadable' }),
  skillOf({ id: 'app:broken', source: 'app', unreadable: 'bad-name' }),
  skillOf({ id: 'builtin:hidden-one', source: 'builtin' }),
]

add('states.resolveUserSkillStates', {
  ts: (args) => resolveUserSkillStates(args[0] as UserSkill[], args[1]),
  cases: cases(
    [SKILLS, undefined],
    [
      SKILLS,
      {
        states: {
          'user:beta': { enabled: true, invoke: 'manual' },
          'app:alpha': { editors: 'all', enabled: false },
          'builtin:alpha': { editors: ['sheets'] },
          'project:gamma': { enabled: false },
          'bad id': { enabled: true },
          'codex:beta': { invoke: 'weird', enabled: 'yes' },
        },
        hiddenBuiltins: ['Hidden-One', '', 5],
      },
    ],
    [SKILLS.slice(0, 2), 'not an object'],
    [[], { states: {} }],
  ),
})

const resolvedOf = (skills: unknown) => resolveUserSkillStates(skills as UserSkill[], undefined)

add('states.pickEnabledUserSkills', {
  ts: (args) => {
    const resolved = args[1]
      ? resolveUserSkillStates(args[0] as UserSkill[], args[1])
      : resolvedOf(args[0])
    const picked = pickEnabledUserSkills(resolved)
    return {
      chosen: picked.chosen.map((skill) => skill.id),
      shadowed: picked.shadowed.map((entry) => ({ id: entry.skill.id, by: entry.by })),
    }
  },
  cases: cases(
    [SKILLS],
    [SKILLS, { states: { 'user:beta': { enabled: true }, 'codex:beta': { enabled: true } } }],
    [
      SKILLS,
      {
        states: {
          'user:beta': { enabled: true },
          'plugin:zz:beta': { enabled: true },
          'plugin:aa:beta': { enabled: true },
          'app:alpha': { enabled: false },
        },
      },
    ],
    [[]],
  ),
})

// ---------------------------------------------------------------------------
// source-record.ts
// ---------------------------------------------------------------------------

add('source-record.isoSeconds', {
  ts: (args) => isoSeconds(new Date(args[0] as number)),
  cases: cases([0], [1_700_000_000_123], [1_700_000_000_999], [-1]),
})

const RECORD = {
  kind: 'github' as const,
  repo: 'o/r',
  ref: 'main',
  path: 'skills/x',
  commit: 'abc',
  installedAt: '2026-10-21T09:00:00Z',
  contentHash: 'h',
}

add('source-record.renderIeumSourceRecord', {
  ts: (args) => renderIeumSourceRecord(args[0] as never),
  cases: cases([RECORD], [{ ...RECORD, path: '', ref: 'feat/x' }]),
})

add('source-record.readIeumSourceRecord', {
  ts: async (args) => readIeumSourceRecord(args[0] as string),
  cases: [
    { args: ['$DIR/s'], files: { 's/.ieum-source.json': JSON.stringify(RECORD) } },
    {
      args: ['$DIR/s'],
      files: { 's/.ieum-source.json': JSON.stringify({ ...RECORD, path: undefined }) },
    },
    {
      args: ['$DIR/s'],
      files: {
        's/.ieum-source.json': JSON.stringify({
          kind: 'github',
          repo: 'o/r',
          ref: 'm',
          path: '',
          commit: 'c',
        }),
      },
    },
    {
      args: ['$DIR/s'],
      files: { 's/.ieum-source.json': JSON.stringify({ ...RECORD, kind: 'zip' }) },
    },
    { args: ['$DIR/s'], files: { 's/.ieum-source.json': '[1]' } },
    { args: ['$DIR/s'], files: { 's/.ieum-source.json': 'not json' } },
    { args: ['$DIR/s'], files: { 's/x': 'x' } },
  ],
})

// ---------------------------------------------------------------------------
// export.ts
// ---------------------------------------------------------------------------

add('export.skillBundleFileName', {
  ts: (args) => skillBundleFileName(args[0] as string | undefined),
  cases: cases(
    [undefined],
    [''],
    ['My skills and 2 more'],
    ['weekly.zip'],
    ['a/b:c*d?'],
    ['CON'],
    ['..dots...'],
    ['x'.repeat(150)],
  ),
})

add('export.skillExportInfo', {
  ts: async (args) => skillExportInfo(args[0] as string),
  cases: [
    {
      args: ['$DIR/s'],
      files: {
        's/SKILL.md': md(
          '---',
          'name: s',
          'description: d',
          'metadata:',
          '  ieum-title: A/B: title',
          '  ieum-template: assets/t.docx',
          '---',
          'b',
        ),
        's/assets/t.docx': 'DOC',
        's/.ieum-source.json': '{}',
      },
    },
    { args: ['$DIR/s'], files: { 's/SKILL.md': SKILL } },
    { args: ['$DIR/s'], files: { 's/readme.md': 'x' } },
    { args: ['$DIR/missing'] },
    {
      args: ['$DIR/s'],
      files: {
        's/SKILL.md': md(
          '---',
          'name: s',
          'description: d',
          'metadata:',
          '  ieum-title: CON',
          '---',
          'b',
        ),
      },
    },
    {
      args: ['$DIR/s'],
      files: {
        's/SKILL.md': md(
          '---',
          'name: s',
          'description: d',
          'metadata:',
          '  ieum-template: assets/gone.docx',
          '---',
          'b',
        ),
      },
    },
  ],
})

// ---------------------------------------------------------------------------
// import.ts: commitSkillInstall
// ---------------------------------------------------------------------------

interface CommitSpec {
  plans: Array<{
    dir: string
    name?: string
    folderName: string
    replaceDirs: string[]
    source?: SkillInstallPlan['source']
  }>
  /** folders the discard callback refuses */
  discardFails?: string[]
  discard?: boolean
}

add('import.commitSkillInstall', {
  ts: async (args, cx) => {
    const spec = args[1] as CommitSpec
    const plans: SkillInstallPlan[] = spec.plans.map((plan) => ({
      candidate: {
        key: plan.folderName,
        rel: '',
        dir: plan.dir,
        name: plan.name ?? plan.folderName,
        title: plan.folderName,
        description: '',
        files: 0,
        bytes: 0,
        hasScripts: false,
        hasTemplate: false,
        urls: [],
        urlCount: 0,
        license: undefined,
        warnings: [],
        warningCount: 0,
        collision: false,
        emptyBody: false,
        problem: undefined,
      },
      folderName: plan.folderName,
      replaceDirs: plan.replaceDirs,
      source: plan.source,
    }))
    const discardFails = spec.discardFails ?? []
    return commitSkillInstall(args[0] as string, plans, {
      now: () => new Date(cx.now),
      random: () => 'rnd',
      discardReplaced: spec.discard
        ? async (dir) => {
            cx.log('discard', dir)
            if (discardFails.some((suffix) => dir.endsWith(suffix))) throw new Error('refused')
          }
        : undefined,
    })
  },
  cases: [
    {
      args: [
        '$DIR/skills',
        { plans: [{ dir: '$DIR/work', folderName: 'new-one', replaceDirs: [] }] },
      ],
      files: { 'work/SKILL.md': SKILL, 'work/a/b.txt': 'b', 'work/.ieum-source.json': '{}' },
    },
    {
      args: [
        '$DIR/skills',
        { plans: [{ dir: '$DIR/work', folderName: 'taken', replaceDirs: [] }] },
      ],
      files: { 'work/SKILL.md': SKILL, 'skills/taken/SKILL.md': 'old' },
    },
    {
      args: [
        '$DIR/skills',
        {
          plans: [{ dir: '$DIR/work', folderName: 'taken', replaceDirs: ['$DIR/skills/taken'] }],
          discard: true,
        },
      ],
      files: { 'work/SKILL.md': SKILL, 'skills/taken/SKILL.md': 'old' },
    },
    {
      args: [
        '$DIR/skills',
        {
          plans: [{ dir: '$DIR/work', folderName: 'taken', replaceDirs: ['$DIR/skills/taken'] }],
          discard: true,
          discardFails: ['old-0-0/taken'],
        },
      ],
      files: { 'work/SKILL.md': SKILL, 'skills/taken/SKILL.md': 'old' },
    },
    {
      args: [
        '$DIR/skills',
        { plans: [{ dir: '$DIR/work', folderName: 'x', replaceDirs: ['$DIR/elsewhere'] }] },
      ],
      files: { 'work/SKILL.md': SKILL, 'elsewhere/f': 'f' },
    },
    {
      args: [
        '$DIR/skills',
        { plans: [{ dir: '$DIR/work', folderName: 'x', replaceDirs: ['$DIR/skills'] }] },
      ],
      files: { 'work/SKILL.md': SKILL },
    },
    {
      args: ['$DIR/skills', { plans: [{ dir: '$DIR/missing', folderName: 'x', replaceDirs: [] }] }],
    },
    {
      args: [
        '$DIR/skills',
        {
          plans: [
            {
              dir: '$DIR/w1',
              folderName: 'one',
              replaceDirs: [],
              source: { repo: 'o/r', ref: 'main', path: 'p', commit: 'c1' },
            },
            { dir: '$DIR/w2', folderName: 'two', replaceDirs: ['$DIR/skills/two'] },
          ],
        },
      ],
      files: {
        'w1/SKILL.md': SKILL,
        'w2/SKILL.md': SKILL,
        'skills/two/SKILL.md': 'old',
        'skills/two/extra.txt': 'e',
      },
    },
    {
      args: [
        '$DIR/skills',
        {
          plans: [
            { dir: '$DIR/work', folderName: 'one', replaceDirs: [] },
            { dir: '$DIR/work', folderName: 'one', replaceDirs: [] },
          ],
        },
      ],
      files: { 'work/SKILL.md': SKILL },
    },
    { args: ['$DIR/skills', { plans: [] }] },
  ],
})
