import { describe, expect, it } from 'vitest'
import { documentLocaleFor } from '../src/index'

describe('documentLocaleFor', () => {
  it('reads a system tag down to the code documents are keyed by', () => {
    expect(documentLocaleFor('ja-JP')).toBe('ja')
    expect(documentLocaleFor('ja')).toBe('ja')
    expect(documentLocaleFor('ko_KR')).toBe('ko')
    expect(documentLocaleFor('de-DE')).toBe('de')
    expect(documentLocaleFor('pt-BR')).toBe('pt')
    expect(documentLocaleFor(' NL-nl ')).toBe('nl')
  })

  it('reads the tags a browser reports, region and all', () => {
    expect(documentLocaleFor('ko-KR')).toBe('ko')
    expect(documentLocaleFor('en-US')).toBe('en')
    expect(documentLocaleFor('ja-JP')).toBe('ja')
    expect(documentLocaleFor('zh-CN')).toBe('zh')
    expect(documentLocaleFor('zh-TW')).toBe('zh-TW')
    expect(documentLocaleFor('xx-XX')).toBe('en')
  })

  it('tells traditional-script Chinese from simplified', () => {
    expect(documentLocaleFor('zh-CN')).toBe('zh')
    expect(documentLocaleFor('zh')).toBe('zh')
    expect(documentLocaleFor('zh-Hans')).toBe('zh')
    expect(documentLocaleFor('zh-TW')).toBe('zh-TW')
    expect(documentLocaleFor('zh_HK')).toBe('zh-TW')
    expect(documentLocaleFor('zh-Hant-MO')).toBe('zh-TW')
  })

  it('reads the legacy codes some systems report for Indonesian and Hebrew', () => {
    expect(documentLocaleFor('in')).toBe('id')
    expect(documentLocaleFor('in_ID')).toBe('id')
    expect(documentLocaleFor('iw-IL')).toBe('he')
  })

  it('reads a language without a code, and no value, as English', () => {
    expect(documentLocaleFor('sv-SE')).toBe('en')
    expect(documentLocaleFor('en-GB')).toBe('en')
    expect(documentLocaleFor('india')).toBe('en')
    expect(documentLocaleFor('')).toBe('en')
    expect(documentLocaleFor(null)).toBe('en')
    expect(documentLocaleFor(undefined)).toBe('en')
  })
})
