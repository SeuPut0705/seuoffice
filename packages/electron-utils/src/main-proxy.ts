import { EnvHttpProxyAgent, type Dispatcher } from 'undici'
import { declareProxyRouting } from './safe-remote-url'

/**
 * The NO_PROXY list the main-process dispatcher ships with: the caller's own
 * entries first, then loopback. undici matches entries exactly (or by `*.` or
 * leading-dot suffix), and the URL host of IPv6 loopback keeps its brackets.
 */
export function mergeNoProxy(userNoProxy: string | undefined): string {
  return [userNoProxy, 'localhost', '127.0.0.1', '[::1]'].filter((v) => !!v).join(',')
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }

/**
 * Whether a NO_PROXY list exempts a URL, by EnvHttpProxyAgent's rules: an entry
 * matches the host exactly, or as a suffix when it starts with `.` or `*`, and
 * an entry with a port only matches that port. undici keeps its matcher
 * private, so the rules are restated here for the one caller that has to know
 * the route before the request is dispatched (the SSRF guard); the tests hold
 * the two to the same answer.
 */
function noProxyMatcher(noProxy: string): (url: URL) => boolean {
  const entries = noProxy
    .split(/[,\s]/)
    .filter((entry) => entry !== '')
    .map((entry) => {
      const withPort = /^(.+):(\d+)$/.exec(entry)
      return {
        hostname: (withPort?.[1] ?? entry).toLowerCase(),
        port: Number.parseInt(withPort?.[2] ?? '0', 10),
      }
    })
  return (url) => {
    // host minus the port keeps the brackets of an IPv6 literal, as the entries do
    const hostname = url.host.replace(/:\d*$/, '').toLowerCase()
    const port = Number.parseInt(url.port, 10) || DEFAULT_PORTS[url.protocol] || 0
    return entries.some((entry) => {
      if (entry.port !== 0 && entry.port !== port) return false
      return /^[.*]/.test(entry.hostname)
        ? hostname.endsWith(entry.hostname.replace(/^\*/, ''))
        : hostname === entry.hostname
    })
  }
}

/**
 * The dispatcher behind the main process's global fetch when a proxy is in
 * play. A plain ProxyAgent sends loopback targets to the proxy too — as
 * absolute-form requests for http:// — so a Custom provider on 127.0.0.1
 * (Ollama, LM Studio, a local relay) gets routed to a remote node and comes
 * back with a gateway page (genoffice#2084). EnvHttpProxyAgent consults NO_PROXY per
 * request; the loopback defaults ride along even when the user set none.
 *
 * The resolved proxyUrl is passed for both schemes, matching what the
 * ProxyAgent it replaces did; the caller keeps the env/resolveProxy probing.
 *
 * The dispatcher carries its own routing answer (`declareProxyRouting`):
 * `fetchWithSsrfGuard` has to know, per URL, whether the proxy or a direct
 * connection will carry the request, and must not guess it from the shape of
 * the object.
 */
export async function createMainProcessProxyDispatcher(proxyUrl: string): Promise<Dispatcher> {
  const noProxy = mergeNoProxy(process.env.no_proxy ?? process.env.NO_PROXY)
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: proxyUrl,
    httpsProxy: proxyUrl,
    noProxy,
  })
  // both schemes go to the proxy, so only a NO_PROXY entry keeps a URL off it
  const exempt = noProxyMatcher(noProxy)
  declareProxyRouting(dispatcher, (url) => !exempt(url))
  return dispatcher
}
