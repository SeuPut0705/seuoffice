import { describe, expect, it } from 'vitest'
import {
  createI18n,
  DEV_USER_DATA_DIR_NAME,
  LANGS,
  PRODUCT_NAME,
  PRODUCT_REPO_NAME,
  PRODUCT_REPO_OWNER,
  PRODUCT_REPO_SLUG,
  productName,
  UPSTREAM_PRODUCT_NAME,
  USER_DATA_DIR_NAME,
  type LangDicts,
} from '../src/index'

describe('productName', () => {
  it('is the same name in every language', () => {
    for (const lang of LANGS) {
      expect(productName(lang), lang).toBe(PRODUCT_NAME)
    }
  })

  it('accepts raw locale tags and falls back to the same name', () => {
    for (const tag of ['ko-KR', 'KO_kr', 'en-US', '', undefined, null]) {
      expect(productName(tag), String(tag)).toBe(PRODUCT_NAME)
    }
  })

  it('has one PRODUCT_NAME definition that is not an upstream name', () => {
    expect(PRODUCT_NAME).toBe('SeuOffice')
    expect(PRODUCT_NAME).not.toBe(UPSTREAM_PRODUCT_NAME)
    expect(PRODUCT_NAME).not.toBe('IeumOffice')
    expect(productName('en')).toBe(PRODUCT_NAME)
  })
})

describe('createI18n and the product name', () => {
  const dicts: LangDicts<{ about: string; ack: string; open: string }> = {
    en: { about: 'About SeuOffice', ack: 'Based on {upstream}', open: 'Open {name} in SeuOffice' },
    ko: { about: 'SeuOffice 정보', ack: '{upstream} 기반', open: 'SeuOffice에서 {name} 열기' },
  }
  const t = createI18n(dicts)

  it('names the original work in the acknowledgement through its parameter', () => {
    const upstream = UPSTREAM_PRODUCT_NAME
    expect(UPSTREAM_PRODUCT_NAME).toBe('GenOffice')
    expect(t('en', 'ack', { upstream })).toBe('Based on GenOffice')
    expect(t('ko', 'ack', { upstream })).toBe('GenOffice 기반')
  })

  it('returns a text that names the original work as it is written', () => {
    // nothing swaps a name at run time any more: a file or a quoted title may really say GenOffice
    const quoting = createI18n<{ title: string }>({
      en: { title: 'Import from GenOffice' },
      ko: { title: 'GenOffice에서 가져오기' },
    })
    expect(quoting('en', 'title')).toBe('Import from GenOffice')
    expect(t('en', 'open', { name: 'GenOffice notes.docx' })).toBe(
      'Open GenOffice notes.docx in SeuOffice',
    )
  })
})

describe('registered names derived from the product name', () => {
  it('names the userData folders after the product name', () => {
    expect(USER_DATA_DIR_NAME).toBe('seuoffice')
    expect(DEV_USER_DATA_DIR_NAME).toBe('seuoffice-Dev')
    expect(USER_DATA_DIR_NAME).not.toBe(UPSTREAM_PRODUCT_NAME)
  })

  it('names the public repository once', () => {
    expect(PRODUCT_REPO_OWNER).toBe('seuput-inc')
    expect(PRODUCT_REPO_NAME).toBe('seuoffice')
    expect(PRODUCT_REPO_SLUG).toBe('seuput-inc/seuoffice')
  })
})
