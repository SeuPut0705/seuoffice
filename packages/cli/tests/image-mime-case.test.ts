import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { run, tempDir } from './helpers'

const env = { ...process.env, GENOFFICE_AUDIT_LOG: 'off' }

const fakes = vi.hoisted(() => ({ generate: vi.fn(), fetch: vi.fn() }))
vi.mock('@genoffice/ai-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-search')>()),
  generateImageTool: fakes.generate,
}))
vi.mock('@genoffice/electron-utils/remote-image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/electron-utils/remote-image')>()),
  fetchRemoteImage: fakes.fetch,
}))
vi.mock('../src/cloud', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cloud')>()),
  prepareCloud: vi.fn(async () => {}),
  headlessCall: vi.fn(async () => ({ settingsPath: 'unused', context: {} })),
}))

// One red pixel in each format, generated with Pillow; no provider or network is used.
const pixels = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  jpg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z',
  gif: 'R0lGODdhAQABAIEAAP8AAAAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==',
  webp: 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=',
}
const formats = [
  { mime: 'image/png', ext: 'png' },
  { mime: 'image/jpeg', ext: 'jpg' },
  { mime: 'image/gif', ext: 'gif' },
  { mime: 'image/webp', ext: 'webp' },
] as const

beforeEach(() => {
  fakes.generate.mockReset().mockResolvedValue({ url: 'https://example.com/generated' })
  fakes.fetch.mockReset()
})

describe('generated image media types are case-insensitive', () => {
  it.each(
    formats.flatMap(({ mime, ext }) => [
      { header: mime, mime, ext },
      { header: mime.toUpperCase(), mime, ext },
    ]),
  )('saves $header with .$ext and reports its canonical type', async ({ header, mime, ext }) => {
    const bytes = Buffer.from(pixels[ext], 'base64')
    fakes.fetch.mockResolvedValue(new Response(bytes, { headers: { 'content-type': header } }))
    const dir = tempDir()
    const out = join(dir, 'hero.png')
    const r = await run(['image', 'a red pixel', '--out', out, '--json'], { env })
    expect(r.code).toBe(0)
    const output = join(dir, `hero.${ext}`)
    expect(r.json().output_path).toBe(output)
    expect(r.json().detail.mime).toBe(mime)
    expect(readFileSync(output)).toEqual(bytes)
    if (ext !== 'png') {
      expect(existsSync(out)).toBe(false)
      expect(r.json().warnings).toContainEqual(expect.objectContaining({ code: 'output_renamed' }))
    } else expect(r.json().warnings).toBeUndefined()
  })

  it.each([
    {
      header: ' Image/JpEg ; name="x"',
      requested: 'hero.png',
      expected: 'hero.jpg',
      renamed: true,
    },
    { header: 'IMAGE/JPEG', requested: 'hero.JPEG', expected: 'hero.JPEG', renamed: false },
    { header: 'IMAGE/JPEG', requested: 'hero', expected: 'hero.jpg', renamed: false },
  ])(
    'keeps parameters, aliases and stems correct for $requested',
    async ({ header, requested, expected, renamed }) => {
      const bytes = Buffer.from(pixels.jpg, 'base64')
      fakes.fetch.mockResolvedValue(new Response(bytes, { headers: { 'content-type': header } }))
      const dir = tempDir()
      const r = await run(['image', 'a red pixel', '--out', join(dir, requested), '--json'], {
        env,
      })
      expect(r.code).toBe(0)
      expect(r.json().output_path).toBe(join(dir, expected))
      expect(r.json().detail.mime).toBe('image/jpeg')
      expect(readFileSync(join(dir, expected))).toEqual(bytes)
      expect(Boolean(r.json().warnings?.length)).toBe(renamed)
    },
  )

  it('keeps the PNG fallback when Content-Type is absent', async () => {
    const bytes = Buffer.from(pixels.png, 'base64')
    fakes.fetch.mockResolvedValue(new Response(new Uint8Array(bytes)))
    const out = join(tempDir(), 'hero.png')
    const r = await run(['image', 'a red pixel', '--out', out, '--json'], { env })
    expect(r.code).toBe(0)
    expect(r.json().detail.mime).toBe('image/png')
    expect(readFileSync(out)).toEqual(bytes)
  })
})
