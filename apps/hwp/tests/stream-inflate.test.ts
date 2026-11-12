/**
 * A deflated stream of an HWP 5 file does not say how large it becomes: a megabyte of it can
 * hold a gigabyte. The readers inflate a stream up to a ceiling, and take one that goes past
 * it the way they take one that is not deflate data at all.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { constants, deflateRawSync } from 'node:zlib'
import * as CFB from 'cfb'
import { afterAll, describe, expect, it } from 'vitest'
import { fieldKindsOf } from '../src/main/field-kinds'
import { SECTION, openHwp, streamOf } from '../src/main/hwp5-file'
import { sectionTailsOf } from '../src/main/section-tails'
import { newTabsOf } from '../src/main/tab-widths'
import { REFUSAL_MS } from '../../../packages/compound-file/tests/helpers/raw-compound'
import type { ProbeReport } from './helpers/inflate-probe'

const MIB = 1024 * 1024
/** what the hostile section inflates to: several times any ceiling a section could need */
const BOMB_MIB = 256
/**
 * The most one reader may add to the peak: half of what the section inflates to. It is not
 * worked out from the readers' own ceiling, so a ceiling raised or taken away fails here: a
 * reader that holds the ceiling (64 MiB) stays under it, one that inflates the section whole
 * does not.
 */
const READER_RISE_MAX = (BOMB_MIB / 2) * MIB

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

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const PROBE = fileURLToPath(new URL('helpers/inflate-probe.ts', import.meta.url))

/**
 * What one reader makes of the file at `path`, read in a process of its own: the most memory
 * a process has held is kept for its whole life, so only a new process shows what one reader
 * adds (see helpers/inflate-probe.ts).
 */
function probe(reader: string, path: string): ProbeReport {
  const out = execFileSync(process.execPath, ['--import', 'tsx', PROBE, reader, path], {
    cwd: APP_DIR,
    encoding: 'utf8',
  })
  return JSON.parse(out) as ProbeReport
}

describe('an HWP 5 file whose section inflates far past what a section holds', () => {
  const bomb = withSection(deflatedFiller(BOMB_MIB))
  const folder = mkdtempSync(join(tmpdir(), 'hwp-inflate-'))
  const bombPath = join(folder, 'bomb.hwp')
  writeFileSync(bombPath, bomb)
  afterAll(() => rmSync(folder, { recursive: true, force: true }))

  it('is a small, sound container', () => {
    expect(bomb.length).toBeLessThan(MIB)
    const opened = openHwp(bomb)
    expect(opened?.compressed).toBe(true)
  })

  it.each([
    ['fieldKinds', null],
    ['sectionTails', null],
    ['newTabs', []],
    ['section', 'refused'],
  ])(
    'is read by %s as a file with nothing to keep, quickly and within the ceiling',
    (reader, nothing) => {
      const report = probe(reader, bombPath)
      expect(report.result).toEqual(nothing)
      expect(report.ms).toBeLessThan(REFUSAL_MS)
      expect(report.riseBytes).toBeLessThan(READER_RISE_MAX)
    },
    60_000,
  )

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
