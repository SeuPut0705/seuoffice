/**
 * Group `b5-mcp`, slice `client-sdk` (Rust: crates/main-core/src/calls/b5_mcp/client_sdk.rs):
 * the client side of @modelcontextprotocol/sdk 1.32.1 that `mcp-client/local.ts`,
 * `remote.ts` and `oauth.ts` use, with the packages it stands on
 * (eventsource, eventsource-parser, content-type, pkce-challenge) and the zod
 * schemas of types.js and shared/auth.js. The names are `mcp-sdk/<file>.<export>`.
 *
 * The real SDK classes run on the TypeScript side with a scripted fetch, fake
 * timers and fake streams; the Rust drives its state machines with the same
 * script. What is compared is what the two sides do to the world.
 *
 * Scripted fetch (`fetches`, one answer per call in order, a call past the end
 * rejects with a TypeError): `{ status, statusText, headers, body | hex,
 * stream, url, redirected, opaque, reject }`. `stream: true` makes the body a
 * stream that the steps `chunk`, `end` and `streamError` feed (streams count
 * from 1 in the order their responses were made). `reject` is `{ typeError |
 * name, message, cause }`.
 *
 * Client scenarios (`mcp-sdk/client.scenario`, `streamable-http-client.scenario`,
 * `sse-client.scenario`): `{ url?, clientInfo?, fallback?, toolsChanged?,
 * validator?, failSends?, fetches?, steps }`. A step is `{ op, ... }`:
 * `connect | listTools | callTool | ping` start an operation named `id` (options
 * `timeout` and `signal`, the name of a signal; `aborted` makes it start
 * aborted); `message` and `raw` deliver a message of the server to an
 * external transport (`message` after the schema parse the stdio framing
 * does); `timer` fires the n-th timer made; `abort` aborts a signal; `close`
 * is `client.close()`; `transportClose` and `transportError` are the pipe
 * closing or failing; `chunk | end | streamError` feed a stream;
 * `terminate` is `transport.terminateSession()`. After each step the answer
 * holds `calls` (what the world was asked to do: sends, fetches, timers,
 * validators) and `events` (what the client reported: settled operations,
 * onerror, onclose, notifications). The two lists are compared each in its own
 * order; at most one operation starts in a step, so the order inside a list
 * does not depend on how promises interleave.
 */
import { createParser } from 'eventsource-parser'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as sdkAuth from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import * as sharedAuth from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import { mediaTypeEssence } from '@modelcontextprotocol/sdk/shared/mediaType.js'
import {
  ReadBuffer,
  deserializeMessage,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js'
import {
  fetchWithinOrigin,
  isWithinOrigin,
  unfollowedRedirect,
} from '@modelcontextprotocol/sdk/shared/transport.js'
import * as types from '@modelcontextprotocol/sdk/types.js'
import { McpError, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Case, FnSpec, Group } from '../../types.ts'

type Log = (...line: unknown[]) => void

/** a chunk or a text: a plain string is UTF-8, `{ hex }` raw bytes */
type Bytes = string | { hex: string }
const bytesOf = (b: Bytes): Buffer =>
  typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b.hex, 'hex')

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null))

/** what a failure shows: its class by name, its message, and the code and data of the SDK's errors */
function errInfo(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { thrown: String(error) }
  const out: Record<string, unknown> = { name: error.name, message: error.message }
  const coded =
    error instanceof McpError || error instanceof StreamableHTTPError || error instanceof SseError
  const code = (error as { code?: unknown }).code
  if (coded && typeof code === 'number') out.code = code
  const data = (error as { data?: unknown }).data
  if (data !== undefined) out.data = data
  return out
}

const nameAndMessage = (error: unknown): { name: string; message: string } => {
  const e = error as { name?: unknown; message?: unknown }
  return { name: String(e?.name), message: String(e?.message) }
}

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))

// ---------------------------------------------------------------------------
// the fakes: a scripted fetch, fake timers, fake streams
// ---------------------------------------------------------------------------

interface FetchSpec {
  status?: number
  statusText?: string
  headers?: Record<string, string>
  body?: string
  hex?: string
  stream?: boolean
  url?: string
  redirected?: boolean
  opaque?: boolean
  reject?: {
    typeError?: boolean
    name?: string
    message: string
    cause?: { name?: string; message: string }
  }
}

interface StreamEntry {
  controller: ReadableStreamDefaultController<Uint8Array>
  closed: boolean
}

class StreamTable {
  entries = new Map<number, StreamEntry>()
  count = 0
}

function makeFetch(specs: FetchSpec[], call: Log, streams: StreamTable) {
  const queue = [...specs]
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = Object.fromEntries(new Headers(init?.headers))
    call(
      'fetch',
      url,
      init?.method ?? 'GET',
      headers,
      init?.body === undefined || init.body === null ? null : String(init.body),
      init?.redirect ?? null,
    )
    const spec = queue.shift()
    if (!spec) throw new TypeError('no scripted response')
    if (spec.reject) {
      const make = spec.reject.typeError
        ? new TypeError(spec.reject.message)
        : Object.assign(new Error(spec.reject.message), { name: spec.reject.name ?? 'Error' })
      if (spec.reject.cause) {
        make.cause = Object.assign(new Error(spec.reject.cause.message), {
          name: spec.reject.cause.name ?? 'Error',
        })
      }
      throw make
    }
    const status = spec.status ?? 200
    const nullBody = status === 204 || status === 205 || status === 304
    let body: BodyInit | null = null
    if (spec.stream) {
      streams.count += 1
      const id = streams.count
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          const entry: StreamEntry = { controller, closed: false }
          streams.entries.set(id, entry)
          init?.signal?.addEventListener('abort', () => {
            if (entry.closed) return
            entry.closed = true
            call('abort', id)
            controller.error(init.signal?.reason)
          })
        },
        cancel() {
          const entry = streams.entries.get(id)
          if (entry) entry.closed = true
          call('cancel', id)
        },
      })
    } else if (!nullBody && spec.hex !== undefined)
      body = new Uint8Array(Buffer.from(spec.hex, 'hex'))
    else if (!nullBody && spec.body !== undefined) body = spec.body
    const response = new Response(body, {
      status,
      statusText: spec.statusText ?? '',
      headers: spec.headers ?? {},
    })
    if (spec.url !== undefined) Object.defineProperty(response, 'url', { value: spec.url })
    if (spec.redirected) Object.defineProperty(response, 'redirected', { value: true })
    if (spec.opaque) {
      Object.defineProperties(response, {
        type: { value: 'opaqueredirect' },
        status: { value: 0 },
        ok: { value: false },
      })
    }
    return response
  }
}

/** `setTimeout` and `clearTimeout` that only log; a timer fires when a step says so */
async function withTimers<T>(
  call: Log,
  body: (fire: (n: number) => void) => Promise<T>,
): Promise<T> {
  const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout }
  const pending: Array<() => void> = []
  const live = new Set<number>()
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    pending.push(callback)
    live.add(pending.length)
    call('setTimeout', pending.length, ms ?? 0)
    return pending.length
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((n: unknown) => {
    live.delete(n as number)
    call('clearTimeout', n)
  }) as unknown as typeof clearTimeout
  try {
    // a timer that was cleared or has fired cannot fire
    return await body((n) => {
      const callback = pending[n - 1]
      if (!callback || !live.delete(n)) return
      callback()
    })
  } finally {
    globalThis.setTimeout = real.set
    globalThis.clearTimeout = real.clear
  }
}

/** lets the promises and the web streams of one step run out */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

// ---------------------------------------------------------------------------
// pure functions: framing, schemas, media types, event streams, urls
// ---------------------------------------------------------------------------

type BufferOp = { append: Bytes } | { read: true } | { readAll: true } | { clear: true }

const bufferCases: Case[] = cases(
  [
    {
      ops: [
        { append: '{"jsonrpc":"2.0","method":"ping","id":1}\n' },
        { read: true },
        { read: true },
      ],
    },
  ],
  [{ ops: [{ append: '{"jsonrpc":"2.0","method":"ping","id":1}\r\n' }, { read: true }] }],
  [
    {
      ops: [
        { append: '{"jsonrpc":"2.0","met' },
        { read: true },
        { append: 'hod":"ping","id":2}' },
        { read: true },
        { append: '\n' },
        { read: true },
      ],
    },
  ],
  [
    {
      ops: [
        {
          append:
            '{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0","method":"b"}\n{"jsonrpc":"2.0","method":"c"',
        },
        { readAll: true },
        { append: '}\n' },
        { readAll: true },
      ],
    },
  ],
  [{ ops: [{ append: 'not json\n{"jsonrpc":"2.0","method":"ok"}\n' }, { readAll: true }] }],
  [
    {
      ops: [
        { append: '{"jsonrpc":"1.0","method":"x"}\n{"jsonrpc":"2.0","method":"y"}\n' },
        { readAll: true },
      ],
    },
  ],
  [{ ops: [{ append: '\n' }, { read: true }, { read: true }] }],
  [{ ops: [{ append: '\r\n{"jsonrpc":"2.0","method":"z"}\n' }, { readAll: true }] }],
  [
    {
      max: 20,
      ops: [{ append: '{"jsonrpc":"2.0",' }, { append: '"method":"x"}' }, { read: true }],
    },
  ],
  [{ max: 20, ops: [{ append: '123456789012345678901' }, { read: true }] }],
  [
    {
      max: 10,
      ops: [
        { append: '12345' },
        { append: '12345' },
        { append: '6' },
        { append: '12' },
        { read: true },
        { append: '\n' },
        { read: true },
      ],
    },
  ],
  [
    {
      ops: [
        { append: { hex: '7b226a736f6e727063223a22322e30222c226d6574686f64223a22c3' } },
        { read: true },
        { append: { hex: 'a9227d0a' } },
        { read: true },
      ],
    },
  ],
  [{ ops: [{ append: { hex: 'efbbbf7b7d0a' } }, { read: true }] }],
  [{ ops: [{ append: '{"jsonrpc":"2.0","method":"x"}' }, { clear: true }, { read: true }] }],
  [{ ops: [{ append: { hex: 'ff0a' } }, { read: true }] }],
  [{ ops: [{ append: '{"jsonrpc":"2.0","method":"x"}\r\r\n' }, { readAll: true }] }],
  [
    {
      ops: [
        { read: true },
        { clear: true },
        { append: '{"jsonrpc":"2.0","id":3,"result":{}}\n' },
        { read: true },
      ],
    },
  ],
)

const bufferSpec: FnSpec = {
  ts: ([cfg]) => {
    const c = cfg as { max?: number; ops: BufferOp[] }
    const buffer = new ReadBuffer(c.max === undefined ? undefined : { maxBufferSize: c.max })
    const out: unknown[] = []
    for (const op of c.ops) {
      if ('append' in op) {
        try {
          buffer.append(bytesOf(op.append))
          out.push('ok')
        } catch (error) {
          out.push({ error: nameAndMessage(error) })
        }
      } else if ('read' in op) {
        try {
          out.push({ message: buffer.readMessage() })
        } catch (error) {
          out.push({ error: nameAndMessage(error) })
        }
      } else if ('readAll' in op) {
        const got: unknown[] = []
        for (;;) {
          try {
            const message = buffer.readMessage()
            if (!message) break
            got.push(message)
          } catch (error) {
            got.push({ error: nameAndMessage(error) })
          }
        }
        out.push(got)
      } else {
        buffer.clear()
        out.push('cleared')
      }
    }
    return out
  },
  cases: bufferCases,
}

const MESSAGES: unknown[] = [
  { jsonrpc: '2.0', method: 'ping', id: 1 },
  { jsonrpc: '2.0', id: 0, result: {} },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  {
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'é', version: '1' },
    },
    jsonrpc: '2.0',
    id: 0,
  },
  { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no\nline' } },
  { a: [1, 2, { b: null }], c: 'x\u2028y' },
  [],
  null,
]

const serializeSpec: FnSpec = {
  ts: ([message]) => serializeMessage(message as never),
  cases: MESSAGES.map((m): Case => ({ args: [m] })),
}

const LINES = [
  '{"jsonrpc":"2.0","method":"ping","id":1}',
  '{"jsonrpc":"2.0","id":1,"result":{"a":1}}',
  '{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"m","data":[1]}}',
  '{"jsonrpc":"2.0","method":"notifications/tools/list_changed","params":{"_meta":{"x":1}}}',
  '{"jsonrpc":"2.0","id":1}',
  '{"jsonrpc":"2.0","id":1.5,"method":"x"}',
  '{"jsonrpc":"2.0","id":"7","method":"x","params":[]}',
  '{"jsonrpc":"2.0","method":"x","extra":1}',
  '{"jsonrpc":"2.0","id":1,"result":{},"extra":1}',
  '{"jsonrpc":"2.0","id":1,"result":5}',
  '{"jsonrpc":"2.0","id":null,"error":{"code":1,"message":"m"}}',
  '{"jsonrpc":"2.0","error":{"code":1.5,"message":"m"}}',
  'not json',
  '',
  '[]',
  'null',
  '{"id":1,"method":"x"}',
]

const deserializeSpec: FnSpec = {
  ts: ([line]) => {
    try {
      return { ok: deserializeMessage(line as string) }
    } catch (error) {
      return { error: nameAndMessage(error) }
    }
  },
  cases: LINES.map((l): Case => ({ args: [l] })),
}

/** the zod schemas of the SDK by name */
const SCHEMAS: Record<
  string,
  { safeParse(value: unknown): { success: boolean; data?: unknown; error?: { issues: unknown[] } } }
