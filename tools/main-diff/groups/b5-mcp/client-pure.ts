/**
 * Group `b5-mcp`, slice `client-pure` (Rust: crates/main-core/src/calls/b5_mcp/client_pure.rs):
 * the pure modules of the user MCP client.
 *
 * - mcp-servers-api: the value exports of apps/shell/src/shared/mcp-servers-api.ts.
 * - agent-core/user-mcp/names, agent-core/user-mcp/result: packages/agent-core/src/user-mcp.
 * - limits, fingerprint, listing, hub-input, hub-strings, address: apps/shell/src/main/mcp-client.
 *
 * Objects with an own `__proto__` key are built with `JSON.parse`; a literal would set the
 * prototype instead. A stored server in a listing case is the answer of `acceptFirstListing` /
 * `applyListing` on the TypeScript side, so its fingerprints are the real ones. The host
 * resolver of `checkResolvedServerAddress` is a case argument: `{ host: [addresses] }`, a host
 * that is not a key does not resolve; each lookup is one log line `resolve <host>`.
 */
import * as api from '../../../../apps/shell/src/shared/mcp-servers-api.ts'
import * as names from '../../../../packages/agent-core/src/user-mcp/names.ts'
import * as result from '../../../../packages/agent-core/src/user-mcp/result.ts'
import * as limits from '../../../../apps/shell/src/main/mcp-client/limits.ts'
import * as fingerprint from '../../../../apps/shell/src/main/mcp-client/fingerprint.ts'
import * as listing from '../../../../apps/shell/src/main/mcp-client/listing.ts'
import * as hubInput from '../../../../apps/shell/src/main/mcp-client/hub-input.ts'
import * as hubStrings from '../../../../apps/shell/src/main/mcp-client/hub-strings.ts'
import * as address from '../../../../apps/shell/src/main/mcp-client/address.ts'
import type { Case, FnSpec, Group } from '../../types.ts'

const one = (...args: unknown[]): Case => ({ args })
const cases = (...lists: unknown[][]): Case[] => lists.map((args) => ({ args }))
const j = (text: string): unknown => JSON.parse(text)
/** a constant: one answer is all there is */
const constant = (why: string, ts: FnSpec['ts']): FnSpec => ({ ts, cases: [one()], single: why })

// Hangul, spelled with escapes: a name with no usable letter
const KOREAN = '\uD55C\uAE00'
const HIGH_LOW = '\u{1F600}'

// ---------------------------------------------------------------------------
// mcp-servers-api
// ---------------------------------------------------------------------------

const FACTS_BASE = {
  enabled: true,
  commandReviewNeeded: false,
  loginRequired: false,
  failure: null as string | null,
  connecting: false,
  reached: false,
  listedBefore: false,
}
const facts = (over: Record<string, unknown>) => ({ ...FACTS_BASE, ...over })
const ALL_FACTS = {
  enabled: true,
  commandReviewNeeded: true,
  loginRequired: true,
  failure: 'unreachable',
  connecting: true,
  reached: true,
  listedBefore: true,
}

const REASONS = [
  'unreachable',
  'http-error',
  'runtime-missing',
  'start-failed',
  'refused-redirect',
  'insecure-address',
]

const PENDING = { description: 'changed', inputSchema: { type: 'object' } }

/** addresses for the reach and nearness questions */
const ADDRESSES = [
  'http://localhost:3000',
  'HTTP://LOCALHOST',
  'http://localhost./x',
  'http://dev.localhost/x',
  'http://127.0.0.1',
  'http://127.255.255.255:9/x',
  'http://10.0.0.5:8080/mcp',
  'http://172.15.255.255',
  'http://172.16.0.1',
  'http://172.31.255.255',
  'http://172.32.0.1',
  'http://192.168.1.2',
  'http://192.169.1.1',
  'http://8.8.8.8',
  'http://0x7f.1',
  'http://127.1',
  'http://2130706433',
  'http://010.0.0.1',
  'http://1.2.3',
  'http://[::1]:3000',
  'http://[::1]',
  'http://[0:0:0:0:0:0:0:1]',
  'http://[fc00::1]',
  'http://[fd00::abcd]',
  'http://[fe80::1]',
  'http://[febf::1]',
  'http://[fec0::1]',
  'http://[2001:db8::1]',
  'http://[::]',
  'http://[::ffff:127.0.0.1]',
  'http://[::FFFF:10.1.1.1]',
  'http://[::ffff:8.8.8.8]',
  'http://[::ffff:7f00:1]',
  'http://[::ffff:a00:1]',
  'http://[::ffff:ac10:1]',
  'http://[::ffff:ac20:1]',
  'http://[::ffff:808:808]',
  'http://[::127.0.0.1]',
  'http://[0:0:0:0:0:ffff:7f00:1]',
  'http://example.com',
  'http://M\u00FCnchen.de/x',
  'http://my-server.local',
  'http://user:pw@127.0.0.1@evil.example.com/',
  'http://127.0.0.1.nip.io',
  'https://example.com',
  'https://127.0.0.1',
  'https://10.0.0.1:443',
  'https://8.8.8.8',
  'https://[::1]',
  'https://[::ffff:127.0.0.1]',
  'https://[2001:db8::1]',
  'https://LOCALHOST',
  'ftp://127.0.0.1',
  'ws://192.168.0.1',
  'foo://bar',
  'localhost:3000',
  'mailto:a@b.c',
  'http://999.1.1.1',
  'http://a b',
  'http://[::1',
  'http://',
  'not a url',
  '',
  '   http://localhost/  ',
]

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

const A24 = 'a'.repeat(24)
const A25 = 'a'.repeat(25)

const SOURCE_CASES: unknown[][] = [
  ['abc', [], {}],
  ['abc', ['abc'], { url: 'https://dict.example.com' }],
  [KOREAN, [], { url: 'https://dict.example.com/mcp' }],
  [KOREAN, [], { url: 'https://www.example.com' }],
  [KOREAN, [], { url: 'https://mcp.api.example.com' }],
  [KOREAN, [], { url: 'https://mcp.com' }],
  [KOREAN, [], { url: 'https://a.b' }],
  [KOREAN, [], { url: 'http://x' }],
  [KOREAN, [], { url: 'http://www' }],
  [KOREAN, [], { url: 'http://127.0.0.1:8080' }],
  [KOREAN, [], { url: 'http://localhost' }],
  [KOREAN, [], { url: 'http://[::1]/' }],
  [KOREAN, [], { url: 'https://192.168.0.1' }],
  [KOREAN, [], { url: 'not a url' }],
  [KOREAN, [], { url: '  https://tools.example.org  ' }],
  [KOREAN, ['dict'], { url: 'https://dict.example.com' }],
  [KOREAN, [], { url: '', command: 'npx', args: ['-y', '@scope/pkg-name@1.2.3'] }],
  [KOREAN, [], { url: 'https://dict.example.com', command: 'npx', args: ['mcp-x'] }],
  [KOREAN, [], { command: 'npx', args: ['-y', '@scope/pkg-name@1.2.3'] }],
  [KOREAN, [], { command: 'uvx', args: ['mcp-server-time'] }],
  [KOREAN, [], { command: 'uv', args: ['run', '--with', 'x', 'server.py'] }],
  [KOREAN, [], { command: 'pnpm', args: ['dlx', 'tool', 'run', 'pkg'] }],
  [KOREAN, [], { command: 'node', args: ['/opt/app/dist/index.js'] }],
  [KOREAN, [], { command: 'node', args: ['C:\\app\\dist\\main.mjs', 'x'] }],
  [KOREAN, [], { command: 'C:\\Tools\\My.EXE', args: [] }],
  [KOREAN, [], { command: 'python3', args: ['-m', 'srv'] }],
  [KOREAN, [], { command: 'python', args: [] }],
  [KOREAN, [], { command: '  deno  ', args: ['run', '-A', 'main.ts'] }],
  [KOREAN, [], { command: 'npx', args: ['--yes'] }],
  [KOREAN, [], { command: 'npx', args: ['  ', '', 'pkg'] }],
  [KOREAN, [], { command: '/usr/bin/', args: [] }],
  [KOREAN, [], { command: 'npx', args: ['@scope'] }],
  [KOREAN, [], { command: 'npx', args: ['@a/b.c@2'] }],
  [KOREAN, [], { command: 'tool.CMD' }],
  [KOREAN, [], { command: 'foo.bat.exe' }],
  [KOREAN, [], { command: 'NPX', args: ['Pkg@Latest'] }],
  [KOREAN, [], { command: 'bun', args: ['x', 'pkg/sub'] }],
  [KOREAN, [], {}],
  ['', [], { command: 'npx', args: ['mcp-fetch'] }],
  ['---', ['mcp-fetch'], { command: 'npx', args: ['mcp-fetch'] }],
  ['My Server', [], { url: 'https://dict.example.com' }],
  ['a', ['a', 'A', 'a-2'], {}],
]

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------

