import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import officeCrypto from 'officecrypto-tool'
import { csvToXlsxBufferForOpen } from '../packages/xlsx-gateway/src/gateway/csv-import'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

/**
 * A workbook or deck with an open password asks for it in the password window,
 * opens with the right one, and saves back still encrypted with that password.
 */
const PASSWORD = '열기-pw 1'
const KINDS = [
  {
    ext: 'xlsx',
    url: '://sheets/',
    channel: 'menu:action',
    fixture: async () => (await csvToXlsxBufferForOpen('Name,Score\nAda,10', 'Sheet1')).buffer,
    part: 'xl/workbook.xml',
  },
  {
    ext: 'pptx',
    url: '://slides/',
    channel: 'slides:menu',
    fixture: () =>
      readFile(
        resolve(__dirname, '../packages/pptx-engine/tests/fixtures/01_standard_business.pptx'),
      ),
    part: 'ppt/presentation.xml',
  },
]

test.setTimeout(180_000)

async function passwordWindow(app: ElectronApplication): Promise<Page> {
  return waitForPageWithUrl(app, 'pdf-password.html')
}

async function submit(page: Page, password: string): Promise<void> {
  await page.locator('#password').fill(password)
  await page.locator('#ok').click()
}

/**
 * Cancels the password window, which closes that window itself. Playwright can
 * see the close before the click returns and report it as an error; that one
 * error is the success case here, so it is taken instead of failing the test.
 * Anything else (the button missing, the app gone before the click) still fails.
 */
async function cancelPasswordWindow(page: Page): Promise<void> {
  await page
    .locator('#cancel')
    .click()
    .catch((error: unknown) => {
      if (!(error instanceof Error) || !/has been closed/.test(error.message)) throw error
    })
}

for (const { ext, url, channel, fixture, part } of KINDS) {
  test(`encrypted .${ext} asks for its password, opens and saves encrypted`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-locked-'))
    const filePath = join(dir, `locked.${ext}`)
    const encrypted = officeCrypto.encrypt(await fixture(), { password: PASSWORD })
    await writeFile(filePath, encrypted)
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: `open-locked-${ext}`,
      openFile: filePath,
    })
    const { app } = launched
    try {
      const prompt = await passwordWindow(app)
      await expect(prompt.locator('#file')).toContainText(`locked.${ext}`)
      await submit(prompt, 'wrong password')
      await expect(prompt.locator('#error')).toBeVisible({ timeout: 15_000 })
      await prompt.screenshot({ path: screenshotPath(`locked-${ext}-retry`) })
      await submit(prompt, PASSWORD)

      const editor = await waitForPageWithUrl(app, url)
      // the document really opened: its sheet tab / slide text is in the DOM
      await editor.waitForFunction(
        (kind) =>
          kind === 'xlsx'
            ? document.body.textContent?.includes('Sheet1')
            : document.querySelectorAll('[data-slide-index], .slide-thumb, canvas').length > 0,
        ext,
        { timeout: 30_000 },
      )
      await editor.waitForTimeout(1_500)
      await editor.screenshot({ path: screenshotPath(`locked-${ext}-opened`) })

      const before = (await stat(filePath)).mtimeMs
      if (ext === 'xlsx') {
        // a sheets Save with no edits is a no-op: type into A1 first
        const grid = await editor.evaluate(() => {
          for (const canvas of document.querySelectorAll('canvas')) {
            const rect = canvas.getBoundingClientRect()
            if (rect.width > 500 && rect.height > 300) return { x: rect.x, y: rect.y }
          }
          return null
        })
        if (!grid) throw new Error('worksheet canvas not found')
        await editor.mouse.click(grid.x + 46 + 43, grid.y + 24 + 12)
        await editor.keyboard.type('Locked', { delay: 50 })
        await editor.keyboard.press('Enter')
      }
      await app.evaluate(
        ({ webContents }, [u, ch]) => {
          webContents
            .getAllWebContents()
            .find((w) => w.getURL().includes(u))
            ?.send(ch, 'save')
        },
        [url, channel],
      )
      await expect
        .poll(async () => (await stat(filePath)).mtimeMs, { timeout: 20_000 })
        .toBeGreaterThan(before)
      // let an in-flight atomic rename settle before reading
      await editor.waitForTimeout(500)
      const saved = await readFile(filePath)
      expect(saved.subarray(0, 4).toString('hex')).toBe('d0cf11e0')
      expect(officeCrypto.isEncrypted(saved)).toBe(true)
      const plain = await officeCrypto.decrypt(saved, { password: PASSWORD })
      const zip = await JSZip.loadAsync(plain)
      expect(zip.file(part)).not.toBeNull()
      if (ext === 'xlsx') {
        const texts = await Promise.all(
          Object.keys(zip.files)
            .filter((name) => /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/.test(name))
            .map((name) => zip.file(name)!.async('string')),
        )
        expect(texts.join('')).toContain('Locked')
      }
      // no plaintext copy was left next to the file
      const siblings = (await import('node:fs')).readdirSync(dir)
      expect(siblings).toEqual([`locked.${ext}`])
    } finally {
      await closeAndSaveVideo(launched, `open-locked-${ext}`)
    }
  })

  test(`cancelling the password for .${ext} leaves the file untouched`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-locked-cancel-'))
    const filePath = join(dir, `locked.${ext}`)
    const encrypted = officeCrypto.encrypt(await fixture(), { password: PASSWORD })
    await writeFile(filePath, encrypted)
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: `open-locked-cancel-${ext}`,
      openFile: filePath,
    })
    try {
      const prompt = await passwordWindow(launched.app)
      await cancelPasswordWindow(prompt)
      const editor = await waitForPageWithUrl(launched.app, url)
      await editor.waitForTimeout(2_000)
      await editor.screenshot({ path: screenshotPath(`locked-${ext}-cancelled`) })
      expect(Buffer.compare(await readFile(filePath), encrypted)).toBe(0)
    } finally {
      await closeAndSaveVideo(launched, `open-locked-cancel-${ext}`)
    }
  })
}
