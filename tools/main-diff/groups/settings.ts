/**
 * Group `settings`: app-settings.ts, folder-roots.ts, split-memory.ts and
 * window-bounds.ts of apps/shell/src/main, `normalizeUserSkillSettings` of
 * packages/ai-provider and `isValidProjectId` of packages/project-store.
 *
 * Callbacks are described by data both sides run (see calls/settings.rs):
 * `ops` for the update functions, `fakeRead`/`fakeWrite`/`lazy` for the split
 * memory options, a window object for the window functions. The temporary
 * file of an atomic write carries the pid and a UUID, so messages are
 * compared with that part replaced.
 */
import {
  AGENT_PROJECT_PREFS_KEY,
  AGENT_SKILL_NOTICE_KEY,
  DEFAULT_AGENT_PROJECT_PREF,
  PROJECTS_SETTING_KEY,
  SKILLS_SETTING_KEY,
  agentSkillNoticeDue,
  markAgentSkillNoticeSeen,
  normalizeAgentProjectPrefs,
  normalizeProjectsSettings,
  readAgentProjectPref,
  readAppSettings,
  readProjectsSettings,
  readSkillSettings,
  updateProjectsSettings,
  updateSkillSettings,
  writeAgentPrefs,
  writeAgentProjectPref,
  writeAppSetting,
  writeAppSettingThen,
  writeAppSettings,
  writeProjectsSettings,
  writeSkillSettings,
} from '../../../apps/shell/src/main/app-settings.ts'
import {
  FOLDER_ROOTS_KEY,
  describeExtraRoot,
  readExtraRoots,
  withExtraRoot,
  withoutExtraRoot,
} from '../../../apps/shell/src/main/folder-roots.ts'
import {
  SPLIT_MEMORY_SETTING_KEY,
  clearSplitMemory,
  readSplitMemory,
  writeSplitMemory,
  type SplitMemoryOptions,
} from '../../../apps/shell/src/main/split-memory.ts'
import {
  SHELL_WINDOW_DEFAULT_HEIGHT,
  SHELL_WINDOW_DEFAULT_WIDTH,
  SHELL_WINDOW_MIN_HEIGHT,
  SHELL_WINDOW_MIN_WIDTH,
  WINDOW_BOUNDS_KEY,
  WINDOW_BOUNDS_SAVE_DEBOUNCE_MS,
  WINDOW_BOUNDS_SETTLE_MS,
  applyShellWindowState,
  installShellWindowBoundsPersistence,
  isShellWindowVisible,
  parseShellWindowState,
  readShellWindowState,
} from '../../../apps/shell/src/main/window-bounds.ts'
import { normalizeUserSkillSettings } from '../../../packages/ai-provider/src/user-skills/states.ts'
import { isValidProjectId } from '../../../packages/project-store/src/folder-api.ts'
import type { Case, Group, TsContext } from '../types.ts'

// ---- helpers

const TEMP_NAME = /\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp/g
const scrub = (message: string): string => message.replace(TEMP_NAME, '.<pid>.<uuid>.tmp')

/** Runs `fn`; a thrown error keeps its code and loses the temporary name. */
function guard<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof Error) error.message = scrub(error.message)
    throw error
  }
}

const S = 'app-settings.json'
const P = `$DIR/${S}`
const text = (value: unknown): string => JSON.stringify(value)
const settingsFile = (value: unknown): Record<string, string> => ({ [S]: text(value) })
const raw = (source: string): Record<string, string> => ({ [S]: source })
const str = (args: unknown[], i: number): string => args[i] as string

/** A constant: two cases whose folders differ, so the answers do. */
const constantCases: Case[] = [
  { args: [], note: 'empty folder' },
  { args: [], files: { 'x.txt': 'x' }, note: 'a file in the folder' },
]

/** Ten file contents of app-settings.json that read in different ways. */
const READ_FILES: [string, Record<string, string> | undefined][] = [
  ['missing', undefined],
  ['empty file', raw('')],
  ['malformed', raw('{"a":')],
  ['top-level array', raw('[1,2]')],
  ['top-level null', raw('null')],
  ['top-level string', raw('"text"')],
  ['top-level number', raw('7')],
  ['integer-like keys', raw('{"b":1,"10":"ten","2":"two","a":[1,2],"-1":"neg","01":"zero one"}')],
  ['duplicate keys', raw('{"a":1,"b":2,"a":3,"2":1,"2":2}')],
  ['byte order mark', raw('\uFEFF{"a":1}')],
  [
    'numbers',
    raw(
      '{"big":1e21,"neg":-0,"sum":0.30000000000000004,"huge":123456789012345678901234567890,"tiny":-1e-7,"exp":1.5e300,"inf":1e999,"frac":0.000001}',
    ),
  ],
  [
    'non-ascii',
    raw('{"\u0131":"\u017f","\u212a":"k","emoji":"\u{1F600}","path":"/h/\u{D55C}\u{AE00}"}'),
  ],
  [
    'control characters',
    raw('{"c":"\\u0001\\u001f\\"\\\\\\n\\t\\b\\f\\r\\u007f\\u2028","\\u0000":1}'),
  ],
  ['deep', raw('{"a":{"b":{"c":{"d":[[],{},[{"e":null}]]}}},"f":true}')],
  ['__proto__ key', raw('{"__proto__":{"x":1},"y":2}')],
  ['truncated utf-8', { [S]: { hex: '7b2261223a22ff227d' } } as unknown as Record<string, string>],
  ['a folder', { [S]: { dir: true } } as unknown as Record<string, string>],
]

const readCases = (): Case[] =>
  READ_FILES.map(([note, files]) => ({ args: [P], files, note }) as Case)

/** The same file contents, each as the base of a write. */
const writeBases = (extra: unknown[], more: boolean): Case[] =>
  READ_FILES.filter((_, i) => more || [0, 2, 3, 7, 8, 10, 11, 12, 13, 14].includes(i)).map(
    ([note, files]) => ({ args: [P, ...extra], files, note }) as Case,
  )

// ---- skills

const SKILLS_FILE = {
  skills: {
    states: {
      'user:a': { enabled: false, invoke: 'manual', editors: ['pdf', 'docs', 'docs', 'zzz'] },
      'project:p': { enabled: true },
      'plugin:x:y': { invoke: 'auto', editors: 'all' },
      'user:bad name': { enabled: true },
      'codex:ok': { editors: ['docs'], enabled: 'yes', invoke: 'always' },
      'builtin:n': [],
      'user:every': {
        editors: [
          'docs',
          'sheets',
          'slides',
          'hwp',
          'pdf',
          'markdown',
          'html',
          'mindmap',
          'epub',
          'diagram',
        ],
      },
      'user:none': { editors: ['zzz', 5] },
      'user:string': { editors: 'docs pdf' },
      'user:empty': {},
      'app:z': null,
    },
    hiddenBuiltins: ['a', '', 'a', 1, 'b', null, 'b'],
  },
  other: 1,
}

const SKILL_RAW: [string, unknown[]][] = [
  ['undefined', []],
  ['null', [null]],
  ['number', [0]],
  ['string', ['states']],
  ['array', [[]]],
  ['empty object', [{}]],
  ['full', [SKILLS_FILE.skills]],
  ['states array', [{ states: [], hiddenBuiltins: 'a' }]],
  ['states null', [{ states: null, hiddenBuiltins: null }]],
  ['hidden only', [{ hiddenBuiltins: ['x', 'y', 'x', '', 3] }]],
  [
    'plugin ids',
    [
      {
        states: {
          'plugin:a:b:c': { enabled: true },
          'plugin::x': {},
          'plugin:x': {},
          'plugin:a:': {},
          'plugin:a:b c': {},
        },
      },
    ],
  ],
  [
    'id shapes',
    [
      {
        states: {
          'user:': {},
          ':user': {},
          'unknown:a': {},
          user: {},
          'user:a\n': {},
          'user:\u0131': {},
          'user:a.b_c-d': { enabled: false },
          'user:-a': {},
          'user:.a': {},
        },
      },
    ],
  ],
  [
    'name length',
    [
      {
        states: {
          [`user:${'a'.repeat(64)}`]: { enabled: true },
          [`user:${'a'.repeat(65)}`]: { enabled: true },
        },
      },
    ],
  ],
  [
    'editors shapes',
    [
      {
        states: {
          'user:a': { editors: [] },
          'user:b': { editors: ['docs', 'docs'] },
          'user:c': { editors: 'all' },
          'user:d': { editors: 'ALL' },
          'user:e': { editors: {} },
          'user:f': { editors: ['diagram', 'docs'] },
        },
      },
    ],
  ],
  [
    'invoke shapes',
    [
      {
        states: {
          'user:a': { invoke: 'auto' },
          'user:b': { invoke: 'manual' },
          'user:c': { invoke: 'Auto' },
          'user:d': { invoke: 1 },
          'user:e': { enabled: null },
        },
      },
    ],
  ],
  ['astral', [{ hiddenBuiltins: ['\u{1F600}', '\u{1F600}'], states: { 'user:\u{1F600}': {} } }]],
]

