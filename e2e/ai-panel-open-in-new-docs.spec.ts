import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

/**
 * Settings → General → "AI panel" (genoffice#1589, #1951), the way the reporter
 * hit it: pick a start state in the UI, restart, then start a *new* document
 * from the Home screen. Pre-seeding app-settings.json is not the same thing —
 * it skips the write, and the write is half of what is being reported.
 */

/** collapsed = the rail only; expanded = the composer is on screen */
async function aiPanelState(
  editor: import('@playwright/test').Page,
): Promise<'collapsed' | 'expanded'> {
  return (await editor.locator('.ai-dock.collapsed').count()) > 0 ? 'collapsed' : 'expanded'
}

async function chooseAiPanelStart(
  page: import('@playwright/test').Page,
  label: 'Off' | 'Collapsed' | 'Last state',
): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('.set-nav-item').filter({ hasText: 'General' }).click()
  const trigger = page.getByRole('button', { name: 'AI panel', exact: true })
  await trigger.click()
  await page.getByRole('option', { name: label, exact: true }).click()
  // the label only changes after the main process has written app-settings.json
  await expect(trigger).toContainText(label)
  await page.locator('.set-close').click()
}

test.describe('#1589 the AI panel start setting', () => {
  test('a new document from the Home screen opens collapsed after choosing "Collapsed"', async () => {
    test.setTimeout(300_000)
    const first = await launchShell({ onboardingSeen: true, videoDir: 'ai-panel-1589-on' })
    let userDataDir: string
    try {
      await chooseAiPanelStart(first.page, 'Collapsed')
      // the write half: the flag has to be on disk, not only in the shell's cache
      const saved = JSON.parse(await readFile(join(first.userDataDir, 'app-settings.json'), 'utf8'))
      expect(saved.aiPanelOpenInNewDocs).toBe(false)
      expect(saved.aiPanelShowSidebar).toBe(true)
      userDataDir = first.userDataDir
    } finally {
      await closeAndSaveVideo(first, 'ai-panel-1589-on')
    }

    const restarted = await launchShell({ userDataDir, videoDir: 'ai-panel-1589-new-doc' })
    try {
      await expect(restarted.page.locator('.quick-card').first()).toContainText('AI Docs')
      await restarted.page.locator('.quick-card').first().click()
      const editor = await waitForPageWithUrl(restarted.app, '://docs/')
      await expect(editor.locator('.ProseMirror').first()).toBeVisible({ timeout: 30_000 })
      expect(await aiPanelState(editor)).toBe('collapsed')
      await expect(editor.locator('.ai-composer textarea')).toBeHidden()
    } finally {
      await closeAndSaveVideo(restarted, 'ai-panel-1589-new-doc')
    }
  })

  test('the same new document still opens with the panel when the setting is left on', async () => {
    // The other half, and the reason the fix is not `setShowAi(false)`: the
    // opening document and a *new* document have to agree. This one goes
    // through newFile too — a test that opened an existing file instead would
    // never run the line under test and would pass either way.
    test.setTimeout(300_000)
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'ai-panel-1589-on-new' })
    try {
      await expect(launched.page.locator('.quick-card').first()).toContainText('AI Docs')
      await launched.page.locator('.quick-card').first().click()
      const editor = await waitForPageWithUrl(launched.app, '://docs/')
      await expect(editor.locator('.ProseMirror').first()).toBeVisible({ timeout: 30_000 })
      expect(await aiPanelState(editor)).toBe('expanded')
      await expect(editor.locator('.ai-composer textarea')).toBeVisible()
    } finally {
      await closeAndSaveVideo(launched, 'ai-panel-1589-on-new')
    }
  })

  test('choosing "Off" hides the panel and its rail in a new document', async () => {
    test.setTimeout(300_000)
    const first = await launchShell({ onboardingSeen: true, videoDir: 'ai-panel-1951-off' })
    let userDataDir: string
    try {
      await chooseAiPanelStart(first.page, 'Off')
      const saved = JSON.parse(await readFile(join(first.userDataDir, 'app-settings.json'), 'utf8'))
      expect(saved.aiPanelShowSidebar).toBe(false)
      userDataDir = first.userDataDir
    } finally {
      await closeAndSaveVideo(first, 'ai-panel-1951-off')
    }

    const restarted = await launchShell({ userDataDir, videoDir: 'ai-panel-1951-new-doc' })
    try {
      await expect(restarted.page.locator('.quick-card').first()).toContainText('AI Docs')
      await restarted.page.locator('.quick-card').first().click()
      const editor = await waitForPageWithUrl(restarted.app, '://docs/')
      await expect(editor.locator('.ProseMirror').first()).toBeVisible({ timeout: 30_000 })
      await expect(editor.locator('.ai-dock')).toHaveClass(/ai-dock-off/)
      await expect(editor.locator('.ai-composer textarea')).toBeHidden()
      await expect(editor.getByRole('button', { name: 'Open AI assistant' })).toHaveCount(0)
    } finally {
      await closeAndSaveVideo(restarted, 'ai-panel-1951-new-doc')
    }
  })
})