> = {
  JSONRPCMessage: types.JSONRPCMessageSchema,
  JSONRPCRequest: types.JSONRPCRequestSchema,
  JSONRPCNotification: types.JSONRPCNotificationSchema,
  JSONRPCResultResponse: types.JSONRPCResultResponseSchema,
  JSONRPCErrorResponse: types.JSONRPCErrorResponseSchema,
  InitializeResult: types.InitializeResultSchema,
  ListToolsResult: types.ListToolsResultSchema,
  CallToolResult: types.CallToolResultSchema,
  EmptyResult: types.EmptyResultSchema,
  ToolListChangedNotification: types.ToolListChangedNotificationSchema,
  InitializedNotification: types.InitializedNotificationSchema,
  CancelledNotification: types.CancelledNotificationSchema,
  ProgressNotification: types.ProgressNotificationSchema,
  PingRequest: types.PingRequestSchema,
  OAuthProtectedResourceMetadata: sharedAuth.OAuthProtectedResourceMetadataSchema,
  OAuthMetadata: sharedAuth.OAuthMetadataSchema,
  OpenIdProviderDiscoveryMetadata: sharedAuth.OpenIdProviderDiscoveryMetadataSchema,
  TokenResponse: sharedAuth.OAuthTokensSchema.omit({ issuer: true }),
  RegistrationResponse: sharedAuth.OAuthClientInformationFullSchema.omit({ issuer: true }),
  OAuthErrorResponse: sharedAuth.OAuthErrorResponseSchema,
}

const TOOL = {
  name: 'echo',
  description: 'Echo',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}

const PARSE: Array<[string, unknown]> = [
  ['JSONRPCMessage', { jsonrpc: '2.0', method: 'ping', id: 1 }],
  [
    'JSONRPCMessage',
    {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 'a',
      params: { name: 'x', _meta: { progressToken: 5, more: 1 }, other: [1] },
    },
  ],
  [
    'JSONRPCMessage',
    { jsonrpc: '2.0', method: 'tools/call', id: 2, params: { _meta: { progressToken: true } } },
  ],
  ['JSONRPCMessage', { jsonrpc: '2.0', method: 'x', id: 1.5 }],
  ['JSONRPCMessage', { jsonrpc: '2.0', method: 'x', id: 1, more: 1 }],
  ['JSONRPCMessage', { jsonrpc: '2.0', method: 'notifications/x', params: { a: 1 } }],
  ['JSONRPCMessage', { jsonrpc: '2.0', id: 1, result: { content: [], extra: true } }],
  ['JSONRPCMessage', { jsonrpc: '2.0', id: 1, result: [] }],
  [
    'JSONRPCMessage',
    { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'x', data: { a: 1 } } },
  ],
  ['JSONRPCMessage', { jsonrpc: '2.0', error: { code: 5, message: 'x' } }],
  ['JSONRPCMessage', { jsonrpc: '2.0', id: 1, error: { code: 1.5, message: 'x' } }],
  ['JSONRPCMessage', { jsonrpc: '1.0', id: 1 }],
  ['JSONRPCMessage', { jsonrpc: '2.0', id: 1 }],
  ['JSONRPCMessage', {}],
  ['JSONRPCMessage', []],
  ['JSONRPCMessage', null],
  ['JSONRPCMessage', 'text'],
  ['JSONRPCMessage', { jsonrpc: '2.0', id: 9007199254740992, method: 'x' }],
  ['JSONRPCRequest', { id: 1, method: 'a', jsonrpc: '2.0', params: {} }],
  ['JSONRPCNotification', { method: 'a', jsonrpc: '2.0', id: 1 }],
  [
    'JSONRPCResultResponse',
    {
      result: { _meta: { 'io.modelcontextprotocol/related-task': { taskId: 't' } } },
      id: 1,
      jsonrpc: '2.0',
    },
  ],
  [
    'JSONRPCResultResponse',
    {
      result: { _meta: { 'io.modelcontextprotocol/related-task': { taskId: 5 } } },
      id: 1,
      jsonrpc: '2.0',
    },
  ],
  ['JSONRPCErrorResponse', { error: { message: 'm', code: 3 }, jsonrpc: '2.0' }],
  [
    'InitializeResult',
    {
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: true }, logging: {}, experimental: { a: { b: 1 } } },
      serverInfo: { name: 'srv', version: '1.0.0' },
    },
  ],
  [
    'InitializeResult',
    {
      serverInfo: {
        version: '2',
        name: 'srv',
        title: 'T',
        icons: [{ src: 'a', sizes: ['1x1'], theme: 'dark', zzz: 1 }],
        websiteUrl: 'w',
        description: 'd',
        extra: 1,
      },
      instructions: 'be nice',
      capabilities: {
        prompts: { listChanged: false, x: 1 },
        resources: { subscribe: true },
        completions: {},
        tasks: { list: {}, requests: { tools: { call: {} }, other: 1 }, more: 2 },
        extensions: { e: {} },
        unknown: 1,
      },
      protocolVersion: '2024-11-05',
      _meta: { progressToken: 'p' },
      extra: { a: 1 },
    },
  ],
  ['InitializeResult', { protocolVersion: 3, capabilities: 'x', serverInfo: [] }],
  [
    'InitializeResult',
    {
      protocolVersion: 'x',
      capabilities: { tools: { listChanged: 'yes' }, experimental: { a: 1 }, logging: null },
      serverInfo: { name: 'n' },
    },
  ],
  ['InitializeResult', {}],
  [
    'InitializeResult',
    {
      protocolVersion: 'x',
      capabilities: { experimental: { a: [] } },
      serverInfo: { name: 'n', version: '1', icons: [{ src: 3, theme: 'blue' }] },
    },
  ],
  ['ListToolsResult', { tools: [] }],
  ['ListToolsResult', { tools: [TOOL], nextCursor: 'c2' }],
  [
    'ListToolsResult',
    {
      nextCursor: 'n',
      tools: [
        {
          annotations: {
            readOnlyHint: true,
            title: 't',
            extra: 1,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          execution: { taskSupport: 'required' },
          outputSchema: { type: 'object', required: ['a'], extra: { a: 1 }, properties: { a: {} } },
          inputSchema: {
            extra: 1,
            type: 'object',
            required: [],
            properties: { x: { type: 'number' } },
          },
          description: 'd',
          title: 'T',
          icons: [{ src: 'i.png' }],
          name: 'tool',
          _meta: { a: 1 },
          unknownKey: 1,
        },
      ],
    },
  ],
  ['ListToolsResult', { tools: [{ name: 'a', inputSchema: { type: 'array' } }] }],
  ['ListToolsResult', { tools: [{ name: 'a' }] }],
  [
    'ListToolsResult',
    { tools: [{ name: 'a', inputSchema: { type: 'object', properties: { p: 5 } } }] },
  ],
  [
    'ListToolsResult',
    {
      tools: [
        {
          name: 'a',
          inputSchema: { type: 'object', required: [1] },
          execution: { taskSupport: 'maybe' },
          annotations: { readOnlyHint: 'x' },
        },
      ],
    },
  ],
  ['ListToolsResult', { tools: {} }],
  [
    'ListToolsResult',
    { tools: [{ name: 'a', inputSchema: { type: 'object', __proto__x: 1 }, outputSchema: 5 }] },
  ],
  ['CallToolResult', { content: [{ type: 'text', text: 'hi' }] }],
  [
    'CallToolResult',
    {
      content: [
        {
          type: 'text',
          text: 'hi',
          annotations: {
            audience: ['user'],
            priority: 0.5,
            lastModified: '2024-02-29T10:00:00+02:00',
          },
          _meta: { a: 1 },
          extra: 1,
        },
      ],
      isError: true,
      structuredContent: { a: [1] },
    },
  ],
  ['CallToolResult', {}],
  ['CallToolResult', { isError: false, extra: { x: 1 } }],
  ['CallToolResult', { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }],
  ['CallToolResult', { content: [{ type: 'image', data: 'AA*A', mimeType: 'image/png' }] }],
  [
    'CallToolResult',
    {
      content: [
        { type: 'audio', data: 'AA==', mimeType: 'audio/wav' },
        { type: 'audio', data: 'A', mimeType: 'x' },
      ],
    },
  ],
  [
    'CallToolResult',
    {
      content: [
        {
          type: 'resource_link',
          name: 'r',
          uri: 'file:///a',
          mimeType: 'text/plain',
          size: 3,
          icons: [{ src: 'a' }],
          description: 'd',
          title: 't',
        },
      ],
    },
  ],
  [
    'CallToolResult',
    {
      content: [
        {
          type: 'resource',
          resource: { uri: 'file:///a', text: 'x', mimeType: 'text/plain', _meta: {} },
        },
      ],
    },
  ],
  [
    'CallToolResult',
    { content: [{ type: 'resource', resource: { uri: 'file:///a', blob: 'AAAA' } }] },
  ],
  [
    'CallToolResult',
    { content: [{ type: 'resource', resource: { uri: 'file:///a', blob: '%%%' } }] },
  ],
  ['CallToolResult', { content: [{ type: 'resource', resource: { uri: 'file:///a' } }] }],
  ['CallToolResult', { content: [{ type: 'video' }] }],
  ['CallToolResult', { content: [{ type: 'text' }] }],
  [
    'CallToolResult',
    {
      content: [
        {
          type: 'text',
          text: 'x',
          annotations: { priority: 2, lastModified: 'yesterday', audience: ['robot'] },
        },
      ],
    },
  ],
  [
    'CallToolResult',
    {
      content: [
        {
          type: 'text',
          text: 'x',
          annotations: { priority: -1, lastModified: '2023-02-29T00:00:00Z' },
        },
      ],
    },
  ],
  ['CallToolResult', { content: 'text', structuredContent: [] }],
  ['CallToolResult', { content: [{ type: 'text', text: 1 }, { type: 'image' }], isError: 'no' }],
  ['EmptyResult', {}],
  ['EmptyResult', { _meta: { progressToken: 3 } }],
  ['EmptyResult', { a: 1 }],
  ['EmptyResult', []],
  ['ToolListChangedNotification', { method: 'notifications/tools/list_changed' }],
  [
    'ToolListChangedNotification',
    {
      method: 'notifications/tools/list_changed',
      params: { _meta: { a: 1 }, other: 1 },
      jsonrpc: '2.0',
    },
  ],
  ['ToolListChangedNotification', { method: 'notifications/tools/list_changed', params: 5 }],
  ['ToolListChangedNotification', { method: 'notifications/other' }],
  ['InitializedNotification', { method: 'notifications/initialized', jsonrpc: '2.0' }],
  [
    'CancelledNotification',
    { method: 'notifications/cancelled', params: { requestId: 3, reason: 'r' } },
  ],
  [
    'CancelledNotification',
    {
      method: 'notifications/cancelled',
      params: { reason: 'r', requestId: 'a', extra: 1, _meta: {} },
    },
  ],
  ['CancelledNotification', { method: 'notifications/cancelled' }],
  ['CancelledNotification', { method: 'notifications/cancelled', params: { requestId: 1.5 } }],
  [
    'ProgressNotification',
    {
      method: 'notifications/progress',
      params: { progressToken: 1, progress: 0.5, total: 2, message: 'm', extra: 1 },
    },
  ],
  ['ProgressNotification', { method: 'notifications/progress', params: { progress: 'x' } }],
  ['PingRequest', { method: 'ping', jsonrpc: '2.0', id: 1 }],
  ['PingRequest', { method: 'ping', params: { _meta: { progressToken: true } } }],
  ['PingRequest', { method: 'pong' }],
  ['OAuthProtectedResourceMetadata', { resource: 'https://a.example/mcp' }],
  [
    'OAuthProtectedResourceMetadata',
    {
      resource: '  https://a.example/mcp\n',
      authorization_servers: [' https://as.example/ ', 'https://b.example'],
      scopes_supported: ['a'],
      extra: 1,
      dpop_bound_access_tokens_required: true,
    },
  ],
  ['OAuthProtectedResourceMetadata', { resource: 'nope' }],
  [
    'OAuthProtectedResourceMetadata',
    { resource: 'https://a.example', authorization_servers: ['javascript:alert(1)'] },
  ],
  [
    'OAuthProtectedResourceMetadata',
    {
      resource: 'https://a.example',
      authorization_servers: ['not a url', 'data:text/plain,x', 'VBSCRIPT:x'],
      jwks_uri: 'x',
    },
  ],
  [
    'OAuthProtectedResourceMetadata',
    { resource: 'https://a.example', authorization_servers: 'x', scopes_supported: [1] },
  ],
  [
    'OAuthMetadata',
    {
      issuer: 'i',
      authorization_endpoint: 'https://a/auth',
      token_endpoint: 'https://a/token',
      response_types_supported: ['code'],
    },
  ],
  [
    'OAuthMetadata',
    {
      issuer: 'i',
      authorization_endpoint: 'https://a/auth',
      token_endpoint: 'https://a/token',
      response_types_supported: ['code'],
      registration_endpoint: 'https://a/reg',
      revocation_endpoint: 'https://a/rev',
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      unknown: { a: 1 },
      scopes_supported: ['x'],
      introspection_endpoint: 'q',
    },
  ],
  [
    'OAuthMetadata',
    {
      issuer: 'i',
      authorization_endpoint: 'data:x',
      token_endpoint: 'x',
      response_types_supported: 'code',
    },
  ],
  ['OAuthMetadata', {}],
  [
    'OpenIdProviderDiscoveryMetadata',
    {
      issuer: 'i',
      authorization_endpoint: 'https://a/auth',
      token_endpoint: 'https://a/token',
      jwks_uri: 'https://a/jwks',
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      revocation_endpoint: 'https://a/rev',
      code_challenge_methods_supported: ['S256'],
      extra: 1,
    },
  ],
  [
    'OpenIdProviderDiscoveryMetadata',
    {
      issuer: 'i',
      authorization_endpoint: 'https://a/auth',
      token_endpoint: 'https://a/token',
      response_types_supported: ['code'],
    },
  ],
  ['TokenResponse', { access_token: 'a', token_type: 'Bearer' }],
  [
    'TokenResponse',
    {
      token_type: 'bearer',
      expires_in: '3600',
      access_token: 'a',
      refresh_token: 'r',
      scope: 's',
      extra: 1,
      issuer: 'x',
      id_token: 'i',
    },
  ],
  ['TokenResponse', { access_token: 'a', token_type: 'Bearer', expires_in: 'soon' }],
  ['TokenResponse', { access_token: 'a', token_type: 'Bearer', expires_in: null }],
  ['TokenResponse', { access_token: 'a', token_type: 'Bearer', expires_in: '' }],
  ['TokenResponse', { access_token: 'a', token_type: 'Bearer', expires_in: true, scope: 5 }],
  ['TokenResponse', { access_token: 1 }],
  ['RegistrationResponse', { client_id: 'c', redirect_uris: ['http://localhost:1/cb'] }],
  [
    'RegistrationResponse',
    {
      redirect_uris: ['http://localhost:1/cb'],
      client_name: 'n',
      logo_uri: '',
      tos_uri: 'https://a/tos',
      client_id: 'c',
      client_secret: 's',
      client_id_issued_at: 1,
      client_secret_expires_at: 0,
      issuer: 'x',
      software_id: 'z',
      unknown: 1,
      jwks: { keys: [] },
    },
  ],
  [
    'RegistrationResponse',
    { client_id: 'c', redirect_uris: ['javascript:x'], logo_uri: 'javascript:x' },
  ],
  [
    'RegistrationResponse',
    { client_id: 'c', redirect_uris: [], logo_uri: 'not a url', tos_uri: 5 },
  ],
  ['RegistrationResponse', { redirect_uris: 'x' }],
  [
    'OAuthErrorResponse',
    { error: 'invalid_grant', error_description: 'gone', error_uri: 'https://e' },
  ],
  ['OAuthErrorResponse', { error: 5 }],
  ['OAuthErrorResponse', { error: 'x', extra: 1 }],
]

