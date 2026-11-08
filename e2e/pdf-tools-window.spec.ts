import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFString,
  StandardFonts,
  concatTransformationMatrix,
  degrees,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from 'pdf-lib'
import { closeAndSaveVideo, launchShell, screenshotPath, waitForPageWithUrl } from './helpers'

/**
 * The PDF tools window (decision 0030) on the built app: Home's card opens it,
 * a tool takes its files from the main process's open dialog, writes where the
 * save dialog points, refuses to write over a source, and opens its result in a
 * PDF tab; an editor-only card opens the picked PDF in a PDF tab. The main
 * process's file dialogs are replaced with queues the test fills, so no native
 * dialog appears. Nothing here uses AI.
 */

/** where the screenshots for review go (defaults to e2e/artifacts/screenshots) */
const EVIDENCE_DIR = process.env.PDF_TOOLS_EVIDENCE_DIR
const shot = (name: string) =>
  EVIDENCE_DIR ? join(EVIDENCE_DIR, `${name}.png`) : screenshotPath(name)

async function makePdf(path: string, sizes: [number, number][]): Promise<void> {
  const doc = await PDFDocument.create()
  for (const size of sizes) doc.addPage(size)
  await writeFile(path, await doc.save({ useObjectStreams: false }))
}

const sha = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

/** the next answers of the main process's open and save dialogs; an empty queue cancels */
async function queueDialogs(
  app: ElectronApplication,
  answers: { open?: string[][]; save?: string[] },
): Promise<void> {
  await app.evaluate(({ dialog }, next) => {
    const g = globalThis as Record<string, unknown>
    g.__pdfToolsOpen = [...(next.open ?? [])]
    g.__pdfToolsSave = [...(next.save ?? [])]
    dialog.showOpenDialog = (async () => {
      const paths = (g.__pdfToolsOpen as string[][]).shift()
      return paths ? { canceled: false, filePaths: paths } : { canceled: true, filePaths: [] }
    }) as never
    dialog.showSaveDialog = (async () => {
      const path = (g.__pdfToolsSave as string[]).shift()
      return path ? { canceled: false, filePath: path } : { canceled: true, filePath: '' }
    }) as never
  }, answers)
}

/** how many editor views of one kind are open ('://pdf/', '://markdown/') */
async function editorPages(app: ElectronApplication, marker = '://pdf/'): Promise<number> {
  let count = 0
  for (const candidate of app.windows()) {
    const href = await candidate.evaluate(() => window.location.href).catch(() => '')
    if (href.includes(marker)) count++
  }
  return count
}
const pdfPages = (app: ElectronApplication) => editorPages(app)

/** a real grey RGB PNG */
function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed))
    return Buffer.concat([len, typed, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)])
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

async function openToolsWindow(app: ElectronApplication, home: Page, card: RegExp): Promise<Page> {
  await home.getByRole('button', { name: card }).click()
  const tools = await waitForPageWithUrl(app, 'pdf-tools.html')
  await expect(tools.locator('.pt-title')).toBeVisible()
  return tools
}

