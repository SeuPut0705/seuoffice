/**
 * Group `b5-mcp`, slice `client-files` (Rust: crates/main-core/src/calls/b5_mcp/client_files.rs):
 * the files of `apps/shell/src/main/mcp-client` that read, write and run
 * programs from the person's MCP settings: toml, paste, secrets, store,
 * runtime-pins, runtime-archive and local-launch. Functions are
 * `<file>.<export>`.
 *
 * - toml.parseToml answers `{ ok: table }` or `{ error, name, line }`. A
 *   number JSON cannot write (inf, nan) prints as `null` on both sides.
 * - paste.parseMcpPaste(text, taken): the result as it crosses to a screen.
 * - A secret codec in a case is `{ canSeal, sealThrows?, open? }`: it seals `x`
 *   as `sealed:v1:` + encodeURIComponent(x) (a value holding `!throw` makes
 *   the seal throw, so does `sealThrows`) and opens by decodeURIComponent
 *   (`open` is `decode` by default, `null` or `throw`; a value holding
 *   `other-pc` opens to null). A server of a case is the stored form: it goes
 *   through normalizeMcpServersFile before the function under test.
 * - secrets.safeStorageMcpCodec: a storage is `{ available, backend?,
 *   encryptThrows?, decryptThrows? }`; it encrypts `x` as the bytes `enc:x`.
 * - store.scenario: a script of steps over one store on `$DIR/mcp-servers.json`
 *   and the fake codec; each step answers a value or `{ error }`. Steps:
 *   `load`, `get`, `server` (id), `update` (ops, `ret`: `void` | `empty`),
 *   `removeServer` (id), `sealing`, `view`, `read` (the file's text or null),
 *   `write` (text), `remove` (the file). Update ops: `['add', input, id?]`,
 *   `['patch', id, fields]`, `['runtime', name, allowed]`, `['drop', id]`.
 *   A random id reads as `<uuid>`, a temp file name as `.<hex>.tmp`.
 * - runtime-archive.downloadVerifiedArchive: the fetch is `{ status?, chunks
 *   (hex), reject?, midError?, noBody? }`; each fetch logs `fetch` with the
 *   URL. extractRuntimeArchive unpacks the case's archive file; archives are
 *   built here (tar with pax, GNU long names, links; zip by JSZip).
 * - local-launch: the kit answers the case's resolution and logs `resolve`.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import JSZip from 'jszip'
import type { Case, FileSpec, FnSpec, Group, TsContext } from '../../types.ts'

import * as launch from '../../../../apps/shell/src/main/mcp-client/local-launch.ts'
import * as archive from '../../../../apps/shell/src/main/mcp-client/runtime-archive.ts'
import * as pins from '../../../../apps/shell/src/main/mcp-client/runtime-pins.ts'
import * as paste from '../../../../apps/shell/src/main/mcp-client/paste.ts'
import * as secrets from '../../../../apps/shell/src/main/mcp-client/secrets.ts'
import * as store from '../../../../apps/shell/src/main/mcp-client/store.ts'
import * as toml from '../../../../apps/shell/src/main/mcp-client/toml.ts'

const c = (args: unknown[], note?: string, files?: Record<string, FileSpec>): Case => ({
  args,
  ...(note ? { note } : {}),
  ...(files ? { files } : {}),
})

const constant = (value: unknown): FnSpec => ({
  ts: () => value,
  cases: [{ args: [] }],
  single: 'a constant',
})

const str = (a: unknown[], i: number): string => a[i] as string

// ---------------------------------------------------------------------------
// toml
// ---------------------------------------------------------------------------

const TOML_TEXTS: [string, string?][] = [
  ['', 'empty'],
  ['# only a comment\n   \n\t# another'],
  ['a = 1'],
  ['a = 1\nb = 2\nc = 3\n'],
  ['  a   =   1  # trailing comment'],
  ['a=1\r\nb=2\r\n', 'CRLF'],
  ['a=1\r\n\r\nb=2\r\n', 'CRLF with a blank line'],
  ['\uFEFFa = 1', 'a byte order mark'],
  ['a-b_c9 = 1'],
  ['"quoted key" = 1'],
  ["'literal key' = 1"],
  ['"" = 1', 'an empty quoted key'],
  ['a.b.c = 1', 'a dotted key'],
  ['a . b . c = 1', 'spaces around dots'],
  ['"a.b".c = 1', 'a quoted part with a dot'],
  ['a.b = 1\na.c = 2', 'dotted keys share a table'],
  ['a = 1\na = 2', 'a key set twice'],
  ['b = 1\na = 2\n2 = 3\n10 = 4\n1 = 5', 'integer keys come first, numerically'],
  ['__proto__ = 1\n[__proto__]\nx = 2', 'a __proto__ key is an ordinary member'],
  ['a.__proto__.b = 3'],
  // strings
  ['s = "plain"'],
  ['s = "tab\\tnew\\nline\\r\\f\\b\\e\\"quote\\\\"'],
  ['s = "\\u00e9\\u0041"'],
  ['s = "\\U0001F600"'],
  ['s = "\\u00E9"', 'upper-case hex'],
  ['s = "\\q"', 'a bad escape'],
  ['s = "\\u12"', 'a short unicode escape'],
  ['s = "\\u12G4"', 'a non-hex unicode escape'],
  ['s = "\\uD800"', 'a surrogate'],
  ['s = "\\U00110000"', 'past U+10FFFF'],
  ['s = "\\UD7FF0000"', 'past U+10FFFF, hex'],
  ['s = "\\u+123"', 'a sign in a unicode escape'],
  ['s = "unterminated'],
  ['s = "unterminated\nb = 1'],
  ['s = "ends in a backslash\\'],
  ['s = "back\\\nslash"', 'a backslash before a line break in a one-line string'],
  ['s = "caf\u00e9 \u{1F600} text"'],
  ["s = 'literal \\n no escape'"],
  ["s = 'unterminated"],
  ["s = 'broken\nline'"],
  ['s = """one"""'],
  ['s = """\nfirst newline trimmed\nsecond"""'],
  ['s = """\r\nCRLF trimmed"""'],
  ['s = """a\nb\r\nc"""'],
  ['s = """line one \\\n    line two"""', 'a line-ending backslash'],
  ['s = """line one \\   \n\n\n   line two"""', 'trailing space after the backslash, blank lines'],
  ['s = """one \\\r\n  two"""', 'a line-ending backslash with CRLF'],
  ['s = """esc \\t \\u00e9 \\\\"""'],
  ['s = """a""""', 'a quote before the closing three'],
  ['s = """a"""""', 'two quotes before the closing three'],
  ['s = """a""""""', 'three quotes: the closing wins'],
  ['s = """"""', 'empty'],
  ['s = """x \\q"""', 'a bad escape in a multi-line string'],
  ['s = """x \\'],
  ['s = """never closed'],
  ["s = '''raw\nlines \\n'''"],
  ["s = '''\nfirst newline trimmed'''"],
  ["s = '''a''''", 'a quote before the closing three'],
  ["s = '''a'''''", 'two quotes before the closing three'],
  ["s = ''''''"],
  ["s = '''never closed"],
  ['s = "a" "b"', 'two strings'],
  ['s = "x"y', 'text after a string'],
  // booleans and numbers
  ['t = true\nf = false'],
  ['t = trueish', 'true is read as a prefix'],
  ['t = tru'],
  ['n = 42\np = +17\nm = -5\nz = 0'],
  ['n = 1_000_000\nm = 1__0'],
  ['n = 007', 'leading zeros'],
  ['h = 0xDEADbeef\no = 0o755\nb = 0b1010\nn = -0x10\np = +0b11'],
  ['h = 0x_\nb = 0b_1_', 'underscores only in a radix number'],
  ['h = 0x'],
  ['f = 3.14\ng = -0.5\ne = 1e3\nE = 2.5E-2\nx = 6.02e+23'],
  ['f = 1_0.2_5'],
  ['f = 1e400', 'overflows to Infinity'],
  ['f = -1e400'],
  ['f = 0.0\ng = -0.0'],
  ['i = inf\nj = +inf\nk = -inf\nn = nan\no = +nan\np = -nan'],
  ['f = .5'],
  ['f = 5.'],
  ['f = 1.e3'],
  ['f = 1e'],
  ['f = 1 2'],
  ['f = abc'],
  ['f = 12abc'],
  ['f ='],
  ['f = # nothing'],
  ['= 1'],
  ['f 1'],
  ['f == 1'],
  ['f = 9007199254740993', 'beyond 2^53'],
  // dates
  ['d = 1979-05-27'],
  ['d = 1979-05-27T07:32:00Z'],
  ['d = 1979-05-27t07:32:00z'],
  ['d = 1979-05-27 07:32:00', 'a space between date and time'],
  ['d = 1979-05-27T00:32:00.999999-07:00'],
  ['d = 1979-05-27T07:32'],
  ['d = 07:32:00'],
  ['d = 07:32:00.5'],
  ['d = 1979-05-27T07:32:00+09:00 # tz'],
  ['d = 1979-5-27', 'not a date: read as a number, then text follows'],
  ['d = 12:30', 'not a time'],
  ['d = 1979-05-27 ', 'a date followed by space only'],
  // arrays
  ['a = []'],
  ['a = [1, 2, 3]'],
  ['a = [1, 2, 3,]', 'a trailing comma'],
  ['a = [\n  1, # one\n  2,\n\n  3\n]', 'comments and blank lines inside'],
  ['a = [[1, 2], [3, [4]]]'],
  ['a = [1, "two", true, 3.5, [], {}]', 'mixed'],
  ['a = [1 2]'],
  ['a = [,]'],
  ['a = [1,,2]'],
  ['a = [1, 2'],
  ['a = [1, 2\n'],
  ['a = ['],
  ['a = [ # c\n]'],
  ['a = ["x" "y"]'],
  ['a = [1\n2]'],
  // inline tables
  ['t = {}'],
  ['t = { a = 1, b = "two" }'],
  ['t = { a = 1, b = 2, }', 'a trailing comma'],
  ['t = { a.b = 1, a.c = 2 }', 'dotted keys inside'],
  ['t = { a = { b = { c = 1 } } }'],
  ['t = {\n  a = 1,\n  b = 2\n}', 'line breaks inside'],
  ['t = { a = 1 b = 2 }'],
  ['t = { a = 1'],
  ['t = { a }'],
  ['t = { a = 1, a = 2 }', 'a key set twice'],
  ['t = { a = [1, { b = 2 }] }'],
  ['t = { a = 1, a.b = 2 }', 'a value, then a dotted key under it'],
  // tables
  ['[a]\nx = 1'],
  ['[a.b]\nx = 1\n[a.c]\ny = 2'],
  ['[ a . b ]\nx = 1', 'spaces in a header'],
  ['["quoted key".x]\nv = 1'],
  ["['lit key']\nv = 1"],
  ['[a]\nx = 1\n[a]\ny = 2', 'a table defined twice is merged'],
  ['[a]\nx = 1\n[a]\nx = 2', 'and its key replaced'],
  ['[a.b]\nx = 1\n[a]\ny = 2', 'a parent after its child'],
  ['[a]\nb.c = 1\n[a.b]\nd = 2', 'a dotted key, then a header'],
  ['[a]\n[b]\n[c]'],
  ['[]'],
  ['[a'],
  ['[a]]'],
  ['[a] b = 1', 'text after a header'],
  ['[a] # comment\nx = 1'],
  ['a = 1\n[a]', 'a header over a value'],
  ['a = 1\n[a.b]'],
  ['[a]\nx = 1\n[a.x]', 'a header under a value'],
  ['a = [1]\n[a]', 'a header over an array of values'],
  ['a = [{ x = 1 }]\n[a.y]\nz = 2', 'a header under an array of inline tables'],
  ['a = [{ x = 1 }]\n[[a]]\ny = 2', 'an array of tables appended to a plain array'],
  ['a = [1]\n[[a]]\ny = 2', 'appended to an array of values'],
  ['a = 1\n[[a]]', 'an array of tables over a value'],
  ['[a]\nx = 1\n[[a]]\ny = 2', 'an array of tables over a table'],
  ['[[a]]\nx = 1\n[[a]]\nx = 2\n[[a]]'],
  [
    '[[a]]\nname = "one"\n[a.sub]\nv = 1\n[[a]]\nname = "two"\n[a.sub]\nv = 2',
    'sub-tables follow the last element',
  ],
  ['[[a.b]]\nx = 1\n[[a.b]]\nx = 2'],
  ['[a]\n[[a.b]]\nx = 1'],
  ['[[a]]\n[a.b.c]\nx = 1'],
  ['[[a]\nx = 1'],
  ['[[a]]]\nx = 1'],
  ['[[]]'],
  ['x.y = 1\nx.y.z = 2', 'a dotted key through a value'],
  ['x = 1\nx.y = 2'],
  ['x = [1]\nx.y = 2'],
  ['x = [{ a = 1 }]\nx.y = 2', 'a dotted key into an array of inline tables'],
  // lines in errors
  ['a = 1\nb = 2\nc = ?'],
  ['a = 1\r\nb = 2\r\nc = ?', 'CRLF line numbers'],
  ['a = """\nline\nline\n"""\nb = ?', 'a multi-line string before the error'],
  ['a = [\n1,\n2\n]\nb = ?'],
  ['a = [\n1,\n2\nb = 1', 'an unclosed array spanning lines'],
  ['a = 1 b = 2'],
  ['a = 1\n\n\n   \n[x\n'],
  ['a = "x\ny"'],
  ['a = """x\ny\n\\q"""'],
  ['# c\n\n\n[a]\nk = \n'],
  ['a = 1\u{1F600}'],
  ['\u{1F600} = 1'],
  ['a = "\u{1F600}"\nb = ?'],
  [
    'a = [' + '['.repeat(30000) + ']'.repeat(30000) + ']',
    'nested past the stack: a RangeError, not a TomlError',
  ],
  ['a = [' + '['.repeat(60) + ']'.repeat(60) + ']', 'nested, within the limit'],
  // what a paste holds
  [
    '[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\nstartup_timeout_sec = 20\n\n[mcp_servers.context7.env]\nAPI_KEY = "abc"\nDEBUG = true\n',
    'a Codex settings text',
  ],
  [
    'model = "gpt-5"\n[mcp_servers.docs]\nurl = "https://example.com/mcp"\nbearer_token_env_var = "DOCS_KEY"\nhttp_headers = { "X-A" = "1", B = 2 }\n',
    'a remote Codex server',
  ],
]

const tomlCases: Case[] = TOML_TEXTS.map(([text, note]) => c([text], note))

// ---------------------------------------------------------------------------
// paste
// ---------------------------------------------------------------------------

const json = (value: unknown): string => JSON.stringify(value, null, 2)
const fence = (body: string, lang = 'json'): string => `\`\`\`${lang}\n${body}\n\`\`\``

const localJson = {
  mcpServers: {
    fs: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { TOKEN: 'abc', COUNT: 3, ON: true, NOTHING: null, NESTED: { a: 1 } },
    },
  },
}

const PASTE_TEXTS: [string, string[]?, string?][] = [
  ['', [], 'empty'],
  ['   \n\t ', [], 'blank'],
  [fence(''), [], 'an empty fence'],
  [json(localJson), [], 'JSON with the wrapper'],
  [json(localJson.mcpServers), [], 'JSON without the wrapper'],
  [json({ ...localJson, extra: 1, other: { a: 1 } }), [], 'other top-level keys are ignored'],
  [fence(json(localJson)), [], 'a fenced block'],
  [
    `Add this to your settings:\n\n${fence(json(localJson))}\n\nThen restart.`,
    [],
    'prose around a fence',
  ],
  ['text\n```\n{"mcpServers":{"a":{"command":"x"}}}\n```', [], 'a fence without a language'],
  ['```json  \r\n{"a":{"command":"x"}}\r\n```', [], 'a fence with CRLF'],
  ['```\n{"a":{"command":"x"}}```', [], 'a fence closing on the code line'],
  ['```json{"a":{"command":"x"}}```', [], 'no line break after the opening fence'],
  [
    'first\n```json\nnot json\n```\nsecond\n```json\n{"a":{"command":"x"}}\n```',
    [],
    'the first fence only',
  ],
  ['{"a":{"command":"x"}}', [], 'one line'],
  ['\n\n  {"a":{"command":"x"}}  \n', [], 'blank lines around'],
  // JSON mistakes
  ['{"a": }', [], 'a missing value'],
  ['{"a":{"command":"x"},}', [], 'a trailing comma'],
  ['{\n  "a": {\n    "command": "x",\n  }\n}', [], 'a trailing comma on line 4'],
  ['{', [], 'an unexpected end'],
  ['{"a": tru}', [], 'a bad literal'],
  ["{'a': 1}", [], 'single quotes'],
  ['{"a": "unterminated}', [], 'an unterminated string'],
  ['{"a": 1}\nmore', [], 'text after the value'],
  [
    'Settings:\n\n{\n  "a": {\n    "command": "x",\n  }\n}',
    [],
    'prose before: the line counts from the paste',
  ],
  [`intro\n${fence('{\n  "a": 1,\n}')}`, [], 'a fenced mistake: the line counts from the paste'],
  ['{"a": {"command": "caf\u00e9", "b": \u{1F600}}}', [], 'a mistake after a non-BMP character'],
  ['{"a": 1e999999999999}', [], 'a number past the double range'],
  ['{"a": {"command": "x"}}', ['a'], 'the name is taken'],
  ['{"a": {"command": "x"}, "A": {"command": "y"}, "a2": 5}', [], 'two names that differ by case'],
  [
    '{"A": {"command": "x"}, "a": {"command": "y"}}',
    [],
    'an upper-case name first, then the same in lower case',
  ],
  ['{"mcpServers": {}}', [], 'no servers'],
  ['{"mcpServers": []}', [], 'mcpServers is no table: the wrapper is a bare name'],
  ['{"mcpServers": 1, "a": {"command": "x"}}', [], 'mcpServers is a number'],
  ['{}', [], 'an empty object'],
  ['{"a": 1, "b": "x", "c": null, "d": [1]}', [], 'no entry is a server'],
  ['{"a": 1, "b": {"command": "x"}}', [], 'a value that is no server is ignored'],
  ['{"mcpServers": {"a": 1, "b": {"command": "x"}}, "x": 1}', [], 'ignored entries and keys'],
  ['[1, 2]', [], 'an array: no TOML either'],
  ['"text"', [], 'a string'],
  ['{"a": {"command": "x"}} trailing', [], 'text after the object'],
  // local servers
  [
    '{"a": {"command": "  node  ", "args": ["x.js", 1, true, null, {"q": 1}, ["z"], 2.5]}}',
    [],
    'args are scalars as text',
  ],
  ['{"a": {"command": "node", "args": "x.js"}}', [], 'args that is no array'],
  [
    '{"a": {"command": "node", "env": {"K": "v", "N": 1, "B": false, "X": null}}}',
    [],
    'env values as text',
  ],
  [
    '{"a": {"command": "node", "env": {"A": "${TOKEN}", "B": "x ${ env : OTHER } y", "C": "${1BAD}", "D": "$TOKEN", "E": "${  }", "F": "${env:A}${env:B}"}}}',
    [],
    'placeholders in env',
  ],
  ['{"a": {"command": "node", "type": "stdio"}}', [], 'type stdio'],
  ['{"a": {"command": "node", "type": "http"}}', [], 'a remote type on a command'],
  ['{"a": {"command": "node", "type": 5}}', [], 'a type that is no text'],
  ['{"a": {"command": "node", "url": "https://x.example"}}', [], 'a command wins over a url'],
  [
    '{"a": {"command": "node", "headers": {"A": "1"}, "bearer_token_env_var": "KEY"}}',
    [],
    'remote fields on a local server',
  ],
  ['{"a": {"command": 5}}', [], 'a command that is no text: no target'],
  ['{"a": {"command": "   "}}', [], 'a blank command'],
  [
    '{"a": {"command": "npx", "args": ["-y", "pkg"], "cwd": "/x", "timeout": 5}}',
    [],
    'unknown fields are listed',
  ],
  // remote servers
  ['{"a": {"url": "https://example.com/mcp"}}', [], 'a plain remote'],
  ['{"a": {"serverUrl": "  https://example.com/sse  "}}', [], 'serverUrl'],
  ['{"a": {"url": 5, "serverUrl": "https://example.com/x"}}', [], 'url that is no text: serverUrl'],
  ['{"a": {"url": "https://example.com/x", "serverUrl": "https://other"}}', [], 'both'],
  ['{"a": {"url": "https://example.com/x", "type": "sse"}}', [], 'type sse'],
  ['{"a": {"url": "https://example.com/x", "type": "http"}}', [], 'type http'],
  [
    '{"a": {"url": "https://example.com/x", "type": "streamable-http"}}',
    [],
    'type streamable-http',
  ],
  ['{"a": {"url": "https://example.com/x", "type": "streamableHttp"}}', [], 'type streamableHttp'],
  [
    '{"a": {"url": "https://example.com/x", "type": "streamable_http"}}',
    [],
    'type streamable_http',
  ],
  ['{"a": {"url": "https://example.com/x", "type": "websocket"}}', [], 'an unknown type'],
  [
    '{"a": {"url": "https://example.com/x", "type": "constructor"}}',
    [],
    'a type that is a name of Object.prototype',
  ],
  ['{"a": {"url": "https://example.com/x", "type": "stdio"}}', [], 'stdio on a remote server'],
  [
    '{"a": {"url": "https://example.com/x", "env": {"A": "1"}, "args": ["x"]}}',
    [],
    'local fields on a remote server',
  ],
  ['{"a": {"type": "sse"}}', [], 'no target'],
  ['{"a": {"url": "   "}}', [], 'a blank url'],
  ['{"a": {}}', [], 'an empty server'],
  [
    '{"a": {"url": "https://x.example", "headers": {"A": "1", "B": 2, "C": true, "D": null, "E": {"x": 1}, "1": "first"}}}',
    [],
    'headers as text, an integer key first',
  ],
  [
    '{"a": {"url": "https://x.example", "http_headers": {"A": "1", "B": "2"}, "headers": {"B": "3", "C": "4"}}}',
    [],
    'http_headers then headers',
  ],
  [
    '{"a": {"url": "https://x.example", "headers": {"Authorization": "Bearer ${API_KEY}", "X-Other": "${env:OTHER}", "X-Plain": "p"}}}',
    [],
    'an Authorization placeholder is the key',
  ],
  [
    '{"a": {"url": "https://x.example", "headers": {"authorization": "${A}", "AUTHORIZATION": "${B}"}}}',
    [],
    'two Authorization spellings',
  ],
  [
    '{"a": {"url": "https://x.example", "headers": {"Authorization": "Bearer abc"}}}',
    [],
    'a literal Authorization stays',
  ],
  [
    '{"a": {"url": "https://x.example", "bearer_token_env_var": "MY_KEY", "headers": {"Authorization": "Bearer ${OTHER}"}}}',
    [],
    'the variable named wins',
  ],
  ['{"a": {"url": "https://x.example", "bearer_token_env_var": ""}}', [], 'an empty variable name'],
  [
    '{"a": {"url": "https://x.example", "bearer_token_env_var": 5}}',
    [],
    'a variable name that is no text',
  ],
  ['{"a": {"url": "https://x.example", "headers": "x"}}', [], 'headers that is no table'],
  // names
  [
    '{"\uc548\ub155": {"url": "https://dict.example.com/mcp"}}',
    [],
    'a Korean name: made from the host',
  ],
  [
    '{"\uc548\ub155": {"command": "npx", "args": ["-y", "@scope/pkg-name@1.2.3"]}}',
    [],
    'a Korean name: made from the package',
  ],
  [
    '{"\uc548\ub155": {"command": "node", "args": ["server.js"]}}',
    [],
    'a Korean name: made from the script',
  ],
  ['{"\uc548\ub155": {"type": "sse"}}', [], 'a Korean name and no target'],
  ['{"my server!": {"command": "x"}}', [], 'an invalid name'],
  [
    '{"averyveryverylongservernamethatexceedsthelimit": {"command": "x"}}',
    [],
    'a name that is too long',
  ],
  [
    '{"ok": {"command": "x"}, "OK": {"command": "y"}, "ok_": {"command": "z"}}',
    ['Ok2'],
    'taken, in other case',
  ],
  ['{"a": {"command": "x"}, "b": {"command": "y"}}', ['A', 'B'], 'both taken in upper case'],
  ['{"\u0130": {"command": "x"}}', [], 'a name with a case mapping'],
  [
    '{"__proto__": {"command": "x"}, "constructor": {"command": "y"}}',
    [],
    'names of Object.prototype',
  ],
  // TOML
  ['[mcp_servers.fs]\ncommand = "npx"\nargs = ["-y", "pkg"]\n', [], 'a Codex server'],
  [
    '[mcp_servers.fs]\ncommand = "npx"\n[mcp_servers.fs.env]\nTOKEN = "abc"\nN = 5\nB = true\nD = 1979-05-27\nP = "${HOME}"\n',
    [],
    'env as a table',
  ],
  [
    '[mcp_servers.web]\nurl = "https://example.com/mcp"\nbearer_token_env_var = "WEB_KEY"\nstartup_timeout_sec = 30\n',
    [],
    'a remote with a token variable',
  ],
  [
    '[mcp_servers.web]\nurl = "https://example.com/mcp"\nhttp_headers = { Authorization = "Bearer ${KEY}", "X-A" = "1" }\n',
    [],
    'http_headers',
  ],
  [
    '[mcp_servers.web]\nurl = "https://example.com/mcp"\n[mcp_servers.web.http_headers]\nX-B = "2"\n',
    [],
    'http_headers as a table',
  ],
  [
    '[mcp_servers.a]\ncommand = "x"\n[mcp_servers.b]\nurl = "https://y.example"\n[mcp_servers.c]\nenabled = true\n',
    [],
    'three servers',
  ],
  [
    'model = "gpt-5"\napproval = 1\n[mcp_servers.a]\ncommand = "x"\n[other]\nk = 1\n',
    [],
    'other tables are ignored',
  ],
  [
    `Put this in config.toml:\n\n${fence('[mcp_servers.a]\ncommand = "x"\n', 'toml')}\n`,
    [],
    'a fenced TOML block',
  ],
  [
    '[mcp_servers.a]\ncommand = "x"\n[mcp_servers.a]\nargs = ["y"]\n',
    [],
    'a redefined table is merged',
  ],
  ['[[mcp_servers.a]]\ncommand = "x"\n', [], 'an array of tables is no server table'],
  ['mcp_servers = 1\n', [], 'mcp_servers is a value'],
  ['[mcp_servers]\n', [], 'an empty mcp_servers'],
  ['[mcp_servers]\nfs = "text"\n', [], 'a value under mcp_servers'],
  ['[other]\nk = 1\n', [], 'a TOML text without mcp_servers'],
  ['k = 1\n', [], 'a root value only'],
  ['just some prose\nwith lines', [], 'prose: no TOML'],
  ['[mcp_servers.a\ncommand = "x"\n', [], 'a TOML mistake on line 1'],
  [
    '[mcp_servers.a]\ncommand = "x"\nargs = [\n  "a",\n  "b"\n\nurl = 1\n',
    [],
    'a TOML mistake: an unclosed array',
  ],
  [
    'Add this:\n\n[mcp_servers.a]\ncommand = "x"\nbad line here\n',
    [],
    'a TOML mistake, with prose before',
  ],
  [
    `Add this:\n${fence('[mcp_servers.a]\ncommand = "x"\n oops')}\n`,
    [],
    'a TOML mistake inside a fence',
  ],
  ['[ mcp_servers .a]\ncommand = ', [], 'a mistake: the header has spaces, not the pattern'],
  ['[other]\nk = \n', [], 'a mistake without mcp_servers: no line'],
  [
    'a = [' + '['.repeat(30000) + ']'.repeat(30000) + ']\n[mcp_servers.x]\ncommand = "y"\n',
    [],
    'a RangeError: no line',
  ],
  ['[mcp_servers."\uc548\ub155"]\ncommand = "node"\nargs = ["a.js"]\n', [], 'a quoted Korean key'],
  [
    '[mcp_servers.a]\ncommand = "x"\nargs = [inf, -inf, +inf, nan, -nan, 0x10, -0x10, 1e400, -1e400]\n',
    [],
    'non-finite and radix numbers read as text keep their sign',
  ],
  [
    '[mcp_servers.a]\ncommand = "x"\nargs = [1, 2.5, true, "s", [1], {a = 1}]\n',
    [],
    'args of several kinds',
  ],
]

const pasteCases: Case[] = PASTE_TEXTS.map(([text, taken, note]) => c([text, taken ?? []], note))

const placeholderCases: Case[] = [
  '${KEY}',
  '${env:KEY}',
  'Bearer ${KEY}',
  '${ KEY }',
  '${ env: KEY }',
  '${ env : KEY }',
  '${env:}',
  '${}',
  '$KEY',
  '${1KEY}',
  '${_k9}',
  'a ${A} b ${B}',
  '${KEY',
  '${KEY-X}',
  '',
  'plain',
  '${\tKEY\n}',
  '${\u00e9}',
].map((v) => c([v]))

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

interface CodecSpec {
  canSeal: boolean
  sealThrows?: boolean
  open?: 'decode' | 'null' | 'throw'
}

const codecOf = (s: CodecSpec): secrets.McpSecretCodec => ({
  canSeal: () => s.canSeal,
  seal: (plain) => {
    if (s.sealThrows || plain.includes('!throw')) throw new Error('seal failed')
    return `sealed:v1:${encodeURIComponent(plain)}`
  },
  open: (sealed) => {
    const mode = s.open ?? 'decode'
    if (mode === 'throw') throw new Error('open failed')
    if (mode === 'null' || sealed.includes('other-pc')) return null
    return decodeURIComponent(sealed.slice('sealed:v1:'.length))
  },
})

const CODECS = {
  seals: { canSeal: true },
  plain: { canSeal: false },
  sealThrows: { canSeal: true, sealThrows: true },
  openNull: { canSeal: true, open: 'null' },
  openThrows: { canSeal: true, open: 'throw' },
} satisfies Record<string, CodecSpec>

const sealed = (text: string): string => `sealed:v1:${encodeURIComponent(text)}`

/** a stored server as the cases write it; the rest of the fields are the defaults of the reader */
function remote(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'srv-remote',
    name: 'web',
    kind: 'remote',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer secret-token', 'X-Empty': '', 'X-Short': 'abc' },
    oauth: { clientId: 'cid', clientSecret: 'client-secret-1', tokens: '{"access_token":"t"}' },
    ...extra,
  }
}
function local(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'srv-local',
    name: 'files',
    kind: 'local',
    command: 'npx',
    args: ['-y', 'pkg'],
    env: { TOKEN: 'local-secret', EMPTY: '', 'caf\u00e9': 'caf\u00e9-secret-\u{1F600}' },
    ...extra,
  }
}

