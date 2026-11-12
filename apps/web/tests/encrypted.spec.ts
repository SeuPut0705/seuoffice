import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocx } from '@seuoffice/docx-engine'
import {
  expect,
  test,
  type Download,
  type FrameLocator,
  type Locator,
  type Page,
} from '@playwright/test'
import officeCrypto from 'officecrypto-tool'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const pdfFixture = (name: string): Buffer =>
  readFileSync(resolve(repo, 'apps/pdf/tests/fixtures', name))

// the encrypted PDF fixtures' first page, and their password
const PDF_TEXT = 'Encrypted Edit Probe'
const PDF_PASSWORD = 's3cret'
const PLAIN_PDF_TEXT = 'This line must survive the round trip.'

// the docx fixture's Chinese text: "first paragraph." / "second paragraph."
const SIMPLE_DOCX = readFileSync(resolve(repo, 'fixtures/generated/simple.docx'))
const FIRST = '\u7b2c\u4e00\u6bb5\u3002'
const SECOND = '\u7b2c\u4e8c\u6bb5\u3002'
const DOCX_PASSWORD = 'docx-pw'
// the desktop's encryptor protects the fixture: ECMA-376 Agile (what Word writes) by default
const ENCRYPTED_DOCX = officeCrypto.encrypt(SIMPLE_DOCX, { password: DOCX_PASSWORD })
const STANDARD_DOCX = officeCrypto.encrypt(SIMPLE_DOCX, {
  password: DOCX_PASSWORD,
  type: 'standard',
})

const PDF_MIME = 'application/pdf'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** Hands bytes to the launcher, for editing (`#edit`) or viewing, and returns the app frame */
async function launch(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
  edit: boolean,
): Promise<FrameLocator> {
  await page.goto('/')
  await page.locator('#edit').setChecked(edit)
  await page.setInputFiles('#file', file)
  return page.frameLocator('#viewer iframe')
}

const downloaded = async (download: Promise<Download>): Promise<Buffer> =>
  readFileSync(await (await download).path())

async function enterPdfPassword(app: FrameLocator, password: string): Promise<void> {
  const field = app.locator('.pdf-pwd-dialog input')
  await expect(field).toBeVisible({ timeout: 30_000 })
  await field.fill(password)
  await field.press('Enter')
}

async function openPdf(page: Page, name: string, edit: boolean): Promise<FrameLocator> {
  const app = await launch(page, { name, mimeType: PDF_MIME, buffer: pdfFixture(name) }, edit)
  await enterPdfPassword(app, PDF_PASSWORD)
  await expect(app.getByText(PDF_TEXT).first()).toBeVisible({ timeout: 30_000 })
  return app
}

/** pdf.js in Node, an independent reader: the first page's text and rotation */
async function readPdf(
  bytes: Buffer,
  password?: string,
): Promise<{ text: string; rotation: number }> {
  const task = getDocument({ data: new Uint8Array(bytes), password })
  try {
    const first = await (await task.promise).getPage(1)
    const items = (await first.getTextContent()).items
    return {
      text: items.map((item) => ('str' in item ? item.str : '')).join(' '),
      rotation: first.rotate,
    }
  } finally {
    await task.destroy()
  }
}

async function pdfSave(page: Page, app: FrameLocator): Promise<Buffer> {
  const download = page.waitForEvent('download')
  await app.locator('.pdf-page-content').first().click()
  await page.keyboard.press('ControlOrMeta+s')
  const bytes = await downloaded(download)
  await expect(page.locator('#status')).not.toContainText('저장 안 함')
  return bytes
}

/** Clicks a ribbon button, first opening its tab unless it shows already (a second press folds the tab) */
async function ribbonButton(app: FrameLocator, tab: string, button: Locator): Promise<void> {
  if (!(await button.isVisible())) await app.locator('.ribbon-tab', { hasText: tab }).click()
  await button.click()
}

async function enterDocxPassword(frame: FrameLocator, password: string): Promise<void> {
  const field = frame.locator('.pwd-dialog input')
  await expect(field).toBeVisible({ timeout: 30_000 })
  await field.fill(password)
  await field.press('Enter')
}

async function openDocx(page: Page, buffer: Buffer, edit: boolean): Promise<FrameLocator> {
  const frame = await launch(page, { name: 'locked.docx', mimeType: DOCX_MIME, buffer }, edit)
  await enterDocxPassword(frame, DOCX_PASSWORD)
  await expect(frame.locator('.ProseMirror').getByText(FIRST)).toBeVisible({ timeout: 30_000 })
  return frame
}

