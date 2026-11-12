/**
 * A deflated part of an HWPX does not say how large it becomes either. The reader of its
 * sections (the widths of new tabs, the count of memo anchors) inflates a part up to the
 * ceiling an HWP 5 stream has, and takes one that goes past it the way it takes one that is
 * not deflate data at all.
 */
import { constants, deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { hwpxMemoCountOf, newTabsOf } from '../src/main/tab-widths'
import { REFUSAL_MS } from '../../../packages/compound-file/tests/helpers/raw-compound'

const MIB = 1024 * 1024

/**
 * A raw deflate stream of `mib` MiB of spaces, about a thousandth of that size, put
 * together from one deflated block so the test never holds what it inflates to.
 */
function deflatedSpaces(mib: number): Buffer {
  // a block flushed in full ends on a byte and forgets what came before it, so it repeats
  const block = deflateRawSync(Buffer.alloc(MIB, 0x20), { finishFlush: constants.Z_FULL_FLUSH })
  return Buffer.concat([...Array<Buffer>(mib).fill(block), deflateRawSync(Buffer.alloc(0))])
}

/** A zip of one entry, the first section of an HWPX, holding `data` as its deflated bytes. */
function hwpxWithSection(data: Buffer, method = 8): Uint8Array {
  const name = Buffer.from('Contents/section0.xml')
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(method, 8)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(method, 10)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(local.length + name.length + data.length, 16)
  return new Uint8Array(Buffer.concat([local, name, data, central, name, end]))
}

/** A section with one memo anchor, as the engine writes it, stored or deflated. */
const MEMO_SECTION = Buffer.from(
  '<hs:sec><hp:p><hp:run><hp:ctrl><hp:fieldBegin type="MEMO"/></hp:ctrl></hp:run></hp:p></hs:sec>',
)

describe('an HWPX whose section inflates far past what a section holds', () => {
  // past the ceiling, and small enough that a reader without one is not a danger to the run
  const bomb = hwpxWithSection(deflatedSpaces(96))

  it('is a small file', () => {
    expect(bomb.length).toBeLessThan(MIB)
  })

  it('is read as a file that cannot be read, quickly: no count of memos, no tabs', () => {
    const started = performance.now()
    expect(hwpxMemoCountOf(bomb)).toBeNull()
    expect(newTabsOf(bomb, 'hwpx')).toEqual([])
    expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
  })

  it('is taken the way a section that is not deflate data is', () => {
    const garbage = hwpxWithSection(Buffer.alloc(4096, 0xff))
    expect(hwpxMemoCountOf(garbage)).toBeNull()
    expect(newTabsOf(garbage, 'hwpx')).toEqual([])
  })
})

describe('an HWPX section of an ordinary size', () => {
  it('is read, deflated or stored', () => {
    expect(hwpxMemoCountOf(hwpxWithSection(deflateRawSync(MEMO_SECTION)))).toBe(1)
    expect(hwpxMemoCountOf(hwpxWithSection(MEMO_SECTION, 0))).toBe(1)
  })

  it('of 16 MiB, far more than a long document holds, is still read whole', () => {
    expect(hwpxMemoCountOf(hwpxWithSection(deflatedSpaces(16)))).toBe(0)
  })
})