const normalizedServer = (stored: unknown): store.McpServerConfig =>
  store.normalizeMcpServersFile({ servers: [stored] }).servers[0] as store.McpServerConfig

const secretServers: [Record<string, unknown>, string][] = [
  [remote(), 'a remote server with OAuth'],
  [remote({ oauth: null }), 'a remote server without OAuth'],
  [
    remote({ headers: {}, oauth: { clientId: 'c', clientSecret: '', tokens: '' } }),
    'nothing secret',
  ],
  [
    remote({
      headers: { A: sealed('one'), B: 'plain', C: sealed('two-other-pc'), D: '', E: 'x!throw' },
      oauth: { clientId: 'c', clientSecret: sealed('cs'), tokens: 'plain-tokens' },
    }),
    'sealed and plain mixed',
  ],
  [local(), 'a local server'],
  [
    local({ env: { '2': 'two-value', '1': 'one-value', b: sealed('b'), a: 'a!throw' } }),
    'integer-like names',
  ],
  [
    local({ env: { B: 'sealed:v1:%E0%A4%A', A: sealed('ok') } }),
    'a malformed escape in a sealed value',
  ],
  [local({ env: { K: 'sealed:v1:' } }), 'an empty sealed value'],
  [local({ env: { K: 'sealed:v2:abc' } }), 'another prefix is plain'],
]

