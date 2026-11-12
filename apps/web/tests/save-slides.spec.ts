import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSlideNotes, openPptx, type SlideElement } from '@seuoffice/pptx-engine'
import { expect, test, type Download, type FrameLocator, type Page } from '@playwright/test'

/** What these tests read of the renderer's slides (pptx-render RenderSlide) */
interface ShownSlide {
  widthPx: number
  nodes: Array<{
    box: { centerX: number; centerY: number }
    text?: { lines: Array<{ runs: Array<{ text: string }> }> }
  }>
}

/** The slides page's bridge, as far as these tests read it */
type SlidesPage = Window & { slidesApi: { getRenderSlides(): Promise<ShownSlide[] | null> } }

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const FIXTURE = resolve(repo, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx')
const FILE_NAME = '01_standard_business.pptx'

interface SavedSlide {
  texts: string[]
  notes: string
}

/** Every slide's text bodies and speaker notes, read back with the engine the app saves with */
async function reopen(download: Download): Promise<SavedSlide[]> {
  const opened = await openPptx(new Uint8Array(readFileSync(await download.path())))
  const texts = (elements: SlideElement[]): string[] =>
    elements.flatMap((el) =>
      el.type === 'group'
        ? texts(el.children)
        : 'text' in el && el.text
          ? [el.text.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n')]
          : [],
    )
  return opened.deck.slides.map((slide) => ({
    texts: texts(slide.elements),
    notes: getSlideNotes(opened.archive, slide.path),
  }))
}

async function open(page: Page, edit: boolean): Promise<FrameLocator> {
  await page.goto('/')
  await page.setChecked('#edit', edit)
  await page.setInputFiles('#file', FIXTURE)
  await expect(page.locator('#status')).toHaveText(FILE_NAME, { timeout: 30_000 })
  const frame = page.frameLocator('#viewer iframe')
  await expect(frame.locator('.thumb')).toHaveCount(5)
  return frame
}

/** The slide's text as the renderer draws it now */
async function shownTexts(page: Page, slideIndex: number): Promise<string[]> {
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!
  return frame.evaluate(async (index) => {
    const slides = await (window as unknown as SlidesPage).slidesApi.getRenderSlides()
    return (slides?.[index]?.nodes ?? []).flatMap((node) =>
      node.text
        ? [node.text.lines.map((line) => line.runs.map((run) => run.text).join('')).join('')]
        : [],
    )
  }, slideIndex)
}

/** Double-click the text body of slide 1 (on screen) that shows `text`, opening its editor */
async function editTextShowing(page: Page, text: string): Promise<void> {
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!
  const at = await frame.evaluate(async (wanted) => {
    const stage = document.querySelector('.stage-rel')!.getBoundingClientRect()
    const slides = await (window as unknown as SlidesPage).slidesApi.getRenderSlides()
    const slide = slides![0]!
    const node = slide.nodes.find((candidate) =>
      candidate.text?.lines.some((line) =>
        line.runs
          .map((run) => run.text)
          .join('')
          .includes(wanted),
      ),
    )!
    const k = stage.width / slide.widthPx
    return { x: stage.x + node.box.centerX * k, y: stage.y + node.box.centerY * k }
  }, text)
  const viewer = (await page.locator('#viewer iframe').boundingBox())!
  await page.mouse.dblclick(viewer.x + at.x, viewer.y + at.y)
  await expect(page.frameLocator('#viewer iframe').locator('.slide-text-editor')).toBeFocused()
}

async function newSlideChord(page: Page): Promise<string> {
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!
  const mac = await frame.evaluate(() => /mac/i.test(navigator.platform))
  return mac ? 'Meta+Shift+N' : 'Control+M'
}

test('edits a presentation and hands the saved .pptx to the host', async ({ page }) => {
  const frame = await open(page, true)

  // change the subtitle of slide 1, then write notes for it
  await editTextShowing(page, 'Fiscal Year 2026')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('Fiscal Year 2027')
  await frame.locator('.notes-pane textarea').click()
  await expect(page.locator('#status')).toContainText('저장 안 함')
  await page.keyboard.type('Open with the new fiscal year')

  // a blank slide after slide 1, and the last slide removed
  await frame.locator('.thumb').first().click()
  await page.keyboard.press(await newSlideChord(page))
  await expect(frame.locator('.thumb')).toHaveCount(6)
  await frame.locator('.thumb').last().click()
  await page.keyboard.press('Delete')
  await expect(frame.locator('.thumb')).toHaveCount(5)

  const expected: SavedSlide[] = [
    { texts: ['Q3 Business Review', 'Fiscal Year 2027'], notes: 'Open with the new fiscal year' },
    { texts: [], notes: '' },
    { texts: ['Agenda', 'Financial results\nProduct updates\nRoadmap'], notes: '' },
    { texts: ['', 'Key Results'], notes: '' },
    { texts: ['Revenue by Region'], notes: '' },
  ]

  // the app's own save
  const ownSave = page.waitForEvent('download')
  await page.keyboard.press('ControlOrMeta+S')
  const own = await ownSave
  expect(own.suggestedFilename()).toBe(FILE_NAME)
  expect(await reopen(own)).toEqual(expected)
  await expect(page.locator('#status')).toHaveText(FILE_NAME)

  // the host asks for a save
  const hostSave = page.waitForEvent('download')
  await page.click('#save')
  expect(await reopen(await hostSave)).toEqual(expected)
})

test('a save the host refuses leaves the edit unsaved for the next save', async ({ page }) => {
  const frame = await open(page, true)
  await editTextShowing(page, 'Q3 Business Review')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('Q4 Business Review')
  await frame.locator('.notes-pane textarea').click()
  await expect(page.locator('#status')).toContainText('저장 안 함')

  // the launcher stores a save as a download; make storing fail once
  await page.evaluate(() => {
    const original = URL.createObjectURL
    URL.createObjectURL = () => {
      URL.createObjectURL = original
      throw new Error('host storage is full')
    }
  })
  await page.keyboard.press('ControlOrMeta+S')
  await expect(frame.getByText(/host storage is full/).first()).toBeVisible()
  await expect(page.locator('#status')).toContainText('저장 안 함')

  const retry = page.waitForEvent('download')
  await page.click('#save')
  const [first] = await reopen(await retry)
  expect(first!.texts).toEqual(['Q4 Business Review', 'Fiscal Year 2026'])
})

test('undo and redo step through edits before a save', async ({ page }) => {
  const frame = await open(page, true)
  await frame.locator('.thumb').nth(1).click()
  await page.keyboard.press('Delete')
  await expect(frame.locator('.thumb')).toHaveCount(4)
  await page.keyboard.press('ControlOrMeta+Z')
  await expect(frame.locator('.thumb')).toHaveCount(5)
  await page.keyboard.press('ControlOrMeta+Shift+Z')
  await expect(frame.locator('.thumb')).toHaveCount(4)
  await page.keyboard.press('ControlOrMeta+Z')
  await expect(frame.locator('.thumb')).toHaveCount(5)

  const saved = page.waitForEvent('download')
  await page.click('#save')
  const slides = await reopen(await saved)
  expect(slides.map((slide) => slide.texts[0])).toEqual([
    'Q3 Business Review',
    'Agenda',
    '',
    'Revenue by Region',
    'Thank you',
  ])
})

test('undoing past a save leaves the presentation unsaved', async ({ page }) => {
  const frame = await open(page, true)
  await frame.locator('.thumb').nth(1).click()
  await page.keyboard.press('Delete')
  await expect(frame.locator('.thumb')).toHaveCount(4)
  const saved = page.waitForEvent('download')
  await page.keyboard.press('ControlOrMeta+S')
  expect(await reopen(await saved)).toHaveLength(4)
  await expect(page.locator('#status')).toHaveText(FILE_NAME)

  await page.keyboard.press('ControlOrMeta+Z')
  await expect(frame.locator('.thumb')).toHaveCount(5)
  await expect(page.locator('#status')).toContainText('저장 안 함')

  // redoing back to what the host stored is clean again
  await page.keyboard.press('ControlOrMeta+Shift+Z')
  await expect(frame.locator('.thumb')).toHaveCount(4)
  await expect(page.locator('#status')).toHaveText(FILE_NAME)
})

test('without edit mode the presentation cannot be changed or saved', async ({ page }) => {
  const frame = await open(page, false)
  let downloads = 0
  page.on('download', () => downloads++)
  await expect(page.locator('#save')).toBeHidden()

  await editTextShowing(page, 'Fiscal Year 2026')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('Fiscal Year 2027')
  await frame.locator('.notes-pane textarea').click()
  await frame.locator('.thumb').first().click()
  await page.keyboard.press(await newSlideChord(page))
  await page.keyboard.press('ControlOrMeta+S')
  // give a refused edit or save the time a real one takes to land
  await page.waitForTimeout(1_000)

  await expect(frame.locator('.thumb')).toHaveCount(5)
  expect(await shownTexts(page, 0)).toEqual(['Q3 Business Review', 'Fiscal Year 2026'])
  expect(downloads).toBe(0)
})
