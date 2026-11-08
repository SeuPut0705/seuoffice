import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  READ_URL_MAX_BYTES,
  READ_URL_PAGE_CHARS,
  readUrlModelText,
  readUrlTool,
  type ReadUrlSuccess,
} from '../src/read-url'

type FetchImpl = typeof fetch

/** The app's settings file, with or without a read_url GitHub token. */
function settingsFile(githubToken?: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'genoffice-read-url-')), 'ai-settings.json')
  const readUrl = githubToken === undefined ? {} : { readUrl: { githubToken } }
  writeFileSync(path, JSON.stringify({ provider: 'auto', providers: {}, ...readUrl }))
  return path
}

interface Recorder {
  fetchImpl: FetchImpl
  /** every requested address, in order */
  urls: string[]
  /** the lower-cased headers of every request, in order */
  headers: Array<Record<string, string>>
}

function headersOf(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!init) return out
  if (init instanceof Headers) init.forEach((value, key) => (out[key.toLowerCase()] = value))
  else if (Array.isArray(init))
    for (const [key, value] of init) out[String(key).toLowerCase()] = String(value)
  else for (const [key, value] of Object.entries(init)) out[key.toLowerCase()] = String(value)
  return out
}

/** A fake fetch answering from `route`; every request is recorded. */
function recordFetch(route: (url: string) => Response | undefined): Recorder {
  const rec: Recorder = {
    fetchImpl: () => Promise.reject(new Error('unset')),
    urls: [],
    headers: [],
  }
  rec.fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    rec.urls.push(url)
    rec.headers.push(headersOf(init?.headers))
    const response = route(url)
    if (!response) return Promise.reject(new Error(`unexpected request to ${url}`))
    return Promise.resolve(response)
  }) as FetchImpl
  return rec
}

function html(body: string, contentType = 'text/html'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

function text(body: string, contentType = 'text/plain'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } })
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

/** A fetch that never answers and rejects when its signal aborts, like the real one. */
function hangingFetch(): FetchImpl {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) reject(abortError())
      signal?.addEventListener('abort', () => reject(abortError()))
    })) as FetchImpl
}

