import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { parseDocx, type CommentInfo, type HeaderFooter } from '@seuoffice/docx-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { buildDocumentContext, type AiHfState } from '../src/renderer/ai/protocol'
import { hfModelTableText } from '../src/renderer/editor/hf-text'
import { collectNoteRevisions, resolveNotes } from '../src/renderer/editor/story-revisions'
import { editComment, type ReviewContext } from '../src/renderer/review-actions'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import {
  LABEL,
  OWN_REDACT_NS,
  PLACEHOLDER,
  SECRET,
} from '../../../packages/docx-engine/tests/helpers/hidden-stories'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const hidden = (text: string) =>
  `<w:r><w:rPr><go:redact xmlns:go="${OWN_REDACT_NS}" w:label="${LABEL}"/></w:rPr><w:t>${text}</w:t></w:r>`
const plain = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
const REV = ' w:id="9" w:author="Ann" w:date="2026-09-29T12:23:00Z"'

const editors = new Set<Editor>()
afterEach(() => {
  for (const editor of editors) editor.destroy()
  editors.clear()
})

describe('a header layout table hidden from AI', () => {
  it('reaches the AI context with each hidden cell run as its placeholder', async () => {
    const parsed = await parseDocx(
      await buildDocx({
        bodyXml: `<w:p>${plain('Body')}</w:p>`,
        headerXml:
          `<w:p>${plain('Title')}</w:p>` +
          '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
          `<w:tr><w:tc><w:p>${plain('Left')}</w:p></w:tc><w:tc><w:p>${plain('Call ')}${hidden(SECRET)}</w:p></w:tc></w:tr></w:tbl>` +
          `<w:p>${plain('')}</w:p>`,
      }),
    )
    const header: HeaderFooter = { text: parsed.headerText ?? '', paras: parsed.headerParas! }
    expect(hfModelTableText(header)).toBe(`Left | Call ${PLACEHOLDER}`)

    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks),
    })
    editors.add(editor)
    const hf: AiHfState = {
      header: 'Title',
      footer: '',
      headerFirst: null,
      footerFirst: null,
      headerEven: null,
      footerEven: null,
      titlePg: false,
      evenOddHf: false,
      multiSection: false,
      tables: { header: hfModelTableText(header) },
    }
    const context = buildDocumentContext(editor, undefined, hf)
    expect(context).toContain(`Left | Call ${PLACEHOLDER}`)
    expect(context).not.toContain(SECRET)
  })
})

describe('what a model reads of a comment or note follows the person’s change at once', () => {
  it('a comment the person edits', async () => {
    const parsed = await parseDocx(
      await buildDocx({
        bodyXml:
          '<w:p><w:commentRangeStart w:id="1"/>' +
          plain('Body') +
          '<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>',
        extraParts: [
          {
            path: 'word/comments.xml',
            xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}><w:comment w:id="1" w:author="Kim"><w:p>${plain('Note: ')}${hidden(SECRET)}</w:p></w:comment></w:comments>`,
            contentType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
          },
        ],
      }),
    )
    let comments: CommentInfo[] = parsed.comments
    const ctx = {
      setComments: (next: CommentInfo[] | ((prev: CommentInfo[]) => CommentInfo[])) => {
        comments = typeof next === 'function' ? next(comments) : next
      },
      setCommentsDirty: () => {},
      dirtyRef: { current: false },
      setStatus: () => {},
    } as unknown as ReviewContext
    expect(comments[0]!.modelText).toBe(`Note: ${PLACEHOLDER}`)

    editComment(ctx, '1', `Call: ${SECRET}`)
    expect(comments[0]!.text).toBe(`Call: ${SECRET}`)
    expect(comments[0]!.modelText).toBe(`Call: ${PLACEHOLDER}`)

    // a second paragraph: the save writes the comment anew, without the mark
    editComment(ctx, '1', `Call: ${SECRET}\nthanks`)
    expect(comments[0]!.modelText).toBeUndefined()
  })

  it('a note whose tracked insertion the person rejects', async () => {
    const parsed = await parseDocx(
      await buildDocx({
        bodyXml: `<w:p>${plain('Body')}<w:r><w:footnoteReference w:id="2"/></w:r></w:p>`,
        extraRels:
          '<Relationship Id="rIdFn" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>',
        extraParts: [
          {
            path: 'word/footnotes.xml',
            xml:
              `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W}>` +
              '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
              '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
              `<w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r>${plain(' See ')}${hidden(SECRET)}` +
              `<w:ins${REV}>${plain(' added')}</w:ins></w:p></w:footnote></w:footnotes>`,
            contentType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
          },
        ],
      }),
    )
    expect(parsed.footnotes[0]!.modelText).toBe(`See ${PLACEHOLDER} added`)
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks),
    })
    editors.add(editor)
    const ins = collectNoteRevisions(editor.state.doc, 'footnote', parsed.footnotes).find(
      (r) => r.kind === 'ins',
    )!
    const [rejected] = resolveNotes(parsed.footnotes, [ins.story], 'reject')
    expect(rejected!.text).toBe(`See ${SECRET}`)
    expect(rejected!.modelText).toBe(`See ${PLACEHOLDER}`)
  })
})
