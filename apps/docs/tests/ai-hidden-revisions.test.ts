import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { parseDocx } from '@seuoffice/docx-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { executeTool } from '../src/renderer/ai/tools'
import { listRevisionEntries, validateSelector } from '../src/renderer/ai/revision-ops'
import { buildReviewEntries } from '../src/renderer/editor/revision-filters'
import { collectRevisions } from '../src/renderer/editor/revisions'
import {
  collectHfRevisions,
  collectNoteRevisions,
  collectTextboxRevisions,
  type StoryRevision,
} from '../src/renderer/editor/story-revisions'
import { revisionsDocx } from '../../../packages/docx-engine/tests/helpers/hidden-revisions'
import {
  PLACEHOLDER,
  SECRET,
  TAG_MUTATION_NAMES,
  type TagMutation,
} from '../../../packages/docx-engine/tests/helpers/hidden-stories'

/**
 * A tracked change whose words a person hid from AI is listed to a model with
 * its placeholder, wherever it sits: the body (a run, a moved run, a paragraph
 * mark, a table row, a field result) or any story outside it (header, footer,
 * footnote, endnote, text box). The person's own revision list keeps the real
 * words. No selector matches a revision by its words, so there is no search to
 * answer differently for a guess.
 */

const editors = new Set<Editor>()
afterEach(() => {
  for (const editor of editors) editor.destroy()
  editors.clear()
})

const NUM_IDS = { bullet: null, ordered: null }

async function open(mutation: TagMutation | 'none', literal: boolean) {
  const file = await revisionsDocx(mkdtempSync(join(tmpdir(), 'rev-')), mutation, literal)
  const parsed = await parseDocx(new Uint8Array(readFileSync(file)))
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks),
  })
  editors.add(editor)
  const hfState = {
    sections: [
      {
        settings: {},
        startType: 'nextPage',
        firstBlockIndex: 0,
        lastBlockIndex: 99,
        sectPrXml: '',
        titlePg: false,
        headerRefs: { default: 'rH' },
        footerRefs: { default: 'rF' },
      },
    ],
    edits: {},
    links: {},
    parsed: {
      hfParts: {
        rH: { text: '', hasPageNumber: false, paras: parsed.headerParas },
        rF: { text: '', hasPageNumber: false, paras: parsed.footerParas },
      },
    },
  }
  const stories: StoryRevision[] = [
    ...collectNoteRevisions(editor.state.doc, 'footnote', parsed.footnotes),
    ...collectNoteRevisions(editor.state.doc, 'endnote', parsed.endnotes),
    ...collectHfRevisions(hfState as never),
    ...collectTextboxRevisions(editor.state.doc),
  ]
  return { editor, stories, parsed }
}

const call = (
  editor: Editor,
  stories: StoryRevision[],
  name: string,
  input: Record<string, unknown> = {},
) =>
  executeTool(
    editor,
    { id: 'x', name, input },
    NUM_IDS,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { storyRevisions: { list: () => stories, apply: () => stories.length } } as never,
  ) as { output: string; isError?: boolean }

const MUTATIONS = ['none', ...TAG_MUTATION_NAMES] as const

describe.each([false, true])('read_revisions, hidden words literal: %s', (literal) => {
  describe.each(MUTATIONS)('tags: %s', (mutation) => {
    it('lists every hidden change with its placeholder and never its words', async () => {
      const { editor, stories } = await open(mutation, literal)
      const { output } = call(editor, stories, 'read_revisions')
      expect(output).not.toContain(SECRET)
      const lines = output.split('\n').filter((l) => l.startsWith('- r'))
      // every change of the document is a hidden one. (A text box whose end tags are spelled
      // `</w:p >` is not read by the engine's box reader: its changes are not listed at all.)
      const spacedEndTags = mutation === 'space before > in end tags' || mutation === 'all'
      expect(lines.length).toBe(spacedEndTags ? 20 : 23)
      for (const line of lines) expect(line, line).toContain(PLACEHOLDER)
      for (const story of ['footnote', 'endnote', 'header', 'footer', 'textbox']) {
        if (story === 'textbox' && spacedEndTags) continue
        expect(lines.filter((l) => l.includes(`in ${story} `)).length, story).toBeGreaterThan(0)
      }
    })

    it('accepting or rejecting by id echoes no hidden word', async () => {
      for (const mode of ['accept_changes', 'reject_changes']) {
        const { editor, stories } = await open(mutation, literal)
        const { output } = call(editor, stories, mode, { all: true })
        expect(output).not.toContain(SECRET)
      }
    })
  })
})

describe('the person’s own revision list', () => {
  it('keeps the real words, in the body and in every story', async () => {
    const { editor, stories } = await open('none', false)
    const body = collectRevisions(editor.state.doc)
    const entries = buildReviewEntries(editor.state.doc, [...body, ...stories])
    const outside = entries.filter((e) => e.rev.story)
    expect(outside.length).toBe(13)
    for (const entry of outside) expect(entry.excerpt).toContain(SECRET)
    // the body's excerpt is the person's text too
    expect(entries.filter((e) => !e.rev.story).some((e) => e.excerpt.includes(SECRET))).toBe(true)
    // the model's list of the same changes does not
    const model = listRevisionEntries(editor.state.doc, stories)
    expect(model.some((e) => e.text.includes(SECRET))).toBe(false)
  })
})

describe('no selector finds a change by its words', () => {
  it.each([SECRET, SECRET.slice(0, 4), PLACEHOLDER, 'zzzz'])(
    'a text selector (%s) is not a selector at all',
    (text) => {
      expect(validateSelector({ text })).toEqual(validateSelector({ text: 'zzzz' }))
      expect('error' in validateSelector({ text })).toBe(true)
      expect('error' in validateSelector({ contains: text })).toBe(true)
    },
  )
})
