import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Frame, type Page } from '@playwright/test'
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const at = (path: string): string => resolve(repo, path)

/** A small template family: one 61 KB file, Latin only */
const FAMILY = 'Bebas Neue'
const FILE = 'BebasNeue-Regular.ttf'

/** Template font files the page and its frames requested, by file name */
function watchTemplateFonts(page: Page): string[] {
  const fetched: string[] = []
  page.on('request', (request) => {
    const match = /\/template-fonts\/([^/?#]+)$/.exec(new URL(request.url()).pathname)
    if (match) fetched.push(decodeURIComponent(match[1]!))
  })
  return fetched
}

async function open(page: Page, name: string, buffer: Buffer): Promise<Frame> {
  await page.goto('/')
  await page.setInputFiles('#file', { name, buffer, mimeType: 'application/octet-stream' })
  await expect(page.locator('#status')).not.toContainText('여는 중', { timeout: 30_000 })
  await expect(page.locator('#status')).not.toContainText('오류')
  const app = name.slice(name.lastIndexOf('.') + 1)
  const dir = { docx: 'docs', xlsx: 'sheets', pptx: 'slides', hwp: 'hwp' }[app]!
  await expect.poll(() => page.frame({ url: new RegExp(`/${dir}/index\\.html`) })).toBeTruthy()
  return page.frame({ url: new RegExp(`/${dir}/index\\.html`) })!
}

/** Status of each face registered under `family` in the frame's document font set */
function faceStatuses(frame: Frame, family: string): Promise<string[]> {
  return frame.evaluate(
    (name) =>
      [...document.fonts]
        .filter((face) => face.family.replace(/^["']|["']$/g, '') === name)
        .map((face) => face.status),
    family,
  )
}

function rezip(path: string, edit: (name: string, text: string) => string): Buffer {
  const entries = unzipSync(readFileSync(path))
  for (const name of Object.keys(entries)) {
    if (!name.endsWith('.xml')) continue
    entries[name] = strToU8(edit(name, strFromU8(entries[name]!)))
  }
  return Buffer.from(zipSync(entries))
}

/** One paragraph set in `family` */
function docxIn(family: string): Buffer {
  const files: Zippable = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    ),
    'word/document.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        `<w:p><w:r><w:rPr><w:rFonts w:ascii="${family}" w:hAnsi="${family}"/></w:rPr>` +
        '<w:t>TEMPLATE FONT HEADLINE</w:t></w:r></w:p>' +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>' +
        '</w:body></w:document>',
    ),
  }
  return Buffer.from(zipSync(files))
}

function firstXlsx(): string {
  const dir = at('apps/sheets/fixtures/generated')
  const name = readdirSync(dir)
    .filter((file) => file.endsWith('.xlsx'))
    .sort()[0]
  if (!name) throw new Error(`no .xlsx in ${dir}`)
  return resolve(dir, name)
}

test('docs draws a paragraph set in a template family with the real face, fetching only it', async ({
  page,
}) => {
  const fetched = watchTemplateFonts(page)
  const frame = await open(page, 'headline.docx', docxIn(FAMILY))
  await expect.poll(() => faceStatuses(frame, FAMILY), { timeout: 20_000 }).toContain('loaded')
  expect([...new Set(fetched)]).toEqual([FILE])
})

test('sheets draws cells in a template family with the real face, fetching only it', async ({
  page,
}) => {
  const fetched = watchTemplateFonts(page)
  // cell A1 styled in the template family; the Normal font stays Calibri
  const styles =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
    `<font><sz val="11"/><name val="${FAMILY}"/></font></fonts>` +
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf fontId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf fontId="0" xfId="0"/><xf fontId="1" xfId="0" applyFont="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  const xlsx = rezip(firstXlsx(), (name, xml) => {
    if (name === 'xl/styles.xml') return styles
    if (name !== 'xl/worksheets/sheet1.xml') return xml
    expect(xml).toContain('<c r="A1" t="inlineStr">')
    return xml.replace('<c r="A1" t="inlineStr">', '<c r="A1" s="1" t="inlineStr">')
  })
  const frame = await open(page, 'cells.xlsx', xlsx)
  await expect.poll(() => faceStatuses(frame, FAMILY), { timeout: 20_000 }).toContain('loaded')
  expect([...new Set(fetched)]).toEqual([FILE])
})

test('slides lays out and draws a theme font from the template set, fetching only it', async ({
  page,
}) => {
  const fetched = watchTemplateFonts(page)
  const pptx = rezip(
    at('packages/pptx-engine/tests/fixtures/01_standard_business.pptx'),
    (_, xml) => xml.replace(/<a:latin typeface="Calibri"/g, `<a:latin typeface="${FAMILY}"`),
  )
  const frame = await open(page, 'deck.pptx', pptx)
  await expect.poll(() => faceStatuses(frame, FAMILY), { timeout: 20_000 }).toContain('loaded')
  expect([...new Set(fetched)]).toEqual([FILE])
})

test('a document that names no template family fetches no template font', async ({ page }) => {
  const fetched = watchTemplateFonts(page)
  const frame = await open(page, 'simple.docx', readFileSync(at('fixtures/generated/simple.docx')))
  await expect(frame.getByText('\u7b2c\u4e00\u6bb5\u3002').first()).toBeVisible()
  expect(fetched).toEqual([])
})

test('the hwp studio loads its old-Hangul face', async ({ page }) => {
  const failures: string[] = []
  page.on('console', (message) => {
    // the studio's own failure line (its word for "failed"), or the browser's failed-resource error
    const failed = message.type() === 'error' || message.text().includes('\uc2e4\ud328')
    const about = `${message.text()} ${message.location().url}`
    if (failed && about.includes('RHWPOldHangul')) failures.push(about)
  })
  await open(page, 'memo.hwp', readFileSync(at('apps/hwp/tests/fixtures/memo.hwp')))
  await expect.poll(() => page.frame({ url: /\/hwp\/studio\// })).toBeTruthy()
  const studio = page.frame({ url: /\/hwp\/studio\// })!
  await expect
    .poll(() => faceStatuses(studio, 'RHWP Old Hangul'), { timeout: 20_000 })
    .toContain('loaded')
  expect(failures).toEqual([])
})