/** Type at the end of the paragraph that holds `anchor` */
async function typeAfter(frame: FrameLocator, anchor: string, text: string): Promise<void> {
  await frame.locator('.ProseMirror').getByText(anchor, { exact: true }).first().click()
  const keyboard = frame.owner().page().keyboard
  await keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
  await keyboard.type(text)
}

async function docxSave(page: Page, frame: FrameLocator): Promise<Buffer> {
  const download = page.waitForEvent('download')
  // the label names the shortcut: ⌘S on a Mac, Ctrl+S elsewhere (CI runs Linux)
  await frame.getByRole('button', { name: /^저장 \((⌘|Ctrl\+)S\)$/ }).click()
  const bytes = await downloaded(download)
  await expect(page.locator('#status')).toHaveText('locked.docx')
  return bytes
}

/** The paragraphs of a docx, decrypting it first when a password is given */
async function docxTexts(bytes: Buffer, password?: string): Promise<string[]> {
  const plain = password ? await officeCrypto.decrypt(bytes, { password }) : bytes
  const { blocks } = await parseDocx(new Uint8Array(plain))
  return blocks.map((block) => (block.runs ?? []).map((run) => run.text).join(''))
}

const openDocxProtection = (frame: FrameLocator): Promise<void> =>
  ribbonButton(frame, '검토', frame.locator('button', { hasText: '문서 보호' }))

/** Types the open password into both fields of the Protect dialog and applies it */
async function setDocxOpenPassword(frame: FrameLocator, password: string): Promise<void> {
  const fields = frame.locator('.protect-dialog input[type="password"]')
  await fields.nth(0).fill(password)
  await fields.nth(1).fill(password)
  await frame.locator('.protect-dialog .btn-primary').click()
  await expect(frame.locator('.protect-dialog')).toBeHidden()
}

test.describe('password-protected PDF', () => {
  for (const name of ['enc-r3-rc4.pdf', 'enc-r4-aes128.pdf', 'enc-r5-aes256.pdf']) {
    test(`${name} opens with its password`, async ({ page }) => {
      await openPdf(page, name, false)
    })
  }

  test('a permissions-only PDF opens without asking', async ({ page }) => {
    const name = 'enc-r5-owneronly.pdf'
    const app = await launch(page, { name, mimeType: PDF_MIME, buffer: pdfFixture(name) }, false)
    await expect(app.getByText(PDF_TEXT).first()).toBeVisible({ timeout: 30_000 })
    await expect(app.locator('.pdf-pwd-dialog')).toHaveCount(0)
  })

  test('a wrong password keeps the prompt with its error, the right one opens', async ({
    page,
  }) => {
    const name = 'enc-r5-aes256.pdf'
    const app = await launch(page, { name, mimeType: PDF_MIME, buffer: pdfFixture(name) }, false)
    await enterPdfPassword(app, 'wrong')
    await expect(app.locator('.pdf-pwd-error')).toBeVisible()
    await expect(app.getByText(PDF_TEXT)).toHaveCount(0)
    await enterPdfPassword(app, PDF_PASSWORD)
    await expect(app.getByText(PDF_TEXT).first()).toBeVisible({ timeout: 30_000 })
  })

  test('an edit saves under the same password', async ({ page }) => {
    const app = await openPdf(page, 'enc-r4-aes128.pdf', true)
    await app.locator('.ribbon-tab', { hasText: '페이지' }).click()
    await app.getByRole('button', { name: '오른쪽으로 회전' }).click()
    await expect(page.locator('#status')).toContainText('저장 안 함')
    const saved = await pdfSave(page, app)

    await expect(readPdf(saved)).rejects.toMatchObject({ name: 'PasswordException' })
    const reopened = await readPdf(saved, PDF_PASSWORD)
    expect(reopened.rotation).toBe(90)
    expect(reopened.text).toContain(PDF_TEXT)

    // the host's own save request writes it protected too
    await app.getByRole('button', { name: '오른쪽으로 회전' }).click()
    const hostSave = page.waitForEvent('download')
    await page.locator('#save').click()
    const again = await downloaded(hostSave)
    await expect(readPdf(again)).rejects.toMatchObject({ name: 'PasswordException' })
    expect((await readPdf(again, PDF_PASSWORD)).rotation).toBe(180)
  })

  test('a password set on a plain PDF protects the save, the owner can lift it', async ({
    page,
  }) => {
    const name = 'plain-sample.pdf'
    const plainApp = await launch(
      page,
      { name, mimeType: PDF_MIME, buffer: pdfFixture(name) },
      true,
    )
    await expect(plainApp.getByText(PLAIN_PDF_TEXT).first()).toBeVisible({ timeout: 30_000 })
    await ribbonButton(
      plainApp,
      '주석',
      plainApp.getByRole('button', { name: '보호', exact: true }),
    )
    const fields = plainApp.locator('.pdf-modal input[type="password"]')
    await fields.nth(0).fill('new-pw')
    await fields.nth(1).fill('new-pw')
    await fields.nth(2).fill('owner-pw')
    await plainApp.getByRole('button', { name: '보호 적용' }).click()
    const locked = await pdfSave(page, plainApp)
    await expect(readPdf(locked)).rejects.toMatchObject({ name: 'PasswordException' })
    expect((await readPdf(locked, 'new-pw')).text).toContain(PLAIN_PDF_TEXT)

    // as on the desktop, only the owner password may lift protection
    const app = await launch(page, { name, mimeType: PDF_MIME, buffer: locked }, true)
    await enterPdfPassword(app, 'owner-pw')
    await expect(app.getByText(PLAIN_PDF_TEXT).first()).toBeVisible({ timeout: 30_000 })
    await ribbonButton(app, '주석', app.getByRole('button', { name: '보호', exact: true }))
    await app.getByRole('button', { name: '보호 제거' }).click()
    const plain = await pdfSave(page, app)
    expect((await readPdf(plain)).text).toContain(PLAIN_PDF_TEXT)
  })
})