const text = (t: string) => ({ type: 'text', text: t })
const BIG = 'x'.repeat(199_999)

const SHAPE_CASES: unknown[][] = [
  [null],
  [],
  ['text'],
  [5],
  [true],
  [[]],
  [[{ content: [text('a')] }]],
  [{}],
  [{ isError: true }],
  [{ isError: 'true' }],
  [{ content: 'x' }],
  [{ content: null }],
  [{ content: {} }],
  [{ content: [] }],
  [{ content: [], isError: true }],
  [{ content: [text('hi')] }],
  [{ content: [text('one'), text('two')] }],
  [{ content: [text('')] }],
  [{ content: [text(''), text('')] }],
  [{ content: [text('a'), { type: 'image', data: 'eA==', mimeType: 'image/png' }] }],
  [{ content: [{ type: 'image' }] }],
  [{ content: [{ type: 'image' }, { type: 'audio' }] }],
  [{ content: [{ type: 'image' }, { type: 'audio' }, text('t'), { type: 'resource' }] }],
  [{ content: [null, 'str', 5, [], { type: 'text' }, { type: 'text', text: 5 }, text('ok')] }],
  [{ content: [{ type: 'Text', text: 'x' }] }],
  [{ content: [text('failed')], isError: true }],
  [{ content: [text('x')], isError: 1 }],
  [{ content: [text('x')], isError: false }],
  [{ content: [{ type: 'image' }], isError: true }],
  [{ structuredContent: { a: 1 } }],
  [{ structuredContent: { a: 1 }, content: [text('{ "a": 1 }')] }],
  [{ structuredContent: { a: 1 }, content: [text('  {"a":1}\n')] }],
  [{ structuredContent: { a: 1 }, content: [text('{"a":2}')] }],
  [
    {
      structuredContent: { a: 1, b: [1, 2] },
      content: [text('not json'), text('{"b":[1,2],"a":1}')],
    },
  ],
  [{ structuredContent: { a: 1, b: [1, 2] }, content: [text('{"a":1,"b":[1,2]}')] }],
  [{ structuredContent: 1e21, content: [text('1e21')] }],
  [{ structuredContent: 1, content: [text('1.0')] }],
  [{ structuredContent: null, content: [text('t')] }],
  [{ structuredContent: null }],
  [{ structuredContent: 0 }],
  [{ structuredContent: false }],
  [{ structuredContent: '' }],
  [{ structuredContent: [] }],
  [{ structuredContent: j('{"__proto__":{"x":1},"b":2}') }],
  [
    {
      structuredContent: j('{"__proto__":{"x":1},"b":2}'),
      content: [text('{"b":2,"__proto__":{"x":1}}')],
    },
  ],
  [{ structuredContent: { r: 'line\nbreak \u2028 \u007f' }, content: [{ type: 'image' }] }],
  [{ content: [text('abcdef')] }, 3],
  [{ content: [text('abcdef')] }, 6],
  [{ content: [text('abcdef')] }, 7],
  [{ content: [text('abcdef')] }, 0],
  [{ content: [text('abcdef')] }, -5],
  [{ content: [text('abcdef')] }, 2.5],
  [{ content: [text(`ab${HIGH_LOW}cd`)] }, 2],
  [{ content: [text(`ab${HIGH_LOW}cd`)] }, 3],
  [{ content: [text(`ab${HIGH_LOW}cd`)] }, 4],
  [{ content: [text(`ab${HIGH_LOW}cd`)] }, 5],
  [{ content: [text(`ab${HIGH_LOW}cd`)] }, 3.5],
  [{ content: [text(`ab${HIGH_LOW}cd`)] }, 4.5],
  [{ content: [text(`${HIGH_LOW}ab`)] }, 1],
  [{ content: [text(`${HIGH_LOW}ab`)] }, 0.5],
  [{ content: [text(`${HIGH_LOW}ab`)] }, 0],
  [{ content: [text(`${HIGH_LOW}${HIGH_LOW}`)] }, 3],
  [{ content: [text('abc'), { type: 'image' }] }, 4],
  [{ content: [text(`${BIG}x`)] }],
  [{ content: [text(`${BIG}${HIGH_LOW}yy`)] }],
  [{ content: [text(BIG)] }],
]

// ---------------------------------------------------------------------------
// fingerprint and listing
// ---------------------------------------------------------------------------

const def = (description: string, inputSchema: unknown = { type: 'object' }) => ({
  description,
  inputSchema,
})

const READ = {
  name: 'read',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  annotations: { readOnlyHint: true },
}
const WRITE = { name: 'write', description: 'Write a file', inputSchema: { type: 'object' } }
const LIST = { name: 'list' }
const L0 = { tools: [READ, WRITE, LIST], instructions: 'Use read first.' }

const BASE = {
  id: 'srv1',
  name: 'files',
  kind: 'remote',
  enabled: true,
  url: 'https://example.com/mcp',
  tools: {},
  newTools: [],
  instructions: null,
  pendingInstructions: null,
  extra: { keep: ['me'] },
}
const accept = (server: unknown, l: unknown) =>
  listing.acceptFirstListing(server as never, l as never) as unknown as Record<string, unknown>
const apply = (server: unknown, l: unknown) =>
  listing.applyListing(server as never, l as never) as unknown as {
    server: Record<string, unknown>
    changes: unknown
  }

const S0 = accept(BASE, L0)
const withTools = (tools: unknown[], instructions: string | null = 'Use read first.') => ({
  tools,
  instructions,
})
const WRITE2 = { ...WRITE, description: 'Write a file safely' }
const S_CHANGED = apply(S0, withTools([READ, WRITE2, LIST])).server
const WRITE3 = {
  ...WRITE,
  description: 'Write three',
  inputSchema: { type: 'object', properties: {} },
}
const S_CHANGED_SCHEMA = apply(S0, withTools([READ, WRITE3, LIST])).server
const S_CHANGED_NEW = apply(S_CHANGED, withTools([READ, WRITE2, LIST, { name: 'extra' }])).server
const S_INSTR = apply(S0, withTools([READ, WRITE, LIST], 'New guide.')).server
const S_NO_PENDING_INSTR = accept(BASE, withTools([READ], null))

const LOCAL = {
  id: 'loc1',
  name: 'time',
  kind: 'local',
  command: 'uvx',
  args: ['mcp-server-time'],
  env: { TZ: 'UTC', A_KEY: '1' },
  approvedLaunch: null,
  approvedPlan: null,
  tools: {},
  newTools: [],
  instructions: null,
  pendingInstructions: null,
}
const PLAN = `sha256:${'ab'.repeat(32)}`
const LOCAL_FP = fingerprint.serverLaunchFingerprint(LOCAL as never)

