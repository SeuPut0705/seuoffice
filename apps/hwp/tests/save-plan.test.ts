import { describe, expect, it } from 'vitest'
import {
  backupPathFor,
  bytesMatchFormat,
  needsBackup,
  withFormatExtension,
} from '../src/main/save-plan'
import { hwpFormatOfPath } from '../src/shared/ipc'

describe('needsBackup', () => {
  it('keeps the bytes a view is about to overwrite for the first time', () => {
    expect(needsBackup('C:/d/a.hwpx', true, new Set())).toBe(true)
  })

  it('does not back up a file this view already wrote in the session', () => {
    expect(needsBackup('C:/d/a.hwpx', true, new Set(['C:/d/a.hwpx']))).toBe(false)
  })

  it('has nothing to keep when the save creates the file', () => {
    expect(needsBackup('C:/d/new.hwp', false, new Set())).toBe(false)
  })

  it('treats another file as a first overwrite even after saving elsewhere', () => {
    expect(needsBackup('C:/d/b.hwp', true, new Set(['C:/d/a.hwp']))).toBe(true)
  })
})

describe('backupPathFor', () => {
  it('keeps the whole file name so .hwp and .hwpx twins do not share a backup', () => {
    expect(backupPathFor('C:/d/report.hwp')).toBe('C:/d/report.hwp.bak')
    expect(backupPathFor('C:/d/report.hwpx')).toBe('C:/d/report.hwpx.bak')
  })
})

describe('bytesMatchFormat', () => {
  const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])
  const ole = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00])

  it('accepts a ZIP container for hwpx and an OLE container for hwp', () => {
    expect(bytesMatchFormat(zip, 'hwpx')).toBe(true)
    expect(bytesMatchFormat(ole, 'hwp')).toBe(true)
  })

  it('refuses bytes of the other format', () => {
    expect(bytesMatchFormat(zip, 'hwp')).toBe(false)
    expect(bytesMatchFormat(ole, 'hwpx')).toBe(false)
  })

  it('refuses bytes too short to carry the signature', () => {
    expect(bytesMatchFormat(Uint8Array.from([0x50, 0x4b]), 'hwpx')).toBe(false)
    expect(bytesMatchFormat(new Uint8Array(), 'hwp')).toBe(false)
  })
})

describe('save target format', () => {
  it('reads the format off the file name, case-insensitively', () => {
    expect(hwpFormatOfPath('C:/d/a.hwp')).toBe('hwp')
    expect(hwpFormatOfPath('C:/d/a.HWPX')).toBe('hwpx')
    expect(hwpFormatOfPath('C:/d/a.hwp.bak')).toBeNull()
    expect(hwpFormatOfPath('C:/d/a.docx')).toBeNull()
  })

  it('appends the current format when Save As returns a bare name', () => {
    expect(withFormatExtension('C:/d/report', 'hwpx')).toBe('C:/d/report.hwpx')
    expect(withFormatExtension('C:/d/report.hwp', 'hwpx')).toBe('C:/d/report.hwp')
  })
})
