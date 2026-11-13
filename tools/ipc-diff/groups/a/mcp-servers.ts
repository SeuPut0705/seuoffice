/**
 * Group `a/mcp-servers`: the person's own MCP servers, Settings side
 * (`apps/shell/src/main/mcp-client/hub-ipc.ts`, started by `hub-app.ts`).
 *
 * The hub is started as the shell entry starts it: `mcpHub = startMcpHub({...})`
 * is the entry's own statement, run over the fake Electron. What Electron
 * would reach is stood in for, and the Rust probe's fakes
 * (`crates/shell-ipc/a/src/probe/mcp.rs`) answer the same way from the same
 * `hosts.a.mcp`:
 *
 * - `net.fetch`: the remote servers by address (`servers`: `{tools, instructions,
 *   initializeStatus, callText, callError, unreachable}`); an address that is
 *   not listed fails to connect. Each POST and DELETE is one log line
 *   `["net.fetch", method, url, <JSON-RPC method or null>]`
 * - `safeStorage`: `storage.available` (true by default), a reversible byte
 *   transform (XOR 0x5a)
 * - `app.getVersion()`: `version` (`9.9.9`)
 * - the shell window's `show`/`focus`/tab: `["shellWindow.showHomeTab"]`
 *
 * Servers are seeded in `userData/mcp-servers.json` with fixed ids, since an
 * added server gets a random one. Only remote servers are used: a program of
 * the PC is the OS's, not the hub's.
 */
import { HOME_CHANNELS } from '../../../../apps/shell/src/shared/home-api.ts'
import type { Call, Case, Group, LoadContext, View } from '../../types.ts'
import { entryStatements, runWith } from './lib/entry-source.ts'

type HubApp = typeof import('../../../../apps/shell/src/main/mcp-client/hub-app.ts')

const entryCode = entryStatements('apps/shell/src/main/index.ts', ['mcpHub = startMcpHub('])

interface ServerSpec {
  tools?: { name: string; description: string }[]
  instructions?: string
  initializeStatus?: number
  callText?: string
  callError?: boolean
  unreachable?: boolean
}

interface McpWorld {
  version?: string
  servers?: Record<string, ServerSpec>
  storage?: { available?: boolean }
}

/** `ServerNet` of the Rust probe: a streamable HTTP MCP server per address */
function fakeFetch(world: McpWorld, log: unknown[]) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    let rpc: { method?: string; id?: unknown; params?: Record<string, unknown> } | null = null
    if (method === 'POST') {
      try {
        rpc = JSON.parse(String(init?.body ?? '{}'))
      } catch {
        rpc = null
      }
    }
    if (method === 'POST' || method === 'DELETE') {
      log.push(['net.fetch', method, url, rpc?.method ?? null])
    }
    const spec = world.servers?.[url]
    if (!spec || spec.unreachable === true) throw new TypeError('fetch failed')
    if (method === 'DELETE') return new Response(null, { status: 200 })
    if (method !== 'POST') return new Response(null, { status: 405 })
    const name = rpc?.method ?? ''
    let result: Record<string, unknown>
    if (name === 'initialize') {
      if (spec.initializeStatus !== undefined) {
        return new Response('error', { status: spec.initializeStatus })
      }
      result = {
        protocolVersion: rpc?.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1' },
        ...(spec.instructions !== undefined ? { instructions: spec.instructions } : {}),
      }
    } else if (name === 'tools/list') {
      result = {
        tools: (spec.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: { type: 'object', properties: {} },
        })),
      }
    } else if (name === 'tools/call') {
      const tool = String((rpc?.params as { name?: unknown } | undefined)?.name ?? '')
      result = {
        content: [{ type: 'text', text: spec.callText ?? `called ${tool}` }],
        ...(spec.callError === true ? { isError: true } : {}),
      }
    } else {
      return new Response(null, { status: 202 })
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc?.id, result }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        ...(name === 'initialize' ? { 'mcp-session-id': 's1' } : {}),
      },
    })
  }
}

const xor = (bytes: Uint8Array): Buffer => Buffer.from(Array.from(bytes, (b) => b ^ 0x5a))

/** Loads the hub as the shell entry starts it, for a case */
export async function loadMcpHub(cx: LoadContext): Promise<void> {
  const hostsA = (cx.case.hosts?.a ?? {}) as { lang?: string; mcp?: McpWorld }
  const world = hostsA.mcp ?? {}
  cx.install({
    app: { ...cx.electron.app, getVersion: () => world.version ?? '9.9.9' },
    net: { fetch: fakeFetch(world, cx.electron.log) },
    safeStorage: {
      isEncryptionAvailable: () => world.storage?.available !== false,
      encryptString: (plain: string) => xor(Buffer.from(plain, 'utf8')),
      decryptString: (sealed: Uint8Array) => xor(sealed).toString('utf8'),
      getSelectedStorageBackend: () => 'gnome_libsecret',
    },
  })
  const hub = await cx.fresh<HubApp>('apps/shell/src/main/mcp-client/hub-app.ts')
  const views = cx.case.views ?? [{ view: 1, window: 1, surface: 'Shell' }]
  const main = views.find((v) => (v.surface ?? 'Shell') === 'Shell')
  const BrowserWindow = cx.electron.BrowserWindow as { fromId(id: number): unknown }
  runWith(entryCode, {
    startMcpHub: hub.startMcpHub,
    currentLang: () => hostsA.lang ?? 'ko',
    shellWindow: main ? BrowserWindow.fromId(main.window ?? main.view) : null,
    tabManager: { openHomeTab: () => void cx.electron.log.push(['shellWindow.showHomeTab']) },
    HOME_CHANNELS,
  })
}

