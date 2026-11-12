import { afterEach, describe, expect, it } from 'vitest'

import { getUiLang, normalizeLang, requestedLanguage, setUiLang } from '@seuoffice/i18n'
import { decodeCsvBuffer } from '@seuoffice/xlsx-gateway/gateway/csv-import'
import { legacyCsvCharset } from '../src/main/document-locale'

// Excel saves a CSV in the legacy code page of the machine and marks nothing.
// Bytes that read cleanly in more than one code page are settled by the
// language of the install; with a wrong guess the file opens as other
// characters. The UI has two languages, the installs have more.

/** "sales,amount / Tokyo,5000" as a Japanese Excel saves it: Shift_JIS, no byte-order mark */
const SHIFT_JIS = {
  text: '売上,金額\n東京,5000\n',
  bytes: new Uint8Array([
    148, 132, 143, 227, 44, 139, 224, 138, 122, 10, 147, 140, 139, 158, 44, 53, 48, 48, 48, 10,
  ]),
}
/** the same two rows from a Taiwanese Excel: Big5 */
const BIG5 = {
  text: '銷售,金額\n臺北,5000\n',
  bytes: new Uint8Array([
    190, 80, 176, 226, 44, 170, 247, 195, 66, 10, 187, 79, 165, 95, 44, 53, 48, 48, 48, 10,
  ]),
}
/** from a mainland Chinese Excel: GBK */
const GBK = {
  text: '销售,金额\n北京,5000\n',
  bytes: new Uint8Array([
    207, 250, 202, 219, 44, 189, 240, 182, 238, 10, 177, 177, 190, 169, 44, 53, 48, 48, 48, 10,
  ]),
}
/** from a Korean Excel: code page 949 */
const CP949 = {
  text: '품목,금액\n라떼,5000\n',
  bytes: new Uint8Array([
    199, 176, 184, 241, 44, 177, 221, 190, 215, 10, 182, 243, 182, 188, 44, 53, 48, 48, 48, 10,
  ]),
}

/** start the way the app does: the UI gets the narrowed language, the request goes along */
function startInstall(stored: string | undefined, system: string): void {
  const requested = requestedLanguage(stored, system)
  setUiLang(normalizeLang(requested), requested)
}

afterEach(() => setUiLang('en'))

describe('opening an unmarked CSV', () => {
  it.each([
    ['ja-JP', SHIFT_JIS],
    ['zh-TW', BIG5],
    ['zh-CN', GBK],
  ])('reads it as written on a %s system, with the UI in English', async (system, file) => {
    startInstall(undefined, system)
    expect(getUiLang()).toBe('en')

    expect(await decodeCsvBuffer(file.bytes, legacyCsvCharset())).toBe(file.text)
  })

  it('reads a Korean file as written on a Korean system', async () => {
    startInstall(undefined, 'ko-KR')

    expect(await decodeCsvBuffer(CP949.bytes, legacyCsvCharset())).toBe(CP949.text)
  })

  it('keeps a Japanese choice stored before the UI had two languages', async () => {
    startInstall('ja', 'ko-KR')
    expect(getUiLang()).toBe('en')

    expect(await decodeCsvBuffer(SHIFT_JIS.bytes, legacyCsvCharset())).toBe(SHIFT_JIS.text)
  })
})
