/// read_url: fetch one http(s) page through the SSRF guard and hand its
/// readable text to the model, at most READ_URL_PAGE_CHARS at a time. HTML is
/// converted (html-text.ts); JSON, XML and plain text pass through unchanged.
/// GitHub blob addresses are rewritten to raw.githubusercontent.com, or to the
/// contents API when the settings carry a token — the token travels only to
/// api.github.com, per hop. The tool never throws: every failure is an object
/// with an English sentence and one of the ReadUrlErrorCode values.

import { ResponseTooLargeError, readBodyCapped } from '@genoffice/electron-utils/remote-image'
import { fetchWithSsrfGuard } from '@genoffice/electron-utils/safe-remote-url'
import { htmlToText } from './html-text'
import { readAiSettingsFile } from './media-tools'

/** The part of one page the model gets in one call; the rest is read with offset. */
export const READ_URL_PAGE_CHARS = 50_000
/** Download cap, applied before and while the body is read (readBodyCapped). */
export const READ_URL_MAX_BYTES = 10 * 1024 * 1024
/** One request's whole budget: connect, redirects and body read together. */
export const READ_URL_TIMEOUT_MS = 30_000
/** The guard follows at most ten redirects; every hop is checked. */
const READ_URL_MAX_REDIRECTS = 10
/** Pages held in process memory, per final address, so a page's continuations do not re-download. */
const READ_URL_CACHE_TTL_MS = 3 * 60_000
const READ_URL_CACHE_MAX_ENTRIES = 8

const USER_AGENT = 'Mozilla/5.0'
const GITHUB_RAW_ACCEPT = 'application/vnd.github.raw+json'
/** Hosts whose refusals get the GitHub-specific hints (private repo, token). */
const GITHUB_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
  'api.github.com',
])

export type ReadUrlErrorCode =
  | 'invalid_url'
  | 'blocked'
  | 'network'
  | 'timeout'
  | 'http_error'
  | 'unsupported_type'
  | 'too_large'
  | 'empty'
  | 'auth'

export interface ReadUrlSuccess {
  ok: true
  /** the final address after redirects (the GitHub rewrite already applied) */
  url: string
  title?: string
  text: string
  /** where this slice of the text starts */
  offset: number
  totalChars: number
  truncated: boolean
  /** where the next slice starts; only when truncated */
  nextOffset?: number
}

export interface ReadUrlFailure {
  ok: false
  error: string
  errorCode: ReadUrlErrorCode
  /** the HTTP status behind an http_error; no other failure carries it */
  status?: number
}

export type ReadUrlResult = ReadUrlSuccess | ReadUrlFailure

export interface ReadUrlOptions {
  /** cancels the read; an aborted run discards the result before it reaches the screen */
  signal?: AbortSignal | undefined
  /** injectable for tests; defaults to global fetch */
  fetchImpl?: typeof fetch
  /** overrides the 30-second deadline (tests only) */
  timeoutMs?: number
}

/** One converted page, keyed by its final address and by the address that was asked for. */
interface PageCacheEntry {
  finalUrl: string
  title?: string
  text: string
  expiresAt: number
  /** every map key pointing at this entry, so eviction drops them together */
  keys: string[]
}

/** Process memory only: pages are re-downloaded after a restart, which is fine. */
const pageCache = new Map<string, PageCacheEntry>()

