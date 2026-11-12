import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import {
  docxHoldsHiddenContent,
  parseDocx,
  saveDocx,
  withheldLabelOf,
  type HeaderFooter,
  type TextboxDisplay,
} from '@seuoffice/docx-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { applyRevisions, collectRevisions } from '../src/renderer/editor/revisions'
import {
  collectHfRevisions,
  collectTextboxRevisions,
  resolveHfValue,
  resolveRuns,
  type StoryLocation,
  resolveTextboxes,
} from '../src/renderer/editor/story-revisions'
import { executeTool } from '../src/renderer/ai/tools'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { revisionsDocx } from '../../../packages/docx-engine/tests/helpers/hidden-revisions'
import {
  SECRET,
  TAG_MUTATION_NAMES,
  type TagMutation,
} from '../../../packages/docx-engine/tests/helpers/hidden-stories'

/**
 * Rejecting a formatting change puts the run's old properties back, and the
 * mark that hides the run from AI is not one of them: in the body and in every
 * story outside it, the person's reject and the AI's both leave every hidden
 * run hidden, in the saved file as read again.
 */

const editors = new Set<Editor>()
afterEach(() => {
  for (const editor of editors) editor.destroy()
  editors.clear()
})

const NUM_IDS = { bullet: null, ordered: null }

async function open(mutation: TagMutation | 'none') {
  const file = await revisionsDocx(mkdtempSync(join(tmpdir(), 'rej-')), mutation)
  const parsed = await parseDocx(new Uint8Array(readFileSync(file)))
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks),
  })
  editors.add(editor)
  return { parsed, editor }
}

type Place = 'body' | 'header' | 'footer' | 'textbox'

/** the label every run holding the secret has, per place, in the file as saved */
async function labelsIn(saved: Uint8Array): Promise<Record<Place, Array<string | null>>> {
  const doc = await parseDocx(saved)
  const of = (runs: Array<{ text: string; rawRPr?: string }>) =>
    runs.filter((r) => r.text.includes(SECRET)).map((r) => withheldLabelOf(r.rawRPr))
  return {
    body: doc.blocks.flatMap((b) => of(b.runs ?? [])),
    header: (doc.headerParas ?? []).flatMap((p) => of(p.runs)),
    footer: (doc.footerParas ?? []).flatMap((p) => of(p.runs)),
    textbox: doc.blocks.flatMap((b) =>
      (b.textboxes ?? []).flatMap((box) => box.paras.flatMap((p) => of(p.runs))),
    ),
  }
}

const labelsOf = (labels: Array<string | null>) => labels.every((l) => l === 'client phone')

/**
 * The engine finds a text box's paragraphs by pattern: under these spellings the
 * box is not read back as it was written (a CDATA section holding `</w:p>`, a comment, an
 * end tag spelled `</w:p >`), whatever is done to it, so its labels are not compared.
 */
const BOX_SURVIVES = new Set<string>([
  'none',
  'single quotes',
  'spaces around =',
  '> and /> inside values',
  'fake markup in CDATA',
])

const MUTATIONS = ['none', ...TAG_MUTATION_NAMES.filter((m) => m !== 'namespace prefix')] as const

