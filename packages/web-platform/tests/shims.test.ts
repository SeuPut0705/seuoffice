import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebBridge } from '../src/bridge'
import { WebUnsupportedError } from '../src/errors'
import { createHash } from '../src/shims/crypto'
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
