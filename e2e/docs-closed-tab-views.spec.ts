import { test, expect } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { launchShell, closeAndSaveVideo } from './helpers'

/**
 * A closed document tab leaves nothing behind: not its renderer process, and
 * not its page. Closed .docx tabs used to stay as pages of their own, carrying
 * the document's title, until the app quit (found on Windows: eight closed
 * documents, eight `docs/index.html?mode=tab` pages still listed).
 */

interface TabsApiOnWindow {
  aiOfficeTabs: {
    list(): Promise<{ id: string; kind: string }[]>
    detach(id: string): Promise<void>
  }
}

/** the Word editor pages the main process still holds */
const docsPages = (app: ElectronApplication) =>
  app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((wc) => wc.getURL().includes('://docs/'))
      .map((wc) => ({ title: wc.getTitle(), crashed: wc.isCrashed(), pid: wc.getOSProcessId() })),
  )

test.describe('closed Word tabs', () => {
  test('three documents opened and closed leave no Word page in the app', async () => {
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'docs-closed-tab-views' })
    const { app, page } = launched
    try {
      const home = page.locator('.tab-bar .tab-item.tab-home')
      const editorTabs = page.locator('.tab-bar .tab-item:not(.tab-home)')
      for (let n = 1; n <= 3; n++) {
        await home.click()
        await page.locator('.quick-card').first().click()
        await expect(editorTabs).toHaveCount(n)
        await expect.poll(async () => (await docsPages(app)).length).toBe(n)
      }
      // every page has its own live renderer before the close
      expect((await docsPages(app)).every((p) => !p.crashed && p.pid > 0)).toBe(true)

      for (let n = 2; n >= 0; n--) {
        await editorTabs.first().click({ button: 'middle' })
        await expect(editorTabs).toHaveCount(n)
      }
      // the main process answers (it is not wedged) and holds no Word page
      await expect.poll(() => docsPages(app), { timeout: 20_000 }).toEqual([])
      await expect(home).toHaveClass(/active/)

      // and a Word tab still opens afterwards
      await page.locator('.quick-card').first().click()
      await expect(editorTabs).toHaveCount(1)
      await expect.poll(async () => (await docsPages(app)).length).toBe(1)
    } finally {
      await closeAndSaveVideo(launched, 'docs-closed-tab-views')
    }
  })

  test('a document moved to a window of its own and closed there leaves no Word page either', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'docs-closed-window-views',
    })
    const { app, page } = launched
    try {
      const windowIds = () =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.id))
      const home = page.locator('.tab-bar .tab-item.tab-home')
      const editorTabs = page.locator('.tab-bar .tab-item:not(.tab-home)')
      await page.locator('.quick-card').first().click()
      await expect(editorTabs).toHaveCount(1)
      await expect.poll(async () => (await docsPages(app)).length).toBe(1)

      const before = await windowIds()
      await page.evaluate(async () => {
        const tabs = (window as unknown as TabsApiOnWindow).aiOfficeTabs
        const tab = (await tabs.list()).find((t) => t.kind === 'docs')
        if (tab) await tabs.detach(tab.id)
      })
      await expect(editorTabs).toHaveCount(0)
      await expect.poll(async () => (await windowIds()).length).toBe(before.length + 1)
      // the same page moved: it is still the one Word page, with its renderer alive
      expect((await docsPages(app)).map((p) => !p.crashed && p.pid > 0)).toEqual([true])

      await app.evaluate(({ BrowserWindow }, kept) => {
        for (const w of BrowserWindow.getAllWindows()) if (!kept.includes(w.id)) w.close()
      }, before)
      await expect.poll(windowIds).toEqual(before)
      // the main process answers (it is not wedged) and holds no Word page
      await expect.poll(() => docsPages(app), { timeout: 20_000 }).toEqual([])

      // and a Word tab still opens afterwards
      await home.click()
      await page.locator('.quick-card').first().click()
      await expect(editorTabs).toHaveCount(1)
      await expect.poll(async () => (await docsPages(app)).length).toBe(1)
    } finally {
      await closeAndSaveVideo(launched, 'docs-closed-window-views')
    }
  })
})
