import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseDocx } from '@seuoffice/docx-engine'
import {
  convertLegacyDocToDocx,
  openLegacyDoc,
  parseFloatingPictures,
  readLegacyDocBody,
} from '../src/index'
import {
  SYNTHETIC_TEXT_OFFSET,
  buildSyntheticDoc,
  encodeBlipRecord,
  encodeChpxFkp,
  encodePicf,
  encodePictureChpx,
  type SyntheticBlip,
} from './helpers/synthetic-doc'

/**
 * A metafile blip is stored deflate-compressed, and the document alone says
 * how much it inflates to: a few kilobytes of zeros stand for any size. The
 * importer inflates up to its limit, omits a picture past it, and converts
 * the rest of the document.
 */

/** 96 MiB of zeros: past the importer's limit, and under 100 KiB once deflated. */
const BOMB: SyntheticBlip = { kind: 'wmf', bytes: new Uint8Array(96 * 1024 * 1024) }

/** placeable WMF header, then bytes that do not compress to nothing */
function patternedWmf(length: number): Uint8Array {
  const out = new Uint8Array(length)
  let state = 0x2f6e2b1
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    // long runs with noise in between: compresses, but not away
    out[index] = index % 512 < 384 ? index & 0x3f : state >>> 24
  }
  out.set([0xd7, 0xcd, 0xc6, 0x9a], 0)
  return out
}

async function mediaPartsOf(docx: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(docx)
  const parts = new Map<string, Uint8Array>()
  for (const [path, entry] of Object.entries(zip.files)) {
    if (path.startsWith('word/media/') && !entry.dir) {
      parts.set(path, await entry.async('uint8array'))
    }
  }
  return parts
}

function inlineDoc(payload: Uint8Array): Uint8Array {
  const text = 'Before \u0001\rAfter\r'
  const fc = SYNTHETIC_TEXT_OFFSET + text.indexOf('\u0001') * 2
  return buildSyntheticDoc({
    pieces: [{ text }],
    chpxFkpPages: [encodeChpxFkp([{ fcStart: fc, fcEnd: fc + 2, grpprl: encodePictureChpx(0) }])],
    dataStream: encodePicf({ payload, xExt: 1440, yExt: 720 }),
  })
}

describe('a compressed picture that inflates past the limit', () => {
  it('floating: the picture is omitted and reported, the rest of the document converts', async () => {
    const small = patternedWmf(4096)
    const bytes = buildSyntheticDoc({
      pieces: [{ text: 'Anchor \u0008here \u0008too\rNext\r' }],
      floatingShapes: [
        { story: 'body', cp: 7, rect: [0, 0, 1440, 720], blip: BOMB },
        { story: 'body', cp: 13, rect: [0, 0, 1440, 720], blip: { kind: 'wmf', bytes: small } },
      ],
    })
    // the whole document is a small file: the size is in the inflation alone
    expect(bytes.length).toBeLessThan(512 * 1024)

    const pictures = parseFloatingPictures(openLegacyDoc(bytes))
    expect(pictures.body).toHaveLength(1)
    expect(pictures.warnings.filter((warning) => warning.includes('omitted'))).toHaveLength(1)

    const { docx, warnings } = await convertLegacyDocToDocx(bytes)
    expect(warnings.filter((warning) => warning.includes('omitted'))).toHaveLength(1)
    const media = await mediaPartsOf(docx)
    expect([...media.keys()]).toEqual(['word/media/image1.wmf'])
    expect(Buffer.from(media.get('word/media/image1.wmf')!).equals(Buffer.from(small))).toBe(true)
    const zip = await JSZip.loadAsync(docx)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('Anchor here too')
    expect(xml).toContain('Next')
    await expect(parseDocx(docx)).resolves.toBeDefined()
  }, 120_000)

  it('inline: the picture is omitted and reported, the text around it stays', async () => {
    const bytes = inlineDoc(encodeBlipRecord(BOMB))
    const body = readLegacyDocBody(bytes)
    expect(body.warnings.filter((warning) => warning.includes('omitted'))).toHaveLength(1)

    const { docx, warnings } = await convertLegacyDocToDocx(bytes)
    expect(warnings.filter((warning) => warning.includes('omitted'))).toHaveLength(1)
    expect((await mediaPartsOf(docx)).size).toBe(0)
    const zip = await JSZip.loadAsync(docx)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('Before')
    expect(xml).toContain('After')
    await expect(parseDocx(docx)).resolves.toBeDefined()
  }, 120_000)
})

describe('a compressed picture within the limit', () => {
  it('comes through byte for byte, floating and inline, at metafile sizes large and small', async () => {
    for (const length of [64, 8 * 1024 * 1024]) {
      const wmf = patternedWmf(length)
      const floating = buildSyntheticDoc({
        pieces: [{ text: 'Anchor \u0008here\rNext\r' }],
        floatingShapes: [
          { story: 'body', cp: 7, rect: [0, 0, 1440, 720], blip: { kind: 'wmf', bytes: wmf } },
        ],
      })
      const inline = inlineDoc(encodeBlipRecord({ kind: 'emf', bytes: wmf }))
      for (const [bytes, part] of [
        [floating, 'word/media/image1.wmf'],
        [inline, 'word/media/image1.emf'],
      ] as const) {
        const { docx, warnings } = await convertLegacyDocToDocx(bytes)
        expect(warnings.some((warning) => warning.includes('omitted'))).toBe(false)
        const media = await mediaPartsOf(docx)
        expect([...media.keys()]).toEqual([part])
        expect(Buffer.from(media.get(part)!).equals(Buffer.from(wmf))).toBe(true)
      }
    }
  }, 120_000)
})
