/**
 * Group `b5-mcp`, slice `deps` (Rust: crates/main-core/src/calls/b5_mcp/deps.rs):
 * the pieces of packages the MCP modules call that were not ported yet.
 *
 * - agent-core/redact-core, ai-provider/agent-session/{policy,claude},
 *   ai-provider/subscription/{locate,process}, google-drive/oauth,
 *   drawio-model/ops, drive/drive-vault: functions by `<file>.<export>`.
 * - A path spec of `locate` is plain JSON: an env is `{ NAME: value }` (a
 *   variable that is not there is left out), the files of a case sit under
 *   `$DIR`.
 * - `process.killProcessTree` takes a spec of the process it ends: `kill`
 *   ('ok', 'allThrow', 'groupThrows', 'singleThrows'), `spawn` ('ok',
 *   'throws', 'noUnref', 'unrefThrows', 'errorEvent': the taskkill child
 *   then emits `error`). Each call of a fake is one log line; `setTimeout` is
 *   a fake that logs and runs its callbacks after the call, in order.
 * - `process.registryScenario` is a script over one registry: each step
 *   answers `null` or, for `size`, the count. The record files of the case's
 *   folder are normalised to the owner `{ pid: 4242, startedAt: 1700000000000 }`
 *   on both sides (the TypeScript's owner is the real process).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Case, FileSpec, FnSpec, Group, TsContext } from '../../types.ts'

import * as redact from '../../../../packages/agent-core/src/redact-core.ts'
import * as policy from '../../../../packages/ai-provider/src/agent-session/policy.ts'
import * as claude from '../../../../packages/ai-provider/src/agent-session/claude.ts'
import * as locate from '../../../../packages/ai-provider/src/subscription/locate.ts'
import * as proc from '../../../../packages/ai-provider/src/subscription/process.ts'
import * as oauth from '../../../../packages/google-drive/src/oauth.ts'
import * as drawio from '../../../../packages/drawio-model/src/ops.ts'
import * as vault from '../../../../apps/shell/src/main/drive/drive-vault.ts'

const c = (args: unknown[], note?: string, files?: Record<string, FileSpec>): Case => ({
  args,
  ...(note ? { note } : {}),
  ...(files ? { files } : {}),
})

const constant = (value: unknown): FnSpec => ({
  ts: () => value,
  cases: [c([])],
  single: 'a constant',
})

const str = (a: unknown[], i: number): string => a[i] as string
const optStr = (a: unknown[], i: number): string | undefined =>
  a[i] === null || a[i] === undefined ? undefined : (a[i] as string)

// ---------------------------------------------------------------------------
// agent-core/redact-core
// ---------------------------------------------------------------------------

const EMOJI = '\u{1F600}'
const LONG = 'abcdefghij'.repeat(5)

const sanitizeCases: Case[] = [
  c(['Alice']),
  c(['  a   b\t\nc  '], 'white space runs become one space'),
  c(['{{x}}<y>="z\'']),
  c(['a*b/c'], 'kept in a label'),
  c(['a*b/c', true], 'stripped for a comment'),
  c(['a*b/c', false]),
  c([LONG], 'cut at 40'),
  c([`${'a'.repeat(39)}${EMOJI}bb`], 'a pair straddles the cut: the high half goes too'),
  c([`${'a'.repeat(38)}${EMOJI}bb`], 'a pair ends exactly at 40'),
  c([`${'a'.repeat(39)} b`], 'the cut leaves a trailing space, trimmed again'),
  c(['{}<>'], 'nothing left'),
  c([''], 'empty'),
  c(['\u00a0x\u00a0'], 'a no-break space is white space'),
  c(['\ufeffx\ufeff'], 'a byte order mark is trimmed'),
  c(['\u0085x\u0085'], 'U+0085 is not white space'),
  c([`${EMOJI}${EMOJI}`], 'two emoji'),
  c([`${'x'.repeat(40)}y`, true], 'comment form cut'),
]

const spec = (
  subject: string,
  opening: string,
  boundary: string,
  middle: string[],
): Record<string, unknown> => ({ subject, opening, boundary, middle })

const redactFns: Group = {
  'agent-core/redact-core.MAX_LABEL_LENGTH': constant(redact.MAX_LABEL_LENGTH),
  'agent-core/redact-core.sanitizeLabel': {
    ts: (a) =>
      redact.sanitizeLabel(str(a, 0), a[1] === undefined ? undefined : { forComment: !!a[1] }),
    cases: sanitizeCases,
  },
  'agent-core/redact-core.placeholderSource': {
    ts: (a) => redact.placeholderSource(str(a, 0)),
    cases: [
      c(['Alice']),
      c(['']),
      c(['{}']),
      c(['   ']),
      c(['a{b}c']),
      c([LONG]),
      c([`${'a'.repeat(39)}${EMOJI}`]),
      c(['x*y/z']),
    ],
  },
  'agent-core/redact-core.isWholePlaceholder': {
    ts: (a) => redact.isWholePlaceholder(str(a, 0)),
    cases: [
      c(['{{a}}']),
      c(['{{}}'], 'nothing inside'),
      c([' {{a}} '], 'trimmed first'),
      c(['{{a}} tail']),
      c(['x{{a}}']),
      c(['{{{a}}}']),
      c(['{{ }}']),
      c(['{{a}']),
      c(['{{}}}']),
      c(['']),
      c(['{{a}}\u00a0']),
    ],
  },
  'agent-core/redact-core.readPlaceholderLabel': {
    ts: (a) => redact.readPlaceholderLabel(str(a, 0)),
    cases: [
      c(['{{ Alice }}']),
      c(['{{}}'], 'null: not a whole marker'),
      c(['{{<>}}'], 'a marker whose label cleans to nothing'),
      c(['plain']),
      c([' {{a  b}} ']),
      c([`{{${LONG}}}`]),
      c([`{{${'a'.repeat(39)}${EMOJI}}}`]),
      c(['{{{a}}}'], 'braces inside are stripped'),
    ],
  },
  'agent-core/redact-core.collectPlaceholders': {
    ts: (a) => redact.collectPlaceholders(str(a, 0)),
    cases: [
      c(['{{a}} and {{b}} {{a}}']),
      c(['none']),
      c(['{{a{b}}']),
      c(['{{ {{x}} }}']),
      c([`{{${EMOJI}}}`]),
      c(['{{}}{{}}']),
      c(['']),
    ],
  },
  'agent-core/redact-core.checkPlaceholders': {
    ts: (a) => redact.checkPlaceholders(str(a, 0), str(a, 1)),
    cases: [
      c(['Hi {{a}}', 'Hello {{a}}'], 'kept'),
      c(['Hi {{a}}', 'Hello'], 'missing'),
      c(['{{a}} {{a}}', 'x {{a}}'], 'one of two kept'),
      c(['{{a}}', '{{b}}'], 'swapped for an unknown one'),
      c(['{{a}}', '{{a}} {{a}}'], 'one too many'),
      c(['x', '{{a}}'], 'invented'),
      c(['{{a}}', '{{a}'], 'split'),
      c(['{{a}}', '{a}'], 'single braces'),
      c(['{{a}}', 'a}}'], 'closing braces only'),
      c(['{{a}}', '{{a}}}'], 'a stray closing brace'),
      c(['{{a}} {{b}}', '{{b}} {{c}} {{c}} {a} }}'], 'several kinds, in the order they are found'),
      c(['', ''], 'nothing'),
      c([`{{${EMOJI}}}`, `{${EMOJI}}`], 'an emoji between single braces'),
      c(['{{a}}', '{{a}}{{a}}{{b}}'], 'extra and unknown'),
      c(['{{a}} {{b}}', ''], 'all missing, in order'),
      c(['{{x}}', `{a {{${EMOJI}}} b}`], 'a masked marker keeps its length in units'),
    ],
  },
  'agent-core/redact-core.placeholderInstruction': {
    ts: (a) =>
      redact.placeholderInstruction(
        a[0] as string[],
        a[1] as { subject: string; opening: string; boundary: string; middle: string[] },
      ),
    cases: [
      c([
        ['Alice', 'Bob'],
        spec('document', 'They stand for names.', 'a line break', ['Do not guess.']),
      ]),
      c([[], spec('workbook', 'Cells.', 'a cell boundary', [])], 'no labels'),
      c(
        [['a', 'a', 'b', 'a'], spec('page', 'x', 'y', ['one', 'two'])],
        'duplicates keep the first place',
      ),
      c([['{x}', '', `${'q'.repeat(50)}`], spec('presentation', 'Pictures.', 'a text box', ['m'])]),
    ],
  },
}

// ---------------------------------------------------------------------------
// ai-provider/agent-session/policy and claude
// ---------------------------------------------------------------------------

type Platform = NodeJS.Platform

const pathCases = (...rows: [string, string, string?][]): Case[] =>
  rows.map(([a, b, p]) => c(p === undefined ? [a, b] : [a, b, p]))

const policyFns: Group = {
  'ai-provider/agent-session/policy.comparablePath': {
    ts: (a) => policy.comparablePath(str(a, 0), str(a, 1), optStr(a, 2) as Platform | undefined),
    cases: pathCases(
      ['/a/b/../c', '/x', 'linux'],
      ['sub/file.txt', '/proj', 'darwin'],
      ['../up', '/a/b', 'linux'],
      ['/a/b/', '/x', 'linux'],
      ['/A/B', '/x', 'linux'],
      ['C:/Users/Me/Doc.TXT', 'C:\\base', 'win32'],
      ['sub\\..\\File.TXT', 'D:\\Proj', 'win32'],
      ['\\\\Server\\Share\\X', 'C:\\base', 'win32'],
      ['Rel/Path', 'C:\\Base', 'win32'],
      ['/abs', '/base'],
      ['', '/base', 'linux'],
      ['', 'C:\\Base\\', 'win32'],
      ['C:\\a\\.\\b', 'C:\\x', 'win32'],
    ),
  },
  'ai-provider/agent-session/policy.isInsidePath': {
    ts: (a) => policy.isInsidePath(str(a, 0), str(a, 1), optStr(a, 2) as Platform | undefined),
    cases: pathCases(
      ['/a/b', '/a/b', 'linux'],
      ['/a/b/c', '/a/b', 'linux'],
      ['/a', '/a/b', 'linux'],
      ['/a/bc', '/a/b', 'linux'],
      ['/a/b/..x', '/a/b', 'linux'],
      ['/a/b/...', '/a/b', 'linux'],
      ['/a/b/../c', '/a/b', 'linux'],
      ['/x', '/a/b', 'darwin'],
      ['/a/b/c/d/e', '/', 'linux'],
      ['c:\\root\\sub', 'c:\\root', 'win32'],
      ['c:\\root', 'c:\\root', 'win32'],
      ['d:\\root\\sub', 'c:\\root', 'win32'],
      ['c:\\rootx', 'c:\\root', 'win32'],
      ['C:\\Root\\Sub', 'c:\\root', 'win32'],
      ['c:\\root\\..x', 'c:\\root', 'win32'],
      ['c:\\other', 'c:\\root', 'win32'],
      ['\\\\srv\\share\\x', 'c:\\root', 'win32'],
      ['\\\\srv\\share\\x', '\\\\srv\\share', 'win32'],
      ['/a/b/c', '/a/b'],
    ),
  },
  'ai-provider/agent-session/policy.webHostOf': {
    ts: (a) => policy.webHostOf(a[0] as string | undefined),
    cases: [
      c(['https://Example.COM/a']),
      c(['http://[::1]:8080/x']),
      c(['ftp://example.com/']),
      c(['not a url']),
      c(['']),
      c([]),
      c(['http://user:pw@Host.example:8080/p?q#f']),
      c(['HTTP://A.b']),
      c(['javascript:alert(1)']),
      c(['file:///etc/passwd']),
      c(['https://EXAMPLE.com./']),
      c(['https://m\u00fcnchen.de/']),
      c(['http://192.168.0.1/']),
      c(['  https://padded.example/  ']),
      c(['https://exa mple.com/']),
    ],
  },
  'ai-provider/agent-session/policy.agentPolicyVerdict': {
    ts: (a) => {
      const ctx = a[1] as Record<string, unknown>
      const allowances = ctx.allowances as { webSearch: boolean; webHosts: string[] } | undefined
      return policy.agentPolicyVerdict(
        a[0] as Parameters<typeof policy.agentPolicyVerdict>[0],
        {
          ...ctx,
          allowances: allowances
            ? { webSearch: allowances.webSearch, webHosts: new Set(allowances.webHosts) }
            : undefined,
        } as Parameters<typeof policy.agentPolicyVerdict>[1],
      )
    },
    cases: policyCases(),
  },
}

function policyCases(): Case[] {
  const ctx = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    mode: 'ask-commands',
    projectRoot: '/proj',
    openDocuments: [],
    protectedPaths: [],
    platform: 'linux',
    ...extra,
  })
  const act = (kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind,
    tool: 'T',
    paths: [],
    ...extra,
  })
  const win = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
    ctx({ projectRoot: 'C:\\Proj', platform: 'win32', ...extra })
  return [
    c([act('read', { paths: ['/proj/a.txt'] }), ctx()], 'inside the folder'),
    c([act('read', { paths: ['/etc/hosts'] }), ctx()], 'outside: ask'),
    c([act('read'), ctx()], 'no paths'),
    c(
      [act('read', { paths: ['/skills/x/run.sh'] }), ctx({ skillBundleDir: '/skills' })],
      'the skill copy',
    ),
    c(
      [act('read', { paths: ['/skills/x'] }), ctx({ skillBundleDir: '' })],
      'empty skill dir counts as none',
    ),
    c([act('read', { paths: ['rel/x'], cwd: '/proj/sub' }), ctx()], 'resolved from the cwd'),
    c([act('read', { paths: ['../x'], cwd: '/proj/sub' }), ctx()], 'up from the cwd, still inside'),
    c([act('read', { paths: ['../../x'], cwd: '/proj/sub' }), ctx()], 'up out of the folder'),
    c(
      [act('read', { paths: ['/proj/secret/k'] }), ctx({ protectedPaths: ['/proj/secret'] })],
      'protected',
    ),
    c(
      [act('read', { paths: ['/proj/secret'] }), ctx({ protectedPaths: ['/proj/secret'] })],
      'the protected folder itself',
    ),
    c(
      [act('read', { paths: ['/proj/secretive'] }), ctx({ protectedPaths: ['/proj/secret'] })],
      'a sibling by prefix',
    ),
    c([act('write', { paths: ['/proj/a.txt'] }), ctx()], 'allowed write'),
    c([act('write', { paths: ['/proj/a.txt'] }), ctx({ mode: 'ask-writes' })], 'ask-writes asks'),
    c([act('write', { paths: ['/proj/a.txt'] }), ctx({ mode: 'trust-project' })]),
    c([act('write', { paths: ['/proj/a.txt', '/elsewhere/b'] }), ctx()], 'one outside'),
    c(
      [act('write', { paths: ['/proj/doc.docx'] }), ctx({ openDocuments: ['/proj/doc.docx'] })],
      'open document',
    ),
    c(
      [act('write', { paths: ['/proj/doc.docx'] }), ctx({ openDocuments: ['doc.docx'] })],
      'open document, relative to the root',
    ),
    c(
      [act('write', { paths: ['/skills/x'] }), ctx({ skillBundleDir: '/skills' })],
      'the skill copy is read only',
    ),
    c([act('write'), ctx({ mode: 'ask-writes' })], 'no paths'),
    c([act('command', { command: 'ls' }), ctx()], 'ask'),
    c([act('command', { command: 'ls' }), ctx({ mode: 'trust-project' })]),
    c([act('command', { command: 'ls' }), ctx({ mode: 'ask-writes' })]),
    c(
      [
        act('command', { command: 'cat /proj/secret/key' }),
        ctx({ protectedPaths: ['/proj/secret'] }),
      ],
      'a protected path in the command line',
    ),
    c(
      [
        act('command', { command: 'cat /proj//secret\\\\key' }),
        ctx({ protectedPaths: ['/proj/secret'] }),
      ],
      'doubled and mixed separators',
    ),
    c(
      [act('command', { command: 'cat /a' }), ctx({ protectedPaths: ['/a'] })],
      'a short path is not matched in a command',
    ),
    c(
      [act('command', { command: 'cat /ab/x' }), ctx({ protectedPaths: ['/ab'] })],
      'three characters is too short',
    ),
    c(
      [act('command', { command: 'cat /abc/x' }), ctx({ protectedPaths: ['/abc'] })],
      'four characters is enough',
    ),
    c(
      [act('command', { command: '' }), ctx({ protectedPaths: ['/proj/secret'] })],
      'empty command',
    ),
    c(
      [
        act('command', { command: 'dir C:\\\\PROJ\\\\SECRET\\\\x' }),
        win({ protectedPaths: ['C:\\Proj\\Secret'] }),
      ],
      'Codex doubles the backslashes',
    ),
    c([act('app-tool'), ctx()]),
    c(
      [act('app-tool', { paths: ['/proj/secret/x'] }), ctx({ protectedPaths: ['/proj/secret'] })],
      'protected paths win over every kind',
    ),
    c([act('skill'), ctx({ mode: 'trust-project' })]),
    c([act('web-search'), ctx()], 'asks'),
    c([act('web-search'), ctx({ allowances: { webSearch: true, webHosts: [] } })]),
    c([act('web-search'), ctx({ allowances: { webSearch: false, webHosts: ['a.com'] } })]),
    c([act('web-fetch', { host: 'a.com' }), ctx()]),
    c(
      [
        act('web-fetch', { host: 'A.com' }),
        ctx({ allowances: { webSearch: false, webHosts: ['a.com'] } }),
      ],
      'host compared in lower case',
    ),
    c([
      act('web-fetch', { host: 'b.com' }),
      ctx({ allowances: { webSearch: true, webHosts: ['a.com'] } }),
    ]),
    c([act('web-fetch'), ctx({ allowances: { webSearch: true, webHosts: ['a.com'] } })], 'no host'),
    c(
      [act('web-fetch', { host: '' }), ctx({ allowances: { webSearch: true, webHosts: [''] } })],
      'an empty host asks',
    ),
    c([act('mcp-tool', { server: 's' }), ctx({ mode: 'trust-project' })]),
    c([act('other'), ctx({ mode: 'trust-project' })]),
    c([act('read', { paths: ['C:/Proj/A.txt'] }), win()], 'Windows, inside'),
    c([act('read', { paths: ['D:\\Other'] }), win()], 'Windows, another drive'),
    c(
      [
        act('write', { paths: ['c:\\proj\\Doc.DOCX'] }),
        win({ openDocuments: ['C:\\Proj\\doc.docx'] }),
      ],
      'Windows ignores case',
    ),
    c(
      [act('write', { paths: ['C:\\Proj\\x'] }), win({ protectedPaths: ['c:\\PROJ\\X'] })],
      'Windows protected',
    ),
    c([act('read', { paths: ['sub\\f'], cwd: 'sub2' }), win()], 'Windows cwd'),
    c(
      [
        act('read', { paths: ['/proj/a'] }),
        { mode: 'ask-commands', projectRoot: '/proj', openDocuments: [], protectedPaths: [] },
      ],
      'the platform of this machine',
    ),
  ]
}

const claudeFns: Group = {
  'ai-provider/agent-session/claude.AGENT_APP_MCP_TOOLS': constant(claude.AGENT_APP_MCP_TOOLS),
  'ai-provider/agent-session/claude.APP_MCP_SERVER_NAME': constant(claude.APP_MCP_SERVER_NAME),
}

// ---------------------------------------------------------------------------
// ai-provider/subscription/locate
// ---------------------------------------------------------------------------

const envOf = (spec: unknown): NodeJS.ProcessEnv => ({ ...(spec as Record<string, string>) })

const nvm = (...versions: string[]): Record<string, FileSpec> =>
  Object.fromEntries(
    versions.map((v) => [`home/.nvm/versions/node/${v}`, { dir: true } as FileSpec]),
  )

const HOME = '$DIR/home'

const locateFns: Group = {
  'ai-provider/subscription/locate.isFullDir': {
    ts: (a) => locate.isFullDir(str(a, 0)),
    cases: [
      c(['/usr/bin']),
      c(['tools']),
      c(['.']),
      c(['']),
      c(['\\tools']),
      c(['/']),
      c(['C:\\x']),
      c(['//server/share']),
      c(['~']),
      c(['./a']),
    ],
  },
  'ai-provider/subscription/locate.pathDirs': {
    ts: (a) => locate.pathDirs(envOf(a[0]), str(a, 1) as Platform),
    cases: [
      c([{}, 'linux'], 'no PATH'),
      c([{ PATH: '' }, 'linux']),
      c([{ PATH: '/a:/b' }, 'linux']),
      c([{ PATH: '/a:/b', Path: '/c' }, 'linux'], 'PATH first'),
      c([{ Path: '/c:/d' }, 'linux'], 'Path'),
      c([{ path: '/e' }, 'darwin'], 'path'),
      c([{ PATH: '', Path: '/c' }, 'linux'], 'an empty PATH is not missing'),
      c(
        [{ PATH: ' "/a b" : \'/c\' :rel:: /d ' }, 'linux'],
        'quotes, blanks, relative and empty entries',
      ),
      c([{ PATH: '/a:/b;/c' }, 'win32'], 'win32 splits at semicolons: one directory with colons'),
      c([{ PATH: 'C:\\a;D:\\b;;rel;"E:\\q"' }, 'win32'], 'drive paths: absolute only on Windows'),
      c([{ PATH: '/x/' }, 'freebsd']),
      c([{ PATH: '"/"' }, 'linux']),
      c([{ PATH: '"' }, 'linux'], 'a single quote'),
    ],
  },
  'ai-provider/subscription/locate.commonUnixBinDirs': {
    ts: (a) => locate.commonUnixBinDirs(str(a, 0), envOf(a[1]), str(a, 2) as Platform),
    cases: [
      c(['', {}, 'linux'], 'no home'),
      c([HOME, {}, 'linux'], 'a home that does not exist'),
      c([HOME, {}, 'darwin'], 'macOS fnm and pnpm places'),
      c([HOME, { XDG_DATA_HOME: '/xdg' }, 'linux']),
      c([HOME, { XDG_DATA_HOME: '/xdg' }, 'darwin']),
      c(
        [HOME, { XDG_DATA_HOME: '  "/q d"  ', FNM_DIR: "'/fnm'", PNPM_HOME: '/pnpm' }, 'linux'],
        'quoted',
      ),
      c(
        [HOME, { XDG_DATA_HOME: '', FNM_DIR: '', PNPM_HOME: '' }, 'linux'],
        'empty values fall back',
      ),
      c(
        [HOME, { npm_config_prefix: '/opt/npm', NPM_CONFIG_PREFIX: '/opt/npm2' }, 'linux'],
        'two prefixes from the environment',
      ),
      c(
        [HOME, { npm_config_prefix: '/opt/npm', NPM_CONFIG_PREFIX: '/opt/npm' }, 'linux'],
        'the same twice',
      ),
      c([HOME, { NPM_CONFIG_PREFIX: 'relative' }, 'linux'], 'a relative prefix is left out'),
      c([HOME, { NPM_CONFIG_PREFIX: '~' }, 'linux'], 'the home directory itself'),
      c([HOME, { NPM_CONFIG_PREFIX: '~/.npm-g' }, 'linux'], 'under the home directory'),
      c([HOME, { NPM_CONFIG_PREFIX: '~\\npm-win' }, 'linux'], 'a backslash after the tilde'),
      c([HOME, { NPM_CONFIG_PREFIX: '~other' }, 'linux'], 'not a home path'),
      c([HOME, { NPM_CONFIG_PREFIX: '/opt/npm' }, 'win32'], 'win32 takes the prefix itself'),
      c([HOME, {}, 'linux'], 'prefixes from .npmrc', {
        'home/.npmrc':
          '; comment\nprefix=/opt/one\n  prefix = ~/two  \nregistry=x\nprefixes=/no\n#prefix=/no\nprefix="/quoted"\nprefix=\nprefix=relative\n',
      }),
      c([HOME, {}, 'linux'], 'CRLF lines', {
        'home/.npmrc': 'prefix=/crlf\r\nother=1\r\nprefix = /crlf2\r\n',
      }),
      c([HOME, {}, 'linux'], 'a lone CR is no line end', {
        'home/.npmrc': 'prefix=/a\rprefix=/b\n',
      }),
      c([HOME, { npm_config_prefix: '/env' }, 'linux'], 'environment before .npmrc', {
        'home/.npmrc': 'prefix=/file\n',
      }),
      c([HOME, {}, 'linux'], '.npmrc is a folder', { 'home/.npmrc': { dir: true } }),
      c([HOME, {}, 'linux'], 'bytes that are no UTF-8', {
        'home/.npmrc': { hex: '7072656669783d2f6f70742f78ff0a' },
      }),
      c(
        [HOME, {}, 'linux'],
        'nvm, newest first',
        nvm('v8.17.0', 'v20.1.0', 'v20.10.0', 'v18.0.0', 'v20.9.9'),
      ),
      c(
        [HOME, {}, 'linux'],
        'nvm, names that do not parse',
        nvm('default', 'v20.1.0', 'lts', 'v20.1.0-rc.1', '20.1.0', 'V20.1.1'),
      ),
      c(
        [HOME, {}, 'linux'],
        'nvm, equal versions in string order',
        nvm('v1.2.3', 'v1.2.3-b', 'v1.2.3-a', '1.2.3'),
      ),
      c(
        [HOME, {}, 'linux'],
        'nvm, huge numbers',
        nvm(`v${'9'.repeat(200)}.0.0`, `v${'9'.repeat(200)}.0.1`, 'v1.0.0'),
      ),
      c([HOME, {}, 'linux'], 'nvm, a file among the versions', {
        'home/.nvm/versions/node/v2.0.0': { dir: true },
        'home/.nvm/versions/node/note.txt': 'x',
      }),
      c(
        [
          HOME,
          { XDG_DATA_HOME: '/xdg', FNM_DIR: '/f', PNPM_HOME: '/p', npm_config_prefix: '/np' },
          'darwin',
        ],
        'everything at once',
        {
          ...nvm('v18.0.0', 'v19.0.0'),
          'home/.npmrc': 'prefix=/rc\n',
        },
      ),
    ],
  },
}

// ---------------------------------------------------------------------------
// ai-provider/subscription/process
// ---------------------------------------------------------------------------

interface KillSpec {
  platform?: string
  force?: boolean
  graceMs?: number
  env?: Record<string, string>
  kill?: 'ok' | 'allThrow' | 'groupThrows' | 'singleThrows'
  spawn?: 'ok' | 'throws' | 'noUnref' | 'unrefThrows' | 'errorEvent'
}

function killProcessTreeSpec(a: unknown[], cx: TsContext): void {
  const target = a[0] as number | { pid?: number }
  const s = (a[1] ?? {}) as KillSpec
  const log = cx.log
  const listeners: Array<() => void> = []
  const timers: Array<() => void> = []
  const options = {
    ...(s.platform !== undefined ? { platform: s.platform as Platform } : {}),
    ...(s.force !== undefined ? { force: s.force } : {}),
    ...(s.graceMs !== undefined ? { graceMs: s.graceMs } : {}),
    ...(s.env !== undefined ? { env: s.env } : {}),
    kill: (pid: number, signal?: NodeJS.Signals | number) => {
      log('kill', pid, signal ?? null)
      const mode = s.kill ?? 'ok'
      if (
        mode === 'allThrow' ||
        (mode === 'groupThrows' && pid < 0) ||
        (mode === 'singleThrows' && pid > 0)
      ) {
        throw new Error('ESRCH')
      }
    },
    spawn: (command: string, args: string[], opts: unknown) => {
      log('spawn', command, args, opts)
      const mode = s.spawn ?? 'ok'
      if (mode === 'throws') throw new Error('spawn failed')
      return {
        pid: 1,
        kill: () => true,
        once: (event: string, listener: () => void) => {
          log('once', event)
          listeners.push(listener)
          return undefined
        },
        ...(mode === 'noUnref'
          ? {}
          : {
              unref: () => {
                log('unref killer')
                if (mode === 'unrefThrows') throw new Error('unref failed')
              },
            }),
      }
    },
  }
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    log('setTimeout', ms)
    timers.push(fn)
    return { unref: () => log('unref timer') }
  }) as unknown as typeof setTimeout
  try {
    proc.killProcessTree(target, options)
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
  if (s.spawn === 'errorEvent') for (const fn of listeners) fn()
  for (const fn of timers) fn()
}

const kc = (target: unknown, spec?: KillSpec, note?: string): Case =>
  c(spec === undefined ? [target] : [target, spec], note)

const WIN_ENV = { SystemRoot: 'C:\\Windows' }

interface Step {
  track?: string
  pid?: number | null
  provider?: string
  command?: string
  startedAt?: number
  forget?: string
  exit?: string
  recordIn?: string | null
  shutdown?: true
  size?: true
}

const OWNER = { pid: 4242, startedAt: 1_700_000_000_000 }

async function registryScenario(a: unknown[], cx: TsContext): Promise<unknown> {
  const opts = (a[0] ?? {}) as { killThrows?: number[] }
  const steps = a[1] as Step[]
  const reg = proc.createSubscriptionChildRegistry({
    killTree: (pid) => {
      cx.log('killTree', pid)
      if (opts.killThrows?.includes(pid)) throw new Error('kill failed')
    },
  })
  const dirs = new Set<string>()
  const exits = new Map<string, Array<() => void>>()
  const forgets = new Map<string, () => void>()
  const answers: unknown[] = []
  const realNow = Date.now
  Date.now = () => cx.now
  try {
    for (const step of steps) {
      if (step.track !== undefined) {
        const listeners: Array<() => void> = []
        exits.set(step.track, listeners)
        const child = {
          pid: step.pid ?? undefined,
          kill: () => true,
          once: (event: string, listener: () => void) => {
            if (event === 'exit') listeners.push(listener)
            return undefined
          },
        }
        forgets.set(
          step.track,
          reg.track(child, {
            provider: step.provider as 'claude-code',
            command: step.command as string,
            ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
          }),
        )
        answers.push(null)
      } else if (step.forget !== undefined) {
        forgets.get(step.forget)!()
        answers.push(null)
      } else if (step.exit !== undefined) {
        const listeners = exits.get(step.exit)!
        for (const fn of listeners.splice(0)) fn()
        answers.push(null)
      } else if (step.recordIn !== undefined) {
        if (step.recordIn) dirs.add(step.recordIn)
        reg.recordIn(step.recordIn)
        answers.push(null)
      } else if (step.shutdown) {
        reg.shutdown()
        answers.push(null)
      } else if (step.size) {
        answers.push(reg.size)
      }
    }
  } finally {
    Date.now = realNow
  }
  await reg.flushed()
  for (const dir of dirs) {
    const file = proc.leftoverRecordFile(dir)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8').replace(
      `"owner":{"pid":${process.pid},"startedAt":${proc.SUBSCRIPTION_OWNER_STARTED_AT}}`,
      `"owner":{"pid":${OWNER.pid},"startedAt":${OWNER.startedAt}}`,
    )
    writeFileSync(proc.leftoverRecordFile(dir, OWNER.pid), text)
    rmSync(file)
  }
  return { answers, size: reg.size }
}

const REC = '$DIR/rec'
const trackStep = (name: string, pid: number | null, extra: Partial<Step> = {}): Step => ({
  track: name,
  pid,
  provider: 'claude-code',
  command: `/bin/${name}`,
  ...extra,
})

const processFns: Group = {
  'ai-provider/subscription/process.USER_MCP_CHILD_KIND': constant(proc.USER_MCP_CHILD_KIND),
  'ai-provider/subscription/process.SUBSCRIPTION_LEFTOVER_FILE_PREFIX': constant(
    proc.SUBSCRIPTION_LEFTOVER_FILE_PREFIX,
  ),
  'ai-provider/subscription/process.leftoverRecordFile': {
    ts: (a) => proc.leftoverRecordFile(str(a, 0), a[1] as number),
    cases: [
      c(['/data', 123]),
      c(['/data/', 7]),
      c(['rel/dir', 1e21]),
      c(['/data/../x', 0]),
      c(['', 5]),
    ],
  },
  'ai-provider/subscription/process.windowsSystemDir': {
    ts: (a) => proc.windowsSystemDir(envOf(a[0])),
    cases: [
      c([{}], 'no variable'),
      c([WIN_ENV]),
      c([{ SystemRoot: 'D:\\WinNT\\' }], 'a trailing backslash'),
      c([{ SystemRoot: 'C:\\A', SYSTEMROOT: 'C:\\B', windir: 'C:\\C' }], 'SystemRoot first'),
      c(
        [{ SystemRoot: 'relative', SYSTEMROOT: 'E:\\Win' }],
        'SYSTEMROOT when SystemRoot is no drive path',
      ),
      c([{ SystemRoot: '\\Windows', SYSTEMROOT: 'C:', windir: 'F:\\W' }], 'windir last'),
      c([{ SystemRoot: 'C:\\Win%dows' }], 'a percent sign'),
      c([{ SystemRoot: 'C:\\Win dows\\sub' }]),
      c([{ SystemRoot: 'C:\\a/b' }], 'a slash'),
      c([{ SystemRoot: 'C:/Windows' }]),
      c([{ SystemRoot: 'C:\\' }], 'the root alone'),
      c([{ SystemRoot: '', windir: 'G:\\X' }], 'an empty value'),
      c([{ SystemRoot: 'C:\\Windows\r\n' }], 'a line break'),
    ],
  },
  'ai-provider/subscription/process.windowsSystemTool': {
    ts: (a) => proc.windowsSystemTool(envOf(a[0]), ...(a[1] as string[])),
    cases: [
      c([WIN_ENV, ['taskkill.exe']]),
      c([{}, ['wbem', 'wmic.exe']]),
      c([WIN_ENV, []]),
      c([{ windir: 'D:\\W' }, ['..', 'x.exe']]),
    ],
  },
  'ai-provider/subscription/process.killProcessTree': {
    ts: killProcessTreeSpec,
    cases: [
      kc(123, { platform: 'linux' }, 'SIGTERM to the group, then SIGKILL after the grace time'),
      kc(123, { platform: 'darwin', graceMs: 50 }, 'a set grace time'),
      kc(123, { platform: 'linux', graceMs: 0 }, 'a grace time of zero is kept'),
      kc({ pid: 456 }, { platform: 'linux' }, 'a child object'),
      kc(123, { platform: 'linux', force: true }, 'SIGKILL at once'),
      kc(123, { platform: 'linux', force: false }),
      kc(
        123,
        { platform: 'linux', kill: 'groupThrows' },
        'no group: the process alone, both times',
      ),
      kc(123, { platform: 'linux', kill: 'allThrow' }, 'already gone'),
      kc(123, { platform: 'linux', kill: 'allThrow', force: true }),
      kc(123, { platform: 'linux', kill: 'singleThrows' }, 'the group call works'),
      kc(1e21, { platform: 'linux', force: true }, 'a pid that prints in exponent form'),
      kc(0, { platform: 'linux' }, 'not a pid'),
      kc(-5, { platform: 'linux' }),
      kc(1.5, { platform: 'linux' }),
      kc({}, { platform: 'linux' }, 'an object without a pid'),
      kc({ pid: 0 }, { platform: 'win32' }),
      kc(123, { platform: 'win32', env: WIN_ENV }, 'taskkill on the tree'),
      kc(1e21, { platform: 'win32', env: WIN_ENV }),
      kc(
        { pid: 77 },
        { platform: 'win32', env: { windir: 'D:\\W' }, spawn: 'noUnref' },
        'a child without unref',
      ),
      kc(
        123,
        { platform: 'win32', env: {}, spawn: 'throws' },
        'taskkill cannot start: the root is ended directly',
      ),
      kc(
        123,
        { platform: 'win32', env: WIN_ENV, spawn: 'throws', kill: 'allThrow' },
        'and that fails too',
      ),
      kc(
        123,
        { platform: 'win32', env: WIN_ENV, spawn: 'unrefThrows' },
        'a throw after the start also ends the root',
      ),
      kc(
        123,
        { platform: 'win32', env: WIN_ENV, spawn: 'errorEvent' },
        'taskkill reports an error later',
      ),
      kc(123, { platform: 'win32', env: WIN_ENV, spawn: 'errorEvent', kill: 'allThrow' }),
      kc(
        123,
        { platform: 'win32', env: WIN_ENV, force: false, graceMs: 5 },
        'Windows ignores force and grace',
      ),
      kc(123, { platform: 'win32', env: { SystemRoot: 'bad', SYSTEMROOT: 'H:\\Sys' } }),
    ],
  },
  'ai-provider/subscription/process.registryScenario': {
    ts: registryScenario,
    cases: [
      c(
        [
          {},
          [
            trackStep('a', 11),
            trackStep('b', 12),
            { size: true },
            { forget: 'a' },
            { size: true },
            { shutdown: true },
            { size: true },
          ],
        ],
        'track, forget, shut down',
      ),
      c(
        [
          {},
          [
            trackStep('a', 11),
            trackStep('b', 12),
            { exit: 'a' },
            { exit: 'a' },
            { size: true },
            { exit: 'b' },
            { size: true },
          ],
        ],
        'exit forgets once',
      ),
      c(
        [
          {},
          [
            trackStep('a', null),
            trackStep('b', 0),
            trackStep('c', -3),
            trackStep('d', 1.5),
            { size: true },
            { forget: 'a' },
            { exit: 'b' },
          ],
        ],
        'no valid pid: nothing is tracked',
      ),
      c(
        [
          {},
          [
            trackStep('a', 5),
            trackStep('b', 5),
            { exit: 'a' },
            { size: true },
            { forget: 'a' },
            { size: true },
            { exit: 'b' },
            { size: true },
          ],
        ],
        'a later child with the same pid is not forgotten by the earlier one',
      ),
      c(
        [
          {},
          [
            trackStep('a', 1),
            trackStep('b', 2),
            trackStep('c', 1),
            { size: true },
            { shutdown: true },
          ],
        ],
        'a pid set again keeps its place',
      ),
      c(
        [
          {},
          [
            trackStep('a', 1),
            trackStep('b', 2),
            { forget: 'a' },
            trackStep('c', 1),
            { shutdown: true },
          ],
        ],
        'a pid forgotten and set again goes last',
      ),
      c(
        [
          { killThrows: [2] },
          [
            trackStep('a', 1),
            trackStep('b', 2),
            trackStep('c', 3),
            { shutdown: true },
            { size: true },
          ],
        ],
        'a kill that throws does not stop the others',
      ),
      c([{}, [{ shutdown: true }, { size: true }]], 'shut down with nothing'),
      c(
        [
          {},
          [
            trackStep('a', 9, { startedAt: 1234 }),
            { recordIn: REC },
            trackStep('b', 10, { startedAt: 5678 }),
          ],
        ],
        'the record on disk after two children',
      ),
      c(
        [
          {},
          [
            { recordIn: REC },
            trackStep('a', 9, { startedAt: 1 }),
            trackStep('b', 10, { startedAt: 2 }),
            { exit: 'a' },
          ],
        ],
        'the record after one exits',
      ),
      c([{}, [{ recordIn: REC }, trackStep('a', 9, { startedAt: 1 })]], 'startedAt is given'),
      c([{}, [{ recordIn: REC }, trackStep('a', 9)]], 'startedAt is now'),
      c(
        [{}, [{ recordIn: REC }, trackStep('a', 9, { startedAt: 1 }), { shutdown: true }]],
        'shutdown removes the record',
      ),
      c(
        [
          {},
          [{ recordIn: REC }, trackStep('a', 9, { startedAt: 1 }), { exit: 'a' }, { size: true }],
        ],
        'an empty list is recorded',
      ),
      c(
        [
          {},
          [
            { recordIn: REC },
            trackStep('a', 9, { startedAt: 1 }),
            { recordIn: null },
            trackStep('b', 10, { startedAt: 2 }),
            { shutdown: true },
          ],
        ],
        'recordIn(null) stops recording and the record stays',
      ),
      c(
        [{}, [{ recordIn: '' }, trackStep('a', 9, { startedAt: 1 }), { shutdown: true }]],
        'an empty directory is none',
      ),
      c(
        [
          {},
          [
            { recordIn: `$DIR/blocker/sub` },
            trackStep('a', 9, { startedAt: 1 }),
            { shutdown: true },
          ],
        ],
        'a record that cannot be written is left alone',
        { blocker: 'x' },
      ),
      c(
        [{}, [{ recordIn: REC }, trackStep('a', 9, { command: 'C:\\x "y"', startedAt: 3 })]],
        'the command is written as JSON',
      ),
    ],
  },
}

// ---------------------------------------------------------------------------
// google-drive/oauth, drawio-model/ops, drive/drive-vault
// ---------------------------------------------------------------------------

const page = (lang: string, title: string, body: string): Record<string, string> => ({
  lang,
  title,
  body,
})

const storages = {
  win: { available: true },
  none: { available: false },
  gnome: { available: true, backend: 'gnome_libsecret' },
  basic: { available: true, backend: 'basic_text' },
  kwallet6: { available: true, backend: 'kwallet6' },
  noBackend: { available: true },
  nullBackend: { available: true, backend: null },
}

function storageOf(spec: Record<string, unknown>) {
  return {
    isEncryptionAvailable: () => !!spec.available,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (sealed: Buffer) => sealed.toString('utf8').slice(4),
    ...('backend' in spec ? { getSelectedStorageBackend: () => spec.backend as string } : {}),
  }
}

const otherFns: Group = {
  'google-drive/oauth.signInPageHtml': {
    ts: (a) => oauth.signInPageHtml(a[0] as { lang: string; title: string; body: string }),
    cases: [
      c([page('en', 'Signed in', 'You can close this tab.')]),
      c([page('ko', '\uc644\ub8cc', '\uc774 \ucc3d\uc744 \ub2eb\uc544\ub3c4 \ub429\ub2c8\ub2e4.')]),
      c(
        [page('en"><script>', '<b>"Done" & \'ok\'</b>', 'a & b < c > d "e" \'f\'')],
        'every character that is escaped',
      ),
      c([page('en', '&amp; &#39;', 'already &lt;escaped&gt;')], 'an ampersand is escaped again'),
      c([page('', '', '')], 'empty'),
      c([page('en', 'two\nlines', `${EMOJI} and \u2028 tab\t`)], 'line breaks and emoji stay'),
    ],
  },
  'drawio-model/ops.DIAGRAM_OP_NAMES': constant(drawio.DIAGRAM_OP_NAMES),
  'drawio-model/ops.DIAGRAM_OPS': constant(drawio.DIAGRAM_OPS),
  'drive-vault.driveTokenSeals': {
    ts: (a) =>
      vault.driveTokenSeals(storageOf(a[0] as Record<string, unknown>), str(a, 1) as Platform),
    cases: [
      c([storages.win, 'win32']),
      c([storages.none, 'win32'], 'no encryption'),
      c([storages.win, 'darwin'], 'the keychain'),
      c([storages.none, 'darwin']),
      c([storages.gnome, 'linux']),
      c([storages.kwallet6, 'linux']),
      c([storages.basic, 'linux'], 'a key built into the program'),
      c([storages.noBackend, 'linux']),
      c([storages.nullBackend, 'linux']),
      c([storages.none, 'linux']),
      c([storages.gnome, 'freebsd'], 'only Linux asks the keyring'),
      c([storages.basic, 'win32']),
    ],
  },
}

export const group: Group = {
  ...redactFns,
  ...policyFns,
  ...claudeFns,
  ...locateFns,
  ...processFns,
  ...otherFns,
}
