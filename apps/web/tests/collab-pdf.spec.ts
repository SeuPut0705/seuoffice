/**
 * Co-editing one PDF in real browser pages. Pages are driven the way the PDF
 * save spec drives them (ribbon tabs, the rectangle tool, the page tab's
 * buttons), and every result is checked in the file the host stored, read
 * back with pdf-lib.
 */
import { fileURLToPath } from 'node:url'
import { expect, test, type Browser, type FrameLocator, type Locator } from '@playwright/test'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
  StandardFonts,
  degrees,
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { openCoEdited, settled, type CoEditor, type CoFile } from './collab'

test.setTimeout(240_000)

const freshDocument = (): string => `pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../pdf/tests/fixtures/${name}`, import.meta.url))

const PAGE_TEXT = ['Page one of the plan.', 'Page two of the plan.', 'Page three of the plan.']

/** Three A4 pages, each with a line of text */
async function planPdf(): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const text of PAGE_TEXT)
    doc.addPage([595, 842]).drawText(text, { x: 72, y: 760, size: 18, font })
  return { name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) }
}

/** Every page this test opened, closed when it ends, and what any of them threw */
const opened: CoEditor[] = []
const pageErrors: string[] = []

test.afterEach(async () => {
  pageErrors.length = 0
  await Promise.all(opened.splice(0).map((editor) => editor.page.context().close()))
})

async function open(
  browser: Browser,
  file: CoFile,
  documentId: string,
  user: string,
  access: 'edit' | 'view' = 'edit',
  unlock?: (frame: FrameLocator) => Promise<void>,
): Promise<CoEditor> {
  const editor = await openCoEdited(browser, file, {
    documentId,
    user,
    access,
    ready: 'canvas',
    unlock,
  })
  opened.push(editor)
  editor.page.on('pageerror', (error) => pageErrors.push(`${user}: ${error.message}`))
  await expect(editor.frame.locator('.pdf-page').first()).toBeVisible({ timeout: 20_000 })
  await countOwnEdits(editor)
  return editor
}

/**
 * Count the edits this page itself reported, from now on: each one raises its
 * unconfirmed count, which a change from someone else never does. The session
 * version cannot tell the two apart: it rises with everyone's edits.
 */
async function countOwnEdits(editor: CoEditor): Promise<void> {
  await editor.page.evaluate(() => {
    const launcher = window.seuLauncher!
    const counted = window as unknown as { ownEdits: number }
    counted.ownEdits = 0
    let status = launcher.collab
    Object.defineProperty(launcher, 'collab', {
      configurable: true,
      get: () => status,
      set(next: typeof status) {
        if (next && status && next.unconfirmed > status.unconfirmed) {
          counted.ownEdits += next.unconfirmed - status.unconfirmed
        }
        status = next
      },
    })
  })
}

const ownEdits = (editor: CoEditor): Promise<number> =>
  editor.page.evaluate(() => {
    const counted = window as unknown as { ownEdits: number }
    return counted.ownEdits
  })

/** Run `act` and wait until the page reported the edit it made: only then can `settled` see it */
async function edit(editor: CoEditor, act: () => Promise<void>): Promise<void> {
  const before = await ownEdits(editor)
  await act()
  await expect.poll(() => ownEdits(editor), { timeout: 10_000 }).toBeGreaterThan(before)
}

/**
 * Hold (or release, in order) the frames the host page sends on its co-editing
 * socket: the page keeps editing and receiving, the server hears it later.
 */
async function holdOutgoing(editor: CoEditor, hold: boolean): Promise<void> {
  await editor.page.evaluate((hold) => {
    const w = window as unknown as {
      heldFrames?: [WebSocket, Parameters<WebSocket['send']>[0]][]
      holding?: boolean
      realSend?: WebSocket['send']
    }
    if (!w.realSend) {
      const real = WebSocket.prototype.send
      w.realSend = real
      w.heldFrames = []
      WebSocket.prototype.send = function (this: WebSocket, data) {
        if (w.holding) w.heldFrames!.push([this, data])
        else real.call(this, data)
      }
    }
    w.holding = hold
    if (!hold) for (const [socket, data] of w.heldFrames!.splice(0)) w.realSend!.call(socket, data)
  }, hold)
}

/**
 * Let every page in `editors` edit while none of their frames reach the server, so all the edits
 * are made at one version; then release the frames and wait for the pages to agree.
 */
async function atOnce(editors: CoEditor[], act: () => Promise<void>): Promise<number> {
  await Promise.all(editors.map((editor) => holdOutgoing(editor, true)))
  try {
    await act()
  } finally {
    await Promise.all(editors.map((editor) => holdOutgoing(editor, false)))
  }
  return settled(editors)
}

