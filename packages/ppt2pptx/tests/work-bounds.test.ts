import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { convertPptToPptx, parsePptPresentation, type PptPresentation } from '../src/index'
import { buildPptContainer, buildPptStreams, type SlideSpec } from './synthetic-ppt'

/**
 * The work a .ppt can demand must follow its size. A slide list may name one
 * slide container any number of times (by one persist id, or by many that
 * resolve to it), and slide containers may sit inside each other, so a small
 * file could otherwise ask for its text thousands of times over.
 */

const pptBytesOf = (streams: { document: Uint8Array; currentUser: Uint8Array }): Uint8Array =>
  buildPptContainer(streams.document, streams.currentUser)

/** 1,024 paragraphs of 63 characters: 64 KiB of slide text with its paragraph marks. */
const LINES = Array.from({ length: 1024 }, (_unused, index) => `line ${index} `.padEnd(63, 'x'))
const BODY = LINES.join('\r')
const oneSlide: SlideSpec[] = [{ textSequences: [{ kind: 1, text: BODY, atom: 'bytes' }] }]

const textLengthOf = (presentation: PptPresentation): number =>
  presentation.slides.reduce(
    (sum, slide) => sum + slide.textSequences.reduce((inner, s) => inner + s.text.length, 0),
    0,
  )

async function slideTextsOf(pptx: Uint8Array): Promise<string[][]> {
  const zip = await JSZip.loadAsync(pptx)
  const parts = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
  const texts: string[][] = []
  for (const path of parts) {
    const xml = await zip.file(path)!.async('string')
    texts.push([...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]!))
  }
  return texts
}

describe('a slide list that names one slide thousands of times', () => {
  it('reads the slide once: one slide, its text once', () => {
    const { document, currentUser } = buildPptStreams(oneSlide, { slideListRepeats: 4096 })
    const presentation = parsePptPresentation(document, currentUser)
    expect(presentation.slides).toHaveLength(1)
    expect(textLengthOf(presentation)).toBe(BODY.length)
    // 4,096 entries name the slide; 4,095 of them are reported as left out
    expect(presentation.warnings).toHaveLength(1)
    expect(presentation.warnings[0]).toContain('4095')
  }, 120_000)

  it('converts in bounded time to a deck with that one slide, and says what it left out', async () => {
    const bytes = pptBytesOf(buildPptStreams(oneSlide, { slideListRepeats: 4096 }))
    const started = performance.now()
    const out = await convertPptToPptx(bytes)
    const elapsed = performance.now() - started
    expect(out.slideCount).toBe(1)
    expect(await slideTextsOf(out.bytes)).toEqual([LINES])
    expect(out.warnings.some((warning) => warning.includes('4095'))).toBe(true)
    // one 64 KiB slide converts in tens of milliseconds; 4,096 copies took most of a minute
    expect(elapsed).toBeLessThan(10_000)
  }, 120_000)

  it('reads the slide once when every listing has a persist id of its own', () => {
    const { document, currentUser } = buildPptStreams(oneSlide, {
      slideListRepeats: 4096,
      aliasRepeats: true,
    })
    const presentation = parsePptPresentation(document, currentUser)
    expect(presentation.slides).toHaveLength(1)
    expect(textLengthOf(presentation)).toBe(BODY.length)
    expect(presentation.warnings).toHaveLength(1)
    expect(presentation.warnings[0]).toContain('4095')
  }, 120_000)

  it('keeps a deck that lists each slide once free of warnings', () => {
    const specs: SlideSpec[] = [
      { textSequences: [{ kind: 0, text: 'First' }] },
      { textSequences: [{ kind: 0, text: 'Second' }] },
    ]
    const { document, currentUser } = buildPptStreams(specs)
    const presentation = parsePptPresentation(document, currentUser)
    expect(presentation.slides.map((slide) => slide.textSequences.map((s) => s.text))).toEqual([
      ['First'],
      ['Second'],
    ])
    expect(presentation.warnings).toEqual([])
  })
})

describe('the text of the whole deck', () => {
  it('refuses slide containers that sit inside each other', () => {
    // 512 KiB of text inside 40 slide containers, each listed as a slide of
    // its own: read as they are listed, 20 MiB of text out of a half-megabyte file
    const big: SlideSpec[] = [
      { textSequences: [{ kind: 1, text: 'x'.repeat(512 * 1024), atom: 'bytes' }] },
    ]
    const { document, currentUser } = buildPptStreams(big, { nestSlides: 39 })
    expect(document.length).toBeLessThan(600 * 1024)
    expect(() => parsePptPresentation(document, currentUser)).toThrowError(
      expect.objectContaining({ name: 'LegacyPptError', code: 'bad_slide' }),
    )
  }, 120_000)

  it('refuses a deck with more text than any real deck holds', () => {
    // twice the text of War and Peace, each character stored once
    const huge: SlideSpec[] = [
      { textSequences: [{ kind: 1, text: 'x'.repeat(6 * 1024 * 1024), atom: 'bytes' }] },
    ]
    const { document, currentUser } = buildPptStreams(huge)
    expect(() => parsePptPresentation(document, currentUser)).toThrowError(
      expect.objectContaining({ name: 'LegacyPptError', code: 'limits_exceeded' }),
    )
  }, 120_000)

  it('refuses a deck whose paragraphs outnumber any real deck', async () => {
    // every byte a paragraph mark: the writer spends a hundred bytes of markup on each
    const marks: SlideSpec[] = [
      { textSequences: [{ kind: 1, text: 'x' + '\r'.repeat(300_000), atom: 'bytes' }] },
    ]
    await expect(convertPptToPptx(pptBytesOf(buildPptStreams(marks)))).rejects.toMatchObject({
      name: 'LegacyPptError',
      code: 'limits_exceeded',
    })
  }, 120_000)

  it('converts a text-heavy deck far larger than a real one, whole', async () => {
    // 500 slides of 4,000 characters in 40 paragraphs: two million characters
    const paragraph = 'Revenue grew twelve percent over the prior period, led by services. '
    const text = Array.from({ length: 40 }, () => paragraph.padEnd(99, '.')).join('\r')
    const specs: SlideSpec[] = Array.from({ length: 500 }, (_unused, index) => ({
      textSequences: [
        { kind: 0, text: `Slide ${index + 1}` },
        { kind: 1, text, atom: 'bytes' as const },
      ],
    }))
    const streams = buildPptStreams(specs)
    expect(parsePptPresentation(streams.document, streams.currentUser).warnings).toEqual([])
    const out = await convertPptToPptx(pptBytesOf(streams))
    expect(out.slideCount).toBe(500)
    const texts = await slideTextsOf(out.bytes)
    expect(texts).toHaveLength(500)
    expect(texts[499]![0]).toBe('Slide 500')
    expect(texts.every((slide) => slide.length === 41)).toBe(true)
  }, 120_000)
})
