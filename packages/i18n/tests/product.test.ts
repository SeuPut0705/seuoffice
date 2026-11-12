import { describe, expect, it } from 'vitest'
import {
  brandText,
  createI18n,
  DEV_USER_DATA_DIR_NAME,
  LANGS,
  PRODUCT_NAME,
  PRODUCT_REPO_NAME,
  PRODUCT_REPO_OWNER,
  PRODUCT_REPO_SLUG,
  productName,
  UPSTREAM_NAME_LITERAL,
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

describe('brandText', () => {
  it('swaps the upstream name for the product name of the language', () => {
    expect(brandText('Welcome to GenOffice', 'en')).toBe('Welcome to SeuOffice')
    expect(brandText('GenOffice에 오신 것을 환영합니다', 'ko')).toBe(
      'SeuOffice에 오신 것을 환영합니다',
    )
    expect(brandText('GenOffice のインストール', 'ja')).toBe('SeuOffice のインストール')
    expect(brandText('关于 GenOffice', 'zh')).toBe('关于 SeuOffice')
  })

  it('replaces every occurrence, including sub-app names and compounds', () => {
    expect(brandText('GenOffice Docs and GenOffice Sheets', 'en')).toBe(
      'SeuOffice Docs and SeuOffice Sheets',
    )
    expect(brandText('GenOffice Markdown', 'ko')).toBe('SeuOffice Markdown')
    expect(brandText('das GenOffice-Fenster', 'de')).toBe('das SeuOffice-Fenster')
    expect(brandText("GenOffice's window", 'en')).toBe("SeuOffice's window")
  })

  it('returns strings without the name untouched', () => {
    const plain = 'Save the file with ⌘S'
    expect(brandText(plain, 'ko')).toBe(plain)
    expect(brandText('', 'ko')).toBe('')
    // the command line and package names are lowercase and are not the display name
    expect(brandText('run `genoffice open` (@genoffice/cli, GENOFFICE_USER_DATA)', 'ko')).toBe(
      'run `genoffice open` (@genoffice/cli, GENOFFICE_USER_DATA)',
    )
  })

  it('prints the literal upstream name where the text escapes it', () => {
    expect(UPSTREAM_PRODUCT_NAME).toBe('GenOffice')
    expect(UPSTREAM_NAME_LITERAL).toBe('{{GenOffice}}')
    expect(brandText('Based on {{GenOffice}}', 'en')).toBe('Based on GenOffice')
    expect(brandText('{{GenOffice}}를 바탕으로 만들었습니다', 'ko')).toBe(
      'GenOffice를 바탕으로 만들었습니다',
    )
    expect(brandText('GenOffice is based on {{GenOffice}}.', 'en')).toBe(
      'SeuOffice is based on GenOffice.',
    )
    expect(brandText('GenOffice는 {{GenOffice}}를 바탕으로 합니다.', 'ko')).toBe(
      'SeuOffice는 GenOffice를 바탕으로 합니다.',
    )
  })

  it('uses the product name inside file and folder names in every language', () => {
    expect(brandText('chmod +x GenOffice-<version>.AppImage', 'ko')).toBe(
      'chmod +x SeuOffice-<version>.AppImage',
    )
    expect(brandText('문서/GenOffice 폴더', 'ko')).toBe('문서/SeuOffice 폴더')
    expect(brandText('%APPDATA%\\GenOffice', 'ko')).toBe('%APPDATA%\\SeuOffice')
    expect(brandText('GenOffice.exe를 실행합니다', 'ko')).toBe('SeuOffice.exe를 실행합니다')
    // a sentence-ending period is not a file extension
    expect(brandText('이것은 GenOffice. 다음 문장', 'ko')).toBe('이것은 SeuOffice. 다음 문장')
    expect(brandText('GenOffice.', 'ko')).toBe('SeuOffice.')
  })

  it('leaves identifiers that merely contain the name alone', () => {
    expect(brandText('GenOfficeFormField', 'en')).toBe('GenOfficeFormField')
    expect(brandText('_GenOfficeCoverPage', 'en')).toBe('_GenOfficeCoverPage')
    expect(brandText('MyGenOffice', 'en')).toBe('MyGenOffice')
  })
})

describe('createI18n product name', () => {
  const dicts: LangDicts<{ about: string; ack: string; open: string }> = {
    en: {
      about: 'About GenOffice',
      ack: 'Based on {{GenOffice}}',
      open: 'Open {name} in GenOffice',
    },
    ko: {
      about: 'GenOffice 정보',
      ack: '{{GenOffice}} 기반',
      open: 'GenOffice에서 {name} 열기',
    },
  }
  const t = createI18n(dicts)

  it('renders the product name of the requested language', () => {
    expect(t('en', 'about')).toBe('About SeuOffice')
    expect(t('ko', 'about')).toBe('SeuOffice 정보')
  })

  it('keeps the upstream name in the acknowledgement', () => {
    expect(t('en', 'ack')).toBe('Based on GenOffice')
    expect(t('ko', 'ack')).toBe('GenOffice 기반')
  })

  it('never rewrites interpolated values (a file may be called GenOffice)', () => {
    expect(t('en', 'open', { name: 'GenOffice notes.docx' })).toBe(
      'Open GenOffice notes.docx in SeuOffice',
    )
    expect(t('ko', 'open', { name: 'GenOffice.docx' })).toBe('SeuOffice에서 GenOffice.docx 열기')
  })
})

describe('registered names derived from the product name', () => {
  it('names the userData folders after the product name', () => {
    expect(USER_DATA_DIR_NAME).toBe('seuoffice')
    expect(DEV_USER_DATA_DIR_NAME).toBe('seuoffice-Dev')
    expect(USER_DATA_DIR_NAME).not.toBe(UPSTREAM_PRODUCT_NAME)
  })

  it('names the public repository once', () => {
    expect(PRODUCT_REPO_OWNER).toBe('SeuPut0705')
    expect(PRODUCT_REPO_NAME).toBe('seuoffice')
    expect(PRODUCT_REPO_SLUG).toBe('SeuPut0705/seuoffice')
  })
})