describe.each(MUTATIONS)('rejecting formatting changes, tags: %s', (mutation) => {
  it("the person's reject keeps every hidden run hidden, in every place", async () => {
    const { parsed, editor } = await open(mutation)
    const before = await labelsIn(
      await saveDocx(
        parsed,
        parsed.blocks
          .filter((b) => !b.hidden)
          .map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex! })),
      ),
    )
    // sanity: the document holds hidden runs in each place. (A text box whose tags the engine's
    // box reader cannot read is not read at all: there is nothing of it to keep or lose.)
    for (const place of ['body', 'header', 'footer'] as const) {
      expect(before[place].length, place).toBeGreaterThan(0)
    }

    const state = {
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
    const formatting = collectHfRevisions(state as never).filter(
      (r) => r.story.type === 'rPrChange',
    )
    const asValue = (kind: 'header' | 'footer'): HeaderFooter => ({
      text: '',
      paras: kind === 'header' ? parsed.headerParas! : parsed.footerParas!,
    })
    const header = resolveHfValue(
      asValue('header'),
      formatting.filter((r) => r.story.kind === 'header').map((r) => r.story),
      'reject',
      false,
    )
    const footer = resolveHfValue(
      asValue('footer'),
      formatting.filter((r) => r.story.kind === 'footer').map((r) => r.story),
      'reject',
      false,
    )

    // the text box, rewritten in the block that holds it
    const boxRevisions = collectTextboxRevisions(editor.state.doc).filter(
      (r) => r.story.type === 'rPrChange',
    )
    const boxes = (parsed.blocks.find((b) => b.textboxes?.length)?.textboxes ??
      []) as TextboxDisplay[]
    let boxPos = -1
    editor.state.doc.descendants((node, pos) => {
      if (boxPos < 0 && node.attrs?.textboxes) boxPos = pos
    })
    if (boxPos >= 0) {
      const resolvedBoxes = resolveTextboxes(
        boxes,
        boxRevisions.map((r) => r.story),
        'reject',
      )
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(boxPos, undefined, {
          ...editor.state.doc.nodeAt(boxPos)!.attrs,
          textboxes: resolvedBoxes,
        }),
      )
    }

    // the body
    applyRevisions(
      editor,
      collectRevisions(editor.state.doc).filter((r) => r.kind === 'rPrChange'),
      'reject',
    )

    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    const saved = await saveDocx(parsed, plan.saveBlocks, { header, footer })
    const after = await labelsIn(saved)
    for (const place of ['body', 'header', 'footer', 'textbox'] as const) {
      if (place === 'textbox' && !BOX_SURVIVES.has(mutation)) continue
      expect(after[place], place).toEqual(before[place])
      expect(labelsOf(after[place]), place).toBe(true)
    }
    expect(await docxHoldsHiddenContent(saved)).toBe(true)
  })

  it("the AI's reject keeps every hidden run hidden: the body, and what it hands the stories to resolve", async () => {
    const { parsed, editor } = await open(mutation)
    const state = {
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
    const stories = [
      ...collectHfRevisions(state as never),
      ...collectTextboxRevisions(editor.state.doc),
    ]
    const handed: string[] = []
    const result = await executeTool(
      editor,
      { id: 'x', name: 'reject_changes', input: { type: 'formatting' } },
      NUM_IDS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        storyRevisions: {
          list: () => stories,
          apply: (targets: Array<{ story: { kind: string; type: string } }>) => {
            for (const t of targets) handed.push(`${t.story.kind}:${t.story.type}`)
            return targets.length
          },
        },
      } as never,
    )
    expect(result.output).not.toContain(SECRET)
    // formatting changes keep their words: the AI may reject them, stories included
    expect(handed.length).toBeGreaterThan(0)
    expect(new Set(handed)).toEqual(
      new Set(
        stories.filter((r) => r.story.type === 'rPrChange').map((r) => `${r.story.kind}:rPrChange`),
      ),
    )

    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    const saved = await saveDocx(parsed, plan.saveBlocks)
    expect(labelsOf((await labelsIn(saved)).body)).toBe(true)
  })
})

/** a run with a pending formatting change, marked hidden from AI afterwards */
describe('a mark added after the formatting change', () => {
  const run = (rPr: string) =>
    `<w:r><w:rPr><w:b/><w:rPrChange w:id="7" w:author="Ann" w:date="2026-09-29T12:23:00Z">${rPr}</w:rPrChange></w:rPr><w:t>${SECRET}</w:t></w:r>`
  const body = (rPr: string) =>
    buildDocx({ bodyXml: `<w:p><w:r><w:t>Call </w:t></w:r>${run(rPr)}</w:p>` })

  const labelOfSaved = async (saved: Uint8Array) =>
    (await parseDocx(saved)).blocks
      .flatMap((b) => b.runs ?? [])
      .filter((r) => r.text.includes(SECRET))
      .map((r) => withheldLabelOf(r.rawRPr))

  async function markThenReject(rPr: string, reject: (editor: Editor) => Promise<void> | void) {
    const parsed = await parseDocx(await body(rPr))
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks),
    })
    editors.add(editor)
    let from = -1
    let to = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text!.includes(SECRET)) {
        from = pos
        to = pos + node.nodeSize
      }
    })
    editor.chain().setTextSelection({ from, to }).setRedaction('client phone').run()
    await reject(editor)
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    return saveDocx(parsed, plan.saveBlocks)
  }

  it.each(['<w:rPr/>', '<w:rPr><w:i/></w:rPr>'])(
    "the person's reject keeps it (old properties %s)",
    async (rPr) => {
      const saved = await markThenReject(rPr, (editor) => {
        applyRevisions(editor, collectRevisions(editor.state.doc), 'reject')
      })
      expect(await labelOfSaved(saved)).toEqual(['client phone'])
    },
  )

  it.each(['<w:rPr/>', '<w:rPr><w:i/></w:rPr>'])(
    "the AI's reject keeps it (old properties %s)",
    async (rPr) => {
      const saved = await markThenReject(rPr, async (editor) => {
        await executeTool(
          editor,
          { id: 'x', name: 'reject_changes', input: { all: true } },
          NUM_IDS,
        )
      })
      expect(await labelOfSaved(saved)).toEqual(['client phone'])
    },
  )

  it('a story run marked after the change keeps its mark through the reject', () => {
    const mark = '<w:rPr><go:redact w:label="client phone"/></w:rPr>'
    const record = { author: 'Ann', date: '2026-09-29T12:23:00Z', id: '7' }
    const runs = [{ text: SECRET, bold: true, rawRPr: mark, rPrChange: { ...record, old: {} } }]
    const story = {
      kind: 'header',
      id: 'header:0:0:-:0:rPrChange',
      text: SECRET,
      modelText: '{{client phone}}',
      record,
      type: 'rPrChange',
      para: 0,
      runs: [0, 1],
    } as unknown as StoryLocation
    const [after] = resolveRuns(runs, [story], 'reject')
    expect(after!.rawRPr).toBe(mark)
    expect(after!.bold).toBeUndefined()
    expect(after!.rPrChange).toBeUndefined()
  })
})

