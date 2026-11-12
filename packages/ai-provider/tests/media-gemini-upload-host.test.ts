import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAiTransientRetryDelays } from '../src/fetch'
import { analyzeMediaWithProvider } from '../src/media-protocols'
import { carriers, closeServers, collector, json, messageOf, serve } from './two-servers'

/**
 * Media too large to send inline goes through Gemini's Files API: a start
 * request, whose reply names the address the bytes are sent to (the
 * `x-goog-upload-url` header). The bytes go out with the API key, so that
 * address is used only on the origin the start request went to.
 */

const KEY = 'secret-api-key'
/** one byte over the inline limit, with a mark to find it by */
const MARK = 'PRIVATE-MEDIA'
const video = (): { bytes: Uint8Array; mime: string } => {
  const bytes = new Uint8Array(18 * 1024 * 1024 + 1)
  bytes.set(new TextEncoder().encode(MARK))
  return { bytes, mime: 'video/mp4' }
}

const gemini = (origin: string) => ({
  apiKey: KEY,
  baseUrl: `${origin}/v1beta`,
  imageModel: '',
  analysisModel: 'gemini-3.7-flash',
})

const analyze = (origin: string): Promise<string> =>
  analyzeMediaWithProvider('gemini', gemini(origin), {
    media: [video()],
    requirements: 'describe',
  })

const REFUSED = /upload address that is not its own.*API key was not sent to it/is

beforeEach(() => setAiTransientRetryDelays([]))

afterEach(async () => {
  vi.unstubAllGlobals()
  setAiTransientRetryDelays(null)
  await closeServers()
})

describe('where a Gemini file upload goes', () => {
  it('sends neither the key nor the file to another host the start reply names', async () => {
    const other = await collector({ file: { state: 'ACTIVE', uri: 'files/abc' } })
    const provider = await serve((_seen, res) =>
      json(res, {}, { 'x-goog-upload-url': `${other.origin}/upload/v1beta/files?upload_id=1` }),
    )

    const message = await messageOf(analyze(provider.origin))

    expect(other.seen).toEqual([])
    expect(message).toMatch(REFUSED)
    expect(message).toContain(other.origin)
    // the start is the only request of the whole analysis
    expect(provider.seen.map((request) => request.path)).toEqual(['/upload/v1beta/files'])
  }, 30_000)

  it('holds the upload to the same port and scheme, not just the same host name', async () => {
    const other = await collector({ file: { state: 'ACTIVE', uri: 'files/abc' } })
    const port = new URL(other.origin).port
    for (const named of [
      // the same machine, another server
      `http://localhost:${port}/session`,
      // the provider's own name over another scheme
      (origin: string) => origin.replace('http:', 'https:') + '/session',
    ]) {
      const provider = await serve((_seen, res) =>
        json(
          res,
          {},
          { 'x-goog-upload-url': typeof named === 'string' ? named : named(provider.origin) },
        ),
      )
      const message = await messageOf(analyze(provider.origin))
      expect(message).toMatch(REFUSED)
      expect(provider.seen).toHaveLength(1)
    }
    expect(other.seen).toEqual([])
  }, 30_000)

  it('refuses an upload address that is no URL', async () => {
    const provider = await serve((_seen, res) =>
      json(res, {}, { 'x-goog-upload-url': 'http://[not-a-host/session' }),
    )
    const message = await messageOf(analyze(provider.origin))
    expect(message).toMatch(/upload address that is not a URL.*API key was not sent to it/is)
    expect(provider.seen).toHaveLength(1)
  }, 30_000)

  it('uploads to the address on the origin the session started on, then analyzes', async () => {
    const provider = await serve((seen, res) => {
      if (seen.path === '/upload/v1beta/files') {
        json(res, {}, { 'x-goog-upload-url': `${provider.origin}/upload/session?upload_id=1` })
      } else if (seen.path === '/upload/session?upload_id=1') {
        json(res, { file: { state: 'ACTIVE', uri: 'files/abc', mimeType: 'video/mp4' } })
      } else {
        json(res, { candidates: [{ content: { parts: [{ text: 'a summary' }] } }] })
      }
    })

    expect(await analyze(provider.origin)).toBe('a summary')
    expect(provider.seen.map((request) => request.path)).toEqual([
      '/upload/v1beta/files',
      '/upload/session?upload_id=1',
      '/v1beta/models/gemini-3.7-flash:generateContent',
    ])
    // the file went with the second request, the key with all three
    expect(provider.seen[1]!.body.startsWith(MARK)).toBe(true)
    expect(carriers(provider.seen, KEY)).toEqual([
      'x-goog-api-key',
      'x-goog-api-key',
      'x-goog-api-key',
    ])
  }, 30_000)
})
