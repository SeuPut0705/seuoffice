import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Download, type FrameLocator, type Page } from '@playwright/test'
import { unzipSync } from 'fflate'

const FIXTURE = fileURLToPath(
  new URL('../../sheets/fixtures/generated/compatibility-edit.xlsx', import.meta.url),
)
const NAME = 'compatibility-edit.xlsx'
// Parts a cell edit has no business in: they must come back byte for byte
const UNTOUCHED_PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/_rels/workbook.xml.rels',
  'customXml/item1.xml',
  'xl/charts/chart1.xml',
]

async function open(
  page: Page,
  file: string | { name: string; buffer: Buffer },
  edit: boolean,
): Promise<FrameLocator> {
  await page.goto('/')
  await page.locator('#edit').setChecked(edit)
  await page.setInputFiles(
    '#file',
    typeof file === 'string' ? file : { ...file, mimeType: 'application/octet-stream' },
  )
  await expect(page.locator('#status')).not.toContainText('여는 중', { timeout: 30_000 })
  await expect(page.locator('#status')).not.toContainText('오류')
  const frame = page.frameLocator('#viewer iframe')
  // Univer's cell-reference box above the grid
  await expect(nameBox(frame)).toBeVisible({ timeout: 20_000 })
  await loaded(frame)
  return frame
}

const nameBox = (frame: FrameLocator) => frame.locator('input.univer-appearance-none').first()
// the app's own "fully loaded, every cell editable" line; typing earlier is refused while cells stream in
const loaded = (frame: FrameLocator) =>
  expect(frame.locator('footer.status-bar')).toContainText('모두 로드', { timeout: 20_000 })
// the label names the shortcut: ⌘S on a Mac, Ctrl+S elsewhere (CI runs Linux)
const saveButton = (frame: FrameLocator) =>
  frame.getByRole('button', { name: /^저장 ?\((⌘|Ctrl\+)S\)$/ })
const unsaved = (page: Page, timeout?: number) =>
  expect(page.locator('#status')).toContainText('저장 안 함', { timeout })

