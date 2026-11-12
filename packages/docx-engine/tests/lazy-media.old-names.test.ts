import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseDocx, saveDocx } from '../src/index'
import { lazyMediaUrl } from '../src/lazy-media'
import { lazyMediaHashesIn, materializeDocx, openZipFile } from '../src/zip-splice'
import { IMAGE_PARAGRAPH_XML, TINY_PNG_BASE64, buildDocx } from './helpers/build-docx'

/**
 * A crash-recovery copy whose pictures could not be put back is kept with the
 * placeholders it was built with (apps/docs `prepareRecoveryBytes`). One left
 * by an earlier version carries that version's placeholder header, and
 * restoring it must still show the pictures and save them, not the
 * placeholder, into the user's file.
 */

const HASH = 'b'.repeat(64)
const PNG = Buffer.from(TINY_PNG_BASE64, 'base64')

async function olderRecoveryCopy(): Promise<{ copy: Buffer; sourcePath: string }> {
  const original = await buildDocx({ bodyXml: IMAGE_PARAGRAPH_XML, withImage: true })
  const dir = await mkdtemp(join(tmpdir(), 'lazy-media-old-'))
  const sourcePath = join(dir, 'doc.docx')
  await writeFile(sourcePath, original)
  const zip = await JSZip.loadAsync(original)
  zip.file('word/media/image1.png', `GENOFFICE-LAZY-MEDIA\n${HASH}\n`)
  return { copy: Buffer.from(await zip.generateAsync({ type: 'uint8array' })), sourcePath }
}

describe('a recovery copy with placeholders an earlier version wrote', () => {
  it('names the document its pictures are served from', async () => {
    const { copy } = await olderRecoveryCopy()
    expect(await lazyMediaHashesIn(copy)).toEqual(new Set([HASH]))
  })

  it('opens with its pictures served from that document', async () => {
    const { copy } = await olderRecoveryCopy()
    const parsed = await parseDocx(copy)
    const image = parsed.blocks.find((b) => b.type === 'image')!
    expect(image.imageDataUrl).toBe(lazyMediaUrl(HASH, 'word/media/image1.png'))
    expect(parsed.extras.lazyMediaHashes).toEqual([HASH])
  })

  it('saves the real picture back into the file', async () => {
    const { copy, sourcePath } = await olderRecoveryCopy()
    const parsed = await parseDocx(copy)
    const blocks = parsed.blocks.flatMap((b) =>
      b.docxIndex == null ? [] : [{ kind: 'original' as const, docxIndex: b.docxIndex }],
    )
    const saved = Buffer.from(
      await saveDocx(parsed, [
        ...blocks,
        { kind: 'xml', xml: '<w:p><w:r><w:t>x</w:t></w:r></w:p>' },
      ]),
    )
    const full = await materializeDocx(saved, async (hash) =>
      hash === HASH ? openZipFile(sourcePath) : null,
    )
    const zip = await JSZip.loadAsync(full)
    expect(Buffer.from(await zip.file('word/media/image1.png')!.async('uint8array'))).toEqual(PNG)
  })
})