test.describe('PDF tools window', () => {
  test('merge, split, refusing a source, and opening results and editor cards in tabs', async () => {
    test.setTimeout(180_000)
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-pdf-tools-e2e-'))
    const a = join(dir, 'a.pdf')
    const b = join(dir, 'b.pdf')
    const bad = join(dir, 'bad.pdf')
    const merged = join(dir, 'merged.pdf')
    const parts = join(dir, 'parts')
    await makePdf(a, [
      [300, 400],
      [300, 400],
      [300, 400],
    ])
    await makePdf(b, [
      [500, 200],
      [500, 200],
    ])
    await writeFile(bad, 'not a pdf')
    await mkdir(parts)
    if (EVIDENCE_DIR) await mkdir(EVIDENCE_DIR, { recursive: true })
    const before = { a: await sha(a), b: await sha(b) }

    const launched = await launchShell({ onboardingSeen: true, videoDir: 'pdf-tools-window' })
    const { app, page } = launched
    try {
      const tools = await openToolsWindow(app, page, /PDF tools/)
      await expect(
        tools.getByText('These tools work only on this PC and do not use AI.'),
      ).toBeVisible()
      await tools.screenshot({ path: shot('pdf-tools-home-en') })

      // merge: an unreadable pick is named and left out, the order can change
      await tools.getByRole('button', { name: /Merge PDF/ }).click()
      await queueDialogs(app, { open: [[a, bad], [b]], save: [merged] })
      await tools.getByRole('button', { name: 'Choose PDF', exact: true }).click()
      await expect(tools.getByText('bad.pdf: could not be read as a PDF.')).toBeVisible()
      await expect(tools.locator('.pt-item')).toHaveCount(1)
      const run = tools.getByRole('button', { name: 'Save as new file' })
      await expect(run).toBeDisabled()
      await tools.getByRole('button', { name: 'Add more PDFs' }).click()
      await expect(tools.locator('.pt-item')).toHaveCount(2)
      await tools.locator('.pt-item').nth(1).getByRole('button', { name: 'Move up' }).click()
      await expect(tools.locator('.pt-item-name').first()).toHaveText('b.pdf')
      await tools.screenshot({ path: shot('pdf-tools-merge-en') })
      await run.click()
      await expect(tools.getByText('Made a new file: merged.pdf')).toBeVisible()
      const out = await PDFDocument.load(await readFile(merged))
      expect(out.getPageCount()).toBe(5)
      expect(out.getPage(0).getWidth()).toBe(500)
      expect(out.getPage(2).getWidth()).toBe(300)
      await tools.screenshot({ path: shot('pdf-tools-merge-done-en') })

      // the result opens in a PDF tab
      const tabsBefore = await pdfPages(app)
      await tools.getByRole('button', { name: 'Open in a tab' }).click()
      await expect.poll(() => pdfPages(app), { timeout: 30_000 }).toBe(tabsBefore + 1)

      // saving over a source is refused and writes nothing
      await queueDialogs(app, { save: [a] })
      await run.click()
      await expect(
        tools.getByText('You cannot save over a source file. Choose another name.'),
      ).toBeVisible()

      // split: one file per page, into a folder the dialog picks
      await tools.getByRole('button', { name: 'All tools' }).click()
      await tools.getByRole('button', { name: /Split PDF/ }).click()
      await queueDialogs(app, { open: [[a], [parts]] })
      await tools.getByRole('button', { name: 'Choose PDF', exact: true }).click()
      await expect(tools.getByText('3 pages', { exact: false })).toBeVisible()
      await tools.getByRole('button', { name: 'Save as new file' }).click()
      await expect(tools.getByText('Made 3 files.')).toBeVisible()
      for (const n of [1, 2, 3]) {
        const part = await PDFDocument.load(await readFile(join(parts, `a-${n}.pdf`)))
        expect(part.getPageCount()).toBe(1)
      }

      // an editor-only card opens the picked PDF in a PDF tab
      await tools.getByRole('button', { name: 'All tools' }).click()
      await tools.getByRole('button', { name: /Crop pages/ }).click()
      await expect(
        tools.getByText('Open the PDF in the editor, then choose this in the ribbon.'),
      ).toBeVisible()
      const tabsBeforeEditor = await pdfPages(app)
      await queueDialogs(app, { open: [[b]] })
      await tools.getByRole('button', { name: 'Open a PDF' }).click()
      await expect.poll(() => pdfPages(app), { timeout: 30_000 }).toBe(tabsBeforeEditor + 1)

      // sources were only read
      expect(await sha(a)).toBe(before.a)
      expect(await sha(b)).toBe(before.b)
      expect(existsSync(join(parts, 'a-4.pdf'))).toBe(false)

      const closed = tools.waitForEvent('close')
      // the window can close before the click itself has finished: that is the button working
      await tools
        .getByRole('button', { name: 'Close', exact: true })
        .click()
        .catch((err: unknown) => {
          if (!tools.isClosed()) throw err
        })
      await closed
    } finally {
      await closeAndSaveVideo(launched, 'pdf-tools-window')
    }
  })

  test('pictures to a PDF, and a PDF to text', async () => {
    test.setTimeout(180_000)
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-pdf-tools-e2e-'))
    const wide = join(dir, 'wide.png')
    const tall = join(dir, 'tall.png')
    const notImage = join(dir, 'notes.png')
    const photos = join(dir, 'photos.pdf')
    const report = join(dir, 'report.pdf')
    const scan = join(dir, 'scan.pdf')
    const reportText = join(dir, 'report.txt')
    await writeFile(wide, png(60, 30))
    await writeFile(tall, png(30, 60))
    await writeFile(notImage, 'not a picture')
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (const line of ['First page', 'Second page']) {
      doc.addPage([300, 300]).drawText(line, { x: 20, y: 200, size: 14, font })
    }
    await writeFile(report, await doc.save({ useObjectStreams: false }))
    await makePdf(scan, [[300, 300]])
    if (EVIDENCE_DIR) await mkdir(EVIDENCE_DIR, { recursive: true })

    const launched = await launchShell({ onboardingSeen: true, videoDir: 'pdf-tools-convert' })
    const { app, page } = launched
    try {
      const tools = await openToolsWindow(app, page, /PDF tools/)

      // images to PDF: a file that is no picture is named and left out
      await tools.getByRole('button', { name: /Images to PDF/ }).click()
      await queueDialogs(app, { open: [[wide, notImage], [tall]], save: [photos] })
      await tools.getByRole('button', { name: 'Choose pictures' }).click()
      await expect(tools.getByText('notes.png: not a JPG or PNG picture.')).toBeVisible()
      await tools.getByRole('button', { name: 'Add more pictures' }).click()
      await expect(tools.locator('.pt-item')).toHaveCount(2)
      await tools.getByRole('radio', { name: 'Wide' }).check()
      await tools.screenshot({ path: shot('pdf-tools-images-en') })
      await tools.getByRole('button', { name: 'Save as new file' }).click()
      await expect(tools.getByText('Made a new file: photos.pdf')).toBeVisible()
      const made = await PDFDocument.load(await readFile(photos))
      expect(made.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([
        [842, 595],
        [595, 842],
      ])

      // save as text, then open the text file in a tab
      await tools.getByRole('button', { name: 'All tools' }).click()
      await tools.getByRole('button', { name: /Save as text/ }).click()
      await queueDialogs(app, { open: [[report]], save: [join(dir, 'report')] })
      await tools.getByRole('button', { name: 'Choose PDF', exact: true }).click()
      await expect(
        tools.getByText('Pages whose text is a picture, such as scanned pages, come out empty.'),
      ).toBeVisible()
      await tools.getByRole('button', { name: 'Save as new file' }).click()
      await expect(tools.getByText('Made a new file: report.txt')).toBeVisible()
      expect(await readFile(reportText, 'utf8')).toBe('First page\n\nSecond page\n')
      await tools.screenshot({ path: shot('pdf-tools-text-en') })
      const textTabs = await editorPages(app, '://markdown/')
      await tools.getByRole('button', { name: 'Open in a tab' }).click()
      await expect
        .poll(() => editorPages(app, '://markdown/'), { timeout: 30_000 })
        .toBe(textTabs + 1)
      const textTab = await waitForPageWithUrl(app, '://markdown/')
      await expect(textTab.locator('body')).toContainText('Second page')

      // saving the text again over that file: the open tab reads it again
      const revised = await PDFDocument.create()
      const revisedFont = await revised.embedFont(StandardFonts.Helvetica)
      revised
        .addPage([300, 300])
        .drawText('Revised page', { x: 20, y: 200, size: 14, font: revisedFont })
      await writeFile(join(dir, 'revised.pdf'), await revised.save({ useObjectStreams: false }))
      await queueDialogs(app, { open: [[join(dir, 'revised.pdf')]], save: [reportText] })
      await tools.getByRole('button', { name: 'Choose another PDF' }).click()
      await tools.getByRole('button', { name: 'Save as new file' }).click()
      await expect(tools.getByText('Made a new file: report.txt')).toBeVisible()
      await tools.getByRole('button', { name: 'Open in a tab' }).click()
      await expect(textTab.locator('body')).toContainText('Revised page', { timeout: 30_000 })
      expect(await editorPages(app, '://markdown/')).toBe(textTabs + 1)

      // a PDF without any text is named, and nothing is asked or written
      await queueDialogs(app, { open: [[scan]], save: [join(dir, 'scan.txt')] })
      await tools.getByRole('button', { name: 'Choose another PDF' }).click()
      await tools.getByRole('button', { name: 'Save as new file' }).click()
      await expect(tools.getByText(/No text was found in this PDF/)).toBeVisible()
      expect(existsSync(join(dir, 'scan.txt'))).toBe(false)
    } finally {
      await closeAndSaveVideo(launched, 'pdf-tools-convert')
    }
  })

  test('padding files for two-sided printing', async () => {
    test.setTimeout(120_000)
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-pdf-tools-e2e-'))
    const a = join(dir, 'a.pdf')
    const b = join(dir, 'b.pdf')
    const out = join(dir, 'print.pdf')
    await makePdf(a, [
      [300, 400],
      [300, 400],
      [300, 400],
    ])
    await makePdf(b, [[500, 200]])
    if (EVIDENCE_DIR) await mkdir(EVIDENCE_DIR, { recursive: true })

    const launched = await launchShell({ onboardingSeen: true, videoDir: 'pdf-tools-duplex' })
    const { app, page } = launched
    try {
      const tools = await openToolsWindow(app, page, /PDF tools/)
      await tools.getByRole('button', { name: /Pad for two-sided printing/ }).click()
      await queueDialogs(app, { open: [[a, b]], save: [out] })
      await tools.getByRole('button', { name: 'Choose PDF', exact: true }).click()
      await expect(tools.locator('.pt-item')).toHaveCount(2)
      // two pages a side later: every file fills whole sheets (a multiple of 4)
      await tools.getByLabel('Pages per side, if merged later').selectOption('2')
      await tools.screenshot({ path: shot('pdf-tools-duplex-en') })
      await tools.getByRole('button', { name: 'Save as new file' }).click()
      await expect(tools.getByText('Made a new file: print.pdf')).toBeVisible()
      const made = await PDFDocument.load(await readFile(out))
      expect(made.getPages().map((p) => p.getWidth())).toEqual([
        300, 300, 300, 300, 500, 500, 500, 500,
      ])
    } finally {
      await closeAndSaveVideo(launched, 'pdf-tools-duplex')
    }
  })

  test('a background behind every page, upright on a turned page', async () => {
    test.setTimeout(150_000)
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-pdf-tools-e2e-'))
    const doc = join(dir, 'letter.pdf')
    const letterhead = join(dir, 'letterhead.pdf')
    const out = join(dir, 'letter-background.pdf')
    const body = await PDFDocument.create()
    const font = await body.embedFont(StandardFonts.Helvetica)
    body.addPage([400, 300]).drawText('Upright page', { x: 30, y: 150, size: 24, font })
    // saved turned: the viewer shows it as a portrait page
    const turned = body.addPage([400, 300])
    turned.setRotation(degrees(90))
    turned.drawText('Turned page', { x: 30, y: 150, size: 24, font })
    await writeFile(doc, await body.save({ useObjectStreams: false }))
    const head = await PDFDocument.create()
    const headFont = await head.embedFont(StandardFonts.HelveticaBold)
    const sheet = head.addPage([210, 297])
    sheet.drawRectangle({ x: 0, y: 257, width: 210, height: 40, color: rgb(0.2, 0.45, 0.8) })
    sheet.drawText('LETTERHEAD', { x: 20, y: 270, size: 18, font: headFont, color: rgb(1, 1, 1) })
    await writeFile(letterhead, await head.save({ useObjectStreams: false }))
    if (EVIDENCE_DIR) await mkdir(EVIDENCE_DIR, { recursive: true })

    const launched = await launchShell({ onboardingSeen: true, videoDir: 'pdf-tools-overlay' })
    const { app, page } = launched
    try {
      const tools = await openToolsWindow(app, page, /PDF tools/)
      await tools.getByRole('button', { name: /Add a background/ }).click()
      await queueDialogs(app, { open: [[doc], [letterhead]], save: [out] })
      await tools.getByRole('button', { name: 'Choose PDF', exact: true }).click()
      const run = tools.getByRole('button', { name: 'Save as new file' })
      // no background yet
      await expect(run).toBeDisabled()
      await tools.getByRole('button', { name: 'Choose background PDF' }).click()
      await expect(tools.locator('.pt-item')).toHaveCount(2)
      await tools.screenshot({ path: shot('pdf-tools-overlay-en') })
      await run.click()
      await expect(tools.getByText('Made a new file: letter-background.pdf')).toBeVisible()
      const made = await PDFDocument.load(await readFile(out))
      expect(made.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90])

      // look at it in the editor: the letterhead stands upright on both pages
      const before = await pdfPages(app)
      await tools.getByRole('button', { name: 'Open in a tab' }).click()
      await expect.poll(() => pdfPages(app), { timeout: 30_000 }).toBe(before + 1)
      const editor = await waitForPageWithUrl(app, '://pdf/')
      await expect(editor.locator('.pdf-page')).toHaveCount(2, { timeout: 30_000 })
      await editor.waitForTimeout(1500)
      await editor.screenshot({ path: shot('pdf-tools-overlay-result') })
    } finally {
      await closeAndSaveVideo(launched, 'pdf-tools-overlay')
    }
  })

  test('removing comments, keeping links, and nothing to remove', async () => {
    test.setTimeout(120_000)
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-pdf-tools-e2e-'))
    const reviewed = join(dir, 'reviewed.pdf')
    const plain = join(dir, 'plain.pdf')
    const out = join(dir, 'reviewed-clean.pdf')
    const doc = await PDFDocument.create()
    const sheet = doc.addPage([300, 300])
    for (const [subtype, contents] of [
      ['Text', 'private remark'],
      ['Link', 'a link'],
    ]) {
      sheet.node.addAnnot(
        doc.context.register(
          doc.context.obj({
            Type: 'Annot',
            Subtype: subtype,
            Rect: [10, 10, 60, 60],
            Contents: PDFString.of(contents!),
          }),
        ),
      )
    }
    await writeFile(reviewed, await doc.save({ useObjectStreams: false }))
    await makePdf(plain, [[300, 300]])
    if (EVIDENCE_DIR) await mkdir(EVIDENCE_DIR, { recursive: true })

    const launched = await launchShell({ onboardingSeen: true, videoDir: 'pdf-tools-annots' })
    const { app, page } = launched
    try {
      const tools = await openToolsWindow(app, page, /PDF tools/)
      await tools.getByRole('button', { name: /Remove annotations/ }).click()
      await queueDialogs(app, { open: [[reviewed]], save: [out] })
      await tools.getByRole('button', { name: 'Choose PDF', exact: true }).click()
      // links stay unless ticked
      await expect(tools.getByRole('checkbox', { name: 'Links' })).not.toBeChecked()
      await expect(tools.getByRole('checkbox', { name: 'Comments' })).toBeChecked()
      await tools.screenshot({ path: shot('pdf-tools-annots-en') })
      await tools.getByRole('button', { name: 'Save as new file' }).click()
      await expect(tools.getByText('Made a new file: reviewed-clean.pdf')).toBeVisible()
      const cleaned = await readFile(out)
      expect(Buffer.from(cleaned).toString('latin1')).not.toContain('private remark')
      expect((await PDFDocument.load(cleaned)).getPage(0).node.Annots()?.size()).toBe(1)

      // with every kind unticked the tool cannot run
      for (const box of await tools.getByRole('checkbox').all()) await box.uncheck()
      await expect(tools.getByRole('button', { name: 'Save as new file' })).toBeDisabled()

      // a PDF without any of the chosen kinds is named, and no file is written
      await tools.getByRole('checkbox', { name: 'Comments' }).check()
      await queueDialogs(app, { open: [[plain]], save: [join(dir, 'plain-clean.pdf')] })
      await tools.getByRole('button', { name: 'Choose another PDF' }).click()
      await tools.getByRole('button', { name: 'Save as new file' }).click()
      await expect(tools.getByText('There are no annotations of the chosen kinds.')).toBeVisible()
      expect(existsSync(join(dir, 'plain-clean.pdf'))).toBe(false)
    } finally {
      await closeAndSaveVideo(launched, 'pdf-tools-annots')
    }
  })

  test('finding blank pages in a job process, and removing only the picked ones', async () => {
    test.setTimeout(150_000)
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-pdf-tools-e2e-'))
    const report = join(dir, 'scan.pdf')
    const out = join(dir, 'scan-no-blank.pdf')
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    doc.addPage([300, 400]).drawText('One', { x: 40, y: 300, size: 24, font })
    doc.addPage([300, 400])
    doc.addPage([300, 400]).drawText('Three', { x: 40, y: 300, size: 24, font })
    doc
      .addPage([300, 400])
      .drawRectangle({ x: 0, y: 0, width: 300, height: 400, color: rgb(1, 1, 1) })
    await writeFile(report, await doc.save({ useObjectStreams: false }))
    if (EVIDENCE_DIR) await mkdir(EVIDENCE_DIR, { recursive: true })

    const launched = await launchShell({ onboardingSeen: true, videoDir: 'pdf-tools-blank' })
    const { app, page } = launched
    try {
      const tools = await openToolsWindow(app, page, /PDF tools/)
      await tools.getByRole('button', { name: /Remove blank pages/ }).click()
      await queueDialogs(app, { open: [[report]], save: [out] })
      await tools.getByRole('button', { name: 'Choose PDF', exact: true }).click()
      const run = tools.getByRole('button', { name: 'Save as new file' })
      // nothing goes before the user has seen the candidates
      await expect(run).toBeDisabled()
      await tools.getByRole('button', { name: 'Find blank pages' }).click()
      await expect(tools.getByText(/Found 2 pages that look blank/)).toBeVisible({
        timeout: 60_000,
      })
      const cards = tools.locator('.pt-blank')
      await expect(cards).toHaveCount(2)
      await expect(cards.nth(0)).toContainText('Page 2')
      await expect(cards.nth(0)).toContainText('Nothing on it')
      await expect(cards.nth(1)).toContainText('Page 4')
      await expect(cards.nth(1)).toContainText('Nearly white')
      // a page that draws nothing starts picked; a nearly white one does not
      await expect(cards.nth(0).getByRole('checkbox')).toBeChecked()
      await expect(cards.nth(1).getByRole('checkbox')).not.toBeChecked()
      await expect(cards.nth(1).locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/)
      await tools.screenshot({ path: shot('pdf-tools-blank-en') })
      await cards.nth(1).getByRole('checkbox').check()
      await run.click()
      await expect(tools.getByText('Made a new file: scan-no-blank.pdf')).toBeVisible()
      const made = await PDFDocument.load(await readFile(out))
      expect(made.getPageCount()).toBe(2)

      // the job process is gone once it answered
      await expect
        .poll(
          () =>
            app.evaluate(
              ({ app: electronApp }) =>
                electronApp.getAppMetrics().filter((m) => m.serviceName === 'pdf-structure').length,
            ),
          { timeout: 15_000 },
        )
        .toBe(0)
    } finally {
      await closeAndSaveVideo(launched, 'pdf-tools-blank')
    }
  })

  test("the PDF editor ribbon opens a task on the editor's own file", async () => {
    test.setTimeout(150_000)
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-pdf-tools-e2e-'))
    const report = join(dir, 'report.pdf')
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    doc.addPage([300, 400]).drawText('Kept page', { x: 40, y: 300, size: 24, font })
    doc.addPage([300, 400])
    await writeFile(report, await doc.save({ useObjectStreams: false }))
    if (EVIDENCE_DIR) await mkdir(EVIDENCE_DIR, { recursive: true })

    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'pdf-tools-ribbon',
      openFile: report,
    })
    const { app } = launched
    try {
      const editor = await waitForPageWithUrl(app, '://pdf/')
      await expect(editor.locator('.pdf-thumb')).toHaveCount(2, { timeout: 30_000 })
      await editor.getByRole('button', { name: 'Pages', exact: true }).click()
      await editor.getByRole('button', { name: 'PDF tools', exact: true }).click()
      await editor.screenshot({ path: shot('pdf-tools-ribbon-menu') })
      await editor.getByRole('button', { name: 'Remove blank pages', exact: true }).click()

      // the window opens on that task with the editor's file already picked
      const tools = await waitForPageWithUrl(app, 'pdf-tools.html')
      await expect(tools.locator('.pt-tool-title')).toHaveText('Remove blank pages')
      await expect(tools.locator('.pt-item-name')).toHaveText(['report.pdf'])
      await tools.getByRole('button', { name: 'Find blank pages' }).click()
      await expect(tools.getByText(/Found 1 pages that look blank/)).toBeVisible({
        timeout: 60_000,
      })

      // with the window open, another task from the ribbon switches it over
      await editor.bringToFront()
      await editor.getByRole('button', { name: 'PDF tools', exact: true }).click()
      await editor.getByRole('button', { name: 'Save as text', exact: true }).click()
      await expect(tools.locator('.pt-tool-title')).toHaveText('Save as text')
      await expect(tools.locator('.pt-item-name')).toHaveText(['report.pdf'])
      await tools.screenshot({ path: shot('pdf-tools-from-ribbon') })
    } finally {
      await closeAndSaveVideo(launched, 'pdf-tools-ribbon')
    }
  })

  test('making a PDF with a large picture smaller', async () => {
    test.setTimeout(180_000)
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-pdf-tools-e2e-'))
    const scan = join(dir, 'photo.pdf')
    const out = join(dir, 'photo-smaller.pdf')
    // a noisy 1600×1600 picture: Flate cannot shrink it, JPEG can
    const width = 1600
    const rgb = new Uint8Array(width * width * 3)
    let seed = 11
    for (let i = 0; i < rgb.length; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
      rgb[i] = (seed >> 16) & 0xff
    }
    const doc = await PDFDocument.create()
    const page = doc.addPage([600, 600])
    const image = doc.context.register(
      doc.context.flateStream(rgb, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: width,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
      }),
    )
    const name = page.node.newXObject('Im', image)
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(600, 0, 0, 600, 0, 0),
      drawObject(name),
      popGraphicsState(),
    )
    await writeFile(scan, await doc.save({ useObjectStreams: false }))
    const before = (await readFile(scan)).length
    if (EVIDENCE_DIR) await mkdir(EVIDENCE_DIR, { recursive: true })

    const launched = await launchShell({ onboardingSeen: true, videoDir: 'pdf-tools-compress' })
    const { app, page: home } = launched
    try {
      const tools = await openToolsWindow(app, home, /PDF tools/)
      await tools.getByRole('button', { name: /Make smaller/ }).click()
      await queueDialogs(app, { open: [[scan]], save: [out] })
      await tools.getByRole('button', { name: 'Choose PDF', exact: true }).click()
      await tools.getByRole('radio', { name: 'Strong (size first)' }).check()
      await tools.screenshot({ path: shot('pdf-tools-compress-en') })
      await tools.getByRole('button', { name: 'Save as new file' }).click()
      await expect(tools.getByText(/Made a new file: photo-smaller\.pdf \(.+ → .+\)/)).toBeVisible({
        timeout: 60_000,
      })
      const made = await readFile(out)
      expect(made.length).toBeLessThan(before / 3)
      // the picture is a JPEG now, at the strong level's longest side
      const smaller = await PDFDocument.load(made)
      const pictures = smaller.context
        .enumerateIndirectObjects()
        .map(([, object]) => object)
        .filter((object): object is PDFRawStream => object instanceof PDFRawStream)
        .filter((object) => object.dict.lookup(PDFName.of('Subtype'))?.toString() === '/Image')
      expect(pictures).toHaveLength(1)
      expect(pictures[0]!.dict.lookup(PDFName.of('Filter'))?.toString()).toBe('/DCTDecode')
      expect(pictures[0]!.dict.lookup(PDFName.of('Width'))?.toString()).toBe('1400')

      // and it still draws in the editor
      const tabs = await pdfPages(app)
      await tools.getByRole('button', { name: 'Open in a tab' }).click()
      await expect.poll(() => pdfPages(app), { timeout: 30_000 }).toBe(tabs + 1)
      const editor = await waitForPageWithUrl(app, '://pdf/')
      await expect(editor.locator('.pdf-page')).toHaveCount(1, { timeout: 30_000 })
      await editor.waitForTimeout(1500)
      await editor.screenshot({ path: shot('pdf-tools-compress-result') })
    } finally {
      await closeAndSaveVideo(launched, 'pdf-tools-compress')
    }
  })

  test('adding a password, removing it, and repairing a file cut short', async () => {
    test.setTimeout(180_000)
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-pdf-tools-e2e-'))
    const plain = join(dir, 'minutes.pdf')
    const locked = join(dir, 'minutes-locked.pdf')
    const unlocked = join(dir, 'minutes-unlocked.pdf')
    const cut = join(dir, 'download.pdf')
    const repaired = join(dir, 'download-repaired.pdf')
    await makePdf(plain, [
      [300, 400],
      [300, 400],
    ])
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 0; i < 3; i++) {
      doc.addPage([300, 400]).drawText(`Page ${i + 1}`, { x: 30, y: 300, size: 24, font })
    }
    const whole = await doc.save({ useObjectStreams: false })
    // a download that stopped partway: the last page and the cross-reference table are gone
    await writeFile(cut, whole.slice(0, Math.floor(whole.length * 0.7)))
    const plainHash = await sha(plain)
    const password = '열려라 참깨 7'
    const isEncrypted = async (path: string) =>
      (await PDFDocument.load(await readFile(path), { ignoreEncryption: true })).isEncrypted
    if (EVIDENCE_DIR) await mkdir(EVIDENCE_DIR, { recursive: true })

    const launched = await launchShell({ onboardingSeen: true, videoDir: 'pdf-tools-security' })
    const { app, page: home } = launched
    try {
      const tools = await openToolsWindow(app, home, /PDF tools/)
      await tools.screenshot({ path: shot('pdf-tools-home-security-en') })

      // add password: typed twice, and the button waits until both match
      await tools.getByRole('button', { name: /Add password/ }).click()
      await queueDialogs(app, { open: [[plain]], save: [locked] })
      await tools.getByRole('button', { name: 'Choose PDF', exact: true }).click()
      const run = tools.getByRole('button', { name: 'Save as new file' })
      await tools.getByLabel('Password to open').fill(password)
      await tools.getByLabel('Type the password again').fill('열려라')
      await expect(tools.getByText('The two passwords do not match.')).toBeVisible()
      await expect(run).toBeDisabled()
      await tools.getByLabel('Type the password again').fill(password)
      await tools.getByRole('checkbox', { name: 'Block printing, copying and changes' }).check()
      await tools.getByLabel('Password to lift the block').fill(password)
      await expect(
        tools.getByText('The password to lift the block must differ from the password to open.'),
      ).toBeVisible()
      await tools.getByLabel('Password to lift the block').fill('owner only')
      await expect(run).toBeEnabled()
      await tools.screenshot({ path: shot('pdf-tools-encrypt-en') })
      await run.click()
      await expect(tools.getByText('Made a new file: minutes-locked.pdf')).toBeVisible({
        timeout: 60_000,
      })
      expect(await isEncrypted(locked)).toBe(true)
      expect(await sha(plain)).toBe(plainHash)
      // the passwords are not kept on screen once used
      await expect(tools.getByLabel('Password to open')).toHaveValue('')

      // remove password: only a protected PDF, and only with its password
      await tools.getByRole('button', { name: /All tools/ }).click()
      await tools.getByRole('button', { name: /Remove password/ }).click()
      await queueDialogs(app, { open: [[plain], [locked]], save: [unlocked] })
      await tools.getByRole('button', { name: 'Choose PDF', exact: true }).click()
      await expect(tools.getByText('minutes.pdf: this PDF has no password.')).toBeVisible()
      await tools.getByRole('button', { name: 'Choose PDF', exact: true }).click()
      await expect(tools.locator('.pt-item-name')).toHaveText('minutes-locked.pdf')
      await tools.getByLabel('Current password').fill('wrong')
      await tools.getByRole('button', { name: 'Save as new file' }).click()
      await expect(tools.getByText('The password is not correct.')).toBeVisible({ timeout: 60_000 })
      expect(existsSync(unlocked)).toBe(false)
      await tools.getByLabel('Current password').fill(password)
      await tools.screenshot({ path: shot('pdf-tools-decrypt-en') })
      await tools.getByRole('button', { name: 'Save as new file' }).click()
      await expect(tools.getByText('Made a new file: minutes-unlocked.pdf')).toBeVisible({
        timeout: 60_000,
      })
      expect(await isEncrypted(unlocked)).toBe(false)
      expect((await PDFDocument.load(await readFile(unlocked))).getPageCount()).toBe(2)

      // repair: the pages that survived come back as a file every tool reads
      await tools.getByRole('button', { name: /All tools/ }).click()
      await tools.getByRole('button', { name: /Repair file/ }).click()
      await queueDialogs(app, { open: [[cut]], save: [repaired] })
      await tools.getByRole('button', { name: 'Choose PDF', exact: true }).click()
      await tools.screenshot({ path: shot('pdf-tools-repair-en') })
      await tools.getByRole('button', { name: 'Save as new file' }).click()
      await expect(tools.getByText('Made a new file: download-repaired.pdf')).toBeVisible({
        timeout: 60_000,
      })
      expect((await PDFDocument.load(await readFile(repaired))).getPageCount()).toBe(2)
      const tabs = await pdfPages(app)
      await tools.getByRole('button', { name: 'Open in a tab' }).click()
      await expect.poll(() => pdfPages(app), { timeout: 30_000 }).toBe(tabs + 1)
      const editor = await waitForPageWithUrl(app, '://pdf/')
      await expect(editor.locator('.pdf-page')).toHaveCount(2, { timeout: 30_000 })
      await editor.waitForTimeout(1500)
      await editor.screenshot({ path: shot('pdf-tools-repair-result') })
    } finally {
      await closeAndSaveVideo(launched, 'pdf-tools-security')
    }
  })

  test('the window in Korean', async () => {
    test.setTimeout(90_000)
    if (EVIDENCE_DIR) await mkdir(EVIDENCE_DIR, { recursive: true })
    const launched = await launchShell({
      onboardingSeen: true,
      lang: 'ko',
      videoDir: 'pdf-tools-window-ko',
    })
    try {
      const tools = await openToolsWindow(launched.app, launched.page, /PDF 도구/)
      await expect(
        tools.getByText('이 도구들은 이 PC 안에서만 처리하며 AI를 쓰지 않습니다.'),
      ).toBeVisible()
      await tools.screenshot({ path: shot('pdf-tools-home-ko') })
    } finally {
      await closeAndSaveVideo(launched, 'pdf-tools-window-ko')
    }
  })
})