const PROTO_TOOLS = j(
  '{"id":"p","kind":"remote","tools":{"__proto__":{"permission":"ask","approved":"x","definition":{"description":"d","inputSchema":{}},"pending":null},"constructor":{"permission":"off","approved":"y","definition":{"description":"","inputSchema":{}},"pending":null}},"newTools":["__proto__","gone"],"instructions":null,"pendingInstructions":null}',
)
const INT_TOOLS = accept(BASE, {
  tools: [{ name: 'b' }, { name: '10' }, { name: '2' }, { name: 'a' }],
  instructions: null,
})

// ---------------------------------------------------------------------------
// hub-input
// ---------------------------------------------------------------------------

const HELD_BIG: Record<string, string> = {}
for (let i = 0; i < 257; i++) HELD_BIG[`k${i}`] = 'v'
const HELD_256: Record<string, string> = {}
for (let i = 0; i < 256; i++) HELD_256[`k${i}`] = 'v'
const FP = `sha256:${'0123456789abcdef'.repeat(4)}`

const INPUT_CASES: unknown[][] = [
  [{ kind: 'remote', name: 'files' }],
  [{ kind: 'local', name: 'time', command: 'uvx', args: ['mcp-server-time'], env: { TZ: 'UTC' } }],
  [
    {
      allowPlainHttp: true,
      kind: 'local',
      env: { B: null, A: 'x' },
      name: 'x',
      command: 'c',
      unknown: 1,
    },
  ],
  [
    {
      kind: 'remote',
      name: 'r',
      url: 'https://e.example/mcp',
      transport: 'sse',
      key: 'secret',
      headers: { Authorization: 'Bearer x', Other: null },
      oauthClient: { clientId: 'id', clientSecret: null },
      allowPlainHttp: false,
      paste: { token: 'tok', index: 2 },
    },
  ],
  [{ kind: 'remote', name: 'r', key: null, oauthClient: null }],
  [{ kind: 'remote', name: 'r', paste: { token: 't', index: 0 } }],
  [{ name: 'r' }],
  [{ kind: 'other', name: 'r' }],
  [{ kind: 'remote' }],
  [{ kind: 'remote', name: 5 }],
  [{ kind: 'remote', name: 'n'.repeat(256) }],
  [{ kind: 'remote', name: 'n'.repeat(257) }],
  [{ kind: 'remote', name: HIGH_LOW.repeat(128) }],
  [{ kind: 'remote', name: HIGH_LOW.repeat(129) }],
  [null],
  [],
  [[]],
  ['text'],
  [{ kind: 'remote', name: 'r', url: 5 }],
  [{ kind: 'remote', name: 'r', url: 'u'.repeat(16384) }],
  [{ kind: 'remote', name: 'r', url: 'u'.repeat(16385) }],
  [{ kind: 'remote', name: 'r', transport: 'ws' }],
  [{ kind: 'remote', name: 'r', transport: 'auto' }],
  [{ kind: 'remote', name: 'r', key: 5 }],
  [{ kind: 'remote', name: 'r', headers: 'x' }],
  [{ kind: 'remote', name: 'r', headers: [] }],
  [{ kind: 'remote', name: 'r', headers: null }],
  [{ kind: 'remote', name: 'r', headers: { A: 5 } }],
  [{ kind: 'remote', name: 'r', headers: { '': 'x' } }],
  [{ kind: 'remote', name: 'r', headers: { ['k'.repeat(257)]: 'x' } }],
  [{ kind: 'remote', name: 'r', headers: HELD_256 }],
  [{ kind: 'remote', name: 'r', headers: HELD_BIG }],
  [{ kind: 'remote', name: 'r', headers: j('{"b":"1","__proto__":"x","2":"y","1":null}') }],
  [{ kind: 'remote', name: 'r', oauthClient: 'x' }],
  [{ kind: 'remote', name: 'r', oauthClient: { clientSecret: 's' } }],
  [{ kind: 'remote', name: 'r', oauthClient: { clientId: 'i' } }],
  [{ kind: 'remote', name: 'r', oauthClient: { clientId: 'i', clientSecret: 's', x: 1 } }],
  [{ kind: 'remote', name: 'r', oauthClient: { clientId: 5, clientSecret: null } }],
  [{ kind: 'local', name: 'r', args: 'x' }],
  [{ kind: 'local', name: 'r', args: [5] }],
  [{ kind: 'local', name: 'r', args: Array.from({ length: 257 }, () => 'a') }],
  [{ kind: 'local', name: 'r', args: Array.from({ length: 256 }, () => 'a') }],
  [{ kind: 'local', name: 'r', command: 5 }],
  [{ kind: 'local', name: 'r', env: { A: 'x'.repeat(16385) } }],
  [{ kind: 'remote', name: 'r', allowPlainHttp: 'yes' }],
  [{ kind: 'remote', name: 'r', allowPlainHttp: null }],
  [{ kind: 'remote', name: 'r', paste: null }],
  [{ kind: 'remote', name: 'r', paste: 'x' }],
  [{ kind: 'remote', name: 'r', paste: { token: '', index: 0 } }],
  [{ kind: 'remote', name: 'r', paste: { token: 't', index: -1 } }],
  [{ kind: 'remote', name: 'r', paste: { token: 't', index: 1.5 } }],
  [{ kind: 'remote', name: 'r', paste: { token: 't', index: '1' } }],
  [{ kind: 'remote', name: 'r', paste: { index: 1 } }],
  [{ kind: 'remote', name: 'r', paste: { token: 't'.repeat(201), index: 1 } }],
]

const PATCH_CASES: unknown[][] = [
  [{}],
  [{ name: 'renamed' }],
  [{ url: 'https://x.example', key: null, allowPlainHttp: true }],
  [{ kind: 'local', name: 'ignored kind', paste: { token: 't', index: 0 } }],
  [{ args: [], env: {} }],
  [{ name: 5 }],
  [{ headers: { A: 5 } }],
  [{ transport: 'x' }],
  [null],
  [],
  [[]],
  [7],
]

// ---------------------------------------------------------------------------
// address
// ---------------------------------------------------------------------------

const IPS = [
  '127.0.0.1',
  '10.1.2.3',
  '172.15.0.1',
  '172.16.0.1',
  '172.31.255.255',
  '172.32.0.1',
  '192.168.1.1',
  '192.167.1.1',
  '8.8.8.8',
  '0.0.0.0',
  '01.2.3.4',
  '1.2.3',
  '256.1.1.1',
  '::1',
  '0:0:0:0:0:0:0:1',
  '0000:0000:0000:0000:0000:0000:0000:0001',
  '[::1]',
  '[127.0.0.1]',
  '[',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:7f00:0001',
  '::ffff:8.8.8.8',
  '::ffff:0808:0808',
  '::FFFF:10.0.0.1',
  '0:0:0:0:0:ffff:7f00:0001',
  '0:0:0:0:0:ffff:127.0.0.1',
  '0::ffff:127.0.0.1',
  '::ffff:0:127.0.0.1',
  '::127.0.0.1',
  '::7f00:1',
  '100::ffff:7f00:1',
  'fc00::1',
  'fdff:ffff::1',
  'fd12:3456::1',
  'fe80::1',
  'febf::1',
  'fec0::1',
  'fbff::1',
  'fe80::1%zz9',
  '::1%zz9',
  '::ffff:127.0.0.1%zz9',
  '::ffff:7f00:1%zz9',
  '::ffff:8.8.8.8%zz9',
  '::ffff:127.0.0.1%1.2.3.4',
  '::ffff:8.8.8.8%1.2.3.4',
  'fe80::1%a:b',
  '::ffff:127.0.0.1.',
  '::ffff:1.2.3.4.5',
  '1:2:3:4:5:6:7:8',
  '1:2:3:4:5:6:7::',
  '1::',
  '::',
  '::2:3:4:5:6:7:8',
  '::ffff:ffff:ffff',
  '2001:db8::1',
  'abc',
  ' 127.0.0.1',
  '',
]

