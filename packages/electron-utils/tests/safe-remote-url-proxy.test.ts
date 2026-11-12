import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect as netConnect, isIP, Socket, type AddressInfo } from 'node:net'
import type * as DnsPromises from 'node:dns/promises'
import { lookup } from 'node:dns/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici'
import { createMainProcessProxyDispatcher } from '../src/main-proxy'
import { fetchWithSsrfGuard } from '../src/safe-remote-url'

// The guard resolves hostnames through node:dns/promises; the stub answers
// with a public address so the test hostnames pass validation.
vi.mock('node:dns/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof DnsPromises>()),
  lookup: vi.fn(),
}))

const PUBLIC_ADDRESS = '93.184.216.34'

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

const closeServer = (server: Server): void => {
  server.closeAllConnections()
  server.close()
}

interface OriginServer {
  /** `host + path` of every request that arrived, by whatever route */
  hits: string[]
  port: number
  close: () => void
}

/** The remote site: answers every path, or redirects to `?to=<url>`. */
async function startOrigin(): Promise<OriginServer> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(`${req.headers.host}${req.url}`)
    const to = new URL(req.url ?? '/', 'http://origin').searchParams.get('to')
    if (to) {
      res.writeHead(302, { location: to })
      res.end()
      return
    }
    res.end(`origin served ${req.url}`)
  })
  return { hits, port: await listen(server), close: () => closeServer(server) }
}

interface ProxyServer {
  /**
   * What clients asked the proxy for: the authority of every CONNECT and the
   * URL of every absolute-form request (the two ways undici proxies).
   */
  through: string[]
  port: number
  close: () => void
}

/** A forward proxy on loopback. Whatever the target, the bytes end up at the local origin. */
async function startProxy(originPort: number): Promise<ProxyServer> {
  const through: string[] = []
  const sockets = new Set<Socket>()
  const server = createServer((req, res) => {
    through.push(req.url ?? '')
    const { pathname, search } = new URL(req.url ?? '/')
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: originPort,
        path: pathname + search,
        method: req.method,
        headers: req.headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      },
    )
    upstream.on('error', () => res.destroy())
    req.pipe(upstream)
  })
  server.on('connect', (req, client: Socket, head: Buffer) => {
    through.push(req.url ?? '')
    const upstream = netConnect(originPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    for (const socket of [client, upstream]) {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => sockets.delete(socket))
    }
  })
  return {
    through,
    port: await listen(server),
    close: () => {
      for (const socket of sockets) socket.destroy()
      closeServer(server)
    },
  }
}

interface DirectConnect {
  /** the host the client asked the socket layer for */
  host: string
  /** the address its connect-time lookup answered with; undefined = left to the OS resolver */
  address: string | undefined
  port: number
}

type ConnectTimeLookup = (
  hostname: string,
  options: object,
  callback: (err: Error | null, address: unknown) => void,
) => void

interface SocketConnectOptions {
  host?: unknown
  port?: unknown
  lookup?: ConnectTimeLookup
}

/**
 * Stands in for the internet: every connection that would leave loopback is
 * recorded with the address it was about to dial, then landed on the local
 * origin. Nothing in these tests reaches a real network.
 */
function captureOutboundConnects(originPort: number): DirectConnect[] {
  const direct: DirectConnect[] = []
  const realConnect = Socket.prototype.connect as (this: Socket, ...args: unknown[]) => Socket
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (
    this: Socket,
    ...args: unknown[]
  ) {
    // net.connect() hands over a normalized [options, callback] pair
    const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0]
    const options =
      first !== null && typeof first === 'object' ? (first as SocketConnectOptions) : {}
    const host = options.host
    if (typeof host === 'string' && !['localhost', '127.0.0.1', '::1'].includes(host)) {
      let address: string | undefined
      if (isIP(host) !== 0) address = host
      else {
        options.lookup?.(host, {}, (err, answer) => {
          if (!err && typeof answer === 'string') address = answer
        })
      }
      direct.push({ host, address, port: Number(options.port) })
      options.host = '127.0.0.1'
      options.port = originPort
      delete options.lookup
    }
    return realConnect.apply(this, args)
  } as never)
  return direct
}