const SKILL_WRITE: [string, unknown][] = [
  ['empty', { states: {}, hiddenBuiltins: [] }],
  [
    'states',
    {
      states: {
        'user:a': { enabled: false },
        'user:b': { invoke: 'manual' },
        'user:c': { editors: ['pdf'] },
        'user:d': { editors: 'all', enabled: true, invoke: 'auto' },
      },
      hiddenBuiltins: [],
    },
  ],
  [
    'empty states dropped',
    {
      states: { 'user:a': {}, 'user:b': { invoke: 'bogus' } },
      hiddenBuiltins: ['', 'a', 'a', 'b'],
    },
  ],
  ['hidden only', { states: {}, hiddenBuiltins: ['x', '', 'x', '\u{1F600}'] }],
  ['empty editors list', { states: { 'user:a': { editors: [] } }, hiddenBuiltins: [] }],
]

const SKILL_OPS: [string, unknown[]][] = [
  ['no ops', []],
  ['set a state', [{ op: 'set', id: 'user:a', value: { enabled: false, invoke: 'manual' } }]],
  ['replace a state', [{ op: 'set', id: 'user:a', value: { editors: ['pdf', 'docs'] } }]],
  ['set an empty state', [{ op: 'set', id: 'user:a', value: {} }]],
  [
    'hide builtins',
    [
      { op: 'hide', name: 'a' },
      { op: 'hide', name: '' },
      { op: 'hide', name: 'a' },
    ],
  ],
  ['clear hidden', [{ op: 'clearHidden' }, { op: 'set', id: 'app:x', value: { enabled: true } }]],
  ['project id is dropped on read', [{ op: 'set', id: 'project:p', value: { enabled: true } }]],
]

type SkillOp =
  | { op: 'set'; id: string; value: Record<string, unknown> }
  | { op: 'hide'; name: string }
  | { op: 'clearHidden' }

// ---- projects

const PID = 'abcDEF_-123'
const SHA = 'a'.repeat(64)
const FULL_PROJECTS = {
  installId: PID,
  list: [
    { id: 'p1', path: '/work/a', pinned: true, lastUsedAt: '2024-05-06T07:08:09.123Z' },
    { id: 'p1', path: '/work/dup', pinned: false, lastUsedAt: '2024-01-01T00:00:00Z' },
    { id: 'p2', path: 'relative/path', pinned: true, lastUsedAt: '2024-01-01' },
    { id: 'p 3', path: '/work/c', lastUsedAt: '2024-01-01' },
    { id: 'p4', path: '/work/d', pinned: 'yes', lastUsedAt: 'garbage' },
    { id: 'p5', path: '/work/e', pinned: true, lastUsedAt: '' },
    { id: 'p6', path: '/work/f', lastUsedAt: 5 },
    { id: 'p7', path: 7, lastUsedAt: '2024-01-01' },
    null,
    [],
    'p8',
    { id: '', path: '/work/g' },
    { id: 'p9', path: '/work/\u{D55C}', lastUsedAt: 'Jan 2 2020 10:00 UTC' },
  ],
  trust: {
    '10': {
      decision: 'use',
      hashes: {
        instructions: SHA,
        memory: 'A'.repeat(64),
        agents: SHA.slice(1),
        claude: SHA,
        extra: SHA,
      },
    },
    '2': { decision: 'without', hashes: {} },
    p1: { decision: 'maybe', hashes: {} },
    p2: { decision: 'use' },
    p3: { decision: 'use', hashes: [] },
    p4: null,
    'bad id': { decision: 'use' },
    ['__proto__']: { decision: 'use', hashes: {} },
    '': { decision: 'use' },
  },
  outsideDocuments: {
    '/docs/a.docx': { projectId: 'p1', lastChatId: 'c1' },
    '/docs/b.docx': { projectId: null, lastChatId: 'c1' },
    '/docs/c.docx': { projectId: 'bad id' },
    '/docs/d.docx': {},
    '/docs/e.docx': { projectId: 'p1', lastChatId: 'bad id' },
    '/docs/f.docx': { projectId: 'p1' },
    'relative.docx': { projectId: 'p1' },
    '/docs/g.docx': 'p1',
    '/docs/h.docx': { projectId: 5 },
  },
  optedOutDocuments: {
    '/docs/a.docx': { projectId: 'p1' },
    '/docs/b.docx': { projectId: null },
    '/docs/c.docx': {},
    'relative.docx': { projectId: 'p1' },
    '/docs/d.docx': [],
  },
  settings: {
    '3': { memoryEnabled: false },
    '1': { readAgentsFiles: false, memoryEnabled: 'no' },
    p1: {},
    'bad id': {},
    p2: null,
    ['__proto__']: { memoryEnabled: false },
  },
  homeProjectId: 'p1',
  syncNoticeShown: ['p1', 'p1', 'bad id', 7, null, 'p2'],
}

const PROJECT_RAW: [string, unknown[]][] = [
  ['undefined', []],
  ['null', [null]],
  ['array', [[]]],
  ['string', ['x']],
  ['empty object', [{}]],
  ['full', [FULL_PROJECTS]],
  ['install id only', [{ installId: PID, homeProjectId: null }]],
  [
    'install id invalid',
    [{ installId: 'a b', homeProjectId: 'a b', syncNoticeShown: 'p1', list: {} }],
  ],
  ['install id newline', [{ installId: 'abc\n', homeProjectId: 'abc\n' }]],
  ['install id number', [{ installId: 5, homeProjectId: 0 }]],
  [
    'home project undefined key order',
    [{ syncNoticeShown: ['b', 'a'], homeProjectId: 'z', installId: 'i' }],
  ],
  [
    'iso times',
    [
      {
        list: [
          '2020-01-01T00:00:00.000Z',
          '2020-01-01T00:00:00',
          '2020-13-45',
          '+275760-09-13T00:00:00.000Z',
          '+275760-09-13T00:00:00.001Z',
          '0000-01-01',
          '-000001-01-01T00:00:00Z',
          '  2020-01-01',
          'Tue, 02 Jan 2024 03:04:05 GMT',
          '2024-02-30',
          '2024-02-29T24:00:00Z',
          '12/25/2024',
          '1',
          '\u0131',
          '2020-01-01T00:00:00+05:30',
          'Thu Jan 01 1970 00:00:00 GMT+0000',
        ].map((lastUsedAt, i) => ({ id: `t${i}`, path: '/p', lastUsedAt })),
      },
    ],
  ],
  [
    'integer-like ids',
    [
      {
        trust: {
          b: { decision: 'use' },
          '9': { decision: 'use' },
          '10': { decision: 'without' },
          a: { decision: 'use' },
          '-1': { decision: 'use' },
        },
        settings: { z: {}, '5': {}, '05': {} },
      },
    ],
  ],
]

type ProjectOp =
  | { op: 'installId'; value: string }
  | { op: 'homeProjectId'; value: string | null }
  | { op: 'addList'; entry: Record<string, unknown> }
  | { op: 'syncNotice'; id: string }
  | { op: 'switch'; id: string; memoryEnabled?: boolean; readAgentsFiles?: boolean }
  | { op: 'trust'; id: string; decision: string; hashes?: Record<string, string> }

