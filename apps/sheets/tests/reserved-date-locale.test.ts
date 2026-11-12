import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import JSZip from 'jszip'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { getUiLang, normalizeLang, requestedLanguage, setUiLang } from '@genoffice/i18n'
import { documentLocale } from '../src/main/document-locale'
import { XlsxSidecarClient } from '../src/main/xlsx-sidecar-client'

// Builtin number formats 27-36 and 50-58 record no pattern in the file; the
// viewer resolves them for its own language. The UI has two languages, the
// engine's tables have more: a workbook must be read for the language the
// install asks for, as it was when that language was also a UI language.

const RESERVED_IDS = [27, 30, 31, 36, 50, 57, 58]

const openedStyles = z.object({
  styles: z.array(z.object({ numberFormat: z.string().optional() })),
})

describe('date formats a workbook leaves to its viewer', () => {
  let directory: string
  let workbookPath: string
  let client: XlsxSidecarClient

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'reserved-date-locale-'))
    workbookPath = join(directory, 'reserved.xlsx')
    await writeFile(workbookPath, await buildReservedDateFixture())
    client = new XlsxSidecarClient(sidecarBinaryPath())
  })

  afterAll(async () => {
    client.stop()
    await rm(directory, { recursive: true, force: true })
  })

  afterEach(() => setUiLang('en'))

  /** the pattern the engine resolves for each reserved id, opened with this locale */
  async function patternsOpenedWith(locale: string): Promise<Array<string | undefined>> {
    const opened = openedStyles.parse(await client.open(workbookPath, locale))
    // xf 0 is the default style; the reserved ids follow in order
    return RESERVED_IDS.map((_id, index) => opened.styles[index + 1]?.numberFormat)
  }

  /** start the way the app does: the UI gets the narrowed language, the request goes along */
  function startInstall(stored: string | undefined, system: string): void {
    const requested = requestedLanguage(stored, system)
    setUiLang(normalizeLang(requested), requested)
  }

  // [the system language of an install that stored no choice, the UI language
  // code it had before the UI was narrowed to two languages: the code the
  // engine was opened with then]
  it.each([
    ['ja-JP', 'ja'],
    ['zh-CN', 'zh'],
    ['zh-TW', 'zh-TW'],
    ['de-DE', 'de'],
    ['fr-FR', 'fr'],
  ])(
    'reads a workbook on a %s system the way that language does, with the UI in English',
    async (system, former) => {
      startInstall(undefined, system)
      expect(getUiLang()).toBe('en')

      const patterns = await patternsOpenedWith(documentLocale())

      expect(patterns).toEqual(await patternsOpenedWith(former))
      expect(patterns).not.toEqual(await patternsOpenedWith('en'))
    },
  )

  it('keeps a Japanese choice stored before the UI had two languages, on a Korean system', async () => {
    startInstall('ja', 'ko-KR')
    expect(getUiLang()).toBe('en')

    expect(await patternsOpenedWith(documentLocale())).toEqual(await patternsOpenedWith('ja'))
  })

  it('reads a workbook on a Korean system the Korean way', async () => {
    startInstall(undefined, 'ko-KR')
    expect(getUiLang()).toBe('ko')

    const patterns = await patternsOpenedWith(documentLocale())

    expect(patterns).toEqual(await patternsOpenedWith('ko'))
    expect(patterns).not.toEqual(await patternsOpenedWith('en'))
  })

  it('lets a stored choice win over the system: English on a Japanese system, Korean on an English one', async () => {
    startInstall('en', 'ja-JP')
    expect(await patternsOpenedWith(documentLocale())).toEqual(await patternsOpenedWith('en'))

    startInstall('ko', 'en-US')
    expect(await patternsOpenedWith(documentLocale())).toEqual(await patternsOpenedWith('ko'))
  })

  it('follows a language chosen in Settings after the start', async () => {
    startInstall(undefined, 'ja-JP')
    setUiLang('ko')

    expect(await patternsOpenedWith(documentLocale())).toEqual(await patternsOpenedWith('ko'))
  })
})
function sidecarBinaryPath(): string {
  const executable = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
  return fileURLToPath(
    new URL(`../native/xlsx-engine/target/release/${executable}`, import.meta.url),
  )
}

async function buildReservedDateFixture(): Promise<Buffer> {
  const xfs = RESERVED_IDS.map((id) => `<xf numFmtId="${id}" applyNumberFormat="1"/>`).join('')
  const cells = RESERVED_IDS.map(
    (_id, index) => `<c r="${String.fromCharCode(65 + index)}1" s="${index + 1}"><v>45651</v></c>`,
  ).join('')
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  )
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  )
  zip.file(
    'xl/styles.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font/></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf/></cellStyleXfs>
  <cellXfs count="${RESERVED_IDS.length + 1}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>${xfs}</cellXfs>
</styleSheet>`,
  )
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData><row r="1">${cells}</row></sheetData>
</worksheet>`,
  )
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