/** Show a ribbon tab. Pressing the tab that is already shown would collapse the ribbon. */
async function tab(editor: CoEditor, name: '홈' | '주석' | '페이지' | '편집'): Promise<void> {
  const button = editor.frame.locator('.ribbon-tab', { hasText: name }).first()
  if (!(await button.evaluate((element) => element.classList.contains('active'))))
    await button.click()
  await expect(button).toHaveClass(/active/)
}

/** A page of the document view by its index in the opened file (thumbnails repeat its layers) */
const pageAt = (editor: CoEditor, index: number): Locator =>
  editor.frame.locator(`.pdf-page[data-page="${index}"]`)

/** Scroll the first page to the top of the view: its drawings exist only while it is in view */
async function showFirstPage(editor: CoEditor): Promise<void> {
  await pageAt(editor, 0).evaluate((element) => element.scrollIntoView({ block: 'start' }))
  await expect(pageAt(editor, 0).locator('.pdf-draw-layer')).toBeVisible()
}

const rectangleTool = (editor: CoEditor): Locator =>
  editor.frame.getByRole('button', { name: '사각형', exact: true })

/** A rectangle comment on the first page, from (`left`, `top`) as fractions of the page */
async function drawRectangle(editor: CoEditor, left: number, top: number): Promise<void> {
  await tab(editor, '주석')
  await showFirstPage(editor)
  const layer = pageAt(editor, 0).locator('.pdf-draw-layer')
  await rectangleTool(editor).click()
  await expect(layer).toHaveClass(/pdf-draw-active/)
  const box = (await layer.boundingBox())!
  const { mouse } = editor.page
  await edit(editor, async () => {
    await mouse.move(box.x + box.width * left, box.y + box.height * top)
    await mouse.down()
    await mouse.move(box.x + box.width * (left + 0.2), box.y + box.height * (top + 0.1), {
      steps: 8,
    })
    await mouse.up()
  })
  // the tool stays armed; leave it so the next press on the page selects instead of drawing
  await rectangleTool(editor).click()
  await expect(layer).not.toHaveClass(/pdf-draw-active/)
}

/** Where a press takes hold of the first page's shape `index`: the middle of its top edge */
async function gripOf(editor: CoEditor, index: number): Promise<{ x: number; y: number }> {
  await showFirstPage(editor)
  const box = (await pageAt(editor, 0).locator('.pdf-draw-shape').nth(index).boundingBox())!
  // the box includes the 16px band around the outline that takes the pointer
  return { x: box.x + box.width / 2, y: box.y + 8 }
}

/** Drag the first page's shape `index` by (`dx`, `dy`) pixels */
async function dragShape(editor: CoEditor, index: number, dx: number, dy: number): Promise<void> {
  const grip = await gripOf(editor, index)
  const { mouse } = editor.page
  await mouse.move(grip.x, grip.y)
  await mouse.down()
  await mouse.move(grip.x + dx, grip.y + dy, { steps: 6 })
  await mouse.up()
}

/** Make the page at `position` (0-based, as shown) the current one, through its thumbnail */
async function selectPage(editor: CoEditor, position: number): Promise<void> {
  const thumb = editor.frame.locator('.pdf-thumb').nth(position)
  await thumb.click()
  await expect(thumb).toHaveClass(/pdf-thumb-active/)
}

async function rotatePage(editor: CoEditor, position: number): Promise<void> {
  await tab(editor, '페이지')
  await selectPage(editor, position)
  await edit(editor, () => editor.frame.getByRole('button', { name: '오른쪽으로 회전' }).click())
}

/** A blank page after the page at `position` */
async function addBlankPage(editor: CoEditor, position: number): Promise<void> {
  await tab(editor, '페이지')
  await selectPage(editor, position)
  await edit(editor, () => editor.frame.getByRole('button', { name: '빈 페이지 삽입' }).click())
}

interface Shown {
  /** the pages in the order shown: index in the opened file, and whether it lies on its side */
  pages: Array<{ page: string; sideways: boolean; blank: boolean }>
  /** the first page's shapes: left, top, width and height of each, in pixels */
  shapes: string[]
}

/** What a person sees of the document: its pages, and the drawings on the first one */
async function shown(editor: CoEditor): Promise<Shown> {
  await showFirstPage(editor)
  return editor.frame
    .locator('.pdf-page')
    .first()
    .evaluate(() => {
      const pages = Array.from(document.querySelectorAll<HTMLElement>('.pdf-page[data-page]'))
      return {
        pages: pages.map((page) => ({
          page: page.dataset.page!,
          sideways: parseFloat(page.style.width) > parseFloat(page.style.height),
          blank: page.querySelector('.pdf-page-content') === null,
        })),
        shapes: Array.from(pages[0]!.querySelectorAll('.pdf-draw-shape'), (shape) => {
          // the outline itself; a wider transparent copy before it takes the pointer
          const outline = shape.querySelector('rect:last-of-type')!
          return ['x', 'y', 'width', 'height']
            .map((name) => Math.round(Number(outline.getAttribute(name))))
            .join(' ')
        }),
      }
    })
}