describe('fetchWithSsrfGuard behind the main-process proxy dispatcher', () => {
  let origin: OriginServer
  let proxy: ProxyServer
  let direct: DirectConnect[]
  let prior: Dispatcher
  let installed: Dispatcher | undefined
  const savedEnv: Record<string, string | undefined> = {}

  /** What the shell and the editors do at startup once they know the proxy URL. */
  const installAppProxy = async (proxyUrl: string): Promise<Dispatcher> => {
    await installed?.destroy()
    installed = await createMainProcessProxyDispatcher(proxyUrl)
    setGlobalDispatcher(installed)
    return installed
  }

  beforeEach(async () => {
    for (const name of ['no_proxy', 'NO_PROXY']) {
      savedEnv[name] = process.env[name]
      delete process.env[name]
    }
    vi.mocked(lookup).mockResolvedValue([{ address: PUBLIC_ADDRESS, family: 4 }] as never)
    origin = await startOrigin()
    proxy = await startProxy(origin.port)
    direct = captureOutboundConnects(origin.port)
    prior = getGlobalDispatcher()
  })

  afterEach(async () => {
    setGlobalDispatcher(prior)
    await installed?.destroy()
    installed = undefined
    proxy.close()
    origin.close()
    vi.restoreAllMocks()
    vi.mocked(lookup).mockReset()
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('sends an http target through the configured proxy', async () => {
    await installAppProxy(`http://127.0.0.1:${proxy.port}`)
    const resp = await fetchWithSsrfGuard('http://files.example.test/report.csv')
    expect(await resp?.text()).toBe('origin served /report.csv')
    expect(proxy.through).toHaveLength(1)
    expect(proxy.through[0]).toContain('files.example.test')
    expect(origin.hits).toEqual(['files.example.test/report.csv'])
    // nothing dialed the site itself: the proxy carried the only request
    expect(direct).toEqual([])
  })

  it('opens the tunnel for an https target at the proxy', async () => {
    // a proxy named by hostname: the OS resolves it, the validated address of
    // the target must not be pinned onto the proxy connection
    await installAppProxy(`http://localhost:${proxy.port}`)
    // the local origin speaks plain http, so the TLS handshake inside the
    // tunnel fails; where the connection went is what this asserts
    await expect(fetchWithSsrfGuard('https://secure.example.test/a.png')).rejects.toThrow()
    expect(proxy.through).toEqual(['secure.example.test:443'])
    expect(direct).toEqual([])
  })

  it('follows a redirect through the proxy and still refuses an internal hop', async () => {
    await installAppProxy(`http://127.0.0.1:${proxy.port}`)
    const resp = await fetchWithSsrfGuard(
      'http://files.example.test/start?to=http%3A%2F%2Fmirror.example.test%2Ffinal',
    )
    expect(await resp?.text()).toBe('origin served /final')
    expect(proxy.through).toHaveLength(2)
    expect(proxy.through[1]).toContain('mirror.example.test')

    const refused = await fetchWithSsrfGuard(
      'http://files.example.test/start?to=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data',
    )
    expect(refused).toBeNull()
    // the metadata address was asked of neither the proxy nor the network
    expect(proxy.through.join(' ')).not.toContain('169.254.169.254')
    expect(direct).toEqual([])
  })

  it('refuses a loopback target even though the proxy dispatcher exempts loopback', async () => {
    await installAppProxy(`http://127.0.0.1:${proxy.port}`)
    expect(await fetchWithSsrfGuard(`http://127.0.0.1:${origin.port}/private`)).toBeNull()
    expect(await fetchWithSsrfGuard(`http://localhost:${origin.port}/private`)).toBeNull()
    expect(origin.hits).toEqual([])
  })

  it('dials a NO_PROXY host directly, at the validated address', async () => {
    process.env.NO_PROXY = 'direct.example.test,.corp.example.test'
    await installAppProxy(`http://127.0.0.1:${proxy.port}`)

    const exact = await fetchWithSsrfGuard('http://direct.example.test/data.json')
    expect(await exact?.text()).toBe('origin served /data.json')
    const suffix = await fetchWithSsrfGuard('http://wiki.corp.example.test/page')
    expect(await suffix?.text()).toBe('origin served /page')
    expect(proxy.through).toEqual([])
    expect(direct).toEqual([
      { host: 'direct.example.test', address: PUBLIC_ADDRESS, port: 80 },
      { host: 'wiki.corp.example.test', address: PUBLIC_ADDRESS, port: 80 },
    ])

    // the same dispatcher still proxies every host NO_PROXY does not name
    const proxied = await fetchWithSsrfGuard('http://files.example.test/report.csv')
    expect(await proxied?.text()).toBe('origin served /report.csv')
    expect(proxy.through).toHaveLength(1)
    expect(direct).toHaveLength(2)
  })

  it('dials the validated address directly when no proxy is configured', async () => {
    const resp = await fetchWithSsrfGuard('http://files.example.test/report.csv')
    expect(await resp?.text()).toBe('origin served /report.csv')
    expect(proxy.through).toEqual([])
    expect(direct).toEqual([{ host: 'files.example.test', address: PUBLIC_ADDRESS, port: 80 }])
  })

  // The guard picks the route before undici does. If the two ever disagreed, a
  // hop would either skip the proxy or go direct without its pinned address,
  // so each NO_PROXY form is sent both ways and must leave by the same door.
  it.each([
    { noProxy: 'direct.example.test', url: 'http://direct.example.test/x', route: 'direct' },
    { noProxy: 'direct.example.test', url: 'http://sub.direct.example.test/x', route: 'proxy' },
    { noProxy: 'direct.example.test', url: 'http://direct.example.test:8080/x', route: 'direct' },
    { noProxy: '.corp.example.test', url: 'http://wiki.corp.example.test/x', route: 'direct' },
    { noProxy: '.corp.example.test', url: 'http://corp.example.test/x', route: 'proxy' },
    { noProxy: '*.corp.example.test', url: 'http://wiki.corp.example.test/x', route: 'direct' },
    { noProxy: '*.corp.example.test', url: 'http://notcorp.example.test/x', route: 'proxy' },
    { noProxy: 'UPPER.Example.Test', url: 'http://upper.example.test/x', route: 'direct' },
    { noProxy: 'a.example.test b.example.test', url: 'http://b.example.test/x', route: 'direct' },
    { noProxy: 'a.example.test, b.example.test', url: 'http://c.example.test/x', route: 'proxy' },
    {
      noProxy: 'ported.example.test:8080',
      url: 'http://ported.example.test:8080/x',
      route: 'direct',
    },
    { noProxy: 'ported.example.test:8080', url: 'http://ported.example.test/x', route: 'proxy' },
    { noProxy: 'web.example.test:80', url: 'http://web.example.test/x', route: 'direct' },
    { noProxy: 'tls.example.test:443', url: 'https://tls.example.test/x', route: 'direct' },
    { noProxy: 'tls.example.test:443', url: 'http://tls.example.test/x', route: 'proxy' },
    { noProxy: '8.8.8.8', url: 'http://8.8.8.8/x', route: 'direct' },
    { noProxy: '[2001:4860:4860::8888]', url: 'http://[2001:4860:4860::8888]/x', route: 'direct' },
    { noProxy: '*', url: 'http://anything.example.test/x', route: 'direct' },
    { noProxy: undefined, url: 'http://anything.example.test/x', route: 'proxy' },
  ])('NO_PROXY=$noProxy sends $url by $route, as the dispatcher itself does', async (c) => {
    if (c.noProxy !== undefined) process.env.NO_PROXY = c.noProxy
    const dispatcher = await installAppProxy(`http://127.0.0.1:${proxy.port}`)
    /** which door the request left by; an https request fails at the plain origin, after leaving */
    const routeOf = async (send: () => Promise<unknown>): Promise<string> => {
      const before = { proxy: proxy.through.length, direct: direct.length }
      await send().catch(() => undefined)
      const viaProxy = proxy.through.length - before.proxy
      const viaDirect = direct.length - before.direct
      return `proxy ${viaProxy}, direct ${viaDirect}`
    }
    const expected = c.route === 'proxy' ? 'proxy 1, direct 0' : 'proxy 0, direct 1'

    const { origin: site, pathname } = new URL(c.url)
    const byDispatcher = await routeOf(async () => {
      const { body } = await dispatcher.request({ origin: site, path: pathname, method: 'GET' })
      await body.dump()
    })
    expect(byDispatcher).toBe(expected)

    const byGuard = await routeOf(async () => {
      const resp = await fetchWithSsrfGuard(c.url)
      await resp?.arrayBuffer()
    })
    expect(byGuard).toBe(expected)
    // a hostname that goes direct is dialed at the address the guard validated
    const last = direct.at(-1)
    if (c.route === 'direct' && last && isIP(last.host) === 0) {
      expect(last.address).toBe(PUBLIC_ADDRESS)
    }
  })
})
