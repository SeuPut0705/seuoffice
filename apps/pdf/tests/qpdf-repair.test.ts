// @vitest-environment node
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFNumber, StandardFonts } from 'pdf-lib'
import { decryptPdfBytes, encryptPdfBytes, WrongPasswordError } from '../src/main/qpdf'
import {
  RepairFailedError,
  pdfiumOpens,
  repairPdfBytes,
  salvagePdfBytes,
  type RepairPdfium,
} from '../src/main/repair'
import { loadPdfium } from '../src/main/text-edit'
import { qpdfWasmPath } from '../src/main/wasm-path'

async function textPdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    doc.addPage([200, 200]).drawText(`page ${i + 1}`, { x: 20, y: 100, size: 12, font })
  }
  return doc.save({ useObjectStreams: false })
}

const encrypted = async (bytes: Uint8Array) =>
  (await PDFDocument.load(bytes, { ignoreEncryption: true })).isEncrypted

describe('encryptPdfBytes and decryptPdfBytes', () => {
  const wasm = qpdfWasmPath()
  let pdfium: RepairPdfium
  const opens = (bytes: Uint8Array, password: string) => pdfiumOpens(pdfium, bytes, password)
  const decrypt = async (bytes: Uint8Array, password: string) => {
    pdfium ??= (await loadPdfium()) as unknown as RepairPdfium
    return decryptPdfBytes(wasm, bytes, password, opens)
  }

  it('locks a PDF that then opens only with its password', async () => {
    const input = await textPdf()
    const before = Buffer.from(input)
    const locked = await encryptPdfBytes(wasm, input, { userPassword: 'open sesame' })
    expect(Buffer.from(input).equals(before)).toBe(true)
    expect(await encrypted(locked)).toBe(true)
    await expect(decrypt(locked, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError)
    const open = await decrypt(locked, 'open sesame')
    expect(await encrypted(open)).toBe(false)
    expect((await PDFDocument.load(open)).getPageCount()).toBe(2)
  })

  it('reads qpdf from the path it is given, not from beside its script', async () => {
    // the bundled job process has no qpdf.wasm beside it: only the given path counts
    const dir = mkdtempSync(join(tmpdir(), 'qpdf-path-'))
    try {
      const moved = join(dir, 'elsewhere.wasm')
      copyFileSync(wasm, moved)
      const locked = await encryptPdfBytes(moved, await textPdf(1), { userPassword: 'a' })
      expect(await encrypted(locked)).toBe(true)
      await expect(
        encryptPdfBytes(join(dir, 'missing.wasm'), await textPdf(1), { userPassword: 'a' }),
      ).rejects.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('takes passwords with spaces, a leading dash and Korean', async () => {
    for (const password of ['-x --decrypt', '비밀 번호 123']) {
      const locked = await encryptPdfBytes(wasm, await textPdf(1), { userPassword: password })
      const open = await decrypt(locked, password)
      expect((await PDFDocument.load(open)).getPageCount(), password).toBe(1)
    }
  })

  it('refuses printing, copying and changes when a permission password is set', async () => {
    const locked = await encryptPdfBytes(wasm, await textPdf(1), {
      userPassword: 'a',
      ownerPassword: 'b',
    })
    const doc = await PDFDocument.load(locked, { ignoreEncryption: true })
    const encrypt = doc.context.lookup(doc.context.trailerInfo.Encrypt!) as unknown as {
      lookup(name: PDFName): unknown
    }
    const p = (encrypt.lookup(PDFName.of('P')) as PDFNumber).asNumber()
    // bit 3 print, 4 modify, 5 copy, 6 annotate: all off
    for (const bit of [3, 4, 5, 6]) expect(p & (1 << (bit - 1)), `bit ${bit}`).toBe(0)
    // and the permission password opens it too
    expect((await PDFDocument.load(await decrypt(locked, 'b'))).getPageCount()).toBe(1)
  })

  it('names a file it could not unlock for another reason as a failure, not a wrong password', async () => {
    await expect(decrypt(new TextEncoder().encode('not a pdf'), 'x')).rejects.not.toBeInstanceOf(
      WrongPasswordError,
    )
  })
})

describe('repairPdfBytes', () => {
  async function damaged(): Promise<Record<string, Uint8Array>> {
    const good = Buffer.from(await textPdf(3)).toString('latin1')
    const latin = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'))
    return {
      offsetsShifted: latin(
        good.replace(
          /(\d{10}) 00000 n/g,
          (_m, n: string) => `${String(Number(n) + 7).padStart(10, '0')} 00000 n`,
        ),
      ),
      startxrefWrong: latin(good.replace(/startxref\s+\d+/, 'startxref\n999999')),
      xrefGone: latin(good.replace(/xref[\s\S]*?trailer/, 'trailer')),
      truncatedEnd: latin(good.slice(0, good.lastIndexOf('xref'))),
    }
  }

  it('writes every kind of damage it was given out again, all pages kept', async () => {
    const m = (await loadPdfium()) as unknown as RepairPdfium
    for (const [kind, bytes] of Object.entries(await damaged())) {
      const fixed = repairPdfBytes(m, bytes)
      expect(fixed.pages, kind).toBe(3)
      const doc = await PDFDocument.load(fixed.bytes)
      expect(doc.getPageCount(), kind).toBe(3)
    }
  })

  it('copies out the whole pages of a file cut short, and nothing from one with none', async () => {
    const good = await textPdf(3)
    const cut = good.slice(0, Math.floor(good.length * 0.7))
    const m = (await loadPdfium()) as unknown as RepairPdfium
    // PDFium gives up on this one
    expect(() => repairPdfBytes(m, cut)).toThrow(RepairFailedError)
    const salvaged = await salvagePdfBytes(cut)
    expect(salvaged?.pages).toBe(2)
    expect((await PDFDocument.load(salvaged!.bytes)).getPageCount()).toBe(2)
    expect(await salvagePdfBytes(new TextEncoder().encode('%PDF-1.7\nnothing'))).toBeNull()
  })

  it('names a password-protected file and one that is no PDF', async () => {
    const m = (await loadPdfium()) as unknown as RepairPdfium
    const locked = await encryptPdfBytes(qpdfWasmPath(), await textPdf(1), { userPassword: 'a' })
    expect(() => repairPdfBytes(m, locked)).toThrow(RepairFailedError)
    try {
      repairPdfBytes(m, locked)
    } catch (err) {
      expect((err as RepairFailedError).reason).toBe('encrypted')
    }
    expect(() => repairPdfBytes(m, new TextEncoder().encode('nothing here'))).toThrow(
      RepairFailedError,
    )
  })
})
