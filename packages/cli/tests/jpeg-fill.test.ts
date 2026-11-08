import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { imageSize } from '../src/formats/image-size'
import { readImageSource } from '../src/formats/image-source'
import { run, tempDir } from './helpers'

// A real 4x3 RGB JPEG generated from a solid-color pixel buffer.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJmAcir/2Q==',
  'base64',
)
function padded(marker: number, count: number): Buffer {
  const offset = JPEG.indexOf(Buffer.from([0xff, marker]))
  if (offset < 0) throw new Error('fixture marker missing')
  return Buffer.concat([JPEG.subarray(0, offset), Buffer.alloc(count, 0xff), JPEG.subarray(offset)])
}

describe('JPEG marker fill bytes', () => {
  it.each([
    [0xe0, 1],
    [0xe0, 7],
    [0xc0, 1],
    [0xc0, 32],
  ])('reads dimensions with fill before marker %s (%s bytes)', (marker, count) => {
    expect(imageSize(padded(marker, count))).toEqual({ width: 4, height: 3, mime: 'image/jpeg' })
  })
  it('retains ordinary JPEG dimensions', () => {
    expect(imageSize(JPEG)).toEqual({ width: 4, height: 3, mime: 'image/jpeg' })
  })
  it('rejects a truncated fill run', () => {
    expect(imageSize(Buffer.from([0xff, 0xd8, ...Array(30).fill(0xff)]))).toBeNull()
  })
  it('rejects a frame segment extending beyond the supplied bytes', () => {
    const offset = JPEG.indexOf(Buffer.from([0xff, 0xc0]))
    const bytes = Buffer.from(JPEG.subarray(0, offset + 10))
    expect(imageSize(bytes)).toBeNull()
  })
  it('sniffs the JPEG type despite a misleading data URL declaration', async () => {
    const bytes = padded(0xc0, 2)
    const source = await readImageSource(`data:image/png;base64,${bytes.toString('base64')}`, {
      cwd: tempDir(),
      env: {},
    })
    expect(source).toMatchObject({ mime: 'image/jpeg', ext: 'jpg' })
    expect(Buffer.from(source!.bytes)).toEqual(bytes)
  })
  it('keeps a filled JPEG when creating a Word document from Markdown', async () => {
    const dir = tempDir()
    const bytes = padded(0xc0, 2)
    writeFileSync(join(dir, 'photo.jpg'), bytes)
    const input = join(dir, 'input.md')
    writeFileSync(input, '![Solid color](photo.jpg)')
    const output = join(dir, 'out.docx')
    const result = await run([
      'create',
      '--type',
      'docx',
      '--from',
      input,
      '--out',
      output,
      '--json',
    ])
    expect(result.code).toBe(0)
    const zip = await JSZip.loadAsync(readFileSync(output))
    const pictures = Object.values(zip.files).filter(
      (file) => file.name.startsWith('word/media/') && !file.dir,
    )
    expect(pictures).toHaveLength(1)
    expect(await pictures[0]!.async('nodebuffer')).toEqual(bytes)
    expect(await zip.file('word/document.xml')!.async('string')).toContain('<w:drawing>')
  })
})
