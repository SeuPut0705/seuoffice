/** Helpers for specs that open one document in several pages, one co-editing user each */
import { expect, type Browser, type FrameLocator, type Page } from '@playwright/test'

export interface CoEditor {
  page: Page
  frame: FrameLocator
  /** the editor's text as the page shows it */
  text(): Promise<string>
  /** the session status the host last heard */
  status(): Promise<{ phase: string; version: number; unconfirmed: number; saved: number; canEdit: boolean }>
}

/**
 * Open `file` in a fresh browser context as user `user` of co-edited document
 * `documentId`, and wait until the page is live in the session.
 */
export async function openCoEdited(
  browser: Browser,
  file: string,
  options: { documentId: string; user: string; access?: 'edit' | 'view' },
): Promise<CoEditor> {
  const access = options.access ?? 'edit'
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  const query = new URLSearchParams({
    collab: options.documentId,
    user: options.user,
    name: options.user,
    access,
  })
  await page.goto(`/?${query}`)
  await page.locator('#edit').setChecked(access === 'edit')
  await page.setInputFiles('#file', file)
  await expect(page.locator('#status')).not.toContainText('여는 중', { timeout: 30_000 })
  await expect(page.locator('#status')).not.toContainText('오류')
  const frame = page.frameLocator('#viewer iframe')
  await expect(frame.locator('.ProseMirror')).toBeVisible()
  await expect(page.locator('body')).toHaveAttribute('data-collab-phase', 'live', { timeout: 30_000 })
  return {
    page,
    frame,
    text: () => frame.locator('.ProseMirror').innerText(),
    status: () =>
      page.evaluate(() => {
        const status = window.seuLauncher?.collab
        if (!status) throw new Error('no co-editing status yet')
        return status
      }),
  }
}

/** Wait until every page is live at one version with nothing of its own unconfirmed */
export async function settled(editors: CoEditor[]): Promise<number> {
  let version = -1
  await expect
    .poll(
      async () => {
        const statuses = await Promise.all(editors.map((editor) => editor.status()))
        version = statuses[0].version
        return statuses.every(
          (status) => status.phase === 'live' && status.unconfirmed === 0 && status.version === version,
        )
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  return version
}

/** Type at the end of the paragraph that holds `anchor` (click into it, then the line-end key) */
export async function typeAfter(editor: CoEditor, anchor: string, text: string): Promise<void> {
  await editor.frame.locator('.ProseMirror').getByText(anchor).first().click()
  await editor.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
  await editor.page.keyboard.type(text, { delay: 20 })
}
