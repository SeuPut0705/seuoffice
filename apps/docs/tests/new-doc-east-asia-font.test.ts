/**
 * A new blank document declares the East Asian default font of the language
 * the install asks for, which the UI may no longer have: the font is part of
 * the document, not of the app's text.
 */
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'

import {
  documentLocale,
  getUiLang,
  normalizeLang,
  requestedLanguage,
  setUiLang,
} from '@genoffice/i18n'
import { setDocumentLocale } from '../src/renderer/document-locale'
import { blankDocxBytes } from '../src/renderer/file-actions'

/** start the install the way the docs window does, then make a new document */
async function newDocumentOn(system: string): Promise<string | undefined> {
  const requested = requestedLanguage(undefined, system)
  setUiLang(normalizeLang(requested), requested)
  setDocumentLocale(documentLocale())
  const zip = await JSZip.loadAsync(await blankDocxBytes())
  const styles = (await zip.file('word/styles.xml')?.async('string')) ?? ''
  const defaults = /<w:rPrDefault>[\s\S]*?<\/w:rPrDefault>/.exec(styles)?.[0] ?? ''
  return /<w:rFonts\b[^>]*\bw:eastAsia="([^"]*)"/.exec(defaults)?.[1]
}

afterEach(() => {
  setUiLang('en')
  setDocumentLocale('en')
})

describe('the East Asian font of a new document', () => {
  it('is the Japanese default on a Japanese install with the UI in English', async () => {
    const font = await newDocumentOn('ja-JP')
    expect(getUiLang()).toBe('en')
    expect(font).toBe('Yu Mincho')
  })

  it('is the Korean default on a Korean install, as before', async () => {
    expect(await newDocumentOn('ko-KR')).toBe('Malgun Gothic')
  })

  it('is left to the system on an English install, as before', async () => {
    expect(await newDocumentOn('en-US')).toBeUndefined()
  })
})