/** The toolbar's unsaved mark ("저장 안 됨") or its failed and in-progress states */
const saveMarks = (editor: CoEditor): Locator =>
  editor.frame.locator('.tb-save-pending, .tb-save-error')

interface SavedPdf {
  version: number | null
  pdf: PDFDocument
}

/** The file the host stored once its version differs from `previous` */
async function savedPdf(editor: CoEditor, previous: SavedPdf | null = null): Promise<SavedPdf> {
  const read = () =>
    editor.page.evaluate(() => {
      const file = window.seuLauncher?.saved
      return file ? { version: file.version, bytes: Array.from(file.bytes) } : null
    })
  await expect
    .poll(async () => (await read())?.version ?? null, { timeout: 60_000 })
    .not.toBe(previous?.version ?? null)
  const saved = (await read())!
  return { version: saved.version, pdf: await PDFDocument.load(new Uint8Array(saved.bytes)) }
}

/** Each page of a stored file: its rotation and the rectangles (`/Rect`) of its square comments */
const pagesOf = (pdf: PDFDocument): Array<{ rotation: number; squares: string[] }> =>
  pdf.getPages().map((page) => ({
    rotation: page.getRotation().angle,
    squares: (page.node.Annots()?.asArray() ?? [])
      .map((ref) => pdf.context.lookup(ref, PDFDict))
      .filter((annot) => String(annot.get(PDFName.of('Subtype'))) === '/Square')
      .map((annot) => String(annot.get(PDFName.of('Rect')))),
  }))

/** A page's content streams as stored: what a fixture draws lives here. Empty for a blank page. */
function pageContent(pdf: PDFDocument, index: number): string {
  const contents = pdf.getPage(index).node.Contents()
  if (!contents) return ''
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => pdf.context.lookup(ref))
      : [contents]
  return streams
    .map((stream) => {
      if (!(stream instanceof PDFRawStream)) throw new Error('the page has no raw content stream')
      return Buffer.from(stream.contents).toString('latin1')
    })
    .join('\n')
}

/** For each page of `pdf`, the page of `original` whose drawing it carries; -1 for a page with none */
function sourcesOf(pdf: PDFDocument, original: PDFDocument): number[] {
  const drawings = original.getPages().map((_, index) => pageContent(original, index))
  return pdf.getPages().map((_, index) => {
    const content = pageContent(pdf, index)
    return content ? drawings.indexOf(content) : -1
  })
}

/** Press the app's own save shortcut with the keyboard inside the document view */
async function pressSave(editor: CoEditor): Promise<void> {
  await showFirstPage(editor)
  // the page margin: no text, no shape
  await pageAt(editor, 0).click({ position: { x: 12, y: 12 } })
  await editor.page.keyboard.press('ControlOrMeta+s')
}