test.describe('password-protected docx', () => {
  test('a wrong password keeps the prompt with its error, the right one opens', async ({
    page,
  }) => {
    const frame = await launch(
      page,
      { name: 'locked.docx', mimeType: DOCX_MIME, buffer: ENCRYPTED_DOCX },
      false,
    )
    await enterDocxPassword(frame, 'wrong')
    await expect(frame.locator('.pwd-dialog [role="alert"]')).toBeVisible({ timeout: 30_000 })
    await expect(frame.locator('.ProseMirror')).toHaveCount(0)
    await enterDocxPassword(frame, DOCX_PASSWORD)
    await expect(frame.locator('.ProseMirror').getByText(FIRST)).toBeVisible({ timeout: 30_000 })
  })

  test('a docx under the older Standard encryption opens with its password', async ({ page }) => {
    await openDocx(page, STANDARD_DOCX, false)
  })

  test('an edit saves under the same password', async ({ page }) => {
    const frame = await openDocx(page, ENCRYPTED_DOCX, true)
    await typeAfter(frame, FIRST, ' web edit')
    await expect(page.locator('#status')).toContainText('(저장 안 함)')
    const saved = await docxSave(page, frame)

    expect(officeCrypto.isEncrypted(saved)).toBe(true)
    await expect(docxTexts(saved)).rejects.toThrow()
    await expect(docxTexts(saved, 'wrong')).rejects.toThrow()
    const texts = await docxTexts(saved, DOCX_PASSWORD)
    expect(texts).toContain(`${FIRST} web edit`)
    expect(texts).toContain(SECOND)

    // the host's own save request writes it protected too
    await typeAfter(frame, SECOND, ' host save')
    const hostSave = page.waitForEvent('download')
    await page.locator('#save').click()
    const again = await downloaded(hostSave)
    expect(await docxTexts(again, DOCX_PASSWORD)).toContain(`${SECOND} host save`)
  })

  test('a password set on a plain docx protects the save, removing it saves plain', async ({
    page,
  }) => {
    const frame = await launch(
      page,
      { name: 'locked.docx', mimeType: DOCX_MIME, buffer: SIMPLE_DOCX },
      true,
    )
    await expect(frame.locator('.ProseMirror').getByText(FIRST)).toBeVisible({ timeout: 30_000 })
    await openDocxProtection(frame)
    await setDocxOpenPassword(frame, 'fresh-pw')
    await typeAfter(frame, FIRST, ' locked now')
    const locked = await docxSave(page, frame)
    expect(officeCrypto.isEncrypted(locked)).toBe(true)
    expect(await docxTexts(locked, 'fresh-pw')).toContain(`${FIRST} locked now`)

    await openDocxProtection(frame)
    await setDocxOpenPassword(frame, '')
    await typeAfter(frame, SECOND, ' open again')
    const plain = await docxSave(page, frame)
    expect(officeCrypto.isEncrypted(plain)).toBe(false)
    expect(await docxTexts(plain)).toContain(`${SECOND} open again`)
  })

  test('a protected docx opened for viewing reads but stays read-only', async ({ page }) => {
    const frame = await openDocx(page, ENCRYPTED_DOCX, false)
    await expect(frame.locator('.ProseMirror').getByText(SECOND)).toBeVisible()
    await expect(frame.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false')
    await expect(page.locator('#save')).toBeHidden()
  })
})
