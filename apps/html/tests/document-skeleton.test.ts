import { describe, expect, it } from 'vitest'

import { documentSkeleton } from '../src/renderer/document/skeleton'
import { isDocEmpty } from '../src/renderer/document/blank'

describe('documentSkeleton', () => {
  it('opens in standards mode', () => {
    // a missing doctype puts the preview in quirks mode, where box sizing and
    // table layout follow different rules than the author expects
    expect(documentSkeleton('en').startsWith('<!DOCTYPE html>')).toBe(true)
  })

  it('declares the document language as the UI language', () => {
    expect(documentSkeleton('ko')).toContain('<html lang="ko-KR">')
    expect(documentSkeleton('en')).toContain('<html lang="en-US">')
  })

  it('declares the encoding before any content', () => {
    // a charset that arrives after the first bytes are decoded is mojibake
    const html = documentSkeleton('ko')
    expect(html).toContain('<meta charset="UTF-8">')
    expect(html.indexOf('<meta charset')).toBeLessThan(html.indexOf('<title>'))
  })

  it('carries the three structural elements a page needs', () => {
    const html = documentSkeleton('ko')
    expect(html).toContain('<head>')
    expect(html).toContain('<title></title>')
    expect(html).toContain('<body></body>')
  })

  it('leaves the page with no visible content, so the AI panel still offers generation', () => {
    // inserting a skeleton must not make the document look written: the head
    // carries no visible text, and isDocEmpty is what the AI panel branches on
    expect(isDocEmpty(documentSkeleton('en'))).toBe(true)
  })

  it('differs only in the lang tag across languages', () => {
    const ko = documentSkeleton('ko')
    const en = documentSkeleton('en')
    expect(ko.replace('ko-KR', 'LANG')).toBe(en.replace('en-US', 'LANG'))
  })

  it('ends with a newline, so appending to it does not join lines', () => {
    expect(documentSkeleton('en').endsWith('\n')).toBe(true)
  })
})
