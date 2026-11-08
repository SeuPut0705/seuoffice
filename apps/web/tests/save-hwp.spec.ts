import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  expect,
  test,
  type Download,
  type Frame,
  type FrameLocator,
  type Page,
} from '@playwright/test'
import init, { HwpDocument } from '@rhwp/core'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const fixture = (name: string): string => resolve(repo, 'apps/hwp/tests/fixtures', name)

test.beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const wasm = join(dirname(require.resolve('@rhwp/core')), 'rhwp_bg.wasm')
  await init({ module_or_path: readFileSync(wasm) })
})

/** The document's text as the engine reads it back */
function textOf(bytes: Uint8Array): string {
  const doc = new HwpDocument(bytes)
  try {
    return doc.getTextFileText().replace(/\r\n?/g, '\n')
  } finally {
    doc.free()
  }
}

async function bytesOf(download: Download): Promise<Uint8Array> {
  return readFileSync(await download.path())
}

/** Open a fixture in the launcher and wait until the editor and the app's File menu are up */
async function openHwp(page: Page, name: string, edit: boolean): Promise<FrameLocator> {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.locator('#edit').setChecked(edit)
  await page.setInputFiles('#file', fixture(name))
  const app = page.frameLocator('#viewer iframe')
  await expect(app.locator('.hwp-app[data-phase="ready"]')).toHaveCount(1, { timeout: 60_000 })
  const studio = app.frameLocator('.hwp-editor-host iframe')
  await expect(studio.locator('[data-cmd="ext:ieum-save"]')).toHaveCount(1, { timeout: 30_000 })
  expect(errors).toEqual([])
  return studio
}

/** Put the caret in the document body and type, as a person would */
async function typeInDocument(page: Page, text: string): Promise<void> {
  const editor = page.frameLocator('#viewer iframe').locator('.hwp-editor-host iframe')
  const box = (await editor.boundingBox())!
  await page.mouse.click(box.x + box.width * 0.4, box.y + 300)
  await page.keyboard.type(text)
}

const dirtyStatus = '(저장 안 함)'

for (const { name, appSave } of [
  { name: 'memo.hwp', appSave: 'Ctrl+S' },
  { name: 'memo.hwpx', appSave: 'File menu' },
] as const) {
  test(`edits ${name} and saves it with ${appSave} and from the host`, async ({ page }) => {
    const original = textOf(readFileSync(fixture(name)))
    const studio = await openHwp(page, name, true)
    const status = page.locator('#status')

    await typeInDocument(page, 'SEUWEBA')
    await expect(status).toContainText(dirtyStatus)
    const first = page.waitForEvent('download')
    if (appSave === 'Ctrl+S') {
      await page.keyboard.press('ControlOrMeta+s')
    } else {
      await studio.locator('#menu-bar .menu-item[data-menu="file"] .menu-title').click()
      await studio.locator('.md-item[data-cmd="ext:ieum-save"]').click()
    }
    const appSaved = await first
    expect(appSaved.suggestedFilename()).toBe(name)
    // the host stored the bytes: the document reads as saved again
    await expect(status).not.toContainText(dirtyStatus)
    const afterApp = textOf(await bytesOf(appSaved))
    expect(afterApp).toContain('SEUWEBA')
    expect(afterApp.replace('SEUWEBA', '')).toBe(original)

    await typeInDocument(page, 'SEUWEBB')
    await expect(status).toContainText(dirtyStatus)
    const second = page.waitForEvent('download')
    await page.locator('#save').click()
    const hostSaved = await second
    expect(hostSaved.suggestedFilename()).toBe(name)
    await expect(status).not.toContainText(dirtyStatus)
    const afterHost = textOf(await bytesOf(hostSaved))
    expect(afterHost).toContain('SEUWEBA')
    expect(afterHost).toContain('SEUWEBB')
    expect(afterHost.replace('SEUWEBA', '').replace('SEUWEBB', '')).toBe(original)
  })
}

/** The editor's own frame, where the document lives */
function studioFrame(page: Page): Frame {
  const frame = page.frames().find((candidate) => candidate.url().includes('/studio/index.html'))
  if (!frame) throw new Error('the editor frame is not there')
  return frame
}

/** Whether leaving the editor would warn of unsaved changes: its own dirty state */
async function editorDirty(page: Page): Promise<boolean> {
  return studioFrame(page).evaluate(() => {
    const leaving = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leaving)
    return leaving.defaultPrevented
  })
}

/** The status bar's count of the document's characters, once it settled */
async function documentCount(page: Page, studio: FrameLocator): Promise<string> {
  const count = studio.locator('#ieum-sb-char-count')
  await expect(count).toHaveText(/\d/, { timeout: 10_000 })
  // the count follows a change after a pause and an idle moment (char-count.mjs)
  await page.waitForTimeout(3_000)
  return (await count.textContent()) ?? ''
}

test('a document opened for viewing can be neither changed nor saved', async ({ page }) => {
  const studio = await openHwp(page, 'memo.hwp', false)
  await expect(page.locator('#save')).toBeHidden()
  const downloads: Download[] = []
  page.on('download', (download) => downloads.push(download))
  const before = await documentCount(page, studio)

  // typing, deleting, splitting a paragraph, pasting and formatting the whole document
  await typeInDocument(page, 'SEUWEBV')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Enter')
  await studioFrame(page).evaluate((text) => {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    const paste = new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    })
    document.activeElement?.dispatchEvent(paste)
  }, 'SEUWEBP')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+b')
  await page.keyboard.press('ControlOrMeta+x')
  expect(await editorDirty(page)).toBe(false)
  expect(await documentCount(page, studio)).toBe(before)

  // the editing commands are off in the menu; reading ones stay
  await studio.locator('#menu-bar .menu-item[data-menu="edit"] .menu-title').click()
  for (const command of [
    'edit:undo',
    'edit:redo',
    'edit:cut',
    'edit:paste',
    'edit:delete',
    'edit:find-replace',
  ]) {
    await expect(studio.locator(`.md-item[data-cmd="${command}"]`)).toHaveClass(/\bdisabled\b/)
  }
  for (const command of ['edit:copy', 'edit:find']) {
    await expect(studio.locator(`.md-item[data-cmd="${command}"]`)).not.toHaveClass(/\bdisabled\b/)
  }
  await page.keyboard.press('Escape')

  await page.keyboard.press('ControlOrMeta+s')
  await studio.locator('#menu-bar .menu-item[data-menu="file"] .menu-title').click()
  await studio.locator('.md-item[data-cmd="ext:ieum-save"]').click()
  // a save would reach the host within this time in the edit tests
  await page.waitForTimeout(3_000)
  expect(downloads).toEqual([])
  expect(await editorDirty(page)).toBe(false)
})