export const DOCS_URL = 'https://example.test/mcp'
export const DOWN_URL = 'https://down.test/mcp'
export const BROKEN_URL = 'https://broken.test/mcp'

const remote = (id: string, name: string, url: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: 'remote',
  enabled: true,
  keepResultsInside: false,
  url,
  transport: 'auto',
  headers: {},
  oauth: null,
  instructions: null,
  pendingInstructions: null,
  tools: {},
  newTools: [],
  ...extra,
})

/** the seeded servers: ids are fixed so a case can name them */
export const seeded = {
  'userData/mcp-servers.json': JSON.stringify({
    version: 1,
    runtimes: {},
    servers: [
      remote('srv-docs', 'docs', DOCS_URL, { headers: { 'X-Key': 'plain-secret' } }),
      remote('srv-down', 'down', DOWN_URL),
      remote('srv-broken', 'broken', BROKEN_URL),
      remote('srv-off', 'off', 'https://off.test/mcp', { enabled: false }),
    ],
  }),
}

export const mcpWorld = (extra: McpWorld = {}) => ({
  a: {
    mcp: {
      servers: {
        [DOCS_URL]: {
          tools: [
            { name: 'echo', description: 'Echo it back' },
            { name: 'upper', description: 'Shout it' },
          ],
          instructions: 'Use these tools politely.',
        },
        [DOWN_URL]: { unreachable: true },
        [BROKEN_URL]: { initializeStatus: 500 },
      },
      ...extra,
    },
  },
})

export const views: View[] = [
  { view: 1, window: 1, surface: 'Shell' },
  { view: 2, window: 2, surface: 'Shell' },
  { view: 3, window: 3, surface: 'Docs' },
]

export const shell = (channel: string, ...args: unknown[]): Call => ({ channel, view: 1, args })
export const second = (channel: string, ...args: unknown[]): Call => ({ channel, view: 2, args })
export const editor = (channel: string, ...args: unknown[]): Call => ({ channel, view: 3, args })

const base = { views, files: seeded, hosts: mcpWorld() }
const FINGERPRINT = `sha256:${'0'.repeat(64)}`

