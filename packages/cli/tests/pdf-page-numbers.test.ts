import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { run, tempDir, writeMinimalPdf } from './helpers'
import { parsePageList, validatePageList } from '../src/formats/pdf-structure'

const fakes = vi.hoisted(() => ({ detect: vi.fn(), stream: vi.fn() }))
vi.mock('@genoffice/ai-provider/subscription', async (original) => ({
  ...(await original<typeof import('@genoffice/ai-provider/subscription')>()),
  detectSubscriptionLogin: fakes.detect,
}))
vi.mock('@genoffice/ai-provider', async (original) => ({
  ...(await original<typeof import('@genoffice/ai-provider')>()),
  streamForProvider: fakes.stream,
}))

describe('PDF page list integer validation', () => {
  it.each([
    '9007199254740992',
    '9007199254740993',
    '1-9007199254740992',
    '9007199254740992-9007199254740994',
    '9'.repeat(400),
  ])('rejects unsafe page numbers in %s as invalid arguments', (value) => {
    expect(() => parsePageList(value, 1)).toThrowError(
      expect.objectContaining({ reason: 'invalid_argument' }),
    )
  })
  it.each(['0', '2-1', '1.5', '1e3', '1,'])('continues to reject malformed spans %s', (value) => {
    expect(() => parsePageList(value, 10)).toThrowError(
      expect.objectContaining({ reason: 'invalid_argument' }),
    )
  })
  it('preserves requested order and removes duplicates', () => {
    expect(parsePageList('3, 1-3, 5', 5)).toEqual([3, 1, 2, 5])
  })
  it('accepts a single page at the safe integer boundary without rounding', () => {
    expect(parsePageList('9007199254740991')).toEqual([9007199254740991])
  })
  it('reports ordinary pages outside the document as out_of_range', () => {
    expect(() => parsePageList('1-3', 2)).toThrowError(
      expect.objectContaining({ reason: 'out_of_range', detail: { valid_range: [1, 2] } }),
    )
  })
  it('validates a large safe span without expanding it', () => {
    expect(() => validatePageList('1-9007199254740991')).not.toThrow()
  })
  it.each(['9007199254740992', '1-9007199254740992', '9'.repeat(400)])(
    'rejects unsafe %s without needing a document count',
    (value) => {
      expect(() => parsePageList(value)).toThrowError(
        expect.objectContaining({ reason: 'invalid_argument' }),
      )
      expect(() => validatePageList(value)).toThrowError(
        expect.objectContaining({ reason: 'invalid_argument' }),
      )
    },
  )
  it('rejects an enormous range against the PDF count before reaching AI setup', async () => {
    const dir = tempDir()
    const pdf = writeMinimalPdf(join(dir, 'one.pdf'), ['One page'])
    const result = await run(['pdf', 'ai-read', pdf, '--pages', '1-9007199254740991', '--json'], {
      env: {
        ...process.env,
        GENOFFICE_USER_DATA: dir,
        GENOFFICE_AUDIT_LOG: 'off',
        GENOFFICE_ALLOWED_ROOTS: '',
      },
    })
    expect(result.code).toBe(1)
    expect(result.json().error).toBe('out_of_range')
    expect(result.json().detail.valid_range).toEqual([1, 1])
    expect(fakes.detect).not.toHaveBeenCalled()
    expect(fakes.stream).not.toHaveBeenCalled()
  })
})