describe('readUrlTool', () => {
  it('rejects a non-http(s) address without fetching', async () => {
    const { fetchImpl, urls } = recordFetch(() => undefined)
    for (const bad of ['ftp://8.8.8.8/file', 'file:///c:/x.txt', 'not a url', '']) {
      const result = await readUrlTool(settingsFile(), bad, 0, { fetchImpl })
      expect(result).toMatchObject({ ok: false, errorCode: 'invalid_url' })
    }
    expect(urls).toEqual([])
  })

  it('blocks a private address without fetching', async () => {
    const { fetchImpl, urls } = recordFetch(() => undefined)
    for (const blocked of [
      'http://127.0.0.1/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/x',
      'http://10.1.2.3/x',
      'http://metadata.internal/x',
    ]) {
      const result = await readUrlTool(settingsFile(), blocked, 0, { fetchImpl })
      expect(result).toMatchObject({ ok: false, errorCode: 'blocked' })
    }
    expect(urls).toEqual([])
  })

  it('refuses a redirect into a private address', async () => {
    const { fetchImpl, urls } = recordFetch((url) =>
      url === 'https://8.8.8.8/t4-redirect-in' ? redirect('http://169.254.169.254/') : undefined,
    )
    const result = await readUrlTool(settingsFile(), 'https://8.8.8.8/t4-redirect-in', 0, {
      fetchImpl,
    })
    expect(result).toMatchObject({ ok: false, errorCode: 'blocked' })
    expect(urls).toEqual(['https://8.8.8.8/t4-redirect-in'])
  })

  it('follows redirects and reads against the final address, then serves the same address from the cache', async () => {
    const body =
      '<html><head><title>Moved</title></head><body><p>Hello <a href="/next">next</a></p></body></html>'
    const { fetchImpl, urls } = recordFetch((url) =>
      url === 'https://8.8.8.8/t5-start'
        ? redirect('https://1.1.1.1/t5-final')
        : url === 'https://1.1.1.1/t5-final'
          ? html(body)
          : undefined,
    )
    const settings = settingsFile()
    const result = await readUrlTool(settings, 'https://8.8.8.8/t5-start', 0, { fetchImpl })
    expect(result).toMatchObject({ ok: true, url: 'https://1.1.1.1/t5-final', title: 'Moved' })
    if (!result.ok) throw new Error('expected ok')
    expect(result.text).toContain('[next](https://1.1.1.1/next)')
    expect(urls).toEqual(['https://8.8.8.8/t5-start', 'https://1.1.1.1/t5-final'])
    // the same address again: answered from memory, no second fetch
    const again = await readUrlTool(settings, 'https://8.8.8.8/t5-start', 0, { fetchImpl })
    expect(again).toMatchObject({ ok: true, url: 'https://1.1.1.1/t5-final' })
    expect(urls).toHaveLength(2)
  })

  it('keeps page text and drops scripts, styles, noscript, template and svg', async () => {
    const body = `<!doctype html><html><head><title>Docs</title><style>.x{color:red}</style></head>
<body>
<script>alert('script secret')</script>
<noscript>noscript secret</noscript>
<template><p>template secret</p></template>
<svg><text>svg secret</text></svg>
<h1>Heading</h1>
<p>First   paragraph
   with   spaces</p>
<img src="/a.png" alt="A picture">
<a href="https://docs.example.com/page">Docs link</a>
<ul><li>one</li><li>two</li></ul>
</body></html>`
    const { fetchImpl } = recordFetch(() => html(body))
    const result = await readUrlTool(settingsFile(), 'https://8.8.8.8/t6-html', 0, { fetchImpl })
    expect(result).toMatchObject({ ok: true, title: 'Docs' })
    if (!result.ok) throw new Error('expected ok')
    expect(result.text).toContain('Heading')
    expect(result.text).toContain('First paragraph with spaces')
    expect(result.text).toContain('A picture')
    expect(result.text).toContain('[Docs link](https://docs.example.com/page)')
    expect(result.text).toContain('one\ntwo')
    for (const secret of ['script secret', 'noscript secret', 'template secret', 'svg secret']) {
      expect(result.text).not.toContain(secret)
    }
  })

  it('uses the first h1 as the title when the page has no title', async () => {
    const { fetchImpl } = recordFetch(() =>
      html('<html><body><h1>Only heading</h1><p>x</p></body></html>'),
    )
    const result = await readUrlTool(settingsFile(), 'https://8.8.8.8/t7-h1', 0, { fetchImpl })
    expect(result).toMatchObject({ ok: true, title: 'Only heading' })
  })

  it('rejects a non-text content type and asks for an attachment', async () => {
    const { fetchImpl } = recordFetch(
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    )
    const result = await readUrlTool(settingsFile(), 'https://8.8.8.8/t8-image', 0, { fetchImpl })
    expect(result).toMatchObject({ ok: false, errorCode: 'unsupported_type' })
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toMatch(/attach/i)
  })

  it('sniffs an unknown content type: text passes, NUL bytes are refused', async () => {
    const rec = recordFetch((url) =>
      url.includes('t9-text')
        ? new Response('plain words', { headers: { 'content-type': 'application/octet-stream' } })
        : new Response(new Uint8Array([0x50, 0x4b, 0x00, 0x01]), {
            headers: { 'content-type': 'application/octet-stream' },
          }),
    )
    const asText = await readUrlTool(settingsFile(), 'https://8.8.8.8/t9-text', 0, {
      fetchImpl: rec.fetchImpl,
    })
    expect(asText).toMatchObject({ ok: true, text: 'plain words' })
    const binary = await readUrlTool(settingsFile(), 'https://8.8.8.8/t9-binary', 0, {
      fetchImpl: rec.fetchImpl,
    })
    expect(binary).toMatchObject({ ok: false, errorCode: 'unsupported_type' })
  })

  it('refuses a body the server declares over the cap before reading it', async () => {
    let pulled = false
    // highWaterMark 0: pull is called only when a reader asks, so a pull proves the body was read
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true
          controller.enqueue(new Uint8Array([1]))
        },
      },
      { highWaterMark: 0 },
    )
    const { fetchImpl } = recordFetch(
      () =>
        new Response(body, {
          headers: {
            'content-type': 'text/plain',
            'content-length': String(READ_URL_MAX_BYTES + 1),
          },
        }),
    )
    const result = await readUrlTool(settingsFile(), 'https://8.8.8.8/t10-declared-big', 0, {
      fetchImpl,
    })
    expect(result).toMatchObject({ ok: false, errorCode: 'too_large' })
    expect(pulled).toBe(false)
  })

  it('refuses a streamed body that passes the cap without declaring it', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(READ_URL_MAX_BYTES))
        controller.enqueue(new Uint8Array([1]))
        controller.close()
      },
    })
    const { fetchImpl } = recordFetch(
      () => new Response(stream, { headers: { 'content-type': 'text/plain' } }),
    )
    const result = await readUrlTool(settingsFile(), 'https://8.8.8.8/t11-streamed-big', 0, {
      fetchImpl,
    })
    expect(result).toMatchObject({ ok: false, errorCode: 'too_large' })
  })

  it('pages long text at 50,000 characters and continues from the offset out of the cache', async () => {
    const full = 'x'.repeat(READ_URL_PAGE_CHARS * 2 + 7)
    const { fetchImpl, urls } = recordFetch(() => text(full))
    const settings = settingsFile()
    const url = 'https://8.8.8.8/t12-long'
    const first = await readUrlTool(settings, url, 0, { fetchImpl })
    expect(first).toMatchObject({
      ok: true,
      offset: 0,
      totalChars: full.length,
      truncated: true,
      nextOffset: READ_URL_PAGE_CHARS,
    })
    if (!first.ok) throw new Error('expected ok')
    expect(first.text).toHaveLength(READ_URL_PAGE_CHARS)
    const second = await readUrlTool(settings, url, READ_URL_PAGE_CHARS, { fetchImpl })
    expect(second).toMatchObject({
      ok: true,
      offset: READ_URL_PAGE_CHARS,
      truncated: true,
      nextOffset: READ_URL_PAGE_CHARS * 2,
    })
    const third = await readUrlTool(settings, url, READ_URL_PAGE_CHARS * 2, { fetchImpl })
    expect(third).toMatchObject({ ok: true, truncated: false })
    if (!third.ok) throw new Error('expected ok')
    expect(third.text).toHaveLength(7)
    expect(third).not.toHaveProperty('nextOffset')
    const beyond = await readUrlTool(settings, url, 10_000_000, { fetchImpl })
    expect(beyond).toMatchObject({ ok: true, text: '', truncated: false })
    // every continuation was answered from the one download
    expect(urls).toHaveLength(1)
    // a negative or non-numeric offset reads from the start
    expect(await readUrlTool(settings, url, -5, { fetchImpl })).toMatchObject({
      ok: true,
      offset: 0,
    })
    expect(await readUrlTool(settings, url, Number.NaN, { fetchImpl })).toMatchObject({
      ok: true,
      offset: 0,
    })
    expect(urls).toHaveLength(1)
  })

  it('reads offset 0 unless the offset is a real number', async () => {
    const body = 'abcdefghij'
    const { fetchImpl, urls } = recordFetch(() => text(body))
    const settings = settingsFile()
    const url = 'https://8.8.8.8/t30-offset'
    for (const bogus of ['5', true, Number.POSITIVE_INFINITY] as unknown as number[]) {
      const result = await readUrlTool(settings, url, bogus, { fetchImpl })
      expect(result).toMatchObject({ ok: true, offset: 0, text: body })
    }
    const fractional = await readUrlTool(settings, url, 2.9, { fetchImpl })
    expect(fractional).toMatchObject({ ok: true, offset: 2, text: body.slice(2) })
    expect(urls).toHaveLength(1)
  })

  it('keeps a shared final address cached when the older redirect entry is evicted', async () => {
    const final = 'https://1.1.1.1/t31-final'
    const startA = 'https://8.8.8.8/t31-a'
    const startB = 'https://8.8.8.8/t31-b'
    const { fetchImpl, urls } = recordFetch((url) => {
      if (url === startA || url === startB) return redirect(final)
      if (url === final) return text('shared page')
      if (url.startsWith('https://8.8.8.8/t31-page-')) return text('page')
      return undefined
    })
    const settings = settingsFile()
    await readUrlTool(settings, startA, 0, { fetchImpl })
    await readUrlTool(settings, startB, 0, { fetchImpl })
    // fill the cache so the older redirect entry (the one that found the shared
    // address first) is evicted while the newer entry still holds it
    for (let i = 0; i < 7; i++) {
      await readUrlTool(settings, `https://8.8.8.8/t31-page-${i}`, 0, { fetchImpl })
    }
    const fetches = urls.length
    const again = await readUrlTool(settings, final, 0, { fetchImpl })
    expect(again).toMatchObject({ ok: true, url: final, text: 'shared page' })
    expect(urls).toHaveLength(fetches)
  })

  it('re-fetches after the three-minute cache window', async () => {
    vi.useFakeTimers()
    try {
      const { fetchImpl, urls } = recordFetch(() => text('once'))
      const settings = settingsFile()
      const url = 'https://8.8.8.8/t13-ttl'
      await readUrlTool(settings, url, 0, { fetchImpl })
      await readUrlTool(settings, url, 0, { fetchImpl })
      expect(urls).toHaveLength(1)
      vi.advanceTimersByTime(3 * 60_000 + 1)
      await readUrlTool(settings, url, 0, { fetchImpl })
      expect(urls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the most recent eight pages and lets the oldest go', async () => {
    const { fetchImpl, urls } = recordFetch(() => text('page'))
    const settings = settingsFile()
    const page = (i: number): string => `https://8.8.8.8/t14-page-${i}`
    for (let i = 0; i < 9; i++) await readUrlTool(settings, page(i), 0, { fetchImpl })
    expect(urls).toHaveLength(9)
    await readUrlTool(settings, page(0), 0, { fetchImpl })
    expect(urls).toHaveLength(10) // evicted by the ninth page
    await readUrlTool(settings, page(8), 0, { fetchImpl })
    expect(urls).toHaveLength(10) // the newest is still cached
  })

  it('refuses a page with no readable text', async () => {
    const rec = recordFetch((url) =>
      url.includes('t15-scripts')
        ? html('<html><head><title>t</title></head><body><script>var a=1</script></body></html>')
        : text('   \n  '),
    )
    const scripts = await readUrlTool(settingsFile(), 'https://8.8.8.8/t15-scripts', 0, {
      fetchImpl: rec.fetchImpl,
    })
    expect(scripts).toMatchObject({ ok: false, errorCode: 'empty' })
    const blank = await readUrlTool(settingsFile(), 'https://8.8.8.8/t15-blank', 0, {
      fetchImpl: rec.fetchImpl,
    })
    expect(blank).toMatchObject({ ok: false, errorCode: 'empty' })
  })

  it('returns JSON unchanged', async () => {
    const body = '{\n  "a": 1\n}'
    const { fetchImpl } = recordFetch(() => text(body, 'application/json; charset=utf-8'))
    const result = await readUrlTool(settingsFile(), 'https://8.8.8.8/t16-json', undefined, {
      fetchImpl,
    })
    expect(result).toMatchObject({ ok: true, text: body, totalChars: body.length })
    if (!result.ok) throw new Error('expected ok')
    expect(result.offset).toBe(0)
    expect(result.title).toBeUndefined()
  })

  it('decodes EUC-KR by the meta charset', async () => {
    const head = Buffer.from('<html><head><meta charset="euc-kr"></head><body><p>', 'ascii')
    const hangul = Buffer.from([0xbe, 0xc8, 0xb3, 0xe7]) // two EUC-KR syllables, asserted below
    const tail = Buffer.from('</p></body></html>', 'ascii')
    const { fetchImpl } = recordFetch(
      () =>
        new Response(Buffer.concat([head, hangul, tail]), {
          headers: { 'content-type': 'text/html' },
        }),
    )
    const result = await readUrlTool(settingsFile(), 'https://8.8.8.8/t17-kr', 0, { fetchImpl })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('expected ok')
    expect(result.text).toContain('안녕')
  })

  it('decodes a UTF-16 body by its BOM even when the content type is unknown', async () => {
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('BOM text', 'utf16le')])
    const { fetchImpl } = recordFetch(
      () => new Response(body, { headers: { 'content-type': 'application/octet-stream' } }),
    )
    const result = await readUrlTool(settingsFile(), 'https://8.8.8.8/t18-utf16', 0, { fetchImpl })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('expected ok')
    expect(result.text).toBe('BOM text')
  })

  it('falls back to UTF-8 for an unknown charset name', async () => {
    const { fetchImpl } = recordFetch(() => text('café', 'text/plain; charset=made-up-charset'))
    const result = await readUrlTool(settingsFile(), 'https://8.8.8.8/t19-charset', 0, {
      fetchImpl,
    })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('expected ok')
    expect(result.text).toBe('café')
  })

  it('ignores a meta charset in non-HTML bodies', async () => {
    const body = JSON.stringify({ note: "<meta charset='euc-kr'>", text: '안녕' })
    const rec = recordFetch((url) =>
      url.includes('t29-json-meta')
        ? text(body, 'application/json')
        : url.includes('t29-sniff-meta')
          ? new Response(body, { headers: { 'content-type': 'application/octet-stream' } })
          : text(body),
    )
    for (const url of [
      'https://8.8.8.8/t29-json-meta',
      'https://8.8.8.8/t29-text-meta',
      'https://8.8.8.8/t29-sniff-meta',
    ]) {
      const result = await readUrlTool(settingsFile(), url, 0, { fetchImpl: rec.fetchImpl })
      expect(result).toMatchObject({ ok: true })
      if (!result.ok) throw new Error('expected ok')
      expect(result.text).toBe(body)
    }
  })

  it('gives up on a hung request after its deadline', async () => {
    const result = await readUrlTool(settingsFile(), 'https://8.8.8.8/t20-hang', 0, {
      fetchImpl: hangingFetch(),
      timeoutMs: 30,
    })
    expect(result).toMatchObject({ ok: false, errorCode: 'timeout' })
  })

  it('times out when the deadline fires while the body is still arriving', async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(abortError()))
            },
          }),
          { headers: { 'content-type': 'text/plain' } },
        ),
      )) as FetchImpl
    const result = await readUrlTool(settingsFile(), 'https://8.8.8.8/t20b-slow-body', 0, {
      fetchImpl,
      timeoutMs: 40,
    })
    expect(result).toMatchObject({ ok: false, errorCode: 'timeout' })
  })

  it('returns a cancelled failure when the caller aborts, never throwing', async () => {
    const controller = new AbortController()
    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => (markStarted = resolve))
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
      markStarted()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(abortError()))
      })
    }) as FetchImpl
    const pending = readUrlTool(settingsFile(), 'https://8.8.8.8/t21-cancel', 0, {
      fetchImpl,
      signal: controller.signal,
    })
    await started
    controller.abort()
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: 'The read was cancelled.',
      errorCode: 'network',
    })
  })

  it('does not fetch when the caller signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetchImpl, urls } = recordFetch(() => text('never'))
    const result = await readUrlTool(settingsFile(), 'https://8.8.8.8/t22-prealready', 0, {
      fetchImpl,
      signal: controller.signal,
    })
    expect(result).toMatchObject({ ok: false, errorCode: 'network' })
    expect(urls).toHaveLength(0)
  })

  it('reports a transport failure as network', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection refused')
    }) as FetchImpl
    const result = await readUrlTool(settingsFile(), 'https://8.8.8.8/t23-net', 0, { fetchImpl })
    expect(result).toMatchObject({ ok: false, errorCode: 'network' })
  })

  it('reports a non-2xx answer with its status code', async () => {
    const { fetchImpl } = recordFetch(
      () => new Response('nope', { status: 503, headers: { 'content-type': 'text/html' } }),
    )
    const result = await readUrlTool(settingsFile(), 'https://8.8.8.8/t24-503', 0, { fetchImpl })
    expect(result).toMatchObject({ ok: false, errorCode: 'http_error', status: 503 })
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('503')
  })

  it('is exported from the package entry point', async () => {
    const index = await import('../src/index')
    expect(index.readUrlTool).toBeTypeOf('function')
  })
})

