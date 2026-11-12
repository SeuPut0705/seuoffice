/**
 * A deflated stream of an HWP 5 file does not say how large it becomes: a megabyte of it can
 * hold a gigabyte. The readers inflate a stream up to a ceiling, and take one that goes past
 * it the way they take one that is not deflate data at all.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { constants, deflateRawSync } from 'node:zlib'
import * as CFB from 'cfb'
import { describe, expect, it } from 'vitest'
import { fieldKindsOf } from '../src/main/field-kinds'
import { MAX_STREAM_INFLATE_BYTES, SECTION, openHwp, streamOf } from '../src/main/hwp5-file'
import { sectionTailsOf } from '../src/main/section-tails'
import { newTabsOf } from '../src/main/tab-widths'
import { REFUSAL_MS } from '../../../packages/compound-file/tests/helpers/raw-compound'

const MIB = 1024 * 1024
/** what the hostile section inflates to: several times any ceiling a section could need */
const BOMB_MIB = 256
/**
 * The most one reader may add to the peak: the ceiling it inflates up to, and room for what
 * else a reader allocates. Far below the bomb, which a reader without the ceiling holds whole.
 */
const READER_RISE_MAX = MAX_STREAM_INFLATE_BYTES + 32 * MIB

/**
 * A raw deflate stream of `mib` MiB of 0xff bytes, about a thousandth of that size. It is
 * put together from one deflated block, so the test never holds what it inflates to. The
 * bytes are 0xff because a run of them is not a list of records: a reader that did inflate
 * them stops there, and does not go on to build a record for every four bytes.
 */
function deflatedFiller(mib: number): Buffer {
  // a block flushed in full ends on a byte and forgets what came before it, so it repeats
  const block = deflateRawSync(Buffer.alloc(MIB, 0xff), { finishFlush: constants.Z_FULL_FLUSH })
  return Buffer.concat([...Array<Buffer>(mib).fill(block), deflateRawSync(Buffer.alloc(0))])
}

/** The Hangul-written fixture with the bytes of its first section replaced. */
function withSection(content: Buffer): Uint8Array {
  const memo = readFileSync(fileURLToPath(new URL('fixtures/memo.hwp', import.meta.url)))
  const cfb = CFB.read(memo, { type: 'buffer' })
  CFB.utils.cfb_add(cfb, SECTION(0), content)
  return new Uint8Array(CFB.write(cfb, { type: 'buffer' }) as Buffer)
}

/** How far the most memory the process ever held rose while `run` ran, in bytes. */
function peakRise(run: () => void): number {
  const before = process.resourceUsage().maxRSS
  run()
  return (process.resourceUsage().maxRSS - before) * 1024
}

describe('an HWP 5 file whose section inflates far past what a section holds', () => {
  const bomb = withSection(deflatedFiller(BOMB_MIB))

  it('is a small, sound container', () => {
    expect(bomb.length).toBeLessThan(MIB)
    const opened = openHwp(bomb)
    expect(opened?.compressed).toBe(true)
  })

  it('is read as a file with nothing to keep, quickly and within the ceiling by each reader', () => {
    // Each reader is measured by itself: what one let go of may still be counted in the peak
    // when the next one runs, so their rises add up when the collector has not run between.
    const readers: Array<() => void> = [
      () => expect(fieldKindsOf(bomb)).toBeNull(),
      () => expect(sectionTailsOf(bomb)).toBeNull(),
      () => expect(newTabsOf(bomb, 'hwp')).toEqual([]),
    ]
    for (const reader of readers) {
      const started = performance.now()
      expect(peakRise(reader)).toBeLessThan(READER_RISE_MAX)
      expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
    }
  })

  it('has its section refused, not handed back inflated', () => {
    const opened = openHwp(bomb)!
    const started = performance.now()
    let inflatedBytes: number | undefined
    let thrown: unknown
    const rise = peakRise(() => {
      try {
        inflatedBytes = streamOf(opened, SECTION(0))?.length
      } catch (error) {
        thrown = error
      }
    })
    expect(inflatedBytes).toBeUndefined()
    expect(thrown).toBeInstanceOf(Error)
    expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
    expect(rise).toBeLessThan(READER_RISE_MAX)
  })

  it('is refused the way a section that is not deflate data is', () => {
    const garbage = withSection(Buffer.alloc(4096, 0xff))
    expect(() => streamOf(openHwp(garbage)!, SECTION(0))).toThrow()
    expect(fieldKindsOf(garbage)).toBeNull()
    expect(sectionTailsOf(garbage)).toBeNull()
    expect(newTabsOf(garbage, 'hwp')).toEqual([])
  })
})

describe('a section of an ordinary size', () => {
  it('written by Hangul inflates to its records', () => {
    const memo = readFileSync(fileURLToPath(new URL('fixtures/memo.hwp', import.meta.url)))
    expect(streamOf(openHwp(memo)!, SECTION(0))?.length).toBeGreaterThan(0)
  })

  it('of 16 MiB, far more than a long document holds, still inflates whole', () => {
    const large = withSection(deflatedFiller(16))
    const section = streamOf(openHwp(large)!, SECTION(0))
    expect(section?.length).toBe(16 * MIB)
    expect(section?.every((byte) => byte === 0xff)).toBe(true)
  })
})
