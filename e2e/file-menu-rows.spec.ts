import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

/**
 * Every row of the File menu is one line. The menu hangs off the narrow File
 * tab, so it used to take its minimum width, and a long label beside a
 * shortcut broke onto a second line (found on Windows, Slides in Korean: the
 * Save As row with Ctrl+Shift+S). The rule is about the longest row, so it is
 * checked in a language with long labels and in English. jsdom computes no
 * layout: only the built app shows it.
 */

type NewTab = 'newSlide' | 'newDoc'
const APPS: { name: string; create: NewTab; url: string }[] = [
  { name: 'Slides', create: 'newSlide', url: '://slides/' },
]

for (const lang of ['ko', 'en']) {
  for (const { name, create, url } of APPS) {
    test(`${name} (${lang}): no row of the File menu wraps`, async () => {
      const launched = await launchShell({
        onboardingSeen: true,
        lang,
        videoDir: `file-menu-rows-${create}-${lang}`,
      })
      try {
        const shellPage = launched.app.windows()[0]!
        await shellPage.evaluate(
          (method) =>
            (window as never as { aiOffice: Record<NewTab, () => Promise<void>> }).aiOffice[
              method
            ](),
          create,
        )
        const page = await waitForPageWithUrl(launched.app, url)
        const fileTab = page.locator('.file-tab-wrap > button').first()
        await fileTab.waitFor({ timeout: 30_000 })
        await fileTab.click()
        const rows = page.locator('.file-menu button')
        await expect(rows.first()).toBeVisible()
        const heights = await rows.evaluateAll((buttons) =>
          buttons.map((button) => ({
            label: button.textContent ?? '',
            height: Math.round(button.getBoundingClientRect().height),
          })),
        )
        expect(heights.length).toBeGreaterThan(3)
        const oneLine = Math.min(...heights.map((row) => row.height))
        // a wrapped row is a whole line taller; a pixel of rounding is not
        expect(heights.filter((row) => row.height > oneLine + 2)).toEqual([])
      } finally {
        await closeAndSaveVideo(launched, `file-menu-rows-${create}-${lang}`)
      }
    })
  }
}