/** Types into a cell through the grid, as a user does: jump with the name box, type, Enter */
async function typeInto(page: Page, frame: FrameLocator, cell: string, text: string) {
  await nameBox(frame).fill(cell)
  await nameBox(frame).press('Enter')
  // the box sometimes keeps focus after the jump; the grid takes keys once it lets go
  await nameBox(frame).blur()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/** An edit the page reports as unsaved; a keystroke the grid dropped is typed again */
async function edit(page: Page, frame: FrameLocator, cell: string, text: string) {
  await expect(async () => {
    await typeInto(page, frame, cell, text)
    await unsaved(page, 2000)
  }).toPass({ timeout: 15_000 })
}

async function bytesOf(download: Download): Promise<Buffer> {
  return readFileSync((await download.path())!)
}

const decoded = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** The saved package holds every typed text and keeps what the edits did not touch */
function expectSavedWith(saved: Buffer, texts: string[]) {
  const before = unzipSync(readFileSync(FIXTURE))
  const after = unzipSync(saved)
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
  const sheet = decoded(after['xl/worksheets/sheet1.xml']!)
  const strings = decoded(after['xl/sharedStrings.xml']!)
  for (const text of texts) expect(sheet + strings).toContain(text)
  expect(strings).toContain('Hello')
  expect(sheet).toContain('<f>SUM(C1:C2)</f>')
  for (const name of UNTOUCHED_PARTS) expect(after[name], name).toEqual(before[name])
}

test('an edited workbook saves through the app and through the host', async ({ page }) => {
  const frame = await open(page, FIXTURE, true)
  await expect(saveButton(frame)).toBeDisabled()

  await edit(page, frame, 'D2', 'web-edit-1')
  const ownSave = page.waitForEvent('download')
  await saveButton(frame).click()
  const first = await ownSave
  expect(first.suggestedFilename()).toBe(NAME)
  expectSavedWith(await bytesOf(first), ['web-edit-1'])
  await expect(page.locator('#status')).not.toContainText('저장 안 함')
  await expect(saveButton(frame)).toBeDisabled()

  // a second edit on the saved workbook, saved when the host asks
  await edit(page, frame, 'D4', 'web-edit-2')
  const hostSave = page.waitForEvent('download')
  await page.locator('#save').click()
  const second = await hostSave
  expect(second.suggestedFilename()).toBe(NAME)
  const secondBytes = await bytesOf(second)
  expectSavedWith(secondBytes, ['web-edit-1', 'web-edit-2'])

  // the engine reads the saved bytes back
  await open(page, { name: NAME, buffer: secondBytes }, false)
})

test('Ctrl+S saves in edit mode', async ({ page }) => {
  const frame = await open(page, FIXTURE, true)
  await edit(page, frame, 'E5', 'by-shortcut')
  const download = page.waitForEvent('download')
  await page.keyboard.press('ControlOrMeta+s')
  expectSavedWith(await bytesOf(await download), ['by-shortcut'])
})

test('view mode keeps the workbook as it is and saves nothing', async ({ page }) => {
  const frame = await open(page, FIXTURE, false)
  await expect(page.locator('#save')).toBeHidden()
  let downloads = 0
  page.on('download', () => (downloads += 1))

  await typeInto(page, frame, 'D2', 'typed-in-view')
  await typeInto(page, frame, 'A1', 'overwrite')
  await page.keyboard.press('Delete')
  await page.keyboard.press('ControlOrMeta+s')
  // the journal and a save settle well within this; edit mode shows both sooner
  await page.waitForTimeout(1000)
  // an edit would land in the journal and enable the save button, as it does in edit mode
  await expect(saveButton(frame)).toBeDisabled()
  expect(downloads).toBe(0)
})

/** The Insert tab's text box: an edit the renderer journals itself, outside Univer's commands */
async function insertTextBox(frame: FrameLocator) {
  await frame
    .getByRole('tab', { name: '삽입' })
    .or(frame.getByText('삽입', { exact: true }))
    .first()
    .click()
  await frame
    .getByRole('button', { name: /텍스트 상자/ })
    .first()
    .click()
}

test('a text box inserts in edit mode and not in view mode', async ({ page }) => {
  const editing = await open(page, FIXTURE, true)
  await insertTextBox(editing)
  await unsaved(page)
  await expect(saveButton(editing)).toBeEnabled()

  const viewing = await open(page, FIXTURE, false)
  await insertTextBox(viewing)
  await page.waitForTimeout(1000)
  await expect(saveButton(viewing)).toBeDisabled()
})

/** A note through the grid's context menu: Univer's note plugin, outside the ribbon */
async function addNote(page: Page, frame: FrameLocator, text: string) {
  // the grid is the tallest canvas (others draw the formula bar or sit off screen);
  // aim at an empty cell a few columns and rows in, below the headers
  const canvases = await frame.locator('#univer-container canvas').all()
  const boxes = await Promise.all(canvases.map((canvas) => canvas.boundingBox()))
  const grid = boxes.reduce((wide, box) => (box && box.height > (wide?.height ?? 0) ? box : wide))!
  const at = { x: grid.x + 400, y: grid.y + 160 }
  const addItem = frame.getByText('노트 추가', { exact: true })
  // the first right-click after load sometimes opens no menu; click again until it shows
  await expect(async () => {
    await page.mouse.click(at.x, at.y)
    await page.mouse.click(at.x, at.y, { button: 'right' })
    await expect(addItem).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
  await addItem.click()
  await page.keyboard.type(text)
  // the note commits when it loses focus
  await page.mouse.click(grid.x + 600, grid.y + 400)
}

test('a context-menu note adds in edit mode and not in view mode', async ({ page }) => {
  const editing = await open(page, FIXTURE, true)
  await addNote(page, editing, 'note-in-edit')
  await unsaved(page)

  const viewing = await open(page, FIXTURE, false)
  await addNote(page, viewing, 'note-in-view')
  await page.waitForTimeout(1000)
  await expect(saveButton(viewing)).toBeDisabled()
})
