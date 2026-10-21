import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

/** The theme picker persists its choice, re-scopes the paper via
 *  data-markdown-theme, and survives a restart. */

async function awaitDocsEditor(page: import('@playwright/test').Page): Promise<void> {
  const editor = page.locator('.ProseMirror').first()
  try {
    await editor.waitFor({ timeout: 45_000 })
    return
  } catch {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await editor.waitFor({ timeout: 90_000 })
  }
}

test('markdown theme picker applies, persists and restarts', async () => {
  test.setTimeout(300_000)
  const dir = join(__dirname, 'artifacts')
  mkdirSync(dir, { recursive: true })
  const docPath = join(dir, 'theme-probe.md')
  writeFileSync(
    docPath,
    '# Theme probe\n\n一段中文正文，用于观察纸面与墨色。\n\n```js\nconst x = 1\n```\n',
  )
  const launched = await launchShell({
    onboardingSeen: true,
    openFile: docPath,
    videoDir: 'markdown-theme-picker',
  })
  const { app } = launched
  try {
    const page = await waitForPageWithUrl(app, '://markdown/')
    await awaitDocsEditor(page)

    const themeButton = page.locator('.md-theme-wrap > .rb-btn').first()
    // a narrow window folds the theme picker behind the ribbon's More button
    const more = page.locator('.rb-more-wrap > .rb-btn')
    if (!(await themeButton.isVisible()) && (await more.isVisible())) await more.click()
    await themeButton.click()
    const menu = page.locator('.md-theme-menu')
    await expect(menu).toBeVisible()
    // every theme is listed
    expect(await menu.locator('.md-theme-item').count()).toBe(7)

    await menu.locator('.md-theme-item', { hasText: 'Nord' }).click()
    await expect(menu).toBeHidden()
    await page.waitForTimeout(600)

    const applied = await page.evaluate(() => ({
      attr: document.documentElement.getAttribute('data-markdown-theme'),
      paper: getComputedStyle(document.querySelector('.doc-page')!).backgroundColor,
      canvas: getComputedStyle(document.querySelector('.editor-scroll')!).backgroundColor,
    }))
    expect(applied.attr).toBe('nord')
    expect(applied.paper).toBe('rgb(46, 52, 64)') // nord0 #2e3440
    await page.screenshot({ path: 'artifacts/md-theme-nord.png' })

    // a real restart: close this instance, then boot again on the same
    // userDataDir (a second live instance would just be forwarded to this one)
    await closeAndSaveVideo(launched, 'markdown-theme-picker')
    const relaunch = await launchShell({
      onboardingSeen: true,
      openFile: docPath,
      videoDir: 'markdown-theme-picker',
      userDataDir: launched.userDataDir,
    })
    try {
      const page2 = await waitForPageWithUrl(relaunch.app, '://markdown/')
      await awaitDocsEditor(page2)
      await page2.waitForTimeout(1000)
      const attr2 = await page2.evaluate(() =>
        document.documentElement.getAttribute('data-markdown-theme'),
      )
      expect(attr2).toBe('nord')
      await page2.screenshot({ path: 'artifacts/md-theme-nord-restart.png' })
    } finally {
      await closeAndSaveVideo(relaunch, 'markdown-theme-picker')
    }
  } catch (err) {
    // the happy path closed its own instance; only failures still hold one
    if (err instanceof Error && err.message.includes('app.process')) throw err
  }
})

/** The theme menu must be fully visible: the ribbon row clips its overflow, so
 *  a menu anchored with position: absolute loses its right edge (and its
 *  bottom) to the window. It has to escape the clip and stay inside the
 *  viewport (genoffice#2104). */
test('the theme menu stays whole: inside the viewport, not clipped by the ribbon', async () => {
  test.setTimeout(300_000)
  const dir = join(__dirname, 'artifacts')
  mkdirSync(dir, { recursive: true })
  const docPath = join(dir, 'theme-menu-fit.md')
  writeFileSync(docPath, '# Fit\n\nbody\n')

  const launched = await launchShell({
    onboardingSeen: true,
    openFile: docPath,
    videoDir: 'markdown-theme-menu-fit',
  })
  const { app } = launched
  try {
    const page = await waitForPageWithUrl(app, '://markdown/')
    await awaitDocsEditor(page)

    const themeButton = page.locator('.md-theme-wrap > .rb-btn').first()
    await themeButton.click()
    const menu = page.locator('.md-theme-menu')
    await expect(menu).toBeVisible()

    const geom = await page.evaluate(() => {
      const el = document.querySelector('.md-theme-menu') as HTMLElement
      const r = el.getBoundingClientRect()
      // what actually paints at the menu's bottom-left corner: the menu
      // itself, or whatever covers it (the page canvas)?
      const hit = document.elementFromPoint(r.left + 4, r.bottom - 4)
      return {
        viewportW: window.innerWidth,
        viewportH: window.innerHeight,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        cornerIsMenu: Boolean(hit?.closest('.md-theme-menu')),
      }
    })

    // every edge inside the window
    expect(geom.left).toBeGreaterThanOrEqual(0)
    expect(geom.right).toBeLessThanOrEqual(geom.viewportW)
    expect(geom.top).toBeGreaterThanOrEqual(0)
    expect(geom.bottom).toBeLessThanOrEqual(geom.viewportH)
    // and nothing paints over the menu
    expect(geom.cornerIsMenu).toBe(true)

    await page.screenshot({ path: 'artifacts/md-theme-menu-fit.png' })
  } finally {
    await closeAndSaveVideo(launched, 'markdown-theme-menu-fit')
  }
})
