import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
import {
  END,
  FAT_SECTOR,
  HOSTILE_FILES,
  REFUSAL_MS,
  chained,
  fatCycleFile,
  rawCompound,
} from '../../compound-file/tests/helpers/raw-compound'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const repoFile = (path: string): Buffer => readFileSync(`${REPO}${path}`)

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

describe('a hostile compound file', () => {
  for (const { what, build } of HOSTILE_FILES) {
    it(`${what}: not reported as encrypted, quickly`, () => {
      const bytes = Buffer.from(build())
      const started = performance.now()
      const encrypted = isEncryptedOfficeFile(bytes)
      expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
      expect(encrypted).toBe(false)
    })

    it(`${what}: decrypting it fails as unsupported, quickly`, async () => {
      const bytes = Buffer.from(build())
      const started = performance.now()
      const err = await decryptOfficeFile(bytes, 'pw').catch((e: unknown) => e)
      expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
      expect(err).toBeInstanceOf(OfficeDecryptError)
      expect((err as OfficeDecryptError).reason).toBe('unsupported')
    })
  }

  it('is not offered a password prompt for carrying the EncryptedPackage name', async () => {
    // what an "encrypted .xlsx" whose package stream loops looks like to the open path
    const bytes = Buffer.from(fatCycleFile('EncryptedPackage'))
    expect(isEncryptedOfficeFile(bytes)).toBe(false)
    const { ask, calls } = answers('pw')
    const err = await unlockOfficeFile(bytes, ask).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OfficeDecryptError)
    expect((err as OfficeDecryptError).reason).toBe('unsupported')
    expect(calls).toEqual([])
  })
})

describe('a sound compound file still reaches the library', () => {
  it.each([
    ['agile', 'office-agile-password.docx', 'office-agile-plain.docx'],
    ['standard', 'office-standard-password.docx', 'office-standard-plain.docx'],
  ])(
    'a file real Office encrypted (%s) is reported encrypted and decrypts',
    async (_scheme, locked, plainName) => {
      const encrypted = repoFile(`apps/docs/tests/encrypted-fixtures/${locked}`)
      expect(isEncryptedOfficeFile(encrypted)).toBe(true)
      const decrypted = await decryptOfficeFile(encrypted, 'Password1234_')
      const expected = repoFile(`apps/docs/tests/encrypted-fixtures/${plainName}`)
      expect(Buffer.compare(decrypted, expected)).toBe(0)
    },
    30_000,
  )

  it('a legacy workbook with an open password is reported encrypted', () => {
    // a Workbook stream that opens with a BOF record and then a FILEPASS record
    const workbook = new Uint8Array(512)
    workbook.set([0x09, 0x08, 0x10, 0x00], 0)
    workbook.set([0x2f, 0x00], 4 + 16)
    const bytes = rawCompound({
      sectors: 10,
      fat: { 0: FAT_SECTOR, 1: END, ...chained(2, 8) },
      data: { 2: workbook },
      entries: [
        { name: 'Root Entry', type: 5, child: 1 },
        { name: 'Workbook', type: 2, start: 2, size: 4096 },
      ],
    })
    expect(isEncryptedOfficeFile(Buffer.from(bytes))).toBe(true)
  })

  it('a legacy workbook without a password is not encrypted and comes back as it was', async () => {
    const xls = repoFile('apps/sheets/native/xlsx-engine/tests/fixtures/cell-styles.xls')
    expect(isEncryptedOfficeFile(xls)).toBe(false)
    expect(Buffer.compare(await decryptOfficeFile(xls, 'pw'), xls)).toBe(0)
  })

  it('a plain zip is not encrypted and comes back as it was', async () => {
    expect(isEncryptedOfficeFile(plain)).toBe(false)
    const docx = repoFile('apps/docs/tests/encrypted-fixtures/office-standard-plain.docx')
    expect(isEncryptedOfficeFile(docx)).toBe(false)
    expect(Buffer.compare(await decryptOfficeFile(docx, 'pw'), docx)).toBe(0)
  })
})
