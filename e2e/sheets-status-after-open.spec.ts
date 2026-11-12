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
  test('never names the working copy, and no loading notice stays on it', async () => {
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
      // every text the status line shows from here until the workbook has
      // loaded and settled: the open's notice can be replaced at once
      const status = sheets.locator('.workbook-status')
      const seen = new Set<string>()
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        seen.add(await status.innerText())
        await sheets.waitForTimeout(100)
      }
      const shown = [...seen]
      // no text names the working copy, and the line does not end on a loading notice
      expect(shown.filter((text) => COPY_NAME.test(text))).toEqual([])
      expect(await status.innerText()).not.toMatch(/Streaming .*rows available/)
    } finally {
      await closeAndSaveVideo(launched, 'sheets-status-after-open')
    }
  })
})
