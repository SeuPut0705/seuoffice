import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchRemoteImage = vi.fn()
const readBodyCapped = vi.fn()

vi.mock('../src/remote-image', () => ({
  fetchRemoteImage: (...args: unknown[]) => fetchRemoteImage(...(args as [])),
  readBodyCapped: (...args: unknown[]) => readBodyCapped(...(args as [])),
  MAX_REMOTE_IMAGE_BYTES: 4096,
}))

let fetchImageBytes: typeof import('../src/fetch-image-bytes').fetchImageBytes

beforeEach(async () => {
  vi.resetModules()
  fetchRemoteImage.mockReset()
  readBodyCapped.mockReset()
  ;({ fetchImageBytes } = await import('../src/fetch-image-bytes'))
})

const response = (contentType: string) => ({
  ok: true,
  headers: { get: (name: string) => (name === 'content-type' ? contentType : null) },
})

describe('fetchImageBytes', () => {
  it('lets the generated-image store answer a file:// URL (the generate_image path)', async () => {
    fetchRemoteImage.mockResolvedValue(response('image/png'))
    readBodyCapped.mockResolvedValue(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))
    const url = 'file:///C:/Users/me/AppData/Local/Temp/genoffice-ai-images/a.png'
    const r = await fetchImageBytes(url)
    // no scheme check here: fetchRemoteImage decides which file:// URLs may be read
    expect(fetchRemoteImage).toHaveBeenCalledWith(url)
    expect(r).toEqual({
      base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      mime: 'image/png',
    })
  })

  it('labels png, gif and everything else like the editors do', async () => {
    readBodyCapped.mockResolvedValue(Uint8Array.from([1]))
    for (const [contentType, mime] of [
      ['image/png', 'image/png'],
      ['image/gif', 'image/gif'],
      ['image/jpeg', 'image/jpeg'],
      ['image/webp', 'image/jpeg'],
    ] as const) {
      fetchRemoteImage.mockResolvedValue(response(contentType))
      expect(await fetchImageBytes('https://example.com/a')).toEqual({
        base64: Buffer.from([1]).toString('base64'),
        mime,
      })
    }
  })

  it('answers null for a blocked or failed download, a throw, and a non-string', async () => {
    fetchRemoteImage.mockResolvedValue(null)
    expect(await fetchImageBytes('https://example.com/a.png')).toBeNull()
    fetchRemoteImage.mockResolvedValue({ ok: false, headers: { get: () => null } })
    expect(await fetchImageBytes('https://example.com/a.png')).toBeNull()
    fetchRemoteImage.mockRejectedValue(new Error('boom'))
    expect(await fetchImageBytes('https://example.com/a.png')).toBeNull()
    fetchRemoteImage.mockClear()
    expect(await fetchImageBytes(undefined)).toBeNull()
    expect(await fetchImageBytes('')).toBeNull()
    expect(fetchRemoteImage).not.toHaveBeenCalled()
  })
})
