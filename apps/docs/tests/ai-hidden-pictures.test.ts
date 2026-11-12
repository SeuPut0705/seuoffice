import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { parseDocx, type CommentInfo, type HeaderFooter } from '@seuoffice/docx-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { buildCommentsContext, buildDocumentContext } from '../src/renderer/ai/protocol'
import { buildNotesContext } from '../src/renderer/ai/note-ops'
import { executeTool } from '../src/renderer/ai/tools'
import { createDocsSkill } from '../src/renderer/ai/docs-skill'
import { hfModelText } from '../src/renderer/editor/hf-text'
import { collectNoteRevisions, resolveNotes } from '../src/renderer/editor/story-revisions'
import { editComment, type ReviewContext } from '../src/renderer/review-actions'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { modelTextOf } from '../src/renderer/ai/redact-view'
import {
  hiddenPictureBase64,
  hiddenStoriesDocx,
  mutatedStoriesDocx,
  LABEL,
  OWN_REDACT_NS,
  PICTURE_STORIES,
  PLACEHOLDER,
  PLAIN_PICTURE_BASE64,
  SECRET,
  TAG_MUTATION_NAMES,
  type StoriesOptions,
  type TagMutation,
} from '../../../packages/docx-engine/tests/helpers/hidden-stories'

const editors = new Set<Editor>()
afterEach(() => {
  for (const editor of editors) editor.destroy()
  editors.clear()
})

const analyzed: string[][] = []
beforeEach(() => {
  analyzed.length = 0
  ;(window as unknown as { desktop: unknown }).desktop = {
    analyzeMedia: async (args: { mediaUrls: string[] }) => {
      analyzed.push(args.mediaUrls)
      return { text: 'a picture' }
    },
  }
})

const NUM_IDS = { bullet: null, ordered: null }

/** the slice of a picture's bytes that tells it from the others, in whatever way it is carried */
function expectNothingOfHiddenPictures(output: string) {
  expect(output).not.toContain(SECRET)
  for (const story of PICTURE_STORIES) {
    expect(output).not.toContain(hiddenPictureBase64(story).slice(30, 70))
  }
}

const VARIANTS: Array<{ name: string; options: StoriesOptions }> = [
  { name: 'words hidden', options: { pictures: true } },
  { name: 'words that read like their placeholder', options: { pictures: true, literal: true } },
]

async function open(mutation: TagMutation | 'none', options: StoriesOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-pictures-'))
  const file =
    mutation === 'none'
      ? await hiddenStoriesDocx(dir, OWN_REDACT_NS, 'pictures.docx', 'go', options)
      : await mutatedStoriesDocx(dir, mutation, options)
  const parsed = await parseDocx(new Uint8Array(readFileSync(file)))
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks),
  })
  editors.add(editor)
  return { parsed, editor }
}

/**
 * The hidden-stories document with a picture in a hidden run in every story:
 * whatever the app's AI readers make of the tags, no hidden picture, its
 * description, title or name reaches the model.
 */
describe.each(VARIANTS)('pictures in hidden runs ($name)', ({ options }) => {
  describe.each(['none', ...TAG_MUTATION_NAMES] as const)('tags: %s', (mutation) => {
    it("the app's AI readers hand over no hidden picture", async () => {
      const { parsed, editor } = await open(mutation, options)
      const hf = (paras: HeaderFooter['paras'], text: string | null | undefined) =>
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
      for (const output of outputs) expectNothingOfHiddenPictures(output)
    })

    it('the model tools hand over no hidden picture', async () => {
      const { parsed, editor } = await open(mutation, options)
      const last = editor.state.doc.childCount - 1
      const read = async (name: string, input: Record<string, unknown> = {}) =>
        (
          await executeTool(
            editor,
            { id: name, name, input },
            NUM_IDS,
            undefined,
            undefined,
            undefined,
            {
              list: () => parsed.comments,
              reply: () => false,
              resolve: () => false,
            },
          )
        ).output
      const outputs = [
        await read('get_document_context'),
        await read('read_blocks', { startBlockIndex: 0, endBlockIndex: last }),
        await read('read_comments'),
      ]
      for (const output of outputs) expectNothingOfHiddenPictures(output)

      // every block of the document offered to the media analysis
      for (let index = 0; index <= last; index++) {
        const analysis = await executeTool(
          editor,
          {
            id: 'a',
            name: 'analyze_media',
            input: { blockIndex: index, requirements: 'describe' },
          },
          NUM_IDS,
        )
        expectNothingOfHiddenPictures(analysis.output)
      }
      expectNothingOfHiddenPictures(analyzed.flat().join('\n'))
    })
  })

  it('a plain picture is still handed to the media analysis', async () => {
    const { editor } = await open('none', options)
    const handed: string[] = []
    for (let index = 0; index < editor.state.doc.childCount; index++) {
      await executeTool(
        editor,
        { id: 'a', name: 'analyze_media', input: { blockIndex: index, requirements: 'describe' } },
        NUM_IDS,
      )
    }
    handed.push(...analyzed.flat())
    expect(handed.some((url) => url.includes(PLAIN_PICTURE_BASE64.slice(30, 70)))).toBe(true)
  })
})

