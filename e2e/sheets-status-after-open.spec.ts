import { test, expect } from '@playwright/test'
import { copyFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

const FIXTURE = resolve(__dirname, '../apps/sheets/fixtures/generated/compatibility-basic.xlsx')
/** the name of the working copy a workbook runs on: a uuid */
const COPY_NAME = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/**
 * The status line of a workbook that has finished loading. Found on Windows:
 * a four-row workbook kept "Streaming <uuid>.xlsx: 4 rows available." there
 * (in Korean): a loading notice that never went, naming the temp copy instead
 * of the document.
 */
test.describe('sheets: the status line after a workbook has opened', () => {
  test('names the document, and no loading notice stays on it', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'seuoffice-status-e2e-'))
    const workbook = join(scratch, 'Budget 2026.xlsx')
    await copyFile(FIXTURE, workbook)
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'sheets-status-after-open',
      openFile: workbook,
    })
    try {
      const sheets = await waitForPageWithUrl(launched.app, '://sheets/')
      await sheets.waitForFunction(() => document.body.textContent?.includes('Sheet1'), null, {
        timeout: 30_000,
      })
      const status = sheets.locator('.workbook-status')
      // the line names the workbook by the file that was opened
      await expect(status).toContainText('Budget 2026.xlsx', { timeout: 15_000 })
      // and stays free of a loading notice and of the copy's name while the
      // rest of the sheet is read in behind it
      for (let i = 0; i < 6; i++) {
        const text = await status.innerText()
        expect(text).not.toMatch(COPY_NAME)
        expect(text).not.toMatch(/Streaming .*rows available/)
        await sheets.waitForTimeout(500)
      }
    } finally {
      await closeAndSaveVideo(launched, 'sheets-status-after-open')
    }
  })
})