const codecNames = Object.keys(CODECS)

const secretCases = (extra: (s: Record<string, unknown>, k: string) => unknown[]): Case[] =>
  secretServers.flatMap(([server, note]) =>
    codecNames.map((k) =>
      c([server, CODECS[k as keyof typeof CODECS], ...extra(server, k)], `${note}, codec ${k}`),
    ),
  )

const storages = {
  win: { available: true },
  none: { available: false },
  encThrows: { available: true, encryptThrows: true },
  decThrows: { available: true, decryptThrows: true },
  gnome: { available: true, backend: 'gnome_libsecret' },
  basic: { available: true, backend: 'basic_text' },
}
const b64 = (text: string): string => Buffer.from(text).toString('base64')

const storageOf = (spec: Record<string, unknown>) => ({
  isEncryptionAvailable: () => spec.available === true,
  encryptString: (plain: string) => {
    if (spec.encryptThrows === true) throw new Error('encrypt failed')
    return Buffer.from(`enc:${plain}`)
  },
  decryptString: (buffer: Buffer) => {
    const text = buffer.toString('utf8')
    if (spec.decryptThrows === true || !text.startsWith('enc:')) throw new Error('decrypt failed')
    return text.slice(4)
  },
  ...('backend' in spec ? { getSelectedStorageBackend: () => spec.backend } : {}),
})

const codecStorageCases: Case[] = [
  [storages.win, 'win32', 'canSeal'],
  [storages.none, 'win32', 'canSeal'],
  [storages.win, 'darwin', 'canSeal'],
  [storages.gnome, 'linux', 'canSeal'],
  [storages.basic, 'linux', 'canSeal'],
  [storages.none, 'linux', 'canSeal'],
  [storages.win, 'win32', 'seal', 'sk-1'],
  [storages.win, 'win32', 'seal', '\u{1F600} \u00e9'],
  [storages.win, 'darwin', 'seal', 'sk-1'],
  [storages.none, 'win32', 'seal', 'sk-1'],
  [storages.encThrows, 'win32', 'seal', 'sk-1'],
  [storages.win, 'win32', 'open', `sealed:v1:${b64('enc:sk-1')}`],
  [storages.win, 'win32', 'open', `sealed:v1:${b64('enc:\u00e9\u{1F600}')}`],
  [storages.win, 'win32', 'open', `sealed:v1:${b64('other:sk-1')}`],
  [storages.decThrows, 'win32', 'open', `sealed:v1:${b64('enc:sk-1')}`],
  [storages.none, 'win32', 'open', `sealed:v1:${b64('enc:sk-1')}`],
  [storages.win, 'win32', 'open', 'plain'],
  [storages.win, 'win32', 'open', 'sealed:v1:'],
  [storages.win, 'win32', 'open', 'sealed:v1:!!!'],
].map((a) => c(a))

const secretViewCases: Case[] = [
  ['', false],
  ['', true],
  ['short', false],
  ['1234567', false],
  ['12345678', false],
  ['12345678', true],
  ['sk-abcdefghijkl', false],
  ['sk-abcdefghijkl', true],
  ['\u{1F600}\u{1F600}\u{1F600}\u{1F600}', false],
  ['abcde\u{1F600}\u{1F600}', false],
  ['\ud55c\uae00\ud55c\uae00\ud55c\uae00\ud55c\uae00\ud55c\uae00', false],
].map(([v, m]) => c([v, m]))

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const TMP = /\.[0-9a-f]{8,}\.tmp/g
const normalize = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value).replace(UUID, '<uuid>').replace(TMP, '.<hex>.tmp'))

interface Step {
  op: string
  [key: string]: unknown
}

function applyOps(draft: store.McpServersFile, ops: unknown[][]): void {
  for (const op of ops) {
    const [kind, ...rest] = op as [string, ...unknown[]]
    if (kind === 'add') {
      const server = store.newMcpServerConfig(rest[0] as store.NewMcpServerInput)
      if (typeof rest[1] === 'string') server.id = rest[1]
      draft.servers.push(server)
    } else if (kind === 'patch') {
      const server = draft.servers.find((s) => s.id === rest[0])
      if (server) Object.assign(server, rest[1])
    } else if (kind === 'runtime') {
      draft.runtimes[rest[0] as string] = { allowed: rest[1] as boolean }
    } else if (kind === 'drop') {
      draft.servers = draft.servers.filter((s) => s.id !== rest[0])
    }
  }
}

async function storeScenario(a: unknown[]): Promise<unknown> {
  const codec = codecOf(a[0] as CodecSpec)
  const file = a[2] as string
  const mcp = store.createMcpServersStore(file, codec)
  const out: unknown[] = []
  for (const step of a[1] as Step[]) {
    try {
      switch (step.op) {
        case 'load':
          out.push(await mcp.load())
          break
        case 'get':
          out.push(mcp.get())
          break
        case 'server':
          out.push(mcp.server(step.id as string))
          break
        case 'update':
          out.push(
            await mcp.update((draft) => {
              applyOps(draft, step.ops as unknown[][])
              if (step.ret === 'empty') return store.emptyMcpServersFile()
              return undefined
            }),
          )
          break
        case 'removeServer':
          out.push(await mcp.removeServer(step.id as string))
          break
        case 'sealing':
          out.push(mcp.sealing())
          break
        case 'view':
          out.push(mcp.view())
          break
        case 'read':
          out.push(existsSync(file) ? readFileSync(file, 'utf8') : null)
          break
        case 'write':
          writeFileSync(file, step.text as string)
          out.push(null)
          break
        case 'remove':
          rmSync(file, { force: true })
          out.push(null)
          break
      }
    } catch (error) {
      out.push({ error: (error as Error).message })
    }
  }
  return normalize(out)
}

