import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'

const TABLE = join(__dirname, '..', 'apps', 'hwp', 'tests', 'fixtures', 'format-copy-table.hwp')

test('F5 and Shift+F5 stay with the editor and Ctrl+F5 starts the HWP presenter', async () => {
  const launched = await launchShell({
    onboardingSeen: true,
    lang: 'ko',
    openFile: TABLE,
    videoDir: 'hwp-presentation',
    recordVideo: false,
  })
  try {
    const hwp = await waitForPageWithUrl(launched.app, '://hwp/')
    await hwp.waitForSelector('.hwp-app[data-phase="ready"]', { timeout: 90_000 })
    await expect(
      hwp.frameLocator('.hwp-editor-host iframe').locator('[data-cmd="ext:ieum-save"]'),
    ).toHaveCount(1)
    const box = (await hwp.locator('.hwp-editor-host iframe').boundingBox())!
    await hwp.mouse.click(box.x + box.width * 0.4, box.y + 300)

    for (const key of ['F5', 'Shift+F5']) {
      await hwp.keyboard.press(key)
      await expect(hwp.locator('.hwp-app')).not.toHaveClass(/hwp-presenting/)
      expect(await hwp.evaluate(() => document.fullscreenElement !== null)).toBe(false)
    }

    await hwp.keyboard.press('Control+F5')
    await expect(hwp.locator('.hwp-app')).toHaveClass(/hwp-presenting/)
    await expect.poll(() => hwp.evaluate(() => document.fullscreenElement !== null)).toBe(true)

    await hwp.keyboard.press('Escape')
    await expect(hwp.locator('.hwp-app')).not.toHaveClass(/hwp-presenting/)
  } finally {
    await closeAndSaveVideo(launched, 'hwp-presentation')
  }
})
