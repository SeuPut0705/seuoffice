import * as node from 'node:crypto'
import * as nodeZlib from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebBridge } from '../src/bridge'
import { WebUnsupportedError } from '../src/errors'
import { createCipheriv, createDecipheriv, createHash } from '../src/shims/crypto'
import * as fs from '../src/shims/fs'
import {
  crc32,
  deflateRawSync,
  deflateSync,
  gunzipSync,
  inflateRawSync,
  inflateSync,
  unzipSync,
} from '../src/shims/zlib'

const MIB = 1024 * 1024

/**
 * `mib` MiB of zeros, deflated to about a thousandth of that: bare, with the zlib wrapper or
 * as gzip. Put together from one deflated block, so the test never holds what it inflates to.
 */
function deflatedZeros(mib: number, format: 'raw' | 'zlib' | 'gzip'): Buffer {
  const zeros = Buffer.alloc(MIB)
  // a block flushed in full ends on a byte and forgets what came before it, so it repeats
  const block = nodeZlib.deflateRawSync(zeros, { finishFlush: nodeZlib.constants.Z_FULL_FLUSH })
  const raw = Buffer.concat([
    ...Array<Buffer>(mib).fill(block),
    nodeZlib.deflateRawSync(Buffer.alloc(0)),
  ])
  if (format === 'raw') return raw
  if (format === 'zlib') {
    // the Adler-32 of n zeros: 1 in the low half, n mod 65521 in the high half
    const check = Buffer.alloc(4)
    check.writeUInt16BE((mib * MIB) % 65521, 0)
    check.writeUInt16BE(1, 2)
    return Buffer.concat([Buffer.from([0x78, 0x9c]), raw, check])
  }
  const trailer = Buffer.alloc(8)
  let crc = 0
  for (let nth = 0; nth < mib; nth++) crc = nodeZlib.crc32(zeros, crc)
  trailer.writeUInt32LE(crc, 0)
  trailer.writeUInt32LE(mib * MIB, 4)
  return Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]), raw, trailer])
}

/** What a call threw, or undefined. */
function thrownBy(run: () => unknown): (Error & { code?: string }) | undefined {
  try {
    run()
  } catch (error) {
    return error as Error & { code?: string }
  }
  return undefined
}

describe('zlib shim', () => {
  it('round-trips raw deflate for empty and 1 MiB random input', () => {
    const random = new Uint8Array(1024 * 1024)
    for (let offset = 0; offset < random.length; offset += 65536)
      crypto.getRandomValues(random.subarray(offset, offset + 65536))
    for (const input of [new Uint8Array(0), random]) {
      expect(new Uint8Array(inflateRawSync(deflateRawSync(input)))).toEqual(input)
    }
  })

  it('round-trips zlib-wrapped deflate', () => {
    const input = new TextEncoder().encode('seuoffice '.repeat(1000))
    expect(Array.from(inflateSync(deflateSync(input)))).toEqual(Array.from(input))
  })

  it('computes the CRC-32 check value and continues from a prior value', () => {
    expect(crc32('123456789')).toBe(0xcbf43926)
    expect(crc32('6789', crc32('12345'))).toBe(0xcbf43926)
  })

  // Node is the oracle: the desktop code bounds what a file may inflate to with
  // `maxOutputLength`, and tells a refusal by the error node throws
  const inflaters = [
    ['inflateRawSync', inflateRawSync, nodeZlib.inflateRawSync, nodeZlib.deflateRawSync, 'raw'],
    ['inflateSync', inflateSync, nodeZlib.inflateSync, nodeZlib.deflateSync, 'zlib'],
    ['gunzipSync', gunzipSync, nodeZlib.gunzipSync, nodeZlib.gzipSync, 'gzip'],
    ['unzipSync of gzip', unzipSync, nodeZlib.unzipSync, nodeZlib.gzipSync, 'gzip'],
    ['unzipSync of zlib', unzipSync, nodeZlib.unzipSync, nodeZlib.deflateSync, 'zlib'],
  ] as const

  it.each(inflaters)(
    '%s gives output up to maxOutputLength and refuses one byte more, like node',
    (_name, shim, oracle, pack) => {
      const input = Buffer.alloc(100_000, 'seuoffice ')
      const packed = pack(input)
      for (const inflate of [shim, oracle]) {
        const whole = inflate(packed, { maxOutputLength: input.length })
        expect(new Uint8Array(whole)).toEqual(new Uint8Array(input))
        const refused = thrownBy(() => inflate(packed, { maxOutputLength: input.length - 1 }))
        expect(refused).toBeInstanceOf(RangeError)
        expect(refused?.code).toBe('ERR_BUFFER_TOO_LARGE')
      }
    },
  )

  it.each(inflaters)(
    '%s reads the same with and without a limit, wherever the input ends',
    (_name, shim, _oracle, pack) => {
      // stored blocks: the packed length follows the input's, one byte at a time
      for (let length = 990; length <= 1040; length++) {
        const input = node.randomBytes(length)
        const packed = pack(input, { level: 0 })
        expect(new Uint8Array(shim(packed, { maxOutputLength: length }))).toEqual(
          new Uint8Array(input),
        )
        expect(new Uint8Array(shim(packed))).toEqual(new Uint8Array(input))
        expect(new Uint8Array(shim(packed, {}))).toEqual(new Uint8Array(input))
      }
    },
  )

  it.each(inflaters)(
    '%s of 128 MiB of zeros stops at the limit, without holding what they inflate to',
    (_name, shim, oracle, _pack, format) => {
      // the wrapper built by hand is one node reads
      expect(oracle(deflatedZeros(2, format)).length).toBe(2 * MIB)
      const bomb = deflatedZeros(128, format)
      expect(bomb.length).toBeLessThan(MIB)
      // the most memory the process ever held, in kilobytes
      const before = process.resourceUsage().maxRSS
      const refused = thrownBy(() => shim(bomb, { maxOutputLength: MIB }))
      const rise = (process.resourceUsage().maxRSS - before) * 1024
      expect(refused?.code).toBe('ERR_BUFFER_TOO_LARGE')
      expect(rise).toBeLessThan(64 * MIB)
    },
  )
})