/** a stored file with sealed and plain secrets */
const SEALED_FILE = JSON.stringify({
  version: 1,
  runtimes: { node: { allowed: true }, uv: { allowed: false }, python: 1, '1': { allowed: true } },
  servers: [
    remote({
      headers: { Authorization: sealed('Bearer sealed-token'), 'X-Hand': 'hand-written-value' },
      oauth: {
        clientId: 'cid',
        clientSecret: sealed('cs-secret-value'),
        tokens: sealed('{"a":1}'),
      },
      tools: {
        search: {
          permission: 'always',
          approved: 'sha256:abc',
          definition: {
            description: 'Search',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          },
          pending: { description: 'Search v2', inputSchema: {} },
        },
        '2': { permission: 'off' },
      },
      newTools: ['search', 'search', 'ghost', '2'],
      instructions: { approved: 'sha256:i', text: 'Be nice' },
      pendingInstructions: 'Be nicer',
    }),
    local({
      env: { TOKEN: sealed('other-pc-secret-other-pc'), PLAIN: 'p', GOOD: sealed('good') },
      approvedLaunch: 'sha256:launch',
      approvedPlan: 'sha256:plan',
    }),
  ],
})

const NEW_REMOTE = {
  name: 'docs',
  kind: 'remote',
  url: 'https://docs.example.com/mcp',
  headers: { Authorization: 'Bearer new-secret-value', 'X-Plain': 'p' },
  oauth: { clientId: 'cid', clientSecret: 'a-client-secret', tokens: '' },
}
const NEW_LOCAL = {
  name: 'fs',
  kind: 'local',
  command: 'npx',
  args: ['-y', 'server-fs'],
  env: { API_KEY: 'local-api-key-1', DEBUG: '1' },
}

const storeScenarios: [unknown[], string, Record<string, FileSpec>?][] = [
  [
    [
      CODECS.seals,
      [
        { op: 'load' },
        {
          op: 'update',
          ops: [
            ['add', NEW_REMOTE, 'r1'],
            ['add', NEW_LOCAL, 'l1'],
          ],
        },
        { op: 'read' },
        { op: 'get' },
        { op: 'view' },
        { op: 'sealing' },
      ],
    ],
    'a first save on a PC that seals',
  ],
  [
    [
      CODECS.plain,
      [
        { op: 'load' },
        {
          op: 'update',
          ops: [
            ['add', NEW_REMOTE, 'r1'],
            ['add', NEW_LOCAL, 'l1'],
          ],
        },
        { op: 'read' },
        { op: 'get' },
        { op: 'view' },
        { op: 'sealing' },
      ],
    ],
    'a first save on a PC that cannot seal: the secrets stay in memory',
  ],
  [
    [
      CODECS.seals,
      [
        { op: 'load' },
        { op: 'get' },
        { op: 'view' },
        { op: 'server', id: 'srv-remote' },
        { op: 'server', id: 'nope' },
      ],
    ],
    'a stored file: sealed values open, an unreadable one is listed',
    { 'mcp-servers.json': SEALED_FILE },
  ],
  [
    [CODECS.openNull, [{ op: 'load' }, { op: 'get' }]],
    'nothing opens here',
    { 'mcp-servers.json': SEALED_FILE },
  ],
  [
    [CODECS.openThrows, [{ op: 'load' }, { op: 'get' }]],
    'every open throws',
    { 'mcp-servers.json': SEALED_FILE },
  ],
  [
    [CODECS.plain, [{ op: 'load' }, { op: 'update', ops: [] }, { op: 'read' }, { op: 'view' }]],
    'a stored file saved again on a PC that cannot seal: the sealed values are kept',
    { 'mcp-servers.json': SEALED_FILE },
  ],
  [
    [
      CODECS.seals,
      [
        { op: 'load' },
        {
          op: 'update',
          ops: [
            [
              'patch',
              'srv-remote',
              { name: 'renamed', enabled: false, headers: { 'X-New': 'new-header-value' } },
            ],
            ['runtime', 'node', false],
            ['runtime', 'python', true],
          ],
        },
        { op: 'read' },
        { op: 'server', id: 'srv-remote' },
      ],
    ],
    'a patch keeps what it does not touch',
    { 'mcp-servers.json': SEALED_FILE },
  ],
  [
    [
      CODECS.seals,
      [
        { op: 'load' },
        { op: 'removeServer', id: 'srv-local' },
        { op: 'removeServer', id: 'srv-local' },
        { op: 'read' },
        { op: 'view' },
      ],
    ],
    'removing a server',
    { 'mcp-servers.json': SEALED_FILE },
  ],
  [
    [
      CODECS.seals,
      [{ op: 'load' }, { op: 'update', ops: [], ret: 'empty' }, { op: 'read' }, { op: 'get' }],
    ],
    'a change that answers another file',
    { 'mcp-servers.json': SEALED_FILE },
  ],
  [
    [
      CODECS.seals,
      [
        { op: 'load' },
        {
          op: 'update',
          ops: [
            ['drop', 'srv-remote'],
            ['drop', 'nope'],
          ],
        },
        { op: 'get' },
      ],
    ],
    'a drop',
    { 'mcp-servers.json': SEALED_FILE },
  ],
  [
    [
      CODECS.seals,
      [
        { op: 'load' },
        { op: 'update', ops: [['add', { name: 'x', kind: 'remote' }]] },
        { op: 'read' },
        { op: 'remove' },
      ],
    ],
    'a server with only a name and a kind (random id)',
  ],
  [
    [
      CODECS.seals,
      [
        { op: 'load' },
        {
          op: 'update',
          ops: [
            [
              'add',
              {
                name: 'x',
                kind: 'local',
                command: 'c',
                url: 'https://ignored',
                headers: { A: 'secret-value-a' },
                oauth: { clientId: 'c', clientSecret: 's', tokens: 't' },
                transport: 'sse',
              },
              'only-local',
            ],
          ],
        },
        { op: 'read' },
      ],
    ],
    'fields of the other kind are dropped',
  ],
  [
    [
      CODECS.seals,
      [
        { op: 'load' },
        {
          op: 'update',
          ops: [
            [
              'add',
              {
                name: 'x',
                kind: 'remote',
                url: 'https://r.example',
                transport: 'sse',
                command: 'c',
                args: ['a'],
                env: { K: 'v' },
              },
              'only-remote',
            ],
          ],
        },
        { op: 'read' },
      ],
    ],
    'local fields of a remote server are dropped',
  ],
  [
    [
      CODECS.seals,
      [
        {
          op: 'update',
          ops: [
            [
              'add',
              { ...NEW_REMOTE, headers: { A: 'plain-ok-value', B: 'bad!throw-value' } },
              'r1',
            ],
          ],
        },
        { op: 'read' },
        { op: 'view' },
      ],
    ],
    'a value the codec cannot seal is never written plain',
  ],
  [
    [
      CODECS.sealThrows,
      [{ op: 'update', ops: [['add', NEW_LOCAL, 'l1']] }, { op: 'read' }, { op: 'view' }],
    ],
    'every seal throws',
  ],
  [
    [
      CODECS.seals,
      [
        { op: 'write', text: '{ not json' },
        { op: 'load' },
        { op: 'get' },
        { op: 'update', ops: [['add', NEW_LOCAL, 'l1']] },
        { op: 'read' },
        { op: 'update', ops: [['patch', 'l1', { name: 'again' }]] },
        { op: 'load' },
        { op: 'get' },
      ],
    ],
    'a damaged file is kept beside once',
  ],
  [
    [CODECS.seals, [{ op: 'write', text: '' }, { op: 'load' }, { op: 'sealing' }]],
    'an empty file is damaged',
  ],
  [
    [CODECS.seals, [{ op: 'write', text: '\uFEFF{"servers": []}' }, { op: 'load' }]],
    'a byte order mark is damage',
  ],
  [
    [CODECS.seals, [{ op: 'write', text: 'null' }, { op: 'load' }, { op: 'get' }]],
    'JSON that is no object',
  ],
  [
    [CODECS.seals, [{ op: 'write', text: '[1,2]' }, { op: 'load' }, { op: 'get' }]],
    'an array file',
  ],
  [
    [
      CODECS.seals,
      [
        { op: 'write', text: JSON.stringify({ version: 9, runtimes: [], servers: 'x' }) },
        { op: 'load' },
        { op: 'get' },
      ],
    ],
    'wrong types',
  ],
  [
    [
      CODECS.seals,
      [
        {
          op: 'write',
          text: JSON.stringify({
            servers: [
              1,
              null,
              'x',
              [],
              {
                command: 'c',
                enabled: false,
                keepResultsInside: false,
                approvedLaunch: 'a',
                approvedPlan: 'p',
                transport: 'sse',
              },
              {
                url: 'https://u.example',
                transport: 'sse',
                enabled: 0,
                approvedLaunch: 'ignored for remote',
                approvedPlan: 'x',
              },
              { kind: 'weird', command: 5, id: '' },
              { id: 'dup', name: 'one' },
              { id: 'dup', name: 'two' },
              {
                id: 'perm',
                tools: {
                  a: { permission: 'always' },
                  b: { permission: 'bogus' },
                  c: 5,
                  d: null,
                  e: { definition: 5, pending: 7 },
                },
              },
              {
                id: 'strs',
                args: ['a', 1, 'b'],
                env: { A: 'x', B: 1 },
                headers: { H: 'v', I: false },
                newTools: 'x',
              },
              { id: 'ins', instructions: { text: 5 }, pendingInstructions: 5 },
              { id: 'ins2', instructions: { text: 'hello' } },
            ],
          }),
        },
        { op: 'load' },
        { op: 'get' },
      ],
    ],
    'the reader is tolerant of missing fields and wrong types',
  ],
  [
    [
      CODECS.seals,
      [{ op: 'load' }, { op: 'read' }, { op: 'sealing' }, { op: 'get' }, { op: 'view' }],
    ],
    'nothing stored',
  ],
  [
    [CODECS.seals, [{ op: 'remove' }, { op: 'removeServer', id: 'x' }, { op: 'read' }]],
    'removing from an empty store writes nothing',
  ],
  [
    [
      CODECS.seals,
      [
        {
          op: 'update',
          ops: [
            [
              'add',
              { ...NEW_REMOTE, headers: { '2': 'two-two-two', '1': 'one-one-one', b: 'bbbbbbbb' } },
              'r1',
            ],
          ],
        },
        { op: 'read' },
        { op: 'view' },
      ],
    ],
    'integer-like header names keep their order',
  ],
  [
    [
      CODECS.seals,
      [
        { op: 'update', ops: [['add', NEW_LOCAL, 'l1']] },
        { op: 'view' },
        { op: 'update', ops: [['patch', 'l1', { approvedLaunch: 'x', approvedPlan: null }]] },
        { op: 'view' },
      ],
    ],
    'launchReviewNeeded of a local server',
  ],
]

const storeCases: Case[] = storeScenarios.map(([args, note, files]) =>
  c(
    [args[0], args[1], `$DIR/${(args[2] as string | undefined) ?? 'mcp-servers.json'}`],
    note,
    files,
  ),
)

// a write that fails: the file sits in a folder that is not there
storeScenarios.push([
  [
    CODECS.seals,
    [
      { op: 'load' },
      { op: 'update', ops: [['add', NEW_LOCAL, 'l1']] },
      { op: 'get' },
      { op: 'read' },
    ],
    'missing/dir/mcp-servers.json',
  ],
  'a save that fails leaves the state as it was',
])
storeCases.push(
  ...storeScenarios
    .slice(-1)
    .map(([args, note, files]) => c([args[0], args[1], `$DIR/${args[2] as string}`], note, files)),
)

// ---------------------------------------------------------------------------
// runtime pins
// ---------------------------------------------------------------------------

const platformCases: Case[] = [
  ['win32', 'x64'],
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'x64'],
  ['linux', 'arm64'],
  ['win32', 'arm64'],
  ['freebsd', 'x64'],
  ['win32-x64', ''],
  ['', 'win32-x64'],
  ['Win32', 'x64'],
  ['', ''],
].map(([p, a]) => c([p, a]))

