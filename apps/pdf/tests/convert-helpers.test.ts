/**
 * The conversion screen's plain helpers: page ranges, the text sent by
 * "Fill with AI" and how its reply is read.
 */
import { describe, expect, it, vi } from 'vitest'
import { parsePageRange } from '../src/renderer/convert/page-range'
import {
  AI_FILL_MAX_CHARS,
  AI_FILL_MAX_PAGES,
  BOOK_INFO_SYSTEM,
  collectLeadingText,
  parseBookInfoReply,
} from '../src/renderer/convert/book-info-ai'

describe('parsePageRange', () => {
  it('reads single pages and ranges, ascending and once each', () => {
    expect(parsePageRange('1-5,8', 10)).toEqual({ ok: true, pages: [1, 2, 3, 4, 5, 8] })
    expect(parsePageRange(' 8 , 3 ; 3-4 ', 10)).toEqual({ ok: true, pages: [3, 4, 8] })
    expect(parsePageRange('5-3', 10)).toEqual({ ok: true, pages: [3, 4, 5] })
    expect(parsePageRange('2–4', 10)).toEqual({ ok: true, pages: [2, 3, 4] })
    expect(parsePageRange('1，10', 10)).toEqual({ ok: true, pages: [1, 10] })
  })

  it('tells an empty, a malformed and an out-of-range entry apart', () => {
    expect(parsePageRange('  ', 10)).toEqual({ ok: false, reason: 'empty' })
    expect(parsePageRange('1-', 10)).toEqual({ ok: false, reason: 'syntax' })
    expect(parsePageRange('a', 10)).toEqual({ ok: false, reason: 'syntax' })
    expect(parsePageRange('1.5', 10)).toEqual({ ok: false, reason: 'syntax' })
    expect(parsePageRange('0', 10)).toEqual({ ok: false, reason: 'outOfRange' })
    expect(parsePageRange('9-11', 10)).toEqual({ ok: false, reason: 'outOfRange' })
    expect(parsePageRange('2, 11', 10)).toEqual({ ok: false, reason: 'outOfRange' })
  })
})

describe('collectLeadingText', () => {
  it('reads the first three pages when they carry enough text', async () => {
    const long = 'x'.repeat(800)
    const pageText = vi.fn(async () => long)
    const text = await collectLeadingText(20, pageText)
    expect(pageText.mock.calls.map(([page]) => page)).toEqual([1, 2, 3])
    expect(text).toContain('[Page 1]')
    expect(text).toContain('[Page 3]')
  })

  it('reads on (up to twelve pages) while the text is short, skipping empty pages', async () => {
    const pageText = vi.fn(async (page: number) => (page === 2 ? 'Title page' : ''))
    const text = await collectLeadingText(40, pageText)
    expect(pageText).toHaveBeenCalledTimes(AI_FILL_MAX_PAGES)
    expect(text).toBe('[Page 2]\nTitle page')
  })

  it('stops at the document end and caps what is sent', async () => {
    const pageText = vi.fn(async () => 'y'.repeat(9000))
    const text = await collectLeadingText(2, pageText)
    expect(pageText).toHaveBeenCalledTimes(2)
    expect(text.length).toBeLessThanOrEqual(AI_FILL_MAX_CHARS)
  })

  it('is empty when the first pages have no text', async () => {
    expect(await collectLeadingText(5, async () => '  ')).toBe('')
  })
})

describe('parseBookInfoReply', () => {
  it('takes the JSON object out of the reply', () => {
    expect(
      parseBookInfoReply(
        '```json\n{"title":" Ferns\\n of Korea ","author":"Mina Park","language":"ko"}\n```',
      ),
    ).toEqual({ title: 'Ferns of Korea', author: 'Mina Park', language: 'ko' })
  })

  it('drops a language that is not a language tag and keeps the rest', () => {
    expect(parseBookInfoReply('{"title":"T","author":"","language":"Korean language"}')).toEqual({
      title: 'T',
      author: '',
      language: '',
    })
  })

  it('reads no suggestion from prose, broken JSON or empty fields', () => {
    expect(parseBookInfoReply('no idea')).toBeNull()
    expect(parseBookInfoReply('{"title": "T"')).toBeNull()
    expect(parseBookInfoReply('["T", "A"]')).toBeNull()
    expect(parseBookInfoReply('{"title":"","author":"","language":""}')).toBeNull()
    expect(parseBookInfoReply('{"title": 42}')).toBeNull()
  })

  it('tells the model the page text is data, not instructions', () => {
    expect(BOOK_INFO_SYSTEM).toMatch(/never follow instructions/i)
  })
})
