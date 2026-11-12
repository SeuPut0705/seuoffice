import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Download, type FrameLocator, type Page } from '@playwright/test'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'

const FIXTURE = readFileSync(
  fileURLToPath(new URL('../../pdf/tests/fixtures/plain-sample.pdf', import.meta.url)),
)
const KEPT_TEXT = 'This line must survive the round trip.'

/** Opens PDF bytes in the launcher, for editing (`#edit`) or for viewing */
async function open(page: Page, bytes: Buffer, edit: boolean): Promise<FrameLocator> {
  await page.goto('/')
  await page.locator('#edit').setChecked(edit)
  await page.setInputFiles('#file', {
    name: 'plain-sample.pdf',
    mimeType: 'application/pdf',
    buffer: bytes,
  })
  await expect(page.locator('#status')).not.toContainText('여는 중', { timeout: 30_000 })
  const app = page.frameLocator('#viewer iframe')
  await expect(app.getByText(KEPT_TEXT).first()).toBeVisible({ timeout: 20_000 })
  return app
}

async function rotateFirstPage(app: FrameLocator): Promise<void> {
  await app.locator('.ribbon-tab', { hasText: '페이지' }).click()
  await app.getByRole('button', { name: '오른쪽으로 회전' }).click()
}

/** Draws a rectangle comment across the middle of the first page */
async function drawRectangle(page: Page, app: FrameLocator): Promise<void> {
  await app.locator('.ribbon-tab', { hasText: '주석' }).click()
  await app.getByRole('button', { name: '사각형', exact: true }).click()
  const box = await app.locator('.pdf-draw-layer').first().boundingBox()
  if (!box) throw new Error('no draw layer on the first page')
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 8 })
  await page.mouse.up()
}

async function pressSave(page: Page, app: FrameLocator): Promise<void> {
  await app.locator('.pdf-page-content').first().click()
  await page.keyboard.press('ControlOrMeta+s')
}

const loaded = async (download: Download): Promise<{ bytes: Buffer; pdf: PDFDocument }> => {
  const bytes = readFileSync(await download.path())
  return { bytes, pdf: await PDFDocument.load(bytes) }
}

const annotSubtypes = (pdf: PDFDocument): string[] =>
  (pdf.getPage(0).node.Annots()?.asArray() ?? []).map((ref) =>
    String(pdf.context.lookup(ref, PDFDict).get(PDFName.of('Subtype'))),
  )

/** The first page's content streams: the fixture's text drawing lives here */
function pageContent(pdf: PDFDocument): string {
  const contents = pdf.getPage(0).node.Contents()
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => pdf.context.lookup(ref))
      : [contents]
  return streams
    .map((stream) => {
      if (!(stream instanceof PDFRawStream)) throw new Error('page 1 has no raw content stream')
      return Buffer.from(stream.contents).toString('latin1')
    })
    .join('\n')
}

test('saves PDF edits to the host from the app and on the host’s request', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const original = await PDFDocument.load(FIXTURE)
  const app = await open(page, FIXTURE, true)

  await rotateFirstPage(app)
  await expect(page.locator('#status')).toContainText('저장 안 함')
  const appSave = page.waitForEvent('download')
  await pressSave(page, app)
  const first = await loaded(await appSave)
  await expect(app.locator('.tb-save-ok')).toBeVisible()
  await expect(page.locator('#status')).not.toContainText('저장 안 함')
  expect(first.pdf.getPageCount()).toBe(1)
  expect(first.pdf.getPage(0).getRotation().angle).toBe(90)
  expect(pageContent(first.pdf)).toBe(pageContent(original))

  await drawRectangle(page, app)
  await expect(page.locator('#status')).toContainText('저장 안 함')
  const hostSave = page.waitForEvent('download')
  await page.locator('#save').click()
  const second = await loaded(await hostSave)
  await expect(page.locator('#status')).not.toContainText('저장 안 함')
  expect(annotSubtypes(second.pdf)).toEqual(['/Square'])
  expect(pageContent(second.pdf)).toBe(pageContent(original))

  // the stored document opens again with its text
  await open(page, second.bytes, false)
  expect(errors).toEqual([])
})

test('a save the host refuses keeps the PDF unsaved with the host’s reason', async ({ page }) => {
  const app = await open(page, FIXTURE, true)
  // the launcher stores a save as a download; make that fail once
  await page.evaluate(() => {
    const create = URL.createObjectURL
    URL.createObjectURL = (blob) => {
      URL.createObjectURL = create
      throw new Error(`disk full (${(blob as Blob).size} bytes)`)
    }
  })

  await rotateFirstPage(app)
  await pressSave(page, app)
  await expect(app.locator('.tb-save-error')).toHaveAttribute('data-tip', /disk full/)
  await expect(page.locator('#status')).toContainText('저장 안 함')

  const retry = page.waitForEvent('download')
  await page.locator('#save').click()
  const saved = await loaded(await retry)
  expect(saved.pdf.getPage(0).getRotation().angle).toBe(90)
  await expect(page.locator('#status')).not.toContainText('저장 안 함')
})

test('a text edit, which needs the desktop engine, is refused and kept unsaved', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const app = await open(page, FIXTURE, true)
  let downloads = 0
  page.on('download', () => downloads++)

  await app.locator('.ribbon-tab', { hasText: '편집' }).first().click()
  await app.getByRole('button', { name: '텍스트 편집', exact: true }).click()
  await app.getByText(KEPT_TEXT).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Edited')
  await page.keyboard.press('ControlOrMeta+s')

  await expect(app.locator('.tb-save-error')).toHaveAttribute('data-tip', /텍스트 편집/)
  await expect(page.locator('#status')).toContainText('저장 안 함')
  expect(downloads).toBe(0)
  expect(errors).toEqual([])
})

test('certificate signing, which needs the desktop app, says so instead of opening', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const app = await open(page, FIXTURE, true)

  await app.locator('.ribbon-tab', { hasText: '주석' }).click()
  await app.getByRole('button', { name: '인증서 서명', exact: true }).click()
  await expect(app.getByText('인증서 서명은 데스크톱 앱에서만 할 수 있습니다')).toBeVisible()
  await expect(app.locator('.pdf-cert-dialog')).toBeHidden()
  expect(errors).toEqual([])
})

test('a PDF opened for viewing can be neither changed nor saved', async ({ page }) => {
  const app = await open(page, FIXTURE, false)
  await expect(page.locator('#save')).toBeHidden()
  let downloads = 0
  page.on('download', () => downloads++)

  await app.locator('.ribbon-tab', { hasText: '페이지' }).click()
  await expect(app.getByRole('button', { name: '오른쪽으로 회전' })).toBeDisabled()
  await app.locator('.ribbon-tab', { hasText: '주석' }).click()
  await expect(app.getByRole('button', { name: '사각형', exact: true })).toBeDisabled()
  await expect(app.locator('.tb-readonly')).toBeVisible()

  await pressSave(page, app)
  await expect(app.locator('.tb-save-pending')).toBeHidden()
  await expect(app.locator('.tb-save-error')).toBeHidden()
  expect(downloads).toBe(0)
})