const parseSpec: FnSpec = {
  ts: ([name, value]) => {
    const schema = SCHEMAS[name as string]
    if (!schema) throw new Error(`no schema ${String(name)}`)
    const result = schema.safeParse(value)
    return result.success ? { ok: plain(result.data) } : { issues: plain(result.error?.issues) }
  },
  cases: PARSE.map(([name, value]): Case => ({ args: [name, value] })),
}

const HEADER_TYPES: Array<string | null> = [
  null,
  '',
  'application/json',
  'APPLICATION/JSON',
  'application/json; charset=utf-8',
  'application/json;charset="utf-8"',
  'application/json;',
  'application/json; charset=',
  'application/json ; charset=utf-8',
  'text/plain; a=application/json',
  'text/event-stream',
  'text/event-stream;charset=UTF-8',
  'text/event-stream, application/json',
  'text/event-stream; x=1, y=2',
  'application/json, text/plain',
  'json',
  '  text/html  ',
  'text/html;a="b\\"c"',
  'text/html;a="b',
  'application/ld+json',
  'text/plain;;',
  '/json',
  'a/b/c',
  ';text/html',
  'ÅPPLICATION/JSON;;',
  'text/\u00e9; q=1,',
]

const mediaTypeSpec: FnSpec = {
  ts: ([header]) => mediaTypeEssence((header as string | null) ?? undefined) ?? null,
  cases: HEADER_TYPES.map((h): Case => ({ args: [h] })),
}

type ParserOp = { chunk: Bytes } | { end: true } | { reset: true }

const PARSER_CASES: ParserOp[][] = [
  [{ chunk: 'data: hello\n\n' }],
  [{ chunk: 'event: message\nid: 1\ndata: {"a":1}\n\n' }],
  [{ chunk: 'data: a\ndata: b\n\n' }],
  [{ chunk: 'data: par' }, { chunk: 'tial\n' }, { chunk: '\n' }],
  [{ chunk: 'data: x\r\n\r\n' }],
  [{ chunk: 'data: x\r' }, { chunk: '\n\r' }, { chunk: '\n' }],
  [{ chunk: 'data: x\r\r' }],
  [{ chunk: 'data: x\r' }, { chunk: 'y' }, { chunk: '\n\n' }],
  [{ chunk: ': comment\ndata:no space\nretry: 1500\nid: 7\n\n' }],
  [{ chunk: 'retry: abc\nretry: 12x\nretry: 42\n\n' }],
  [{ chunk: 'id: a\0b\ndata: z\n\nid:\ndata: w\n\n' }],
  [{ chunk: 'unknown: field\nevent\ndata\ndata: y\n\n' }],
  [{ chunk: 'event: endpoint\ndata: /messages?session=1\n\n' }],
  [{ chunk: '\u00ef\u00bb\u00bfdata: bom\n\n' }],
  [{ chunk: { hex: 'efbbbf646174613a206f6b0a0a' } }],
  [{ chunk: { hex: '646174613a20c3' } }, { chunk: { hex: 'a90a0a' } }],
  [{ chunk: { hex: '646174613a20ff0a0a' } }],
  [{ chunk: 'data: a\n\ndata: b\n\ndata: c' }, { end: true }],
  [{ chunk: { hex: '646174613a20e2' } }, { end: true }],
  [{ chunk: 'data: 1\n\n' }, { reset: true }, { chunk: 'data: 2\n\n' }],
  [{ chunk: 'data:\n\n' }, { chunk: 'data: \n\n' }, { chunk: 'event: e\n\n' }],
  [{ chunk: 'ID: 1\ndata: A\n\n' }],
]

const parserSpec: FnSpec = {
  ts: ([ops]) => {
    const decoder = new TextDecoder()
    let found: unknown[] = []
    let retries: number[] = []
    const parser = createParser({
      onEvent: (event) => found.push(event),
      onRetry: (retry) => retries.push(retry),
    })
    const out: unknown[] = []
    for (const op of ops as ParserOp[]) {
      if ('chunk' in op) parser.feed(decoder.decode(bytesOf(op.chunk), { stream: true }))
      else if ('end' in op) {
        const rest = decoder.decode()
        if (rest) parser.feed(rest)
      } else parser.reset()
      out.push({ events: found, retries })
      found = []
      retries = []
    }
    return plain(out)
  },
  cases: PARSER_CASES.map((ops): Case => ({ args: [ops] })),
}

const ORIGINS: Array<[string, string]> = [
  ['https://a.example/x', 'https://a.example/y'],
  ['https://a.example/x', 'https://b.example/x'],
  ['https://a.example/x', 'http://a.example/x'],
  ['http://a.example/x', 'https://a.example/x'],
  ['http://a.example:80/x', 'https://a.example:443/x'],
  ['http://a.example:8080/x', 'https://a.example/x'],
  ['http://a.example/x', 'https://a.example:444/x'],
  ['https://a.example:8443/x', 'https://a.example/x'],
  ['https://a.example/x', 'https://a.example:443/x'],
  ['http://[::1]:3000/x', 'http://[::1]:3000/y'],
  ['http://127.0.0.1/x', 'https://127.0.0.1/x'],
  ['https://a.example/x', 'https://A.EXAMPLE/x'],
]

const withinOriginSpec: FnSpec = {
  ts: ([from, to]) => isWithinOrigin(new URL(from as string), new URL(to as string)),
  cases: ORIGINS.map(([from, to]): Case => ({ args: [from, to] })),
}

interface ResponseDesc {
  status?: number
  headers?: Record<string, string>
  opaque?: boolean
  url?: string
}

function responseOf(desc: ResponseDesc): Response {
  const response = new Response(null, { status: desc.status ?? 200, headers: desc.headers ?? {} })
  if (desc.url !== undefined) Object.defineProperty(response, 'url', { value: desc.url })
  if (desc.opaque) Object.defineProperty(response, 'type', { value: 'opaqueredirect' })
  return response
}

const UNFOLLOWED: Array<[ResponseDesc, string]> = [
  [{ status: 200 }, 'https://a.example/x'],
  [{ status: 302, headers: { location: 'https://b.example/y' } }, 'https://a.example/x'],
  [{ status: 301, headers: { location: '/other?q=1#f' } }, 'https://a.example/x'],
  [{ status: 307, headers: { location: 'http://a.example/x' } }, 'https://a.example/x'],
  [
    { status: 307, headers: { location: 'http://u:p@a.example:8080/x?y#z' } },
    'https://a.example/x',
  ],
  [
    { status: 308, headers: { location: 'https://a.example/y' }, url: 'https://c.example/x' },
    'https://a.example/x',
  ],
  [{ status: 302 }, 'https://a.example/x'],
  [{ status: 302, headers: { location: '' } }, 'https://a.example/x'],
  [{ status: 303, headers: { location: 'http://[bad' } }, 'https://a.example/x'],
  [{ status: 200, headers: { location: 'https://b.example/' } }, 'https://a.example/x'],
  [{ status: 302, headers: { location: 'https://u:p@b.example/y?z=1#h' } }, 'http://a.example/x'],
  [
    { status: 302, opaque: true, headers: { location: 'https://b.example/' } },
    'https://a.example/x',
  ],
  [{ status: 302, headers: { location: 'http://b.example/' } }, 'not a url'],
]

const unfollowedSpec: FnSpec = {
  ts: ([desc, url]) => unfollowedRedirect(responseOf(desc as ResponseDesc), url as string) ?? null,
  cases: UNFOLLOWED.map(([desc, url]): Case => ({ args: [desc, url] })),
}

interface FetchCase {
  fetches: FetchSpec[]
  url?: string
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    redirect?: 'manual' | 'error' | 'follow'
  }
}

async function runFetchWithinOrigin(cfg: FetchCase): Promise<unknown> {
  const calls: unknown[][] = []
  const fetchFn = makeFetch(cfg.fetches, (...x) => calls.push(x), new StreamTable())
  const init: RequestInit = {}
  if (cfg.init?.method !== undefined) init.method = cfg.init.method
  if (cfg.init?.headers !== undefined) init.headers = cfg.init.headers
  if (cfg.init?.body !== undefined) init.body = cfg.init.body
  if (cfg.init?.redirect !== undefined) init.redirect = cfg.init.redirect
  try {
    const response = await fetchWithinOrigin(fetchFn)(cfg.url ?? 'https://a.example/mcp', init)
    return { calls, status: response.status, text: await response.text() }
  } catch (error) {
    return { calls, error: nameAndMessage(error) }
  }
}

const redirect = (status: number, location: string, extra: Partial<FetchSpec> = {}): FetchSpec => ({
  status,
  headers: { location },
  ...extra,
})

const fetchWithinOriginSpec: FnSpec = {
  ts: ([cfg]) => runFetchWithinOrigin(cfg as FetchCase),
  cases: cases(
    [{ fetches: [{ body: 'ok' }] }],
    [{ fetches: [redirect(302, '/b', { body: 'x' }), { body: 'done' }] }],
    [{ fetches: [redirect(301, 'https://a.example/b'), redirect(308, '/c'), { body: 'end' }] }],
    [{ fetches: [redirect(302, 'https://b.example/x')], url: 'https://a.example/mcp' }],
    [
      {
        fetches: [redirect(307, '/b'), { body: 'post kept' }],
        init: { method: 'POST', body: '{}' },
      },
    ],
    [
      {
        fetches: [redirect(302, '/b'), { body: 'not reached' }],
        init: { method: 'POST', body: '{}' },
      },
    ],
    [{ fetches: [redirect(303, '/b'), { body: 'not reached' }], init: { method: 'DELETE' } }],
    [{ fetches: [redirect(302, '/b'), { body: 'get follows' }], init: { method: 'get' } }],
    [{ fetches: [redirect(302, '/b')], init: { redirect: 'manual' } }],
    [{ fetches: [redirect(302, '/b')], init: { redirect: 'error' } }],
    [{ fetches: [redirect(302, '/b'), { body: 'follow policy' }], init: { redirect: 'follow' } }],
    [
      {
        fetches: [redirect(302, 'http://a.example/b'), { body: 'upgrade path' }],
        url: 'http://a.example/mcp',
      },
    ],
    [
      {
        fetches: [redirect(302, 'https://a.example/b'), { body: 'https upgrade' }],
        url: 'http://a.example/mcp',
      },
    ],
    [
      {
        fetches: [redirect(302, 'https://a.example:8443/b'), { body: 'other port' }],
        url: 'http://a.example/mcp',
      },
    ],
    [{ fetches: [redirect(302, 'https://u:p@a.example/b'), { body: 'userinfo' }] }],
    [
      {
        fetches: [redirect(302, '/b'), { body: 'same' }],
        init: { headers: { 'X-One': '1', accept: 'text/x' } },
      },
    ],
    [
      {
        fetches: [1, 2, 3, 4, 5, 6]
          .map((n) => redirect(302, `/r${n}`))
          .concat([{ body: 'never' }] as never),
      },
    ],
    [
      {
        fetches: [
          {
            reject: {
              typeError: true,
              message: 'fetch failed',
              cause: { message: 'ECONNREFUSED' },
            },
          },
        ],
      },
    ],
    [{ fetches: [redirect(302, '/b'), { reject: { typeError: true, message: 'fetch failed' } }] }],
    [{ fetches: [{ status: 302 }, { body: 'no location' }] }],
    [{ fetches: [redirect(302, 'http://[bad'), { body: 'bad' }] }],
    [{ fetches: [] }],
  ),
}