// ---------------------------------------------------------------------------
// runtime archive
// ---------------------------------------------------------------------------

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const bufOf = (...parts: string[]): Buffer => Buffer.concat(parts.map((p) => Buffer.from(p, 'hex')))

interface FetchSpec {
  status?: number
  chunks?: string[]
  reject?: string
  midError?: string
  noBody?: boolean
}

function fetchOf(spec: FetchSpec, log: (...args: unknown[]) => void): archive.RuntimeFetch {
  return async (url) => {
    log('fetch', url)
    if (spec.reject !== undefined) throw new Error(spec.reject)
    const chunks = (spec.chunks ?? []).map((h) => new Uint8Array(Buffer.from(h, 'hex')))
    let next = 0
    const body = spec.noBody
      ? null
      : new ReadableStream<Uint8Array>({
          pull(controller) {
            if (next < chunks.length) controller.enqueue(chunks[next++]!)
            else if (spec.midError !== undefined) controller.error(new Error(spec.midError))
            else controller.close()
          },
        })
    return new Response(body, { status: spec.status ?? 200 })
  }
}

const URL_PINNED = 'https://example.test/runtime.tar.gz'
const bodyHex = [Buffer.from('hello '), Buffer.from('pinned '), Buffer.from('world')].map((b) =>
  b.toString('hex'),
)
const whole = bufOf(...bodyHex)
const pinned = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  url: URL_PINNED,
  sha256: sha(whole),
  bytes: whole.length,
  format: 'tar.gz',
  root: '',
  ...overrides,
})

const downloadCases: Case[] = [
  c([pinned(), { chunks: bodyHex }, '$DIR/runtime.bin'], 'the exact bytes in three chunks'),
  c([pinned(), { chunks: [whole.toString('hex')] }, '$DIR/runtime.bin'], 'one chunk'),
  c(
    [pinned({ sha256: sha(whole).toUpperCase() }), { chunks: bodyHex }, '$DIR/runtime.bin'],
    'an upper-case pinned hash',
  ),
  c([pinned(), { chunks: ['', ...bodyHex, ''] }, '$DIR/runtime.bin'], 'empty chunks'),
  c(
    [pinned({ sha256: '0'.repeat(64) }), { chunks: bodyHex }, '$DIR/runtime.bin'],
    'the hash differs: the file is deleted',
  ),
  c(
    [pinned({ bytes: whole.length + 1 }), { chunks: bodyHex }, '$DIR/runtime.bin'],
    'fewer bytes than pinned',
  ),
  c(
    [pinned({ bytes: whole.length - 1 }), { chunks: bodyHex }, '$DIR/runtime.bin'],
    'more bytes than pinned: cut off',
  ),
  c(
    [pinned({ bytes: 3 }), { chunks: bodyHex }, '$DIR/runtime.bin'],
    'longer from the first chunk on',
  ),
  c(
    [pinned({ bytes: 0, sha256: sha(Buffer.alloc(0)) }), { chunks: [] }, '$DIR/runtime.bin'],
    'an empty archive pinned',
  ),
  c([pinned(), { chunks: [] }, '$DIR/runtime.bin'], 'an empty body'),
  c([pinned(), { status: 404, chunks: bodyHex }, '$DIR/runtime.bin'], 'HTTP 404'),
  c([pinned(), { status: 500, chunks: [] }, '$DIR/runtime.bin'], 'HTTP 500'),
  c([pinned(), { status: 200, noBody: true }, '$DIR/runtime.bin'], 'no body'),
  c(
    [pinned(), { reject: 'getaddrinfo ENOTFOUND example.test' }, '$DIR/runtime.bin'],
    'the fetch rejects',
  ),
  c(
    [pinned(), { chunks: bodyHex.slice(0, 2), midError: 'socket hang up' }, '$DIR/runtime.bin'],
    'the stream fails midway: the file is deleted',
  ),
  c([pinned(), { chunks: bodyHex }, '$DIR/runtime.bin'], 'the target is there already', {
    'runtime.bin': 'old',
  }),
  c([pinned(), { chunks: bodyHex }, '$DIR/missing/runtime.bin'], 'the target folder is not there'),
  c([pinned(), { chunks: bodyHex }, '$DIR'], 'the target is a folder'),
]

// ---- archives ----

const BLOCK = 512
const octal = (value: number, width: number): string =>
  `${value.toString(8).padStart(width - 1, '0')}\0`

interface TarEntry {
  name: string
  data?: string | Buffer
  type?: string
  mode?: number
  link?: string
  /** the size field as written, instead of the data's length */
  sizeField?: string
  /** a checksum that is wrong */
  badSum?: boolean
  /** the checksum field ends in two NUL bytes instead of NUL and a space */
  nulSum?: boolean
  /** no ustar magic */
  v7?: boolean
  prefix?: string
  /** the data is not padded to a block */
  unpadded?: boolean
}

function tarBlock(entry: TarEntry, typeChar: string, data: Buffer): Buffer {
  const header = Buffer.alloc(BLOCK)
  header.write(entry.name.slice(0, 100), 0, 'utf8')
  header.write(octal(entry.mode ?? 0o644, 8), 100, 'latin1')
  header.write(octal(0, 8), 108, 'latin1')
  header.write(octal(0, 8), 116, 'latin1')
  header.write(entry.sizeField ?? octal(data.length, 12), 124, 'latin1')
  header.write(octal(0, 12), 136, 'latin1')
  header.fill(0x20, 148, 156)
  header.write(typeChar, 156, 'latin1')
  if (entry.link) header.write(entry.link.slice(0, 100), 157, 'utf8')
  if (!entry.v7) {
    header.write('ustar\0', 257, 'latin1')
    header.write('00', 263, 'latin1')
  }
  if (entry.prefix) header.write(entry.prefix, 345, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  const written = entry.nulSum
    ? `${sum.toString(8).padStart(6, '0')}\0\0`
    : `${sum.toString(8).padStart(6, '0')}\0 `
  header.write(entry.badSum ? '0000000\0' : written, 148, 'latin1')
  return header
}

const padded = (data: Buffer): Buffer => {
  const rest = data.length % BLOCK
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rest)])
}

/** pax records as `<length> <key>=<value>\n`, the length counting its own digits */
function paxBody(records: Record<string, string>): Buffer {
  const parts = Object.entries(records).map(([key, value]) => {
    const body = ` ${key}=${value}\n`
    const bytes = Buffer.byteLength(body)
    let length = bytes + 1
    while (String(length).length + bytes !== length) length = String(length).length + bytes
    return `${length}${body}`
  })
  return Buffer.from(parts.join(''))
}

function tarBytes(
  entries: TarEntry[],
  opts: { endMark?: boolean; trailing?: Buffer } = {},
): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data =
      typeof entry.data === 'string' ? Buffer.from(entry.data) : (entry.data ?? Buffer.alloc(0))
    const typeChar = entry.type ?? (entry.name.endsWith('/') ? '5' : '0')
    blocks.push(tarBlock(entry, typeChar, data))
    if (data.length > 0) blocks.push(entry.unpadded ? data : padded(data))
  }
  if (opts.endMark !== false) blocks.push(Buffer.alloc(BLOCK * 2))
  if (opts.trailing) blocks.push(opts.trailing)
  return Buffer.concat(blocks)
}

const pax = (records: Record<string, string>): TarEntry => ({
  name: 'PaxHeader',
  type: 'x',
  data: paxBody(records),
})
const gnuLong = (type: 'L' | 'K', value: string): TarEntry => ({
  name: '././@LongLink',
  type,
  data: Buffer.concat([Buffer.from(value), Buffer.alloc(1)]),
})

const gz = (tar: Buffer): string => gzipSync(tar).toString('hex')
const R = 'node-v1'

