import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { parseDocx, saveDocx } from '@seuoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import {
  COVER_PRESETS,
  coverPageRange,
  insertCoverPage,
  removeCoverPage,
} from '../src/renderer/editor/cover-pages'
import { t } from '../src/renderer/i18n/locale'

/**
 * "Remove Current Cover Page" finds a gallery cover by two hidden bookmarks
 * saved in the .docx. A cover inserted by an earlier version carries the
 * bookmark names it was given then.
 */

const TITLE = t('editorCoverTitle')

const editors = new Set<Editor>()
afterEach(() => {
  for (const e of editors) e.destroy()
  editors.clear()
})

async function open(bytes: Uint8Array): Promise<Editor> {
  const parsed = await parseDocx(bytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content: blocksToPmDoc(parsed.blocks).content as PmNode[] },
  })
  editors.add(editor)
  return editor
}

const texts = (editor: Editor) =>
  (editor.getJSON().content ?? []).map(
    (n) => n.content?.map((c) => ('text' in c ? c.text : '')).join('') ?? '',
  )

const olderCover = () =>
  buildDocx({
    bodyXml:
      '<w:p><w:bookmarkStart w:id="1" w:name="_GenOfficeCoverPage"/><w:bookmarkEnd w:id="1"/>' +
      '<w:r><w:t>Old cover title</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Old cover subtitle</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pageBreakBefore/></w:pPr>' +
      '<w:bookmarkStart w:id="2" w:name="_GenOfficeCoverPageEnd"/><w:bookmarkEnd w:id="2"/></w:p>' +
      '<w:p><w:r><w:t>Body</w:t></w:r></w:p>',
  })

describe('a cover page saved by an earlier version', () => {
  it('is recognised and removed exactly, keeping the body', async () => {
    const editor = await open(await olderCover())
    expect(coverPageRange(editor.state.doc)).not.toBeNull()
    expect(removeCoverPage(editor)).toBe(true)
    expect(texts(editor)).toEqual(['Body'])
  })

  it('is replaced, not stacked, when another cover is inserted', async () => {
    const editor = await open(await olderCover())
    insertCoverPage(editor, COVER_PRESETS[0])
    const all = texts(editor)
    expect(all).not.toContain('Old cover title')
    expect(all.filter((t) => t.includes(TITLE))).toHaveLength(1)
    expect(all[all.length - 1]).toBe('Body')
  })
})

describe('a cover page inserted now', () => {
  it('is recognised after a save and reopen', async () => {
    const from = await buildDocx({ bodyXml: '<w:p><w:r><w:t>Body</w:t></w:r></w:p>' })
    const editor = await open(from)
    insertCoverPage(editor, COVER_PRESETS[0])
    const parsed = await parseDocx(from)
    const saved = await saveDocx(
      parsed,
      pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks).saveBlocks,
    )
    const reopened = await open(saved)
    expect(texts(reopened).some((t) => t.includes(TITLE))).toBe(true)
    expect(removeCoverPage(reopened)).toBe(true)
    expect(texts(reopened)).toEqual(['Body'])
  })
})
