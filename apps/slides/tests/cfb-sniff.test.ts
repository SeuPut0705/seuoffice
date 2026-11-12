import { describe, it, expect } from 'vitest'
import { encryptOoxml } from '@seuoffice/electron-utils/office-encryption'
import { cfbKind, isCfbHeader } from '../src/main/cfb-sniff'
import {
  END,
  FAT_SECTOR,
  HOSTILE_FILES,
  REFUSAL_MS,
  chained,
  fatCycleFile,
  rawCompound,
} from '../../../packages/compound-file/tests/helpers/raw-compound'

const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** A sound compound file of one 4096-byte stream, in sectors 2 to 9. */
function compoundWith(streamName: string): Buffer {
  return Buffer.from(
    rawCompound({
      sectors: 10,
      fat: { 0: FAT_SECTOR, 1: END, ...chained(2, 8) },
      entries: [
        { name: 'Root Entry', type: 5, child: 1 },
        { name: streamName, type: 2, start: 2, size: 4096 },
      ],
    }),
  )
}

/** Where the stream of `compoundWith` starts: sector n is (n + 1) sectors into the file. */
const STREAM_AT = 3 * 512

// Encryption treats the package as opaque bytes, so a zip-looking buffer will do.
const encryptedDeck = (): Buffer =>
  encryptOoxml(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('a deck')]), 'pw')

describe('cfbKind', () => {
  it('plain zip (pptx) does not match', () => {
    expect(isCfbHeader(Buffer.from('PK\x03\x04rest'))).toBe(false)
    expect(cfbKind(Buffer.from('PK\x03\x04rest'))).toBeNull()
  })

  it('CFB without EncryptedPackage stream -> legacy .ppt', () => {
    expect(cfbKind(compoundWith('PowerPoint Document'))).toBe('legacy')
  })

  it('CFB containing EncryptedPackage stream name (UTF-16LE) -> encrypted OOXML', () => {
    expect(cfbKind(encryptedDeck())).toBe('encrypted')
    expect(cfbKind(compoundWith('EncryptedPackage'))).toBe('encrypted')
  })

  it('ASCII-form EncryptedPackage is not misdetected (stream name must be UTF-16LE)', () => {
    const buf = compoundWith('PowerPoint Document')
    buf.write('EncryptedPackage', STREAM_AT, 'ascii')
    expect(cfbKind(buf)).toBe('legacy')
  })
})

describe('a CFB whose container does not hold', () => {
  it('is damaged, not encrypted, for carrying the EncryptedPackage name', () => {
    // the magic number, the name and nothing a reader could follow
    const junk = Buffer.concat([
      CFB,
      Buffer.alloc(64),
      Buffer.from('EncryptedPackage', 'utf16le'),
      Buffer.alloc(64),
    ])
    expect(cfbKind(junk)).toBe('damaged')
    expect(cfbKind(Buffer.from(fatCycleFile('EncryptedPackage')))).toBe('damaged')
  })

  it('is damaged, not legacy, without that name', () => {
    expect(cfbKind(Buffer.concat([CFB, Buffer.alloc(512)]))).toBe('damaged')
  })

  it('made from a real protected deck by one wrong header field is damaged', () => {
    const deck = encryptedDeck()
    // the header counts one FAT sector more than the file lists
    deck.writeUInt32LE(deck.readUInt32LE(44) + 1, 44)
    expect(cfbKind(deck)).toBe('damaged')
  })

  for (const { what, build } of HOSTILE_FILES) {
    it(`${what}: damaged, quickly`, () => {
      const started = performance.now()
      expect(cfbKind(Buffer.from(build()))).toBe('damaged')
      expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
    })
  }
})
