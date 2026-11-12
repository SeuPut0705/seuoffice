import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import {
  BLANK_BULLET_NUM_ID,
  BLANK_ORDERED_NUM_ID,
  buildBlankDocx,
  parseDocx,
  saveDocx,
} from '@seuoffice/docx-engine'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { collectRevisions } from '../src/renderer/editor/revisions'
import { executeTool } from '../src/renderer/ai/tools'
import { createDocsSkill } from '../src/renderer/ai/docs-skill'

/** AI edits are always tracked revisions; only a person can accept or reject them. */

const NUM_IDS = { bullet: BLANK_BULLET_NUM_ID, ordered: BLANK_ORDERED_NUM_ID }

async function createEditor() {
  const { editorExtensions } = await import('../src/renderer/editor/extensions')
  const parsed = await parseDocx(await buildBlankDocx())
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
  })
  editor.commands.setContent(blocksToPmDoc(parsed.blocks) as never)
  await executeTool(
    editor,
    {
      id: 'seed',
      name: 'insert_content',
      input: { html: '<p>Original first paragraph.</p><p>Original second paragraph.</p>' },
    },
    NUM_IDS,
  )
  return { editor, parsed }
}

const skillOf = (editor: Editor) =>
  createDocsSkill(
    () => editor,
    () => NUM_IDS,
  )

const replaceCall = {
  id: 't',
  name: 'replace_blocks',
  input: { startBlockIndex: 0, endBlockIndex: 0, html: '<p>Rewritten first paragraph.</p>' },
}

describe('AI edits are always tracked', () => {
  it('records a tracked revision by "AI Assistant" while the user toggle is off', async () => {
    const { editor, parsed } = await createEditor()
    expect(editor.storage.trackChanges.enabled).toBe(false)
    const skill = skillOf(editor)
    skill.buildContext?.()
    const exec = await skill.executeTool(replaceCall)
    expect(exec.isError).toBeFalsy()

    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    const saved = await saveDocx(parsed, plan.saveBlocks)
    const xml = (await parseDocx(saved)).internal.documentXml
    expect(xml).toMatch(/<w:ins w:id="\d+" w:author="AI Assistant"/)
    expect(xml).toMatch(/<w:del w:id="\d+" w:author="AI Assistant"/)

    expect(editor.storage.trackChanges.enabled).toBe(false)
    const before = collectRevisions(editor.state.doc).length
    editor.commands.insertContent('typed by a person')
    expect(collectRevisions(editor.state.doc)).toHaveLength(before)
    editor.destroy()
  })

  it('never offers accept_changes / reject_changes and refuses them without touching the document', async () => {
    const { editor } = await createEditor()
    const skill = skillOf(editor)
    skill.buildContext?.()
    await skill.executeTool(replaceCall)
    const pending = collectRevisions(editor.state.doc).length
    expect(pending).toBeGreaterThan(0)

    const names = skill.tools.map((t) => t.name)
    expect(names).not.toContain('accept_changes')
    expect(names).not.toContain('reject_changes')

    const before = JSON.stringify(editor.getJSON())
    for (const name of ['accept_changes', 'reject_changes']) {
      const exec = await skill.executeTool({ id: name, name, input: { all: true } })
      expect(exec.isError).toBe(true)
    }
    expect(JSON.stringify(editor.getJSON())).toBe(before)
    expect(collectRevisions(editor.state.doc)).toHaveLength(pending)
    editor.destroy()
  })
})
