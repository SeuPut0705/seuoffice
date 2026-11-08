/**
 * Paragraph citations (reading-assist spec 4.7, 10.8): the link forms the AI
 * window accepts (the old page form, `q`, broken encoding, other schemes), the
 * instruction in the PDF skill, and finding the quote on its page with
 * whitespace, line breaks and line-end hyphenation folded, falling back to the
 * page alone (with a brief notice) when the whole quote is not there.
 */
import { describe, expect, it } from 'vitest'
import { parsePdfNavHref, PDF_NAV_QUOTE_MAX_CHARS } from '../src/renderer/ai/pdf-nav'
import { findQuoteRects, findQuoteSpan, foldForQuote } from '../src/renderer/ai/quote-find'
import { QUOTE_NOT_FOUND_NOTICE_MS, locateCitation } from '../src/renderer/ai/QuoteFlash'
import { createPdfSkill } from '../src/renderer/ai/pdf-skill'
import type { PdfAiDeps } from '../src/renderer/ai/tools'
import type { PageEntry, SearchIndex } from '../src/renderer/search'

describe('citation links', () => {
  it('keeps the old page form', () => {
    expect(parsePdfNavHref('pdfnav://page/7')).toEqual({ page: 7 })
  })

  it('reads a URL-encoded quote', () => {
    const quote = 'the results (see Table 2) were consistent'
    expect(parsePdfNavHref(`pdfnav://page/3?q=${encodeURIComponent(quote)}`)).toEqual({
      page: 3,
      quote,
    })
    expect(parsePdfNavHref('pdfnav://page/3?q=net+income+rose')).toEqual({
      page: 3,
      quote: 'net income rose',
    })
  })

  it('goes to the page alone when the quote is broken or empty', () => {
    expect(parsePdfNavHref('pdfnav://page/4?q=%E0%A4%A')).toEqual({ page: 4 })
    expect(parsePdfNavHref('pdfnav://page/4?q=')).toEqual({ page: 4 })
    expect(parsePdfNavHref('pdfnav://page/4?q=%20%20')).toEqual({ page: 4 })
  })

  it('caps a very long quote', () => {
    const out = parsePdfNavHref(`pdfnav://page/1?q=${'a'.repeat(PDF_NAV_QUOTE_MAX_CHARS + 50)}`)
    expect(out?.quote?.length).toBe(PDF_NAV_QUOTE_MAX_CHARS)
  })

  it('rejects other schemes, paths and parameters', () => {
    expect(parsePdfNavHref('https://example.com/page/3?q=x')).toBeNull()
    expect(parsePdfNavHref('filenav:///C:/a.pdf')).toBeNull()
    expect(parsePdfNavHref('pdfnav://block/3?q=x')).toBeNull()
    expect(parsePdfNavHref('pdfnav://page/3?x=1')).toBeNull()
    expect(parsePdfNavHref('pdfnav://page/3?q=a&x=1')).toBeNull()
    expect(parsePdfNavHref('pdfnav://page/3#q=a')).toBeNull()
    expect(parsePdfNavHref('pdfnav://page/x?q=a')).toBeNull()
  })

  it('tells the AI to cite the passage with verbatim words', () => {
    const skill = createPdfSkill({ imageGenAvailable: () => true } as unknown as PdfAiDeps)
    expect(skill.systemPrompt).toContain('pdfnav://page/N?q=')
    expect(skill.systemPrompt).toContain('8 to 20 consecutive words copied verbatim')
    expect(skill.systemPrompt).toContain('[p.N](pdfnav://page/N)')
  })
})

/** a page entry like the viewer search builds: one run per line, 10pt per character */
function entryOf(lines: string[]): PageEntry {
  let text = ''
  const items: PageEntry['items'] = []
  lines.forEach((line, i) => {
    items.push({
      start: text.length,
      end: text.length + line.length,
      x: 50,
      y: 700 - i * 14,
      w: line.length * 10,
      h: 12,
    })
    text += `${line}\n`
  })
  return { text, lower: text.toLowerCase(), items }
}

describe('finding a quote on its page', () => {
  const page = entryOf([
    'The commit\u00ADtee reviewed the infor-',
    'mation  provided by the  applicant and',
    'found the ﬁnal “well-',
    'known” figures were consistent.',
  ])

  it('folds whitespace, line breaks, hyphenation, case, ligatures and quotes', () => {
    expect(foldForQuote('Well-\nknown  “Final”').folded).toBe('wellknown"final"')
    expect(
      findQuoteSpan(page.text, 'the information provided by the applicant and found'),
    ).not.toBeNull()
    expect(
      findQuoteSpan(page.text, 'the final "well-known" figures were CONSISTENT'),
    ).not.toBeNull()
    expect(findQuoteSpan(page.text, 'The committee reviewed')).not.toBeNull()
  })

  it('maps the span back to the page text', () => {
    const span = findQuoteSpan(page.text, 'provided by the applicant')!
    expect(page.text.slice(span.start, span.end)).toBe('provided by the  applicant')
  })

  it('gives the rectangles on the lines the quote covers', () => {
    const rects = findQuoteRects(page, 'reviewed the information provided')!
    expect(rects).toHaveLength(2)
    expect(rects[0]![1]).toBe(700)
    expect(rects[1]![1]).toBe(686)
  })

  it('only the whole quote counts: one word off is not found, never a part of it', () => {
    // its first half is on the page, but a part could be another passage: page only
    expect(
      findQuoteSpan(
        page.text,
        'the information provided by the applicant and found the final well-known numbers',
      ),
    ).toBeNull()
    expect(
      findQuoteRects(
        page,
        'an unrelated opening about budgets, reviewed the information provided by the applicant',
      ),
    ).toBeNull()
  })

  it('says "not found" only briefly', () => {
    expect(QUOTE_NOT_FOUND_NOTICE_MS).toBeGreaterThanOrEqual(2000)
    expect(QUOTE_NOT_FOUND_NOTICE_MS).toBeLessThanOrEqual(3000)
  })

  it('finds nothing for words the page does not have', () => {
    expect(findQuoteSpan(page.text, 'an entirely different sentence about budgets')).toBeNull()
    expect(findQuoteRects(page, 'ab')).toBeNull()
    expect(findQuoteRects(undefined, 'the information provided')).toBeNull()
  })

  it('locates a citation through the search index, or answers null (page only)', async () => {
    const index: SearchIndex = [entryOf(['first page']), page]
    const found = await locateCitation(
      { page: 2, quote: 'provided by the applicant' },
      Promise.resolve(index),
    )
    expect(found?.origIdx).toBe(1)
    expect(found?.rects.length).toBeGreaterThan(0)
    expect(
      await locateCitation({ page: 2, quote: 'not on this page at all' }, Promise.resolve(index)),
    ).toBeNull()
    expect(await locateCitation({ page: 2 }, Promise.resolve(index))).toBeNull()
    expect(
      await locateCitation({ page: 9, quote: 'provided by' }, Promise.resolve(index)),
    ).toBeNull()
    expect(await locateCitation({ page: 2, quote: 'provided by the' }, null)).toBeNull()
  })
})
