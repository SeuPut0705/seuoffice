/** The co-editing recovery paths (collab.ts `recoveryTests`) on a DOCX in the docs editor */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocx } from '@genoffice/docx-engine'
import { expect, test } from '@playwright/test'
import { countOwnEdits, edited, openCoEdited, recoveryTests, type CoEditor } from './collab'

const repo = fileURLToPath(new URL('../../..', import.meta.url))

// the fixture's two paragraphs: "first paragraph." / "second paragraph."
const FIRST = '\u7b2c\u4e00\u6bb5\u3002'
const SECOND = '\u7b2c\u4e8c\u6bb5\u3002'

test.setTimeout(240_000)

/** The caret at the end of the paragraph of `place`: the first for one person, the second for the other */
async function caretAt(editor: CoEditor, place: number): Promise<void> {
  const anchor = place < 10 ? FIRST : SECOND
  await editor.frame.locator('.ProseMirror').first().getByText(anchor).first().click()
  await editor.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
}

recoveryTests({
  label: 'docx',
  file: async () => ({
    name: 'simple.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: readFileSync(resolve(repo, 'fixtures/generated/simple.docx')),
  }),
  async open(browser, file, documentId, user) {
    const editor = await openCoEdited(browser, file, { documentId, user })
    await countOwnEdits(editor)
    return editor
  },
  async write(editor, place, text) {
    await caretAt(editor, place)
    await expect(editor.frame.locator('.ProseMirror').first()).toBeFocused()
    await edited(editor, () => editor.page.keyboard.type(` ${text}`, { delay: 20 }))
    await expect.poll(() => editor.text()).toContain(text)
  },
  async tryWrite(editor, place, text) {
    await caretAt(editor, place)
    await editor.page.keyboard.type(` ${text}`, { delay: 20 })
  },
  async textOf(bytes) {
    const parsed = await parseDocx(bytes)
    return parsed.blocks
      .map((block) => (block.runs ?? []).map((run) => run.text).join(''))
      .join('\n')
  },
})
