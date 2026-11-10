/**
 * The co-editing recovery paths (collab.ts `recoveryTests`) on a PDF in the pdf editor. Text
 * goes into note comments on the first page, each place at its own spot, made the way
 * collab-pdf.spec.ts makes one: the Comment tab's note tool, a click on the page, the draft
 * box, its confirm button.
 */
import { expect, test, type Locator } from '@playwright/test'
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { countOwnEdits, edited, openCoEdited, recoveryTests, type CoEditor } from './collab'

test.setTimeout(240_000)

/** One A4 page with a line of text */
async function onePagePdf(): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([595, 842]).drawText('Notes go on this page.', { x: 72, y: 780, size: 18, font })
  return { name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) }
}

const firstPage = (editor: CoEditor): Locator => editor.frame.locator('.pdf-page[data-page="0"]')

/** Open a note draft at the spot of `place`: four across, five down, below the page's text line */
async function draftAt(editor: CoEditor, place: number, timeout?: number): Promise<Locator> {
  const tab = editor.frame.locator('.ribbon-tab', { hasText: '주석' }).first()
  if (!(await tab.evaluate((element) => element.classList.contains('active'))))
    await tab.click({ timeout })
  await firstPage(editor).evaluate((element) => element.scrollIntoView({ block: 'start' }))
  const layer = firstPage(editor).locator('.pdf-draw-layer')
  await expect(layer).toBeVisible({ timeout })
  // the tool button toggles: press it only when the note tool is not on already
  const tool = editor.frame.getByRole('button', { name: '메모', exact: true })
  if (!(await tool.evaluate((element) => element.classList.contains('active'))))
    await tool.click({ timeout })
  const box = (await layer.boundingBox())!
  await editor.page.mouse.click(
    box.x + box.width * (0.15 + (place % 4) * 0.2),
    box.y + box.height * (0.25 + Math.floor((place % 20) / 4) * 0.12),
  )
  return editor.frame.locator('.pdf-note-draft-box textarea')
}

/** The contents of every note comment of a file, page after page */
async function notesOf(bytes: Uint8Array): Promise<string> {
  const pdf = await PDFDocument.load(bytes)
  return pdf
    .getPages()
    .flatMap((page) => page.node.Annots()?.asArray() ?? [])
    .map((ref) => pdf.context.lookup(ref, PDFDict))
    .filter((annot) => String(annot.get(PDFName.of('Subtype'))) === '/Text')
    .map((annot) => {
      const contents = annot.get(PDFName.of('Contents'))
      return contents instanceof PDFString || contents instanceof PDFHexString
        ? contents.decodeText()
        : String(contents)
    })
    .join('\n')
}

recoveryTests({
  label: 'pdf',
  file: onePagePdf,
  async open(browser, file, documentId, user) {
    const editor = await openCoEdited(browser, file, { documentId, user, ready: 'canvas' })
    await expect(editor.frame.locator('.pdf-page').first()).toBeVisible({ timeout: 20_000 })
    await countOwnEdits(editor)
    return editor
  },
  async write(editor, place, text) {
    const draft = await draftAt(editor, place)
    await draft.fill(text)
    await edited(editor, () => editor.frame.locator('.pdf-note-draft-actions .primary').click())
  },
  async tryWrite(editor, place, text) {
    const draft = await draftAt(editor, place, 3_000)
    await draft.fill(text, { timeout: 3_000 })
    await editor.frame.locator('.pdf-note-draft-actions .primary').click({ timeout: 3_000 })
  },
  textOf: notesOf,
})