function failure(
  errorCode: ReadUrlErrorCode,
  error: string,
  extra: { status?: number } = {},
): ReadUrlFailure {
  return {
    ok: false,
    error,
    errorCode,
    ...(extra.status !== undefined ? { status: extra.status } : {}),
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function clip(value: string): string {
  return value.length > 120 ? `${value.slice(0, 120)}...` : value
}

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** The display name of a page in the model-facing text: its title, else its host. */
function hostForLabel(rawUrl: string): string {
  try {
    return new URL(rawUrl).host
  } catch {
    return rawUrl
  }
}

function githubPathParts(
  url: URL,
): { owner: string; repo: string; ref: string; file: string } | null {
  const host = url.hostname.toLowerCase()
  if (host !== 'github.com' && host !== 'www.github.com') return null
  const parts = url.pathname.split('/').filter((part) => part !== '')
  if (parts.length < 5) return null
  const [owner, repo, kind, ref, ...rest] = parts
  const file = rest.join('/')
  // exactly one ref segment: a branch name with a slash cannot be told apart from
  // the file path, so it is not guessed (the failure comes back from GitHub's answer)
  if (kind !== 'blob' || !owner || !repo || !ref || !file) return null
  return { owner, repo, ref, file }
}

/** A GitHub blob address as the request that actually serves its bytes. */
function githubRequest(
  target: URL,
  token: string,
): { url: string; blobApi: boolean; tokenForApi: boolean } {
  const blob = githubPathParts(target)
  if (!blob) {
    const url = target.toString()
    // a contents address the model gave directly carries the token too, but not the raw Accept:
    // its own answer (a directory listing, file metadata) is what should be read
    return { url, blobApi: false, tokenForApi: token !== '' && hostOf(url) === 'api.github.com' }
  }
  if (!token) {
    return {
      url: `https://raw.githubusercontent.com/${blob.owner}/${blob.repo}/${blob.ref}/${blob.file}`,
      blobApi: false,
      tokenForApi: false,
    }
  }
  return {
    url: `https://api.github.com/repos/${blob.owner}/${blob.repo}/contents/${blob.file}?ref=${encodeURIComponent(blob.ref)}`,
    blobApi: true,
    tokenForApi: true,
  }
}

/** Headers for one hop: the token only ever rides an api.github.com request of this chain. */
function hopHeaders(
  hopUrl: string,
  request: { blobApi: boolean; tokenForApi: boolean },
  token: string,
): Record<string, string> {
  const base = { 'User-Agent': USER_AGENT }
  if (!request.tokenForApi || !token || hostOf(hopUrl) !== 'api.github.com') return base
  return request.blobApi
    ? { ...base, Accept: GITHUB_RAW_ACCEPT, Authorization: `Bearer ${token}` }
    : { ...base, Authorization: `Bearer ${token}` }
}

function httpFailure(status: number, host: string, hasToken: boolean): ReadUrlFailure {
  if (GITHUB_HOSTS.has(host) && hasToken && (status === 401 || status === 403)) {
    return failure(
      'auth',
      `GitHub rejected the GitHub token (HTTP ${status}). Check the GitHub token in the AI settings.`,
    )
  }
  if (GITHUB_HOSTS.has(host) && !hasToken && status === 404) {
    return failure(
      'auth',
      'GitHub answered with HTTP 404. If this file is in a private repository, add a GitHub token in the AI settings; otherwise check the address.',
    )
  }
  if (GITHUB_HOSTS.has(host) && hasToken && status === 404) {
    return failure(
      'http_error',
      'GitHub answered with HTTP 404 for this file; check the address and that the token can read this repository.',
      { status },
    )
  }
  return failure('http_error', `The server answered with HTTP ${status}.`, { status })
}

function unsupportedType(mime: string): ReadUrlFailure {
  const what = mime !== '' ? `a ${mime} file` : 'a binary file'
  return failure(
    'unsupported_type',
    `This address is ${what}, not a web page. Download it and attach the file instead.`,
  )
}

function tooLarge(): ReadUrlFailure {
  return failure(
    'too_large',
    'The page is larger than 10 MB. Download it and attach the file instead.',
  )
}

/** Content types read as page text; anything else is a download. */
function isReadableType(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime.endsWith('+json') ||
    mime === 'application/xml' ||
    mime === 'text/xml' ||
    mime === 'application/xhtml+xml' ||
    mime === 'application/vnd.github.raw'
  )
}

function hasNulByte(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte === 0) return true
  return false
}

function bomEncoding(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return 'utf-8'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  return undefined
}

/** `<meta charset>` / `<meta http-equiv=content-type content=...charset=…>` in the head bytes. */
function metaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 4096))
  const match = /<meta[^>]*charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head)
  return match?.[1]
}