test('two people edit one PDF at once; a late joiner and a viewer follow; saves hold one exact version', async ({
  browser,
}) => {
  const file = await planPdf()
  const original = await PDFDocument.load(file.buffer)
  const documentId = freshDocument()
  const alice = await open(browser, file, documentId, 'alice')
  const bob = await open(browser, file, documentId, 'bob')

  // different things, at the same time: a rectangle on the first page, the second page turned
  await Promise.all([drawRectangle(alice, 0.3, 0.2), rotatePage(bob, 1)])
  await settled([alice, bob])
  const afterFirst = await shown(alice)
  expect(afterFirst.shapes).toHaveLength(1)
  expect(afterFirst.pages.map((page) => page.sideways)).toEqual([false, true, false])
  await expect.poll(() => shown(bob)).toEqual(afterFirst)

  // the same rectangle, moved by both at one version: one move wins whole on both pages
  const moved: string[][] = []
  await atOnce([alice, bob], async () => {
    await edit(alice, () => dragShape(alice, 0, 90, 0))
    await edit(bob, () => dragShape(bob, 0, 0, 120))
    moved.push((await shown(alice)).shapes, (await shown(bob)).shapes)
  })
  expect(moved[0]).not.toEqual(moved[1])
  const afterMove = await shown(alice)
  expect(moved).toContainEqual(afterMove.shapes)
  await expect.poll(() => shown(bob)).toEqual(afterMove)

  // the same page, turned by both at one version: the turns add up
  await atOnce([alice, bob], async () => {
    await rotatePage(alice, 2)
    await rotatePage(bob, 2)
  })
  // both add a blank page after the first at one version: both minted the same page index
  await atOnce([alice, bob], async () => {
    await addBlankPage(alice, 0)
    await addBlankPage(bob, 0)
  })
  const afterPages = await shown(alice)
  expect(afterPages.pages.map((page) => page.blank)).toEqual([false, true, true, false, false])
  expect(afterPages.pages.map((page) => page.sideways)).toEqual([false, false, false, true, false])
  expect(new Set(afterPages.pages.map((page) => page.page)).size).toBe(5)
  await expect.poll(() => shown(bob)).toEqual(afterPages)

  // nothing keeps writing once the people stop: no edit bounces between the pages
  const quiet = await settled([alice, bob])
  await alice.page.waitForTimeout(3_000)
  expect(await settled([alice, bob])).toBe(quiet)

  // a late joiner opens the same document
  const carol = await open(browser, file, documentId, 'carol')
  await settled([alice, bob, carol])
  await expect.poll(() => shown(carol)).toEqual(afterPages)

  // a viewer sees it too, and a later edit; the tools that change the document are off
  const viewer = await open(browser, file, documentId, 'dave', 'view')
  expect((await viewer.status()).canEdit).toBe(false)
  await expect.poll(() => shown(viewer)).toEqual(afterPages)
  await expect(viewer.frame.locator('.tb-readonly')).toBeVisible()
  await tab(viewer, '주석')
  await expect(rectangleTool(viewer)).toBeDisabled()
  await tab(viewer, '페이지')
  await expect(viewer.frame.getByRole('button', { name: '오른쪽으로 회전' })).toBeDisabled()
  await expect(viewer.frame.getByRole('button', { name: '빈 페이지 삽입' })).toBeDisabled()
  await drawRectangle(bob, 0.55, 0.05)
  const version = await settled([alice, bob, carol, viewer])
  const beforeSave = await shown(bob)
  expect(beforeSave.shapes).toHaveLength(2)
  await expect.poll(() => shown(viewer)).toEqual(beforeSave)

  // the viewer drags a rectangle, tries to delete it and presses save: nothing happens anywhere
  await dragShape(viewer, 0, 60, 60)
  const grip = await gripOf(viewer, 1)
  await viewer.page.mouse.click(grip.x, grip.y)
  await viewer.page.keyboard.press('Delete')
  await viewer.page.keyboard.press('ControlOrMeta+s')
  await viewer.page.waitForTimeout(1_000)
  expect(await ownEdits(viewer)).toBe(0)
  expect(await viewer.status()).toMatchObject({ phase: 'live', version, unconfirmed: 0 })
  expect(await shown(viewer)).toEqual(beforeSave)
  expect(await shown(alice)).toEqual(beforeSave)
  // not "saving" for ever, not "unsaved": a viewer has nothing to save
  await expect(saveMarks(viewer)).toHaveCount(0)
  expect(await viewer.page.evaluate(() => window.seuLauncher?.saved ?? null)).toBeNull()

  // until someone saves, every editing page says the document is not saved
  for (const editor of [alice, bob, carol]) {
    await expect(editor.frame.locator('.tb-save-pending')).toHaveText('저장 안 됨')
    await expect(editor.page.locator('#status')).toContainText('저장 안 함')
  }

  // the host's save: the file of one version, with everyone's edits
  await alice.page.locator('#save').click()
  const first = await savedPdf(alice)
  expect(first.version).toBe(version)
  const stored = pagesOf(first.pdf)
  expect(stored.map((page) => page.rotation)).toEqual([0, 0, 0, 90, 180])
  expect(stored.map((page) => page.squares.length)).toEqual([2, 0, 0, 0, 0])
  // the opened file's pages with their drawing untouched, and the two blank pages between them
  expect(sourcesOf(first.pdf, original)).toEqual([0, -1, -1, 1, 2])
  await expect.poll(async () => (await bob.status()).saved).toBe(version)
  // and every page says so: the pending edits it still shows are in the stored file
  for (const editor of [alice, bob, carol]) {
    await expect(saveMarks(editor)).toHaveCount(0)
    await expect(editor.page.locator('#status')).not.toContainText('저장 안 함')
  }

  // the host holds this version: carol's own save has nothing new to store
  await pressSave(carol)
  await carol.page.waitForTimeout(1_000)
  expect(await carol.page.evaluate(() => window.seuLauncher?.saved ?? null)).toBeNull()
  // asked by her host, her page writes the same document for the same version
  await carol.page.locator('#save').click()
  const hers = await savedPdf(carol)
  expect(hers.version).toBe(version)
  expect(pagesOf(hers.pdf)).toEqual(stored)

  // both keep editing after the saves, and a second save holds the later edits too
  await Promise.all([drawRectangle(alice, 0.05, 0.05), edit(bob, () => dragShape(bob, 1, 0, 80))])
  const later = await settled([alice, bob, carol, viewer])
  expect(later).toBeGreaterThan(version)
  await expect(bob.frame.locator('.tb-save-pending')).toHaveText('저장 안 됨')
  const afterSave = await shown(alice)
  expect(afterSave.shapes).toHaveLength(3)
  for (const editor of [bob, carol, viewer])
    await expect.poll(() => shown(editor)).toEqual(afterSave)
  await bob.page.locator('#save').click()
  const second = await savedPdf(bob)
  expect(second.version).toBe(later)
  const storedLater = pagesOf(second.pdf)
  expect(storedLater.map((page) => page.rotation)).toEqual([0, 0, 0, 90, 180])
  expect(storedLater[0]!.squares).toHaveLength(3)
  // the rectangle nobody touched since is where the first save had it; the dragged one moved
  expect(storedLater[0]!.squares).toContain(stored[0]!.squares[0])
  expect(storedLater[0]!.squares).not.toContain(stored[0]!.squares[1])
  for (const editor of [alice, bob, carol, viewer]) {
    expect((await editor.status()).phase).toBe('live')
  }
  expect(pageErrors).toEqual([])
})

