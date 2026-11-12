import { describe, expect, it } from 'vitest'
import { decodeCsvBuffer } from '../src/gateway/csv-import'
import { documentLocaleFor, legacyCsvCharsetFor } from '../src/shared/document-locale'

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

// The same two rows, a header and one sale of 5000, as Excel saves a CSV on a
// machine of each language: its legacy code page, no byte-order mark.
const SALES_CSV = [
  {
    system: 'ja-JP',
    text: '売上,金額\n東京,5000\n',
    bytes: [
      148, 132, 143, 227, 44, 139, 224, 138, 122, 10, 147, 140, 139, 158, 44, 53, 48, 48, 48, 10,
    ],
  },
  {
    system: 'zh-CN',
    text: '销售,金额\n北京,5000\n',
    bytes: [
      207, 250, 202, 219, 44, 189, 240, 182, 238, 10, 177, 177, 190, 169, 44, 53, 48, 48, 48, 10,
    ],
  },
  {
    system: 'zh-TW',
    text: '銷售,金額\n臺北,5000\n',
    bytes: [190, 80, 176, 226, 44, 170, 247, 195, 66, 10, 187, 79, 165, 95, 44, 53, 48, 48, 48, 10],
  },
  {
    system: 'ko-KR',
    text: '품목,금액\n라떼,5000\n',
    bytes: [
      199, 176, 184, 241, 44, 177, 221, 190, 215, 10, 182, 243, 182, 188, 44, 53, 48, 48, 48, 10,
    ],
  },
]

describe('an unmarked CSV in a legacy code page', () => {
  it.each(SALES_CSV)('reads as written on a $system system', ({ system, text, bytes }) => {
    const charset = legacyCsvCharsetFor(documentLocaleFor(system))
    expect(decodeCsvBuffer(new Uint8Array(bytes), charset)).toBe(text)
  })

  it('needs the language to tell Japanese bytes from Chinese ones', () => {
    const japanese = SALES_CSV[0]!
    const read = (system: string): string =>
      decodeCsvBuffer(
        new Uint8Array(japanese.bytes),
        legacyCsvCharsetFor(documentLocaleFor(system)),
      )
    expect(read('ja-JP')).toBe(japanese.text)
    expect(read('zh-CN')).not.toBe(japanese.text)
  })

  it('has no code page to prefer where the system never had one', () => {
    expect(legacyCsvCharsetFor(documentLocaleFor('en-US'))).toBeUndefined()
    expect(legacyCsvCharsetFor(documentLocaleFor('de-DE'))).toBeUndefined()
  })
})
