import * as node from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebBridge } from '../src/bridge'
import { WebUnsupportedError } from '../src/errors'
import { createCipheriv, createDecipheriv, createHash } from '../src/shims/crypto'
import * as fs from '../src/shims/fs'
import { crc32, deflateRawSync, deflateSync, inflateRawSync, inflateSync } from '../src/shims/zlib'

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
})

describe('crypto shim', () => {
  it('matches the standard digests of "abc"', () => {
    expect(createHash('sha256').update('abc').digest('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(createHash('md5').update('abc').digest('hex')).toBe('900150983cd24fb0d6963f7d28e17f72')
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