const PROJECT_OPS: [string, unknown[]][] = [
  ['no ops', []],
  [
    'add a project',
    [
      {
        op: 'addList',
        entry: { id: 'n1', path: '/work/new', pinned: true, lastUsedAt: '2025-01-01T00:00:00Z' },
      },
    ],
  ],
  [
    'add duplicate and invalid',
    [
      {
        op: 'addList',
        entry: { id: 'p1', path: '/other', pinned: false, lastUsedAt: '2025-01-01' },
      },
      {
        op: 'addList',
        entry: { id: 'x y', path: '/other', pinned: false, lastUsedAt: '2025-01-01' },
      },
      { op: 'addList', entry: { id: 'n2', path: 'rel', pinned: false, lastUsedAt: 'garbage' } },
    ],
  ],
  ['home project', [{ op: 'homeProjectId', value: 'p2' }]],
  ['home project null', [{ op: 'homeProjectId', value: null }]],
  ['home project invalid', [{ op: 'homeProjectId', value: 'not valid' }]],
  ['install id', [{ op: 'installId', value: 'inst' }]],
  [
    'sync notices',
    [
      { op: 'syncNotice', id: 'p1' },
      { op: 'syncNotice', id: 'p1' },
      { op: 'syncNotice', id: 'bad id' },
    ],
  ],
  [
    'switches',
    [
      { op: 'switch', id: 'p1', memoryEnabled: false },
      { op: 'switch', id: '2', readAgentsFiles: false },
      { op: 'switch', id: 'bad id', memoryEnabled: false },
    ],
  ],
  [
    'trust',
    [
      {
        op: 'trust',
        id: 'p1',
        decision: 'use',
        hashes: { memory: 'b'.repeat(64), agents: 'short' },
      },
      { op: 'trust', id: '7', decision: 'without' },
      { op: 'trust', id: 'p2', decision: 'maybe' },
    ],
  ],
]

const PROJECTS_BASES: [string, Record<string, string> | undefined][] = [
  ['missing file', undefined],
  ['no projects key', raw('{"a":1}')],
  ['full projects', raw(text({ keep: 1, projects: FULL_PROJECTS, zed: 2 }))],
  [
    'projects with integer keys',
    raw(
      '{"projects":{"trust":{"10":{"decision":"use"},"2":{"decision":"use"}},"homeProjectId":null}}',
    ),
  ],
]

// ---- agent project prefs

const PREF_RAW: [string, unknown[]][] = [
  ['undefined', []],
  ['null', [null]],
  ['array', [[]]],
  ['string', ['x']],
  ['empty', [{}]],
  [
    'mixed',
    [
      {
        '/a': { codexNetwork: true, codexWebSearch: 'live' },
        '/b': { codexWebSearch: 'bogus', codexNetwork: 'yes' },
        '/c': { codexWebSearch: 'disabled' },
        '/d': { codexNetwork: false },
        relative: { codexNetwork: true },
        '': { codexNetwork: true },
        '/e': null,
        '/f': [],
        '/g': 'live',
        '/h': 5,
        '/i': { codexWebSearch: 'cached', codexNetwork: true, extra: 1 },
        '/\u{D55C}': { codexWebSearch: 'LIVE' },
        '/\u0131': { codexNetwork: true },
      },
    ],
  ],
]

const PREF_FILE = {
  [AGENT_PROJECT_PREFS_KEY]: {
    '/x/y': { codexWebSearch: 'live', codexNetwork: true },
    '/x/net': { codexNetwork: true },
    '/x/web': { codexWebSearch: 'disabled' },
    '/x/z/': { codexWebSearch: 'live' },
    '/x/bad': { codexWebSearch: 'nope' },
  },
  other: 'kept',
}

// ---- the group

