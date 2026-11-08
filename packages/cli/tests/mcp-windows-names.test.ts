import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileStore, MAX_SAFE_NAME_BYTES, MAX_SAFE_NAME_CHARS, safeName } from '../src/mcp/files'
import { tempDir } from './helpers'

describe('portable MCP upload names on Windows', () => {
  it.each([
    'CON',
    'prn.pdf',
    'AUX.docx',
    'NUL.tar.gz',
    'COM1.xlsx',
    'lpt9.txt',
    'COM\u00b9.pdf',
    'LPT\u00b3.docx',
  ])('turns reserved device name %s into a normal file name', (name) => {
    const result = safeName(name)
    expect(result).toBe('_' + name)
    expect(result.length).toBeLessThanOrEqual(MAX_SAFE_NAME_CHARS)
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(MAX_SAFE_NAME_BYTES)
  })

  it.each([
    ['report.docx.', 'report.docx'],
    ['report.docx. .', 'report.docx'],
    [' . . ', 'upload.bin'],
  ])('removes a trailing Windows suffix from %j', (raw, expected) => {
    expect(safeName(raw, 'upload.bin')).toBe(expected)
  })

  it.each(['CONsole.txt', 'COM10.docx', 'LPT0.pdf', 'résumé.docx'])(
    'keeps ordinary name %s',
    (name) => {
      expect(safeName(name)).toBe(name)
    },
  )

  it('writes and exposes a reserved upload name as an ordinary disk file', () => {
    const store = new FileStore(join(tempDir(), 'store'))
    try {
      const path = store.uploadTarget('CON.txt')
      expect(basename(path)).toBe('_CON.txt')
      const before = Buffer.from('ordinary upload bytes')
      writeFileSync(path, before)
      const entry = store.expose(path)
      expect(entry.name).toBe('_CON.txt')
      expect(readFileSync(entry.path)).toEqual(before)
      expect(dirname(entry.path)).not.toBe(store.root)
    } finally {
      store.dispose()
    }
  })

  it('keeps both limits after prefixing a long reserved name', () => {
    const name = safeName('CON.' + 'a'.repeat(200))
    expect(name.startsWith('_CON.')).toBe(true)
    expect(name.length).toBeLessThanOrEqual(MAX_SAFE_NAME_CHARS)
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(MAX_SAFE_NAME_BYTES)
    expect(/[ .]$/.test(name)).toBe(false)
  })
})
