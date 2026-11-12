import { describe, expect, it } from 'vitest'
import { decodeCsvBuffer } from '../src/gateway/csv-import'
import { legacyCsvCharsetFor } from '../src/shared/document-locale'

// The same two rows, a header and one sale of 5000, as Excel saves a CSV on a
// machine of each language: its legacy code page, no byte-order mark.
const SALES_CSV = [
  {
    locale: 'ja',
    text: '売上,金額\n東京,5000\n',
    bytes: [
      148, 132, 143, 227, 44, 139, 224, 138, 122, 10, 147, 140, 139, 158, 44, 53, 48, 48, 48, 10,
    ],
  },
  {
    locale: 'zh',
    text: '销售,金额\n北京,5000\n',
    bytes: [
      207, 250, 202, 219, 44, 189, 240, 182, 238, 10, 177, 177, 190, 169, 44, 53, 48, 48, 48, 10,
    ],
  },
  {
    locale: 'zh-TW',
    text: '銷售,金額\n臺北,5000\n',
    bytes: [190, 80, 176, 226, 44, 170, 247, 195, 66, 10, 187, 79, 165, 95, 44, 53, 48, 48, 48, 10],
  },
  {
    locale: 'ko',
    text: '품목,금액\n라떼,5000\n',
    bytes: [
      199, 176, 184, 241, 44, 177, 221, 190, 215, 10, 182, 243, 182, 188, 44, 53, 48, 48, 48, 10,
    ],
  },
]

describe('an unmarked CSV in a legacy code page', () => {
  it.each(SALES_CSV)(
    'reads as written where documents are read for $locale',
    async ({ locale, text, bytes }) => {
      const charset = legacyCsvCharsetFor(locale)
      expect(await decodeCsvBuffer(new Uint8Array(bytes), charset)).toBe(text)
    },
  )

  it('needs the language to tell Japanese bytes from Chinese ones', async () => {
    const japanese = SALES_CSV[0]!
    const read = (locale: string): Promise<string> =>
      decodeCsvBuffer(new Uint8Array(japanese.bytes), legacyCsvCharsetFor(locale))
    expect(await read('ja')).toBe(japanese.text)
    expect(await read('zh')).not.toBe(japanese.text)
  })

  it('has no code page to prefer where the system never had one', () => {
    expect(legacyCsvCharsetFor('en')).toBeUndefined()
    expect(legacyCsvCharsetFor('de')).toBeUndefined()
  })
})