describe('readUrlTool GitHub addresses', () => {
  const blob = (repo: string): string => `https://github.com/acme/${repo}/blob/main/docs/SKILL.md`

  it('rewrites a blob address to raw.githubusercontent.com without a token', async () => {
    const raw = 'https://raw.githubusercontent.com/acme/raw-repo/main/docs/SKILL.md'
    const { fetchImpl, urls, headers } = recordFetch((url) =>
      url === raw
        ? new Response('# Skill\n\nDo the thing.', { headers: { 'content-type': 'text/plain' } })
        : undefined,
    )
    const result = await readUrlTool(settingsFile(), blob('raw-repo'), 0, { fetchImpl })
    expect(result).toMatchObject({ ok: true, url: raw })
    expect(urls).toEqual([raw])
    expect(headers[0]).not.toHaveProperty('authorization')
    if (!result.ok) throw new Error('expected ok')
    expect(result.text).toContain('# Skill')
  })

  it('reads a blob through the contents API when a token is set', async () => {
    const api = 'https://api.github.com/repos/acme/api-repo/contents/docs/SKILL.md?ref=main'
    const { fetchImpl, urls, headers } = recordFetch((url) =>
      url === api
        ? new Response('# Private\n\nbody', {
            headers: { 'content-type': 'application/vnd.github.raw+json; charset=utf-8' },
          })
        : undefined,
    )
    const result = await readUrlTool(settingsFile(' github_pat_test '), blob('api-repo'), 0, {
      fetchImpl,
    })
    expect(result).toMatchObject({ ok: true, url: api })
    expect(urls).toEqual([api])
    expect(headers[0]?.authorization).toBe('Bearer github_pat_test')
    expect(headers[0]?.accept).toContain('application/vnd.github.raw')
    if (!result.ok) throw new Error('expected ok')
    expect(result.text).toContain('# Private')
  })

  it('never sends the token on a redirect hop outside api.github.com', async () => {
    const api = 'https://api.github.com/repos/acme/redirect-repo/contents/docs/SKILL.md?ref=main'
    const raw = 'https://raw.githubusercontent.com/acme/redirect-repo/main/docs/SKILL.md'
    const { fetchImpl, urls, headers } = recordFetch((url) =>
      url === api ? redirect(raw) : url === raw ? text('moved') : undefined,
    )
    const result = await readUrlTool(settingsFile('github_pat_test'), blob('redirect-repo'), 0, {
      fetchImpl,
    })
    expect(result).toMatchObject({ ok: true, url: raw })
    expect(urls).toEqual([api, raw])
    expect(headers[0]?.authorization).toBe('Bearer github_pat_test')
    expect(headers[1]).not.toHaveProperty('authorization')
  })

  it('never sends the token to an address outside GitHub', async () => {
    const { fetchImpl, headers } = recordFetch(() => text('page'))
    const result = await readUrlTool(
      settingsFile('github_pat_test'),
      'https://8.8.8.8/t28-plain',
      0,
      {
        fetchImpl,
      },
    )
    expect(result).toMatchObject({ ok: true })
    expect(headers[0]).not.toHaveProperty('authorization')
  })

  it('sends the token to an api.github.com address given directly, without the raw Accept', async () => {
    const api = 'https://api.github.com/repos/acme/direct-api/contents/docs'
    const publicApi = 'https://api.github.com/repos/acme/direct-api/contents/public'
    const listing = '[\n  {"name": "SKILL.md"}\n]'
    const { fetchImpl, headers } = recordFetch((url) =>
      url === api || url === publicApi
        ? new Response(listing, { headers: { 'content-type': 'application/json' } })
        : undefined,
    )
    const withToken = await readUrlTool(settingsFile('github_pat_test'), api, 0, { fetchImpl })
    expect(withToken).toMatchObject({ ok: true, text: listing })
    expect(headers[0]?.authorization).toBe('Bearer github_pat_test')
    expect(headers[0]).not.toHaveProperty('accept')
    const withoutToken = await readUrlTool(settingsFile(), publicApi, 0, { fetchImpl })
    expect(withoutToken).toMatchObject({ ok: true })
    expect(headers[1]).not.toHaveProperty('authorization')
  })

  it('points a tokenless 404 at the GitHub token setting', async () => {
    const { fetchImpl } = recordFetch((url) =>
      url.startsWith('https://raw.githubusercontent.com/acme/gh404/')
        ? new Response('', { status: 404 })
        : undefined,
    )
    const result = await readUrlTool(settingsFile(), blob('gh404'), 0, { fetchImpl })
    expect(result).toMatchObject({ ok: false, errorCode: 'auth' })
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toMatch(/token/i)
  })

  it.each([401, 403])('points a GitHub %i with a token at the token check', async (status) => {
    const { fetchImpl } = recordFetch((url) =>
      url.startsWith('https://api.github.com/repos/acme/gh-denied/')
        ? new Response('', { status })
        : undefined,
    )
    const result = await readUrlTool(settingsFile('github_pat_test'), blob('gh-denied'), 0, {
      fetchImpl,
    })
    expect(result).toMatchObject({ ok: false, errorCode: 'auth' })
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain(String(status))
    expect(result.error).not.toContain('github_pat_test')
  })

  it('keeps a 404 with a token an http_error with the address hint', async () => {
    const { fetchImpl } = recordFetch((url) =>
      url.startsWith('https://api.github.com/repos/acme/gh-404-token/')
        ? new Response('', { status: 404 })
        : undefined,
    )
    const result = await readUrlTool(settingsFile('github_pat_test'), blob('gh-404-token'), 0, {
      fetchImpl,
    })
    expect(result).toMatchObject({ ok: false, errorCode: 'http_error', status: 404 })
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('404')
  })
})

describe('readUrlModelText', () => {
  it('formats like drive_read, with the final address and the end/continue markers', () => {
    const success: ReadUrlSuccess = {
      ok: true,
      url: 'https://example.com/a',
      title: 'Title',
      text: 'abc',
      offset: 0,
      totalChars: 3,
      truncated: false,
    }
    expect(readUrlModelText(success)).toBe(
      'Title — characters 0..3 of 3 (end)\nhttps://example.com/a\n\nabc',
    )
    const truncated: ReadUrlSuccess = { ...success, text: 'a', truncated: true, nextOffset: 1 }
    expect(readUrlModelText(truncated)).toBe(
      'Title — characters 0..1 of 3 (continue with offset)\nhttps://example.com/a\n\na',
    )
    const untitled: ReadUrlSuccess = { ...success, title: undefined, offset: 1, text: 'bc' }
    expect(readUrlModelText(untitled)).toBe(
      'example.com — characters 1..3 of 3 (end)\nhttps://example.com/a\n\nbc',
    )
  })
})