const CHECK_URLS = [
  'https://example.com',
  'HTTPS://Example.COM/x',
  'https://127.0.0.1',
  'http://localhost',
  'http://LOCALHOST:8080/mcp',
  'http://localhost./',
  'http://dev.localhost',
  'http://127.0.0.1:3000',
  'http://10.0.0.1:3000/mcp',
  'http://172.16.5.4',
  'http://172.32.5.4',
  'http://192.168.0.1',
  'http://8.8.8.8',
  'http://0x7f.1',
  'http://[::1]',
  'http://[::1]:9/x',
  'http://[fc00::1]',
  'http://[fe80::1]',
  'http://[2001:db8::1]',
  'http://[::ffff:127.0.0.1]',
  'http://[::ffff:8.8.8.8]',
  'http://[::127.0.0.1]',
  'http://example.com',
  'http://M\u00FCnchen.de',
  'ftp://example.com',
  'file:///etc/hosts',
  'mailto:a@b.c',
  'ws://localhost',
  'not a url',
  '',
  'http://',
  'https://',
  'http://a b',
  '  https://x.example  ',
  '  http://localhost  ',
]

const RESOLVES = {
  localhost: ['127.0.0.1', '::1'],
  'dev.localhost': ['127.0.0.1'],
  'tools.internal.example': ['10.0.0.5'],
  'mixed.example': ['10.0.0.5', '8.8.8.8'],
  'mapped.example': ['::ffff:10.0.0.5'],
  'v6.example': ['fd00::1', 'fe80::1%zz9'],
  'bad.example': ['not-an-ip'],
  'public.example': ['93.184.216.34'],
  'empty.example': [],
  'example.com': ['93.184.216.34'],
  'my-server.local': ['192.168.1.9'],
}