// ---- auth: the helpers of client/auth.js ----

const RESPONSE_HEADERS: Array<Record<string, string>> = [
  {},
  { 'WWW-Authenticate': 'Bearer realm="x"' },
  {
    'WWW-Authenticate':
      'Bearer resource_metadata="https://a.example/.well-known/oauth-protected-resource", scope="read write", error="insufficient_scope"',
  },
  { 'WWW-Authenticate': 'bearer resource_metadata=https://a.example/rm,scope=read' },
  { 'WWW-Authenticate': 'Basic realm="x"' },
  { 'WWW-Authenticate': 'Bearer' },
  { 'WWW-Authenticate': 'Bearer  scope="x"' },
  { 'WWW-Authenticate': 'Bearer resource_metadata="not a url", scope=""' },
  { 'WWW-Authenticate': 'Bearer error=invalid_token error_description="x", scope=a%20b' },
  { 'www-authenticate': 'BEARER xscope="q" resource_metadata="http://[bad"' },
  { 'WWW-Authenticate': 'Bearer scope="a", scope="b"' },
  { 'WWW-Authenticate': '' },
  { 'WWW-Authenticate': 'Bearer error="a b"' },
]

const wwwAuthSpec: FnSpec = {
  ts: ([headers]) => {
    const found = sdkAuth.extractWWWAuthenticateParams(
      new Response(null, { status: 401, headers: headers as Record<string, string> }),
    )
    return plain({
      ...found,
      resourceMetadataUrl: found.resourceMetadataUrl?.href,
    })
  },
  cases: RESPONSE_HEADERS.map((h): Case => ({ args: [h] })),
}

const resourceAllowedSpec: FnSpec = {
  ts: ([requested, configured]) => {
    try {
      return {
        ok: checkResourceAllowed({
          requestedResource: requested as string,
          configuredResource: configured as string,
        }),
      }
    } catch (error) {
      return { error: nameAndMessage(error) }
    }
  },
  cases: [
    ['https://a.example/mcp', 'https://a.example/mcp'],
    ['https://a.example/mcp/tools', 'https://a.example/mcp'],
    ['https://a.example/mcp123', 'https://a.example/mcp'],
    ['https://a.example/mcp', 'https://a.example/mcp/'],
    ['https://a.example/mcp/', 'https://a.example/mcp'],
    ['https://a.example/', 'https://a.example'],
    ['https://a.example/x', 'https://a.example'],
    ['https://a.example', 'https://a.example/x'],
    ['https://a.example/mcp', 'https://b.example/mcp'],
    ['https://a.example:8443/mcp', 'https://a.example/mcp'],
    ['http://a.example/mcp', 'https://a.example/mcp'],
    ['https://a.example/mcp?x=1#f', 'https://a.example/mcp'],
    ['https://a.example/a%20b', 'https://a.example/a b'],
    ['not a url', 'https://a.example'],
    ['https://a.example', ''],
    ['foo://a/b', 'bar://c/b'],
    ['foo://a/b/c', 'bar://c/b'],
    ['https://a.example/MCP', 'https://a.example/mcp'],
    ['https://A.example/mcp', 'https://a.example/mcp'],
  ].map(([a, b]): Case => ({ args: [a, b] })),
}

const resourceUrlSpec: FnSpec = {
  ts: ([url]) => {
    try {
      return { ok: resourceUrlFromServerUrl(url as string).href }
    } catch (error) {
      return { error: nameAndMessage(error) }
    }
  },
  cases: [
    'https://a.example/mcp',
    'https://a.example/mcp#fragment',
    'https://a.example#x',
    'https://a.example/mcp?x=1#f',
    'https://A.EXAMPLE:443/p/../q',
    'http://u:p@a.example:8080/x#y',
    'nope',
    '',
    'foo:bar#baz',
  ].map((u): Case => ({ args: [u] })),
}

const CLIENTS: Array<[Record<string, unknown>, string[]]> = [
  [{ client_id: 'c' }, []],
  [{ client_id: 'c', client_secret: 's' }, []],
  [{ client_id: 'c' }, ['client_secret_basic', 'none']],
  [{ client_id: 'c', client_secret: 's' }, ['client_secret_basic', 'client_secret_post']],
  [{ client_id: 'c', client_secret: 's' }, ['client_secret_post']],
  [{ client_id: 'c', client_secret: 's' }, ['none']],
  [{ client_id: 'c', client_secret: 's' }, ['private_key_jwt']],
  [{ client_id: 'c' }, ['private_key_jwt']],
  [
    { client_id: 'c', client_secret: 's', token_endpoint_auth_method: 'client_secret_post' },
    ['client_secret_basic', 'client_secret_post'],
  ],
  [
    { client_id: 'c', client_secret: 's', token_endpoint_auth_method: 'client_secret_post' },
    ['client_secret_basic'],
  ],
  [{ client_id: 'c', token_endpoint_auth_method: 'none' }, []],
  [{ client_id: 'c', client_secret: 's', token_endpoint_auth_method: 'none' }, []],
  [{ client_id: 'c', client_secret: 's', token_endpoint_auth_method: 'weird' }, []],
  [{ client_id: 'c', client_secret: 's', token_endpoint_auth_method: '' }, ['none']],
  [{ client_id: 'c', client_secret: '' }, ['client_secret_basic']],
]

const authMethodSpec: FnSpec = {
  ts: ([client, supported]) =>
    sdkAuth.selectClientAuthMethod(client as never, supported as string[]),
  cases: CLIENTS.map(([c, s]): Case => ({ args: [c, s] })),
}

const discoveryUrlsSpec: FnSpec = {
  ts: ([url]) => {
    try {
      return { ok: sdkAuth.buildDiscoveryUrls(url as string).map((u) => [u.url.href, u.type]) }
    } catch (error) {
      return { error: nameAndMessage(error) }
    }
  },
  cases: [
    'https://as.example',
    'https://as.example/',
    'https://as.example/tenant1',
    'https://as.example/tenant1/',
    'https://as.example/a/b/c',
    'https://as.example:8443/t?x=1#y',
    'https://as.example//evil',
    'http://localhost:3000/oauth',
    'https://as.example/a%20b',
    'nope',
    'foo:bar',
  ].map((u): Case => ({ args: [u] })),
}

// ---- auth over the scripted fetch ----

interface AuthCase {
  fetches?: FetchSpec[]
  /** the seed of the byte stream that stands for crypto.getRandomValues */
  seed?: number
  [key: string]: unknown
}

/** the bytes of the fake `crypto.getRandomValues`: a fixed walk through 0..255 */
function randomWalk(seed: number): (size: number) => Uint8Array {
  let state = seed
  return (size) => {
    const out = new Uint8Array(size)
    for (let i = 0; i < size; i++) {
      state = (state * 73 + 41) % 256
      out[i] = state
    }
    return out
  }
}

const authErr = (error: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = nameAndMessage(error)
  if (error instanceof OAuthError) {
    out.errorCode = error.errorCode
    out.errorUri = error.errorUri ?? null
    out.response = error.toResponseObject()
  }
  return out
}

async function runAuth(
  cfg: AuthCase,
  body: (fetchFn: typeof fetch, config: AuthCase) => Promise<unknown>,
): Promise<unknown> {
  const calls: unknown[][] = []
  const fetchFn = makeFetch(
    cfg.fetches ?? [],
    (...x) => calls.push(x),
    new StreamTable(),
  ) as typeof fetch
  const walk = randomWalk(cfg.seed ?? 1)
  const crypto = globalThis.crypto as unknown as { getRandomValues: (a: Uint8Array) => Uint8Array }
  const real = Object.getOwnPropertyDescriptor(crypto, 'getRandomValues')
  Object.defineProperty(crypto, 'getRandomValues', {
    configurable: true,
    writable: true,
    value: (array: Uint8Array) => {
      array.set(walk(array.length))
      return array
    },
  })
  try {
    return { calls, result: plain(await body(fetchFn, cfg)) }
  } catch (error) {
    return { calls, error: authErr(error) }
  } finally {
    if (real) Object.defineProperty(crypto, 'getRandomValues', real)
    else delete (crypto as { getRandomValues?: unknown }).getRandomValues
  }
}

const META = {
  issuer: 'https://as.example',
  authorization_endpoint: 'https://as.example/authorize',
  token_endpoint: 'https://as.example/token',
  registration_endpoint: 'https://as.example/register',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
}
const rm = (extra: Record<string, unknown> = {}) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    resource: 'https://a.example/mcp',
    authorization_servers: ['https://as.example'],
    ...extra,
  }),
})
const json = (value: unknown, status = 200, headers: Record<string, string> = {}): FetchSpec => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(value),
})
const nf: FetchSpec = { status: 404, body: 'not found' }

const serverInfoSpec: FnSpec = {
  ts: ([cfg]) =>
    runAuth(cfg as AuthCase, async (fetchFn, c) => {
      const options: { resourceMetadataUrl?: URL; fetchFn: typeof fetch } = { fetchFn }
      if (typeof c.resourceMetadataUrl === 'string')
        options.resourceMetadataUrl = new URL(c.resourceMetadataUrl)
      return sdkAuth.discoverOAuthServerInfo(c.serverUrl as string, options)
    }),
  cases: cases(
    [{ serverUrl: 'https://a.example/mcp', fetches: [rm(), json(META)] }],
    [{ serverUrl: 'https://a.example/mcp', fetches: [nf, nf, json(META)] }],
    [{ serverUrl: 'https://a.example/', fetches: [nf, nf, nf, nf] }],
    [
      {
        serverUrl: 'https://a.example/mcp',
        fetches: [rm({ authorization_servers: [] }), json(META)],
      },
    ],
    [
      {
        serverUrl: 'https://a.example/mcp?x=1',
        fetches: [
          rm(),
          { status: 404 },
          { status: 404 },
          json({
            ...META,
            jwks_uri: 'https://as.example/jwks',
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            revocation_endpoint: 'https://as.example/rev',
          }),
        ],
      },
    ],
    [
      {
        serverUrl: 'https://a.example/mcp',
        resourceMetadataUrl: 'https://a.example/.well-known/oauth-protected-resource/x',
        fetches: [rm(), json(META)],
      },
    ],
    [
      {
        serverUrl: 'https://a.example/mcp',
        resourceMetadataUrl: 'https://a.example/rm',
        fetches: [nf, json(META)],
      },
    ],
    [
      {
        serverUrl: 'https://a.example/mcp',
        fetches: [{ status: 500 }, { status: 404 }, { status: 404 }, { status: 404 }],
      },
    ],
    [{ serverUrl: 'https://a.example/mcp', fetches: [rm(), { status: 503 }] }],
    [{ serverUrl: 'https://a.example/mcp', fetches: [rm(), json({ nope: 1 })] }],
    [
      {
        serverUrl: 'https://a.example/mcp',
        fetches: [
          { reject: { typeError: true, message: 'fetch failed' } },
          { reject: { typeError: true, message: 'fetch failed' } },
          { reject: { typeError: true, message: 'fetch failed' } },
          { reject: { typeError: true, message: 'x' } },
          { reject: { typeError: true, message: 'x' } },
          { reject: { typeError: true, message: 'x' } },
          { reject: { typeError: true, message: 'x' } },
        ],
      },
    ],
    [
      {
        serverUrl: 'https://a.example/mcp',
        fetches: [rm(), { reject: { name: 'AbortError', message: 'The operation was aborted' } }],
      },
    ],
    [{ serverUrl: 'nope', fetches: [] }],
    [
      {
        serverUrl: 'https://a.example/mcp',
        fetches: [{ status: 200, body: 'not json' }, json(META)],
      },
    ],
    [
      {
        serverUrl: 'https://a.example/mcp',
        fetches: [rm({ authorization_servers: ['https://as.example/tenant'] }), nf, nf, json(META)],
      },
    ],
    [
      {
        serverUrl: 'https://a.example/mcp',
        fetches: [{ status: 302, headers: { location: '/rm' } }, rm(), json(META)],
      },
    ],
  ),
}

const resourceMetadataSpec: FnSpec = {
  ts: ([cfg]) =>
    runAuth(cfg as AuthCase, async (fetchFn, c) => {
      const opts: { resourceMetadataUrl?: string } = {}
      if (typeof c.resourceMetadataUrl === 'string')
        opts.resourceMetadataUrl = c.resourceMetadataUrl
      return sdkAuth.discoverOAuthProtectedResourceMetadata(c.serverUrl as string, opts, fetchFn)
    }),
  cases: cases(
    [{ serverUrl: 'https://a.example/mcp', fetches: [rm()] }],
    [
      {
        serverUrl: 'https://a.example/mcp/sub/path',
        fetches: [nf, rm({ scopes_supported: ['a', 'b'] })],
      },
    ],
    [{ serverUrl: 'https://a.example', fetches: [nf] }],
    [{ serverUrl: 'https://a.example/mcp', fetches: [{ status: 500 }] }],
    [{ serverUrl: 'https://a.example/mcp', fetches: [{ status: 403 }, { status: 500 }] }],
    [{ serverUrl: 'https://a.example/mcp', fetches: [rm({ resource: 'nope' })] }],
    [
      {
        serverUrl: 'https://a.example/mcp',
        resourceMetadataUrl: 'https://a.example/custom',
        fetches: [rm()],
      },
    ],
    [
      {
        serverUrl: 'https://a.example/mcp',
        resourceMetadataUrl: 'https://a.example/custom',
        fetches: [{ status: 404 }],
      },
    ],
    [
      {
        serverUrl: 'https://a.example/mcp?v=2',
        fetches: [{ reject: { typeError: true, message: 'x' } }, rm()],
      },
    ],
    [
      {
        serverUrl: 'https://a.example/mcp',
        fetches: [
          { reject: { typeError: true, message: 'x' } },
          { reject: { typeError: true, message: 'x' } },
          nf,
        ],
      },
    ],
    [{ serverUrl: 'https://a.example/mcp/', fetches: [rm()] }],
    [{ serverUrl: 'https://a.example/mcp', fetches: [{ status: 200, body: '' }] }],
    [{ serverUrl: 'https://a.example/mcp', fetches: [{ status: 200, body: '[]' }] }],
  ),
}

