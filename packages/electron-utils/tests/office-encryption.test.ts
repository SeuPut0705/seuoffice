import { describe, expect, it } from 'vitest'
import {
  decryptOfficeFile,
  encryptOoxml,
  isCfbHeader,
  isEncryptedOfficeFile,
  isEncryptedOoxml,
  OfficeDecryptError,
  unlockOfficeFile,
} from '../src/office-encryption'

// Encryption treats the package as opaque bytes, so a zip-looking buffer will do.
const plain = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('a stand-in package body')])

/** an ask() that answers from a list and records every call */
function answers(...replies: (string | null)[]) {
  const calls: boolean[] = []
  const ask = async (retry: boolean) => {
    calls.push(retry)
    return replies.shift() ?? null
  }
  return { ask, calls }
}

describe('office encryption detection', () => {
  it('tells an encrypted package from a zip, a bare CFB and short input', () => {
    const encrypted = encryptOoxml(plain, 'pw')
    expect(isCfbHeader(encrypted)).toBe(true)
    expect(isEncryptedOoxml(encrypted)).toBe(true)
    expect(isEncryptedOfficeFile(encrypted)).toBe(true)
    expect(isEncryptedOoxml(plain)).toBe(false)
    expect(isEncryptedOfficeFile(plain)).toBe(false)
    expect(isCfbHeader(Buffer.alloc(3))).toBe(false)
    const bareCfb = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(512),
    ])
    expect(isEncryptedOfficeFile(bareCfb)).toBe(false)
  })
})

describe('decryptOfficeFile', () => {
  it('round-trips byte for byte and names a wrong password', async () => {
    const encrypted = encryptOoxml(plain, '비밀 pw')
    expect(Buffer.compare(await decryptOfficeFile(encrypted, '비밀 pw'), plain)).toBe(0)
    const err = await decryptOfficeFile(encrypted, 'nope').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OfficeDecryptError)
    expect((err as OfficeDecryptError).reason).toBe('wrong-password')
  }, 30_000)

  it('reports a container it cannot read as unsupported', async () => {
    const err = await decryptOfficeFile(Buffer.from('not a cfb'), 'pw').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OfficeDecryptError)
    expect((err as OfficeDecryptError).reason).toBe('unsupported')
  })
})

describe('unlockOfficeFile', () => {
  it('asks again after a wrong or empty password, then opens', async () => {
    const encrypted = encryptOoxml(plain, 'right')
    const { ask, calls } = answers('wrong', '', 'right')
    const unlocked = await unlockOfficeFile(encrypted, ask)
    expect(unlocked).not.toBeNull()
    expect(Buffer.compare(unlocked!.bytes, plain)).toBe(0)
    expect(unlocked!.password).toBe('right')
    expect(unlocked!.asked).toBe(true)
    expect(calls).toEqual([false, true, true])
  }, 60_000)

  it('resolves null when the user cancels', async () => {
    const { ask } = answers(null)
    expect(await unlockOfficeFile(encryptOoxml(plain, 'pw'), ask)).toBeNull()
  }, 30_000)

  it("opens a file locked with Excel's built-in password without asking", async () => {
    const { ask, calls } = answers('unused')
    const unlocked = await unlockOfficeFile(encryptOoxml(plain, 'VelvetSweatshop'), ask)
    expect(calls).toEqual([])
    expect(unlocked?.asked).toBe(false)
    expect(unlocked?.password).toBe('VelvetSweatshop')
    expect(Buffer.compare(unlocked!.bytes, plain)).toBe(0)
  }, 30_000)

  it('passes an unsupported file through as an error instead of asking', async () => {
    const { ask, calls } = answers('pw')
    const err = await unlockOfficeFile(Buffer.from('not a cfb'), ask).catch((e: unknown) => e)
    expect((err as OfficeDecryptError).reason).toBe('unsupported')
    expect(calls).toEqual([])
  })
})
