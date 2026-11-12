/**
 * Quick Look inflates the preview picture of an .hwp when it is stored deflated. The file
 * alone decides how large that becomes, so it is inflated no further than a picture Quick
 * Look would show: one that goes past it gets no picture, as one too large always did.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { constants, deflateRawSync } from 'node:zlib'
import * as CFB from 'cfb'
import { describe, expect, it } from 'vitest'
import { extractEmbeddedThumbnail } from '../src/main/quick-look/extract'
import { REFUSAL_MS } from '../../../packages/compound-file/tests/helpers/raw-compound'

const MIB = 1024 * 1024
/** what the hostile preview inflates to: far more than any preview picture */
const BOMB_MIB = 256
const PREVIEW = '/PrvImage'

const memo = (): Buffer =>
  readFileSync(fileURLToPath(new URL('../../hwp/tests/fixtures/memo.hwp', import.meta.url)))

/**
 * A raw deflate stream of `mib` MiB of zeros, about a thousandth of that size, put together
 * from one deflated block so the test never holds what it inflates to.
 */
function deflatedZeros(mib: number): Buffer {
  // a block flushed in full ends on a byte and forgets what came before it, so it repeats
  const block = deflateRawSync(Buffer.alloc(MIB), { finishFlush: constants.Z_FULL_FLUSH })
  return Buffer.concat([...Array<Buffer>(mib).fill(block), deflateRawSync(Buffer.alloc(0))])
}

/** The Hangul-written fixture with the bytes of its preview picture replaced. */
function withPreview(content: Buffer): Buffer {
  const cfb = CFB.read(memo(), { type: 'buffer' })
  CFB.utils.cfb_add(cfb, PREVIEW, content)
  return Buffer.from(CFB.write(cfb, { type: 'buffer' }) as Buffer)
}

describe('Quick Look on an .hwp whose deflated preview picture', () => {
  it('inflates to 256 MiB: no picture, quickly and in a fraction of that memory', async () => {
    const bomb = withPreview(deflatedZeros(BOMB_MIB))
    expect(bomb.length).toBeLessThan(MIB)
    const started = performance.now()
    // the most memory the process ever held, in kilobytes
    const before = process.resourceUsage().maxRSS
    expect(await extractEmbeddedThumbnail('hwp', bomb)).toBeUndefined()
    const rise = (process.resourceUsage().maxRSS - before) * 1024
    expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
    expect(rise).toBeLessThan((BOMB_MIB / 2) * MIB)
  })

  it('is the picture Hangul wrote: it is shown as when stored as it is', async () => {
    const sound = memo()
    const picture = Buffer.from(
      CFB.find(CFB.read(sound, { type: 'buffer' }), PREVIEW)!.content as Uint8Array,
    )
    const shown = await extractEmbeddedThumbnail('hwp', sound)
    expect(shown).toMatch(/^data:image\//)
    expect(await extractEmbeddedThumbnail('hwp', withPreview(deflateRawSync(picture)))).toBe(shown)
  })
})
