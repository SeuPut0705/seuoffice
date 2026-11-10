/**
 * The co-editing recovery paths (collab.ts `recoveryTests`) on a PPTX in the slides editor.
 * Text goes into the speaker notes: one person writes the first slide's, the other the
 * second's (a slide's notes are one value: the later writer would win). Leaving the slide
 * commits the notes, as collab-slides.spec.ts does.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSlideNotes, openPptx, type SlideElement } from '@genoffice/pptx-engine'
import { expect, test, type Locator } from '@playwright/test'
import { countOwnEdits, edited, openCoEdited, recoveryTests, type CoEditor } from './collab'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const FIXTURE = resolve(repo, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx')

test.setTimeout(240_000)

const thumbs = (editor: CoEditor): Locator => editor.frame.locator('.thumb')
const notesBox = (editor: CoEditor): Locator => editor.frame.locator('.notes-pane textarea')

async function showSlide(editor: CoEditor, index: number, timeout?: number): Promise<void> {
  await thumbs(editor).nth(index).click({ timeout })
  await expect(thumbs(editor).nth(index)).toHaveClass(/active/, { timeout })
}

/** Type ` text` at the end of the notes of this place's slide; the returned slide index commits it */
async function typeNotes(
  editor: CoEditor,
  place: number,
  text: string,
  timeout?: number,
): Promise<number> {
  const slide = place < 10 ? 0 : 1
  await showSlide(editor, slide, timeout)
  await notesBox(editor).click({ timeout })
  await expect(notesBox(editor)).toBeFocused({ timeout })
  await notesBox(editor).evaluate((box: HTMLTextAreaElement) =>
    box.setSelectionRange(box.value.length, box.value.length),
  )
  await editor.page.keyboard.type(` ${text}`)
  return 1 - slide
}

/** Every text box's text and every slide's notes of a pptx file */
async function deckText(bytes: Uint8Array): Promise<string> {
  const opened = await openPptx(bytes)
  const texts = (elements: SlideElement[]): string[] =>
    elements.flatMap((el) =>
      el.type === 'group'
        ? texts(el.children)
        : 'text' in el && el.text
          ? [el.text.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n')]
          : [],
    )
  return opened.deck.slides
    .flatMap((slide) => [...texts(slide.elements), getSlideNotes(opened.archive, slide.path)])
    .join('\n')
}

recoveryTests({
  label: 'pptx',
  file: async () => ({
    name: '01_standard_business.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer: readFileSync(FIXTURE),
  }),
  async open(browser, file, documentId, user) {
    const editor = await openCoEdited(browser, file, { documentId, user, ready: 'canvas' })
    await expect(thumbs(editor).first()).toBeVisible({ timeout: 20_000 })
    await countOwnEdits(editor)
    return editor
  },
  async write(editor, place, text) {
    const leaveTo = await typeNotes(editor, place, text)
    await expect(notesBox(editor)).toHaveValue(new RegExp(`${text}$`))
    await edited(editor, () => showSlide(editor, leaveTo))
  },
  async tryWrite(editor, place, text) {
    const leaveTo = await typeNotes(editor, place, text, 3_000)
    await showSlide(editor, leaveTo, 3_000)
  },
  textOf: deckText,
})
