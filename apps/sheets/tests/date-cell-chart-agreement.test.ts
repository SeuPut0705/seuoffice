import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { numfmt } from '@univerjs/core'
import JSZip from 'jszip'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  documentLocale,
  getUiLang,
  normalizeLang,
  requestedLanguage,
  setUiLang,
} from '@seuoffice/i18n'
import { chartCategoryFormat } from '@seuoffice/xlsx-gateway/domain/chart-visual'
import { XlsxSidecarClient } from '../src/main/xlsx-sidecar-client'
import { workbookFileSchema } from '../src/shared/desktop-api'
import { setDocumentLocale } from '../src/renderer/document-locale'
import { setModuleLang } from '../src/renderer/i18n/locale'
import { applyNumfmtLocale } from '../src/renderer/univer-locales'
import { BarChart } from '../src/renderer/WorkbookVisuals'

vi.mock('@univerjs/preset-sheets-core', () => ({
  SheetsNumfmtCellContentController: class SheetsNumfmtCellContentController {},
}))

// One workbook: a date in A1 whose format spells the month and the weekday, and a
// chart whose category is that cell. Opened the way the app opens it, the grid
// draws the cell and the chart draws its category label; both must be in the
// language the install asks for, which the UI no longer has.

const DATE = 45651 // 2024-12-25, a Wednesday
// short enough for a category tick, which keeps at most 16 characters
const FORMAT = 'mmm d (ddd)'

// what the app makes of the engine's answer when it opens a workbook (sheets-main.ts)
const opened = workbookFileSchema.omit({ sha256: true, readOnly: true })

describe('a date cell and a chart of it, in one workbook', () => {
  let directory: string
  let workbookPath: string
  let client: XlsxSidecarClient

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'date-cell-chart-'))
    workbookPath = join(directory, 'sales.xlsx')
    await writeFile(workbookPath, await buildWorkbook())
    client = new XlsxSidecarClient(sidecarBinaryPath())
  })

  afterAll(async () => {
    client.stop()
    await rm(directory, { recursive: true, force: true })
  })

  afterEach(() => {
    setUiLang('en')
    setModuleLang('en')
    setDocumentLocale('en')
  })

  /** start the install the way the app does, open the workbook, draw the cell and the chart */
  async function drawOn(system: string): Promise<{ cell: string; chart: string }> {
    const requested = requestedLanguage(undefined, system)
    setUiLang(normalizeLang(requested), requested)
    setModuleLang(getUiLang())
    // what the window is handed at boot
    setDocumentLocale(documentLocale())

    const workbook = opened.parse(await client.open(workbookPath, documentLocale()))

    // the grid formats a cell with the locale its number-format controller was given
    let gridLocale = ''
    applyNumfmtLocale({
      univer: {
        __getInjector: () => ({
          get: () => ({ setNumfmtLocal: (locale: string) => (gridLocale = locale) }),
        }),
      },
    } as never)
    const cellFormat = workbook.styles[1]?.numberFormat
    if (cellFormat === undefined) throw new Error('the date cell has no number format')
    const cell = numfmt.format(cellFormat, DATE, { locale: gridLocale })

    const chart = workbook.visuals.find((visual) => visual.kind === 'chart')?.chart
    if (!chart) throw new Error('the workbook has no chart')
    const markup = renderToStaticMarkup(
      createElement(BarChart, {
        seriesList: chart.series.map((series) => ({
          name: series.name ?? '',
          categories: series.categories,
          values: series.values,
        })),
        isHorizontal: false,
        categoryFormat: chartCategoryFormat(chart),
      }),
    )
    return { cell, chart: markup }
  }

  it('are both Japanese on a Japanese install with the UI in English', async () => {
    const { cell, chart } = await drawOn('ja-JP')
    expect(getUiLang()).toBe('en')

    expect(cell).toBe(numfmt.format(FORMAT, DATE, { locale: 'ja-JP' }))
    expect(cell).not.toBe(numfmt.format(FORMAT, DATE, { locale: 'en' }))
    expect(chart).toContain(cell)
  })

  it('are both English on an English install, as before', async () => {
    const { cell, chart } = await drawOn('en-US')

    expect(cell).toBe(numfmt.format(FORMAT, DATE, { locale: 'en' }))
    expect(chart).toContain(cell)
  })

  it('are both Korean on a Korean install, as before', async () => {
    const { cell, chart } = await drawOn('ko-KR')

    expect(cell).toBe(numfmt.format(FORMAT, DATE, { locale: 'ko-KR' }))
    expect(chart).toContain(cell)
  })
})

function sidecarBinaryPath(): string {
  const executable = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
  return fileURLToPath(
    new URL(`../native/xlsx-engine/target/release/${executable}`, import.meta.url),
  )
}

async function buildWorkbook(): Promise<Buffer> {
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
  <Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
  <Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
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
  <numFmts count="1"><numFmt numFmtId="164" formatCode="${FORMAT}"/></numFmts>
  <fonts count="1"><font/></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf/></cellStyleXfs>
  <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs>
</styleSheet>`,
  )
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetData><row r="1"><c r="A1" s="1"><v>${DATE}</v></c><c r="B1"><v>12</v></c></row></sheetData>
  <drawing r:id="rId1"/>
</worksheet>`,
  )
  zip.file(
    'xl/worksheets/_rels/sheet1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`,
  )
  zip.file(
    'xl/drawings/drawing1.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="1" name="Sales"/></xdr:nvGraphicFramePr>
      <a:graphic><a:graphicData><c:chart r:id="rId1"/></a:graphicData></a:graphic>
    </xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>
</xdr:wsDr>`,
  )
  zip.file(
    'xl/drawings/_rels/drawing1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
</Relationships>`,
  )
  zip.file(
    'xl/charts/chart1.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:ser>
    <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Sales</c:v></c:pt></c:strCache></c:strRef></c:tx>
    <c:cat><c:numRef><c:f>Data!$A$1</c:f><c:numCache><c:formatCode>${FORMAT}</c:formatCode><c:pt idx="0"><c:v>${DATE}</c:v></c:pt></c:numCache></c:numRef></c:cat>
    <c:val><c:numRef><c:f>Data!$B$1</c:f><c:numCache><c:formatCode>General</c:formatCode><c:pt idx="0"><c:v>12</c:v></c:pt></c:numCache></c:numRef></c:val>
  </c:ser></c:barChart></c:plotArea></c:chart>
</c:chartSpace>`,
  )
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