test('the app’s own save stores the co-edited version; the page keeps its edits and says it saved', async ({
  browser,
}) => {
  const file = await planPdf()
  const documentId = freshDocument()
  const alice = await open(browser, file, documentId, 'alice')
  const bob = await open(browser, file, documentId, 'bob')
  await drawRectangle(bob, 0.3, 0.2)
  const version = await settled([alice, bob])
  const drawn = await shown(bob)
  await expect.poll(() => shown(alice)).toEqual(drawn)
  // alice made no edit, and her page still has something to save: the session's
  await expect(alice.frame.locator('.tb-save-pending')).toHaveText('저장 안 됨')

  await pressSave(alice)
  const first = await savedPdf(alice)
  expect(first.version).toBe(version)
  expect(pagesOf(first.pdf).map((page) => page.squares.length)).toEqual([1, 0, 0])
  await expect.poll(async () => (await bob.status()).saved).toBe(version)
  // the save neither failed nor left the page "unsaved", on the page that saved and on the other
  for (const editor of [alice, bob]) {
    await expect(saveMarks(editor)).toHaveCount(0)
    await expect(editor.frame.locator('.pdf-toast')).toHaveCount(0)
    await expect(editor.page.locator('#status')).not.toContainText('저장 안 함')
  }
  // no reload from the stored file: the page shows what it showed, and both still agree
  expect(await shown(alice)).toEqual(drawn)

  // editing goes on: a later edit reaches the other page and the next save
  await addBlankPage(alice, 0)
  const later = await settled([alice, bob])
  const withPage = await shown(alice)
  expect(withPage.pages.map((page) => page.blank)).toEqual([false, true, false, false])
  expect(withPage.shapes).toEqual(drawn.shapes)
  await expect.poll(() => shown(bob)).toEqual(withPage)
  await expect(bob.frame.locator('.tb-save-pending')).toHaveText('저장 안 됨')
  await pressSave(bob)
  const second = await savedPdf(bob)
  expect(second.version).toBe(later)
  expect(pagesOf(second.pdf).map((page) => page.squares)).toEqual([
    pagesOf(first.pdf)[0]!.squares,
    [],
    [],
    [],
  ])
  for (const editor of [alice, bob]) await expect(saveMarks(editor)).toHaveCount(0)
  expect(pageErrors).toEqual([])
})

