import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocx, type Block } from '@genoffice/docx-engine'
import { expect, test, type Download, type FrameLocator, type Page } from '@playwright/test'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const SIMPLE = resolve(repo, 'fixtures/generated/simple.docx')
const KITCHEN_SINK = resolve(repo, 'fixtures/generated/kitchen-sink.docx')

// the fixtures' Chinese text: "first paragraph." / "second paragraph." / "last paragraph."
const FIRST = '\u7b2c\u4e00\u6bb5\u3002'
const SECOND = '\u7b2c\u4e8c\u6bb5\u3002'
const LAST = '\u5c3e\u6bb5\u3002'

async function open(page: Page, file: string, edit: boolean): Promise<FrameLocator> {
  await page.goto('/')
  await page.locator('#edit').setChecked(edit)
  await page.setInputFiles('#file', file)
  await expect(page.locator('#status')).not.toContainText('여는 중', { timeout: 30_000 })
  await expect(page.locator('#status')).not.toContainText('오류')
  const frame = page.frameLocator('#viewer iframe')
  await expect(frame.locator('.ProseMirror')).toBeVisible()
  return frame
}

/** Type at the end of the paragraph that holds `anchor` (a click past its last character) */
async function typeAfter(frame: FrameLocator, anchor: string, text: string): Promise<void> {
  const paragraph = frame.locator('.ProseMirror').getByText(anchor, { exact: true }).first()
  const box = await paragraph.boundingBox()
  if (!box) throw new Error(`${anchor} is not on screen`)
  await paragraph.click({ position: { x: box.width - 2, y: box.height / 2 } })
  await frame.owner().page().keyboard.type(text)
}

async function saved(download: Download): Promise<Block[]> {
  const path = await download.path()
  return (await parseDocx(new Uint8Array(await readFile(path)))).blocks
}

const texts = (blocks: Block[]): string[] =>
  blocks.map((block) => (block.runs ?? []).map((run) => run.text).join(''))

const appSave = (frame: FrameLocator) => frame.getByRole('button', { name: '저장 (⌘S)' })

test('an edited docx saves through the app and through the host', async ({ page }) => {
  const frame = await open(page, SIMPLE, true)
  const status = page.locator('#status')

  await typeAfter(frame, FIRST, ' web edit')
  await expect(status).toContainText('(저장 안 함)')
  const first = page.waitForEvent('download')
  await appSave(frame).click()
  const firstSave = await first
  expect(firstSave.suggestedFilename()).toBe('simple.docx')
  await expect(status).toHaveText('simple.docx')
  await expect(appSave(frame)).toBeDisabled()
  const afterApp = texts(await saved(firstSave))
  expect(afterApp).toContain(`${FIRST} web edit`)
  expect(afterApp).toContain(SECOND)

  await typeAfter(frame, SECOND, ' host save')
  await expect(status).toContainText('(저장 안 함)')
  const second = page.waitForEvent('download')
  await page.locator('#save').click()
  const afterHost = texts(await saved(await second))
  expect(afterHost).toContain(`${FIRST} web edit`)
  expect(afterHost).toContain(`${SECOND} host save`)
  await expect(status).toHaveText('simple.docx')
  await expect(appSave(frame)).toBeDisabled()
})

test('a saved docx keeps its picture and table', async ({ page }) => {
  const original = (await parseDocx(new Uint8Array(await readFile(KITCHEN_SINK)))).blocks
  const frame = await open(page, KITCHEN_SINK, true)

  await typeAfter(frame, LAST, ' web edit')
  const download = page.waitForEvent('download')
  await frame.locator('.ProseMirror').press('Control+s')
  const blocks = await saved(await download)

  expect(texts(blocks)).toContain(`${LAST} web edit`)
  const picture = (doc: Block[]) => doc.find((block) => block.imageDataUrl)?.imageDataUrl
  expect(picture(blocks)).toBeDefined()
  expect(picture(blocks)).toBe(picture(original))
  const table = (doc: Block[]) => doc.find((block) => block.type === 'table')?.originalXml
  expect(table(blocks)).toBe(table(original))
})

test('a save the host refuses shows its reason and leaves the document unsaved', async ({
  page,
}) => {
  // a host that refuses every save: answers before the launcher's own listener sees it
  await page.addInitScript(() => {
    if (window !== window.top) return
    window.addEventListener('message', (event) => {
      const data = event.data as { source?: string; type?: string; saveId?: number } | null
      if (data?.source !== 'seuoffice' || data.type !== 'save') return
      event.stopImmediatePropagation()
      ;(event.source as Window).postMessage(
        {
          source: 'seuoffice',
          version: 1,
          type: 'save_failed',
          saveId: data.saveId,
          message: 'disk full',
        },
        event.origin,
      )
    })
  })
  const frame = await open(page, SIMPLE, true)
  const status = page.locator('#status')

  await typeAfter(frame, FIRST, ' web edit')
  await appSave(frame).click()
  await expect(frame.getByText('저장 실패: disk full').first()).toBeVisible()
  await expect(appSave(frame)).toBeEnabled()
  await expect(status).toContainText('(저장 안 함)')

  await page.locator('#save').click()
  await expect(status).toHaveText('저장 실패: disk full')
  await expect(appSave(frame)).toBeEnabled()
})

test('a document opened for viewing cannot be edited or saved', async ({ page }) => {
  let downloads = 0
  page.on('download', () => downloads++)
  const frame = await open(page, SIMPLE, false)
  const editor = frame.locator('.ProseMirror')

  await expect(editor).toHaveAttribute('contenteditable', 'false')
  await typeAfter(frame, FIRST, ' web edit')
  await expect(editor).not.toContainText('web edit')
  await editor.press('Control+s')
  await expect(page.locator('#save')).toBeHidden()
  // a save would arrive as a download well within this
  await page.waitForTimeout(2_000)
  expect(downloads).toBe(0)
})

test('a document opened for viewing stays read-only after every way out of Read Mode', async ({
  page,
}) => {
  const frame = await open(page, SIMPLE, false)
  const editor = frame.locator('.ProseMirror')
  const tryToEdit = async (): Promise<void> => {
    await typeAfter(frame, FIRST, ' web edit')
    await expect(editor).toHaveAttribute('contenteditable', 'false')
    await expect(editor).not.toContainText('web edit')
  }

  await editor.click()
  await editor.press('Escape')
  await tryToEdit()
  await frame.getByRole('button', { name: '읽기 모드', exact: true }).click()
  await tryToEdit()
  // the in-page "Exit Read Mode" button would offer a way out the host did not grant
  await expect(frame.locator('.read-exit')).toBeHidden()
})