const cases: Case[] = [
  {
    ...base,
    note: 'only the shell window answers; another shell window and an editor are refused',
    calls: [
      shell('mcp-servers:list'),
      second('mcp-servers:list'),
      second('mcp-servers:add', { name: 'x', kind: 'remote', url: 'https://x.test/mcp' }),
      second('mcp-servers:test', 'srv-docs'),
      second('mcp-servers:sign-in', 'srv-docs'),
      second('mcp-servers:planned-launch', 'srv-docs'),
      second('mcp-servers:answer-runtime-download', 'srv-docs', true),
      editor('mcp-servers:list'),
    ],
  },
  {
    ...base,
    note: 'a request that is not what Settings sends is malformed',
    calls: [
      shell('mcp-servers:add', 5),
      shell('mcp-servers:add', { name: 'x', kind: 'maybe' }),
      shell('mcp-servers:edit', 'srv-docs', 'patch'),
      shell('mcp-servers:edit', 5, {}),
      shell('mcp-servers:remove', 5),
      shell('mcp-servers:test', ''),
      shell('mcp-servers:sign-in', 5),
      shell('mcp-servers:cancel-sign-in', 5),
      shell('mcp-servers:approve-tool', 'srv-docs', 5),
      shell('mcp-servers:approve-instructions', null),
      shell('mcp-servers:approve-launch', 'srv-docs', 'sha256:short'),
      shell('mcp-servers:set-tool-permission', 'srv-docs', 'echo', 'sometimes'),
      shell('mcp-servers:set-keep-results-inside', 'srv-docs', 'yes'),
      shell('mcp-servers:set-enabled', 'srv-docs', 1),
      shell('mcp-servers:mark-tools-seen', {}),
      shell('mcp-servers:planned-launch', 5),
      shell('mcp-servers:answer-runtime-download', 'srv-docs', 'yes'),
      shell('mcp-servers:retry', 5),
      shell('mcp-servers:parse-paste', 5),
    ],
  },
  {
    ...base,
    note: 'a server that is not registered is not found',
    calls: [
      shell('mcp-servers:edit', 'nope', { name: 'x' }),
      shell('mcp-servers:remove', 'nope'),
      shell('mcp-servers:test', 'nope'),
      shell('mcp-servers:sign-in', 'nope'),
      shell('mcp-servers:approve-tool', 'nope', 'echo'),
      shell('mcp-servers:approve-instructions', 'nope'),
      shell('mcp-servers:approve-launch', 'nope', FINGERPRINT),
      shell('mcp-servers:set-tool-permission', 'nope', 'echo', 'always'),
      shell('mcp-servers:set-keep-results-inside', 'nope', true),
      shell('mcp-servers:set-enabled', 'nope', true),
      shell('mcp-servers:mark-tools-seen', 'nope'),
      shell('mcp-servers:planned-launch', 'nope'),
      shell('mcp-servers:answer-runtime-download', 'nope', true),
      shell('mcp-servers:retry', 'nope'),
    ],
  },
  {
    ...base,
    note: 'a name taken, one that is too odd, and the paste that is not a server',
    calls: [
      shell('mcp-servers:add', { name: 'docs', kind: 'remote', url: 'https://x.test/mcp' }),
      shell('mcp-servers:add', { name: '', kind: 'remote', url: 'https://x.test/mcp' }),
      shell('mcp-servers:add', { name: 'plain', kind: 'remote', url: 'http://192.0.2.1/mcp' }),
      shell('mcp-servers:add', { name: 'cmd', kind: 'local', command: '', args: [] }),
      shell('mcp-servers:edit', 'srv-docs', { name: 'down' }),
      shell('mcp-servers:parse-paste', 'not a server at all'),
      shell('mcp-servers:parse-paste', ''),
    ],
  },
  {
    ...base,
    note: 'edit, turn off and on, keep results inside: each is written and told to the windows',
    calls: [
      shell('mcp-servers:list'),
      shell('mcp-servers:edit', 'srv-docs', { name: 'documents' }),
      shell('mcp-servers:list'),
      shell('mcp-servers:set-keep-results-inside', 'srv-docs', true),
      shell('mcp-servers:set-enabled', 'srv-docs', false),
      shell('mcp-servers:set-enabled', 'srv-docs', true),
      shell('mcp-servers:edit', 'srv-off', { headers: { Authorization: 'Bearer top-secret' } }),
      shell('mcp-servers:edit', 'srv-off', { headers: { 'bad name': 'x' } }),
      shell('mcp-servers:list'),
    ],
  },
  {
    ...base,
    note: 'remove a server: the file loses it; remove it again',
    calls: [
      shell('mcp-servers:remove', 'srv-off'),
      shell('mcp-servers:remove', 'srv-off'),
      shell('mcp-servers:remove', 'srv-docs'),
      shell('mcp-servers:list'),
    ],
  },
  {
    ...base,
    note: 'test: the tools are listed; a server that is down, broken or off says why',
    calls: [
      shell('mcp-servers:test', 'srv-docs'),
      shell('mcp-servers:list'),
      shell('mcp-servers:test', 'srv-down'),
      shell('mcp-servers:test', 'srv-broken'),
      shell('mcp-servers:test', 'srv-off'),
      shell('mcp-servers:list'),
      shell('mcp-servers:retry', 'srv-down'),
    ],
  },
  {
    ...base,
    note: 'after a test: tool permissions, approvals and the new-tools mark',
    calls: [
      shell('mcp-servers:test', 'srv-docs'),
      shell('mcp-servers:set-tool-permission', 'srv-docs', 'echo', 'always'),
      shell('mcp-servers:set-tool-permission', 'srv-docs', 'upper', 'off'),
      shell('mcp-servers:set-tool-permission', 'srv-docs', 'missing', 'ask'),
      shell('mcp-servers:approve-tool', 'srv-docs', 'echo'),
      shell('mcp-servers:approve-tool', 'srv-docs', 'missing'),
      shell('mcp-servers:approve-instructions', 'srv-docs'),
      shell('mcp-servers:mark-tools-seen', 'srv-docs'),
      shell('mcp-servers:list'),
    ],
  },
  {
    ...base,
    note: 'a remote server has no program to launch or download for',
    calls: [
      shell('mcp-servers:planned-launch', 'srv-docs'),
      shell('mcp-servers:approve-launch', 'srv-docs', FINGERPRINT),
      shell('mcp-servers:answer-runtime-download', 'srv-docs', true),
      shell('mcp-servers:answer-runtime-download', 'srv-docs', false),
    ],
  },
  {
    ...base,
    note: 'cancelling a sign-in that is not under way is harmless; signing in to a server without one fails',
    calls: [
      shell('mcp-servers:cancel-sign-in', 'srv-docs'),
      shell('mcp-servers:cancel-sign-in', 'nope'),
      shell('mcp-servers:sign-in', 'srv-down'),
    ],
  },
  {
    ...base,
    note: 'without a way to seal secrets they stay out of the file; in English the failures are worded in English',
    hosts: { a: { ...mcpWorld({ storage: { available: false } }).a, lang: 'en' } },
    calls: [
      shell('mcp-servers:edit', 'srv-docs', { headers: { 'X-Key': 'other-secret' } }),
      shell('mcp-servers:test', 'srv-down'),
    ],
  },
]

export const group: Group = {
  batch: 'A',
  load: loadMcpHub,
  cases,
}