const serverMetadataSpec: FnSpec = {
  ts: ([cfg]) =>
    runAuth(cfg as AuthCase, async (fetchFn, c) =>
      sdkAuth.discoverAuthorizationServerMetadata(c.url as string, { fetchFn }),
    ),
  cases: cases(
    [{ url: 'https://as.example', fetches: [json(META)] }],
    [
      {
        url: 'https://as.example',
        fetches: [
          nf,
          json({
            ...META,
            jwks_uri: 'https://as.example/jwks',
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            extra: 1,
            revocation_endpoint: 'https://as.example/rev',
          }),
        ],
      },
    ],
    [
      {
        url: 'https://as.example/t1',
        fetches: [
          nf,
          nf,
          json({
            ...META,
            jwks_uri: 'https://as.example/jwks',
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
          }),
        ],
      },
    ],
    [{ url: 'https://as.example/t1/', fetches: [nf, nf, nf] }],
    [{ url: 'https://as.example', fetches: [{ status: 500 }] }],
    [{ url: 'https://as.example', fetches: [nf, { status: 502 }] }],
    [{ url: 'https://as.example', fetches: [json({ issuer: 'x' })] }],
    [{ url: 'https://as.example', fetches: [nf, json({ issuer: 'x' })] }],
    [
      {
        url: 'https://as.example',
        fetches: [{ reject: { typeError: true, message: 'x' } }, json(META)],
      },
    ],
    [
      {
        url: 'https://as.example',
        fetches: [
          { reject: { typeError: true, message: 'x' } },
          { reject: { typeError: true, message: 'x' } },
          { reject: { typeError: true, message: 'x' } },
          { reject: { typeError: true, message: 'x' } },
        ],
      },
    ],
    [{ url: 'https://as.example', fetches: [{ reject: { name: 'AbortError', message: 'stop' } }] }],
    [{ url: 'https://as.example', fetches: [{ status: 200, body: '{' }] }],
    [
      {
        url: 'https://as.example',
        fetches: [{ status: 302, headers: { location: 'https://evil.example/x' } }, json(META)],
      },
    ],
    [
      {
        url: 'https://as.example',
        fetches: [{ status: 301, headers: { location: '/meta' } }, json(META)],
      },
    ],
  ),
}

const CLIENT_METADATA = {
  client_name: 'SeuOffice',
  redirect_uris: ['http://127.0.0.1:5555/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}

const registerSpec: FnSpec = {
  ts: ([cfg]) =>
    runAuth(cfg as AuthCase, async (fetchFn, c) => {
      const options: Parameters<typeof sdkAuth.registerClient>[1] = {
        clientMetadata: c.clientMetadata as never,
        fetchFn,
      }
      if (c.metadata !== undefined) options.metadata = c.metadata as never
      if (c.scope !== undefined) options.scope = c.scope as string
      return sdkAuth.registerClient(c.url as string, options)
    }),
  cases: cases(
    [
      {
        url: 'https://as.example',
        metadata: META,
        clientMetadata: CLIENT_METADATA,
        fetches: [json({ client_id: 'cid', redirect_uris: CLIENT_METADATA.redirect_uris }, 201)],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        clientMetadata: CLIENT_METADATA,
        scope: 'read write',
        fetches: [
          json({
            redirect_uris: ['http://127.0.0.1:5555/callback'],
            client_id: 'cid',
            client_secret: 'sec',
            client_name: 'x',
            extra: 1,
          }),
        ],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        clientMetadata: { ...CLIENT_METADATA, scope: 'old' },
        scope: 'new',
        fetches: [json({ client_id: 'cid', redirect_uris: [] })],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        clientMetadata: { scope: 'old', a: 1 },
        scope: '',
        fetches: [json({ client_id: 'cid', redirect_uris: [] })],
      },
    ],
    [
      {
        url: 'https://as.example/base',
        clientMetadata: CLIENT_METADATA,
        fetches: [json({ client_id: 'cid', redirect_uris: [] })],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: { ...META, registration_endpoint: undefined },
        clientMetadata: CLIENT_METADATA,
        fetches: [],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        clientMetadata: CLIENT_METADATA,
        fetches: [json({ error: 'invalid_client_metadata', error_description: 'bad uri' }, 400)],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        clientMetadata: CLIENT_METADATA,
        fetches: [{ status: 500, body: 'oops' }],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        clientMetadata: CLIENT_METADATA,
        fetches: [json({ redirect_uris: [] })],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        clientMetadata: CLIENT_METADATA,
        fetches: [{ status: 201, body: 'nope' }],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        clientMetadata: CLIENT_METADATA,
        fetches: [{ reject: { typeError: true, message: 'fetch failed' } }],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        clientMetadata: CLIENT_METADATA,
        fetches: [
          { status: 307, headers: { location: '/reg2' } },
          json({ client_id: 'cid', redirect_uris: [] }),
        ],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: { ...META, registration_endpoint: 'nope' },
        clientMetadata: CLIENT_METADATA,
        fetches: [],
      },
    ],
  ),
}

const startSpec: FnSpec = {
  ts: ([cfg]) =>
    runAuth(cfg as AuthCase, async (_fetchFn, c) => {
      const options: Parameters<typeof sdkAuth.startAuthorization>[1] = {
        clientInformation: { client_id: (c.clientId as string) ?? 'cid' },
        redirectUrl: (c.redirectUrl as string) ?? 'http://127.0.0.1:5555/callback',
      }
      if (c.metadata !== undefined) options.metadata = c.metadata as never
      if (c.scope !== undefined) options.scope = c.scope as string
      if (c.state !== undefined) options.state = c.state as string
      if (c.resource !== undefined) options.resource = c.resource as string
      const out = await sdkAuth.startAuthorization(c.url as string, options)
      return { authorizationUrl: out.authorizationUrl.href, codeVerifier: out.codeVerifier }
    }),
  cases: cases(
    [{ url: 'https://as.example', metadata: META }],
    [
      {
        url: 'https://as.example',
        metadata: META,
        seed: 7,
        scope: 'read write',
        state: 'st4te',
        resource: 'https://a.example/mcp',
      },
    ],
    [{ url: 'https://as.example', metadata: META, seed: 200, scope: 'offline_access read' }],
    [{ url: 'https://as.example', metadata: META, seed: 3, scope: '' }],
    [{ url: 'https://as.example', seed: 11 }],
    [{ url: 'https://as.example/tenant', seed: 12, state: 'x y&z' }],
    [
      {
        url: 'https://as.example',
        metadata: {
          ...META,
          authorization_endpoint: 'https://as.example/authorize?audience=a&client_id=old&x=a+b%20c',
        },
        seed: 13,
      },
    ],
    [{ url: 'https://as.example', metadata: { ...META, response_types_supported: ['token'] } }],
    [
      {
        url: 'https://as.example',
        metadata: { ...META, code_challenge_methods_supported: ['plain'] },
      },
    ],
    [{ url: 'https://as.example', metadata: { ...META, code_challenge_methods_supported: [] } }],
    [
      {
        url: 'https://as.example',
        metadata: { ...META, code_challenge_methods_supported: undefined },
        seed: 5,
      },
    ],
    [{ url: 'https://as.example', metadata: { ...META, response_types_supported: undefined } }],
    [{ url: 'https://as.example', metadata: { ...META, authorization_endpoint: 'nope' } }],
    [
      {
        url: 'https://as.example',
        metadata: META,
        seed: 21,
        resource: 'https://a.example/',
        redirectUrl: 'http://localhost:1/cb?a=b',
      },
    ],
    [{ url: 'nope' }],
    [{ url: 'https://as.example', metadata: META, seed: 255, scope: 'a', clientId: 'ü client' }],
  ),
}

const CLIENT_INFO = { client_id: 'cid' }
const CLIENT_WITH_SECRET = { client_id: 'cid', client_secret: 'sec' }
const TOKENS = { access_token: 'at', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt' }

const exchangeSpec: FnSpec = {
  ts: ([cfg]) =>
    runAuth(cfg as AuthCase, async (fetchFn, c) => {
      const options: Parameters<typeof sdkAuth.exchangeAuthorization>[1] = {
        clientInformation: c.client as never,
        authorizationCode: (c.code as string) ?? 'code1',
        codeVerifier: (c.verifier as string) ?? 'ver',
        redirectUri: (c.redirectUri as string) ?? 'http://127.0.0.1:5555/callback',
        fetchFn,
      }
      if (c.metadata !== undefined) options.metadata = c.metadata as never
      if (c.resource !== undefined) options.resource = c.resource as string
      return sdkAuth.exchangeAuthorization(c.url as string, options)
    }),
  cases: cases(
    [{ url: 'https://as.example', metadata: META, client: CLIENT_INFO, fetches: [json(TOKENS)] }],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_WITH_SECRET,
        fetches: [json(TOKENS)],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: { ...META, token_endpoint_auth_methods_supported: ['client_secret_post'] },
        client: CLIENT_WITH_SECRET,
        fetches: [json(TOKENS)],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: { ...CLIENT_WITH_SECRET, token_endpoint_auth_method: 'client_secret_post' },
        resource: 'https://a.example/mcp',
        fetches: [json({ ...TOKENS, expires_in: '60', extra: 1 })],
      },
    ],
    [
      {
        url: 'https://as.example/base',
        client: CLIENT_INFO,
        code: 'a b&c',
        verifier: 'v/+=',
        fetches: [json({ access_token: 'x', token_type: 'bearer' })],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: { client_id: 'ü', client_secret: 'é' },
        fetches: [json(TOKENS)],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: { client_id: '€', client_secret: 's' },
        fetches: [],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: { ...META, token_endpoint_auth_methods_supported: ['client_secret_basic'] },
        client: { client_id: 'c', client_secret: '' },
        fetches: [],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_INFO,
        fetches: [
          json(
            { error: 'invalid_grant', error_description: 'expired', error_uri: 'https://e/x' },
            400,
          ),
        ],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_INFO,
        fetches: [json({ error: 'brand_new' }, 400)],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_INFO,
        fetches: [{ status: 502, body: '<html>bad gateway</html>' }],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_INFO,
        fetches: [json({ access_token: 5 })],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_INFO,
        fetches: [{ status: 200, body: '' }],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_INFO,
        fetches: [{ reject: { typeError: true, message: 'fetch failed' } }],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_INFO,
        fetches: [{ status: 307, headers: { location: '/token2' } }, json(TOKENS)],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_INFO,
        fetches: [{ status: 302, headers: { location: '/token2' } }],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: { ...META, token_endpoint: 'nope' },
        client: CLIENT_INFO,
        fetches: [],
      },
    ],
  ),
}

const refreshSpec: FnSpec = {
  ts: ([cfg]) =>
    runAuth(cfg as AuthCase, async (fetchFn, c) => {
      const options: Parameters<typeof sdkAuth.refreshAuthorization>[1] = {
        clientInformation: c.client as never,
        refreshToken: (c.refreshToken as string) ?? 'rt0',
        fetchFn,
      }
      if (c.metadata !== undefined) options.metadata = c.metadata as never
      if (c.resource !== undefined) options.resource = c.resource as string
      return sdkAuth.refreshAuthorization(c.url as string, options)
    }),
  cases: cases(
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_INFO,
        fetches: [json({ access_token: 'new', token_type: 'Bearer' })],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_INFO,
        fetches: [
          json({ access_token: 'new', token_type: 'Bearer', refresh_token: 'rt2', expires_in: 10 }),
        ],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_WITH_SECRET,
        resource: 'https://a.example/mcp',
        fetches: [json({ token_type: 'Bearer', refresh_token: 'rt3', access_token: 'n' })],
      },
    ],
    [
      {
        url: 'https://as.example',
        client: CLIENT_INFO,
        refreshToken: 'a b',
        fetches: [json({ access_token: 'n', token_type: 'x' })],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_INFO,
        fetches: [json({ error: 'invalid_grant', error_description: 'revoked' }, 400)],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_INFO,
        fetches: [json({ error: 'invalid_client' }, 401)],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_INFO,
        fetches: [json({ error: 'unauthorized_client', error_description: 'no' }, 400)],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_INFO,
        fetches: [json({ error: 'temporarily_unavailable' }, 503)],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_INFO,
        fetches: [{ status: 400, body: 'plain text' }],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_INFO,
        fetches: [{ reject: { name: 'AbortError', message: 'timeout' } }],
      },
    ],
    [
      {
        url: 'https://as.example',
        metadata: META,
        client: CLIENT_WITH_SECRET,
        fetches: [json({ access_token: 'a', token_type: 'b', refresh_token: 'keep' })],
      },
    ],
  ),
}

