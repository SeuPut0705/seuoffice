import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { parseDocx } from '@seuoffice/docx-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { executeTool } from '../src/renderer/ai/tools'
import {
  anchorsDocx,
  anchorsFor,
  HIDDEN_WORDS,
} from '../../../packages/docx-engine/tests/helpers/hidden-anchors'
import { PLACEHOLDER, SECRET } from '../../../packages/docx-engine/tests/helpers/hidden-stories'

/**
 * A phrase an op looks for must not tell the model anything about the words a
 * person hid from AI: neither by quoting them (an error that echoes the block)
 * nor by answering differently when a guess is right (a search that finds them).
 *
 * What a model can anchor on: the words it is shown. A hidden run is shown as
 * its placeholder, which is no text of the document: an anchor that reaches
 * into the run, the placeholder included, is answered as a phrase that is not
 * there, and the model anchors on the plain words beside it ("Call ").
 */

const editors = new Set<Editor>()
afterEach(() => {
  for (const editor of editors) editor.destroy()
  editors.clear()
})

async function open(literal: boolean) {
  const parsed = await parseDocx(await anchorsDocx(literal))
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks),
  })
  editors.add(editor)
  return editor
}

const NUM_IDS = { bullet: null, ordered: null }
const notes = { list: () => [], add: () => '1', remove: () => false, replace: () => false }
const comments = {
  list: () => [],
  reply: () => false,
  resolve: () => false,
  add: () => '9',
}

interface Answer {
  isError: boolean
  /** the output with the quoted anchor the model sent taken out: what is left is the tool's own words */
  output: string
  changed: boolean
}

async function call(
  literal: boolean,
  name: string,
  input: Record<string, unknown>,
  anchor: string,
): Promise<Answer> {
  const editor = await open(literal)
  const before = JSON.stringify(editor.state.doc.toJSON())
  const result = await executeTool(
    editor,
    { id: 'x', name, input },
    NUM_IDS,
    undefined,
    undefined,
    undefined,
    comments as never,
    undefined,
    undefined,
    undefined,
    undefined,
    notes as never,
  )
  return {
    isError: result.isError === true,
    output: result.output.replace(`"${anchor}"`, '"<anchor>"'),
    changed: JSON.stringify(editor.state.doc.toJSON()) !== before,
  }
}

const ops = (...list: unknown[]) => ({ ops: list })
const OPS: Record<string, (anchor: string) => [string, Record<string, unknown>]> = {
  'insertField afterText': (afterText) => [
    'apply_ops',
    ops({ op: 'insertField', target: { blockIndexes: [0] }, type: 'PAGE', afterText }),
  ],
  'insert_footnote afterText': (afterText) => [
    'insert_footnote',
    { blockIndex: 0, afterText, text: 'note' },
  ],
  'insert_endnote afterText': (afterText) => [
    'insert_endnote',
    { blockIndex: 0, afterText, text: 'note' },
  ],
  'add_comment text': (text) => ['add_comment', { blockIndex: 0, text, comment: 'c' }],
  findReplace: (find) => ['apply_ops', ops({ op: 'findReplace', find, replace: 'X' })],
  'findReplace in a block': (find) => [
    'apply_ops',
    ops({ op: 'findReplace', find, replace: 'X', target: { blockIndexes: [0, 1] } }),
  ],
  'setMatchedFont text': (text) => ['apply_ops', ops({ op: 'setMatchedFont', text, bold: true })],
}