test('a text edit is refused with a message and changes nothing on either page', async ({
  browser,
}) => {
  const file = await planPdf()
  const original = await PDFDocument.load(file.buffer)
  const documentId = freshDocument()
  const alice = await open(browser, file, documentId, 'alice')
  const bob = await open(browser, file, documentId, 'bob')
  const before = await settled([alice, bob])
  const shownBefore = await shown(bob)

  await tab(alice, '편집')
  await alice.frame.getByRole('button', { name: '텍스트 편집', exact: true }).click()
  await alice.frame.getByText(PAGE_TEXT[0]!).first().click()
  await alice.page.keyboard.press('End')
  await alice.page.keyboard.type(' Edited')
  // the save commits the open draft first: that commit is the edit the session refuses
  await alice.page.keyboard.press('ControlOrMeta+s')
  await expect(alice.frame.locator('.pdf-toast-notice')).toContainText(
    '여러 사람이 함께 편집하는 동안에는 글자를 고치거나 넣을 수 없습니다.',
  )
  await alice.page.waitForTimeout(1_000)
  expect(await ownEdits(alice)).toBe(0)
  expect(await settled([alice, bob])).toBe(before)
  await expect(bob.frame.locator('.pdf-toast')).toHaveCount(0)
  // the typed text is on neither page, and neither has something to save
  for (const editor of [alice, bob]) {
    expect(await shown(editor)).toEqual(shownBefore)
    await expect(editor.frame.getByText('Edited')).toHaveCount(0)
    await expect(editor.frame.getByText(PAGE_TEXT[0]!).first()).toBeVisible()
    await expect(saveMarks(editor)).toHaveCount(0)
    await expect(editor.page.locator('#status')).not.toContainText('저장 안 함')
  }
  // the save she pressed stored nothing: the session holds nothing the host does not have
  for (const editor of [alice, bob]) {
    expect(await editor.page.evaluate(() => window.seuLauncher?.saved ?? null)).toBeNull()
  }
  // the file bob's page writes when his host asks is the opened one
  await bob.page.locator('#save').click()
  const saved = await savedPdf(bob)
  expect(saved.version).toBe(before)
  expect(sourcesOf(saved.pdf, original)).toEqual([0, 1, 2])
  expect(pagesOf(saved.pdf).map((page) => page.squares)).toEqual([[], [], []])
  expect(pageErrors).toEqual([])
})

/** Select the first page's shape `index` the way a person does: a press on its outline */
async function selectShape(editor: CoEditor, index: number): Promise<void> {
  const grip = await gripOf(editor, index)
  await editor.page.mouse.click(grip.x, grip.y)
  await expect(pageAt(editor, 0).locator('.pdf-draw-selected')).toHaveCount(1)
}

const storedFile = (editor: CoEditor): Promise<unknown> =>
  editor.page.evaluate(() => window.seuLauncher?.saved ?? null)

test('the app’s save stores the session’s version also when this page holds no pending edit', async ({
  browser,
}) => {
  const file = await planPdf()
  const documentId = freshDocument()
  const alice = await open(browser, file, documentId, 'alice')
  const bob = await open(browser, file, documentId, 'bob')
  await drawRectangle(alice, 0.3, 0.2)
  await settled([alice, bob])
  await pressSave(alice)
  const first = await savedPdf(alice)
  expect(pagesOf(first.pdf)[0]!.squares).toHaveLength(1)
  await expect(saveMarks(alice)).toHaveCount(0)

  // she deletes the rectangle: no pending edit is left on the page, and the stored file still
  // holds the rectangle
  await selectShape(alice, 0)
  await edit(alice, () => alice.page.keyboard.press('Delete'))
  const version = await settled([alice, bob])
  expect((await shown(alice)).shapes).toEqual([])
  await expect(alice.frame.locator('.tb-save-pending')).toHaveText('저장 안 됨')
  await pressSave(alice)
  const second = await savedPdf(alice, first)
  expect(second.version).toBe(version)
  expect(pagesOf(second.pdf)[0]!.squares).toEqual([])
  for (const editor of [alice, bob]) await expect(saveMarks(editor)).toHaveCount(0)
  // pressing save again stores nothing: the host holds this version
  await alice.page.evaluate(() => {
    window.seuLauncher!.saved = null
  })
  await pressSave(alice)
  await alice.page.waitForTimeout(1_000)
  expect(await storedFile(alice)).toBeNull()
  expect(pageErrors).toEqual([])
})

test('the host’s save takes the comment a person is still typing', async ({ browser }) => {
  const file = await planPdf()
  const documentId = freshDocument()
  const alice = await open(browser, file, documentId, 'alice')
  const bob = await open(browser, file, documentId, 'bob')

  // a note on the first page
  await tab(alice, '주석')
  await showFirstPage(alice)
  await alice.frame.getByRole('button', { name: '메모', exact: true }).click()
  const layer = (await pageAt(alice, 0).locator('.pdf-draw-layer').boundingBox())!
  await alice.page.mouse.click(layer.x + layer.width * 0.5, layer.y + layer.height * 0.3)
  const draft = alice.frame.locator('.pdf-note-draft-box textarea')
  await draft.fill('first words')
  await edit(alice, () => alice.frame.locator('.pdf-note-draft-actions .primary').click())
  await settled([alice, bob])

  // she rewrites it, and the host saves while the box is still open
  await alice.frame.locator('.pdf-note-comment-edit').first().click()
  const box = alice.frame.locator('.pdf-note-edit-box textarea')
  await box.fill('still typing when the host saved')
  await alice.page.locator('#save').click()
  const saved = await savedPdf(alice)
  const notes = (saved.pdf.getPage(0).node.Annots()?.asArray() ?? [])
    .map((ref) => saved.pdf.context.lookup(ref, PDFDict))
    .filter((annot) => String(annot.get(PDFName.of('Subtype'))) === '/Text')
    .map((annot) => {
      const contents = annot.get(PDFName.of('Contents'))
      return contents instanceof PDFString || contents instanceof PDFHexString
        ? contents.decodeText()
        : String(contents)
    })
  expect(notes).toEqual(['still typing when the host saved'])
  expect(saved.version).toBe(await settled([alice, bob]))
  await expect(bob.frame.getByText('still typing when the host saved').first()).toBeAttached()
  expect(pageErrors).toEqual([])
})