const ERROR_BODIES: Array<[number, string, Record<string, string>?]> = [
  [400, '{"error":"invalid_request","error_description":"bad","error_uri":"https://e/1"}'],
  [400, '{"error":"invalid_client"}'],
  [400, '{"error":"invalid_grant","error_description":""}'],
  [400, '{"error":"unauthorized_client","error_description":"x"}'],
  [400, '{"error":"unsupported_grant_type"}'],
  [400, '{"error":"invalid_scope","error_description":"s"}'],
  [403, '{"error":"access_denied"}'],
  [500, '{"error":"server_error","error_description":"boom"}'],
  [503, '{"error":"temporarily_unavailable"}'],
  [400, '{"error":"unsupported_response_type"}'],
  [400, '{"error":"unsupported_token_type"}'],
  [401, '{"error":"invalid_token"}'],
  [405, '{"error":"method_not_allowed"}'],
  [429, '{"error":"too_many_requests"}'],
  [400, '{"error":"invalid_client_metadata"}'],
  [403, '{"error":"insufficient_scope"}'],
  [400, '{"error":"invalid_target"}'],
  [400, '{"error":"made_up","error_description":"d"}'],
  [400, '{"error":"constructor","error_description":"d"}'],
  [400, '{"error":"toString"}'],
  [400, '{"error":"__proto__"}'],
  [400, '{"error":"hasOwnProperty","error_description":"x"}'],
  [400, '{"error":5}'],
  [400, '{"error_description":"x"}'],
  [400, '[]'],
  [400, 'not json'],
  [502, '<html>Bad gateway</html>'],
  [400, ''],
  [400, '{"error":"invalid_grant","extra":1}'],
  [302, '{"nope":1}', { location: 'https://b.example/x' }],
  [307, 'x', { location: '/y?z=1' }],
  [301, 'x'],
]

const errorResponseSpec: FnSpec = {
  ts: async ([status, body, headers, asText]) => {
    const input = asText
      ? (body as string)
      : new Response(body as string, {
          status: status as number,
          headers: (headers as Record<string, string> | undefined) ?? {},
        })
    const error = await sdkAuth.parseErrorResponse(input)
    return authErr(error)
  },
  cases: [
    ...ERROR_BODIES.map(([status, body, headers]): Case => ({
      args: [status, body, headers ?? {}, false],
    })),
    { args: [0, '{"error":"invalid_grant","error_description":"as text"}', {}, true] },
    { args: [0, 'plain text', {}, true] },
  ],
}

// ---------------------------------------------------------------------------
// the client over scripted transports
// ---------------------------------------------------------------------------

interface ScenarioStep {
  op: string
  id?: string
  timeout?: number
  signal?: string
  aborted?: unknown
  params?: unknown
  message?: unknown
  n?: number
  reason?: unknown
  stream?: number
  text?: Bytes
  name?: string
  typeError?: boolean
}

interface Scenario {
  url?: string
  clientInfo?: Record<string, unknown>
  fallback?: string
  toolsChanged?: boolean
  validator?: boolean
  failSends?: number[]
  fetches?: FetchSpec[]
  steps: ScenarioStep[]
}

type Transport =
  ConstructorParameters<typeof Client> extends never ? never : Parameters<Client['connect']>[0]

class ScriptedTransport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: never) => void
  closed = false
  sends = 0
  constructor(
    private readonly call: Log,
    private readonly failSends: number[],
  ) {}
  async start(): Promise<void> {}
  async send(message: unknown): Promise<void> {
    const index = this.sends++
    this.call('send', JSON.stringify(message))
    if (this.closed)
      throw new McpError(types.ErrorCode.ConnectionClosed, 'The server is not running')
    if (this.failSends.includes(index)) throw new Error('write failed')
  }
  async close(): Promise<void> {
    this.call('close')
    this.finish()
  }
  finish(): void {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }
}

/** a validator that checks `required` and counts what it compiles */
class FakeValidator {
  count = 0
  constructor(private readonly call: Log) {}
  getValidator(schema: Record<string, unknown>) {
    this.call('compile', schema)
    if (schema.bad === true) throw new Error('bad schema')
    this.count += 1
    const id = this.count
    return (input: unknown) => {
      this.call('validate', id, input)
      if (schema.throws === true) throw new Error('validator crashed')
      const required = (schema.required as string[] | undefined) ?? []
      const missing = required.find((key) => !(key in (input as Record<string, unknown>)))
      if (missing !== undefined) {
        return {
          valid: false as const,
          data: undefined,
          errorMessage: `must have required property '${missing}'`,
        }
      }
      return { valid: true as const, data: input, errorMessage: undefined }
    }
  }
}

function reasonOf(spec: unknown): unknown {
  if (spec === undefined || spec === null) return undefined
  const r = spec as {
    error?: { name: string; message: string }
    mcp?: { code: number; message: string }
  }
  if (r.error) return Object.assign(new Error(r.error.message), { name: r.error.name })
  if (r.mcp) return new McpError(r.mcp.code, r.mcp.message)
  return spec
}

type Kind = 'external' | 'streamable' | 'sse'

async function runScenario(kind: Kind, scenario: Scenario): Promise<unknown> {
  const out: Array<{ calls: unknown[][]; events: unknown[][] }> = []
  let current: { calls: unknown[][]; events: unknown[][] } = { calls: [], events: [] }
  const call: Log = (...x) => current.calls.push(x)
  const event: Log = (...x) => current.events.push(x)
  const streams = new StreamTable()
  const client = new Client(
    (scenario.clientInfo ?? { name: 'seuoffice', version: '1.0.0' }) as never,
    {
      capabilities: {},
      ...(scenario.validator ? { jsonSchemaValidator: new FakeValidator(call) as never } : {}),
    },
  )
  switch (scenario.fallback) {
    case 'methodNotFound':
      client.fallbackRequestHandler = async (request) => {
        event('fallback', request)
        throw new McpError(types.ErrorCode.MethodNotFound, `Method not found: ${request.method}`)
      }
      break
    case 'result':
      client.fallbackRequestHandler = async (request) => {
        event('fallback', request)
        return { ok: true } as never
      }
      break
    case 'undefined':
      client.fallbackRequestHandler = async (request) => {
        event('fallback', request)
        return undefined as never
      }
      break
    case 'throwPlain':
      client.fallbackRequestHandler = async (request) => {
        event('fallback', request)
        throw new Error('boom')
      }
      break
    case 'throwCode':
      client.fallbackRequestHandler = async (request) => {
        event('fallback', request)
        throw Object.assign(new Error('bad'), { code: 5, data: { a: 1 } })
      }
      break
    case 'throwBadCode':
      client.fallbackRequestHandler = async (request) => {
        event('fallback', request)
        throw Object.assign(new Error('x'), { code: 1.5 })
      }
      break
    case 'throwString':
      client.fallbackRequestHandler = async (request) => {
        event('fallback', request)
        throw 'just text'
      }
      break
    default:
      break
  }
  client.onerror = (error) => event('onerror', errInfo(error))
  client.onclose = () => event('onclose')
  if (scenario.toolsChanged) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, (n) => {
      event('notification', n)
    })
  }
  const url = new URL(scenario.url ?? 'https://example.com/mcp')
  const fetchFn = makeFetch(scenario.fetches ?? [], call, streams)
  let scripted: ScriptedTransport | undefined
  let streamable: StreamableHTTPClientTransport | undefined
  let transport: Transport
  if (kind === 'external') {
    scripted = new ScriptedTransport(call, scenario.failSends ?? [])
    transport = scripted as unknown as Transport
  } else if (kind === 'streamable') {
    streamable = new StreamableHTTPClientTransport(url, { fetch: fetchFn })
    transport = streamable as unknown as Transport
  } else {
    transport = new SSEClientTransport(url, { fetch: fetchFn }) as unknown as Transport
  }
  const controllers = new Map<string, AbortController>()
  const optionsOf = (step: ScenarioStep) => {
    const options: { timeout?: number; signal?: AbortSignal } = {}
    if (step.timeout !== undefined) options.timeout = step.timeout
    if (step.signal !== undefined) {
      let controller = controllers.get(step.signal)
      if (!controller) {
        controller = new AbortController()
        controllers.set(step.signal, controller)
        if (step.aborted !== undefined)
          controller.abort(reasonOf(step.aborted === true ? undefined : step.aborted))
      }
      options.signal = controller.signal
    }
    return options
  }
  const track = (id: string, promise: Promise<unknown>): void => {
    promise.then(
      (value) => event('settle', id, 'ok', plain(value)),
      (error: unknown) => event('settle', id, 'error', errInfo(error)),
    )
  }
  await withTimers(call, async (fire) => {
    for (const step of scenario.steps) {
      switch (step.op) {
        case 'connect':
          track(step.id ?? 'connect', client.connect(transport, optionsOf(step)))
          break
        case 'listTools':
          track(step.id ?? 'list', client.listTools(step.params as never, optionsOf(step)))
          break
        case 'callTool':
          track(
            step.id ?? 'call',
            client.callTool(step.params as never, undefined, optionsOf(step)),
          )
          break
        case 'ping':
          track(step.id ?? 'ping', client.ping(optionsOf(step)))
          break
        case 'message':
          try {
            scripted?.onmessage?.(types.JSONRPCMessageSchema.parse(step.message) as never)
          } catch (error) {
            event('parseError', errInfo(error))
          }
          break
        case 'raw':
          scripted?.onmessage?.(step.message as never)
          break
        case 'timer':
          fire(step.n ?? 1)
          break
        case 'abort':
          controllers.get(step.signal ?? '')?.abort(reasonOf(step.reason))
          break
        case 'close':
          client.close().catch((error: unknown) => event('closeError', errInfo(error)))
          break
        case 'transportClose':
          scripted?.finish()
          break
        case 'transportError':
          scripted?.onerror?.(new Error(step.text as string))
          break
        case 'chunk': {
          const entry = streams.entries.get(step.stream ?? 1)
          if (entry && !entry.closed)
            entry.controller.enqueue(new Uint8Array(bytesOf(step.text ?? '')))
          break
        }
        case 'end': {
          const entry = streams.entries.get(step.stream ?? 1)
          if (entry && !entry.closed) {
            entry.closed = true
            entry.controller.close()
          }
          break
        }
        case 'streamError': {
          const entry = streams.entries.get(step.stream ?? 1)
          if (entry && !entry.closed) {
            entry.closed = true
            const error = step.typeError
              ? new TypeError(step.text as string)
              : Object.assign(new Error(step.text as string), { name: step.name ?? 'Error' })
            entry.controller.error(error)
          }
          break
        }
        case 'terminate':
          if (streamable) {
            const target = streamable
            track(
              'terminate',
              target.terminateSession().then(() => undefined),
            )
          }
          break
        case 'session':
          event('session', streamable?.sessionId ?? null)
          break
        default:
          throw new Error(`no such step: ${step.op}`)
      }
      await settle()
      out.push(current)
      current = { calls: [], events: [] }
    }
  })
  return plain(out)
}

const INIT_OK = {
  protocolVersion: '2025-11-25',
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: 'srv', version: '1.2.3' },
  instructions: 'use me',
}
const result = (id: number, value: unknown) => ({ jsonrpc: '2.0', id, result: value })
const failure = (id: number, code: number, message: string, data?: unknown) => ({
  jsonrpc: '2.0',
  id,
  error: data === undefined ? { code, message } : { code, message, data },
})
const connectSteps = (init: unknown = INIT_OK): ScenarioStep[] => [
  { op: 'connect', id: 'c' },
  { op: 'message', message: result(0, init) },
]
const TOOLS_PAGE = {
  tools: [
    {
      name: 'echo',
      description: 'Echo',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    },
    {
      name: 'plain',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
      extra: 1,
    },
  ],
  nextCursor: 'p2',
}