/**
 * A model cannot see the words a hidden change covers, so it cannot judge taking
 * them away: accepting a hidden deletion or rejecting a hidden insertion is the
 * person's to do. The model may keep the words (reject a deletion, accept an
 * insertion) and may act on formatting; every plain change is as it was.
 */
describe('what the AI may accept or reject', () => {
  const rev = (id: number) => ` w:id="${id}" w:author="Ann" w:date="2026-09-29T12:23:00Z"`
  const mark =
    '<w:rPr><go:redact xmlns:go="https://github.com/SeuPut0705/seuoffice/redaction/2026" w:label="client phone"/></w:rPr>'
  const doc = () =>
    buildDocx({
      bodyXml:
        `<w:p><w:r><w:t>hidden ins </w:t></w:r><w:ins${rev(1)}><w:r>${mark}<w:t>${SECRET}</w:t></w:r></w:ins></w:p>` +
        `<w:p><w:r><w:t>hidden del </w:t></w:r><w:del${rev(2)}><w:r>${mark}<w:delText>${SECRET}</w:delText></w:r></w:del></w:p>` +
        `<w:p><w:r><w:t>plain ins </w:t></w:r><w:ins${rev(3)}><w:r><w:t>added</w:t></w:r></w:ins></w:p>` +
        `<w:p><w:r><w:t>plain del </w:t></w:r><w:del${rev(4)}><w:r><w:delText>removed</w:delText></w:r></w:del></w:p>`,
    })

  async function run(name: 'accept_changes' | 'reject_changes', input: Record<string, unknown>) {
    const parsed = await parseDocx(await doc())
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks),
    })
    editors.add(editor)
    const result = (await executeTool(editor, { id: 'x', name, input }, NUM_IDS)) as {
      output: string
      isError?: boolean
    }
    const texts: string[] = []
    editor.state.doc.forEach((block) => texts.push(block.textContent))
    return { result, texts, editor }
  }

  it('rejects every plain change and the ones that keep hidden words, and leaves the hidden insertion', async () => {
    const { result, texts } = await run('reject_changes', { all: true })
    expect(result.output).not.toContain(SECRET)
    expect(result.output).toContain('r1')
    expect(result.output).toMatch(/left pending/)
    // the hidden insertion stays; the hidden deletion's words come back; the plain ones are resolved
    expect(texts[0]).toContain(SECRET)
    expect(texts[1]).toContain(SECRET)
    expect(texts[2]).not.toContain('added')
    expect(texts[3]).toContain('removed')
  })

  it('accepts every plain change and the ones that keep hidden words, and leaves the hidden deletion', async () => {
    const { result, texts } = await run('accept_changes', { all: true })
    expect(result.output).not.toContain(SECRET)
    expect(result.output).toMatch(/left pending/)
    expect(texts[0]).toContain(SECRET)
    expect(texts[1]).toContain(SECRET)
    expect(texts[2]).toContain('added')
    expect(texts[3]).not.toContain('removed')
  })

  it('refuses, naming nothing of the words, when every change picked would remove hidden words', async () => {
    const { result, texts } = await run('reject_changes', { ids: ['r1'] })
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/nothing was changed/)
    expect(result.output).not.toContain(SECRET)
    expect(texts[0]).toContain(SECRET)
  })

  it('story changes follow the same rule, and `all` is not replayed over the ones left pending', async () => {
    const { parsed, editor } = await open('none')
    const stories = [
      ...collectHfRevisions({
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
      } as never),
      ...collectTextboxRevisions(editor.state.doc),
    ]
    const seen: Array<{ kinds: string[]; all: boolean }> = []
    await executeTool(
      editor,
      { id: 'x', name: 'reject_changes', input: { all: true } },
      NUM_IDS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        storyRevisions: {
          list: () => stories,
          apply: (targets: Array<{ story: { type: string } }>, _mode: string, all?: boolean) => {
            seen.push({ kinds: targets.map((t) => t.story.type), all: all === true })
            return targets.length
          },
        },
      } as never,
    )
    expect(seen).toHaveLength(1)
    // rejecting: a hidden insertion is not handed over, a hidden deletion and a formatting change are
    expect(seen[0]!.kinds).not.toContain('ins')
    expect(seen[0]!.kinds).toContain('del')
    expect(seen[0]!.kinds).toContain('rPrChange')
    expect(seen[0]!.all).toBe(false)
  })
})
