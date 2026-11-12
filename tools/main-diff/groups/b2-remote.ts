/**
 * Group `b2-remote`: the remote address, image and permission modules of
 * packages/electron-utils (safe-remote-url, remote-image, remote-table,
 * fetch-image-bytes, generated-images, main-proxy, safe-external-url,
 * navigation-guard, renderer-scheme, permission-guard).
 *
 * The network is never touched. Both sides run against the same fake world,
 * a JSON value the case carries:
 *
 *   dns        host (as the gate normalizes it) to the addresses `lookup` answers,
 *              or 'reject' (the lookup fails), or 'abort' (the signal aborts while
 *              the lookup runs)
 *   routes     URL (exactly as it is requested) to the answer of `fetchImpl`: a
 *              response `{ status, headers, chunks, noBody, streamError }`, 'throw'
 *              (the transport throws) or 'abort-throw' (the signal aborts, then it
 *              throws); a list answers the first request with its first entry and
 *              so on, the last entry repeating
 *   signal     'none', 'live' (an AbortSignal that the world may abort) or 'aborted'
 *   mock       the transport is undici over a MockAgent (see World)
 *   dispatcher the global dispatcher: 'plain' (an Agent), `{ proxyHosts }` (declares
 *              that exactly those hostnames ride a proxy) or `{ symbols }` (an Agent
 *              that carries symbols with those descriptions, no declared routing)
 *   seeds      what the generated-image folder holds before the call
 *
 * TypeScript on the one side and Rust on the other write the same log lines:
 *   ['dns', host], ['fetch', url, headers, signal, pinned], ['cancel', url],
 *   ['close', url], ['sleep', ms], ['headersForHop', url, hop],
 *   ['microphoneOpen', id], and the Electron-object calls of the guards.
 * `pinned` is what the hop's Agent `lookup` answers for the request's host
 * (null where the hop is not pinned).
 */
import dnsPromises from 'node:dns/promises'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  Agent,
  EnvHttpProxyAgent,
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from 'undici'
import {
  isBlockedAddress,
  isFakeIpDnsArtifact,
  isSafeRemoteUrl,
  fetchWithSsrfGuard,
  pinnedLookup,
  resolveSafeRemoteTarget,
} from '../../../packages/electron-utils/src/safe-remote-url.ts'
import type { FetchWithSsrfGuardOptions } from '../../../packages/electron-utils/src/safe-remote-url.ts'
import {
  MAX_REMOTE_IMAGE_BYTES,
  ResponseTooLargeError,
  fetchRemoteImage,
  readBodyCapped,
  remoteImageHeaders,
} from '../../../packages/electron-utils/src/remote-image.ts'
import {
  MAX_REMOTE_TABLE_BYTES,
  MAX_REMOTE_TABLE_CELL_CHARS,
  MAX_REMOTE_TABLE_COLUMNS,
  MAX_REMOTE_TABLE_ROWS,
  REMOTE_TABLE_TIMEOUT_MS,
  detectDelimiter,
  fetchRemoteTable,
  parseDelimitedRow,
  parseDelimitedTable,
  parseHtmlTable,
} from '../../../packages/electron-utils/src/remote-table.ts'
import { fetchImageBytes } from '../../../packages/electron-utils/src/fetch-image-bytes.ts'
import {
  GENERATED_IMAGE_DIR,
  MAX_GENERATED_IMAGE_BYTES,
  readGeneratedImage,
  storeGeneratedImage,
} from '../../../packages/electron-utils/src/generated-images.ts'
import {
  createMainProcessProxyDispatcher,
  mergeNoProxy,
} from '../../../packages/electron-utils/src/main-proxy.ts'
import { safeExternalUrl } from '../../../packages/electron-utils/src/safe-external-url.ts'
import { installNavigationGuard } from '../../../packages/electron-utils/src/navigation-guard.ts'
import {
  DOCX_MEDIA_SCHEME_PRIVILEGE,
  MAX_RENDERER_QUERY_CHARS,
  MAX_RENDERER_QUERY_ENTRIES,
  RENDERER_SCHEME,
  RENDERER_SCHEME_PRIVILEGE,
  SLIDE_MEDIA_SCHEME_PRIVILEGE,
  rendererUrl,
  resolveRendererFile,
} from '../../../packages/electron-utils/src/renderer-scheme.ts'
import {
  appPageOf,
  installPermissionGuard,
  permissionAllowed,
  permissionCheckHandler,
  permissionRequestHandler,
} from '../../../packages/electron-utils/src/permission-guard.ts'
import type { Case, Group, TsContext } from '../types.ts'

// ---------------------------------------------------------------- the world

interface RespSpec {
  status: number
  headers?: Record<string, string>
  /** UTF-8 text, or `hex:...` for raw bytes; one stream chunk each */
  chunks?: string[]
  /** `new Response(null)` */
  noBody?: boolean
  /** the stream fails with this message once its chunks are read */
  streamError?: string
}
type Route = 'throw' | 'abort-throw' | RespSpec
interface Seed {
  text?: string
  hex?: string
  dir?: true
  mtimeMs?: number
}
interface World {
  tmpdir: string
  seeds?: Record<string, Seed>
  dns?: Record<string, { address: string; family: number }[] | 'reject' | 'abort'>
  routes?: Record<string, Route | Route[]>
  signal?: 'none' | 'live' | 'aborted'
  dispatcher?: 'plain' | { proxyHosts: string[] } | { symbols: string[] }
  /**
   * The transport is undici itself, over a MockAgent that answers from `routes`
   * (for the functions that take no `fetchImpl`). Every host rides that agent
   * (no pinning) and a hop logs only `['fetch', url]`; every URL asked for has a route.
   */
  mock?: true
}

const TMP = tmpdir()
const W = (world: Omit<World, 'tmpdir'> = {}): World => ({ tmpdir: TMP, ...world })
const IMAGE_DIR = GENERATED_IMAGE_DIR

const PUBLIC = [{ address: '93.184.216.34', family: 4 }]
const DNS: NonNullable<World['dns']> = {
  'example.com': PUBLIC,
  'img.example.com': [{ address: '93.184.216.35', family: 4 }],
  'cdn.example.net': [{ address: '93.184.216.36', family: 4 }],
  'xn--r8jz45g.jp': PUBLIC,
  'xn--fa-hia.de': PUBLIC,
  'internal.example': [{ address: '10.1.2.3', family: 4 }],
  'mixed.example': [PUBLIC[0]!, { address: '192.168.1.5', family: 4 }],
  'fake.example': [{ address: '198.18.0.7', family: 4 }],
  'v6.example': [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }],
  'v6private.example': [{ address: 'fd00::1', family: 6 }],
  'v4mapped.example': [{ address: '::ffff:10.0.0.1', family: 6 }],
  'fakev6.example': [{ address: '::ffff:198.18.0.1', family: 6 }],
  'dual.example': [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ],
  'weird-family.example': [{ address: '93.184.216.37', family: 5 }],
  'empty.example': [],
  'rejects.example': 'reject',
  'slow.example': 'abort',
}
const ok = (text: string, headers: Record<string, string> = {}): RespSpec => ({
  status: 200,
  headers,
  chunks: [text],
})
const redirect = (location: string | null, status = 302): RespSpec => ({
  status,
  headers: location === null ? {} : { location },
  chunks: ['moved'],
})

/** `null` is how a spec leaves an argument out */
const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined

const hex = (bytes: Uint8Array | ArrayBuffer): string =>
  Buffer.from(bytes as Uint8Array).toString('hex')
const bytesOfChunk = (chunk: string): Uint8Array =>
  chunk.startsWith('hex:') ? Buffer.from(chunk.slice(4), 'hex') : new TextEncoder().encode(chunk)

function makeResponse(spec: RespSpec, url: string, cx: TsContext): Response {
  let body: ReadableStream<Uint8Array> | null = null
  if (!spec.noBody) {
    const chunks = (spec.chunks ?? []).map(bytesOfChunk)
    let next = 0
    body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (next < chunks.length) controller.enqueue(chunks[next++]!)
          else if (spec.streamError !== undefined) controller.error(new Error(spec.streamError))
          else controller.close()
        },
        cancel() {
          cx.log('cancel', url)
        },
      },
      { highWaterMark: 0 },
    )
  }
  return new Response(body, { status: spec.status, headers: spec.headers ?? {} })
}

interface Env {
  controller: AbortController | undefined
  signal: AbortSignal | undefined
  fetchImpl: typeof fetch
}

function seedDir(world: World): string[] {
  const names = Object.keys(world.seeds ?? {})
  if (names.length === 0) return names
  const dir = join(world.tmpdir, 'seuoffice-ai-images')
  mkdirSync(dir, { recursive: true })
  for (const name of names) {
    const spec = world.seeds![name]!
    const path = join(dir, name)
    if (spec.dir) mkdirSync(path, { recursive: true })
    else
      writeFileSync(path, spec.hex !== undefined ? Buffer.from(spec.hex, 'hex') : (spec.text ?? ''))
    if (spec.mtimeMs !== undefined) utimesSync(path, spec.mtimeMs / 1000, spec.mtimeMs / 1000)
  }
  return names
}

function unseedDir(world: World, names: string[], extra: string[] = []): void {
  const dir = join(world.tmpdir, 'seuoffice-ai-images')
  for (const name of [...names, ...extra]) rmSync(join(dir, name), { recursive: true, force: true })
}

/** `$GEN` in an address is the `file:` URL of the generated-image folder */
const withGen = (text: unknown): unknown =>
  typeof text === 'string'
    ? text.split('$GEN').join(pathToFileURL(IMAGE_DIR).href.replace(/\/$/, ''))
    : text

/** runs `run` inside the world: the resolver, the transport, the global dispatcher and the folder are its */
async function inWorld<T>(
  world: World,
  cx: TsContext,
  run: (env: Env) => Promise<T>,
  options: { sleeps?: boolean } = {},
): Promise<T> {
  const controller = world.signal && world.signal !== 'none' ? new AbortController() : undefined
  if (world.signal === 'aborted') controller!.abort()
  const counters = new Map<string, number>()
  const fetchImpl = (async (url: string, init: Record<string, unknown> | undefined) => {
    const dispatcher = init?.dispatcher as
      { close: (...args: unknown[]) => unknown; [key: symbol]: unknown } | undefined
    let pinned: unknown = null
    if (dispatcher) {
      const key = Object.getOwnPropertySymbols(dispatcher).find((s) => s.description === 'options')!
      const connect = (dispatcher[key] as { connect: { lookup: (...args: unknown[]) => void } })
        .connect
      pinned = await new Promise((resolve) => {
        connect.lookup(new URL(url).hostname, { all: true }, (_err: unknown, addresses: unknown) =>
          resolve(addresses),
        )
      })
      const close = dispatcher.close.bind(dispatcher)
      dispatcher.close = (...args: unknown[]) => {
        // undici's promise form of close() calls close(callback) on itself: that
        // re-entry is not the caller's call and is not logged
        if (typeof args[0] !== 'function') cx.log('close', url)
        return close(...args)
      }
    }
    cx.log('fetch', url, init?.headers ?? null, init?.signal !== undefined, pinned)
    const entry = world.routes?.[url]
    const list = entry === undefined ? [] : Array.isArray(entry) ? entry : [entry]
    const at = counters.get(url) ?? 0
    counters.set(url, at + 1)
    const route = list[Math.min(at, list.length - 1)]
    if (route === undefined) throw new Error(`no route: ${url}`)
    if (route === 'throw') throw new Error(`transport down: ${url}`)
    if (route === 'abort-throw') {
      controller?.abort()
      throw new Error(`aborted: ${url}`)
    }
    return makeResponse(route, url, cx)
  }) as unknown as typeof fetch

  const realLookup = dnsPromises.lookup
  ;(dnsPromises as { lookup: unknown }).lookup = async (host: string) => {
    cx.log('dns', host)
    const answer = world.dns?.[host]
    if (answer === undefined || answer === 'reject') {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
    }
    if (answer === 'abort') {
      controller?.abort()
      return PUBLIC
    }
    return answer
  }
  syncBuiltinESMExports()

  const previousDispatcher = getGlobalDispatcher()
  const wanted = world.dispatcher ?? 'plain'
  if (wanted !== 'plain') {
    const agent = new Agent()
    if ('symbols' in wanted) {
      for (const description of wanted.symbols) {
        Object.defineProperty(agent, Symbol(description), { value: true })
      }
    } else {
      const hosts = wanted.proxyHosts
      const routing = (url: URL): boolean => hosts.includes(url.hostname)
      Object.defineProperty(agent, Symbol.for('seuoffice.dispatcher-proxy-routing'), {
        value: routing,
      })
    }
    setGlobalDispatcher(agent)
  }

  if (world.mock) {
    const agent = new MockAgent()
    agent.disableNetConnect()
    Object.defineProperty(agent, Symbol.for('seuoffice.dispatcher-proxy-routing'), {
      value: () => true,
    })
    for (const url of Object.keys(world.routes ?? {})) {
      const parsed = new URL(url)
      agent
        .get(parsed.origin)
        .intercept({ path: `${parsed.pathname}${parsed.search}`, method: 'GET' })
        .reply(() => {
          cx.log('fetch', url)
          const entry = world.routes![url]!
          const list = Array.isArray(entry) ? entry : [entry]
          const at = counters.get(url) ?? 0
          counters.set(url, at + 1)
          const route = list[Math.min(at, list.length - 1)]!
          if (route === 'throw' || route === 'abort-throw')
            throw new Error(`transport down: ${url}`)
          return {
            statusCode: route.status,
            data: Buffer.concat((route.chunks ?? []).map(bytesOfChunk)),
            responseOptions: { headers: route.headers ?? {} },
          }
        })
        .persist()
    }
    setGlobalDispatcher(agent)
  }

  const realSetTimeout = globalThis.setTimeout
  if (options.sleeps) {
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      // only the retry pause of remote-image.ts: undici sets timers of its own
      if ((new Error().stack ?? '').includes('remote-image')) cx.log('sleep', ms)
      return realSetTimeout(fn, 0)
    }) as unknown as typeof setTimeout
  }
  const seeded = seedDir(world)
  try {
    return await run({ controller, signal: controller?.signal, fetchImpl })
  } finally {
    unseedDir(world, seeded)
    globalThis.setTimeout = realSetTimeout
    setGlobalDispatcher(previousDispatcher)
    ;(dnsPromises as { lookup: unknown }).lookup = realLookup
    syncBuiltinESMExports()
  }
}

/** a response as the comparison prints it; its body is read to the end */
async function render(resp: Response | null): Promise<unknown> {
  if (resp === null) return null
  let body: string
  try {
    body = hex(await resp.arrayBuffer())
  } catch (error) {
    body = `error: ${(error as Error).message}`
  }
  return {
    status: resp.status,
    ok: resp.ok,
    contentType: resp.headers.get('content-type'),
    contentLength: resp.headers.get('content-length'),
    location: resp.headers.get('location'),
    body,
  }
}

const num = (value: unknown): number | undefined =>
  value === 'NaN'
    ? NaN
    : value === 'Infinity'
      ? Infinity
      : value === '-Infinity'
        ? -Infinity
        : (orUndefined(value as number | null) as number | undefined)

interface GuardOptions {
  maxRedirects?: number | string | null
  redirect?: string | null
  headers?: Record<string, string> | null
  /** hop number to the headers that hop gets; a hop not listed answers undefined */
  hopHeaders?: Record<string, Record<string, string>> | null
}

function guardOptions(
  options: GuardOptions | null | undefined,
  env: Env,
  cx: TsContext,
): FetchWithSsrfGuardOptions {
  const out: FetchWithSsrfGuardOptions = { fetchImpl: env.fetchImpl }
  const maxRedirects = num(options?.maxRedirects)
  if (maxRedirects !== undefined) out.maxRedirects = maxRedirects
  if (options?.redirect != null) out.redirect = options.redirect as 'manual'
  if (options?.headers != null) out.headers = options.headers
  if (options?.hopHeaders != null) {
    const table = options.hopHeaders
    out.headersForHop = (url, hop) => {
      cx.log('headersForHop', url, hop)
      return table[String(hop)]
    }
  }
  if (env.signal) out.signal = env.signal
  return out
}

// ------------------------------------------------------------------ helpers

type Spec = Group[string]
const caseOf = (args: unknown[], note?: string): Case => (note ? { args, note } : { args })

/** a constant: one answer */
const constant = (value: () => unknown): Spec => ({
  ts: () => value(),
  cases: [{ args: [] }],
  single: 'a constant',
})

const world = (a: unknown[], i: number): World => a[i] as World

// ------------------------------------------------------------- safe-remote-url