const tarArchives: [string, TarEntry[], { endMark?: boolean }?][] = [
  [
    'files, folders and modes',
    [
      { name: `${R}/`, type: '5' },
      { name: `${R}/bin/`, type: '5' },
      { name: `${R}/bin/node`, data: 'NODE', mode: 0o755 },
      { name: `${R}/README.md`, data: 'readme', mode: 0o644 },
      { name: `${R}/lib/deep/er/file.txt`, data: 'deep', mode: 0o600 },
      { name: `${R}/empty.txt`, data: '' },
    ],
  ],
  [
    'modes: setuid kept off, read-only raised, zero is 644',
    [
      { name: `${R}/a`, data: 'a', mode: 0o4755 },
      { name: `${R}/b`, data: 'b', mode: 0o444 },
      { name: `${R}/c`, data: 'c', mode: 0 },
      { name: `${R}/d`, data: 'd', mode: 0o7777 },
      { name: `${R}/e`, data: 'e', mode: 0o100 },
    ],
  ],
  [
    'entries outside the top folder and the folder itself are skipped',
    [
      { name: `${R}/`, type: '5' },
      { name: 'other/file.txt', data: 'skipped' },
      { name: `${R}x/file.txt`, data: 'skipped too' },
      { name: 'top.txt', data: 'skipped' },
      { name: `${R}/kept.txt`, data: 'kept' },
    ],
  ],
  [
    'dot segments and double slashes',
    [
      { name: `./${R}/./a//b.txt`, data: 'one' },
      { name: `${R}//c.txt`, data: 'two' },
    ],
  ],
  ['backslashes in a name', [{ name: `${R}\\win\\file.txt`, data: 'win' }]],
  [
    'a link name and a plain name of other types are skipped',
    [
      { name: `${R}/fifo`, type: '6' },
      { name: `${R}/chr`, type: '3' },
      { name: `${R}/blk`, type: '4' },
      { name: `${R}/ext`, type: 'A', data: 'some data' },
      { name: `${R}/kept`, data: 'kept' },
    ],
  ],
  ['type 7 is a file', [{ name: `${R}/contig`, type: '7', data: 'contiguous' }]],
  [
    'a file of several blocks',
    [{ name: `${R}/big.bin`, data: Buffer.from('0123456789abcdef'.repeat(200)) }],
  ],
  ['a pax path', [pax({ path: `${R}/pax/long-name.txt` }), { name: 'short', data: 'via pax' }]],
  [
    'a pax path with a non-ASCII name and other records',
    [
      pax({ path: `${R}/\uc548\ub155/\u{1F600}.txt`, mtime: '1700000000.5', comment: 'x' }),
      { name: 'short', data: 'unicode' },
    ],
  ],
  [
    'a pax path of the empty string',
    [pax({ path: '' }), { name: `${R}/ignored.txt`, data: 'ignored' }],
  ],
  [
    'a pax header with a bad length ends the records',
    [
      { name: 'PaxHeader', type: 'x', data: 'zz path=x\n' },
      { name: `${R}/after.txt`, data: 'after' },
    ],
  ],
  [
    'a pax record without an equals sign',
    [
      { name: 'PaxHeader', type: 'x', data: '8 nopair\n' },
      { name: `${R}/plain.txt`, data: 'plain' },
    ],
  ],
  [
    'a global pax header is ignored',
    [
      { name: 'GlobalHeader', type: 'g', data: paxBody({ path: 'ignored/x' }) },
      { name: `${R}/g.txt`, data: 'g' },
    ],
  ],
  [
    'a global pax header inside the top folder is ignored, not unpacked',
    [
      { name: `${R}/GlobalHeader`, type: 'g', data: paxBody({ comment: 'x' }) },
      { name: `${R}/g2.txt`, data: 'g2' },
    ],
  ],
  [
    'a pax header applies to the next entry only',
    [
      pax({ path: `${R}/first.txt` }),
      { name: 'x', data: '1' },
      { name: `${R}/second.txt`, data: '2' },
    ],
  ],
  [
    'a GNU long name',
    [
      gnuLong('L', `${R}/${'long-directory-name/'.repeat(8)}file.txt`),
      { name: 'trunc', data: 'gnu long' },
    ],
  ],
  [
    'a GNU long name applies to the next entry only',
    [
      gnuLong('L', `${R}/long.txt`),
      { name: 'x', data: '1' },
      { name: `${R}/short.txt`, data: '2' },
    ],
  ],
  [
    'a pax path wins over a GNU long name',
    [gnuLong('L', `${R}/gnu.txt`), pax({ path: `${R}/pax.txt` }), { name: 'x', data: 'both' }],
  ],
  ['a ustar prefix', [{ name: 'file.txt', prefix: `${R}/some/dir`, data: 'prefixed' }]],
  [
    'no ustar magic: the prefix field is not read',
    [{ name: `${R}/plain.txt`, prefix: 'ignored/prefix', data: 'v7', v7: true }],
  ],
  [
    'a GNU long name that is the empty string',
    [gnuLong('L', ''), { name: `${R}/ignored.txt`, data: 'x' }],
  ],
  [
    'a base-256 size',
    [{ name: `${R}/b256.txt`, data: 'base256 size', sizeField: '\x80\0\0\0\0\0\0\0\0\0\0\x0c' }],
  ],
  ['a size field that is blank', [{ name: `${R}/blank.txt`, sizeField: ' '.repeat(12) }]],
  [
    'a size field that is no number',
    [
      { name: `${R}/nan.txt`, sizeField: 'zzzzzzzzzzz\0' },
      { name: `${R}/next.txt`, data: 'next' },
    ],
  ],
  [
    'a size field with a space and a sign',
    [{ name: `${R}/sp.txt`, data: 'abc', sizeField: '    3\0      ' }],
  ],
  [
    'a negative size skips five bytes',
    [{ name: `${R}/neg.txt`, sizeField: '-5\0' + '\0'.repeat(9) }],
  ],
  [
    'a symbolic link inside',
    [
      { name: `${R}/bin/real`, data: 'REAL', mode: 0o755 },
      { name: `${R}/bin/alias`, type: '2', link: 'real' },
      { name: `${R}/up`, type: '2', link: 'bin/real' },
      { name: `${R}/bin/up2`, type: '2', link: '../bin/real' },
    ],
  ],
  [
    'a symbolic link that leaves the folder is left out',
    [
      { name: `${R}/a/escape`, type: '2', link: '../../../outside' },
      { name: `${R}/b/abs`, type: '2', link: '/etc/passwd' },
      { name: `${R}/ok`, data: 'ok' },
    ],
  ],
  [
    'a symbolic link with no target is left out',
    [
      { name: `${R}/empty-link`, type: '2' },
      { name: `${R}/ok`, data: 'ok' },
    ],
  ],
  [
    'a symbolic link replaces a file',
    [
      { name: `${R}/real`, data: 'REAL' },
      { name: `${R}/link`, data: 'old file' },
      { name: `${R}/link`, type: '2', link: 'real' },
    ],
  ],
  [
    'a symbolic link twice',
    [
      { name: `${R}/real`, data: 'REAL' },
      { name: `${R}/other`, data: 'OTHER' },
      { name: `${R}/link`, type: '2', link: 'real' },
      { name: `${R}/link`, type: '2', link: 'other' },
    ],
  ],
  [
    'a symbolic link with a pax linkpath',
    [
      { name: `${R}/real`, data: 'REAL' },
      pax({ linkpath: 'real' }),
      { name: `${R}/viapax`, type: '2', link: 'ignored' },
    ],
  ],
  [
    'a symbolic link with a GNU long link',
    [
      { name: `${R}/real`, data: 'REAL' },
      gnuLong('K', 'real'),
      { name: `${R}/viagnu`, type: '2', link: 'ignored' },
    ],
  ],
  [
    'a hard link',
    [
      { name: `${R}/real`, data: 'REAL', mode: 0o755 },
      { name: `${R}/hard`, type: '1', link: `${R}/real` },
      { name: `${R}/sub/hard2`, type: '1', link: `${R}/real` },
    ],
  ],
  [
    'a hard link to a file that is not there is left out',
    [
      { name: `${R}/hard`, type: '1', link: `${R}/missing` },
      { name: `${R}/ok`, data: 'ok' },
    ],
  ],
  [
    'a hard link to a folder is left out',
    [
      { name: `${R}/dir/`, type: '5' },
      { name: `${R}/hard`, type: '1', link: `${R}/dir` },
    ],
  ],
  [
    'a hard link whose target is outside the top folder is left out',
    [
      { name: `${R}/hard`, type: '1', link: 'other/file' },
      { name: `${R}/ok`, data: 'ok' },
    ],
  ],
  ['a hard link that is absolute', [{ name: `${R}/hard`, type: '1', link: '/etc/passwd' }]],
  ['a hard link that leaves the archive', [{ name: `${R}/hard`, type: '1', link: `${R}/../x` }]],
  [
    'an absolute entry name',
    [
      { name: `${R}/ok.txt`, data: 'written first' },
      { name: '/etc/evil', data: 'x' },
    ],
  ],
  ['a drive letter entry name', [{ name: 'C:/evil', data: 'x' }]],
  ['a drive letter entry name with a backslash', [{ name: 'c:\\evil', data: 'x' }]],
  [
    'an entry that leaves the archive',
    [
      { name: `${R}/ok.txt`, data: 'written first' },
      { name: `${R}/../evil`, data: 'x' },
    ],
  ],
  ['an entry that leaves the archive, by a backslash', [{ name: `${R}\\..\\evil`, data: 'x' }]],
  [
    'an escaping entry name outside the top folder is refused too',
    [{ name: '../evil', data: 'x' }],
  ],
  [
    'a bad checksum',
    [
      { name: `${R}/first.txt`, data: 'first' },
      { name: `${R}/bad.txt`, data: 'bad', badSum: true },
    ],
  ],
  [
    'a checksum field ending in two NUL bytes',
    [
      { name: `${R}/nul.txt`, data: 'nul', nulSum: true },
      { name: `${R}/after.txt`, data: 'after' },
    ],
  ],
  ['no end mark', [{ name: `${R}/a.txt`, data: 'a' }], { endMark: false }],
  ['only the end mark', []],
  [
    'a file whose data is cut short',
    [{ name: `${R}/cut.txt`, data: 'short', sizeField: octal(5000, 12) }],
    { endMark: false },
  ],
  [
    'data that is not padded to a block, then the end',
    [{ name: `${R}/np.txt`, data: 'abc', unpadded: true }],
    { endMark: false },
  ],
  [
    'a pax header whose data is cut short',
    [{ name: 'PaxHeader', type: 'x', data: 'x', sizeField: octal(9999, 12) }],
    { endMark: false },
  ],
  [
    'a skipped entry whose data is cut short',
    [{ name: 'other/x', data: 'x', sizeField: octal(9999, 12) }],
    { endMark: false },
  ],
  [
    'a file over a folder',
    [
      { name: `${R}/dir/`, type: '5' },
      { name: `${R}/dir`, data: 'file over folder' },
    ],
  ],
  [
    'a folder over a file',
    [
      { name: `${R}/x`, data: 'file' },
      { name: `${R}/x/`, type: '5' },
    ],
  ],
  [
    'a file under a file',
    [
      { name: `${R}/x`, data: 'file' },
      { name: `${R}/x/y`, data: 'under a file' },
    ],
  ],
  [
    'a file written twice',
    [
      { name: `${R}/x`, data: 'first, longer text' },
      { name: `${R}/x`, data: 'second' },
    ],
  ],
  [
    'a file written twice with another mode',
    [
      { name: `${R}/x`, data: 'one', mode: 0o755 },
      { name: `${R}/x`, data: 'two', mode: 0o600 },
    ],
  ],
]

/** a zip as JSZip writes it, with Unix permissions */
async function zipHex(
  entries: { name: string; data?: string; dir?: boolean; perms?: number }[],
  platform: 'UNIX' | 'DOS' = 'UNIX',
): Promise<string> {
  const zip = new JSZip()
  for (const e of entries) {
    if (e.dir)
      zip.file(e.name, '', {
        dir: true,
        ...(e.perms !== undefined ? { unixPermissions: e.perms } : {}),
      })
    else
      zip.file(
        e.name,
        e.data ?? '',
        e.perms !== undefined
          ? { unixPermissions: e.perms, createFolders: false }
          : { createFolders: false },
      )
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer', platform, compression: 'DEFLATE' })
  return bytes.toString('hex')
}

const extractCases: Case[] = []
const archiveFile = (hex: string): Record<string, FileSpec> => ({ 'archive.bin': { hex } })

for (const [note, entries, opts] of tarArchives) {
  extractCases.push(
    c(
      ['$DIR/archive.bin', 'tar.gz', R, '$DIR/out'],
      note,
      archiveFile(gz(tarBytes(entries, opts))),
    ),
  )
}
extractCases.push(
  c(
    ['$DIR/archive.bin', 'tar.gz', R, '$DIR/out'],
    'a symbolic link into a sibling folder whose name starts like the destination',
    {
      ...archiveFile(
        gz(
          tarBytes([
            { name: `${R}/a/sibling`, type: '2', link: '../../out-sibling/f' },
            { name: `${R}/a/inside`, type: '2', link: '../b' },
            { name: `${R}/b`, data: 'b' },
          ]),
        ),
      ),
      'out-sibling/f': 'sibling file',
    },
  ),
)
extractCases.push(
  c(
    ['$DIR/archive.bin', 'tar.gz', '', '$DIR/out'],
    'a tar without a top folder',
    archiveFile(
      gz(
        tarBytes([
          { name: 'a/b.txt', data: 'ab' },
          { name: 'c.txt', data: 'c' },
        ]),
      ),
    ),
  ),
  c(
    ['$DIR/archive.bin', 'tar.gz', R, '$DIR/out'],
    'the destination is there already, with a file in it',
    {
      ...archiveFile(gz(tarBytes([{ name: `${R}/new.txt`, data: 'new' }]))),
      'out/old.txt': 'old',
    },
  ),
  c(['$DIR/archive.bin', 'tar.gz', R, '$DIR/out'], 'the destination is a file', {
    ...archiveFile(gz(tarBytes([{ name: `${R}/new.txt`, data: 'new' }]))),
    out: 'a file',
  }),
  c(
    ['$DIR/archive.bin', 'tar.gz', R, '$DIR/out'],
    'not gzip',
    archiveFile(Buffer.from('this is not a gzip file at all').toString('hex')),
  ),
  c(
    ['$DIR/archive.bin', 'tar.gz', R, '$DIR/out'],
    'gzip of text that is no tar',
    archiveFile(gz(Buffer.from('just some text, shorter than a block'))),
  ),
  c(
    ['$DIR/archive.bin', 'tar.gz', R, '$DIR/out'],
    'gzip of a block of text',
    archiveFile(gz(Buffer.alloc(512, 0x41))),
  ),
  c(
    ['$DIR/archive.bin', 'tar.gz', R, '$DIR/out'],
    'a gzip stream cut off in the middle',
    archiveFile(
      (() => {
        const full = gzipSync(
          tarBytes([
            { name: `${R}/a.txt`, data: 'a'.repeat(300) },
            {
              name: `${R}/big.bin`,
              data: Buffer.from(Array.from({ length: 6000 }, (_, i) => (i * 7919) % 251)),
            },
          ]),
        )
        return full.subarray(0, Math.floor(full.length / 2)).toString('hex')
      })(),
    ),
  ),
)

const zipArchives: [string, Parameters<typeof zipHex>[0], string?][] = [
  [
    'files, folders and permissions',
    [
      { name: `${R}/`, dir: true },
      { name: `${R}/bin/`, dir: true, perms: 0o755 },
      { name: `${R}/bin/node.exe`, data: 'EXE', perms: 0o755 },
      { name: `${R}/readme.txt`, data: 'readme', perms: 0o644 },
      { name: `${R}/deep/er/x.txt`, data: 'deep' },
      { name: `${R}/empty.txt`, data: '' },
    ],
  ],
  [
    'permissions: setuid dropped, read-only raised',
    [
      { name: `${R}/a`, data: 'a', perms: 0o4755 },
      { name: `${R}/b`, data: 'b', perms: 0o444 },
      { name: `${R}/c`, data: 'c', perms: 0o7777 },
    ],
  ],
  [
    'entries outside the top folder are skipped',
    [
      { name: 'other/x.txt', data: 'skipped' },
      { name: 'top.txt', data: 'skipped' },
      { name: `${R}/kept.txt`, data: 'kept' },
    ],
  ],
  ['backslashes in a name', [{ name: `${R}\\bin\\x.exe`, data: 'win' }]],
  [
    'an absolute name',
    [
      { name: `${R}/ok.txt`, data: 'first' },
      { name: '/etc/evil', data: 'x' },
    ],
  ],
  ['a drive letter name', [{ name: 'C:/evil', data: 'x' }]],
  [
    'a folder entry only',
    [
      { name: `${R}/`, dir: true },
      { name: `${R}/sub/`, dir: true },
    ],
  ],
]
for (const [note, entries] of zipArchives) {
  extractCases.push(
    c(
      ['$DIR/archive.bin', 'zip', R, '$DIR/out'],
      `zip: ${note}`,
      archiveFile(await zipHex(entries)),
    ),
  )
}
extractCases.push(
  c(
    ['$DIR/archive.bin', 'zip', '', '$DIR/out'],
    'zip: no top folder, written by DOS (no permissions)',
    archiveFile(
      await zipHex(
        [
          { name: 'uv.exe', data: 'UV' },
          { name: 'sub/x', data: 'x' },
        ],
        'DOS',
      ),
    ),
  ),
  c(
    ['$DIR/archive.bin', 'zip', R, '$DIR/out'],
    'zip: not a zip',
    archiveFile(Buffer.from('not a zip').toString('hex')),
  ),
  c(['$DIR/archive.bin', 'zip', R, '$DIR/out'], 'zip: an empty file', archiveFile('')),
  c(['$DIR/missing.bin', 'zip', R, '$DIR/out'], 'zip: the archive is not there'),
  c(
    ['$DIR/archive.bin', 'zip', R, '$DIR/out'],
    'zip: a file over a folder',
    archiveFile(
      await zipHex([
        { name: `${R}/d/`, dir: true },
        { name: `${R}/d`, data: 'file' },
      ]),
    ),
  ),
)

// ---------------------------------------------------------------------------
// local launch
// ---------------------------------------------------------------------------

const resolved = (
  command: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ok: true,
  command,
  prefixArgs: [],
  env: {},
  pathPrepend: [],
  source: 'pc',
  runtime: null,
  ...extra,
})
const missing = (detail: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ok: false,
  reason: 'runtime-missing',
  detail,
  runtime: null,
  downloads: [],
  message: `no ${detail}`,
  ...extra,
})