test('printing prints what the page shows and a file operation is refused; neither stores a save', async ({
  browser,
}) => {
  const file = await planPdf()
  const documentId = freshDocument()
  const alice = await open(browser, file, documentId, 'alice')
  const bob = await open(browser, file, documentId, 'bob')
  await addBlankPage(alice, 0)
  await drawRectangle(alice, 0.3, 0.2)
  const version = await settled([alice, bob])

  // the print dialog cannot be driven: count the pages handed to it instead
  const frame = alice.page.frames().find((candidate) => candidate !== alice.page.mainFrame())!
  await frame.evaluate(() => {
    const printed = window as unknown as { printedPages: number | null }
    printed.printedPages = null
    window.print = () => {
      printed.printedPages = document.querySelector('.pdf-print-root')?.children.length ?? 0
      window.dispatchEvent(new Event('afterprint'))
    }
  })
  await tab(alice, '홈')
  await alice.frame.locator('.rb-big', { hasText: '인쇄' }).click()
  await alice.frame.locator('.pdf-modal .pdf-modal-btn.primary', { hasText: '인쇄' }).click()
  await expect
    .poll(
      () =>
        frame.evaluate(() => {
          const printed = window as unknown as { printedPages: number | null }
          return printed.printedPages
        }),
      { timeout: 20_000 },
    )
    .toBe(4)
  await expect(alice.frame.locator('.tb-save-error')).toHaveCount(0)

  // merging works on the stored file, which a co-edited page does not have: refused, with a message
  await tab(alice, '페이지')
  await alice.frame.getByRole('button', { name: 'PDF 병합' }).click()
  await expect(alice.frame.locator('.pdf-toast-notice')).toContainText(
    '여러 사람이 함께 편집하는 동안에는',
  )
  await alice.page.waitForTimeout(1_000)

  // neither stored anything, and the edits are where they were
  expect(await storedFile(alice)).toBeNull()
  expect(await alice.status()).toMatchObject({ phase: 'live', version, saved: 0 })
  expect((await shown(alice)).shapes).toHaveLength(1)
  await expect(alice.frame.locator('.tb-save-pending')).toHaveText('저장 안 됨')
  expect(pageErrors).toEqual([])
})

test('a selection stays through someone else’s change, and goes when its item is deleted', async ({
  browser,
}) => {
  const file = await planPdf()
  const documentId = freshDocument()
  const alice = await open(browser, file, documentId, 'alice')
  const bob = await open(browser, file, documentId, 'bob')
  await drawRectangle(alice, 0.3, 0.2)
  await settled([alice, bob])
  await selectShape(alice, 0)
  const selected = pageAt(alice, 0).locator('.pdf-draw-selected')

  // a change that leaves the page where it is on her screen (one that moves the layout scrolls
  // the view, and a scroll closes the selection as it always does)
  await drawRectangle(bob, 0.6, 0.5)
  await settled([alice, bob])
  await expect(pageAt(alice, 0).locator('.pdf-draw-shape')).toHaveCount(2)
  await expect(selected).toHaveCount(1)

  // bob deletes the rectangle she has selected: the selection goes with it
  await selectShape(bob, 0)
  await edit(bob, () => bob.page.keyboard.press('Delete'))
  await settled([alice, bob])
  await expect(pageAt(alice, 0).locator('.pdf-draw-shape')).toHaveCount(1)
  await expect(selected).toHaveCount(0)
  expect(pageErrors).toEqual([])
})

// the encrypted fixtures' first page, and their password (encrypted.spec.ts)
const LOCKED_TEXT = 'Encrypted Edit Probe'
const LOCKED_PASSWORD = 's3cret'

async function typePassword(frame: FrameLocator): Promise<void> {
  const field = frame.locator('.pdf-pwd-dialog input')
  await expect(field).toBeVisible({ timeout: 30_000 })
  await field.fill(LOCKED_PASSWORD)
  await field.press('Enter')
}