describe('crypto shim', () => {
  it('matches the standard digests of "abc"', () => {
    expect(createHash('sha256').update('abc').digest('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(createHash('md5').update('abc').digest('hex')).toBe('900150983cd24fb0d6963f7d28e17f72')
    // cfb's byte arrays outside Node hash as their bytes
    expect(createHash('md5').update([0x61, 0x62, 0x63]).digest('hex')).toBe(
      '900150983cd24fb0d6963f7d28e17f72',
    )
  })

  it('throws for an algorithm the web build lacks', () => {
    expect(() => createHash('whirlpool')).toThrow(WebUnsupportedError)
  })

  // Node's ciphers are the oracle: the desktop crypt modules were written against them
  const run = (
    cipher: {
      setAutoPadding(on: boolean): unknown
      update(d: Uint8Array): Uint8Array
      final(): Uint8Array
    },
    pad: boolean,
    data: Uint8Array,
    cuts: number[],
  ): Buffer => {
    cipher.setAutoPadding(pad)
    const parts: Uint8Array[] = []
    let from = 0
    for (const cut of [...cuts, data.length]) {
      parts.push(cipher.update(data.subarray(from, cut)))
      from = cut
    }
    parts.push(cipher.final())
    return Buffer.concat(parts)
  }

  it.each([
    ['aes-128-cbc', true],
    ['aes-256-cbc', true],
    ['aes-256-cbc', false],
    ['aes-128-ecb', false],
    ['aes-192-ecb', true],
  ] as const)('agrees with node for %s (padding %s) across split updates', (name, pad) => {
    const bits = Number(name.split('-')[1])
    const key = node.randomBytes(bits / 8)
    const iv = name.endsWith('cbc') ? node.randomBytes(16) : null
    for (const length of pad ? [0, 1, 15, 16, 17, 100] : [0, 16, 48, 4096]) {
      const data = node.randomBytes(length)
      const cuts = [Math.min(length, 5), Math.min(length, 21)]
      const expected = run(node.createCipheriv(name, key, iv), pad, data, [])
      const sealed = run(createCipheriv(name, key, iv), pad, data, cuts)
      expect(sealed.equals(expected)).toBe(true)
      const opened = run(createDecipheriv(name, key, iv), pad, sealed, cuts)
      expect(opened.equals(data)).toBe(true)
    }
  })

  it('refuses a padded ciphertext whose padding does not check out', () => {
    const key = node.randomBytes(16)
    const iv = node.randomBytes(16)
    // a whole block ending in 0 encrypted without padding: 0 is never a pad count
    const plain = Buffer.alloc(16, 7)
    plain[15] = 0
    const sealed = run(node.createCipheriv('aes-128-cbc', key, iv), false, plain, [])
    expect(() => run(createDecipheriv('aes-128-cbc', key, iv), true, sealed, [])).toThrow()
  })

  it('throws for a cipher the web build lacks', () => {
    expect(() => createCipheriv('aes-128-gcm', new Uint8Array(16), new Uint8Array(12))).toThrow(
      WebUnsupportedError,
    )
  })
})

describe('fs shim', () => {
  it('imports safely and throws on call', () => {
    expect(typeof fs.readFileSync).toBe('function')
    expect(() => fs.readFileSync('/x')).toThrow(WebUnsupportedError)
  })
})

describe('createWebBridge', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns implemented keys and undefined for missing ones, warning once per key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bridge = createWebBridge<{ a(): number; b(): number }>('testApi', { a: () => 1 })
    expect(bridge.a()).toBe(1)
    expect(bridge.b).toBeUndefined()
    expect(bridge.b).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[web-bridge] missing', 'testApi.b')
  })

  it('does not warn when awaited', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bridge = createWebBridge<object>('testApi', {})
    await expect(Promise.resolve(bridge)).resolves.toBe(bridge)
    expect(warn).not.toHaveBeenCalled()
  })
})