const IPS = [
  '',
  '0.0.0.0',
  '0.255.255.255',
  '1.0.0.0',
  '8.8.8.8',
  '9.255.255.255',
  '10.0.0.0',
  '10.255.255.255',
  '11.0.0.0',
  '100.63.255.255',
  '100.64.0.0',
  '100.127.255.255',
  '100.128.0.0',
  '126.255.255.255',
  '127.0.0.1',
  '127.255.255.255',
  '128.0.0.0',
  '169.253.255.255',
  '169.254.169.254',
  '169.255.0.0',
  '172.15.255.255',
  '172.16.0.0',
  '172.31.255.255',
  '172.32.0.0',
  '191.255.255.255',
  '192.0.0.1',
  '192.0.1.0',
  '192.0.2.1',
  '192.167.255.255',
  '192.168.0.1',
  '192.169.0.0',
  '198.17.255.255',
  '198.18.0.0',
  '198.19.255.255',
  '198.20.0.0',
  '223.255.255.255',
  '224.0.0.0',
  '239.255.255.255',
  '240.0.0.0',
  '255.255.255.255',
  '1.2.3',
  '1.2.3.4.5',
  '01.2.3.4',
  '1.2.3.256',
  ' 1.2.3.4',
  '1.2.3.4 ',
  '1.2.3.4\n',
  '0x7f.0.0.1',
  '2130706433',
  '::',
  '::1',
  '::2',
  '1::',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:8.8.8.8',
  '::ffff:0808:0808',
  '::ffff:10.0.0.1',
  '::ffff:a00:1',
  '0:0:0:0:0:ffff:10.0.0.1',
  '::10.0.0.1',
  '::8.8.8.8',
  '::0.0.0.1',
  '::1.2.3.4',
  '64:ff9b::1',
  '64:ff9b::8.8.8.8',
  '64:ff9c::1',
  'fc00::1',
  'fdff:ffff::',
  'fe00::1',
  'fe80::1',
  'febf::1',
  'fec0::1',
  'ff00::1',
  'ff02::1',
  '2001:db8::1',
  '2606:2800:220:1:248:1893:25c8:1946',
  'FE80::1',
  'fe80::1%eth0',
  'fe80::1%lo0',
  '2606:2800::1%zz',
  '::1%1',
  '1:2:3:4:5:6:7:8',
  '1:2:3:4:5:6:7::',
  '[::1]',
  'localhost',
  'example.com',
  '１２７.0.0.1',
  '::ffff:1.2.3',
  '::ffff:01.2.3.4',
  ':::',
  '1:::2',
  'g::1',
  '12345::1',
  '::ffff:198.18.0.1',
  '::ffff:198.17.0.1',
]

const RAW_URLS: (string | number | null)[] = [
  'http://example.com/',
  'https://example.com/a?b=c#d',
  'HTTP://EXAMPLE.COM/A',
  'http://example.com.',
  'http://example.com../',
  'http://EXAMPLE.com:8080/x',
  'http://example.com:80/',
  'http://example.com:99999/',
  'http://example.com:0/',
  'https://user:pw@example.com/',
  'http://\u4f8b\u3048.jp/',
  'http://xn--r8jz45g.jp/',
  'http://\uff25\uff38\uff21\uff2d\uff30\uff2c\uff25.com/',
  'http://fa\u00df.de/',
  'http://example\u3002com/',
  'http://exa\u00admple.com/',
  'http://%65xample.com/',
  'http://exa mple.com/',
  'http://exa_mple.com/',
  'ftp://example.com/',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'data:text/html,hi',
  'mailto:a@example.com',
  'http:example.com',
  'http:/\\example.com',
  'http:\\\\example.com',
  'http:///example.com',
  'http://',
  'http://:80/',
  'http://[::1',
  '//example.com/',
  '/relative',
  'example.com',
  '',
  ' http://example.com/ ',
  '\thttp://example.com/\n',
  'http://localhost/',
  'http://LOCALHOST/',
  'http://localhost./',
  'http://a.localhost/',
  'http://printer.local/',
  'http://svc.internal/',
  'http://svc.internal./',
  'http://notlocal/',
  'http://xlocalhost/',
  'http://127.0.0.1/',
  'http://127.1/',
  'http://0x7f.1/',
  'http://2130706433/',
  'http://0177.0.0.1/',
  'http://1.2.3/',
  'http://1.1.1.256/',
  'http://8.8.8.8/',
  'http://8.8.8.8./',
  'http://0.0.0.0/',
  'http://169.254.169.254/latest/meta-data/',
  'http://10.0.0.1:8080/',
  'http://192.168.1.1/',
  'http://[::1]/',
  'http://[::]/',
  'http://[::ffff:127.0.0.1]/',
  'http://[::ffff:8.8.8.8]/',
  'http://[2606:2800:220:1:248:1893:25c8:1946]/',
  'http://[fe80::1]/',
  'http://[fd00::1]:8080/',
  'http://[0:0:0:0:0:0:0:1]/',
  'http://[::127.0.0.1]/',
  'http://internal.example/',
  'http://mixed.example/',
  'http://fake.example/',
  'http://v6.example/',
  'http://v6private.example/',
  'http://v4mapped.example/',
  'http://fakev6.example/',
  'http://dual.example/',
  'http://weird-family.example/',
  'http://empty.example/',
  'http://rejects.example/',
  'http://unknown.example/',
  'http://slow.example/',
  42,
  null,
]

// ---------------------------------------------------------------- remote-image

// ----------------------------------------------------------------- main-proxy

const PROXY_ENV_KEYS = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'no_proxy',
  'NO_PROXY',
]
type ProxyEnvSpec = Partial<Record<(typeof PROXY_ENV_KEYS)[number], string>>

async function withEnv<T>(env: ProxyEnvSpec, run: () => Promise<T> | T): Promise<T> {
  const saved = PROXY_ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of PROXY_ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  try {
    return await run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** which of the agent's three dispatchers carries each URL */
function undiciChoices(agent: unknown, urls: string[]): string[] {
  const holder = agent as Record<symbol, { dispatch: unknown }>
  const symbol = (description: string): symbol =>
    Object.getOwnPropertySymbols(agent as object).find((s) => s.description === description)!
  const noProxy = symbol('no proxy agent')
  const http = symbol('http proxy agent')
  const https = symbol('https proxy agent')
  const dispatchKey = Object.getOwnPropertySymbols(EnvHttpProxyAgent.prototype).find(
    (s) => s.description === 'dispatch',
  )!
  let chosen: unknown
  for (const key of new Set([noProxy, http, https])) {
    holder[key]!.dispatch = () => {
      chosen = holder[key]
      return true
    }
  }
  return urls.map((url) => {
    chosen = undefined
    ;(agent as Record<symbol, (opts: unknown, handler: unknown) => unknown>)[dispatchKey]!(
      { origin: new URL(url).origin, path: '/' },
      {},
    )
    return chosen === holder[noProxy]
      ? 'noProxy'
      : chosen === holder[http]
        ? 'http'
        : chosen === holder[https]
          ? 'https'
          : '?'
  })
}

const PROXY_URLS = [
  'http://example.com/',
  'https://example.com/',
  'http://localhost/',
  'http://LOCALHOST:8080/',
  'http://127.0.0.1:3000/x',
  'https://[::1]/',
  'http://[::1]:8080/',
  'http://api.corp.com/',
  'https://api.corp.com:8443/',
  'http://corp.com/',
  'https://x.internal.test:443/',
  'http://a.b.test:8080/',
  'http://a.b.test/',
  'https://a.b.test:8080/',
  'http://192.168.0.5:80/',
  'http://example.com:0/',
]

const NO_PROXY_LISTS: (string | null)[] = [
  null,
  '',
  '*',
  ' * ',
  '.corp.com',
  '*.corp.com',
  'corp.com',
  '.corp.com:8443',
  'a.b.test:8080',
  'A.B.TEST:8080',
  'example.com , 192.168.0.5',
  'example.com\n.internal.test\t[::1]',
  ',,;',
  ':80',
  'a:b:8080',
  'example.com:0',
  'example.com:99999999999999999999999',
  '.',
  '**.corp.com',
  'localhost:8080',
  '\u00a0example.com\u00a0',
  'EXAMPLE.COM',
]

// --------------------------------------------------------- navigation / permission

interface ContentsScenario {
  url: string
  navigations: string[]
}

type Listener = (...args: never[]) => unknown

interface FrameSpec {
  url: string
  origin: string
  parent: number | null
}
interface ContentsSpec {
  id: number
  frames: FrameSpec[]
  /** index of the top frame; null for a webContents without one */
  main: number | null
  /** accesses that throw: 'mainFrame', 'subtree', 'url:i', 'origin:i', 'parent:i' */
  torn?: string[]
}
interface PagesSpec {
  devUrls?: Record<string, string | null> | null
  fileRoots?: Record<string, string> | null
}
interface PolicySpec {
  pages: PagesSpec
  micOpen: number[]
}

function policyOf(spec: PolicySpec, cx: TsContext) {
  return {
    pages: {
      ...(spec.pages.devUrls != null
        ? { devUrls: spec.pages.devUrls as Record<string, string | undefined> }
        : {}),
      ...(spec.pages.fileRoots != null ? { fileRoots: spec.pages.fileRoots } : {}),
    },
    microphoneOpen: (id: number): boolean => {
      cx.log('microphoneOpen', id)
      return spec.micOpen.includes(id)
    },
  }
}

function contentsOf(spec: ContentsSpec | null) {
  if (spec === null) return null
  const torn = new Set(spec.torn ?? [])
  const frames: Record<string, unknown>[] = spec.frames.map(() => ({}))
  spec.frames.forEach((frame, i) => {
    const object = frames[i]!
    const guarded = (key: string, value: () => unknown) =>
      Object.defineProperty(object, key, {
        get() {
          if (torn.has(`${key}:${i}`)) throw new Error('frame was torn down')
          return value()
        },
      })
    guarded('url', () => frame.url)
    guarded('origin', () => frame.origin)
    guarded('parent', () => (frame.parent === null ? null : frames[frame.parent]))
  })
  const contents: Record<string, unknown> = { id: spec.id }
  Object.defineProperty(contents, 'mainFrame', {
    get() {
      if (torn.has('mainFrame')) throw new Error('frame was torn down')
      if (spec.main === null) return undefined
      const top = frames[spec.main]!
      Object.defineProperty(top, 'framesInSubtree', {
        get() {
          if (torn.has('subtree')) throw new Error('frame was torn down')
          // every frame whose chain of parents reaches the top frame, itself included
          return spec.frames.flatMap((frame, i) => {
            for (let at: number | null = i; at !== null; at = spec.frames[at]!.parent) {
              if (at === spec.main) return [frames[i]]
            }
            return []
          })
        },
      })
      return top
    },
  })
  return contents as never
}

const POLICY: PolicySpec = {
  pages: {
    devUrls: { docs: 'http://localhost:5173/', shell: 'http://localhost:5174' },
    fileRoots: { shell: '/opt/seuoffice/shell' },
  },
  micOpen: [7],
}

const guardTarget = (a: unknown[]) => ({
  url: 'http://example.com/',
  hostname: 'example.com',
  literal: false,
  addresses: [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ],
  ...(a[0] as object),
})

const PIN_HOSTS = [
  'example.com',
  'EXAMPLE.com.',
  '[example.com]',
  'example.com..',
  'other.example',
  '',
  'exampl\u0065.com',
  'ex\u0131mple.com',
]
const PIN_OPTIONS: { all?: boolean; family?: number }[] = [
  {},
  { all: true },
  { family: 6 },
  { family: 4 },
  { family: 5 },
  { all: true, family: 6 },
  { all: false, family: 4 },
]

const GUARD_CASES: Case[] = [
  caseOf(
    ['http://example.com/', W({ dns: DNS, routes: { 'http://example.com/': ok('hello') } })],
    'a public host',
  ),
  caseOf(
    [
      'http://example.com/',
      W({ dns: DNS, routes: { 'http://example.com/': ok('hello') }, signal: 'live' }),
    ],
    'a live signal rides along',
  ),
  caseOf(
    [
      'https://img.example.com/a.png',
      W({ dns: DNS, routes: { 'https://img.example.com/a.png': { status: 404, chunks: ['no'] } } }),
    ],
    'a 404 is handed back',
  ),
  caseOf(
    ['http://127.0.0.1/', W({ dns: DNS, routes: { 'http://127.0.0.1/': ok('x') } })],
    'loopback literal is refused',
  ),
  caseOf(
    ['http://8.8.8.8/', W({ routes: { 'http://8.8.8.8/': ok('x') } })],
    'a public literal is not pinned',
  ),
  caseOf(
    [
      'http://[2606:2800:220:1:248:1893:25c8:1946]/',
      W({ routes: { 'http://[2606:2800:220:1:248:1893:25c8:1946]/': ok('x') } }),
    ],
    'an IPv6 literal',
  ),
  caseOf(
    ['http://internal.example/', W({ dns: DNS, routes: { 'http://internal.example/': ok('x') } })],
    'a host that resolves to a private address',
  ),
  caseOf(
    ['http://mixed.example/', W({ dns: DNS, routes: { 'http://mixed.example/': ok('x') } })],
    'one private address among the answers',
  ),
  caseOf(
    ['http://fake.example/', W({ dns: DNS, routes: { 'http://fake.example/': ok('x') } })],
    'a fake-ip answer is allowed',
  ),
  caseOf(
    ['http://dual.example/', W({ dns: DNS, routes: { 'http://dual.example/': ok('x') } })],
    'both families pinned',
  ),
  caseOf(
    ['http://example.com/', W({ dns: DNS, routes: {} })],
    'the transport throws for a URL it has no route for',
  ),
  caseOf(
    ['http://example.com/', W({ dns: DNS, routes: { 'http://example.com/': 'throw' } })],
    'the transport throws',
  ),
  caseOf(
    [
      'http://example.com/',
      W({ dns: DNS, routes: { 'http://example.com/': 'throw' }, signal: 'live' }),
    ],
    'a throw with a live signal that is not aborted is rethrown',
  ),
  caseOf(
    [
      'http://example.com/',
      W({ dns: DNS, routes: { 'http://example.com/': 'abort-throw' }, signal: 'live' }),
    ],
    'a throw after an abort is null',
  ),
  caseOf(
    [
      'http://example.com/',
      W({ dns: DNS, routes: { 'http://example.com/': ok('x') }, signal: 'aborted' }),
    ],
    'aborted before the first hop',
  ),
  caseOf(
    [
      'http://slow.example/',
      W({ dns: DNS, routes: { 'http://slow.example/': ok('x') }, signal: 'live' }),
    ],
    'aborted during the lookup',
  ),
  caseOf(
    ['http://slow.example/', W({ dns: DNS, routes: { 'http://slow.example/': ok('x') } })],
    'the same lookup without a signal',
  ),
  // redirects
  caseOf(
    [
      'http://example.com/a',
      W({
        dns: DNS,
        routes: {
          'http://example.com/a': redirect('http://img.example.com/b'),
          'http://img.example.com/b': ok('end'),
        },
      }),
    ],
    'a redirect is followed and its body cancelled',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({
        dns: DNS,
        routes: {
          'http://example.com/a': redirect('/b?x=1#f'),
          'http://example.com/b?x=1#f': ok('end'),
        },
      }),
    ],
    'a relative Location',
  ),
  caseOf(
    [
      'http://example.com/dir/a',
      W({
        dns: DNS,
        routes: {
          'http://example.com/dir/a': redirect('b'),
          'http://example.com/dir/b': ok('end'),
        },
      }),
    ],
    'a Location relative to the directory',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({
        dns: DNS,
        routes: {
          'http://example.com/a': redirect('//cdn.example.net/x'),
          'http://cdn.example.net/x': ok('end'),
        },
      }),
    ],
    'a scheme-relative Location',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({
        dns: DNS,
        routes: {
          'http://example.com/a': redirect('http://127.0.0.1/secret'),
          'http://127.0.0.1/secret': ok('secret'),
        },
      }),
    ],
    'a public host that bounces to loopback',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({
        dns: DNS,
        routes: {
          'http://example.com/a': redirect('http://internal.example/'),
          'http://internal.example/': ok('secret'),
        },
      }),
    ],
    'a bounce to a private resolution',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({ dns: DNS, routes: { 'http://example.com/a': redirect('file:///etc/passwd') } }),
    ],
    'a bounce to a file URL',
  ),
  caseOf(
    ['http://example.com/a', W({ dns: DNS, routes: { 'http://example.com/a': redirect(null) } })],
    'no Location',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({
        dns: DNS,
        routes: { 'http://example.com/a': { status: 302, headers: { location: '' }, chunks: [] } },
      }),
    ],
    'an empty Location',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({
        dns: DNS,
        routes: {
          'http://example.com/a': {
            status: 301,
            headers: { location: 'http://[::1' },
            noBody: true,
          },
        },
      }),
    ],
    'a Location that does not parse',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({
        dns: DNS,
        routes: {
          'http://example.com/a': {
            status: 307,
            headers: { location: 'http://example.com/b' },
            noBody: true,
          },
          'http://example.com/b': ok('end'),
        },
      }),
    ],
    'a redirect without a body',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({
        dns: DNS,
        routes: {
          'http://example.com/a': {
            status: 399,
            headers: { location: 'http://example.com/b' },
            chunks: ['x'],
          },
          'http://example.com/b': ok('end'),
        },
      }),
    ],
    '399 is a redirect',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({
        dns: DNS,
        routes: {
          'http://example.com/a': {
            status: 400,
            headers: { location: 'http://example.com/b' },
            chunks: ['x'],
          },
          'http://example.com/b': ok('end'),
        },
      }),
    ],
    '400 is not',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({ dns: DNS, routes: { 'http://example.com/a': { status: 299, chunks: ['x'] } } }),
    ],
    '299 is handed back',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({ dns: DNS, routes: { 'http://example.com/a': redirect('http://example.com/a') } }),
    ],
    'a redirect loop runs out of hops',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({ dns: DNS, routes: { 'http://example.com/a': redirect('http://example.com/a') } }),
      { maxRedirects: 0 },
    ],
    'no hops to follow',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({ dns: DNS, routes: { 'http://example.com/a': redirect('http://example.com/a') } }),
      { maxRedirects: 1 },
    ],
    'one hop',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({ dns: DNS, routes: { 'http://example.com/a': redirect('http://example.com/a') } }),
      { maxRedirects: 1.9 },
    ],
    'a fractional budget is floored',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({ dns: DNS, routes: { 'http://example.com/a': redirect('http://example.com/a') } }),
      { maxRedirects: -3 },
    ],
    'a negative budget is zero',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({ dns: DNS, routes: { 'http://example.com/a': redirect('http://example.com/a') } }),
      { maxRedirects: 100 },
    ],
    'a budget over ten is ten',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({ dns: DNS, routes: { 'http://example.com/a': redirect('http://example.com/a') } }),
      { maxRedirects: 'Infinity' },
    ],
    'an infinite budget is five',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({ dns: DNS, routes: { 'http://example.com/a': redirect('http://example.com/a') } }),
      { maxRedirects: 'NaN' },
    ],
    'NaN is five',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({ dns: DNS, routes: { 'http://example.com/a': redirect('http://example.com/a') } }),
      { maxRedirects: '-Infinity' },
    ],
    'minus infinity is five',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({
        dns: DNS,
        routes: {
          'http://example.com/a': [
            redirect('http://example.com/a'),
            redirect('http://example.com/a'),
            ok('third'),
          ],
        },
      }),
      { maxRedirects: 2 },
    ],
    'the hop that fits the budget answers',
  ),
  // manual
  caseOf(
    [
      'http://example.com/a',
      W({ dns: DNS, routes: { 'http://example.com/a': redirect('http://example.com/b') } }),
      { redirect: 'manual' },
    ],
    'manual hands the redirect back',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({ dns: DNS, routes: { 'http://example.com/a': ok('x') } }),
      { redirect: 'manual' },
    ],
    'manual with an ordinary answer',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({ dns: DNS, routes: { 'http://example.com/a': redirect('http://example.com/b') } }),
      { redirect: 'follow' },
    ],
    'follow',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({
        dns: DNS,
        routes: {
          'http://example.com/a': redirect('http://example.com/b'),
          'http://example.com/b': ok('x'),
        },
      }),
      { redirect: 'MANUAL' },
    ],
    'only the exact word is manual',
  ),
  // headers
  caseOf(
    [
      'http://example.com/',
      W({ dns: DNS, routes: { 'http://example.com/': ok('x') } }),
      { headers: { 'X-One': '1', Accept: 'text/html' } },
    ],
    'headers',
  ),
  caseOf(
    [
      'http://example.com/',
      W({ dns: DNS, routes: { 'http://example.com/': ok('x') } }),
      { headers: {} },
    ],
    'empty headers are still headers',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({
        dns: DNS,
        routes: {
          'http://example.com/a': redirect('http://img.example.com/b'),
          'http://img.example.com/b': ok('end'),
        },
      }),
      { headers: { A: '1' }, hopHeaders: { '1': { B: '2' } } },
    ],
    'headers for the second hop only',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({
        dns: DNS,
        routes: {
          'http://example.com/a': redirect('http://img.example.com/b'),
          'http://img.example.com/b': ok('end'),
        },
      }),
      { hopHeaders: { '0': {}, '1': { B: '2' } } },
    ],
    'an empty hop answer replaces the headers',
  ),
  caseOf(
    ['http://127.0.0.1/', W({ routes: {} }), { hopHeaders: { '0': { B: '2' } } }],
    'the callback is not asked for a refused hop',
  ),
  // the proxy
  caseOf(
    [
      'http://example.com/',
      W({
        dns: DNS,
        routes: { 'http://example.com/': ok('x') },
        dispatcher: { proxyHosts: ['example.com'] },
      }),
    ],
    'a hop the proxy carries is not pinned',
  ),
  caseOf(
    [
      'http://example.com/',
      W({
        dns: DNS,
        routes: { 'http://example.com/': ok('x') },
        dispatcher: { proxyHosts: ['other.example'] },
      }),
    ],
    'a declared routing that exempts the host',
  ),
  caseOf(
    [
      'http://example.com/',
      W({
        dns: DNS,
        routes: { 'http://example.com/': ok('x') },
        dispatcher: { symbols: ['proxy agent'] },
      }),
    ],
    'a bare ProxyAgent',
  ),
  caseOf(
    [
      'http://example.com/',
      W({
        dns: DNS,
        routes: { 'http://example.com/': ok('x') },
        dispatcher: { symbols: ['unrelated', 'proxy agent options'] },
      }),
    ],
    'a dispatcher with the options symbol',
  ),
  caseOf(
    [
      'http://example.com/',
      W({
        dns: DNS,
        routes: { 'http://example.com/': ok('x') },
        dispatcher: { symbols: ['unrelated'] },
      }),
    ],
    'a dispatcher with none of the symbols',
  ),
  caseOf(
    [
      'http://8.8.8.8/',
      W({ routes: { 'http://8.8.8.8/': ok('x') }, dispatcher: { proxyHosts: ['8.8.8.8'] } }),
    ],
    'a literal never asks the dispatcher',
  ),
  caseOf(
    [
      'http://example.com/a',
      W({
        dns: DNS,
        routes: {
          'http://example.com/a': redirect('http://img.example.com/b'),
          'http://img.example.com/b': ok('end'),
        },
        dispatcher: { proxyHosts: ['img.example.com'] },
      }),
    ],
    'the proxy takes the second hop only',
  ),
  // response shape
  caseOf(
    [
      'http://example.com/',
      W({
        dns: DNS,
        routes: {
          'http://example.com/': {
            status: 200,
            headers: { 'content-type': 'text/csv', 'content-length': '3' },
            chunks: ['a,b'],
          },
        },
      }),
    ],
    'headers of the answer',
  ),
  caseOf(
    [
      'http://example.com/',
      W({
        dns: DNS,
        routes: {
          'http://example.com/': { status: 200, chunks: ['one', 'two'], streamError: 'reset' },
        },
      }),
    ],
    'a body that fails when read',
  ),
  caseOf(
    ['HTTP://EXAMPLE.COM/X', W({ dns: DNS, routes: { 'HTTP://EXAMPLE.COM/X': ok('x') } })],
    'the URL is requested as it was given',
  ),
  caseOf(
    ['http://example.com/a b', W({ dns: DNS, routes: { 'http://example.com/a b': ok('x') } })],
    'a URL that needs escaping',
  ),
]

