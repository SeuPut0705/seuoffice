import { describe, afterEach, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
// by path: this app does not depend on the package that reads files for other
// editors, and the test is only here to hold the two together
import { redactMarkdownSource } from '../../../packages/file-parse/src/markdown-redaction'
import { Redaction } from '../src/renderer/editor/Redaction'
import { SelectiveEscapeMarkdown } from '../src/renderer/editor/markdownEscape'
import { redactJson } from '../src/renderer/editor/redact'

/**
 * A markdown file read as another file's material (attachment, knowledge base,
 * search index) goes through `@genoffice/file-parse`, which cannot import this
 * app and so restates how a withheld span is persisted. This holds the two
 * together: what that reader hands to another conversation is the document this
 * editor hands its own model.
 */

// an EditorView left alive fires a timer against a jsdom that is already gone
const editors = new Set<Editor>()
afterEach(() => {
  for (const e of editors) e.destroy()
  editors.clear()
})

function makeEditor(md = '') {
  const editor = new Editor({ extensions: [StarterKit, SelectiveEscapeMarkdown, Redaction] })
  if (md) editor.commands.setContent(md, { contentType: 'markdown' })
  editors.add(editor)
  return editor
}

function withhold(editor: Editor, needle: string, label: string) {
  let start = -1
  editor.state.doc.descendants((node, pos) => {
    if (start >= 0 || !node.isTextblock) return
    const at = node.textContent.indexOf(needle)
    if (at >= 0) start = pos + 1 + at
  })
  expect(start).toBeGreaterThan(0)
  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, start, start + needle.length),
    ),
  )
  editor.commands.setRedaction(label)
}

/** the saved file as this editor would show it to a model, written back as markdown */
function editorModelView(saved: string): string {
  const view = makeEditor()
  view.commands.setContent(redactJson(makeEditor(saved).getJSON()))
  return view.getMarkdown()
}

const CASES: Array<{ name: string; md: string; hide: Array<[string, string]> }> = [
  {
    name: 'a span inside a sentence',
    md: 'please call 13800138000 confirm the order',
    hide: [['13800138000', 'client phone']],
  },
  {
    name: 'a span next to other marks, in a document with blocks',
    md: '# Title\n\nJane Roe lives at **1 Main St** today\n\n- item one\n- secret item',
    hide: [['1 Main St', 'address']],
  },
  {
    name: 'a whole paragraph',
    md: 'one two three',
    hide: [['one two three', 'all']],
  },
  {
    name: 'words that carry markup characters',
    md: 'the rule is a < b and c > d here',
    hide: [['a < b and c > d', 'rule']],
  },
  {
    name: 'two spans in one paragraph',
    md: 'Jane Roe can be reached at 13800138000 after noon',
    hide: [
      ['Jane Roe', 'client name'],
      ['13800138000', 'client phone'],
    ],
  },
]

describe('a markdown file read as another file’s material matches the editor’s model view', () => {
  for (const { name, md, hide } of CASES) {
    it(name, () => {
      const editor = makeEditor(md)
      for (const [needle, label] of hide) withhold(editor, needle, label)
      const saved = editor.getMarkdown()
      // the file itself keeps the words: that is what makes the read below matter
      for (const [needle] of hide)
        expect(saved).toContain(needle.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
      const read = redactMarkdownSource(saved)
      for (const [needle, label] of hide) {
        expect(read).not.toContain(needle)
        expect(read).toContain(`{{${label}}}`)
      }
      expect(read).toBe(editorModelView(saved))
    })
  }
})

describe('a span that covers formatted text reads the same in both', () => {
  // the hidden range runs across other marks, so the saved span holds markdown
  const FORMATTED: Array<[string, string]> = [
    ['plain **bold part** and *it* tail', 'plain bold part and it tail'],
    ['a [link text](http://x.y/z_q) b', 'a link text b'],
    ['price $5,000 and 2*3 a_b [TODO] x~y end', 'price $5,000 and 2*3 a_b [TODO] x~y end'],
    ['keep ~~struck out~~ here', 'keep struck out here'],
    ['x `inline code` y', 'x inline code y'],
  ]
  for (const [md, hidden] of FORMATTED) {
    it(md, () => {
      const editor = makeEditor(md)
      withhold(editor, hidden, 'k')
      const saved = editor.getMarkdown()
      expect(saved).toContain('data-redaction')
      expect(redactMarkdownSource(saved)).toBe(editorModelView(saved))
    })
  }
})

describe('a closing tag that is not the one the editor closes at', () => {
  const SECRET = '13800138000'
  const O = '<span class="redact-span" data-redaction="" data-label="k">'

  /**
   * In each of these the first raw `</span>` after the opening tag is not where
   * the editor ends the span, so the words after it are still hidden there.
   * The cross-file read may fail, or hide as much; it may not hand them over.
   */
  const EARLY_CLOSE: Array<[string, string]> = [
    ['in a code span', `before ${O} see \`</span>\` then ${SECRET}</span> after`],
    ['behind a backslash', `before ${O} see \\</span> then ${SECRET}</span> after`],
    ['in a comment', `before ${O} see <!-- </span> --> then ${SECRET}</span> after`],
    ['in a link destination', `before ${O} see [x](</span>) then ${SECRET}</span> after`],
    ['after a nested span in an HTML block', `<div>${O} a <span>x</span> ${SECRET}</span></div>`],
    [
      'in an attribute inside an HTML block',
      `<div>${O} a <img alt="</span>"> ${SECRET}</span></div>`,
    ],
    ['inside emphasis that ends later', `before ${O} a *b </span> c* ${SECRET}</span> after`],
    ['inside a link label', `before ${O} [see </span> x](http://u) ${SECRET}</span> after`],
    ['as a tag that is not a plain closing tag', `before ${O} a</span foo> ${SECRET}</span> end`],
    [
      'when the attribute follows a quoted ">" in an HTML block',
      `<div><span title="a>b" data-redaction="" data-label="k">${SECRET}</span></div>`,
    ],
  ]

  for (const [name, md] of EARLY_CLOSE) {
    it(name, () => {
      // the editor does hide the words: that is what makes this input a trap
      expect(editorModelView(md)).not.toContain(SECRET)
      let read: string | null = null
      try {
        read = redactMarkdownSource(md)
      } catch (error) {
        expect(String(error)).toMatch(/redaction/i)
      }
      if (read !== null) expect(read).not.toContain(SECRET)
    })
  }

  it('hides more than the editor, never less, when a paragraph ends inside a span', () => {
    const md = `before ${O}${SECRET}\n\nnext para</span> after`
    expect(editorModelView(md)).not.toContain(SECRET)
    expect(redactMarkdownSource(md)).toBe('before {{k}} after')
  })
})
