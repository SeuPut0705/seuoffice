/**
 * What the open path does with a .docx that is a compound file: a protected document asks
 * for its password; one whose container does not hold is a damaged file, which no password
 * opens, so it is refused as unreadable and nobody is asked for one.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({
  reportError: vi.fn<(code: string, message: string) => void>(),
}))

vi.mock('@seuoffice/web-platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@seuoffice/web-platform')>()),
  reportError: host.reportError,
}))

import { openDecryptedDocx, openDocxFromBytes } from '../src/web/open-docx'

const fixture = (name: string) => readFileSync(join(__dirname, 'encrypted-fixtures', name))

function documentOf(bytes: Buffer) {
  return { id: 'd', fileName: 'report.docx', bytes: new Uint8Array(bytes), virtualPath: '/web/d' }
}

/** A real protected docx whose header counts one FAT sector more than the file lists. */
function damaged(): Buffer {
  const bytes = fixture('office-agile-password.docx')
  bytes.writeUInt32LE(bytes.readUInt32LE(44) + 1, 44)
  return bytes
}

beforeEach(() => host.reportError.mockReset())

describe('opening a .docx that is a compound file', () => {
  it('asks for the password of a protected document, and opens it with it', async () => {
    const doc = documentOf(fixture('office-agile-password.docx'))
    expect(await openDocxFromBytes(doc)).toEqual({
      needsPassword: true,
      path: doc.virtualPath,
      name: doc.fileName,
    })
    expect(host.reportError).not.toHaveBeenCalled()
    const opened = await openDecryptedDocx(doc, 'Password1234_')
    expect(opened.ok).toBe(true)
  })

  it('refuses a damaged one as a failed open, without asking for a password', async () => {
    const doc = documentOf(damaged())
    expect(await openDocxFromBytes(doc)).toBeNull()
    expect(host.reportError).toHaveBeenCalledTimes(1)
    expect(host.reportError.mock.calls[0]![0]).toBe('open_failed')
  })
})
