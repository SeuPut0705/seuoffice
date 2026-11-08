import { afterEach, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildExtensions } from '../../src/renderer/editor/extensions'
import { parseDocText, stripLegacyFencedDivs } from '../../src/renderer/markdown/docText'
import {
  captureMarkdownSource,
  serializeMarkdown,
} from '../../src/renderer/markdown/roundtripSerializer'

/**
 * Opens Markdown the way the editor loads a file and saves it back through the
 * round-trip serializer. Registers its cleanup in the calling test file.
 */
export function useRoundTripEditor() {
  const editors: Editor[] = []
  afterEach(() => {
    editors.splice(0).forEach((editor) => editor.destroy())
    localStorage.clear()
  })

  const open = (source: string) => {
    const editor = new Editor({
      extensions: buildExtensions({
        slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
        slashItems: () => [],
      }),
      content: '',
    })
    editors.push(editor)
    const envelope = parseDocText(source)
    editor
      .chain()
      .setMeta('addToHistory', false)
      .setContent(stripLegacyFencedDivs(envelope.body), { contentType: 'markdown' })
      .run()
    const original = captureMarkdownSource(source, envelope, editor.state.doc)
    const body = vi.fn(() => editor.getMarkdown())
    const save = () => serializeMarkdown(envelope, editor.state.doc, body, original)
    return { editor, envelope, original, body, save }
  }
  return open
}