/** The body as text: BOM first, then the declared charset, then the meta tag, then UTF-8. */
function decodeBody(
  bytes: Uint8Array,
  declaredCharset: string | undefined,
  allowMeta: boolean,
  bom: string | undefined,
): string {
  const label = bom ?? declaredCharset ?? (allowMeta ? metaCharset(bytes) : undefined) ?? 'utf-8'
  try {
    // broken characters become replacement characters, never a failure
    return new TextDecoder(label.trim().toLowerCase()).decode(bytes)
  } catch {
    // an unknown charset name reads as UTF-8
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function declaredCharsetOf(rawContentType: string | null): string | undefined {
  const match = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(rawContentType ?? '')
  return match?.[1]
}

function looksLikeHtml(text: string): boolean {
  return /^\s*(<!doctype\s+html|<html[\s>])/i.test(text)
}

function normalizeOffset(offset: unknown): number {
  // only a real number counts: "500", true and non-numbers read from the start
  return typeof offset === 'number' && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
}

function slicePage(
  entry: { finalUrl: string; title?: string; text: string },
  offset: number,
): ReadUrlSuccess {
  const totalChars = entry.text.length
  const text = offset >= totalChars ? '' : entry.text.slice(offset, offset + READ_URL_PAGE_CHARS)
  const end = offset + text.length
  const truncated = end < totalChars
  return {
    ok: true,
    url: entry.finalUrl,
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    text,
    offset,
    totalChars,
    truncated,
    ...(truncated ? { nextOffset: end } : {}),
  }
}

/** Every map key that still points at this entry; a newer entry for the same final address owns that key. */
function ownedKeys(entry: PageCacheEntry): string[] {
  return entry.keys.filter((key) => pageCache.get(key) === entry)
}

/** Drop the keys the entry still owns; a key another entry has taken over stays. */
function dropEntry(entry: PageCacheEntry): void {
  for (const key of ownedKeys(entry)) pageCache.delete(key)
}

/** A cached page, refreshing its recency; an expired one is dropped. */
function cachedPage(key: string, now: number): PageCacheEntry | undefined {
  const entry = pageCache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= now) {
    dropEntry(entry)
    return undefined
  }
  for (const owned of ownedKeys(entry)) {
    pageCache.delete(owned)
    pageCache.set(owned, entry)
  }
  return entry
}

function cachePage(
  page: { finalUrl: string; title?: string; text: string },
  requestUrl: string,
  now: number,
): PageCacheEntry {
  const keys = requestUrl === page.finalUrl ? [page.finalUrl] : [page.finalUrl, requestUrl]
  const entry: PageCacheEntry = { ...page, expiresAt: now + READ_URL_CACHE_TTL_MS, keys }
  // delete before set even for a key that already exists: the newest entry for an
  // address owns it, and the key moves to the newest position for eviction order
  for (const key of keys) pageCache.delete(key)
  for (const key of keys) pageCache.set(key, entry)
  let entries = new Set(pageCache.values())
  while (entries.size > READ_URL_CACHE_MAX_ENTRIES) {
    const oldestKey = pageCache.keys().next().value
    if (oldestKey === undefined) break
    const oldest = pageCache.get(oldestKey)
    pageCache.delete(oldestKey)
    if (oldest) dropEntry(oldest)
    entries = new Set(pageCache.values())
  }
  return entry
}

/**
 * The model-facing text of one read, shaped like drive_read: a name line with
 * the character window, the final address on its own line, then the text.
 */
export function readUrlModelText(result: ReadUrlSuccess): string {
  const end = result.offset + result.text.length
  const name =
    result.title !== undefined && result.title !== '' ? result.title : hostForLabel(result.url)
  return (
    `${name} — characters ${result.offset}..${end} of ${result.totalChars}` +
    (result.truncated ? ' (continue with offset)' : ' (end)') +
    `\n${result.url}\n\n${result.text}`
  )
}

/**
 * Read one web page as text. Never throws: the result says `ok: false` with an
 * English sentence and an error code. `offset` continues a long page from where
 * the previous call stopped (at most READ_URL_PAGE_CHARS per call).
 */
export async function readUrlTool(
  settingsPath: string,
  url: string,
  offset = 0,
  options: ReadUrlOptions = {},
): Promise<ReadUrlResult> {
  const start = normalizeOffset(offset)
  if (typeof url !== 'string') {
    return failure('invalid_url', 'The address must be an http or https URL.')
  }
  const trimmed = url.trim()
  let target: URL
  try {
    target = new URL(trimmed)
  } catch {
    return failure('invalid_url', `Not a usable web address: ${clip(trimmed)}`)
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return failure('invalid_url', 'Only http and https addresses can be read.')
  }

  // read live on every call, like the search tools: the token can change between calls
  const token = readAiSettingsFile(settingsPath).readUrl?.githubToken?.trim() ?? ''
  const request = githubRequest(target, token)
  const hasToken = token !== ''

  const now = Date.now()
  const cached = cachedPage(request.url, now)
  if (cached) return slicePage(cached, start)

  const configured = options.timeoutMs ?? READ_URL_TIMEOUT_MS
  const timeoutMs =
    Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : READ_URL_TIMEOUT_MS
  const deadline = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline
  // why the chain stopped: a fired deadline, or the caller cancelling. The
  // cancelled sentence is never shown: an aborted run discards its result
  // before it reaches the screen, and the result exists only so this function
  // can keep its no-throw promise.
  const stoppedFailure = (): ReadUrlFailure | undefined => {
    if (options.signal?.aborted) return failure('network', 'The read was cancelled.')
    if (deadline.aborted) return failure('timeout', 'The page did not answer within 30 seconds.')
    return undefined
  }

  const baseFetch = options.fetchImpl ?? fetch
  // the guard follows redirects internally; remembering the last requested
  // address is how the final address is known afterwards
  let finalUrl = request.url
  const trackingFetch: typeof fetch = (input, init) => {
    finalUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    return baseFetch(input, init)
  }

  let response: Response | null
  try {
    response = await fetchWithSsrfGuard(request.url, {
      maxRedirects: READ_URL_MAX_REDIRECTS,
      headers: { 'User-Agent': USER_AGENT },
      headersForHop: (hopUrl) => hopHeaders(hopUrl, request, token),
      signal,
      fetchImpl: trackingFetch,
    })
  } catch (err) {
    return stoppedFailure() ?? failure('network', `Could not reach the address: ${errorText(err)}`)
  }
  if (!response) {
    return (
      stoppedFailure() ??
      failure(
        'blocked',
        'Refused to fetch that address: it is, or redirects to, a private or loopback address.',
      )
    )
  }
  if (!response.ok) return httpFailure(response.status, hostOf(finalUrl), hasToken)

  const rawContentType = response.headers.get('content-type')
  const mime = (rawContentType ?? '').split(';')[0]!.trim().toLowerCase()
  // an absent or generic type is decided from the bytes themselves
  const sniff = mime === '' || mime === 'application/octet-stream'
  if (!sniff && !isReadableType(mime)) return unsupportedType(mime)

  let bytes: Uint8Array
  try {
    bytes = await readBodyCapped(response, READ_URL_MAX_BYTES)
  } catch (err) {
    const stopped = stoppedFailure()
    if (stopped) return stopped
    if (err instanceof ResponseTooLargeError) return tooLarge()
    return failure('network', `Could not download the page: ${errorText(err)}`)
  }
  const bom = bomEncoding(bytes)
  // a UTF-16 body carries NUL bytes; its BOM is what proves it is text
  if (sniff && bom === undefined && hasNulByte(bytes)) return unsupportedType('')

  let converted: { title?: string; text: string }
  try {
    // the meta charset is an HTML signal only: a `<meta charset=...>` string inside
    // JSON, XML or plain text must not change how those bytes are decoded
    const allowMeta = mime === 'text/html' || mime === 'application/xhtml+xml'
    const decoded = decodeBody(bytes, declaredCharsetOf(rawContentType), allowMeta, bom)
    const convertAsHtml =
      mime === 'text/html' || mime === 'application/xhtml+xml' || (sniff && looksLikeHtml(decoded))
    converted = convertAsHtml ? htmlToText(decoded, finalUrl) : { text: decoded }
  } catch {
    // conversion is best effort: bytes that cannot be turned into text are a download to attach
    return unsupportedType('')
  }
  if (converted.text.trim() === '') {
    return failure('empty', 'The page had no readable text.')
  }
  const entry = cachePage(
    {
      finalUrl,
      ...('title' in converted && converted.title !== undefined ? { title: converted.title } : {}),
      text: converted.text,
    },
    request.url,
    Date.now(),
  )
  return slicePage(entry, start)
}