const POSIX_BASE = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/u',
  LANG: 'C',
  http_proxy: 'http://p',
  SEUOFFICE_SECRET: 's',
  OPENAI_API_KEY: 'k',
  USERNAME: 'posix-user',
}
const WIN_BASE = {
  Path: 'C:\\Windows\\System32',
  SystemRoot: 'C:\\Windows',
  Temp: 'C:\\Temp',
  USERPROFILE: 'C:\\Users\\u',
  appdata: 'C:\\Users\\u\\AppData',
  HOMEDRIVE: 'C:',
  USERNAME: 'u',
  windir: 'C:\\Windows',
  SEUOFFICE_X: 'x',
}

const srv = (command: string, args: string[] = [], env: Record<string, string> = {}) => ({
  command,
  args,
  env,
})
const lc = (
  server: unknown,
  kit: unknown,
  options: Record<string, unknown> = {},
  note?: string,
): Case => c([server, kit, options], note)

const launchCases: Case[] = [
  lc(
    srv('/usr/bin/tool', ['--a', 'b'], { MY: 'v' }),
    resolved('/usr/bin/tool'),
    { platform: 'linux', baseEnv: POSIX_BASE },
    'a posix program',
  ),
  lc(
    srv('  tool  '),
    resolved('/usr/bin/tool'),
    { platform: 'linux', baseEnv: POSIX_BASE },
    'a command with spaces around',
  ),
  lc(srv(''), resolved('/x'), { platform: 'linux', baseEnv: {} }, 'no command'),
  lc(srv(' \t\n'), resolved('/x'), { platform: 'linux', baseEnv: {} }, 'a blank command'),
  lc(
    srv('tool'),
    missing('not-found', {
      runtime: 'node',
      downloads: [{ runtime: 'node', version: '26.13.0', bytes: 58334661 }],
    }),
    { platform: 'linux', baseEnv: {} },
    'the runtime is missing',
  ),
  lc(
    srv('tool'),
    missing('download-needed', { runtime: 'uv', message: 'a download is needed' }),
    { platform: 'darwin', baseEnv: {}, offerDownload: true },
    'a download is offered',
  ),
  lc(srv('tool'), missing('declined'), { platform: 'win32', baseEnv: {} }, 'declined'),
  lc(srv('tool'), resolved('relative/tool'), { platform: 'linux', baseEnv: {} }, 'a relative path'),
  lc(srv('tool'), resolved('tool'), { platform: 'linux', baseEnv: {} }, 'a bare name'),
  lc(
    srv('tool'),
    resolved('C:\\tools\\tool.exe'),
    { platform: 'linux', baseEnv: {} },
    'a Windows path is not absolute on posix',
  ),
  lc(
    srv('tool'),
    resolved('/bin/tool.cmd'),
    { platform: 'linux', baseEnv: {} },
    '.cmd on posix is fine',
  ),
  // windows
  lc(
    srv('tool'),
    resolved('C:\\tools\\tool.exe'),
    { platform: 'win32', baseEnv: WIN_BASE },
    'a Windows program',
  ),
  lc(
    srv('tool'),
    resolved('C:\\tools\\TOOL.EXE'),
    { platform: 'win32', baseEnv: WIN_BASE },
    'upper-case extension',
  ),
  lc(srv('tool'), resolved('C:\\tools\\tool.com'), { platform: 'win32', baseEnv: {} }, '.com'),
  lc(
    srv('tool'),
    resolved('C:\\tools\\tool.cmd'),
    { platform: 'win32', baseEnv: {} },
    '.cmd needs a command window',
  ),
  lc(srv('tool'), resolved('C:\\tools\\tool.BAT'), { platform: 'win32', baseEnv: {} }, '.bat'),
  lc(
    srv('tool'),
    resolved('C:\\tools\\tool.cmd. '),
    { platform: 'win32', baseEnv: {} },
    'trailing dots and spaces hide .cmd',
  ),
  lc(
    srv('tool'),
    resolved('C:\\tools\\tool.exe...'),
    { platform: 'win32', baseEnv: {} },
    'trailing dots after .exe',
  ),
  lc(srv('tool'), resolved('C:\\tools\\tool.ps1'), { platform: 'win32', baseEnv: {} }, 'a script'),
  lc(srv('tool'), resolved('C:\\tools\\tool'), { platform: 'win32', baseEnv: {} }, 'no extension'),
  lc(
    srv('tool'),
    resolved('\\\\server\\share\\tool.exe'),
    { platform: 'win32', baseEnv: {} },
    'a UNC path',
  ),
  lc(
    srv('tool'),
    resolved('/usr/bin/tool.exe'),
    { platform: 'win32', baseEnv: {} },
    'a rooted path without a drive',
  ),
  lc(
    srv('tool'),
    resolved('tool.exe'),
    { platform: 'win32', baseEnv: {} },
    'a bare name on Windows',
  ),
  lc(
    srv('tool'),
    resolved('C:tool.exe'),
    { platform: 'win32', baseEnv: {} },
    'a drive-relative path',
  ),
  // npx
  lc(
    srv('npx', ['-y', 'pkg']),
    resolved('/usr/bin/npx'),
    { platform: 'linux', baseEnv: {} },
    'npx with -y',
  ),
  lc(
    srv('npx', ['pkg', '--flag']),
    resolved('/usr/bin/npx'),
    { platform: 'linux', baseEnv: {} },
    'npx without a yes: --yes is added',
  ),
  lc(
    srv('npx', []),
    resolved('/usr/bin/npx'),
    { platform: 'linux', baseEnv: {} },
    'npx without arguments',
  ),
  lc(
    srv('npx', ['--yes', 'pkg']),
    resolved('/usr/bin/npx'),
    { platform: 'linux', baseEnv: {} },
    'npx with --yes',
  ),
  lc(
    srv('npx', ['--yes=true', 'pkg']),
    resolved('/usr/bin/npx'),
    { platform: 'linux', baseEnv: {} },
    'npx with --yes=true',
  ),
  lc(
    srv('npx', ['--yes=false', 'pkg']),
    resolved('/usr/bin/npx'),
    { platform: 'linux', baseEnv: {} },
    'npx with --yes=false',
  ),
  lc(
    srv('npx', ['-p', 'x', '-y', 'pkg']),
    resolved('/usr/bin/npx'),
    { platform: 'linux', baseEnv: {} },
    'npx: -p x stops the scan',
  ),
  lc(
    srv('npx', ['--no-install', '-y', 'pkg']),
    resolved('/usr/bin/npx'),
    { platform: 'linux', baseEnv: {} },
    'npx: another option first',
  ),
  lc(
    srv('npx', ['--', '-y']),
    resolved('/usr/bin/npx'),
    { platform: 'linux', baseEnv: {} },
    'npx: -- stops the scan',
  ),
  lc(
    srv('npx', ['pkg', '-y']),
    resolved('/usr/bin/npx'),
    { platform: 'linux', baseEnv: {} },
    'npx: the yes comes after the package',
  ),
  lc(
    srv('npx', ['-y'], {}),
    resolved('/usr/bin/npx', { prefixArgs: ['/opt/npm/cli.js', 'exec'] }),
    { platform: 'linux', baseEnv: {} },
    'npx with a prefix from the runtime',
  ),
  lc(
    srv('npx', ['pkg']),
    resolved('/opt/npm/cli.js', { prefixArgs: ['/p'] }),
    { platform: 'linux', baseEnv: {} },
    'the answer is a script path',
  ),
  lc(
    srv('NPX', ['pkg']),
    resolved('/usr/bin/npx'),
    { platform: 'linux', baseEnv: {} },
    'NPX on posix is not npx',
  ),
  lc(
    srv('NPX', ['pkg']),
    resolved('C:\\n\\node.exe'),
    { platform: 'win32', baseEnv: {} },
    'NPX on Windows is npx',
  ),
  lc(
    srv('npx.cmd', ['pkg']),
    resolved('C:\\n\\node.exe'),
    { platform: 'win32', baseEnv: {} },
    'npx.cmd on Windows',
  ),
  lc(
    srv('npx.EXE', ['pkg']),
    resolved('C:\\n\\node.exe'),
    { platform: 'win32', baseEnv: {} },
    'npx.EXE on Windows',
  ),
  lc(
    srv('npx.cmd', ['pkg']),
    resolved('/usr/bin/npx'),
    { platform: 'linux', baseEnv: {} },
    'npx.cmd on posix',
  ),
  lc(
    srv('npx.bat.exe', ['pkg']),
    resolved('C:\\n\\node.exe'),
    { platform: 'win32', baseEnv: {} },
    'only one extension is cut',
  ),
  lc(
    srv('/usr/bin/npx', ['pkg']),
    resolved('/usr/bin/npx'),
    { platform: 'linux', baseEnv: {} },
    'a path is not a bare command',
  ),
  lc(
    srv('C:\\p\\npx', ['pkg']),
    resolved('C:\\n\\node.exe'),
    { platform: 'win32', baseEnv: {} },
    'a Windows path',
  ),
  lc(
    srv('npx', ['pkg']),
    resolved('/x/npx', { source: 'app', runtime: 'node' }),
    { platform: 'darwin', baseEnv: {} },
    'the app runtime',
  ),
  // environment
  lc(
    srv('t'),
    resolved('/bin/t'),
    { platform: 'linux', baseEnv: POSIX_BASE },
    'system variables: HOME, LANG, PATH and the proxy spelling present',
  ),
  lc(
    srv('t'),
    resolved('/bin/t'),
    { platform: 'linux', baseEnv: { path: '/lower', Path: '/mixed', PATH: '/upper' } },
    'case matters on posix',
  ),
  lc(
    srv('t'),
    resolved('C:\\t.exe'),
    { platform: 'win32', baseEnv: WIN_BASE },
    'Windows names match without regard to case; Node adds its own list',
  ),
  lc(
    srv('t'),
    resolved('C:\\t.exe'),
    { platform: 'win32', baseEnv: { PATH: 'a', Path: 'b', path: 'c' } },
    'three spellings of PATH',
  ),
  lc(
    srv('t'),
    resolved('C:\\t.exe'),
    { platform: 'win32', baseEnv: { SYSTEMROOT: 'C:\\W', temp: 'x', Tmp: 'y' } },
    'other spellings',
  ),
  lc(
    srv('t'),
    resolved('/bin/t'),
    { platform: 'linux', baseEnv: { PATH: '' } },
    'an empty variable is passed',
  ),
  lc(srv('t'), resolved('/bin/t'), { platform: 'linux', baseEnv: {} }, 'an empty environment'),
  lc(
    srv('t'),
    resolved('/bin/t'),
    { platform: 'linux', baseEnv: POSIX_BASE, systemEnv: ['LANG', 'NOPE', 'LANG', 'HOME'] },
    'another list of system variables',
  ),
  lc(
    srv('t'),
    resolved('/bin/t'),
    { platform: 'linux', baseEnv: POSIX_BASE, systemEnv: [] },
    'no system variables',
  ),
  lc(
    srv('t'),
    resolved('C:\\t.exe'),
    { platform: 'win32', baseEnv: WIN_BASE, systemEnv: ['path', 'PATH', 'username'] },
    'Windows: the list holds two spellings of one name',
  ),
  lc(
    srv('t', [], { MY: 'v', Other: 'w', LANG: 'registered' }),
    resolved('/bin/t'),
    { platform: 'linux', baseEnv: POSIX_BASE },
    'registered variables, one replacing a system one',
  ),
  lc(
    srv('t', [], { path: '/mine', Other: 'w' }),
    resolved('C:\\t.exe'),
    { platform: 'win32', baseEnv: WIN_BASE },
    'Windows: a registered path replaces PATH regardless of case, moving to the end',
  ),
  lc(
    srv('t', [], {
      SEUOFFICE_X: '1',
      seuoffice_y: '2',
      GENOFFICE_Z: '3',
      genoffice_w: '4',
      SEUOFFICE: 'no',
      MY_SEUOFFICE_X: 'kept',
    }),
    resolved('/bin/t'),
    { platform: 'linux', baseEnv: POSIX_BASE },
    'the app prefixes are never passed on',
  ),
  lc(
    srv('t', [], { '2': 'two', '1': 'one', b: 'b', a: 'a' }),
    resolved('/bin/t'),
    { platform: 'linux', baseEnv: {} },
    'integer-like registered names',
  ),
  lc(
    srv('t', [], { A: 'a' }),
    resolved('/bin/t', { env: { A: 'from the app', B: 'b' } }),
    { platform: 'linux', baseEnv: {} },
    'the runtime env replaces a registered value',
  ),
  lc(
    srv('t', [], { a: 'lower' }),
    resolved('C:\\t.exe', { env: { A: 'from the app' } }),
    { platform: 'win32', baseEnv: {} },
    'Windows: the runtime env replaces by case-insensitive name',
  ),
  lc(
    srv('t'),
    resolved('/bin/t', { env: { '3': 'x', '1': 'y' } }),
    { platform: 'linux', baseEnv: {} },
    'integer-like names from the runtime',
  ),
  lc(
    srv('t'),
    resolved('/opt/rt/bin/t', { pathPrepend: ['/opt/rt/bin', '/opt/rt/lib'] }),
    { platform: 'linux', baseEnv: POSIX_BASE },
    'the runtime folders go first on PATH',
  ),
  lc(
    srv('t'),
    resolved('/opt/rt/bin/t', { pathPrepend: ['/opt/rt/bin'] }),
    { platform: 'linux', baseEnv: {} },
    'no PATH: the runtime folder alone',
  ),
  lc(
    srv('t'),
    resolved('/opt/rt/bin/t', { pathPrepend: ['/opt/rt/bin'] }),
    { platform: 'linux', baseEnv: { PATH: '' } },
    'an empty PATH',
  ),
  lc(
    srv('t', [], { PATH: '/mine' }),
    resolved('/opt/rt/bin/t', { pathPrepend: ['/opt/rt/bin'] }),
    { platform: 'linux', baseEnv: POSIX_BASE },
    'a registered PATH: its origin stays',
  ),
  lc(
    srv('t'),
    resolved('C:\\rt\\t.exe', { pathPrepend: ['C:\\rt'] }),
    { platform: 'win32', baseEnv: WIN_BASE },
    'Windows: the delimiter and the PATH spelling of the PC',
  ),
  lc(
    srv('t'),
    resolved('C:\\rt\\t.exe', { pathPrepend: ['C:\\rt'] }),
    { platform: 'win32', baseEnv: {} },
    'Windows: no PATH',
  ),
  lc(
    srv('t', [], { PATH: 'C:\\mine' }),
    resolved('C:\\rt\\t.exe', { pathPrepend: ['C:\\rt'], env: { Path: 'C:\\app' } }),
    { platform: 'win32', baseEnv: {} },
    'Windows: the app sets PATH, then the prepend',
  ),
  lc(
    srv('t', ['a', 'b']),
    resolved('/bin/t', { prefixArgs: ['p1', 'p2'] }),
    { platform: 'linux', baseEnv: {} },
    'prefix arguments come first',
  ),
  lc(
    srv('t'),
    resolved('/bin/t', { source: 'app', runtime: 'uv' }),
    { baseEnv: { PATH: '/p' } },
    'no platform: this one',
  ),
  lc(
    srv('t'),
    resolved('/bin/t'),
    { platform: 'linux', baseEnv: { A: 'x' }, offerDownload: true },
    'a download is offered',
  ),
  lc(
    srv('t'),
    resolved('/bin/t'),
    { platform: 'linux', baseEnv: { A: 'x' }, offerDownload: false },
    'a download is not offered',
  ),
  lc(
    srv('t'),
    resolved('/bin/t'),
    { platform: 'freebsd', baseEnv: POSIX_BASE },
    'another posix platform',
  ),
]