describe.each([false, true])(
  'anchors in a document whose hidden words are literal: %s',
  (literal) => {
    const anchors = anchorsFor(literal)
    const miss = anchors['a phrase that is not there']!

    describe.each(Object.keys(OPS))('%s', (opName) => {
      it.each(Object.entries(anchors))(
        'answers an anchor on %s as a phrase that is not there',
        async (_what, anchor) => {
          const answer = await call(literal, ...OPS[opName]!(anchor), anchor)
          const reference = await call(literal, ...OPS[opName]!(miss), miss)
          // the same answer, the same words, and nothing changed
          expect(answer).toEqual(reference)
          expect(answer.changed).toBe(false)
        },
      )

      it('never quotes the hidden words', async () => {
        for (const anchor of Object.values(anchors)) {
          const { output } = await call(literal, ...OPS[opName]!(anchor), anchor)
          expect(output).not.toContain(SECRET)
          expect(output).not.toContain(SECRET.slice(0, 5))
          expect(output).not.toContain(SECRET.slice(-5))
        }
      })
    })

    it('still anchors on the plain words beside a hidden run', async () => {
      for (const [name, anchor] of [
        ['insertField afterText', 'Call '],
        ['insert_footnote afterText', 'Call '],
        ['add_comment text', 'Call'],
        ['findReplace', 'now'],
      ] as const) {
        const answer = await call(literal, ...OPS[name]!(anchor), anchor)
        expect(answer.isError, name).toBe(false)
        // (a footnote and a comment are the app's to store, not the document's)
        expect(
          answer.changed || name === 'insert_footnote afterText' || name === 'add_comment text',
          name,
        ).toBe(true)
      }
    })
  },
)

describe('an anchor that lands in the plain words puts nothing inside the hidden run', () => {
  it('a field right after "Call " sits outside the mark', async () => {
    const editor = await open(false)
    await executeTool(
      editor,
      {
        id: 'x',
        name: 'apply_ops',
        input: ops({
          op: 'insertField',
          target: { blockIndexes: [0] },
          type: 'PAGE',
          afterText: 'Call ',
        }),
      },
      NUM_IDS,
    )
    const json = editor.state.doc.toJSON()
    const runs = json.content[0].content as Array<{
      text?: string
      marks?: Array<{ type: string }>
    }>
    const hidden = runs.filter((r) => r.marks?.some((m) => m.type === 'redaction'))
    expect(hidden.map((r) => r.text)).toEqual([SECRET])
    expect(
      runs.filter((r) => r.marks?.some((m) => m.type === 'instrField')).length,
    ).toBeGreaterThan(0)
  })
})

describe('a search that selects blocks reads what the model reads', () => {
  it.each(Object.entries(anchorsFor(false)))('containsText on %s', async (what, anchor) => {
    const miss = await call(
      false,
      'apply_ops',
      ops({ op: 'setFont', target: { containsText: 'zzzz' }, bold: true }),
      'zzzz',
    )
    const answer = await call(
      false,
      'apply_ops',
      ops({ op: 'setFont', target: { containsText: anchor }, bold: true }),
      anchor,
    )
    expect(answer).toEqual(miss)
    void what
  })

  it('the placeholder the model is shown selects the block that holds it', async () => {
    const answer = await call(
      false,
      'apply_ops',
      ops({ op: 'setFont', target: { containsText: PLACEHOLDER }, bold: true }),
      PLACEHOLDER,
    )
    expect(answer.isError).toBe(false)
    expect(answer.changed).toBe(true)
  })
})

describe('words copied out of a hidden paragraph', () => {
  it.each([false, true])(
    'a table of contents is refused when a heading holds hidden words (literal: %s)',
    async (literal) => {
      const answer = await call(
        literal,
        'apply_ops',
        ops({ op: 'insertToc', afterBlockIndex: -1 }),
        HIDDEN_WORDS(literal),
      )
      expect(answer.isError).toBe(true)
      expect(answer.changed).toBe(false)
      expect(answer.output).not.toContain(SECRET)
    },
  )

  it.each([false, true])(
    'a cross-reference to a hidden paragraph is refused (literal: %s)',
    async (literal) => {
      const answer = await call(
        literal,
        'apply_ops',
        ops({ op: 'insertField', target: { blockIndexes: [4] }, type: 'REF', args: 'Secret \\h' }),
        HIDDEN_WORDS(literal),
      )
      expect(answer.isError).toBe(true)
      expect(answer.changed).toBe(false)
      expect(answer.output).not.toContain(SECRET)
    },
  )

  it('a cross-reference to a plain paragraph still works', async () => {
    const answer = await call(
      false,
      'apply_ops',
      ops({ op: 'insertField', target: { blockIndexes: [0] }, type: 'REF', args: 'Open \\h' }),
      'zzzz',
    )
    expect(answer.isError).toBe(false)
    expect(answer.changed).toBe(true)
  })
})