/**
 * A hidden run whose words are the placeholder reads, to a model, as the entry
 * says: what a reader withholds, refuses or keeps follows the mark, never the
 * difference between the words and what a model reads.
 */
describe('a hidden run whose words are the placeholder', () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  const hidden = `<w:r><w:rPr><go:redact xmlns:go="${OWN_REDACT_NS}" w:label="${LABEL}"/></w:rPr><w:t>${PLACEHOLDER}</w:t></w:r>`
  const plain = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`

  it('a note refuses an AI edit whatever it looks for', async () => {
    const { parsed, editor } = await open('none', { literal: true })
    const replaced: string[] = []
    const outputs: string[] = []
    for (const find of ['See', 'client', 'absent']) {
      const done = await executeTool(
        editor,
        { id: 'e', name: 'edit_note', input: { id: '1', kind: 'footnote', find, replace: 'x' } },
        NUM_IDS,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          list: (kind) => (kind === 'footnote' ? parsed.footnotes : parsed.endnotes),
          add: () => '',
          remove: () => false,
          replace: (_kind, id) => (replaced.push(id), true),
        },
      )
      expect(done.isError).toBe(true)
      outputs.push(done.output)
    }
    expect(replaced).toEqual([])
    expect(new Set(outputs).size).toBe(1)
  })

  it('a comment the person edits keeps a model text', async () => {
    const parsed = await parseDocx(
      await buildDocx({
        bodyXml:
          '<w:p><w:commentRangeStart w:id="1"/>' +
          plain('Body') +
          '<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>',
        extraParts: [
          {
            path: 'word/comments.xml',
            xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}><w:comment w:id="1" w:author="Kim"><w:p>${plain('Note: ')}${hidden}</w:p></w:comment></w:comments>`,
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
    editComment(ctx, '1', `Call: ${PLACEHOLDER}`)
    expect(comments[0]!.modelText).toBe(`Call: ${PLACEHOLDER}`)
  })

  it('a note whose tracked insertion the person rejects keeps a model text', async () => {
    const REV = ' w:id="9" w:author="Ann" w:date="2026-09-29T12:23:00Z"'
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
              `<w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r>${plain(' See ')}${hidden}` +
              `<w:ins${REV}>${plain(' added')}</w:ins></w:p></w:footnote></w:footnotes>`,
            contentType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
          },
        ],
      }),
    )
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
    expect(rejected!.text).toBe(`See ${PLACEHOLDER}`)
    expect(rejected!.modelText).toBe(`See ${PLACEHOLDER}`)
  })
})

/**
 * The instruction that explains the placeholders is given when the document
 * withholds something: a picture block, a comment or a note counts as much as a
 * span of the body.
 */
describe('the instruction about placeholders', () => {
  const skillFor = (editor: Editor, parsed?: Awaited<ReturnType<typeof open>>['parsed']) =>
    createDocsSkill(
      () => editor,
      () => NUM_IDS,
      parsed
        ? () => ({ list: () => parsed.comments, reply: () => false, resolve: () => false })
        : undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      parsed
        ? () => ({
            list: (kind) => (kind === 'footnote' ? parsed.footnotes : parsed.endnotes),
            add: () => '',
            remove: () => false,
            replace: () => false,
          })
        : undefined,
    ).systemPrompt

  it('is given for a document whose only hidden content is a picture block', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: {
        type: 'doc',
        content: [
          {
            type: 'docProtected',
            attrs: { blockType: 'image', label: 'Image', redact: 'id card' },
          },
        ],
      },
    })
    editors.add(editor)
    expect(skillFor(editor)).toContain('{{id card}}')
  })

  it('is given for a document whose only hidden content is in a comment or a note', async () => {
    const { parsed } = await open('none', { literal: true })
    const bare = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc([
        { id: 'b0', docxIndex: 0, originalXml: '', type: 'paragraph', runs: [{ text: 'Plain' }] },
      ] as never),
    })
    editors.add(bare)
    expect(skillFor(bare)).not.toContain(PLACEHOLDER)
    expect(skillFor(bare, parsed)).toContain(PLACEHOLDER)
  })
})