const optionsOf = (o: Record<string, unknown>): launch.PlanOptions => ({
  ...(o.platform !== undefined ? { platform: o.platform as NodeJS.Platform } : {}),
  ...(o.baseEnv !== undefined ? { baseEnv: o.baseEnv as NodeJS.ProcessEnv } : {}),
  ...(o.systemEnv !== undefined ? { systemEnv: o.systemEnv as string[] } : {}),
  ...(o.offerDownload !== undefined ? { offerDownload: o.offerDownload as boolean } : {}),
})

const kitOf = (answer: unknown, cx: TsContext) => ({
  resolveCommand: async (command: string, options?: unknown) => {
    cx.log('resolve', command, options)
    return answer as never
  },
})

// ---------------------------------------------------------------------------
// the group
// ---------------------------------------------------------------------------

const toError = (error: unknown): { error: string; name: string; line?: number } => {
  const e = error as { message: string; name: string; line?: number }
  return { error: e.message, name: e.name, line: e.line }
}

export const group: Group = {
  'toml.parseToml': {
    ts: (a) => {
      try {
        return { ok: toml.parseToml(str(a, 0)) }
      } catch (error) {
        return toError(error)
      }
    },
    cases: tomlCases,
  },
  'paste.parseMcpPaste': {
    ts: (a) => paste.parseMcpPaste(str(a, 0), a[1] as string[]),
    cases: pasteCases,
  },
  'paste.placeholderVariable': {
    ts: (a) => paste.placeholderVariable(str(a, 0)),
    cases: placeholderCases,
  },
  'secrets.safeStorageMcpCodec': {
    ts: (a) => {
      const codec = secrets.safeStorageMcpCodec(
        storageOf(a[0] as Record<string, unknown>) as never,
        str(a, 1) as NodeJS.Platform,
      )
      const op = str(a, 2)
      if (op === 'canSeal') return codec.canSeal()
      return op === 'seal' ? codec.seal(str(a, 3)) : codec.open(str(a, 3))
    },
    cases: codecStorageCases,
  },
  'secrets.mapServerSecrets': {
    ts: (a) =>
      secrets.mapServerSecrets(normalizedServer(a[0]), (value, ref) =>
        a[1] === 'ref' ? `${ref}=${value}` : value.toUpperCase(),
      ),
    cases: secretServers.flatMap(([server, note]) =>
      ['ref', 'upper'].map((m) => c([server, m], `${note}, ${m}`)),
    ),
  },
  'secrets.sealServerSecrets': {
    ts: (a) => secrets.sealServerSecrets(normalizedServer(a[0]), codecOf(a[1] as CodecSpec)),
    cases: secretCases(() => []),
  },
  'secrets.openServerSecrets': {
    ts: (a) => secrets.openServerSecrets(normalizedServer(a[0]), codecOf(a[1] as CodecSpec)),
    cases: secretCases(() => []),
  },
  'secrets.secretView': {
    ts: (a) => secrets.secretView(str(a, 0), a[1] as boolean),
    cases: secretViewCases,
  },
  'store.MCP_SERVERS_FILE_NAME': constant(store.MCP_SERVERS_FILE_NAME),
  'store.MCP_SERVERS_FILE_VERSION': constant(store.MCP_SERVERS_FILE_VERSION),
  'store.emptyMcpServersFile': constant(store.emptyMcpServersFile()),
  'store.mcpServersFilePath': {
    ts: (a) => store.mcpServersFilePath(str(a, 0)),
    cases: ['/data', '/data/', 'data', '', '/a/../b', '/a//b'].map((d) => c([d])),
  },
  'store.newMcpServerConfig': {
    ts: (a) => normalize(store.newMcpServerConfig(a[0] as store.NewMcpServerInput)),
    cases: [
      { name: 'a', kind: 'remote' },
      { name: 'a', kind: 'local' },
      NEW_REMOTE,
      NEW_LOCAL,
      { ...NEW_REMOTE, transport: 'sse' },
      { ...NEW_REMOTE, oauth: null },
      { ...NEW_REMOTE, command: 'x', args: ['y'], env: { Z: '1' } },
      {
        ...NEW_LOCAL,
        url: 'https://x',
        transport: 'sse',
        headers: { A: '1' },
        oauth: { clientId: 'c', clientSecret: 's', tokens: 't' },
      },
      { name: 'b', kind: 'remote', headers: { '2': 'b', '1': 'a' } },
    ].map((input) => c([input])),
  },
  'store.normalizeMcpServersFile': {
    ts: (a) => normalize(store.normalizeMcpServersFile(a[0])),
    cases: [
      JSON.parse(SEALED_FILE),
      null,
      [],
      'text',
      5,
      {},
      { servers: [{}] },
      {
        servers: [
          { id: 'x', kind: 'local' },
          { id: 'y', command: 'c' },
          { id: 'z', url: 'u' },
        ],
      },
      { runtimes: { a: { allowed: true }, b: { allowed: 'yes' }, c: null, d: 1 }, servers: [] },
      { servers: [{ id: 'dup', tools: { a: { permission: 'off' } }, newTools: ['a', 'a', 'b'] }] },
    ].map((v) => c([v])),
  },
  'store.serializeMcpServersFile': {
    ts: (a) => store.serializeMcpServersFile(store.normalizeMcpServersFile(a[0])),
    cases: [
      JSON.parse(SEALED_FILE),
      {},
      { servers: [remote(), local()] },
      { servers: [local({ tools: { b: { permission: 'always', approved: 'x' }, '1': {} } })] },
      { runtimes: { node: { allowed: true } }, servers: [] },
    ].map((v) => c([v])),
  },
  'store.scenario': {
    ts: storeScenario,
    cases: storeCases,
  },
  'runtime-pins.MCP_RUNTIME_PINS': constant(pins.MCP_RUNTIME_PINS),
  'runtime-pins.MCP_RUNTIME_PLATFORM_KEYS': constant(pins.MCP_RUNTIME_PLATFORM_KEYS),
  'runtime-pins.mcpRuntimePlatformKey': {
    ts: (a) => pins.mcpRuntimePlatformKey(str(a, 0) as NodeJS.Platform, str(a, 1)),
    cases: platformCases,
  },
  'runtime-archive.downloadVerifiedArchive': {
    ts: async (a, cx) => {
      try {
        await archive.downloadVerifiedArchive(
          a[0] as never,
          str(a, 2),
          fetchOf(a[1] as FetchSpec, cx.log),
        )
        return { ok: true }
      } catch (error) {
        if (error instanceof archive.RuntimeArchiveError) {
          return { kind: error.kind, name: error.name, message: error.message }
        }
        throw error
      }
    },
    cases: downloadCases,
  },
  'runtime-archive.extractRuntimeArchive': {
    ts: async (a) => {
      try {
        await archive.extractRuntimeArchive(str(a, 0), str(a, 1) as never, str(a, 2), str(a, 3))
        return { ok: true }
      } catch (error) {
        if (error instanceof archive.RuntimeArchiveError) {
          return { kind: error.kind, name: error.name, message: error.message }
        }
        throw error
      }
    },
    cases: extractCases,
  },
  'local-launch.MCP_LOCAL_SYSTEM_ENV': constant(launch.MCP_LOCAL_SYSTEM_ENV),
  'local-launch.MCP_LOCAL_WINDOWS_ENV': constant(launch.MCP_LOCAL_WINDOWS_ENV),
  'local-launch.prepareLocalLaunch': {
    ts: (a, cx) =>
      launch.prepareLocalLaunch(
        a[0] as never,
        kitOf(a[1], cx),
        optionsOf(a[2] as Record<string, unknown>),
      ),
    cases: launchCases,
  },
  'local-launch.plannedLaunch': {
    ts: (a, cx) =>
      launch.plannedLaunch(
        a[0] as never,
        kitOf(a[1], cx),
        optionsOf(a[2] as Record<string, unknown>),
      ),
    cases: launchCases.filter((_, i) => i % 3 === 0),
  },
}