const BODY_CASES: Case[] = [
  caseOf([ok('hello'), 10]),
  caseOf([ok('hello'), 5], 'exactly the cap'),
  caseOf([ok('hello'), 4], 'a byte over'),
  caseOf([{ status: 200, chunks: ['ab', 'cd', 'ef'] }, 5], 'the cap is passed by the third chunk'),
  caseOf([{ status: 200, chunks: ['ab', 'cd', 'ef'] }, 6], 'three chunks'),
  caseOf([{ status: 200, chunks: ['a'] }, 6], 'one chunk'),
  caseOf([{ status: 200, chunks: [] }, 6], 'no chunk'),
  caseOf(
    [{ status: 200, headers: { 'content-length': '100' }, chunks: ['ab'] }, 50],
    'a declared length over the cap is refused unread',
  ),
  caseOf(
    [{ status: 200, headers: { 'content-length': '50' }, chunks: ['ab'] }, 50],
    'a declared length at the cap',
  ),
  caseOf(
    [{ status: 200, headers: { 'content-length': '2' }, chunks: ['abcdef'] }, 4],
    'a header that lies',
  ),
  caseOf(
    [{ status: 200, headers: { 'content-length': 'abc' }, chunks: ['ab'] }, 1],
    'a declared length that is no number',
  ),
  caseOf(
    [{ status: 200, headers: { 'content-length': '-5' }, chunks: ['ab'] }, 4],
    'a negative declared length',
  ),
  caseOf(
    [{ status: 200, headers: { 'content-length': '' }, chunks: ['ab'] }, 4],
    'an empty declared length is zero',
  ),
  caseOf(
    [{ status: 200, headers: { 'content-length': '1e2' }, chunks: ['ab'] }, 50],
    'an exponent',
  ),
  caseOf(
    [{ status: 200, headers: { 'content-length': '0x10' }, chunks: ['ab'] }, 15],
    'hexadecimal',
  ),
  caseOf(
    [{ status: 200, headers: { 'content-length': ' 7 ' }, chunks: ['ab'] }, 6],
    'padding is trimmed by the headers',
  ),
  caseOf([{ status: 200, headers: { 'content-length': '2.5' }, chunks: ['ab'] }, 2], 'a fraction'),
  caseOf([{ status: 200, noBody: true }, 10], 'no body'),
  caseOf([{ status: 200, noBody: true }, -1], 'no body over a negative cap'),
  caseOf(
    [{ status: 200, noBody: true, headers: { 'content-length': '9' } }, 3],
    'no body but a declared length',
  ),
  caseOf(
    [{ status: 200, chunks: ['one', 'two'], streamError: 'connection reset' }, 100],
    'a stream that fails',
  ),
  caseOf(
    [{ status: 200, chunks: [], streamError: 'immediately' }, 100],
    'a stream that fails at once',
  ),
  caseOf([{ status: 200, chunks: ['hex:00ff80', 'hex:fe'] }, 100], 'raw bytes'),
  caseOf([{ status: 200, chunks: ['\u00e9\u{1F600}'] }, 5], 'UTF-8 bytes are counted'),
  caseOf([ok('hello'), 3 * 1024 * 1024 - 1], 'the message rounds the cap'),
]

const TOO_LARGE_CASES: Case[] = [
  0,
  1,
  1048576,
  1572864,
  1048576 * 3,
  1048576 * 2.5,
  524288,
  524287,
  52428800,
  1000,
  -1572864,
  -524288,
  1.5e9,
].map((n) => caseOf([n]))

