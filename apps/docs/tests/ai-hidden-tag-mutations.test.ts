import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { parseDocx, type HeaderFooter } from '@seuoffice/docx-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { buildCommentsContext, buildDocumentContext } from '../src/renderer/ai/protocol'
import { buildNotesContext } from '../src/renderer/ai/note-ops'
import { hfModelText } from '../src/renderer/editor/hf-text'
import { modelTextOf } from '../src/renderer/ai/redact-view'
import {
  mutatedStoriesDocx,
  SECRET,
  TAG_MUTATION_NAMES,
} from '../../../packages/docx-engine/tests/helpers/hidden-stories'

const editors = new Set<Editor>()
afterEach(() => {
  for (const editor of editors) editor.destroy()
  editors.clear()
})

/**
 * The hidden-stories document with its tags written another valid way: the
 * app's AI readers (body, header and footer, comments, notes) hand over no
 * hidden word, whatever the tags look like.
 */
describe.each(TAG_MUTATION_NAMES)('tags rewritten: %s', (mutation) => {
  it("the app's AI readers hand over no hidden word", async () => {
    const file = await mutatedStoriesDocx(mkdtempSync(join(tmpdir(), 'ai-tags-')), mutation)
    const parsed = await parseDocx(new Uint8Array(readFileSync(file)))
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks),
    })
    editors.add(editor)
    const hf = (paras: HeaderFooter['paras'], text: string | undefined) =>
      paras ? hfModelText({ text: text ?? '', paras }) : ''
    const outputs = [
      modelTextOf(editor.state.doc.toJSON()),
      buildDocumentContext(editor),
      hf(parsed.headerParas ?? undefined, parsed.headerText),
      hf(parsed.footerParas ?? undefined, parsed.footerText),
      buildCommentsContext(editor, parsed.comments, true),
      buildNotesContext(editor.state.doc, parsed.footnotes, parsed.endnotes, () => null),
      JSON.stringify(
        parsed.blocks
          .flatMap((b) => b.inlineContentControls ?? [])
          .map((c) => c.modelText ?? c.text),
      ),
    ]
    for (const output of outputs) expect(output).not.toContain(SECRET)
  })
})