export const group: Group = {
  // ---- mcp-servers-api ----
  'mcp-servers-api.MCP_PERMISSIONS': constant('a constant', () => [...api.MCP_PERMISSIONS]),
  'mcp-servers-api.permissionOf': {
    ts: (a) => api.permissionOf(a[0]),
    cases: cases(
      ['always'],
      ['off'],
      ['ask'],
      ['ALWAYS'],
      ['Off'],
      [' always'],
      ['x'],
      [''],
      [null],
      [],
      [5],
      [true],
      [{}],
      [[]],
      [['always']],
    ),
  },
  'mcp-servers-api.serverStatusOf': {
    ts: (a) => api.serverStatusOf(a[0] as never),
    cases: [
      facts({ enabled: false }),
      { ...ALL_FACTS, enabled: false },
      facts({ commandReviewNeeded: true }),
      { ...ALL_FACTS, enabled: true },
      facts({ loginRequired: true }),
      facts({ loginRequired: true, failure: 'http-error', connecting: true, reached: true }),
      ...REASONS.map((failure) => facts({ failure })),
      facts({ failure: 'start-failed', connecting: true, reached: true, listedBefore: true }),
      facts({ connecting: true }),
      facts({ connecting: true, reached: true, listedBefore: true }),
      facts({ reached: true }),
      facts({ reached: true, listedBefore: true }),
      facts({ listedBefore: true }),
      facts({}),
    ].map((f) => one(f)),
  },
  'mcp-servers-api.toolDisplayOf': {
    ts: (a) => api.toolDisplayOf(a[0] as never, (a[1] ?? null) as never),
    cases: cases(
      [{ pending: null }, null],
      [{ pending: PENDING }, null],
      [{ pending: {} }, null],
      [{ pending: null }, 'empty'],
      [{ pending: PENDING }, 'empty'],
      [{ pending: PENDING }, 'too-long'],
      [{ pending: null }, 'collision'],
      [{ pending: PENDING }, 'server-name'],
      [{}, null],
      [{ pending: PENDING }],
    ),
  },
  'mcp-servers-api.MCP_SERVERS_SETTINGS_KEY': constant(
    'a constant',
    () => api.MCP_SERVERS_SETTINGS_KEY,
  ),
  'mcp-servers-api.MCP_SERVERS_CHANNELS': constant('a constant', () => api.MCP_SERVERS_CHANNELS),
  'mcp-servers-api.plainHttpReach': {
    ts: (a) => api.plainHttpReach(a[0] as string),
    cases: ADDRESSES.map((u) => one(u)),
  },
  'mcp-servers-api.isNearAddress': {
    ts: (a) => api.isNearAddress(a[0] as string),
    cases: ADDRESSES.map((u) => one(u)),
  },

  // ---- agent-core/user-mcp/names ----
  'agent-core/user-mcp/names.MCP_TOOL_PREFIX': constant('a constant', () => names.MCP_TOOL_PREFIX),
  'agent-core/user-mcp/names.MCP_NAME_SEPARATOR': constant(
    'a constant',
    () => names.MCP_NAME_SEPARATOR,
  ),
  'agent-core/user-mcp/names.MCP_SERVER_NAME_MAX': constant(
    'a constant',
    () => names.MCP_SERVER_NAME_MAX,
  ),
  'agent-core/user-mcp/names.MCP_TOOL_NAME_MAX': constant(
    'a constant',
    () => names.MCP_TOOL_NAME_MAX,
  ),
  'agent-core/user-mcp/names.APP_MCP_SERVER_NAME': constant(
    'a constant',
    () => names.APP_MCP_SERVER_NAME,
  ),
  'agent-core/user-mcp/names.RESERVED_MCP_SERVER_NAMES': constant('a constant', () => [
    ...names.RESERVED_MCP_SERVER_NAMES,
  ]),
  'agent-core/user-mcp/names.serverNameProblem': {
    ts: (a) => names.serverNameProblem(a[0] as string, a[1] as number | undefined),
    cases: cases(
      [''],
      ['files'],
      ['a-b_c-1'],
      [A24],
      [A25],
      [A25, 30],
      ['ab', 1],
      ['a', 0],
      ['', 0],
      ['bad name'],
      ['a.b'],
      [KOREAN],
      [HIGH_LOW],
      [HIGH_LOW, 1],
      [HIGH_LOW, 2],
      ['a__b'],
      ['__'],
      ['_'],
      ['_a'],
      ['a_'],
      ['a_b'],
      ['-a-'],
      ['seuoffice-editor'],
      ['SeuOffice-Editor'],
      ['ieumoffice-editor'],
      ['IEUMOFFICE-EDITOR'],
      ['seuoffice-editor2'],
      ['a\n'],
      ['a', 2.5],
      ['abc', 2.5],
    ),
  },
  'agent-core/user-mcp/names.isValidServerName': {
    ts: (a) => names.isValidServerName(a[0] as string, a[1] as number | undefined),
    cases: cases(
      ['files'],
      [''],
      ['a b'],
      [A25],
      [A25, 40],
      ['seuoffice-editor'],
      ['x', 0],
      ['a_'],
    ),
  },
  'agent-core/user-mcp/names.suggestServerName': {
    ts: (a) =>
      names.suggestServerName(
        a[0] as string,
        a[1] as string[] | undefined,
        a[2] as number | undefined,
      ),
    cases: cases(
      ['My Server'],
      ['My Server', []],
      ['hello world!!'],
      ['a__b'],
      ['a___b'],
      ['__x__'],
      ['--x--'],
      ['x_'],
      ['a-_-b'],
      ['a  b'],
      [''],
      ['---'],
      ['___'],
      [KOREAN],
      [`${KOREAN}abc${KOREAN}`],
      [`a${HIGH_LOW}b`],
      [`a_${HIGH_LOW}_b`],
      [`${HIGH_LOW}${HIGH_LOW}`],
      [`${HIGH_LOW}x`],
      ['server', ['server']],
      ['server', ['SERVER']],
      ['x', ['x', 'x-2', 'x-3']],
      ['x', ['X', 'x-2', 'x-3', 'x-4']],
      ['x', ['x', 'x']],
      ['x', ['y', 'z']],
      ['x', [`x${KOREAN}`]],
      ['seuoffice-editor'],
      ['IEUMOFFICE-EDITOR', []],
      ['abcdefghijklmnopqrstuvwxyz0123'],
      ['abcd-efgh', [], 5],
      ['abcdefghijklmnopqrstuvwxyz0123', ['abcdefghijklmnopqrstuvwx']],
      [A24, [A24]],
      [A24, [A24, `${'a'.repeat(22)}-2`]],
      ['abc', [], 0],
      ['abc', ['abc'], 2],
      ['abc', ['abc', 'abc-2'], 5],
      ['abcdef', [], 3.5],
      ['abcdef', [], 1],
      ['abcdef', ['a'], 1],
      ['a-b', ['a'], 2],
      ['a-b-c', [], 3],
      ['a', ['a'], 3],
      ['a_b', [], 2],
    ),
  },
  'agent-core/user-mcp/names.suggestServerNameFrom': {
    ts: (a) =>
      names.suggestServerNameFrom(a[0] as string, a[1] as string[] | undefined, a[2] as never),
    cases: SOURCE_CASES.map((args) => one(...args)),
  },
  'agent-core/user-mcp/names.toolStepLabel': {
    ts: (a) => names.toolStepLabel(a[0] as string),
    cases: cases(
      ['mcp__server__tool'],
      ['mcp__a__b__c'],
      ['mcp__a___t'],
      ['read_file'],
      ['open-in-seuoffice'],
      ['mcp__bad__'],
      ['mcp__srv'],
      ['mcp__'],
      ['mcp___x__t'],
      ['mcp____t'],
      [`mcp__a__${'t'.repeat(56)}`],
      [`mcp__a__${'t'.repeat(57)}`],
      [`mcp__a__${KOREAN}`],
      ['a__--__b'],
      ['--'],
      [''],
    ),
  },
  'agent-core/user-mcp/names.sanitizeToolName': {
    ts: (a) => names.sanitizeToolName(a[0] as string),
    cases: cases(
      ['read_file'],
      ['read file'],
      ['a.b/c'],
      [HIGH_LOW],
      [`a${HIGH_LOW}b`],
      [KOREAN],
      [''],
      ['ok-name_1'],
      ['a\n'],
    ),
  },
  'agent-core/user-mcp/names.mcpToolName': {
    ts: (a) => names.mcpToolName(a[0] as string, a[1] as string),
    cases: cases(['a', 'b'], ['', ''], ['x__y', 'z'], [KOREAN, HIGH_LOW]),
  },
  'agent-core/user-mcp/names.isMcpToolName': {
    ts: (a) => names.isMcpToolName(a[0] as string),
    cases: cases(
      ['mcp__a__b'],
      ['mcp__'],
      ['mcp_'],
      ['MCP__a'],
      [''],
      ['xmcp__'],
      ['open_in_seuoffice'],
    ),
  },
  'agent-core/user-mcp/names.mapServerToolNames': {
    ts: (a) => names.mapServerToolNames(a[0] as string, a[1] as string[]),
    cases: cases(
      ['files', ['read', 'write']],
      ['files', []],
      ['files', ['a b', 'a_b']],
      ['files', ['x', 'x']],
      ['files', ['', '']],
      ['files', ['', 'x']],
      ['files', [HIGH_LOW]],
      ['files', [`a${HIGH_LOW}`, 'a__']],
      ['files', [KOREAN, 'x']],
      ['bad__server', ['x']],
      ['_x', ['x', '']],
      ['', ['x']],
      ['bad name', ['x', 'x']],
      ['seuoffice-editor', ['x']],
      ['s', ['t'.repeat(56)]],
      ['s', ['t'.repeat(57)]],
      ['s', [`${'t'.repeat(56)}${HIGH_LOW}`, 't']],
      ['srv', ['a'.repeat(60), 'ok']],
      ['srv', ['a-b', 'a_b', 'a-b']],
    ),
  },
  'agent-core/user-mcp/names.parseMcpToolName': {
    ts: (a) => names.parseMcpToolName(a[0] as string),
    cases: cases(
      ['mcp__srv__tool'],
      ['mcp__srv__'],
      ['mcp__srv'],
      ['srv__tool'],
      ['mcp__a__b__c'],
      ['mcp__a___t'],
      ['mcp__-a__t'],
      ['mcp__a-__t'],
      ['mcp____t'],
      ['mcp___a__t'],
      ['mcp__a___'],
      ['mcp__a__t!'],
      [`mcp__a__${'t'.repeat(56)}`],
      [`mcp__a__${'t'.repeat(57)}`],
      [`mcp__${KOREAN}__t`],
      ['mcp__a__t\n'],
      [''],
    ),
  },
  'agent-core/user-mcp/names.parseMcpToolNameIn': {
    ts: (a) => names.parseMcpToolNameIn(a[0] as string, a[1] as string[]),
    cases: cases(
      ['mcp__a__t', ['a']],
      ['mcp__a__t', ['b', 'a']],
      ['mcp__a__t', ['b']],
      ['mcp__a__t', []],
      ['mcp__A__t', ['a']],
      ['mcp__a__', ['a']],
      ['nope', ['a']],
    ),
  },

  // ---- agent-core/user-mcp/result ----
  'agent-core/user-mcp/result.MCP_RESULT_MAX_CHARS': constant(
    'a constant',
    () => result.MCP_RESULT_MAX_CHARS,
  ),
  'agent-core/user-mcp/result.MCP_RESULT_UNREADABLE': constant(
    'a constant',
    () => result.MCP_RESULT_UNREADABLE,
  ),
  'agent-core/user-mcp/result.MCP_RESULT_EMPTY': constant(
    'a constant',
    () => result.MCP_RESULT_EMPTY,
  ),
  'agent-core/user-mcp/result.MCP_ERROR_EMPTY': constant(
    'a constant',
    () => result.MCP_ERROR_EMPTY,
  ),
  'agent-core/user-mcp/result.MCP_NO_ANSWER': constant('a constant', () => result.MCP_NO_ANSWER),
  'agent-core/user-mcp/result.shapeMcpResult': {
    ts: (a) => result.shapeMcpResult(a[0], a[1] as number | undefined),
    cases: SHAPE_CASES.map((args) => one(...args)),
  },
  'agent-core/user-mcp/result.shapedMcpAnswer': {
    ts: (a) => result.shapedMcpAnswer(a[0] as never),
    cases: cases(
      [{ output: 'x', isError: false }],
      [{ output: '', isError: true }],
      [{ output: 'a\nb', isError: true, extra: 1 }],
    ),
  },
  'agent-core/user-mcp/result.mcpCallAnswerOf': {
    ts: (a) => result.mcpCallAnswerOf(a[0]),
    cases: cases(
      [null],
      [],
      ['x'],
      [5],
      [true],
      [[]],
      [[1]],
      [{}],
      [{ ok: false }],
      [{ ok: false, error: '' }],
      [{ ok: false, error: 'boom' }],
      [{ ok: false, error: 5 }],
      [{ ok: false, error: 'e', output: 'x' }],
      [{ ok: true }],
      [{ ok: true, output: 'x' }],
      [{ ok: true, output: '' }],
      [{ ok: true, output: 'x', isError: true }],
      [{ ok: true, output: 'x', isError: 'yes' }],
      [{ ok: true, output: 5 }],
      [{ ok: 'true', output: 'x' }],
      [{ ok: 1, output: 'x' }],
    ),
  },

  // ---- limits ----
  'limits.MCP_CALL_TIMEOUT_MS': constant('a constant', () => limits.MCP_CALL_TIMEOUT_MS),

  // ---- fingerprint ----
  'fingerprint.stableJson': {
    ts: (a) => fingerprint.stableJson(a[0]),
    cases: cases(
      [{ b: 1, a: 2 }],
      [{ b: { d: 1, c: [{ z: 1, y: 2 }, 3] }, a: null }],
      [[3, { b: 1, a: 2 }, [{ y: 1, x: 2 }]]],
      [j('{"b":1,"__proto__":{"z":1,"a":2},"a":0}')],
      [j('{"b":1,"10":2,"2":3,"a":4,"1":5}')],
      [{ '\uFF5E': 1, [HIGH_LOW]: 2, z: 3, '\u00E9': 4 }],
      [{ [`${HIGH_LOW}a`]: 1, [`${HIGH_LOW}`]: 2, '\uE000': 3 }],
      [{ n: [1e21, 1e-7, 0.1 + 0.2, 100, 1.5e300], s: 'q"\\\n\u0001\u2028\u007f' }],
      [null],
      [],
      ['text'],
      [5],
      [[]],
      [{}],
      [{ a: {} }],
    ),
  },
  'fingerprint.fingerprintOf': {
    ts: (a) => fingerprint.fingerprintOf(a[0] as string),
    cases: cases([''], ['abc'], ['\u00E9'], ['e\u0301'], [HIGH_LOW], ['a\r\nb']),
  },
  'fingerprint.toolFingerprint': {
    ts: (a) => fingerprint.toolFingerprint(a[0] as string, a[1] as never),
    cases: cases(
      ['read', def('Read a file')],
      ['read', def('Read a file', { type: 'object', properties: { a: 1 } })],
      ['read', def('Read a file', { properties: { a: 1 }, type: 'object' })],
      ['write', def('Read a file')],
      ['read', def('line1\r\nline2')],
      ['read', def('line1\nline2')],
      ['read', def('line1\rline2')],
      ['read', def('a\r\r\nb')],
      ['read', def('\u00E9')],
      ['read', def('e\u0301')],
      ['read', def('\u1112\u1161\u11AB')],
      ['read', def('\uD55C')],
      ['read', def('\uFB01')],
      ['read', { inputSchema: {} }],
      ['read', { description: null, inputSchema: null }],
      ['read', { description: 'd' }],
      ['read', {}],
      ['read', { description: 'd', inputSchema: {}, annotations: { readOnlyHint: true } }],
      ['read', { description: 'd', inputSchema: {} }],
      [KOREAN, def('d')],
      ['', def('')],
      ['x', def('d', j('{"__proto__":{"a":1},"b":[1,{"d":1,"c":2}]}'))],
    ),
  },
  'fingerprint.instructionsFingerprint': {
    ts: (a) => fingerprint.instructionsFingerprint(a[0] as string),
    cases: cases(
      [''],
      ['Use read first.'],
      ['a\r\nb'],
      ['a\nb'],
      ['a\rb'],
      ['\u00E9'],
      ['e\u0301'],
      [`${KOREAN}\r\n`],
    ),
  },
  'fingerprint.launchFingerprint': {
    ts: (a) => fingerprint.launchFingerprint(a[0] as never),
    cases: cases(
      [{ command: 'uvx', args: ['mcp-server-time'], envNames: ['TZ', 'A_KEY'] }],
      [{ command: 'uvx', args: ['mcp-server-time'], envNames: ['A_KEY', 'TZ'] }],
      [{ command: 'uvx', args: ['b', 'a'], envNames: [] }],
      [{ command: 'uvx', args: ['a', 'b'], envNames: [] }],
      [{ command: '', args: [], envNames: [] }],
      [{ command: 'c', args: [], envNames: ['\u00E9', 'z', HIGH_LOW, '\uFF5E', 'Z', '10', '9'] }],
      [{ command: 'c', args: [], envNames: ['__proto__', 'a'] }],
      [{ command: 'c\u0301', args: ['e\u0301'], envNames: [] }],
    ),
  },
  'fingerprint.planFingerprint': {
    ts: (a) => fingerprint.planFingerprint(a[0] as never),
    cases: cases(
      [
        {
          command: '/usr/bin/uvx',
          args: ['a'],
          env: [
            { name: 'B', origin: 'app' },
            { name: 'A', origin: 'user' },
          ],
        },
      ],
      [
        {
          command: '/usr/bin/uvx',
          args: ['a'],
          env: [
            { name: 'A', origin: 'user' },
            { name: 'B', origin: 'app' },
          ],
        },
      ],
      [{ command: '/usr/bin/uvx', args: [], env: [] }],
      [
        {
          command: 'c',
          args: [],
          env: [
            { name: 'A', origin: 'z' },
            { name: 'A', origin: 'a' },
          ],
        },
      ],
      [
        {
          command: 'c',
          args: [],
          env: [
            { name: 'A', origin: 'a' },
            { name: 'A', origin: 'z' },
          ],
        },
      ],
      [
        {
          command: 'c',
          args: [],
          env: [
            { name: HIGH_LOW, origin: 'a' },
            { name: '\uFF5E', origin: 'b' },
            { name: 'a', origin: 'c' },
          ],
        },
      ],
      [{ command: 'c', args: [], env: [{ name: 'B', origin: 'x', extra: 1 }] }],
    ),
  },
  'fingerprint.serverLaunchFingerprint': {
    ts: (a) => fingerprint.serverLaunchFingerprint(a[0] as never),
    cases: cases(
      [LOCAL],
      [{ ...LOCAL, env: { A_KEY: 'other', TZ: 'x' } }],
      [{ ...LOCAL, env: {} }],
      [{ ...LOCAL, env: j('{"b":"1","__proto__":"x","2":"y"}') }],
      [{ ...LOCAL, args: ['mcp-server-time', '--flag'] }],
      [{ ...LOCAL, command: 'npx' }],
      [{ ...LOCAL, kind: 'remote' }],
    ),
  },
  'fingerprint.launchReviewNeeded': {
    ts: (a) => fingerprint.launchReviewNeeded(a[0] as never),
    cases: cases(
      [{ ...LOCAL, kind: 'remote' }],
      [LOCAL],
      [{ ...LOCAL, approvedLaunch: LOCAL_FP, approvedPlan: PLAN }],
      [{ ...LOCAL, approvedLaunch: LOCAL_FP, approvedPlan: null }],
      [{ ...LOCAL, approvedLaunch: 'sha256:other', approvedPlan: PLAN }],
      [{ ...LOCAL, approvedLaunch: LOCAL_FP, approvedPlan: PLAN, args: ['changed'] }],
      [{ ...LOCAL, approvedLaunch: LOCAL_FP, approvedPlan: PLAN, env: { TZ: 'x', A_KEY: 'y' } }],
      [{ ...LOCAL, approvedLaunch: LOCAL_FP, approvedPlan: PLAN, env: { TZ: 'x' } }],
      [{ ...LOCAL, approvedLaunch: LOCAL_FP }],
      [{ ...LOCAL, approvedLaunch: LOCAL_FP, approvedPlan: undefined }],
      [{ ...LOCAL, approvedLaunch: null }],
    ),
  },

  // ---- listing ----
  'listing.initialPermission': {
    ts: (a) => listing.initialPermission(a[0] as never),
    cases: cases(
      [],
      [null],
      [{}],
      [{ readOnlyHint: true }],
      [{ readOnlyHint: false }],
      [{ readOnlyHint: 'true' }],
      [{ readOnlyHint: true, destructiveHint: true }],
      [[]],
      ['readOnlyHint'],
    ),
  },
  'listing.definitionOf': {
    ts: (a) => listing.definitionOf(a[0] as never),
    cases: cases(
      [{ name: 'a' }],
      [{ name: 'a', description: 'd', inputSchema: { type: 'object' } }],
      [{ name: 'a', description: '', inputSchema: null }],
      [{ name: 'a', description: null }],
      [{ name: 'a', annotations: {} }],
      [{ name: 'a', annotations: { readOnlyHint: true, title: 'T' } }],
      [{ name: 'a', annotations: null }],
      [{ name: 'a', inputSchema: j('{"__proto__":{"x":1}}') }],
    ),
  },
  'listing.acceptFirstListing': {
    ts: (a) => listing.acceptFirstListing(a[0] as never, a[1] as never),
    cases: cases(
      [BASE, L0],
      [BASE, withTools([], null)],
      [BASE, withTools([], '')],
      [BASE, withTools([READ], 'Guide')],
      [
        BASE,
        withTools([
          { name: 'a', description: '1' },
          { name: 'b' },
          { name: 'a', description: '2', annotations: { readOnlyHint: true } },
        ]),
      ],
      [
        BASE,
        withTools(
          j('[{"name":"__proto__","description":"p"},{"name":"constructor"}]') as unknown[],
        ),
      ],
      [BASE, withTools([{ name: 'b' }, { name: '10' }, { name: '2' }, { name: 'a' }], null)],
      [S_CHANGED_NEW, L0],
      [{ id: 'bare' }, L0],
      [{}, withTools([READ], null)],
      [
        {
          ...BASE,
          tools: { gone: 1 },
          newTools: ['gone'],
          instructions: { approved: 'x', text: 'y' },
          pendingInstructions: 'z',
        },
        withTools([LIST], null),
      ],
    ),
  },
  'listing.applyListing': {
    ts: (a) => apply(a[0], a[1]),
    cases: cases(
      [S0, L0],
      [S0, withTools([READ, WRITE2, LIST])],
      [S_CHANGED, withTools([READ, WRITE2, LIST])],
      [S_CHANGED, withTools([READ, { ...WRITE, description: 'Write differently' }, LIST])],
      [S_CHANGED, L0],
      [
        S_CHANGED_SCHEMA,
        withTools([READ, { ...WRITE3, inputSchema: { properties: {}, type: 'object' } }, LIST]),
      ],
      [S0, withTools([READ, LIST])],
      [S0, withTools([])],
      [S0, withTools([READ, WRITE, LIST, { name: 'extra', annotations: { readOnlyHint: true } }])],
      [
        S0,
        withTools([READ, WRITE, LIST, { name: 'extra' }, { name: 'extra', description: 'later' }]),
      ],
      [S_CHANGED_NEW, withTools([READ, WRITE2, LIST])],
      [S_CHANGED_NEW, withTools([READ, WRITE2, LIST, { name: 'extra' }])],
      [S_CHANGED_NEW, withTools([READ, WRITE, { name: 'other' }])],
      [S0, withTools([READ, WRITE, LIST], 'New guide.')],
      [S_INSTR, withTools([READ, WRITE, LIST], 'New guide.')],
      [S_INSTR, withTools([READ, WRITE, LIST], 'Use read first.')],
      [S0, withTools([READ, WRITE, LIST], null)],
      [S0, withTools([READ, WRITE, LIST], '')],
      [S_NO_PENDING_INSTR, withTools([READ], 'Now there is a guide')],
      [S_NO_PENDING_INSTR, withTools([READ], null)],
      [{ ...S0, instructions: undefined }, L0],
      [S0, withTools([{ ...READ, annotations: { readOnlyHint: false } }, WRITE, LIST])],
      [S0, withTools([{ ...READ, annotations: undefined }, WRITE, LIST])],
      [S0, withTools([{ ...WRITE, annotations: { title: 'W' } }, READ, LIST])],
      [
        S0,
        withTools([
          {
            ...READ,
            inputSchema: {
              required: ['path'],
              properties: { path: { type: 'string' } },
              type: 'object',
            },
          },
          WRITE,
          LIST,
        ]),
      ],
      [
        S0,
        withTools([
          { ...READ, description: 'Read a file' },
          { ...WRITE, description: 'Write a file' },
          LIST,
        ]),
      ],
      [S0, withTools([{ ...READ, inputSchema: { type: 'object' } }, WRITE, LIST])],
      [
        accept(BASE, withTools([{ name: 'n', description: 'e\u0301' }], null)),
        withTools([{ name: 'n', description: '\u00E9' }], null),
      ],
      [
        accept(BASE, withTools([{ name: 'n', description: 'a\r\nb' }], null)),
        withTools([{ name: 'n', description: 'a\nb' }], null),
      ],
      [
        accept(BASE, withTools([{ name: 'n', description: 'a' }], null)),
        withTools([{ name: 'n', description: 'b' }], null),
      ],
      [
        {
          ...S0,
          tools: {
            ...(S0.tools as object),
            read: { ...(S0.tools as Record<string, object>).read, approved: 'sha256:tampered' },
          },
        },
        L0,
      ],
      [{ ...S0, newTools: ['read', 'gone', 5, 'read', 'write'] }, L0],
      [{ ...S0, newTools: ['read', 'gone'] }, withTools([READ, { name: 'fresh' }])],
      [{ ...S0, newTools: ['write'] }, withTools([READ, WRITE, { name: 'write' }])],
      [
        PROTO_TOOLS,
        withTools(
          [{ name: '__proto__', description: 'd' }, { name: 'constructor' }, { name: 'toString' }],
          null,
        ),
      ],
      [PROTO_TOOLS, withTools([], null)],
      [INT_TOOLS, withTools([{ name: 'a' }, { name: '2' }, { name: 'zz' }], null)],
      [INT_TOOLS, withTools([{ name: 'a' }, { name: 'b' }, { name: '10' }, { name: '2' }], null)],
      [
        {
          ...S0,
          tools: {
            read: {
              permission: 'always',
              approved: 'x',
              definition: { description: 'd', inputSchema: {} },
            },
          },
        },
        withTools([READ], 'Use read first.'),
      ],
    ),
  },
  'listing.approveTool': {
    ts: (a) => listing.approveTool(a[0] as never, a[1] as string),
    cases: cases(
      [S_CHANGED, 'write'],
      [S_CHANGED, 'read'],
      [S_CHANGED, 'missing'],
      [S0, 'write'],
      [S_CHANGED, 'constructor'],
      [PROTO_TOOLS, '__proto__'],
      [
        {
          ...(PROTO_TOOLS as object),
          tools: j(
            '{"__proto__":{"permission":"ask","approved":"x","definition":{"description":"d","inputSchema":{}},"pending":{"description":"new","inputSchema":{"a":1}}}}',
          ),
        },
        '__proto__',
      ],
      [
        {
          id: 'x',
          tools: {
            t: { permission: 'off', approved: 'a', definition: def('d'), pending: def('e\u0301') },
          },
        },
        't',
      ],
      [{ id: 'x', tools: { t: { permission: 'off', approved: 'a', definition: def('d') } } }, 't'],
    ),
  },
  'listing.approveInstructions': {
    ts: (a) => listing.approveInstructions(a[0] as never),
    cases: cases(
      [S_INSTR],
      [S0],
      [{ id: 'x', pendingInstructions: 'a\r\nb' }],
      [{ id: 'x', pendingInstructions: null }],
    ),
  },
  'listing.approveLaunch': {
    ts: (a) => listing.approveLaunch(a[0] as never, a[1] as string),
    cases: cases(
      [LOCAL, PLAN],
      [{ ...LOCAL, approvedLaunch: 'x', approvedPlan: 'y' }, PLAN],
      [{ ...LOCAL, kind: 'remote' }, PLAN],
      [{ id: 'l', kind: 'local', command: 'c', args: [], env: {} }, PLAN],
      [{ id: 'l' }, PLAN],
    ),
  },
  'listing.markToolsSeen': {
    ts: (a) => listing.markToolsSeen(a[0] as never),
    cases: cases([S_CHANGED_NEW], [S0], [{ id: 'x', newTools: ['a'] }]),
  },
  'listing.setToolPermission': {
    ts: (a) => listing.setToolPermission(a[0] as never, a[1] as string, a[2] as never),
    cases: cases(
      [S0, 'read', 'off'],
      [S0, 'write', 'always'],
      [S0, 'write', 'ask'],
      [S0, 'missing', 'off'],
      [S0, 'constructor', 'off'],
      [PROTO_TOOLS, '__proto__', 'always'],
      [INT_TOOLS, 'a', 'off'],
      [INT_TOOLS, '2', 'always'],
    ),
  },
  'listing.toolsAwaitingReview': {
    ts: (a) => listing.toolsAwaitingReview(a[0] as never),
    cases: cases(
      [S_CHANGED],
      [S0],
      [{ id: 'x', tools: {} }],
      [
        {
          id: 'x',
          tools: {
            b: { pending: def('x') },
            a: { pending: null },
            c: {},
            '2': { pending: def('y') },
          },
        },
      ],
      [PROTO_TOOLS],
    ),
  },

  // ---- hub-input ----
  'hub-input.serverIdOf': {
    ts: (a) => hubInput.serverIdOf(a[0]),
    cases: cases(
      ['a'],
      [''],
      ['x'.repeat(200)],
      ['x'.repeat(201)],
      [HIGH_LOW.repeat(100)],
      [HIGH_LOW.repeat(101)],
      [5],
      [null],
      [],
      [['a']],
      [{}],
    ),
  },
  'hub-input.toolNameOf': {
    ts: (a) => hubInput.toolNameOf(a[0]),
    cases: cases(
      ['read'],
      [''],
      ['x'.repeat(256)],
      ['x'.repeat(257)],
      [HIGH_LOW.repeat(128)],
      [HIGH_LOW.repeat(129)],
      [0],
      [null],
      [],
    ),
  },
  'hub-input.pasteTextOf': {
    ts: (a) => hubInput.pasteTextOf(a[0]),
    cases: cases(
      [''],
      ['{"mcpServers":{}}'],
      ['p'.repeat(262_144)],
      ['p'.repeat(262_145)],
      [5],
      [null],
      [],
    ),
  },
  'hub-input.permissionOfInput': {
    ts: (a) => hubInput.permissionOfInput(a[0]),
    cases: cases(['always'], ['ask'], ['off'], ['Off'], [''], [null], [], [5], [['off']]),
  },
  'hub-input.booleanOf': {
    ts: (a) => hubInput.booleanOf(a[0]),
    cases: cases([true], [false], ['true'], [1], [0], [null], []),
  },
  'hub-input.planFingerprintOf': {
    ts: (a) => hubInput.planFingerprintOf(a[0]),
    cases: cases(
      [FP],
      [PLAN],
      [FP.toUpperCase()],
      [`sha256:${'A'.repeat(64)}`],
      [FP.slice(0, -1)],
      [`${FP}0`],
      [`${FP}\n`],
      [` ${FP}`],
      [`sha256:${'g'.repeat(64)}`],
      [FP.slice(7)],
      ['sha1:' + 'a'.repeat(64)],
      [5],
      [null],
      [],
    ),
  },
  'hub-input.mcpServerInputOf': {
    ts: (a) => hubInput.mcpServerInputOf(a[0]),
    cases: INPUT_CASES.map((args) => one(...args)),
  },
  'hub-input.mcpServerPatchOf': {
    ts: (a) => hubInput.mcpServerPatchOf(a[0]),
    cases: PATCH_CASES.map((args) => one(...args)),
  },

  // ---- hub-strings ----
  'hub-strings.MCP_HUB_STRINGS': constant('a constant', () => hubStrings.MCP_HUB_STRINGS),
  'hub-strings.mcpHubText': {
    ts: (a) => hubStrings.mcpHubText(a[0] as never, a[1] as never),
    cases: (['en', 'ko'] as const).flatMap((lang) =>
      [
        'pageDoneTitle',
        'pageDoneBody',
        'pageFailedTitle',
        'pageFailedBody',
        'problemNeedsCommandWindow',
        'problemEmptyCommand',
        'problemNotAProgram',
        'problemRuntimeMissing',
        'problemDidNotStart',
        'noSuchKey',
      ].map((key) => one(lang, key)),
    ),
  },
  'hub-strings.mcpSignInPages': {
    ts: (a) => hubStrings.mcpSignInPages(a[0] as never),
    cases: cases(['en'], ['ko']),
  },
  'hub-strings.mcpLaunchProblemText': {
    ts: (a) => hubStrings.mcpLaunchProblemText(a[0] as never, a[1] as never),
    cases: (['en', 'ko'] as const).flatMap((lang) =>
      [
        'needs-command-window',
        'empty-command',
        'not-a-program',
        'runtime-missing',
        'did-not-start',
      ].map((problem) => one(lang, problem)),
    ),
  },

  // ---- address ----
  'address.plainHttpAllowedIp': {
    ts: (a) => address.plainHttpAllowedIp(a[0] as string),
    cases: IPS.map((ip) => one(ip)),
  },
  'address.checkServerAddress': {
    ts: (a) => address.checkServerAddress(a[0] as string),
    cases: CHECK_URLS.map((u) => one(u)),
  },
  'address.checkResolvedServerAddress': {
    ts: async (a, cx) => {
      const table = a[1] as Record<string, string[]>
      return address.checkResolvedServerAddress(a[0] as string, async (host) => {
        cx.log('resolve', host)
        const found = Object.hasOwn(table, host) ? table[host] : undefined
        if (found === undefined) throw new Error(`ENOTFOUND ${host}`)
        return found
      })
    },
    cases: [
      ['https://example.com', RESOLVES],
      ['http://127.0.0.1', RESOLVES],
      ['http://8.8.8.8', RESOLVES],
      ['http://[::1]', RESOLVES],
      ['http://localhost', RESOLVES],
      ['http://LOCALHOST:3000/x', RESOLVES],
      ['http://localhost', { localhost: ['127.0.0.1', '8.8.8.8'] }],
      ['http://localhost', { localhost: [] }],
      ['http://localhost', {}],
      ['http://dev.localhost', RESOLVES],
      ['http://tools.internal.example', RESOLVES],
      ['http://mixed.example', RESOLVES],
      ['http://mapped.example', RESOLVES],
      ['http://v6.example', RESOLVES],
      ['http://bad.example', RESOLVES],
      ['http://public.example', RESOLVES],
      ['http://empty.example', RESOLVES],
      ['http://unknown.example', RESOLVES],
      ['http://example.com', RESOLVES],
      ['http://my-server.local:8080/mcp', RESOLVES],
      ['  http://my-server.local  ', RESOLVES],
      ['ftp://example.com', RESOLVES],
      ['not a url', RESOLVES],
      ['http://', RESOLVES],
      ['', RESOLVES],
    ].map((args) => one(...args)),
  },
}