const clientScenarios: Scenario[] = [
  { steps: connectSteps() },
  { steps: [...connectSteps({ ...INIT_OK, protocolVersion: '2024-11-05' })] },
  { steps: [...connectSteps({ ...INIT_OK, protocolVersion: '2023-01-01' })] },
  {
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'message', message: failure(0, -32603, 'cannot init', { why: 1 }) },
    ],
  },
  {
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'message', message: result(0, { protocolVersion: 5 }) },
    ],
  },
  {
    steps: [
      { op: 'connect', id: 'c', timeout: 500 },
      { op: 'timer', n: 1 },
    ],
  },
  {
    steps: [
      { op: 'connect', id: 'c', signal: 's' },
      { op: 'abort', signal: 's' },
    ],
  },
  { steps: [{ op: 'connect', id: 'c', signal: 's', aborted: true }] },
  {
    steps: [
      {
        op: 'connect',
        id: 'c',
        signal: 's',
        aborted: { error: { name: 'AbortError', message: 'stopped' } },
      },
    ],
  },
  { steps: [{ op: 'connect', id: 'c' }, { op: 'close' }] },
  { failSends: [0], steps: [{ op: 'connect', id: 'c' }] },
  {
    failSends: [1],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'message', message: result(0, INIT_OK) },
    ],
  },
  {
    steps: [
      ...connectSteps(),
      { op: 'listTools', id: 'l1' },
      { op: 'message', message: result(1, TOOLS_PAGE) },
      { op: 'listTools', id: 'l2', params: { cursor: 'p2' } },
      {
        op: 'message',
        message: result(2, { tools: [{ name: 'third', inputSchema: { type: 'object' } }] }),
      },
      { op: 'listTools', id: 'l3', params: {} },
      { op: 'message', message: failure(3, -32601, 'Method not found') },
      { op: 'listTools', id: 'l4' },
      { op: 'message', message: result(4, { tools: [{ name: 'x' }] }) },
    ],
  },
  {
    steps: [
      ...connectSteps(),
      { op: 'callTool', id: 'k1', params: { name: 'echo', arguments: { text: 'hi' } } },
      { op: 'message', message: result(1, { content: [{ type: 'text', text: 'hi' }] }) },
      { op: 'callTool', id: 'k2', params: { name: 'echo', arguments: {} } },
      {
        op: 'message',
        message: result(2, { content: [{ type: 'text', text: 'bad' }], isError: true, extra: [1] }),
      },
      { op: 'callTool', id: 'k3', params: { name: 'echo' } },
      { op: 'message', message: result(3, { content: [{ type: 'image' }] }) },
      { op: 'callTool', id: 'k4', params: { name: 'echo' } },
      { op: 'message', message: result(4, {}) },
      { op: 'callTool', id: 'k5', params: { name: 'echo' }, timeout: 1000 },
      { op: 'timer', n: 6 },
      { op: 'message', message: result(5, { content: [] }) },
    ],
  },
  {
    steps: [
      ...connectSteps(),
      { op: 'callTool', id: 'k1', params: { name: 'a' }, signal: 's' },
      { op: 'abort', signal: 's' },
      { op: 'message', message: result(1, { content: [] }) },
      { op: 'callTool', id: 'k2', params: { name: 'b' }, signal: 's2' },
      { op: 'message', message: result(2, { content: [] }) },
      { op: 'abort', signal: 's2', reason: { mcp: { code: -32001, message: 'custom' } } },
      { op: 'callTool', id: 'k3', params: { name: 'c' }, signal: 's3' },
      { op: 'abort', signal: 's3', reason: 'plain text' },
    ],
  },
  {
    steps: [
      ...connectSteps(),
      { op: 'callTool', id: 'k1', params: { name: 'a' }, timeout: 100 },
      { op: 'timer', n: 2 },
      { op: 'listTools', id: 'l' },
      { op: 'close' },
    ],
  },
  {
    failSends: [2],
    steps: [
      ...connectSteps(),
      { op: 'callTool', id: 'k1', params: { name: 'a' }, signal: 's' },
      { op: 'abort', signal: 's' },
    ],
  },
  {
    steps: [
      ...connectSteps(),
      { op: 'listTools', id: 'l' },
      { op: 'transportClose' },
      { op: 'listTools', id: 'after' },
      { op: 'message', message: result(1, TOOLS_PAGE) },
    ],
  },
  {
    fallback: 'methodNotFound',
    steps: [
      ...connectSteps(),
      {
        op: 'message',
        message: {
          jsonrpc: '2.0',
          id: 10,
          method: 'sampling/createMessage',
          params: { messages: [] },
        },
      },
      { op: 'message', message: { jsonrpc: '2.0', id: 'x', method: 'roots/list' } },
      { op: 'message', message: { jsonrpc: '2.0', id: 11, method: 'ping' } },
      {
        op: 'message',
        message: {
          jsonrpc: '2.0',
          id: 12,
          method: 'ping',
          params: { _meta: { progressToken: true } },
        },
      },
    ],
  },
  {
    steps: [
      ...connectSteps(),
      { op: 'message', message: { jsonrpc: '2.0', id: 10, method: 'elicitation/create' } },
      { op: 'message', message: { jsonrpc: '2.0', id: 11, method: 'ping', params: {} } },
    ],
  },
  ...['result', 'undefined', 'throwPlain', 'throwCode', 'throwBadCode', 'throwString'].map(
    (fallback): Scenario => ({
      fallback,
      steps: [
        ...connectSteps(),
        {
          op: 'message',
          message: { jsonrpc: '2.0', id: 3, method: 'custom/method', params: { a: 1 } },
        },
      ],
    }),
  ),
  {
    toolsChanged: true,
    steps: [
      ...connectSteps(),
      { op: 'message', message: { jsonrpc: '2.0', method: 'notifications/tools/list_changed' } },
      {
        op: 'message',
        message: {
          jsonrpc: '2.0',
          method: 'notifications/tools/list_changed',
          params: { _meta: { a: 1 } },
        },
      },
      {
        op: 'message',
        message: { jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: 5 },
      },
      {
        op: 'message',
        message: { jsonrpc: '2.0', method: 'notifications/resources/list_changed' },
      },
    ],
  },
  {
    steps: [
      ...connectSteps(),
      { op: 'message', message: { jsonrpc: '2.0', method: 'notifications/tools/list_changed' } },
      {
        op: 'message',
        message: {
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 1, reason: 'x' },
        },
      },
      { op: 'message', message: { jsonrpc: '2.0', method: 'notifications/cancelled' } },
      {
        op: 'message',
        message: {
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken: 9, progress: 1, extra: 1 },
        },
      },
      {
        op: 'message',
        message: { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 'a' } },
      },
      { op: 'transportError', text: 'pipe trouble' },
    ],
  },
  {
    steps: [
      ...connectSteps(),
      { op: 'message', message: result(99, {}) },
      { op: 'message', message: { jsonrpc: '2.0', id: '0', result: {} } },
      { op: 'message', message: failure(98, -1, 'nobody') },
      { op: 'raw', message: { nope: true } },
      { op: 'message', message: { jsonrpc: '2.0', id: 1, result: {}, extra: 1 } },
    ],
  },
  {
    steps: [
      ...connectSteps(),
      { op: 'listTools', id: 'l' },
      { op: 'message', message: result('1' as never, TOOLS_PAGE) },
    ],
  },
  {
    steps: [
      ...connectSteps(),
      { op: 'callTool', id: 'k', params: { name: 'a' } },
      {
        op: 'message',
        message: failure(1, -32042, 'elicit', { elicitations: [{ id: 1 }], other: 2 }),
      },
      { op: 'callTool', id: 'k2', params: { name: 'a' } },
      { op: 'message', message: failure(2, -32042, 'no elicitations', { other: 2 }) },
    ],
  },
  {
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'connect', id: 'again' },
      { op: 'message', message: result(0, INIT_OK) },
      { op: 'connect', id: 'again2' },
    ],
  },
  {
    steps: [
      { op: 'listTools', id: 'early' },
      { op: 'callTool', id: 'early2', params: { name: 'x' } },
      { op: 'close' },
    ],
  },
  { clientInfo: { name: 'é', version: '2', extra: [1] }, steps: [{ op: 'connect', id: 'c' }] },
  // tool metadata: output validators and the task refusal
  {
    validator: true,
    steps: [
      ...connectSteps(),
      { op: 'listTools', id: 'l' },
      {
        op: 'message',
        message: result(1, {
          tools: [
            {
              name: 'typed',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object', required: ['a'] },
            },
            { name: 'plain', inputSchema: { type: 'object' } },
            {
              name: 'crashy',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object', throws: true },
            },
            {
              name: 'needsTask',
              inputSchema: { type: 'object' },
              execution: { taskSupport: 'required' },
            },
            {
              name: 'maybeTask',
              inputSchema: { type: 'object' },
              execution: { taskSupport: 'optional' },
            },
          ],
        }),
      },
      { op: 'callTool', id: 'ok', params: { name: 'typed' } },
      { op: 'message', message: result(2, { content: [], structuredContent: { a: 1 } }) },
      { op: 'callTool', id: 'missing', params: { name: 'typed' } },
      { op: 'message', message: result(3, { content: [], structuredContent: { b: 1 } }) },
      { op: 'callTool', id: 'nostructured', params: { name: 'typed' } },
      { op: 'message', message: result(4, { content: [] }) },
      { op: 'callTool', id: 'iserror', params: { name: 'typed' } },
      { op: 'message', message: result(5, { content: [], isError: true }) },
      { op: 'callTool', id: 'untyped', params: { name: 'plain' } },
      { op: 'message', message: result(6, { content: [] }) },
      { op: 'callTool', id: 'crashy', params: { name: 'crashy' } },
      { op: 'message', message: result(7, { content: [], structuredContent: {} }) },
      { op: 'callTool', id: 'task', params: { name: 'needsTask' } },
      { op: 'callTool', id: 'taskOptional', params: { name: 'maybeTask' } },
      { op: 'message', message: result(8, { content: [] }) },
      { op: 'callTool', id: 'unknownTool', params: { name: 'other' } },
      { op: 'message', message: result(9, { content: [] }) },
      { op: 'callTool', id: 'noName', params: {} },
      { op: 'message', message: result(10, { content: [] }) },
    ],
  },
  {
    validator: true,
    steps: [
      ...connectSteps(),
      { op: 'listTools', id: 'l' },
      {
        op: 'message',
        message: result(1, {
          tools: [
            { name: 'good', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
            {
              name: 'bad',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object', bad: true },
            },
            { name: 'late', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
          ],
        }),
      },
      { op: 'callTool', id: 'k', params: { name: 'good' } },
      { op: 'message', message: result(2, { content: [] }) },
      { op: 'listTools', id: 'l2' },
      { op: 'message', message: result(3, { tools: [] }) },
      { op: 'callTool', id: 'k2', params: { name: 'good' } },
      { op: 'message', message: result(4, { content: [] }) },
    ],
  },
  {
    steps: [
      ...connectSteps({
        protocolVersion: '2025-03-26',
        capabilities: {},
        serverInfo: { name: 's', version: '1' },
      }),
      { op: 'ping', id: 'p' },
      { op: 'message', message: result(1, {}) },
      { op: 'ping', id: 'p2' },
      { op: 'message', message: result(2, { extra: 1 }) },
    ],
  },
]

const clientSpec: FnSpec = {
  ts: ([scenario]) => runScenario('external', scenario as Scenario),
  cases: clientScenarios.map((s): Case => ({ args: [s] })),
}

// ---- Streamable HTTP ----

const SSE_HEADERS = { 'content-type': 'text/event-stream' }
const JSON_HEADERS = { 'content-type': 'application/json' }
const sse = (...messages: unknown[]): string =>
  messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join('')
const jsonAnswer = (value: unknown, headers: Record<string, string> = {}): FetchSpec => ({
  status: 200,
  headers: { ...JSON_HEADERS, ...headers },
  body: JSON.stringify(value),
})
const accepted: FetchSpec = { status: 202 }
const initAnswer = (headers: Record<string, string> = {}): FetchSpec =>
  jsonAnswer(result(0, INIT_OK), { 'mcp-session-id': 'sess-1', ...headers })

const streamableScenarios: Scenario[] = [
  {
    fetches: [initAnswer(), accepted, { status: 405 }],
    steps: [{ op: 'connect', id: 'c' }, { op: 'session' }],
  },
  {
    fetches: [
      initAnswer(),
      accepted,
      { status: 200, headers: SSE_HEADERS, stream: true },
      jsonAnswer(result(1, TOOLS_PAGE)),
    ],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'listTools', id: 'l' },
    ],
  },
  {
    fetches: [
      {
        status: 200,
        headers: { ...SSE_HEADERS, 'mcp-session-id': 'abc' },
        body: sse(result(0, INIT_OK)),
      },
      accepted,
      { status: 405 },
      {
        status: 200,
        headers: SSE_HEADERS,
        body: sse(
          { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
          result(1, { content: [{ type: 'text', text: 'x' }] }),
        ),
      },
    ],
    toolsChanged: true,
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'callTool', id: 'k', params: { name: 'echo' } },
    ],
  },
  {
    fetches: [
      initAnswer(),
      accepted,
      { status: 405 },
      { status: 200, headers: SSE_HEADERS, stream: true },
    ],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'callTool', id: 'k', params: { name: 'echo' } },
      { op: 'chunk', stream: 1, text: 'event: message\nid: 1\ndata: ' },
      { op: 'chunk', stream: 1, text: JSON.stringify(result(1, { content: [] })) },
      { op: 'chunk', stream: 1, text: '\n\n' },
      { op: 'end', stream: 1 },
    ],
  },
  {
    fetches: [
      initAnswer(),
      accepted,
      { status: 200, headers: SSE_HEADERS, stream: true },
      { status: 200, headers: SSE_HEADERS, stream: true },
    ],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'chunk', stream: 1, text: 'retry: 2500\nid: e1\ndata: ' },
      {
        op: 'chunk',
        stream: 1,
        text: '{"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n',
      },
      { op: 'end', stream: 1 },
      { op: 'timer', n: 2 },
      {
        op: 'chunk',
        stream: 2,
        text: 'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"n":2}}\n\n',
      },
      { op: 'streamError', stream: 2, typeError: true, text: 'terminated' },
    ],
  },
  {
    fetches: [
      initAnswer(),
      accepted,
      { status: 200, headers: SSE_HEADERS, stream: true },
      { status: 500, statusText: 'Server Error' },
      { status: 200, headers: SSE_HEADERS, stream: true },
    ],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'end', stream: 1 },
      { op: 'timer', n: 2 },
      { op: 'timer', n: 3 },
      { op: 'end', stream: 2 },
    ],
  },
  {
    fetches: [
      initAnswer(),
      accepted,
      { status: 200, headers: SSE_HEADERS, stream: true },
      { reject: { typeError: true, message: 'fetch failed' } },
      { reject: { typeError: true, message: 'fetch failed' } },
    ],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'end', stream: 1 },
      { op: 'timer', n: 2 },
      { op: 'timer', n: 3 },
    ],
  },
  {
    fetches: [initAnswer(), accepted, { status: 200, headers: SSE_HEADERS, stream: true }],
    steps: [{ op: 'connect', id: 'c' }, { op: 'close' }],
  },
  {
    fetches: [initAnswer(), accepted, { status: 405 }, { status: 200 }],
    steps: [{ op: 'connect', id: 'c' }, { op: 'terminate' }, { op: 'session' }],
  },
  {
    fetches: [
      initAnswer(),
      accepted,
      { status: 405 },
      { status: 405 },
      { status: 404, statusText: 'Not Found' },
    ],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'terminate' },
      { op: 'session' },
      { op: 'terminate' },
      { op: 'session' },
    ],
  },
  {
    fetches: [
      initAnswer(),
      accepted,
      { status: 405 },
      { reject: { typeError: true, message: 'fetch failed' } },
    ],
    steps: [{ op: 'connect', id: 'c' }, { op: 'terminate' }, { op: 'session' }],
  },
  { fetches: [{ status: 404, body: 'no such endpoint' }], steps: [{ op: 'connect', id: 'c' }] },
  { fetches: [{ status: 405, body: '' }], steps: [{ op: 'connect', id: 'c' }] },
  {
    fetches: [{ status: 401, headers: { 'www-authenticate': 'Bearer realm="x"' }, body: 'denied' }],
    steps: [{ op: 'connect', id: 'c' }],
  },
  { fetches: [{ status: 400, body: '{"error":"bad"}' }], steps: [{ op: 'connect', id: 'c' }] },
  {
    fetches: [{ status: 200, headers: { 'content-type': 'text/plain' }, body: 'hello' }],
    steps: [{ op: 'connect', id: 'c' }],
  },
  { fetches: [{ status: 200, body: '{}' }], steps: [{ op: 'connect', id: 'c' }] },
  {
    fetches: [{ status: 200, headers: JSON_HEADERS, body: 'not json' }],
    steps: [{ op: 'connect', id: 'c' }],
  },
  {
    fetches: [jsonAnswer({ jsonrpc: '2.0', method: 'x', id: 'q' })],
    steps: [{ op: 'connect', id: 'c' }],
  },
  {
    fetches: [
      { reject: { typeError: true, message: 'fetch failed', cause: { message: 'ECONNREFUSED' } } },
    ],
    steps: [{ op: 'connect', id: 'c' }],
  },
  {
    fetches: [
      { status: 307, headers: { location: '/mcp2' } },
      initAnswer(),
      accepted,
      { status: 405 },
    ],
    steps: [{ op: 'connect', id: 'c' }],
  },
  {
    fetches: [{ status: 307, headers: { location: 'https://other.example/mcp' } }],
    steps: [{ op: 'connect', id: 'c' }],
  },
  {
    fetches: [{ status: 302, headers: { location: '/mcp2' } }],
    steps: [{ op: 'connect', id: 'c' }],
  },
  {
    fetches: [
      initAnswer(),
      accepted,
      { status: 405 },
      jsonAnswer([result(1, { content: [] }), { jsonrpc: '2.0', method: 'notifications/x' }]),
    ],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'callTool', id: 'k', params: { name: 'x' } },
    ],
  },
  {
    fetches: [initAnswer(), accepted, { status: 405 }, jsonAnswer([result(1, {}), { bad: 1 }])],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'callTool', id: 'k', params: { name: 'x' } },
    ],
  },
  {
    fetches: [
      initAnswer(),
      accepted,
      { status: 405 },
      {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(failure(1, -32000, 'server says no')),
      },
    ],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'callTool', id: 'k', params: { name: 'x' } },
    ],
  },
  {
    fetches: [initAnswer(), accepted, { status: 405 }, { status: 404, body: 'session gone' }],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'callTool', id: 'k', params: { name: 'x' } },
      { op: 'session' },
    ],
  },
  {
    fetches: [
      initAnswer({ 'mcp-session-id': 'second' }),
      accepted,
      { status: 405 },
      jsonAnswer(result(1, { content: [] }), { 'mcp-session-id': 'third' }),
    ],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'session' },
      { op: 'callTool', id: 'k', params: { name: 'x' } },
      { op: 'session' },
    ],
  },
  {
    fetches: [jsonAnswer(result(0, INIT_OK)), accepted, { status: 405 }, jsonAnswer(result(1, {}))],
    steps: [{ op: 'connect', id: 'c' }, { op: 'session' }, { op: 'ping', id: 'p' }],
  },
  {
    fetches: [
      jsonAnswer(result(0, { ...INIT_OK, protocolVersion: '2024-11-05' }), {
        'mcp-session-id': 's',
      }),
      accepted,
      { status: 405 },
      jsonAnswer(result(1, {})),
    ],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'ping', id: 'p' },
    ],
  },
  {
    fetches: [initAnswer(), { status: 200, headers: JSON_HEADERS, body: '' }, { status: 405 }],
    steps: [{ op: 'connect', id: 'c' }],
  },
  {
    fetches: [initAnswer(), { status: 500, body: 'init notification failed' }],
    steps: [{ op: 'connect', id: 'c' }],
  },
  {
    fetches: [
      initAnswer(),
      accepted,
      { status: 405 },
      { status: 200, headers: SSE_HEADERS, stream: true },
    ],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'listTools', id: 'l', timeout: 300 },
      { op: 'timer', n: 2 },
      { op: 'chunk', stream: 1, text: sse(result(1, { tools: [] })) },
    ],
  },
  {
    fetches: [
      initAnswer(),
      accepted,
      { status: 200, headers: SSE_HEADERS, stream: true },
      { status: 200, headers: SSE_HEADERS, stream: true },
    ],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'callTool', id: 'k', params: { name: 'x' }, signal: 's' },
      { op: 'abort', signal: 's' },
      { op: 'close' },
    ],
  },
  {
    fetches: [initAnswer(), accepted, { status: 200, headers: SSE_HEADERS, stream: true }],
    steps: [
      { op: 'connect', id: 'c' },
      {
        op: 'chunk',
        stream: 1,
        text: 'data: not json\n\ndata: {"jsonrpc":"2.0","id":5,"result":{}}\n\n',
      },
      { op: 'chunk', stream: 1, text: 'event: other\ndata: {"a":1}\n\n: keepalive\n\ndata:\n\n' },
    ],
  },
  {
    fetches: [initAnswer(), accepted, { status: 200, headers: SSE_HEADERS, stream: true }],
    steps: [
      { op: 'connect', id: 'c' },
      {
        op: 'chunk',
        stream: 1,
        text: {
          hex: '646174613a207b226a736f6e727063223a22322e30222c226d6574686f64223a226e6f74696669636174696f6e732f78222c22706172616d73223a7b2261223a22c3',
        },
      },
      { op: 'chunk', stream: 1, text: { hex: 'a9227d7d0a0a' } },
    ],
  },
  {
    fetches: [
      initAnswer(),
      accepted,
      { status: 405 },
      { status: 200, headers: SSE_HEADERS, body: sse(result(1, { content: [] })) },
      { status: 200, headers: SSE_HEADERS, body: 'id: p1\ndata:\n\n' },
      { status: 200, headers: SSE_HEADERS, stream: true },
    ],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'callTool', id: 'k', params: { name: 'x' } },
      { op: 'callTool', id: 'k2', params: { name: 'y' } },
      { op: 'timer', n: 2 },
    ],
  },
  {
    fetches: [{ status: 200, headers: JSON_HEADERS }],
    steps: [{ op: 'connect', id: 'c' }],
  },
]