test('a password-protected PDF opens for the first person and a late joiner, and saves protected', async ({
  browser,
}) => {
  const file = fixture('enc-r5-aes256.pdf')
  const documentId = freshDocument()
  const alice = await open(browser, file, documentId, 'alice', 'edit', typePassword)
  await expect(alice.frame.getByText(LOCKED_TEXT).first()).toBeVisible({ timeout: 30_000 })
  await drawRectangle(alice, 0.3, 0.4)
  const bob = await open(browser, file, documentId, 'bob', 'edit', typePassword)
  await expect(bob.frame.getByText(LOCKED_TEXT).first()).toBeVisible({ timeout: 30_000 })
  const version = await settled([alice, bob])
  await expect.poll(async () => (await shown(bob)).shapes).toHaveLength(1)

  await bob.page.locator('#save').click()
  await expect
    .poll(() => bob.page.evaluate(() => window.seuLauncher?.saved?.version ?? null), {
      timeout: 60_000,
    })
    .toBe(version)
  const bytes = new Uint8Array(
    await bob.page.evaluate(() => Array.from(window.seuLauncher!.saved!.bytes)),
  )
  // an independent reader: the stored file needs the password, and holds the rectangle
  await expect(getDocument({ data: bytes.slice() }).promise).rejects.toMatchObject({
    name: 'PasswordException',
  })
  const stored = await getDocument({ data: bytes.slice(), password: LOCKED_PASSWORD }).promise
  const annotations = await (await stored.getPage(1)).getAnnotations()
  expect(annotations.map((annotation) => annotation.subtype)).toEqual(['Square'])
  expect(pageErrors).toEqual([])
})

/** A form with a filled text field, a ticked box and a choice */
async function formPdf(): Promise<CoFile> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  const form = doc.getForm()
  const name = form.createTextField('applicant.name')
  name.setText('Ada Lovelace')
  name.addToPage(page, { x: 72, y: 720, width: 240, height: 24 })
  const agree = form.createCheckBox('applicant.agree')
  agree.addToPage(page, { x: 72, y: 680, width: 16, height: 16 })
  agree.check()
  const plan = form.createDropdown('applicant.plan')
  plan.addOptions(['Basic', 'Team'])
  plan.select('Team')
  plan.addToPage(page, { x: 72, y: 630, width: 160, height: 24 })
  return { name: 'form.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) }
}

/** Pages of two sizes, one stored turned, and a comment the file already holds */
async function mixedPdf(): Promise<CoFile> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const first = doc.addPage([595, 842])
  first.drawText('Portrait A4', { x: 72, y: 760, size: 18, font })
  const comment = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Square',
      Rect: [100, 500, 260, 600],
      C: [1, 0, 0],
      Border: [0, 0, 2],
      F: 4,
    }),
  )
  first.node.set(PDFName.of('Annots'), doc.context.obj([comment]))
  const second = doc.addPage([842, 595])
  second.drawText('Landscape A4', { x: 72, y: 500, size: 18, font })
  const third = doc.addPage([612, 792])
  third.drawText('Letter, stored turned', { x: 72, y: 700, size: 18, font })
  third.setRotation(degrees(90))
  return { name: 'mixed.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) }
}

const QUIET: Array<{ label: string; file: () => CoFile | Promise<CoFile> }> = [
  { label: 'a plain page', file: () => fixture('plain-sample.pdf') },
  { label: 'three pages of text', file: planPdf },
  { label: 'a filled form', file: formPdf },
  { label: 'mixed page sizes, a stored rotation and a saved comment', file: mixedPdf },
  { label: 'a file protected by an owner password', file: () => fixture('enc-r5-owneronly.pdf') },
]

for (const { label, file } of QUIET) {
  test(`two pages on ${label} write nothing of their own`, async ({ browser }) => {
    const documentId = freshDocument()
    const bytes = await file()
    const alice = await open(browser, bytes, documentId, 'alice')
    const bob = await open(browser, bytes, documentId, 'bob')
    // rendering, form values and fonts settle in this time; whatever they write must stay local
    await alice.page.waitForTimeout(5_000)
    expect(await settled([alice, bob])).toBe(0)
    // looking through the pages and the ribbon writes nothing either
    await alice.frame.locator('.pdf-thumb').last().click()
    await bob.frame.locator('.pdf-thumb').first().click()
    await tab(alice, '주석')
    await tab(bob, '페이지')
    await pageAt(bob, 0).click({ position: { x: 12, y: 12 } })
    await alice.page.waitForTimeout(2_000)
    expect(await settled([alice, bob])).toBe(0)
    for (const editor of [alice, bob]) {
      expect(await ownEdits(editor)).toBe(0)
      await expect(saveMarks(editor)).toHaveCount(0)
      await expect(editor.page.locator('#status')).not.toContainText('저장 안 함')
    }
    expect(await shown(bob)).toEqual(await shown(alice))
    expect(pageErrors).toEqual([])
  })
}
