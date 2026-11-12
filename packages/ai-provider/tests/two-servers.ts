import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Real servers on 127.0.0.1 for the tests of where a credential goes: one
 * plays the provider, another the party a redirect or a reply names. Each
 * records what reaches it, so "nothing was sent there" is read off the wire.
 */

export interface Seen {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: string
}

export interface TestServer {
  origin: string
  seen: Seen[]
}

export type Answer = (seen: Seen, res: ServerResponse) => void

const closers: (() => Promise<void>)[] = []

export async function serve(answer: Answer): Promise<TestServer> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    // the request body is read to its end before the answer goes out
    req.on('end', () => {
      const entry = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('latin1'),
      }
      seen.push(entry)
      answer(entry, res)
    })
  })
  // the package's lib target has no Promise.withResolvers
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

/** call from `afterEach` */
export async function closeServers(): Promise<void> {
  await Promise.all(closers.splice(0).map((close) => close()))
}

export function json(
  res: ServerResponse,
  body: unknown,
  headers: Record<string, string> = {},
  status = 200,
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

export function redirect(res: ServerResponse, status: number, location: string): void {
  res.writeHead(status, { location })
  res.end()
}

/** the other party: it answers every request with `body`, as a provider that took the credential would */
export function collector(body: unknown = {}): Promise<TestServer> {
  return serve((_seen, res) => json(res, body))
}

/** where a request carried `secret`: the names of its headers, `url`, `body` */
export function carriers(seen: Seen[], secret: string): string[] {
  return seen.flatMap((request) => [
    ...Object.entries(request.headers)
      .filter(([, value]) => String(value).includes(secret))
      .map(([name]) => name),
    ...(request.path.includes(secret) ? ['url'] : []),
    ...(request.body.includes(secret) ? ['body'] : []),
  ])
}

export function messageOf(run: Promise<unknown>): Promise<string> {
  return run.then(
    () => 'no error',
    (error: unknown) => String((error as Error).message),
  )
}