const streamableSpec: FnSpec = {
  ts: ([scenario]) => runScenario('streamable', scenario as Scenario),
  cases: streamableScenarios.map((s): Case => ({ args: [s] })),
}

// ---- legacy SSE ----

const endpoint = (data: string): string => `event: endpoint\ndata: ${data}\n\n`
const sseOpen: FetchSpec = { status: 200, headers: SSE_HEADERS, stream: true }

const sseScenarios: Scenario[] = [
  {
    fetches: [sseOpen, accepted, accepted],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'chunk', stream: 1, text: endpoint('/messages?sessionId=1') },
      { op: 'chunk', stream: 1, text: sse(result(0, INIT_OK)) },
    ],
  },
  {
    fetches: [sseOpen, accepted, accepted, accepted],
    toolsChanged: true,
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'chunk', stream: 1, text: endpoint('/messages?sessionId=1') },
      { op: 'chunk', stream: 1, text: sse(result(0, INIT_OK)) },
      { op: 'listTools', id: 'l' },
      {
        op: 'chunk',
        stream: 1,
        text: sse(
          { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
          result(1, { tools: [] }),
        ),
      },
      { op: 'close' },
    ],
  },
  {
    fetches: [sseOpen],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'chunk', stream: 1, text: endpoint('https://evil.example/messages') },
    ],
  },
  {
    fetches: [sseOpen],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'chunk', stream: 1, text: endpoint('http://[bad') },
    ],
  },
  {
    fetches: [sseOpen, accepted],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'chunk', stream: 1, text: endpoint('//example.com:8443/x') },
    ],
  },
  { fetches: [{ status: 404, body: 'nope' }], steps: [{ op: 'connect', id: 'c' }] },
  { fetches: [{ status: 204 }], steps: [{ op: 'connect', id: 'c' }] },
  {
    fetches: [{ status: 200, headers: JSON_HEADERS, body: '{}' }],
    steps: [{ op: 'connect', id: 'c' }],
  },
  { fetches: [{ status: 200, headers: SSE_HEADERS }], steps: [{ op: 'connect', id: 'c' }] },
  {
    fetches: [{ status: 302, headers: { location: 'https://evil.example/sse' } }],
    steps: [{ op: 'connect', id: 'c' }],
  },
  {
    fetches: [{ status: 302, headers: { location: '/sse2' } }, sseOpen],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'chunk', stream: 1, text: endpoint('/m') },
    ],
  },
  {
    fetches: [
      { reject: { typeError: true, message: 'fetch failed', cause: { message: 'ECONNREFUSED' } } },
      sseOpen,
    ],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'timer', n: 1 },
      { op: 'chunk', stream: 1, text: endpoint('/m') },
    ],
  },
  {
    fetches: [{ reject: { name: 'AbortError', message: 'aborted' } }],
    steps: [{ op: 'connect', id: 'c' }],
  },
  {
    fetches: [sseOpen, sseOpen],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'chunk', stream: 1, text: 'retry: 1200\n' + endpoint('/m') },
      { op: 'end', stream: 1 },
      { op: 'timer', n: 1 },
      { op: 'chunk', stream: 2, text: endpoint('/m2') },
      { op: 'streamError', stream: 2, typeError: true, text: 'terminated' },
      { op: 'timer', n: 2 },
    ],
  },
  {
    fetches: [sseOpen],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'chunk', stream: 1, text: endpoint('/m') },
      { op: 'close' },
      { op: 'close' },
    ],
  },
  {
    fetches: [sseOpen, { status: 500, body: 'post failed' }],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'chunk', stream: 1, text: endpoint('/m') },
      { op: 'chunk', stream: 1, text: sse({ not: 'a message' }) },
    ],
  },
  {
    fetches: [sseOpen, { status: 500, body: 'post failed' }],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'chunk', stream: 1, text: endpoint('/m') },
    ],
  },
  {
    fetches: [sseOpen, { status: 307, headers: { location: '/elsewhere' } }, accepted],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'chunk', stream: 1, text: endpoint('/m') },
    ],
  },
  {
    fetches: [sseOpen, { status: 302, headers: { location: '/elsewhere' } }],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'chunk', stream: 1, text: endpoint('/m') },
    ],
  },
  {
    fetches: [sseOpen, { reject: { typeError: true, message: 'fetch failed' } }],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'chunk', stream: 1, text: endpoint('/m') },
    ],
  },
  {
    fetches: [sseOpen, accepted, accepted, accepted],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'chunk', stream: 1, text: endpoint('/m') },
      {
        op: 'chunk',
        stream: 1,
        text: sse(result(0, { ...INIT_OK, protocolVersion: '2024-11-05' })),
      },
      { op: 'ping', id: 'p' },
      { op: 'chunk', stream: 1, text: sse(result(1, {})) },
    ],
  },
  {
    fetches: [sseOpen],
    steps: [
      { op: 'connect', id: 'c' },
      { op: 'chunk', stream: 1, text: 'data: x\n\n' },
      { op: 'chunk', stream: 1, text: endpoint('/a') + endpoint('/b') },
    ],
  },
]

const sseSpec: FnSpec = {
  ts: ([scenario]) => runScenario('sse', scenario as Scenario),
  cases: sseScenarios.map((s): Case => ({ args: [s] })),
}

export const group: Group = {
  'mcp-sdk/stdio.readBuffer': bufferSpec,
  'mcp-sdk/stdio.serializeMessage': serializeSpec,
  'mcp-sdk/stdio.deserializeMessage': deserializeSpec,
  'mcp-sdk/types.safeParse': parseSpec,
  'mcp-sdk/mediaType.mediaTypeEssence': mediaTypeSpec,
  'mcp-sdk/event-source-parser.feed': parserSpec,
  'mcp-sdk/transport.isWithinOrigin': withinOriginSpec,
  'mcp-sdk/transport.unfollowedRedirect': unfollowedSpec,
  'mcp-sdk/transport.fetchWithinOrigin': fetchWithinOriginSpec,
  'mcp-sdk/auth.extractWWWAuthenticateParams': wwwAuthSpec,
  'mcp-sdk/auth-utils.checkResourceAllowed': resourceAllowedSpec,
  'mcp-sdk/auth-utils.resourceUrlFromServerUrl': resourceUrlSpec,
  'mcp-sdk/auth.selectClientAuthMethod': authMethodSpec,
  'mcp-sdk/auth.buildDiscoveryUrls': discoveryUrlsSpec,
  'mcp-sdk/auth.discoverOAuthServerInfo': serverInfoSpec,
  'mcp-sdk/auth.discoverOAuthProtectedResourceMetadata': resourceMetadataSpec,
  'mcp-sdk/auth.discoverAuthorizationServerMetadata': serverMetadataSpec,
  'mcp-sdk/auth.registerClient': registerSpec,
  'mcp-sdk/auth.startAuthorization': startSpec,
  'mcp-sdk/auth.exchangeAuthorization': exchangeSpec,
  'mcp-sdk/auth.refreshAuthorization': refreshSpec,
  'mcp-sdk/auth.parseErrorResponse': errorResponseSpec,
  'mcp-sdk/client.scenario': clientSpec,
  'mcp-sdk/streamable-http-client.scenario': streamableSpec,
  'mcp-sdk/sse-client.scenario': sseSpec,
}