const FETCH_IMAGE_CASES: Case[] = [
  caseOf(
    [
      'https://img.example.com/a.png',
      W({
        dns: DNS,
        routes: { 'https://img.example.com/a.png': ok('PNGDATA', { 'content-type': 'image/png' }) },
      }),
    ],
    'a picture',
  ),
  caseOf(
    [
      'https://img.example.com/a.png',
      W({ dns: DNS, routes: { 'https://img.example.com/a.png': { status: 404, chunks: ['no'] } } }),
    ],
    'not found is not retried',
  ),
  caseOf(
    [
      'https://img.example.com/a.png',
      W({
        dns: DNS,
        routes: {
          'https://img.example.com/a.png': [
            { status: 403, chunks: ['no'] },
            ok('PNGDATA', { 'content-type': 'image/png' }),
          ],
        },
      }),
    ],
    '403 then a picture',
  ),
  caseOf(
    [
      'https://img.example.com/a.png',
      W({
        dns: DNS,
        routes: {
          'https://img.example.com/a.png': [
            { status: 408, chunks: [] },
            { status: 429, chunks: [] },
            ok('x'),
          ],
        },
      }),
    ],
    '408, 429, then a picture: both delays',
  ),
  caseOf(
    [
      'https://img.example.com/a.png',
      W({
        dns: DNS,
        routes: { 'https://img.example.com/a.png': { status: 503, chunks: ['busy'] } },
      }),
    ],
    'a server error that does not end',
  ),
  caseOf(
    [
      'https://img.example.com/a.png',
      W({ dns: DNS, routes: { 'https://img.example.com/a.png': { status: 499, chunks: ['no'] } } }),
    ],
    '499 is not transient',
  ),
  caseOf(
    [
      'https://img.example.com/a.png',
      W({ dns: DNS, routes: { 'https://img.example.com/a.png': { status: 500, chunks: ['no'] } } }),
    ],
    '500 is',
  ),
  caseOf(
    [
      'https://img.example.com/a.png',
      W({
        dns: DNS,
        routes: { 'https://img.example.com/a.png': { status: 503, chunks: ['busy'] } },
      }),
      { retryDelaysMs: [] },
    ],
    'no delays: the first answer is handed back',
  ),
  caseOf(
    [
      'https://img.example.com/a.png',
      W({
        dns: DNS,
        routes: { 'https://img.example.com/a.png': { status: 503, chunks: ['busy'] } },
      }),
      { retryDelaysMs: [7] },
    ],
    'one custom delay',
  ),
  caseOf(
    [
      'https://img.example.com/a.png',
      W({
        dns: DNS,
        routes: { 'https://img.example.com/a.png': { status: 503, chunks: ['busy'] } },
      }),
      { retryDelaysMs: [0, 2.5, 9, 11] },
    ],
    'four custom delays',
  ),
  caseOf(
    [
      'https://img.example.com/a.png',
      W({ dns: DNS, routes: { 'https://img.example.com/a.png': 'throw' } }),
    ],
    'the transport throws every time',
  ),
  caseOf(
    [
      'https://img.example.com/a.png',
      W({ dns: DNS, routes: { 'https://img.example.com/a.png': ['throw', ok('x')] } }),
    ],
    'the transport throws once',
  ),
  caseOf(
    [
      'https://img.example.com/a.png',
      W({ dns: DNS, routes: { 'https://img.example.com/a.png': 'throw' } }),
      { retryDelaysMs: [] },
    ],
    'a throw with no delay is null',
  ),
  caseOf(
    ['http://127.0.0.1/a.png', W({ dns: DNS, routes: { 'http://127.0.0.1/a.png': ok('x') } })],
    'blocked: null at once',
  ),
  caseOf(
    [
      'http://internal.example/a.png',
      W({ dns: DNS, routes: { 'http://internal.example/a.png': ok('x') } }),
    ],
    'blocked by resolution',
  ),
  caseOf(
    [
      'https://img.example.com/a.png',
      W({
        dns: DNS,
        routes: {
          'https://img.example.com/a.png': redirect('https://cdn.example.net/b.png'),
          'https://cdn.example.net/b.png': ok('x', { 'content-type': 'image/gif' }),
        },
      }),
    ],
    'a redirect',
  ),
  caseOf(
    [
      'https://img.example.com/a.png',
      W({ dns: DNS, routes: { 'https://img.example.com/a.png': redirect('http://127.0.0.1/') } }),
    ],
    'a bounce is null',
  ),
  caseOf(['ftp://example.com/a.png', W({ dns: DNS })], 'not http'),
  caseOf(['file:///etc/passwd', W({ dns: DNS })], 'a file outside the store'),
  caseOf(['file:not-a-url', W({ dns: DNS })], 'file: that is no URL'),
  caseOf(
    ['FILE:///etc/passwd', W({ dns: DNS, routes: { 'FILE:///etc/passwd': ok('x') } })],
    'only the lower-case prefix is a file',
  ),
  caseOf(
    [
      '$GEN/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png',
      W({ seeds: { 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png': { text: 'PNG-BYTES' } } }),
    ],
    'a generated picture',
  ),
  caseOf(
    [
      '$GEN/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.webp',
      W({ seeds: { 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.webp': { hex: '52494646' } } }),
    ],
    'a webp',
  ),
  caseOf(
    [
      '$GEN/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg',
      W({ seeds: { 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg': { text: '' } } }),
    ],
    'an empty picture',
  ),
  caseOf(
    ['$GEN/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png', W({})],
    'a generated picture that is gone',
  ),
]

const IMAGE_BYTES_CASES: Case[] = [
  caseOf([null, W({ dns: DNS })], 'not a string'),
  caseOf([42, W({ dns: DNS })], 'a number'),
  caseOf(['', W({ dns: DNS })], 'empty'),
  caseOf(
    [
      'https://img.example.com/a',
      W({
        dns: DNS,
        mock: true,
        routes: { 'https://img.example.com/a': ok('PNG', { 'content-type': 'image/png' }) },
      }),
    ],
    'png',
  ),
  caseOf(
    [
      'https://img.example.com/a',
      W({
        dns: DNS,
        mock: true,
        routes: { 'https://img.example.com/a': ok('GIF8', { 'content-type': 'image/gif' }) },
      }),
    ],
    'gif',
  ),
  caseOf(
    [
      'https://img.example.com/a',
      W({
        dns: DNS,
        mock: true,
        routes: { 'https://img.example.com/a': ok('JPEG!', { 'content-type': 'image/jpeg' }) },
      }),
    ],
    'jpeg',
  ),
  caseOf(
    [
      'https://img.example.com/a',
      W({
        dns: DNS,
        mock: true,
        routes: { 'https://img.example.com/a': ok('<html>', { 'content-type': 'text/html' }) },
      }),
    ],
    'anything else is jpeg',
  ),
  caseOf(
    [
      'https://img.example.com/a',
      W({ dns: DNS, mock: true, routes: { 'https://img.example.com/a': ok('x') } }),
    ],
    'no content type',
  ),
  caseOf(
    [
      'https://img.example.com/a',
      W({
        dns: DNS,
        mock: true,
        routes: { 'https://img.example.com/a': ok('x', { 'content-type': 'IMAGE/PNG' }) },
      }),
    ],
    'the type is matched as it is written',
  ),
  caseOf(
    [
      'https://img.example.com/a',
      W({
        dns: DNS,
        mock: true,
        routes: {
          'https://img.example.com/a': ok('x', { 'content-type': 'image/x-png; charset=binary' }),
        },
      }),
    ],
    'png anywhere in the type',
  ),
  caseOf(
    [
      'https://img.example.com/a',
      W({
        dns: DNS,
        mock: true,
        routes: { 'https://img.example.com/a': ok('x', { 'content-type': 'image/gif;png' }) },
      }),
    ],
    'png wins over gif',
  ),
  caseOf(
    [
      'https://img.example.com/a',
      W({
        dns: DNS,
        mock: true,
        routes: {
          'https://img.example.com/a': {
            status: 200,
            headers: { 'content-type': 'image/png', 'content-length': '99999999' },
            chunks: ['x'],
          },
        },
      }),
    ],
    'a declared length over the cap',
  ),
  caseOf(
    [
      'https://img.example.com/a',
      W({
        dns: DNS,
        mock: true,
        routes: {
          'https://img.example.com/a': {
            status: 200,
            headers: { 'content-type': 'image/png' },
            noBody: true,
          },
        },
      }),
    ],
    'an empty answer',
  ),
  caseOf(
    [
      'https://img.example.com/a',
      W({
        dns: DNS,
        mock: true,
        routes: { 'https://img.example.com/a': { status: 404, chunks: ['no'] } },
      }),
    ],
    'not found',
  ),
  caseOf(
    [
      'https://img.example.com/a',
      W({ dns: DNS, mock: true, routes: { 'https://img.example.com/a': 'throw' } }),
    ],
    'the transport throws',
  ),
  caseOf(['http://127.0.0.1/a', W({ dns: DNS })], 'blocked'),
  caseOf(
    [
      'https://img.example.com/a',
      W({
        dns: DNS,
        mock: true,
        routes: {
          'https://img.example.com/a': {
            status: 200,
            headers: { 'content-type': 'image/png' },
            chunks: ['hex:00'],
          },
        },
      }),
    ],
    'one byte',
  ),
  caseOf(
    [
      'https://img.example.com/a',
      W({
        dns: DNS,
        mock: true,
        routes: {
          'https://img.example.com/a': {
            status: 200,
            headers: { 'content-type': 'image/png' },
            chunks: ['hex:0001'],
          },
        },
      }),
    ],
    'two bytes',
  ),
  caseOf(
    [
      'https://img.example.com/a',
      W({
        dns: DNS,
        mock: true,
        routes: {
          'https://img.example.com/a': {
            status: 200,
            headers: { 'content-type': 'image/png' },
            chunks: ['hex:000102', 'hex:fffefd'],
          },
        },
      }),
    ],
    'six bytes in two chunks',
  ),
  caseOf(
    [
      '$GEN/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png',
      W({ seeds: { 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png': { text: 'PNG-BYTES' } } }),
    ],
    'a generated png',
  ),
  caseOf(
    [
      '$GEN/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.gif',
      W({ seeds: { 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.gif': { text: 'GIF89a' } } }),
    ],
    'a generated gif',
  ),
  caseOf(
    [
      '$GEN/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.webp',
      W({ seeds: { 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.webp': { text: 'RIFF' } } }),
    ],
    'a generated webp is labelled by its content type: jpeg',
  ),
  caseOf(['file:///etc/hosts', W({})], 'a file outside the store'),
]

const UU = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OLD_UU = '11111111-2222-4333-8444-555555555555'
const READ_CASES: Case[] = [
  caseOf([W({ seeds: { [`${UU}.png`]: { text: 'PNG' } } }), `$GEN/${UU}.png`], 'a png'),
  caseOf([W({ seeds: { [`${UU}.jpg`]: { hex: 'ffd8ff' } } }), `$GEN/${UU}.jpg`], 'a jpg'),
  caseOf([W({ seeds: { [`${UU}.gif`]: { text: 'GIF' } } }), `$GEN/${UU}.gif`], 'a gif'),
  caseOf([W({ seeds: { [`${UU}.webp`]: { text: 'WEBP' } } }), `$GEN/${UU}.webp`], 'a webp'),
  caseOf([W({ seeds: { [`${UU}.png`]: { text: '' } } }), `$GEN/${UU}.png`], 'an empty file'),
  caseOf(
    [W({ seeds: { [`${UU}.png`]: { text: 'PNG' } } }), `$GEN/${UU}.png?x=1#frag`],
    'a query and a fragment are not the path',
  ),
  caseOf(
    [W({ seeds: { [`${UU}.png`]: { text: 'PNG' } } }), `$GEN/${UU}.PNG`],
    'an upper-case extension',
  ),
  caseOf(
    [
      W({ seeds: { [`${UU.toUpperCase()}.png`]: { text: 'PNG' } } }),
      `$GEN/${UU.toUpperCase()}.png`,
    ],
    'an upper-case name',
  ),
  caseOf(
    [W({ seeds: { [`${UU}.bmp`]: { text: 'BMP' } } }), `$GEN/${UU}.bmp`],
    'an extension that is not an image',
  ),
  caseOf(
    [W({ seeds: { [`${UU}.png.bak`]: { text: 'x' } } }), `$GEN/${UU}.png.bak`],
    'a name with a tail',
  ),
  caseOf(
    [W({ seeds: { [`x${UU}.png`]: { text: 'x' } } }), `$GEN/x${UU}.png`],
    'a name with a head',
  ),
  caseOf(
    [W({ seeds: { 'photo.png': { text: 'x' } } }), '$GEN/photo.png'],
    'a name that is no uuid',
  ),
  caseOf(
    [W({ seeds: { [`${UU}.png`]: { text: 'PNG' } } }), `$GEN/../${UU}.png`],
    'a parent segment',
  ),
  caseOf(
    [W({ seeds: { [`${UU}.png`]: { text: 'PNG' } } }), `$GEN/sub/../${UU}.png`],
    'a segment that cancels',
  ),
  caseOf(
    [W({ seeds: { [`${UU}.png`]: { text: 'PNG' } } }), `$GEN/%2e%2e/${UU}.png`],
    'an encoded parent segment',
  ),
  caseOf(
    [W({ seeds: { [`${UU}.png`]: { text: 'PNG' } } }), `$GEN%2F${UU}.png`],
    'an encoded slash',
  ),
  caseOf(
    [W({ seeds: { [`${UU}.png`]: { text: 'PNG' } } }), `$GEN/%2f${UU}.png`],
    'an encoded slash inside',
  ),
  caseOf(
    [W({ seeds: { [`${UU}.png`]: { text: 'PNG' } } }), `$GEN/%5c${UU}.png`],
    'an encoded backslash',
  ),
  caseOf([W({ seeds: { [`${UU}.png`]: { text: 'PNG' } } }), `$GEN//${UU}.png`], 'a doubled slash'),
  caseOf(
    [W({ seeds: { [`${UU}.png`]: { text: 'PNG' } } }), `$GEN/%${UU}.png`],
    'a malformed escape',
  ),
  caseOf(
    [W({ seeds: { [`${UU}.png`]: { text: 'PNG' } } }), `$GEN/%E0%A4%A${UU}.png`],
    'a bad UTF-8 escape',
  ),
  caseOf([W({ seeds: { [`${UU}.png`]: { text: 'PNG' } } }), `$GEN/%00${UU}.png`], 'an encoded NUL'),
  caseOf(
    [
      W({ seeds: { sub: { dir: true }, [`sub/${UU}.png`]: { text: 'PNG' } } }),
      `$GEN/sub/${UU}.png`,
    ],
    'a file in a sub folder',
  ),
  caseOf(
    [W({ seeds: { [`${UU}.png`]: { dir: true } } }), `$GEN/${UU}.png`],
    'a folder with the name of a picture',
  ),
  caseOf([W({}), `$GEN/${UU}.png`], 'no such file'),
  caseOf(
    [W({ seeds: { [`${UU}.png`]: { text: 'PNG' } } }), `file://remote.example/${UU}.png`],
    'a host in the URL',
  ),
  caseOf([W({}), 'file://localhost/etc/passwd'], 'a file outside the store through localhost'),
  caseOf([W({}), 'file:///etc/passwd'], 'a prompt-injected file'),
  caseOf([W({}), 'http://example.com/a.png'], 'not a file URL'),
  caseOf([W({}), 'FILE:///etc/passwd'], 'the scheme is case-insensitive'),
  caseOf([W({}), 'file:'], 'file: alone'),
  caseOf([W({}), 'file:///'], 'the root'),
  caseOf([W({}), 'not a url'], 'not a URL'),
  caseOf([W({}), ''], 'empty'),
  caseOf([W({}), 'file://'], 'an empty file URL'),
  caseOf([W({}), `file:///${'a'.repeat(300)}/${UU}.png`], 'a long path'),
  caseOf([W({}), `file://${'\u00e9'}/${UU}.png`], 'a non-ASCII host'),
]

const STORE_NOW = 1_794_452_400_000
const DAY = 24 * 60 * 60 * 1000
const STORE_CASES: Case[] = [
  caseOf([W({}), { hex: '89504e47' }, 'image/png'], 'png'),
  caseOf([W({}), { hex: '00' }, 'image/jpeg'], 'jpeg is jpg'),
  caseOf([W({}), { hex: '00' }, 'image/jpg'], 'jpg'),
  caseOf([W({}), { hex: '00' }, 'image/gif'], 'gif'),
  caseOf([W({}), { hex: '00' }, 'image/webp'], 'webp'),
  caseOf([W({}), { hex: '00' }, 'IMAGE/WEBP'], 'the label is lower-cased'),
  caseOf([W({}), { hex: '00' }, 'image/\u0130'], 'U+0130 lower-cases to two characters'),
  caseOf([W({}), { hex: '00' }, '\u212Aimage/png'], 'the Kelvin sign is not a label'),
  caseOf([W({}), { hex: '00' }, 'image/svg+xml'], 'an unknown label is png'),
  caseOf([W({}), { hex: '00' }, ''], 'an empty label'),
  caseOf([W({}), { hex: '00' }, null], 'no label'),
  caseOf([W({}), { hex: '00' }, 42], 'a label that is a number'),
  caseOf([W({}), { hex: '00' }, 'constructor'], 'a label that names an inherited property'),
  caseOf([W({}), { hex: '00' }, 'toString'], 'another inherited function'),
  caseOf([W({}), { hex: '00' }, 'hasOwnProperty'], 'hasOwnProperty'),
  caseOf([W({}), { hex: '00' }, '__proto__'], 'the prototype itself'),
  caseOf([W({}), { hex: '00' }, '__defineGetter__'], '__defineGetter__'),
  caseOf([W({}), { hex: '00' }, 'valueOf'], 'valueOf'),
  caseOf([W({}), { hex: '00' }, 'isPrototypeOf'], 'isPrototypeOf'),
  caseOf([W({}), { hex: '00' }, 'propertyIsEnumerable'], 'propertyIsEnumerable'),
  caseOf([W({}), { hex: '00' }, 'toLocaleString'], 'toLocaleString'),
  caseOf([W({}), { hex: '00' }, '__lookupSetter__'], '__lookupSetter__'),
  caseOf([W({}), { hex: '00' }, 'CONSTRUCTOR'], 'the label is lower-cased first'),
  caseOf([W({}), { hex: '00' }, `image/png${' '.repeat(128 - 9)}`], 'a label of 128 units'),
  caseOf(
    [W({}), { hex: '00' }, `image/png${' '.repeat(129 - 9)}`],
    'a label of 129 units falls back',
  ),
  caseOf(
    [W({}), { hex: '00' }, 'x'.repeat(64) + '\u{1F600}'.repeat(32)],
    'astral characters count twice: 128',
  ),
  caseOf(
    [W({}), { hex: '00' }, 'x'.repeat(65) + '\u{1F600}'.repeat(32)],
    'astral characters count twice: 129',
  ),
  caseOf([W({}), { hex: '' }, 'image/png'], 'empty bytes'),
  caseOf([W({}), { length: 0 }, 'image/png'], 'empty bytes again'),
  caseOf([W({}), null, 'image/png'], 'no bytes'),
  caseOf([W({}), 'abcd', 'image/png'], 'bytes that are a string'),
  caseOf([W({}), { length: 25 * 1024 * 1024 }, 'image/png'], 'the byte budget'),
  caseOf([W({}), { length: 25 * 1024 * 1024 + 1 }, 'image/png'], 'a byte over the budget'),
  caseOf(
    [
      W({ seeds: { [`${OLD_UU}.png`]: { text: 'old', mtimeMs: STORE_NOW - DAY - 1 } } }),
      { hex: '01' },
      'image/png',
    ],
    'a picture a millisecond past a day is pruned',
  ),
  caseOf(
    [
      W({ seeds: { [`${OLD_UU}.png`]: { text: 'old', mtimeMs: STORE_NOW - DAY } } }),
      { hex: '01' },
      'image/png',
    ],
    'a picture of exactly a day stays',
  ),
  caseOf(
    [
      W({ seeds: { [`${OLD_UU}.png`]: { text: 'old', mtimeMs: STORE_NOW - DAY + 1 } } }),
      { hex: '01' },
      'image/png',
    ],
    'a younger one stays',
  ),
  caseOf(
    [
      W({ seeds: { [`${OLD_UU}.png`]: { text: 'old', mtimeMs: STORE_NOW + DAY } } }),
      { hex: '01' },
      'image/png',
    ],
    'a picture from the future stays',
  ),
  caseOf(
    [
      W({ seeds: { 'old.png': { text: 'old', mtimeMs: STORE_NOW - 9 * DAY } } }),
      { hex: '01' },
      'image/png',
    ],
    'an old file that is no picture of the store stays',
  ),
  caseOf(
    [
      W({
        seeds: { [`${OLD_UU.toUpperCase()}.png`]: { text: 'old', mtimeMs: STORE_NOW - 9 * DAY } },
      }),
      { hex: '01' },
      'image/png',
    ],
    'an upper-case name stays',
  ),
  caseOf(
    [
      W({ seeds: { [`${OLD_UU}.bmp`]: { text: 'old', mtimeMs: STORE_NOW - 9 * DAY } } }),
      { hex: '01' },
      'image/png',
    ],
    'an extension of no picture stays',
  ),
  caseOf(
    [
      W({
        seeds: {
          [`${OLD_UU}.webp`]: { text: 'old', mtimeMs: STORE_NOW - 9 * DAY },
          [`${UU}.gif`]: { text: 'newer', mtimeMs: STORE_NOW - 3600_000 },
        },
      }),
      { hex: '01' },
      'image/webp',
    ],
    'two pictures: one pruned',
  ),
  caseOf(
    [
      W({ seeds: { [`${OLD_UU}.png`]: { dir: true, mtimeMs: STORE_NOW - 9 * DAY } } }),
      { hex: '01' },
      'image/png',
    ],
    'a folder named like a picture cannot be removed as a file',
  ),
]

const many = (n: number, piece: string): string => piece.repeat(n)

const HTML_TABLES: string[] = [
  '<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Apple</td><td>3</td></tr><tr><td>Pear</td><td>5</td></tr></table>',
  '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr><tr><td>2</td></tr></tbody><tfoot><tr><td>sum</td></tr></tfoot></table>',
  '<table><tr><td>a<td>b<tr><td>c<td>d',
  '<TABLE><TR><TD>A<TD>B</TABLE>',
  '<table><td>a</td></table>',
  '<table><tr><th>x</td><td>y</th></tr></table>',
  '<table><tr></tr><tr><td>a</td></tr><tr></tr></table>',
  '<table><tr><td></td></tr><tr><td> </td><td></td></tr></table>',
  '<table><tr><td>one</td></tr></table><table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>',
  '<table></table><table><tr><td>second</td></tr></table>',
  '<table><tr><td>first</td></tr></table><table><tr><td>second</td></tr></table>',
  '<table><caption>cap</caption><colgroup><col></colgroup><tr><td>1</td></tr></table>',
  '<table><tr><td>outer<table><tr><td>inner1</td></tr><tr><td>inner2</td></tr></table></td></tr></table>',
  '<table><tr><td><table><tr><td>deep</td></tr></table></td><td>x</td></tr></table>',
  'text before<table>fostered<tr><td>a</td></tr></table>text after',
  '<p><table><tr><td>in p</td></tr></table>',
  '<div><div><table><tr><td>deep div</td></tr></table></div></div>',
  '<td>no table</td>',
  '<tr><td>no table either</td></tr>',
  '<p>no table</p>',
  '',
  '   ',
  '<table',
  '<table><tr><td>a',
  '<table><tr><td>a</td></tr>',
  '<table><tr><td>a</tr></td></table>',
  '<table><tr><td>a<td>b</td><td>c</td></table><table>',
  '<table><tr><td>a\u00a0\u00a0b</td><td>\u00a0lead and trail\u00a0</td></tr></table>',
  '<table><tr><td>a&nbsp;&nbsp;b&amp;c&lt;d&#x1F600;&#65;&unknown;</td></tr></table>',
  '<table><tr><td>tab\there\nnew  line\r\ncr\rlf</td></tr></table>',
  '<table><tr><td>\ufeffbom \u2028sep \u2029par \u0085nel \u000bvt \u000cff</td></tr></table>',
  '<table><tr><td>a<!-- hidden -->b<!---->c</td></tr></table>',
  '<table><tr><td>a<b>bold</b> <i>it<u>alic</u></i> end</td></tr></table>',
  '<table><tr><td>a<script>var x = 1 < 2;</script>b<style>p{}</style>c</td></tr></table>',
  '<table><tr><td>a<template><b>hidden</b></template>b</td></tr></table>',
  '<table><tr><td>a<noscript><b>raw</b></noscript>b</td></tr></table>',
  '<table><tr><td>a<br>b<hr>c<img src=x alt=alt>d</td></tr></table>',
  '<table><tr><td>a<svg><title>svg title</title></svg>b</td></tr></table>',
  '<table><tr><td>a<math><mi>x</mi></math>b</td></tr></table>',
  '<table><tr><td>a<textarea>t&amp;a</textarea>b<xmp><b>x</b></xmp>c</td></tr></table>',
  '<table><tr><td>one</td><td>two</td><td>three</td></tr><tr><td>1</td></tr><tr><td>1</td><td>2</td><td>3</td><td>4</td></tr></table>',
  '<table><tbody><tr><td>1<tr><td>2</tbody><tbody><tr><td>3</table>',
  '<table><tr><td>1</td></tr></table>\ufeff',
  '\ufeff<table><tr><td>after a BOM</td></tr></table>',
  '<table><tr><td>a \u0000 b</td></tr></table>',
  '<table><tr><td>a < b > c</td></tr></table>',
  '<table><tr><td>\u00e9\u00fc\u{1F600}\u4f8b</td><td>\u0131\u017f\u212a</td></tr></table>',
  '<table><tr><td><a href="x">link</a></td><td><button>b</button></td></tr></table>',
  '<table><tr><td><form><input></form>f</td></tr></table>',
  '<svg><table><tr><td>svg table</td></tr></table></svg>',
  '<table><tr><td><svg><foreignObject><table><tr><td>fo</td></tr></table></foreignObject></svg></td></tr></table>',
  '<table><tr><td>a</td></tr><tr><td>b</td></tr></table><table><tr><td>c</td></tr><tr><td>d</td></tr><tr><td>e</td></tr></table><table><tr><td>f</td></tr><tr><td>g</td></tr><tr><td>h</td></tr></table>',
  '<select><table><tr><td>in select</td></tr></table></select>',
  '<table><tr><th>h1<th>h2<tr><th>a<td>b<tr><td>c<th>d</table>',
  '<table><colgroup><tr><td>cg</td></tr></table>',
  '<table><tr><td>x</td></tr></table><p>after</p><table><tr><td>y</td></tr></table>',
  `<table>${many(50001, '<tr><td>r</td></tr>')}</table>`,
  `<table><tr>${many(1001, '<td>c</td>')}</tr><tr><td>short</td></tr></table>`,
  `<table><tr><td>${'x'.repeat(32767)}</td><td>${'y'.repeat(32768)}</td></tr></table>`,
]

const CSV_TEXTS: string[] = [
  'a,b,c\n1,2,3\n4,5,6',
  'a;b;c\n1;2;3',
  'a\tb\tc\n1\t2\t3',
  'a,b;c\n1,2;3',
  'a;b,c\n1;2,c',
  'a,b\tc\n1,2\t3',
  '"a,b",c,d\n"1,2",3,4',
  '"a;b";c\n1;2',
  'a,"b\n',
  'plain text without any delimiter',
  '',
  '\n\n\r\n',
  '\ufeffa,b\n1,2',
  '\ufeff\ufeffa,b',
  'a,b\r\n1,2\r\n3,4\r\n',
  'a,b\r1,2\r3,4',
  'a,b\n\n\n1,2\n\n',
  'a,b\n1,2\n,\n,,\n',
  'a,b\n1,2\n\u00a0,\n',
  'a,b,c\n1\n1,2,3,4,5',
  '"quoted ""inner"" text",x\nplain,y',
  'a,b\n"multi\nline",c',
  'x,y\n"unterminated,z\nrest,w',
  'a,b\n1,2\n'.repeat(3),
  '\u00e9,\u4f8b\n\u{1F600},\u0131',
  `a,b\n${many(49999, '1,2\n')}`,
  `${many(50001, 'x\n')}`,
  `${many(1001, 'c,')}c\n1,2`,
  'x'.repeat(65534) + '\u{1F600};;;;,',
  'x'.repeat(65535) + '\u{1F600};;;;,',
  `${'x'.repeat(65536)};;;;,`,
  `${'x'.repeat(65535)};;;;,`,
  ',,,,,;;;;;\t\t\t\t\t',
  ',;\t',
  '"a"b,c\n',
  'a,b\n1,"2"3"\n',
]

const ROWS: [string, string][] = [
  ['a,b,c', ','],
  ['a,b,c', ';'],
  ['', ','],
  ['a,', ','],
  [',a', ','],
  [',', ','],
  ['"a,b",c', ','],
  ['"a""b",c', ','],
  ['"a"b",c', ','],
  ['a"b,c', ','],
  ['a,"b', ','],
  ['a,"b,c', ','],
  ['a,"b,c"', ','],
  ['"', ','],
  ['""', ','],
  ['""""', ','],
  ['"""a"', ','],
  ['"a"x,y', ','],
  ['"a" ,y', ','],
  [' "a",y', ','],
  ['a,,b', ','],
  ['a\tb\tc', '\t'],
  ['a;b;"c;d"', ';'],
  ['a,b,c', ',,'],
  ['a,,b', ',,'],
  ['a,b,c', ''],
  ['a\u00e9b\u00e9c', '\u00e9'],
  ['a\u{1F600}b\u{1F600}c', '\u{1F600}'],
  ['a,b\u{1F600},c', ','],
  ['"\u{1F600}","b"', ','],
  ['a b c', ' '],
  ['a\u0131b', '\u0131'],
  ['"a"\u017f"b"', '\u017f'],
]

const DELIMITED_ARGS: [string, string | null][] = [
  ...CSV_TEXTS.map((text): [string, string | null] => [text, null]),
  ['a;b\n1;2', ';'],
  ['a;b\n1;2', ','],
  ['a,b\n1,2', ''],
  ['a,b\n1,2', ',,'],
  ['a,b\n1,2', '\t'],
  ['a|b\n1|2', '|'],
]

const TABLE_HEADERS = { 'content-type': 'text/html; charset=utf-8' }
const tableWorld = (url: string, response: RespSpec | 'throw'): World =>
  W({ dns: DNS, routes: { [url]: response } })
const TABLE_URL = 'https://example.com/t'
const fetchTable = (response: RespSpec | 'throw'): Case =>
  caseOf([TABLE_URL, tableWorld(TABLE_URL, response)])

const FETCH_TABLE_CASES: Case[] = [
  fetchTable({
    status: 200,
    headers: TABLE_HEADERS,
    chunks: ['<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>'],
  }),
  fetchTable({ status: 200, headers: { 'content-type': 'text/csv' }, chunks: ['a,b\n1,2\n'] }),
  fetchTable({
    status: 200,
    headers: { 'content-type': 'TEXT/CSV; charset=utf-8' },
    chunks: ['a;b\n1;2\n'],
  }),
  fetchTable({ status: 200, headers: { 'content-type': 'text/plain' }, chunks: ['a\tb\n1\t2'] }),
  fetchTable({ status: 200, headers: { 'content-type': 'application/csv' }, chunks: ['a,b\n1,2'] }),
  fetchTable({ status: 200, headers: { 'content-type': 'Application/CSV' }, chunks: ['a,b\n1,2'] }),
  fetchTable({ status: 200, headers: { 'content-type': 'text/csv; name=\u00e9' }, chunks: ['a,b\n1,2'] }),
  fetchTable({ status: 200, headers: { 'content-type': 'x-text/csv-x' }, chunks: ['a,b\n1,2'] }),
  fetchTable({ status: 200, headers: { 'content-type': 'text/html' }, chunks: ['a,b\n1,2\n'] }),
  fetchTable({ status: 200, chunks: ['a,b\n1,2\n'] }),
  fetchTable({
    status: 200,
    headers: { 'content-type': 'text/html' },
    chunks: ['a < b > c\n1,2\n'],
  }),
  fetchTable({
    status: 200,
    headers: { 'content-type': 'text/html' },
    chunks: ['<p>no table</p>'],
  }),
  fetchTable({ status: 200, headers: { 'content-type': 'text/html' }, chunks: ['x<y>z'] }),
  fetchTable({ status: 200, headers: { 'content-type': 'text/html' }, chunks: ['a,b\n<A\n1,2'] }),
  fetchTable({
    status: 200,
    headers: { 'content-type': 'text/html' },
    chunks: ['a,b <!doctype> 1,2'],
  }),
  fetchTable({ status: 200, headers: { 'content-type': 'text/html' }, chunks: ['a,b </x> 1,2'] }),
  fetchTable({
    status: 200,
    headers: { 'content-type': 'text/html' },
    chunks: ['a,b <\u017f> 1,2'],
  }),
  fetchTable({
    status: 200,
    headers: { 'content-type': 'text/html' },
    chunks: ['a,b <\u212a> 1,2'],
  }),
  fetchTable({ status: 200, headers: { 'content-type': 'text/html' }, chunks: ['a,b <1> 1,2'] }),
  fetchTable({ status: 200, headers: { 'content-type': 'text/html' }, chunks: ['a,b <x 1,2'] }),
  fetchTable({ status: 200, headers: { 'content-type': 'text/html' }, chunks: ['a,b\n>x<\n1,2'] }),
  fetchTable({
    status: 200,
    headers: { 'content-type': 'text/csv' },
    chunks: ['<table><tr><td>x</td></tr></table>'],
  }),
  fetchTable({
    status: 200,
    headers: TABLE_HEADERS,
    chunks: ['<table><tr><td>a</td></tr><tr><td></td></tr><tr><td></td></tr></table>'],
  }),
  fetchTable({
    status: 200,
    headers: TABLE_HEADERS,
    chunks: ['<table><tr><td></td></tr><tr><td></td></tr></table>'],
  }),
  fetchTable({
    status: 200,
    headers: { 'content-type': 'text/csv' },
    chunks: ['a,b\n1,2\n,\n,\n'],
  }),
  fetchTable({ status: 200, headers: { 'content-type': 'text/csv' }, chunks: ['a,b\n,\n'] }),
  fetchTable({
    status: 200,
    headers: TABLE_HEADERS,
    chunks: [
      `<table><tr><td>${'x'.repeat(32767)}</td><td>${'y'.repeat(32768)}</td><td>${'z'.repeat(32766)}\u{1F600}</td></tr></table>`,
    ],
  }),
  fetchTable({
    status: 200,
    headers: { 'content-type': 'text/csv' },
    chunks: [`${'x'.repeat(40000)},b\n1,2`],
  }),
  fetchTable({ status: 200, headers: { 'content-type': 'text/csv' }, chunks: ['\ufeffa,b\n1,2'] }),
  fetchTable({
    status: 200,
    headers: { 'content-type': 'text/csv' },
    chunks: ['hex:efbbbf', 'a,b\n1,2'],
  }),
  fetchTable({
    status: 200,
    headers: { 'content-type': 'text/csv' },
    chunks: ['hex:efbbbfefbbbf', 'a,b'],
  }),
  fetchTable({
    status: 200,
    headers: { 'content-type': 'text/csv' },
    chunks: ['hex:612cff62', 'hex:0a312c32'],
  }),
  fetchTable({
    status: 200,
    headers: { 'content-type': 'text/csv' },
    chunks: ['hex:612cc3', 'hex:a9620a312c32'],
  }),
  fetchTable({ status: 200, headers: { 'content-type': 'text/csv' }, chunks: ['hex:fffe6100'] }),
  fetchTable({
    status: 200,
    headers: { 'content-type': 'text/csv' },
    chunks: ['hex:f0908080', 'hex:2c620a31'],
  }),
  fetchTable({ status: 200, headers: { 'content-type': 'text/csv' }, chunks: [] }),
  fetchTable({ status: 200, headers: { 'content-type': 'text/csv' }, noBody: true }),
  fetchTable({ status: 200, headers: { 'content-type': 'text/html' }, chunks: [''] }),
  fetchTable({
    status: 404,
    headers: TABLE_HEADERS,
    chunks: ['<table><tr><td>x</td></tr></table>'],
  }),
  fetchTable({
    status: 200,
    headers: { 'content-length': '20000000', 'content-type': 'text/csv' },
    chunks: ['a,b'],
  }),
  fetchTable({
    status: 200,
    headers: { 'content-length': '16777216', 'content-type': 'text/csv' },
    chunks: ['a,b'],
  }),
  fetchTable({
    status: 200,
    headers: { 'content-type': 'text/csv' },
    chunks: ['a,b\n', '1,2'],
    streamError: 'cut',
  }),
  fetchTable('throw'),
  caseOf(
    [
      TABLE_URL,
      W({
        dns: DNS,
        routes: {
          [TABLE_URL]: redirect('https://cdn.example.net/t.csv'),
          'https://cdn.example.net/t.csv': {
            status: 200,
            headers: { 'content-type': 'text/csv' },
            chunks: ['a,b\n1,2'],
          },
        },
      }),
    ],
    'a redirect',
  ),
  caseOf(
    [TABLE_URL, W({ dns: DNS, routes: { [TABLE_URL]: redirect('http://127.0.0.1/t.csv') } })],
    'a bounce to loopback',
  ),
  caseOf(['http://127.0.0.1/t', W({ dns: DNS })], 'a refused address'),
  caseOf(['http://internal.example/t', W({ dns: DNS })], 'a refused resolution'),
  caseOf(['file:///etc/passwd', W({ dns: DNS })], 'not http'),
  caseOf(['\\\\server\\share\\t.csv', W({ dns: DNS })], 'a UNC share'),
  caseOf(['not a url', W({ dns: DNS })], 'not a URL'),
  caseOf(
    [
      'HTTPS://EXAMPLE.COM/T',
      W({
        dns: DNS,
        routes: {
          'HTTPS://EXAMPLE.COM/T': {
            status: 200,
            headers: { 'content-type': 'text/csv' },
            chunks: ['a'],
          },
        },
      }),
    ],
    'the URL comes back as it was given',
  ),
]

const EXTERNAL_URLS: (string | number | null)[] = [
  'https://example.com',
  'http://example.com/a b',
  '  https://example.com/x  ',
  '\n\thttps://example.com/\r\n',
  '\u00a0https://example.com/\u00a0',
  '\ufeffhttps://example.com/',
  '\u0085https://example.com/',
  'HTTPS://EXAMPLE.COM',
  'https://\u4f8b\u3048.jp/',
  'https://xn--r8jz45g.jp/',
  'https://fa\u00df.de/',
  'https://\uff25\uff38.com/',
  'https://exa\u00admple.com/',
  'https://[::1]:8080/',
  'https://[::1',
  'https://a b/',
  'https://exa mple.com/',
  'https://exa%20mple.com/',
  'https://example.com:99999/',
  'https://user:pass@example.com/',
  'https:example.com',
  'https:/example.com',
  'https:///example.com',
  'https://',
  'https:',
  'http://',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'JAVASCRIPT:alert(1)',
  'data:text/html,x',
  'mailto:a@example.com',
  'tel:+123',
  'ftp://example.com/',
  'ws://example.com/',
  'vscode://file/x',
  'genoffice-app://docs/index.html',
  'blob:https://example.com/uuid',
  'about:blank',
  '//example.com',
  '/path',
  'example.com',
  'x',
  '',
  ' ',
  '\u0131ttps://example.com',
  'ht\u0074ps://example.com',
  'h\u017ftps://example.com',
  'http\u212a://example.com',
  7,
  null,
]

const EXTERNAL_OPTIONS: ({ allowedProtocols?: string[] } | null)[] = [
  null,
  {},
  { allowedProtocols: ['https:'] },
  { allowedProtocols: ['http:', 'https:', 'mailto:', 'tel:'] },
  { allowedProtocols: ['file:'] },
  { allowedProtocols: [] },
  { allowedProtocols: ['HTTPS:'] },
  { allowedProtocols: ['https'] },
  { allowedProtocols: ['genoffice-app:', 'vscode:'] },
]

const RENDERER_QUERIES: (Record<string, string> | null)[] = [
  null,
  {},
  { a: '1' },
  { a: '1', b: '2' },
  {
    a: 'one two',
    b: 'x&y=z',
    c: '#frag',
    d: '?q',
    e: '100%',
    f: 'plus+sign',
    g: '\u00e9\u{1F600}',
  },
  { '': 'empty key', k: '' },
  { '10': 'ten', '2': 'two', x: 'x', '1': 'one' },
  { 'a b': '1', 'a&b': '2', 'a=b': '3', 'a+b': '4', 'a%b': '5' },
  { '~': '~', '*': '*', '-': '-', '.': '.', _: '_', "'": "'", '!': '!', '(': '(', ')': ')' },
  { k: '\r\n' },
  { file: 'C:\\docs\\a b.docx' },
  { ['k'.repeat(256)]: 'v' },
  { ['k'.repeat(257)]: 'v' },
  { ['\u{1F600}'.repeat(128)]: 'v' },
  { ['\u{1F600}'.repeat(129)]: 'v' },
  { k: 'v'.repeat(4000) },
  { k: 'v'.repeat(4001) },
  { k: '\u{1F600}'.repeat(2000) },
  { k: '\u{1F600}'.repeat(2001) },
  Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, String(i)])),
  Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, String(i)])),
  { ok: '1', ['k'.repeat(300)]: 'v' },
]

const RENDERER_CASES: Case[] = [
  ...RENDERER_QUERIES.map((q) => caseOf([null, 'docs', q])),
  caseOf(['http://localhost:5173/', 'docs', null], 'a dev URL'),
  caseOf(['http://localhost:5173', 'docs', { a: '1' }], 'a dev URL without a path'),
  caseOf(
    ['http://localhost:5173/index.html?x=1&y=2&x=3', 'docs', { x: 'new', z: '9' }],
    'a key that is there is set once and the others go',
  ),
  caseOf(
    ['http://localhost:5173/?a=1&b=2', 'docs', { c: '3' }],
    'a key that is not there is appended',
  ),
  caseOf(
    ['http://localhost:5173/?a=1+2%20three&b=%7E~', 'docs', { c: '3' }],
    'the query is written again',
  ),
  caseOf(['http://localhost:5173/?a=1', 'docs', {}], 'no params keeps the dev URL'),
  caseOf(['http://localhost:5173/?a=1', 'docs', null], 'no query keeps the dev URL'),
  caseOf(['http://localhost:5173/?', 'docs', {}], 'an empty query stays'),
  caseOf(['http://localhost:5173/?', 'docs', { a: '1' }], 'an empty query takes a param'),
  caseOf(['http://localhost:5173/?a#frag', 'docs', { b: '1' }], 'the fragment stays'),
  caseOf(['http://localhost:5173/#frag', 'docs', { b: '1' }], 'a fragment without a query'),
  caseOf(['http://localhost:5173/?%zz=1&&=&a', 'docs', { a: 'x' }], 'a query that is not clean'),
  caseOf(['HTTP://LOCALHOST:5173/A', 'sheets', null], 'the URL is written normalized'),
  caseOf(['file:///app/index.html', 'pdf', { f: 'x' }], 'a file dev URL'),
  caseOf(['genoffice-app://slides/index.html?q=1', 'slides', { q: '2' }], 'a scheme dev URL'),
  caseOf(['', 'docs', null], 'an empty dev URL is a URL that does not parse'),
  caseOf(['not a url', 'docs', null], 'a dev URL that does not parse'),
  caseOf(['http://', 'sheets', { a: '1' }], 'an incomplete dev URL'),
  caseOf(['http://exa mple/', 'help', null], 'a host with a space'),
  caseOf(
    ['not a url', 'docs', Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, '1']))],
    'the URL is checked before the params',
  ),
  caseOf([null, 'bad host', null], 'the scheme URL does not parse: the message says undefined'),
  caseOf([null, 'bad host', { a: '1' }], 'the same with params'),
  caseOf([null, '', null], 'an empty host'),
  caseOf([null, 'Docs', null], 'a host in capitals'),
  caseOf([null, 'docs/x', null], 'a host with a slash'),
  caseOf([null, 'docs:80', null], 'a host with a port'),
  caseOf([null, 'do cs', null], 'a space'),
  caseOf([null, 'd\u00f6cs', null], 'a non-ASCII host'),
  caseOf([null, '\u4f8b', null], 'a CJK host'),
  caseOf([null, 'docs', { a: '1' }], 'one param'),
  ...[
    'docs',
    'sheets',
    'slides',
    'pdf',
    'markdown',
    'html',
    'mindmap',
    'hwp',
    'epub',
    'diagram',
    'help',
  ].map((h) => caseOf([null, h, null])),
]

const ROOTS = {
  docs: '/srv/docs',
  sheets: '/srv/sheets/',
  mixed: '/srv//mixed/./x/..',
  empty: '',
  relative: 'relative/root',
  slash: '/',
  Upper: '/srv/upper',
  '': '/srv/nameless',
  'docs:8080': '/srv/ported',
}
const RENDERER_REQUESTS: string[] = [
  'genoffice-app://docs/index.html',
  'genoffice-app://docs/assets/app.js',
  'genoffice-app://docs/assets/app.js?v=1#frag',
  'genoffice-app://docs/',
  'genoffice-app://docs',
  'genoffice-app://docs//etc/passwd',
  'genoffice-app://docs/../../etc/passwd',
  'genoffice-app://docs/..%2f..%2fetc/passwd',
  'genoffice-app://docs/%2e%2e/x',
  'genoffice-app://docs/%2E%2E%2fx',
  'genoffice-app://docs/a/%2e%2e/b.js',
  'genoffice-app://docs/./x/../y.js',
  'genoffice-app://docs/a%5c..%5c..%5cb',
  'genoffice-app://docs/a%5Cb',
  'genoffice-app://docs/%5c%5cserver%5cshare',
  'genoffice-app://docs/C:/x',
  'genoffice-app://docs/a%00b',
  'genoffice-app://docs/%00',
  'genoffice-app://docs/%E0%A4%A',
  'genoffice-app://docs/%',
  'genoffice-app://docs/%41%42.js',
  'genoffice-app://docs/%C3%A9%F0%9F%98%80.js',
  'genoffice-app://docs/\u00e9\u{1F600}.js',
  `genoffice-app://docs/${'a'.repeat(4095)}`,
  `genoffice-app://docs/${'a'.repeat(4096)}`,
  `genoffice-app://docs/${'\u{1F600}'.repeat(2047)}`,
  `genoffice-app://docs/${'\u{1F600}'.repeat(2048)}`,
  `genoffice-app://docs/${'%41'.repeat(4096)}`,
  'genoffice-app://sheets/s.js',
  'genoffice-app://sheets//s.js',
  'genoffice-app://mixed/m.js',
  'genoffice-app://mixed/',
  'genoffice-app://empty/index.html',
  'genoffice-app://relative/index.html',
  'genoffice-app://slash/index.html',
  'genoffice-app://slash/',
  'genoffice-app://Upper/x',
  'genoffice-app://upper/x',
  'genoffice-app://UPPER/x',
  'genoffice-app://DOCS/index.html',
  'genoffice-app://Docs/index.html',
  'genoffice-app://docs:8080/index.html',
  'genoffice-app://docs.:8080/index.html',
  'genoffice-app://nope/index.html',
  'genoffice-app://unknown/../docs/index.html',
  'genoffice-app:///index.html',
  'genoffice-app:index.html',
  'genoffice-app:docs/index.html',
  'http://docs/index.html',
  'HTTP://DOCS/index.html',
  'https://docs:443/index.html',
  'file://docs/index.html',
  'file:///docs/index.html',
  'not a url',
  '',
  '/docs/index.html',
  'genoffice-app://exa mple/x',
  'genoffice-app://docs/a b/c d.js',
  'genoffice-app://docs/a%20b.js',
  'genoffice-app://docs/a#b',
  'genoffice-app://docs/a?b=c',
  'genoffice-app://docs/%2e',
  'genoffice-app://docs/%2e%2e',
  'genoffice-app://docs/.%2e/etc',
]

const ROOT_SETS: Record<string, string>[] = [
  ROOTS,
  {},
  { docs: '/srv/docs/' },
  { docs: '/' },
  { docs: '/srv/docs/..' },
  { docs: '/srv/do\u00e7s' },
]

const RESOLVE_CASES: Case[] = [
  ...RENDERER_REQUESTS.map((request) => caseOf([ROOTS, request])),
  ...ROOT_SETS.slice(1).flatMap((roots) =>
    ['genoffice-app://docs/index.html', 'genoffice-app://docs/', 'genoffice-app://docs/../x'].map(
      (request) => caseOf([roots, request]),
    ),
  ),
]

// ------------------------------------------------------------------ proxy

const proxyCases = (): Case[] => {
  const out: Case[] = []
  const proxies = [
    'http://proxy.corp:3128',
    'http://user:pw@127.0.0.1:8080',
    'socks5://p:1080',
    '',
    'not a url',
    'http://',
  ]
  for (const proxy of proxies) out.push(caseOf([proxy, {}, PROXY_URLS]))
  for (const list of NO_PROXY_LISTS) {
    if (list !== null) {
      out.push(caseOf(['http://proxy.corp:3128', { no_proxy: list }, PROXY_URLS]))
      out.push(caseOf(['http://proxy.corp:3128', { NO_PROXY: list }, PROXY_URLS]))
    }
  }
  out.push(
    caseOf(
      ['http://proxy.corp:3128', { no_proxy: '', NO_PROXY: 'example.com' }, PROXY_URLS],
      'the lower-case variable wins even when empty',
    ),
  )
  out.push(
    caseOf(
      ['http://proxy.corp:3128', { no_proxy: 'example.com', NO_PROXY: 'api.corp.com' }, PROXY_URLS],
      'both set',
    ),
  )
  out.push(
    caseOf(
      [
        'http://proxy.corp:3128',
        { http_proxy: 'http://other:1', HTTPS_PROXY: 'http://other:2' },
        PROXY_URLS,
      ],
      'the proxy variables are not read',
    ),
  )
  return out
}

const envProxyCases = (): Case[] => {
  const out: Case[] = []
  const options = [
    {},
    { httpProxy: 'http://p:1' },
    { httpsProxy: 'http://p:2' },
    { httpProxy: 'http://p:1', httpsProxy: 'http://p:2' },
    { httpProxy: '', httpsProxy: 'http://p:2' },
    { httpProxy: 'http://p:1', httpsProxy: '' },
    { httpProxy: '', httpsProxy: '' },
    { httpProxy: 'http://p:1', noProxy: '' },
    { httpProxy: 'http://p:1', noProxy: 'example.com' },
    { httpProxy: 'http://p:1', noProxy: '*' },
    { httpProxy: 'http://p:1', noProxy: '.corp.com,localhost:8080' },
    { httpProxy: 'not a url' },
    { httpsProxy: 'not a url' },
    { httpProxy: '', httpsProxy: 'not a url' },
    { httpProxy: 'http://p:1', httpsProxy: 'bad url' },
  ]
  for (const opts of options) out.push(caseOf([opts, {}, PROXY_URLS]))
  const envs: ProxyEnvSpec[] = [
    { http_proxy: 'http://e:1' },
    { HTTP_PROXY: 'http://e:1' },
    { http_proxy: '', HTTP_PROXY: 'http://e:1' },
    { https_proxy: 'http://e:2' },
    { HTTPS_PROXY: 'http://e:2' },
    { http_proxy: 'http://e:1', HTTPS_PROXY: 'http://e:2' },
    { HTTPS_PROXY: 'http://e:2', https_proxy: '' },
    { no_proxy: 'example.com', http_proxy: 'http://e:1' },
    { NO_PROXY: '.corp.com', https_proxy: 'http://e:2' },
    { no_proxy: '', NO_PROXY: 'example.com', http_proxy: 'http://e:1' },
    { NO_PROXY: '*', http_proxy: 'http://e:1' },
    { http_proxy: 'bad url' },
    { HTTPS_PROXY: 'bad url', http_proxy: 'http://e:1' },
  ]
  for (const env of envs) out.push(caseOf([{}, env, PROXY_URLS]))
  out.push(
    caseOf(
      [
        { httpProxy: 'http://p:1', noProxy: 'example.com' },
        { no_proxy: 'api.corp.com', http_proxy: 'http://e:1' },
        PROXY_URLS,
      ],
      'the options win over the environment',
    ),
  )
  out.push(
    caseOf(
      [{ httpProxy: 'http://p:1' }, { NO_PROXY: 'example.com,[::1]' }, PROXY_URLS],
      'no proxy list from the environment',
    ),
  )
  return out
}

// -------------------------------------------------------------- guards

const NAV_SCENARIOS: Case[] = [
  caseOf(
    [
      {
        installs: 1,
        contents: [
          {
            url: 'genoffice-app://docs/index.html',
            navigations: [
              'genoffice-app://docs/index.html',
              'https://evil.example/',
              'genoffice-app://docs/index.html#x',
              '',
            ],
          },
        ],
      },
    ],
    'one window',
  ),
  caseOf(
    [{ installs: 2, contents: [{ url: 'a', navigations: ['a', 'b'] }] }],
    'a second install does nothing',
  ),
  caseOf(
    [
      {
        installs: 3,
        contents: [
          { url: 'a', navigations: [] },
          { url: '', navigations: ['', 'x'] },
        ],
      },
    ],
    'three installs, two windows',
  ),
  caseOf([{ installs: 0, contents: [{ url: 'a', navigations: ['a'] }] }], 'no install: no handler'),
  caseOf([{ installs: 1, contents: [] }], 'no window'),
  caseOf(
    [
      {
        installs: 1,
        contents: [
          {
            url: 'file:///a.html',
            navigations: ['file:///a.html', 'FILE:///a.html', 'file:///a.html '],
          },
        ],
      },
    ],
    'a URL is compared as written',
  ),
  caseOf(
    [
      {
        installs: 1,
        contents: [
          { url: '\u00e9\u{1F600}', navigations: ['\u00e9\u{1F600}', 'e\u0301\u{1F600}'] },
        ],
      },
    ],
    'non-ASCII URLs',
  ),
]

const TREE_OWN: FrameSpec[] = [
  { url: 'genoffice-app://hwp/index.html', origin: 'genoffice-app://hwp', parent: null },
  { url: 'genoffice-app://hwp/editor.html', origin: 'genoffice-app://hwp', parent: 0 },
]
const TREE_SLIDES: FrameSpec[] = [
  { url: 'genoffice-app://slides/index.html', origin: 'genoffice-app://slides', parent: null },
  { url: 'genoffice-app://slides/index.html', origin: 'null', parent: 0 },
  { url: 'blob:genoffice-app://slides/u', origin: 'genoffice-app://slides', parent: 0 },
]
const TREE_FILE: FrameSpec[] = [
  { url: 'file:///opt/seuoffice/shell/index.html', origin: 'null', parent: null },
  { url: 'file:///opt/seuoffice/shell/frame.html', origin: 'null', parent: 0 },
]
const TREE_DEV: FrameSpec[] = [
  { url: 'http://localhost:5173/', origin: 'http://localhost:5173', parent: null },
  { url: 'http://localhost:5173/frame', origin: 'http://localhost:5173', parent: 0 },
  { url: 'http://localhost:5173/frame', origin: 'http://localhost:5173', parent: 1 },
]
const TREE_DOC: FrameSpec[] = [
  { url: 'https://example.com/', origin: 'https://example.com', parent: null },
  { url: 'genoffice-app://docs/index.html', origin: 'genoffice-app://docs', parent: 0 },
]

const contents = (
  id: number,
  frames: FrameSpec[],
  extra: Partial<ContentsSpec> = {},
): ContentsSpec => ({
  id,
  frames,
  main: 0,
  ...extra,
})

const APP_PAGE_ADDRESSES: (string | null)[] = [
  null,
  '',
  'not a url',
  'genoffice-app://docs/index.html',
  'genoffice-app://docs',
  'genoffice-app://docs/',
  'genoffice-app://Docs/index.html',
  'genoffice-app://DOCS',
  'genoffice-app://sheets/x?y#z',
  'genoffice-app://slides/index.html',
  'genoffice-app://pdf/',
  'genoffice-app://markdown/',
  'genoffice-app://html/',
  'genoffice-app://mindmap/',
  'genoffice-app://hwp/',
  'genoffice-app://epub/',
  'genoffice-app://diagram/',
  'genoffice-app://help/',
  'genoffice-app://shell/',
  'genoffice-app://nope/',
  'genoffice-app://constructor/',
  'genoffice-app://__proto__/',
  'genoffice-app://toString/',
  'genoffice-app://hasOwnProperty/',
  'genoffice-app://docs.example/',
  'genoffice-app:docs',
  'genoffice-app:///docs',
  'genoffice-app://docs:80/',
  'genoffice-apps://docs/',
  'GENOFFICE-APP://docs/',
  'http://localhost:5173/',
  'http://localhost:5173/a/b?c#d',
  'http://LOCALHOST:5173/',
  'http://localhost:5174/',
  'http://localhost:5175/',
  'http://localhost/',
  'https://localhost:5173/',
  'http://localhost:5173.evil.example/',
  'http://evil.example/http://localhost:5173/',
  'http://user@localhost:5173/',
  'http://127.0.0.1:5173/',
  'http://[::1]:5173/',
  'http://[::1]:5176/',
  'http://dev.example:8080/',
  'http://dev.example:80/',
  'http://dev.example/',
  'https://dev.example:443/',
  'file:///opt/seuoffice/shell/index.html',
  'file:///opt/seuoffice/shell/a/b/c.html',
  'file:///opt/seuoffice/shell',
  'file:///opt/seuoffice/shell/',
  'file:///opt/seuoffice/shellx/index.html',
  'file:///opt/seuoffice/shell/../x/index.html',
  'file:///opt/seuoffice/shell/./index.html',
  'file:///opt/seuoffice/other/index.html',
  'file:///OPT/SEUOFFICE/SHELL/index.html',
  'file:///opt/seuoffice/shell/a%20b.html',
  'file:///opt/seuoffice/shell/a%2Fb.html',
  'file:///opt/seuoffice/shell/a%5Cb.html',
  'file:///opt/seuoffice/shell/%E0%A4%A.html',
  'file://localhost/opt/seuoffice/shell/index.html',
  'file://remote/opt/seuoffice/shell/index.html',
  'file://127.0.0.1/opt/seuoffice/shell/index.html',
  'file:///opt/seuoffice/hwp/viewer/index.html',
  'file:///opt/seuoffice/hwp/index.html',
  'file:///opt/seuoffice/hwp',
  'file:///opt/seuoffice/\u00e9/index.html',
  'file:///opt/seuoffice/%C3%A9/index.html',
  'file:///tmp/printed/doc.html',
  'file:///',
  'file:',
  'blob:http://localhost:5173/uuid',
  'blob:genoffice-app://docs/uuid',
  'data:text/html,hello',
  'about:blank',
  'about:srcdoc',
  'javascript:0',
  'filesystem:http://localhost:5173/temporary/x',
  'ftp://localhost:5173/',
  'ws://localhost:5173/',
]

const PAGES_SETS: PagesSpec[] = [
  {
    devUrls: {
      docs: 'http://localhost:5173/',
      shell: 'http://localhost:5174',
      dev: 'http://dev.example:8080/x',
      v6: 'http://[::1]:5173',
      bad: 'not a url',
      blank: '',
      none: null,
    },
    fileRoots: {
      shell: '/opt/seuoffice/shell',
      hwp: '/opt/seuoffice/hwp/',
      nested: '/opt/seuoffice/hwp/viewer',
      dots: '/opt/seuoffice/other/../hwp2',
      empty: '',
      accent: '/opt/seuoffice/\u00e9',
    },
  },
  {
    devUrls: {
      '10': 'http://localhost:5173/',
      '2': 'http://localhost:5173/',
      b: 'http://localhost:5173/',
      '1': 'http://localhost:5174/',
    },
    fileRoots: {
      '9': '/opt/seuoffice/shell',
      '10': '/opt/seuoffice/shell',
      a: '/opt/seuoffice/shell',
    },
  },
  { devUrls: null, fileRoots: null },
  {},
  {
    devUrls: {
      x: 'file:///opt/seuoffice/shell/index.html',
      y: 'genoffice-app://docs/',
      z: 'http://localhost:5173',
    },
  },
  { fileRoots: { rel: 'relative/root', slash: '/' } },
]

const APP_PAGE_CASES: Case[] = [
  ...APP_PAGE_ADDRESSES.map((address) => caseOf([PAGES_SETS[0], address])),
  ...[
    'http://localhost:5173/',
    'http://localhost:5174/',
    'file:///opt/seuoffice/shell/x',
    'genoffice-app://docs/',
    'http://localhost:1/',
  ].flatMap((address) => PAGES_SETS.slice(1).map((pages) => caseOf([pages, address]))),
  caseOf(
    [{ fileRoots: { rel: 'relative/root' } }, `file://${process.cwd()}/relative/root/x.html`],
    'a relative root is resolved from the working folder',
  ),
  caseOf(
    [{ fileRoots: { dir: '$DIR/app' } }, 'file://$DIR/app/index.html'],
    'a folder of the case',
  ),
  caseOf([{ fileRoots: { dir: '$DIR/app' } }, 'file://$DIR/app'], 'the folder itself is no page'),
  caseOf(
    [{ fileRoots: { dir: '$DIR/app/' } }, 'file://$DIR/app/x/y.html'],
    'a root with a trailing slash',
  ),
]

const ASKS: Record<string, unknown>[] = []
for (const permission of [
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'local-fonts',
  'media',
  'geolocation',
  'notifications',
  'camera',
  'microphone',
  'constructor',
  'toString',
  '__proto__',
  'hasOwnProperty',
  'Fullscreen',
  '',
]) {
  for (const url of [
    'genoffice-app://docs/index.html',
    'genoffice-app://slides/index.html',
    'https://example.com/',
    null,
  ]) {
    ASKS.push({ permission, webContentsId: 7, url, isMainFrame: true, ownFrame: null, media: null })
  }
}
const MEDIA_ASKS: Record<string, unknown>[] = []
for (const media of [
  null,
  [],
  ['audio'],
  ['video'],
  ['audio', 'video'],
  ['audio', 'audio'],
  ['Audio'],
  [''],
  ['screen'],
]) {
  for (const id of [7, 8, 0, -1]) {
    for (const main of [true, false]) {
      MEDIA_ASKS.push({
        permission: 'media',
        webContentsId: id,
        url: 'genoffice-app://slides/index.html',
        isMainFrame: main,
        ownFrame: main ? null : true,
        media,
      })
    }
  }
}
const FRAME_ASKS: Record<string, unknown>[] = [
  {
    permission: 'fullscreen',
    webContentsId: 7,
    url: 'genoffice-app://docs/index.html',
    isMainFrame: false,
    ownFrame: null,
    media: null,
  },
  {
    permission: 'fullscreen',
    webContentsId: 7,
    url: 'genoffice-app://docs/index.html',
    isMainFrame: false,
    ownFrame: false,
    media: null,
  },
  {
    permission: 'fullscreen',
    webContentsId: 7,
    url: 'genoffice-app://docs/index.html',
    isMainFrame: false,
    ownFrame: true,
    media: null,
  },
  {
    permission: 'media',
    webContentsId: 7,
    url: 'genoffice-app://slides/index.html',
    isMainFrame: false,
    ownFrame: true,
    media: ['audio'],
  },
  {
    permission: 'fullscreen',
    webContentsId: null,
    url: 'genoffice-app://docs/index.html',
    isMainFrame: true,
    ownFrame: null,
    media: null,
  },
  {
    permission: 'fullscreen',
    webContentsId: 0,
    url: 'genoffice-app://docs/index.html',
    isMainFrame: true,
    ownFrame: null,
    media: null,
  },
  {
    permission: 'fullscreen',
    webContentsId: 7,
    url: 'http://localhost:5173/',
    isMainFrame: true,
    ownFrame: null,
    media: null,
  },
  {
    permission: 'fullscreen',
    webContentsId: 7,
    url: 'file:///opt/seuoffice/shell/index.html',
    isMainFrame: true,
    ownFrame: null,
    media: null,
  },
  {
    permission: 'fullscreen',
    webContentsId: 7,
    url: 'file:///tmp/doc.html',
    isMainFrame: true,
    ownFrame: null,
    media: null,
  },
]
const ALLOWED_CASES: Case[] = [...ASKS, ...MEDIA_ASKS, ...FRAME_ASKS].map((ask) =>
  caseOf([POLICY, ask]),
)

const REQUEST_DETAILS = (
  url: string | null,
  isMainFrame: boolean,
  mediaTypes: string[] | null = null,
) => ({
  isMainFrame,
  requestingUrl: url,
  mediaTypes,
})
const CHECK_DETAILS = (
  url: string | null,
  isMainFrame: boolean,
  mediaType: string | null = null,
) => ({
  isMainFrame,
  requestingUrl: url,
  mediaType,
})

const HANDLER_TREES: [string, ContentsSpec | null][] = [
  ['no contents', null],
  ['the app page alone', contents(7, [TREE_OWN[0]!])],
  ['an own frame', contents(7, TREE_OWN)],
  ['a sandboxed frame at an app address, and a nested one', contents(7, TREE_SLIDES)],
  ['a file page with a file frame', contents(7, TREE_FILE)],
  ['a dev page with nested frames of one address', contents(7, TREE_DEV)],
  ['a document page that is no app page', contents(7, TREE_DOC)],
  ['no top frame', contents(7, TREE_OWN, { main: null })],
  ['a torn main frame', contents(7, TREE_OWN, { torn: ['mainFrame'] })],
  ['a torn subtree', contents(7, TREE_OWN, { torn: ['subtree'] })],
  ['a torn top url', contents(7, TREE_OWN, { torn: ['url:0'] })],
  ['a torn frame url', contents(7, TREE_OWN, { torn: ['url:1'] })],
  ['a torn origin', contents(7, TREE_OWN, { torn: ['origin:1'] })],
  ['a torn top origin', contents(7, TREE_OWN, { torn: ['origin:0'] })],
  ['a torn parent', contents(7, TREE_OWN, { torn: ['parent:1'] })],
]
const HANDLER_URLS = [
  'genoffice-app://hwp/editor.html',
  'genoffice-app://hwp/index.html',
  'genoffice-app://slides/index.html',
  'blob:genoffice-app://slides/u',
  'file:///opt/seuoffice/shell/frame.html',
  'http://localhost:5173/frame',
  'genoffice-app://docs/index.html',
  'https://example.com/',
  null,
  '',
]
const HANDLER_CASES = (kind: 'request' | 'check'): Case[] => {
  const out: Case[] = []
  for (const [note, tree] of HANDLER_TREES) {
    for (const url of HANDLER_URLS) {
      for (const main of [false, true]) {
        const permission = url?.includes('slides') ? 'media' : 'fullscreen'
        out.push(
          kind === 'request'
            ? caseOf(
                [
                  POLICY,
                  tree,
                  permission,
                  REQUEST_DETAILS(url, main, permission === 'media' ? ['audio'] : null),
                ],
                note,
              )
            : caseOf(
                [
                  POLICY,
                  tree,
                  permission,
                  'origin',
                  CHECK_DETAILS(url, main, permission === 'media' ? 'audio' : null),
                ],
                note,
              ),
        )
      }
    }
  }
  return out
}
const HANDLER_MEDIA_CASES = (kind: 'request' | 'check'): Case[] => {
  const out: Case[] = []
  const slides = contents(7, [TREE_SLIDES[0]!])
  for (const id of [7, 9]) {
    const tree = { ...slides, id }
    const url = 'genoffice-app://slides/index.html'
    if (kind === 'request') {
      for (const types of [null, [], ['audio'], ['video'], ['audio', 'video']])
        out.push(caseOf([POLICY, tree, 'media', REQUEST_DETAILS(url, true, types)]))
      out.push(
        caseOf(
          [POLICY, tree, 'fullscreen', REQUEST_DETAILS(url, true, ['video'])],
          'media types are read for media only',
        ),
      )
    } else {
      for (const device of [null, 'audio', 'video', 'screen', ''])
        out.push(caseOf([POLICY, tree, 'media', 'o', CHECK_DETAILS(url, true, device)]))
    }
  }
  return out
}

const INSTALL_CASES: Case[] = [
  caseOf(
    [{ policy: POLICY, sessions: [], probe: contents(7, TREE_OWN) }],
    'only the default session',
  ),
  caseOf(
    [
      {
        policy: POLICY,
        sessions: ['persist:a', 'persist:b'],
        probe: contents(7, [TREE_SLIDES[0]!]),
      },
    ],
    'two sessions created before ready',
  ),
  caseOf([{ policy: POLICY, sessions: ['persist:diagram'], probe: null }], 'no contents'),
  caseOf(
    [{ policy: { pages: {}, micOpen: [] }, sessions: [], probe: contents(7, TREE_OWN) }],
    'a policy without pages',
  ),
]

const PIN_TARGETS: Record<string, unknown>[] = [
  {},
  { addresses: [] },
  { addresses: [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }] },
  {
    addresses: [
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
    ],
  },
  { hostname: 'Example.COM' },
  { hostname: '' },
]

const targetOf = (a: unknown[]): never => guardTarget(a) as never

/** one answer of `net.isIP`-style tables: each input a case */
const each = (values: unknown[]): Case[] => values.map((v) => caseOf([v]))

const unwrapMasked = (text: string): string =>
  text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')

/** the bytes a spec names: `{ hex }`, `{ length }` (zeros), or whatever else it is */
function bytesOfSpec(spec: unknown): unknown {
  if (spec !== null && typeof spec === 'object') {
    const s = spec as { hex?: string; length?: number }
    if (s.hex !== undefined) return new Uint8Array(Buffer.from(s.hex, 'hex'))
    return new Uint8Array(s.length ?? 0)
  }
  return spec
}

/** `Date.now()` reads the clock of the call while `fn` runs */
function withNow<T>(now: number, fn: () => T): T {
  const real = Date.now
  Date.now = () => now
  try {
    return fn()
  } finally {
    Date.now = real
  }
}

const probeContents = (spec: ContentsSpec | null) => contentsOf(spec) as never

export const group: Group = {
  // ------------------------------------------------------------- safe-remote-url
  'safe-remote-url.isFakeIpDnsArtifact': {
    ts: (a) => isFakeIpDnsArtifact(a[0] as string),
    cases: each(IPS),
  },
  'safe-remote-url.isBlockedAddress': {
    ts: (a) => isBlockedAddress(a[0] as string),
    cases: each(IPS),
  },
  'safe-remote-url.isIP': {
    ts: (a) => isIP(a[0] as string),
    cases: each(IPS),
  },
  'safe-remote-url.resolveSafeRemoteTarget': {
    ts: (a, cx) => inWorld(world(a, 1), cx, (env) => resolveSafeRemoteTarget(a[0], env.signal)),
    cases: [
      ...RAW_URLS.map((raw) => caseOf([raw, W({ dns: DNS })])),
      caseOf(
        ['http://example.com/', W({ dns: DNS, signal: 'aborted' })],
        'aborted before the lookup',
      ),
      caseOf(['http://example.com/', W({ dns: DNS, signal: 'live' })], 'a live signal'),
      caseOf(
        ['http://slow.example/', W({ dns: DNS, signal: 'live' })],
        'aborted during the lookup',
      ),
      caseOf(
        ['http://8.8.8.8/', W({ dns: DNS, signal: 'aborted' })],
        'a literal ignores the signal',
      ),
      caseOf(
        ['http://localhost/', W({ dns: DNS, signal: 'aborted' })],
        'a blocked name never reaches the lookup',
      ),
    ],
  },
  'safe-remote-url.isSafeRemoteUrl': {
    ts: (a, cx) => inWorld(world(a, 1), cx, (env) => isSafeRemoteUrl(a[0], env.signal)),
    cases: [
      ...RAW_URLS.map((raw) => caseOf([raw, W({ dns: DNS })])),
      caseOf(['http://example.com/', W({ dns: DNS, signal: 'aborted' })], 'aborted'),
    ],
  },
  'safe-remote-url.pinnedLookup': {
    ts: (a) => {
      const out: unknown[][] = []
      const target = targetOf([a[0]])
      pinnedLookup(target)(
        a[1] as string,
        a[2] as never,
        (...args: unknown[]) => out.push(args) as never,
      )
      const [err, address, family] = out[0]! as [Error & { code?: string }, unknown, unknown]
      return { err: err ? { code: err.code, message: err.message } : null, address, family }
    },
    cases: [
      ...PIN_HOSTS.map((host) => caseOf([{}, host, { all: true }])),
      ...PIN_OPTIONS.map((options) => caseOf([{}, 'example.com', options])),
      ...PIN_TARGETS.flatMap((target) =>
        [{ all: true }, {}, { family: 6 }].map((options) =>
          caseOf([target, 'example.com', options]),
        ),
      ),
      caseOf(
        [{ hostname: 'Example.COM' }, 'example.com', {}],
        'the target hostname is compared as it is',
      ),
      caseOf(
        [
          {
            addresses: [
              { address: '::1', family: 6 },
              { address: '1.1.1.1', family: 4 },
            ],
          },
          'example.com',
          { family: 4 },
        ],
        'the family picks',
      ),
    ],
  },
  'safe-remote-url.fetchWithSsrfGuard': {
    ts: (a, cx) =>
      inWorld(world(a, 1), cx, async (env) =>
        render(
          await fetchWithSsrfGuard(
            a[0] as string,
            guardOptions(a[2] as GuardOptions | null, env, cx),
          ),
        ),
      ),
    cases: GUARD_CASES,
  },

  // ---------------------------------------------------------------- remote-image
  'remote-image.MAX_REMOTE_IMAGE_BYTES': constant(() => MAX_REMOTE_IMAGE_BYTES),
  'remote-image.ResponseTooLargeError': {
    ts: (a) => {
      const error = new ResponseTooLargeError(a[0] as number)
      return { message: error.message, maxBytes: error.maxBytes }
    },
    cases: TOO_LARGE_CASES,
  },
  'remote-image.readBodyCapped': {
    ts: async (a, cx) => {
      const bytes = await readBodyCapped(makeResponse(a[0] as RespSpec, 'body', cx), a[1] as number)
      return { bytes: hex(bytes) }
    },
    cases: BODY_CASES,
  },
  'remote-image.remoteImageHeaders': {
    ts: () => remoteImageHeaders(),
    cases: [{ args: [] }],
    single: 'a constant',
  },
  'remote-image.fetchRemoteImage': {
    ts: (a, cx) =>
      inWorld(
        world(a, 1),
        cx,
        async (env) => {
          const retry = (a[2] as { retryDelaysMs?: number[] } | null)?.retryDelaysMs
          return render(
            await fetchRemoteImage(withGen(a[0]) as string, {
              fetchImpl: env.fetchImpl,
              ...(retry ? { retryDelaysMs: retry } : {}),
            }),
          )
        },
        { sleeps: true },
      ),
    cases: FETCH_IMAGE_CASES,
  },

  // ------------------------------------------------------------ fetch-image-bytes
  'fetch-image-bytes.fetchImageBytes': {
    ts: (a, cx) => inWorld(world(a, 1), cx, () => fetchImageBytes(withGen(a[0])), { sleeps: true }),
    cases: IMAGE_BYTES_CASES,
  },

  // ------------------------------------------------------------- generated-images
  'generated-images.GENERATED_IMAGE_DIR': {
    ts: () => GENERATED_IMAGE_DIR,
    cases: [{ args: [TMP] }],
    single: 'a constant',
  },
  'generated-images.MAX_GENERATED_IMAGE_BYTES': constant(() => MAX_GENERATED_IMAGE_BYTES),
  'generated-images.storeGeneratedImage': {
    ts: async (a, cx) => {
      const w = world(a, 0)
      const seeded = seedDir(w)
      let url: string | undefined
      let name: string | undefined
      try {
        try {
          url = withNow(cx.now, () =>
            storeGeneratedImage(bytesOfSpec(a[1]) as Uint8Array, a[2] as string),
          )
        } catch (error) {
          const e = error as Error
          e.message = unwrapMasked(e.message)
          throw e
        }
        const path = fileURLToPath(url)
        name = basename(path)
        const dir = join(w.tmpdir, 'seuoffice-ai-images')
        return {
          url: unwrapMasked(url),
          name: unwrapMasked(name),
          bytes: hex(readFileSync(path)),
          seedsLeft: seeded.filter((n) => existsSync(join(dir, n))),
        }
      } finally {
        unseedDir(w, seeded, name ? [name] : [])
      }
    },
    cases: STORE_CASES,
  },
  'generated-images.readGeneratedImage': {
    ts: async (a, cx) => {
      const w = world(a, 0)
      const seeded = seedDir(w)
      try {
        const found = readGeneratedImage(withGen(a[1]) as string)
        return found === null ? null : { bytes: hex(found.bytes), mime: found.mime }
      } finally {
        unseedDir(w, seeded)
        void cx
      }
    },
    cases: READ_CASES,
  },

  // ----------------------------------------------------------------- remote-table
  'remote-table.MAX_REMOTE_TABLE_BYTES': constant(() => MAX_REMOTE_TABLE_BYTES),
  'remote-table.MAX_REMOTE_TABLE_ROWS': constant(() => MAX_REMOTE_TABLE_ROWS),
  'remote-table.MAX_REMOTE_TABLE_COLUMNS': constant(() => MAX_REMOTE_TABLE_COLUMNS),
  'remote-table.MAX_REMOTE_TABLE_CELL_CHARS': constant(() => MAX_REMOTE_TABLE_CELL_CHARS),
  'remote-table.REMOTE_TABLE_TIMEOUT_MS': constant(() => REMOTE_TABLE_TIMEOUT_MS),
  'remote-table.parseHtmlTable': {
    ts: (a) => parseHtmlTable(a[0] as string),
    cases: each(HTML_TABLES),
  },
  'remote-table.detectDelimiter': {
    ts: (a) => detectDelimiter(a[0] as string),
    cases: each(CSV_TEXTS),
  },
  'remote-table.parseDelimitedRow': {
    ts: (a) => parseDelimitedRow(a[0] as string, a[1] as string),
    cases: ROWS.map(([line, delimiter]) => caseOf([line, delimiter])),
  },
  'remote-table.parseDelimitedTable': {
    ts: (a) => parseDelimitedTable(a[0] as string, orUndefined(a[1] as string | null)),
    cases: DELIMITED_ARGS.map(([text, delimiter]) => caseOf([text, delimiter])),
  },
  'remote-table.fetchRemoteTable': {
    ts: (a, cx) =>
      inWorld(world(a, 1), cx, (env) =>
        fetchRemoteTable(a[0] as string, { fetchImpl: env.fetchImpl }),
      ),
    cases: FETCH_TABLE_CASES,
  },

  // ------------------------------------------------------------------ main-proxy
  'main-proxy.mergeNoProxy': {
    ts: (a) => mergeNoProxy(orUndefined(a[0] as string | null)),
    cases: each([
      null,
      '',
      'a.com',
      'a.com,b.com',
      ' x ',
      ',',
      '*',
      'localhost',
      '[::1]',
      '\u00e9',
    ]),
  },
  'main-proxy.createMainProcessProxyDispatcher': {
    ts: (a) =>
      withEnv(a[1] as ProxyEnvSpec, async () => {
        const dispatcher = await createMainProcessProxyDispatcher(a[0] as string)
        try {
          const routing = (dispatcher as unknown as Record<symbol, (url: URL) => boolean>)[
            Symbol.for('seuoffice.dispatcher-proxy-routing')
          ]!
          const urls = a[2] as string[]
          const agents = undiciChoices(dispatcher, urls)
          return urls.map((url, i) => ({ url, routes: routing(new URL(url)), agent: agents[i] }))
        } finally {
          await dispatcher.close()
        }
      }),
    cases: proxyCases(),
  },
  'main-proxy.EnvHttpProxyAgent': {
    ts: (a) =>
      withEnv(a[1] as ProxyEnvSpec, async () => {
        const opts = a[0] as { httpProxy?: string; httpsProxy?: string; noProxy?: string }
        const agent = new EnvHttpProxyAgent(opts)
        try {
          return undiciChoices(agent, a[2] as string[])
        } finally {
          await agent.close()
        }
      }),
    cases: envProxyCases(),
  },

  // ------------------------------------------------------------ safe-external-url
  'safe-external-url.safeExternalUrl': {
    ts: (a) => safeExternalUrl(a[0], orUndefined(a[1] as never)),
    cases: [
      ...EXTERNAL_URLS.map((url) => caseOf([url, null])),
      ...EXTERNAL_OPTIONS.flatMap((options) =>
        [
          'https://example.com/',
          'http://example.com/',
          'mailto:a@b.c',
          'file:///x',
          'tel:+1',
          'genoffice-app://docs/',
          'vscode://x',
          'HTTPS://X.COM',
        ].map((url) => caseOf([url, options])),
      ),
    ],
  },

  // ------------------------------------------------------------ navigation-guard
  'navigation-guard.installNavigationGuard': {
    ts: async (a, cx) => {
      const scenario = a[0] as { installs: number; contents: ContentsScenario[] }
      const created: Listener[] = []
      const app: Record<string | symbol, unknown> = {
        on: (event: string, listener: Listener) => {
          cx.log('app.on', event)
          created.push(listener)
        },
      }
      for (let i = 0; i < scenario.installs; i++) installNavigationGuard(app as never)
      const results = scenario.contents.map((spec) => {
        const will: ((event: unknown) => void)[] = []
        let open: (() => unknown) | undefined
        const contents = {
          on: (event: string, listener: (event: unknown) => void) => {
            cx.log('contents.on', event)
            will.push(listener)
          },
          getURL: () => spec.url,
          setWindowOpenHandler: (handler: () => unknown) => {
            cx.log('contents.setWindowOpenHandler')
            open = handler
          },
        }
        for (const listener of created)
          (listener as unknown as (e: unknown, c: unknown) => void)({}, contents)
        const prevented = spec.navigations.map((url) => {
          let blocked = false
          for (const listener of will) {
            listener({
              url,
              preventDefault: () => {
                blocked = true
              },
            })
          }
          return blocked
        })
        return { listeners: will.length, prevented, windowOpen: open ? open() : null }
      })
      return { handlers: created.length, results }
    },
    cases: NAV_SCENARIOS,
  },

  // --------------------------------------------------------------- renderer-scheme
  'renderer-scheme.RENDERER_SCHEME': constant(() => RENDERER_SCHEME),
  'renderer-scheme.RENDERER_SCHEME_PRIVILEGE': constant(() => RENDERER_SCHEME_PRIVILEGE),
  'renderer-scheme.DOCX_MEDIA_SCHEME_PRIVILEGE': constant(() => DOCX_MEDIA_SCHEME_PRIVILEGE),
  'renderer-scheme.SLIDE_MEDIA_SCHEME_PRIVILEGE': constant(() => SLIDE_MEDIA_SCHEME_PRIVILEGE),
  'renderer-scheme.MAX_RENDERER_QUERY_ENTRIES': constant(() => MAX_RENDERER_QUERY_ENTRIES),
  'renderer-scheme.MAX_RENDERER_QUERY_CHARS': constant(() => MAX_RENDERER_QUERY_CHARS),
  'renderer-scheme.rendererUrl': {
    ts: (a) =>
      rendererUrl(
        orUndefined(a[0] as string | null),
        a[1] as never,
        orUndefined(a[2] as Record<string, string> | null),
      ),
    cases: RENDERER_CASES,
  },
  'renderer-scheme.resolveRendererFile': {
    ts: (a) =>
      resolveRendererFile(new Map(Object.entries(a[0] as Record<string, string>)), a[1] as string),
    cases: RESOLVE_CASES,
  },

  // ------------------------------------------------------------- permission-guard
  'permission-guard.appPageOf': {
    ts: (a) => appPageOf(a[0] as never, orUndefined(a[1] as string | null)),
    cases: APP_PAGE_CASES,
  },
  'permission-guard.permissionAllowed': {
    ts: (a, cx) => {
      const ask = a[1] as Record<string, unknown>
      return permissionAllowed(policyOf(a[0] as PolicySpec, cx), {
        permission: ask.permission as string,
        webContentsId: orUndefined(ask.webContentsId as number | null),
        url: orUndefined(ask.url as string | null),
        isMainFrame: ask.isMainFrame as boolean,
        ...(ask.ownFrame != null ? { ownFrame: ask.ownFrame as boolean } : {}),
        media: orUndefined(ask.media as string[] | null),
      })
    },
    cases: ALLOWED_CASES,
  },
  'permission-guard.permissionRequestHandler': {
    ts: (a, cx) => {
      const answers: boolean[] = []
      permissionRequestHandler(policyOf(a[0] as PolicySpec, cx))(
        probeContents(a[1] as ContentsSpec | null),
        a[2] as string,
        (granted) => answers.push(granted),
        (() => {
          const d = a[3] as {
            isMainFrame: boolean
            requestingUrl: string | null
            mediaTypes: string[] | null
          }
          return {
            isMainFrame: d.isMainFrame,
            ...(d.requestingUrl !== null ? { requestingUrl: d.requestingUrl } : {}),
            ...(d.mediaTypes !== null ? { mediaTypes: d.mediaTypes } : {}),
          }
        })(),
      )
      return answers
    },
    cases: [...HANDLER_CASES('request'), ...HANDLER_MEDIA_CASES('request')],
  },
  'permission-guard.permissionCheckHandler': {
    ts: (a, cx) => {
      const d = a[4] as {
        isMainFrame: boolean
        requestingUrl: string | null
        mediaType: string | null
      }
      return permissionCheckHandler(policyOf(a[0] as PolicySpec, cx))(
        probeContents(a[1] as ContentsSpec | null),
        a[2] as string,
        a[3] as string,
        {
          isMainFrame: d.isMainFrame,
          ...(d.requestingUrl !== null ? { requestingUrl: d.requestingUrl } : {}),
          ...(d.mediaType !== null ? { mediaType: d.mediaType } : {}),
        },
      )
    },
    cases: [...HANDLER_CASES('check'), ...HANDLER_MEDIA_CASES('check')],
  },
  'permission-guard.installPermissionGuard': {
    ts: async (a, cx) => {
      const scenario = a[0] as {
        policy: PolicySpec
        sessions: string[]
        probe: ContentsSpec | null
      }
      const listeners: ((ses: unknown) => void)[] = []
      let resolveReady: () => void = () => {}
      const ready = { promise: new Promise<void>((resolve) => (resolveReady = resolve)) }
      const app = {
        on: (event: string, listener: (ses: unknown) => void) => {
          cx.log('app.on', event)
          listeners.push(listener)
        },
        whenReady: () => {
          cx.log('app.whenReady')
          return ready.promise
        },
      }
      const guarded: { name: string; request?: Listener; check?: Listener }[] = []
      const session = (name: string) => {
        const entry: { name: string; request?: Listener; check?: Listener } = { name }
        guarded.push(entry)
        return {
          setPermissionRequestHandler: (handler: Listener) => {
            cx.log('session.setPermissionRequestHandler', name)
            entry.request = handler
          },
          setPermissionCheckHandler: (handler: Listener) => {
            cx.log('session.setPermissionCheckHandler', name)
            entry.check = handler
          },
        }
      }
      installPermissionGuard(
        app as never,
        { defaultSession: session('default') as never },
        policyOf(scenario.policy, cx),
      )
      for (const name of scenario.sessions)
        for (const listener of listeners) listener(session(name))
      resolveReady()
      await new Promise((resolve) => setImmediate(resolve))
      const url = 'genoffice-app://slides/index.html'
      const results = guarded.map((entry) => {
        const asked: boolean[] = []
        const contents = probeContents(scenario.probe)
        ;(entry.request as unknown as (...args: unknown[]) => void)?.(
          contents,
          'media',
          (g: boolean) => asked.push(g),
          {
            isMainFrame: true,
            requestingUrl: url,
            mediaTypes: ['audio'],
          },
        )
        const checked = (entry.check as unknown as (...args: unknown[]) => boolean)?.(
          contents,
          'fullscreen',
          'o',
          {
            isMainFrame: true,
            requestingUrl: 'genoffice-app://docs/index.html',
          },
        )
        return {
          name: entry.name,
          request: entry.request ? asked : null,
          check: entry.check ? checked : null,
        }
      })
      return results
    },
    cases: INSTALL_CASES,
  },
}