export const group: Group = {
  // ---- states.ts, folder-api.ts
  'states.normalizeUserSkillSettings': {
    ts: (args) => normalizeUserSkillSettings(args[0]),
    cases: SKILL_RAW.map(([note, args]) => ({ args, note })),
  },
  'folder-api.isValidProjectId': {
    ts: (args) => isValidProjectId(args[0]),
    cases: [
      ...[
        'abc',
        'ABC_-09',
        '',
        ' ',
        'a b',
        'a.b',
        'abc\n',
        '\nabc',
        '\u0131',
        '\u212a',
        '\u017f',
        '\u{1F600}',
        '__proto__',
        '0',
        'a'.repeat(300),
      ].map((value) => ({ args: [value], note: JSON.stringify(value).slice(0, 20) })),
      { args: [], note: 'undefined' },
      { args: [null], note: 'null' },
      { args: [5], note: 'number' },
      { args: [['a']], note: 'array' },
    ],
  },

  // ---- app-settings.ts
  'app-settings.readAppSettings': {
    ts: (args) => readAppSettings(str(args, 0)),
    cases: [...readCases(), { args: ['$DIR/nested/none.json'], note: 'missing folder' }],
  },
  'app-settings.writeAppSettings': {
    ts: (args) => guard(() => writeAppSettings(str(args, 0), args[1] as Record<string, unknown>)),
    cases: [
      ...writeBases([{ added: 1, '2': 'two', a: null }], true),
      { args: [P, {}], note: 'no updates, no file' },
      { args: [P, {}], files: raw('{"b":1,"a":2}'), note: 'no updates rewrites with two spaces' },
      {
        args: [
          P,
          {
            b: { deep: [1, [2, { c: 3 }], {}, []] },
            big: 1e21,
            sum: 0.1 + 0.2,
            tiny: 1e-7,
            neg: -1.5e-10,
          },
        ],
        files: raw('{"b":1,"a":2}'),
        note: 'values replaced in place',
      },
      {
        args: [P, { s: 'line\nbreak \u0001 \u007f \u2028 \u{1F600} \u0131 \\ "q"' }],
        note: 'string escapes',
      },
      {
        args: [P, { __proto__x: 1, ['__proto__']: { p: 1 } }],
        files: raw('{"a":1}'),
        note: 'own __proto__ key',
      },
      { args: ['$DIR/nope/s.json', { a: 1 }], note: 'folder missing: open fails' },
      {
        args: ['$DIR/d', { a: 1 }],
        files: { d: { dir: true } } as never,
        note: 'destination is a folder: rename fails, temp removed',
      },
      {
        args: [P, { a: 1 }],
        files: { [S]: { text: '{"x":1}', mode: 0o444 }, '.': { dir: true, mode: 0o555 } } as never,
        note: 'read-only folder',
      },
      { args: [`$DIR/\u{D55C}\u{AE00}.json`, { a: 1 }], note: 'non-ascii path' },
    ],
  },
  'app-settings.writeAppSetting': {
    ts: (args) => guard(() => writeAppSetting(str(args, 0), str(args, 1), args[2])),
    cases: [
      { args: [P, 'a', 1], note: 'no file' },
      { args: [P, 'a'], files: raw('{"a":1,"b":2}'), note: 'undefined removes the key' },
      { args: [P, 'zzz'], files: raw('{"a":1}'), note: 'undefined on an absent key' },
      {
        args: [P, '2', { n: [1, 2] }],
        files: raw('{"a":1,"10":1,"3":1}'),
        note: 'integer-like key goes first',
      },
      { args: [P, 'a', null], files: raw('{"a":1,"b":2}'), note: 'null is kept' },
      { args: [P, 'k', 0.1 + 0.2], files: raw('[1]'), note: 'array replaced by an object' },
      { args: [P, 'k', 1e21], files: raw('{"k":-0}'), note: '1e21 and -0' },
      { args: [P, '__proto__', { p: 1 }], files: raw('{"a":1}'), note: 'own __proto__' },
      { args: [P, '', 'empty key'], note: 'empty key' },
      { args: [P, '\u0131', '\u{1F600}'], files: raw('{"\u212a":1}'), note: 'non-ascii key' },
      { args: ['$DIR/nope/s.json', 'a', 1], note: 'folder missing' },
      {
        args: ['$DIR/d', 'a', 1],
        files: { d: { dir: true } } as never,
        note: 'destination is a folder',
      },
    ],
  },
  'app-settings.writeAppSettingThen': {
    ts: (args) => {
      let called = false
      let seen: unknown
      guard(() =>
        writeAppSettingThen(str(args, 0), str(args, 1), args[2], (value) => {
          called = true
          seen = value
        }),
      )
      return { called, with: seen }
    },
    cases: [
      { args: [P, 'a', { b: 1 }], note: 'written, then applied' },
      { args: [P, 'a'], files: raw('{"a":1}'), note: 'undefined applied' },
      { args: [P, 'a', 0.1 + 0.2], note: 'number applied' },
      { args: ['$DIR/nope/s.json', 'a', 1], note: 'write fails: apply is not called' },
      { args: ['$DIR/d', 'a', 1], files: { d: { dir: true } } as never, note: 'rename fails' },
    ],
  },
  'app-settings.SKILLS_SETTING_KEY': { ts: () => SKILLS_SETTING_KEY, cases: constantCases },
  'app-settings.AGENT_SKILL_NOTICE_KEY': { ts: () => AGENT_SKILL_NOTICE_KEY, cases: constantCases },
  'app-settings.AGENT_PROJECT_PREFS_KEY': {
    ts: () => AGENT_PROJECT_PREFS_KEY,
    cases: constantCases,
  },
  'app-settings.PROJECTS_SETTING_KEY': { ts: () => PROJECTS_SETTING_KEY, cases: constantCases },
  'app-settings.DEFAULT_AGENT_PROJECT_PREF': {
    ts: () => DEFAULT_AGENT_PROJECT_PREF,
    cases: constantCases,
  },
  'app-settings.readSkillSettings': {
    ts: (args) => readSkillSettings(str(args, 0)),
    cases: [
      { args: [P], note: 'missing' },
      { args: [P], files: settingsFile(SKILLS_FILE), note: 'many shapes' },
      { args: [P], files: settingsFile({ skills: [] }), note: 'skills is an array' },
      { args: [P], files: settingsFile({ skills: null }), note: 'skills is null' },
      {
        args: [P],
        files: raw(
          '{"skills":{"hiddenBuiltins":["b","a","b"],"states":{"app:q":{"enabled":true}}}}',
        ),
        note: 'hidden and one state',
      },
      { args: [P], files: raw('[]'), note: 'top-level array' },
    ],
  },
  'app-settings.writeSkillSettings': {
    ts: (args) => guard(() => writeSkillSettings(str(args, 0), args[1] as never)),
    cases: [
      ...SKILL_WRITE.map(
        ([note, value]) =>
          ({ args: [P, value], files: raw('{"keep":1,"skills":{"old":1}}'), note }) as Case,
      ),
      { args: [P, SKILL_WRITE[1]![1]], note: 'no file' },
      { args: ['$DIR/nope/s.json', SKILL_WRITE[1]![1]], note: 'folder missing' },
    ],
  },
  'app-settings.updateSkillSettings': {
    ts: (args) =>
      guard(() =>
        updateSkillSettings(str(args, 0), (settings) => {
          for (const op of args[1] as SkillOp[]) {
            if (op.op === 'set') settings.states[op.id] = op.value as never
            else if (op.op === 'hide') settings.hiddenBuiltins.push(op.name)
            else settings.hiddenBuiltins = []
          }
        }),
      ),
    cases: [
      ...SKILL_OPS.map(
        ([note, ops]) => ({ args: [P, ops], files: settingsFile(SKILLS_FILE), note }) as Case,
      ),
      { args: [P, SKILL_OPS[1]![1]], note: 'no file' },
      { args: ['$DIR/nope/s.json', SKILL_OPS[1]![1]], note: 'write fails' },
    ],
  },
  'app-settings.agentSkillNoticeDue': {
    ts: (args) => agentSkillNoticeDue(str(args, 0)),
    cases: [
      { args: [P], note: 'missing' },
      ...[1, 2, 0, -1, 1.5, '1', 1e21, true, null].map(
        (accepted) =>
          ({
            args: [P],
            files: settingsFile({ agent: { warningAccepted: accepted } }),
            note: `accepted ${JSON.stringify(accepted)}`,
          }) as Case,
      ),
      {
        args: [P],
        files: settingsFile({ agent: { warningAccepted: 1 }, [AGENT_SKILL_NOTICE_KEY]: true }),
        note: 'notice seen',
      },
      {
        args: [P],
        files: settingsFile({ agent: { warningAccepted: 1 }, [AGENT_SKILL_NOTICE_KEY]: false }),
        note: 'notice false',
      },
      {
        args: [P],
        files: settingsFile({ agent: { warningAccepted: 1 }, [AGENT_SKILL_NOTICE_KEY]: 'true' }),
        note: 'notice string',
      },
      { args: [P], files: settingsFile({ agent: [1] }), note: 'agent array' },
      { args: [P], files: settingsFile({ agent: 'x' }), note: 'agent string' },
      { args: [P], files: settingsFile({ agent: null }), note: 'agent null' },
    ],
  },
  'app-settings.markAgentSkillNoticeSeen': {
    ts: (args) => guard(() => markAgentSkillNoticeSeen(str(args, 0))),
    cases: [
      { args: [P], note: 'missing' },
      { args: [P], files: raw('{"b":1,"2":2}'), note: 'other keys kept' },
      {
        args: [P],
        files: settingsFile({ [AGENT_SKILL_NOTICE_KEY]: false, z: 1 }),
        note: 'false becomes true',
      },
      { args: ['$DIR/nope/s.json'], note: 'folder missing' },
    ],
  },
  'app-settings.writeAgentPrefs': {
    ts: (args) => guard(() => writeAgentPrefs(str(args, 0), args[1] as never)),
    cases: [
      { args: [P, { warningAccepted: 1 }], note: 'first acceptance records the notice' },
      {
        args: [P, { warningAccepted: 1 }],
        files: settingsFile({ agent: { warningAccepted: 1 } }),
        note: 'already accepted',
      },
      {
        args: [P, { warningAccepted: 2 }],
        files: settingsFile({ [AGENT_SKILL_NOTICE_KEY]: false }),
        note: 'notice already decided',
      },
      {
        args: [P, { warningAccepted: 1 }],
        files: settingsFile({ [AGENT_SKILL_NOTICE_KEY]: null }),
        note: 'notice null is defined',
      },
      { args: [P, { warningAccepted: 0 }], note: 'not accepted' },
      { args: [P, { warningAccepted: 1.5 }], note: 'not an integer' },
      {
        args: [P, { warningAccepted: 1, extra: [1, { a: 2 }] }],
        files: settingsFile({ agent: { warningAccepted: 0 } }),
        note: 'extra keys written',
      },
      {
        args: [P, { warningAccepted: 1 }],
        files: settingsFile({ agent: { warningAccepted: 1e21 } }),
        note: 'accepted 1e21',
      },
      { args: [P, { warningAccepted: 3 }], files: raw('[]'), note: 'top-level array' },
      { args: ['$DIR/nope/s.json', { warningAccepted: 1 }], note: 'folder missing' },
    ],
  },
  'app-settings.normalizeAgentProjectPrefs': {
    ts: (args) => normalizeAgentProjectPrefs(args[0]),
    cases: PREF_RAW.map(([note, args]) => ({ args, note })),
  },
  'app-settings.readAgentProjectPref': {
    ts: (args) => readAgentProjectPref(str(args, 0), str(args, 1)),
    cases: [
      { args: [P, '/x/y'], files: settingsFile(PREF_FILE), note: 'both stored' },
      {
        args: [P, '/x/y/../y'],
        files: settingsFile(PREF_FILE),
        note: 'another spelling of the same folder',
      },
      { args: [P, '/x/z'], files: settingsFile(PREF_FILE), note: 'trailing slash key matches' },
      { args: [P, '/x/net'], files: settingsFile(PREF_FILE), note: 'only the network stored' },
      { args: [P, '/x/web'], files: settingsFile(PREF_FILE), note: 'only the search stored' },
      { args: [P, '/x/bad'], files: settingsFile(PREF_FILE), note: 'invalid dropped, defaults' },
      { args: [P, '/X/Y'], files: settingsFile(PREF_FILE), note: 'case differs' },
      { args: [P, '/unknown'], files: settingsFile(PREF_FILE), note: 'unknown folder' },
      { args: [P, '/x/y'], note: 'missing file' },
      { args: [P, 'relative'], files: settingsFile(PREF_FILE), note: 'relative folder reads' },
      {
        args: [P, '/x/y'],
        files: settingsFile({ [AGENT_PROJECT_PREFS_KEY]: [] }),
        note: 'prefs array',
      },
    ],
  },
  'app-settings.writeAgentProjectPref': {
    ts: (args) => guard(() => writeAgentProjectPref(str(args, 0), str(args, 1), args[2] as never)),
    cases: [
      { args: [P, '/x/new', { codexWebSearch: 'live', codexNetwork: true }], note: 'new folder' },
      { args: [P, '/x/new', {}], note: 'empty patch stores an empty entry' },
      {
        args: [P, '/x/net', { codexWebSearch: 'live' }],
        files: settingsFile(PREF_FILE),
        note: 'search added after the network key',
      },
      {
        args: [P, '/x/y/../y', { codexNetwork: false }],
        files: settingsFile(PREF_FILE),
        note: 'matches an earlier spelling',
      },
      {
        args: [P, '/x/web', { codexNetwork: 'yes', codexWebSearch: 'bogus' }],
        files: settingsFile(PREF_FILE),
        note: 'invalid patch values ignored',
      },
      {
        args: [P, '/x/z', { codexNetwork: true }],
        files: settingsFile(PREF_FILE),
        note: 'trailing slash key kept',
      },
      { args: [P, 'relative/dir', { codexNetwork: true }], note: 'relative folder throws' },
      { args: [P, '', {}], note: 'empty folder throws' },
      {
        args: [P, '/x/\u{D55C}', { codexWebSearch: 'disabled' }],
        files: raw('{"agentProjectPrefs":[1]}'),
        note: 'prefs array replaced',
      },
      { args: ['$DIR/nope/s.json', '/x/y', { codexNetwork: true }], note: 'folder missing' },
    ],
  },
  'app-settings.normalizeProjectsSettings': {
    ts: (args) => normalizeProjectsSettings(args[0]),
    cases: PROJECT_RAW.map(([note, args]) => ({ args, note })),
  },
  'app-settings.readProjectsSettings': {
    ts: (args) => readProjectsSettings(str(args, 0)),
    cases: PROJECTS_BASES.map(([note, files]) => ({ args: [P], files, note }) as Case),
  },
  'app-settings.writeProjectsSettings': {
    ts: (args) => guard(() => writeProjectsSettings(str(args, 0), args[1] as never)),
    cases: [
      ...PROJECT_RAW.map(
        ([note, args]) => ({ args: [P, ...args], files: raw('{"keep":1}'), note }) as Case,
      ),
      { args: ['$DIR/nope/s.json', {}], note: 'folder missing' },
    ],
  },
  'app-settings.updateProjectsSettings': {
    ts: (args) =>
      guard(() =>
        updateProjectsSettings(str(args, 0), (settings) => {
          for (const op of args[1] as ProjectOp[]) {
            if (op.op === 'installId') settings.installId = op.value
            else if (op.op === 'homeProjectId') settings.homeProjectId = op.value
            else if (op.op === 'addList') settings.list.push(op.entry as never)
            else if (op.op === 'syncNotice') settings.syncNoticeShown.push(op.id)
            else if (op.op === 'switch') {
              settings.settings[op.id] = {
                memoryEnabled: op.memoryEnabled !== false,
                readAgentsFiles: op.readAgentsFiles !== false,
              }
            } else {
              settings.trust[op.id] = { decision: op.decision, hashes: op.hashes ?? {} } as never
            }
          }
        }),
      ),
    cases: [
      ...PROJECT_OPS.map(
        ([note, ops]) =>
          ({
            args: [P, ops],
            files: settingsFile({ keep: 1, projects: FULL_PROJECTS }),
            note,
          }) as Case,
      ),
      ...PROJECT_OPS.slice(1, 4).map(
        ([note, ops]) => ({ args: [P, ops], note: `${note}, no file` }) as Case,
      ),
      {
        args: [P, PROJECT_OPS[1]![1]],
        files: raw(
          '{"projects":{"trust":{"10":{"decision":"use"},"2":{"decision":"use"}},"homeProjectId":null}}',
        ),
        note: 'integer-like keys',
      },
      { args: ['$DIR/nope/s.json', PROJECT_OPS[1]![1]], note: 'write fails' },
    ],
  },

  // ---- folder-roots.ts
  'folder-roots.FOLDER_ROOTS_KEY': { ts: () => FOLDER_ROOTS_KEY, cases: constantCases },
  'folder-roots.readExtraRoots': {
    ts: (args) => readExtraRoots(args[0] as Record<string, unknown>, str(args, 1)),
    cases: [
      { args: [{}, '$DIR/def'], note: 'no key' },
      { args: [{ folderRoots: 'x' }, '$DIR/def'], note: 'not an array' },
      { args: [{ folderRoots: [] }, '$DIR/def'], note: 'empty' },
      {
        args: [
          {
            folderRoots: [
              '$DIR/a',
              '$DIR/a/',
              '$DIR/./a',
              '$DIR/b/../a',
              '$DIR/def',
              '$DIR/def/',
              '$DIR/c',
            ],
          },
          '$DIR/def',
        ],
        note: 'duplicates after resolve',
      },
      {
        args: [{ folderRoots: ['rel/a', '', 5, null, ['/x'], { a: 1 }, true, '/ok'] }, '$DIR/def'],
        note: 'entries that are skipped',
      },
      {
        args: [
          {
            folderRoots: ['/x/\u{D55C}', '/x/\u0131', '/x/I', '/x/\u{1F600}', '/x/\u212a', '/x/K'],
          },
          '/x/\u0131',
        ],
        note: 'non-ascii and case',
      },
      { args: [{ folderRoots: ['/a', '/b'], other: 1 }, '/'], note: 'root default' },
      {
        args: [{ folderRoots: ['/a//b', '/a/b', '/a/b/.', '//a/b'] }, '/z'],
        note: 'double slashes',
      },
    ],
  },
  'folder-roots.withExtraRoot': {
    ts: (args) => withExtraRoot(args[0] as string[], str(args, 1), str(args, 2)),
    cases: [
      { args: [[], '$DIR/def', '$DIR/new'], note: 'appended' },
      { args: [['$DIR/a'], '$DIR/def', '$DIR/a/'], note: 'already an extra' },
      { args: [['$DIR/a'], '$DIR/def', '$DIR/def/x/..'], note: 'the default folder' },
      { args: [['$DIR/a'], '$DIR/def', 'rel/x'], note: 'relative path appended as given' },
      { args: [['/a', '/b'], '/z', '/b/../c'], note: 'appended unresolved' },
      { args: [['/x/\u{D55C}'], '/z', '/x/\u{D55C}/'], note: 'non-ascii duplicate' },
    ],
  },
  'folder-roots.withoutExtraRoot': {
    ts: (args) => withoutExtraRoot(args[0] as string[], str(args, 1)),
    cases: [
      { args: [[], '/a'], note: 'empty' },
      { args: [['/a', '/b', '/a/'], '/a'], note: 'removes spellings of one folder' },
      { args: [['/a', '/b'], '/c'], note: 'absent' },
      { args: [['/a', 'rel', '/b'], 'rel/../rel'], note: 'relative against cwd' },
      { args: [['/x/\u{D55C}', '/x/\u{1F600}'], '/x/./\u{D55C}'], note: 'non-ascii' },
    ],
  },
  'folder-roots.describeExtraRoot': {
    ts: (args) => describeExtraRoot(str(args, 0)),
    cases: [
      { args: ['$DIR/d'], files: { d: { dir: true } } as never, note: 'a usable folder' },
      { args: ['$DIR/d/'], files: { d: { dir: true } } as never, note: 'trailing slash' },
      { args: ['$DIR/f'], files: { f: 'x' }, note: 'a file' },
      { args: ['$DIR/none'], note: 'missing' },
      {
        args: ['$DIR/ro'],
        files: { ro: { dir: true, mode: 0o555 } } as never,
        note: 'read-only folder',
      },
      {
        args: ['$DIR/wo'],
        files: { wo: { dir: true, mode: 0o333 } } as never,
        note: 'write-only folder',
      },
      { args: ['$DIR/no'], files: { no: { dir: true, mode: 0 } } as never, note: 'no access' },
      { args: ['/'], note: 'root has no basename' },
      { args: [''], note: 'empty path' },
      {
        args: ['$DIR/\u{D55C}\u{AE00}'],
        files: { '\u{D55C}\u{AE00}': { dir: true } } as never,
        note: 'non-ascii folder',
      },
      {
        args: ['$DIR/a\u{1F600}'],
        files: { 'a\u{1F600}': { dir: true } } as never,
        note: 'astral name',
      },
      { args: ['$DIR/a\u0000b'], note: 'NUL in the path' },
      { args: ['rel/none'], note: 'relative path' },
    ],
  },

  // ---- split-memory.ts
  'split-memory.SPLIT_MEMORY_SETTING_KEY': {
    ts: () => SPLIT_MEMORY_SETTING_KEY,
    cases: constantCases,
  },
  'split-memory.readSplitMemory': {
    ts: (args, cx) => readSplitMemory(splitOptions(args[0], cx)),
    cases: [
      ...(
        [
          ['minimal', { version: 1, a: '/a' }],
          [
            'both and all keys',
            { version: 1, a: '/a', b: '/b', orientation: 'stack', ratio: 0.5, focus: 'b' },
          ],
          ['empty b dropped', { version: 1, a: '/a', b: '' }],
          ['b not a string', { version: 1, a: '/a', b: 5 }],
          ['b null', { version: 1, a: '/a', b: null }],
          ['ratio clamped low', { version: 1, a: '/a', ratio: 0.1 }],
          ['ratio clamped high', { version: 1, a: '/a', ratio: 3 }],
          ['ratio negative', { version: 1, a: '/a', ratio: -0.5 }],
          ['ratio string', { version: 1, a: '/a', ratio: '0.5' }],
          ['ratio null', { version: 1, a: '/a', ratio: null }],
          ['version 2', { version: 2, a: '/a' }],
          ['version string', { version: '1', a: '/a' }],
          ['a empty', { version: 1, a: '' }],
          ['a number', { version: 1, a: 5 }],
          ['orientation bad', { version: 1, a: '/a', orientation: 'diagonal' }],
          ['focus bad', { version: 1, a: '/a', focus: 'c' }],
          ['unknown keys dropped', { version: 1, a: '/\u{D55C}', zzz: 1 }],
          ['array', []],
          ['null', null],
          ['string', 'x'],
        ] as [string, unknown][]
      ).map(
        ([note, value]) =>
          ({
            args: [{ settingsPath: P }],
            files: settingsFile({ [SPLIT_MEMORY_SETTING_KEY]: value }),
            note,
          }) as Case,
      ),
      {
        args: [{ settingsPath: P }],
        files: raw('{"splitView":{"version":1,"a":"/a","ratio":1e999}}'),
        note: 'ratio infinite',
      },
      {
        args: [{ settingsPath: P }],
        files: raw('{"splitView":{"version":1.0,"a":"/a","ratio":-0}}'),
        note: 'ratio negative zero',
      },
      { args: [{ settingsPath: P }], note: 'missing file' },
      {
        args: [{ settingsPath: P }],
        files: raw('{"splitview":{"version":1,"a":"/a"}}'),
        note: 'key spelled differently',
      },
      {
        args: [{ settingsPath: P, lazy: true }],
        files: settingsFile({ splitView: { version: 1, a: '/a' } }),
        note: 'path from a function',
      },
      {
        args: [
          { settingsPath: '/x', fakeRead: { splitView: { version: 1, a: '/hook', ratio: 0.7 } } },
        ],
        note: 'readSettings hook',
      },
      {
        args: [{ settingsPath: '/x', lazy: true, fakeRead: {} }],
        note: 'both hooks, nothing stored',
      },
    ],
  },
  'split-memory.writeSplitMemory': {
    ts: (args, cx) => guard(() => writeSplitMemory(args[0] as never, splitOptions(args[1], cx))),
    cases: [
      ...(
        [
          ['a only', { aTabIdPath: '/a' }],
          ['b only becomes a', { bTabIdPath: '/b' }],
          ['both', { aTabIdPath: '/a', bTabIdPath: '/b' }],
          ['empty paths clear', { aTabIdPath: '', bTabIdPath: '' }],
          ['empty a, b set', { aTabIdPath: '', bTabIdPath: '/b' }],
          ['no paths clear', {}],
          ['non-string path', { aTabIdPath: 5, bTabIdPath: '/b' }],
          [
            'everything',
            { aTabIdPath: '/a', bTabIdPath: '/b', orientation: 'stack', ratio: 0.55, focus: 'a' },
          ],
          ['orientation side', { aTabIdPath: '/a', orientation: 'side' }],
          ['orientation bad', { aTabIdPath: '/a', orientation: 'x' }],
          ['ratio low', { aTabIdPath: '/a', ratio: -4 }],
          ['ratio high', { aTabIdPath: '/a', ratio: 1e300 }],
          ['ratio fraction', { aTabIdPath: '/a', ratio: 0.1 + 0.2 }],
          ['ratio exactly low', { aTabIdPath: '/a', ratio: 0.2 }],
          ['ratio string', { aTabIdPath: '/a', ratio: '0.5' }],
          ['focus bad', { aTabIdPath: '/a', focus: 'z' }],
          ['astral and non-ascii', { aTabIdPath: '/\u{1F600}', bTabIdPath: '/\u0131\u212a' }],
        ] as [string, unknown][]
      ).map(
        ([note, state]) =>
          ({
            args: [state, { settingsPath: P }],
            files: raw('{"splitView":{"old":1},"keep":[1]}'),
            note,
          }) as Case,
      ),
      {
        args: [null, { settingsPath: P }],
        files: raw('{"splitView":{"version":1,"a":"/a"},"keep":1}'),
        note: 'null state clears',
      },
      { args: [{ aTabIdPath: '/a' }, { settingsPath: P }], note: 'no file' },
      { args: [{ aTabIdPath: '/a' }, { settingsPath: '$DIR/nope/s.json' }], note: 'write fails' },
      {
        args: [
          { aTabIdPath: '/a', bTabIdPath: '/b', ratio: 0.3 },
          { settingsPath: '/p', fakeWrite: true },
        ],
        note: 'writeSetting hook',
      },
      {
        args: [null, { settingsPath: '/p', fakeWrite: true, lazy: true }],
        note: 'hook sees undefined',
      },
      {
        args: [{}, { settingsPath: '/p', fakeWrite: true, lazy: true }],
        note: 'empty state through the hook',
      },
    ],
  },
  'split-memory.clearSplitMemory': {
    ts: (args, cx) => guard(() => clearSplitMemory(splitOptions(args[0], cx))),
    cases: [
      {
        args: [{ settingsPath: P }],
        files: raw('{"splitView":{"a":1},"z":1,"2":2}'),
        note: 'key removed',
      },
      { args: [{ settingsPath: P }], note: 'no file writes an empty object' },
      { args: [{ settingsPath: P }], files: raw('[]'), note: 'array replaced' },
      { args: [{ settingsPath: '$DIR/nope/s.json' }], note: 'write fails' },
      { args: [{ settingsPath: '/p', fakeWrite: true, lazy: true }], note: 'through the hook' },
    ],
  },

  // ---- window-bounds.ts
  'window-bounds.WINDOW_BOUNDS_KEY': { ts: () => WINDOW_BOUNDS_KEY, cases: constantCases },
  'window-bounds.SHELL_WINDOW_DEFAULT_WIDTH': {
    ts: () => SHELL_WINDOW_DEFAULT_WIDTH,
    cases: constantCases,
  },
  'window-bounds.SHELL_WINDOW_DEFAULT_HEIGHT': {
    ts: () => SHELL_WINDOW_DEFAULT_HEIGHT,
    cases: constantCases,
  },
  'window-bounds.SHELL_WINDOW_MIN_WIDTH': {
    ts: () => SHELL_WINDOW_MIN_WIDTH,
    cases: constantCases,
  },
  'window-bounds.SHELL_WINDOW_MIN_HEIGHT': {
    ts: () => SHELL_WINDOW_MIN_HEIGHT,
    cases: constantCases,
  },
  'window-bounds.WINDOW_BOUNDS_SAVE_DEBOUNCE_MS': {
    ts: () => WINDOW_BOUNDS_SAVE_DEBOUNCE_MS,
    cases: constantCases,
  },
  'window-bounds.WINDOW_BOUNDS_SETTLE_MS': {
    ts: () => WINDOW_BOUNDS_SETTLE_MS,
    cases: constantCases,
  },
  'window-bounds.parseShellWindowState': {
    ts: (args) => parseShellWindowState(args[0]),
    cases: (
      [
        ['undefined', undefined],
        ['null', null],
        ['array', []],
        ['number', 5],
        ['string', 'x'],
        ['valid', { x: 10, y: 20, width: 1200, height: 800 }],
        ['maximized', { x: 0, y: 0, width: 720, height: 550, maximized: true }],
        ['maximized as string', { x: 0, y: 0, width: 720, height: 550, maximized: 'true' }],
        ['fractions rounded', { x: 10.5, y: -0.5, width: 800.4999, height: 600.5 }],
        ['half rounds toward +infinity', { x: -2.5, y: 2.5, width: 719.5, height: 549.5 }],
        ['negative zero', { x: -0.4, y: -0, width: 720, height: 550 }],
        ['too narrow', { x: 0, y: 0, width: 719.4, height: 600 }],
        ['too short', { x: 0, y: 0, width: 800, height: 549.4 }],
        ['at the maximum', { x: 0, y: 0, width: 8192.4, height: 8192 }],
        ['past the maximum width', { x: 0, y: 0, width: 8192.5, height: 800 }],
        ['past the maximum height', { x: 0, y: 0, width: 800, height: 8193 }],
        ['x as string', { x: '10', y: 0, width: 800, height: 600 }],
        ['y missing', { x: 1, width: 800, height: 600 }],
        ['x null', { x: null, y: 0, width: 800, height: 600 }],
        ['huge position', { x: 1e21, y: -1e21, width: 800, height: 600 }],
        ['sum fraction', { x: 0.1 + 0.2, y: 1 / 3, width: 800, height: 600 }],
        ['array with keys', Object.assign([], { x: 1, y: 2, width: 800, height: 600 })],
        ['extra keys dropped', { height: 600, width: 800, y: 1, x: 2, z: 3, maximized: true }],
      ] as [string, unknown][]
    ).map(([note, value]) => ({ args: value === undefined ? [] : [value], note }) as Case),
  },
  'window-bounds.isShellWindowVisible': {
    ts: (args) => isShellWindowVisible(args[0] as never, args[1] as never),
    cases: (
      [
        [
          'inside',
          { x: 100, y: 100, width: 800, height: 600 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
        ['no displays', { x: 0, y: 0, width: 800, height: 600 }, []],
        [
          'exactly 120 wide',
          { x: 1800, y: 0, width: 800, height: 600 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
        [
          '119 wide',
          { x: 1801, y: 0, width: 800, height: 600 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
        [
          'left edge 120',
          { x: -680, y: 0, width: 800, height: 600 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
        [
          'left edge 119',
          { x: -681, y: 0, width: 800, height: 600 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
        [
          'strip 12 rows',
          { x: 0, y: 1068, width: 800, height: 600 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
        [
          'strip 11 rows',
          { x: 0, y: 1069, width: 800, height: 600 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
        [
          'above the display',
          { x: 0, y: -28, width: 800, height: 600 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
        [
          'above, 11 rows',
          { x: 0, y: -29, width: 800, height: 600 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
        [
          'short window',
          { x: 0, y: 0, width: 800, height: 10 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
        [
          'short window, 10 of 10 rows',
          { x: 0, y: 1070, width: 800, height: 10 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
        [
          'short window, 9 of 10 rows',
          { x: 0, y: 1071, width: 800, height: 10 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
        [
          'zero height',
          { x: 0, y: 0, width: 800, height: 0 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
        [
          'second display',
          { x: 2000, y: 100, width: 800, height: 600 },
          [
            { x: 0, y: 0, width: 1920, height: 1080 },
            { x: 1920, y: 0, width: 1920, height: 1080 },
          ],
        ],
        [
          'unplugged display',
          { x: 2000, y: 100, width: 800, height: 600 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
        [
          'display on the left',
          { x: -1500, y: 0, width: 800, height: 600 },
          [
            { x: -1920, y: 0, width: 1920, height: 1080 },
            { x: 0, y: 0, width: 1920, height: 1080 },
          ],
        ],
        [
          'fractions',
          { x: 0.1 + 0.2, y: 0.5, width: 119.7, height: 600.25 },
          [{ x: 0.3, y: 0.1, width: 1000.5, height: 1000.5 }],
        ],
        [
          'fraction boundary',
          { x: -0.1, y: 0, width: 120.1, height: 600 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
        [
          'huge',
          { x: 1e21, y: 0, width: 1e21, height: 600 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
        [
          'display with no size',
          { x: 0, y: 0, width: 800, height: 600 },
          [{ x: 0, y: 0, width: 0, height: 0 }],
        ],
        [
          'negative size',
          { x: 0, y: 0, width: -800, height: 600 },
          [{ x: 0, y: 0, width: 1920, height: 1080 }],
        ],
      ] as [string, unknown, unknown][]
    ).map(([note, state, areas]) => ({ args: [state, areas], note }) as Case),
  },
  'window-bounds.readShellWindowState': {
    ts: (args) => readShellWindowState(str(args, 0), args[1] as never),
    cases: (
      [
        [
          'visible',
          raw('{"windowBounds":{"x":10,"y":20,"width":1200,"height":800,"maximized":true}}'),
        ],
        [
          'visible, rounded',
          raw('{"windowBounds":{"x":10.5,"y":20.5,"width":1200.4,"height":800.6}}'),
        ],
        ['off screen', raw('{"windowBounds":{"x":5000,"y":20,"width":1200,"height":800}}')],
        ['too small', raw('{"windowBounds":{"x":0,"y":0,"width":100,"height":100}}')],
        ['not an object', raw('{"windowBounds":7}')],
        ['no key', raw('{"x":0}')],
        ['missing', undefined],
        ['malformed', raw('{')],
      ] as [string, Record<string, string> | undefined][]
    )
      .map(
        ([note, files]) =>
          ({ args: [P, [{ x: 0, y: 0, width: 1920, height: 1080 }]], files, note }) as Case,
      )
      .concat([
        {
          args: [P, []],
          files: raw('{"windowBounds":{"x":10,"y":20,"width":1200,"height":800}}'),
          note: 'no display',
        },
      ]),
  },
  'window-bounds.applyShellWindowState': {
    ts: (args) => {
      const w = args[0] as { bounds: unknown; reported?: unknown }
      const calls: unknown[] = []
      let bounds = w.bounds
      const win = {
        setContentBounds(b: unknown): void {
          bounds = b
          calls.push(['set', b])
        },
        getContentBounds: () => (w.reported ?? bounds) as never,
        maximize(): void {
          calls.push(['maximize'])
        },
      }
      const baseline = applyShellWindowState(win, args[1] as never)
      return { baseline, calls }
    },
    cases: [
      { args: [{ bounds: { x: 1, y: 2, width: 3, height: 4 } }, null], note: 'no state' },
      {
        args: [
          { bounds: { x: 1, y: 2, width: 3, height: 4 } },
          { x: 10, y: 20, width: 1200, height: 800, maximized: false },
        ],
        note: 'applied, reads back the same',
      },
      {
        args: [
          {
            bounds: { x: 1, y: 2, width: 3, height: 4 },
            reported: { x: 838, y: 20, width: 1218, height: 800 },
          },
          { x: 837, y: 20, width: 1217, height: 800, maximized: false },
        ],
        note: 'the window reports another rectangle',
      },
      {
        args: [
          {
            bounds: { x: 1, y: 2, width: 3, height: 4 },
            reported: { x: 5, y: 5, width: 5, height: 5 },
          },
          { x: 10, y: 20, width: 1200, height: 800, maximized: true },
        ],
        note: 'maximized after the baseline is read',
      },
      {
        args: [
          { bounds: { x: 0, y: 0, width: 0, height: 0 }, reported: null },
          { x: -5, y: 0.5, width: 720, height: 550, maximized: true },
        ],
        note: 'reported null, fractions untouched',
      },
    ],
  },
  'window-bounds.installShellWindowBoundsPersistence': {
    ts: (args, cx) => guard(() => installPersistence(args, cx)),
    cases: installCases(),
  },
}

// ---- split memory options

function splitOptions(value: unknown, cx: TsContext): SplitMemoryOptions {
  const spec = value as {
    settingsPath: string
    lazy?: boolean
    fakeRead?: Record<string, unknown>
    fakeWrite?: boolean
  }
  const options: SplitMemoryOptions = {
    settingsPath: spec.lazy
      ? () => {
          cx.log('settingsPath')
          return spec.settingsPath
        }
      : spec.settingsPath,
  }
  if (spec.fakeRead !== undefined) {
    const stored = spec.fakeRead
    options.readSettings = (path) => {
      cx.log('read', path)
      return stored
    }
  }
  if (spec.fakeWrite) {
    options.writeSetting = (path, key, written) => {
      cx.log('write', path, key, written === undefined ? '<undefined>' : written)
    }
  }
  return options
}

// ---- the persistence of the window geometry

interface FakeWin {
  maximized?: boolean
  minimized?: boolean
  fullScreen?: boolean
  destroyed?: boolean
  optional?: boolean
  bounds: { x: number; y: number; width: number; height: number }
}
interface Step {
  win: FakeWin
  action?: 'move' | 'resize' | 'settle' | 'debounce' | 'close'
}

/**
 * Runs the install with timers and events driven by the steps: the first
 * step's window is the one installed on, each later step puts the window in
 * its state and then fires its action (an event, a timer, or the close).
 */
function installPersistence(args: unknown[], cx: TsContext): void {
  const [settingsPath, steps, launch] = args as [string, Step[], never]
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let nextId = 1
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const realWarn = console.warn
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const id = nextId++
    pending.set(id, { fn, ms })
    return id
  }) as never
  globalThis.clearTimeout = ((id: number) => {
    pending.delete(id)
  }) as never
  console.warn = (message: string, error: unknown) => {
    cx.log(message, scrub(String((error as Error | undefined)?.message ?? error)))
  }
  try {
    let current = steps[0]!.win
    const listeners = new Map<string, () => void>()
    const win = {
      isMaximized: () => current.maximized === true,
      ...(steps[0]!.win.optional === false
        ? {}
        : {
            isMinimized: () => current.minimized === true,
            isFullScreen: () => current.fullScreen === true,
          }),
      getContentBounds: () => ({ ...current.bounds }),
      isDestroyed: () => current.destroyed === true,
      on(event: string, listener: () => void): void {
        listeners.set(event, listener)
      },
    }
    installShellWindowBoundsPersistence(settingsPath, win, launch)
    const fire = (ms: number): void => {
      const entry = [...pending].find(([, timer]) => timer.ms === ms)
      if (!entry) return
      pending.delete(entry[0])
      entry[1].fn()
    }
    for (const step of steps.slice(1)) {
      current = step.win
      if (step.action === 'move' || step.action === 'resize') listeners.get(step.action)?.()
      else if (step.action === 'settle') fire(WINDOW_BOUNDS_SETTLE_MS)
      else if (step.action === 'debounce') fire(WINDOW_BOUNDS_SAVE_DEBOUNCE_MS)
      else if (step.action === 'close') listeners.get('close')?.()
    }
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
    console.warn = realWarn
  }
}

function installCases(): Case[] {
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
  const normal = (r: ReturnType<typeof rect>, more: Partial<FakeWin> = {}): FakeWin => ({
    bounds: r,
    ...more,
  })
  const R1 = rect(100, 50, 1200, 800)
  const R2 = rect(120, 60, 1000, 700)
  const R3 = rect(0, 0, 400, 300)
  const restored = { ...rect(837, 20, 1217, 800), maximized: false }
  const baseline = rect(838, 20, 1218, 800)
  const fresh = { restored: null, baseline: null }
  const wbFile = (r: object, maximized = false) => raw(text({ windowBounds: { ...r, maximized } }))
  return [
    {
      args: [P, [{ win: normal(R1) }, { win: normal(R1), action: 'close' }], fresh],
      note: 'close writes the window as it is',
    },
    {
      args: [
        P,
        [
          { win: normal(R1) },
          { win: normal(R2), action: 'move' },
          { win: normal(R2), action: 'settle' },
          { win: normal(R2), action: 'debounce' },
        ],
        fresh,
      ],
      files: raw('{"keep":1}'),
      note: 'move, settle, then the debounce writes',
    },
    {
      args: [
        P,
        [
          { win: normal(R1) },
          { win: normal(R2), action: 'resize' },
          { win: normal(R3), action: 'close' },
        ],
        fresh,
      ],
      note: 'close without the settle timer reads the window itself',
    },
    {
      args: [
        P,
        [
          { win: normal(R1) },
          { win: normal(R2), action: 'move' },
          { win: normal(R3), action: 'settle' },
        ],
        fresh,
      ],
      note: 'only the settle ran: nothing is written',
    },
    {
      args: [P, [{ win: normal(R1) }, { win: normal(R2), action: 'debounce' }], fresh],
      note: 'no event, no timer, no write',
    },
    {
      args: [P, [{ win: normal(R1) }, { win: normal(R2), action: 'settle' }], fresh],
      note: 'settle without a timer',
    },
    {
      args: [
        P,
        [{ win: normal(R1) }, { win: normal(R2, { maximized: true }), action: 'close' }],
        fresh,
      ],
      note: 'maximized: the normal rectangle is kept',
    },
    {
      args: [
        P,
        [
          { win: normal(R1, { maximized: true }) },
          { win: normal(R2, { maximized: true }), action: 'close' },
        ],
        { restored: { ...R1, maximized: true }, baseline: R1 },
      ],
      note: 'maximized all session, restored rectangle written back',
    },
    {
      args: [
        P,
        [
          { win: normal(R1, { maximized: true }) },
          { win: normal(R2, { maximized: true }), action: 'close' },
        ],
        fresh,
      ],
      note: 'maximized all session, no baseline: nothing written',
    },
    {
      args: [
        P,
        [{ win: normal(baseline) }, { win: normal(baseline), action: 'close' }],
        { restored, baseline },
      ],
      note: 'still at the baseline: the restored rectangle is kept',
    },
    {
      args: [
        P,
        [{ win: normal(baseline) }, { win: normal(rect(839, 20, 1218, 800)), action: 'close' }],
        { restored, baseline },
      ],
      note: 'moved off the baseline',
    },
    {
      args: [
        P,
        [{ win: normal(baseline) }, { win: normal(R3), action: 'close' }],
        { restored, baseline },
      ],
      note: 'below the minimum: clamped on write',
    },
    {
      args: [
        P,
        [
          { win: normal(rect(10.5, -0.5, 1000.4, 700.5)) },
          { win: normal(rect(10.5, -0.5, 1000.4, 700.5)), action: 'close' },
        ],
        fresh,
      ],
      note: 'rounding on write',
    },
    {
      args: [
        P,
        [
          { win: normal(R1, { minimized: true }) },
          { win: normal(R2, { minimized: true }), action: 'close' },
        ],
        { restored: { ...R1, maximized: true }, baseline: R1 },
      ],
      note: 'minimized: flag and rectangle kept',
    },
    {
      args: [
        P,
        [{ win: normal(R1) }, { win: normal(R2, { fullScreen: true }), action: 'close' }],
        fresh,
      ],
      note: 'full screen: the last normal rectangle',
    },
    {
      args: [
        P,
        [{ win: normal(R1) }, { win: normal(R2, { destroyed: true }), action: 'close' }],
        fresh,
      ],
      note: 'destroyed window: nothing written',
    },
    {
      args: [
        P,
        [
          { win: normal(R1, { optional: false, minimized: true, fullScreen: true }) },
          {
            win: normal(R2, { optional: false, minimized: true, fullScreen: true }),
            action: 'close',
          },
        ],
        fresh,
      ],
      note: 'window without the optional methods',
    },
    {
      args: [
        P,
        [
          { win: normal(R1) },
          { win: normal(R2), action: 'move' },
          { win: normal(R3), action: 'close' },
          { win: normal(R2), action: 'debounce' },
        ],
        fresh,
      ],
      note: 'close cancels the pending timers',
    },
    {
      args: [
        P,
        [
          { win: normal(R1) },
          { win: normal(R2), action: 'close' },
          { win: normal(rect(5, 6, 1100, 760)), action: 'close' },
        ],
        fresh,
      ],
      files: wbFile(R1),
      note: 'two saves',
    },
    {
      args: [
        '$DIR/nope/s.json',
        [{ win: normal(R1) }, { win: normal(R1), action: 'close' }],
        fresh,
      ],
      note: 'unwritable: warned, not thrown',
    },
    {
      args: ['$DIR/d', [{ win: normal(R1) }, { win: normal(R1), action: 'close' }], fresh],
      files: { d: { dir: true } } as never,
      note: 'rename onto a folder: warned',
    },
  ]
}
