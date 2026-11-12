// @vitest-environment node
/**
 * Korean text written through the ops (what the AI tools, the CLI and the slide editor's
 * commit all go through) wraps at spaces, never inside a word. PowerPoint and the layout
 * keep a Hangul word whole only in a Korean-tagged run, so the ops tag the Hangul they
 * write lang="ko-KR". Checked on the render tree the canvas draws: from the live model
 * right after the op (the app does not reparse after a text edit) and again from the
 * saved file.
 */
import { describe, expect, it } from 'vitest'
import { createBlankPptx, openPptx, savePptx, type OpenedPptx } from '@genoffice/pptx-engine'
import { runTxn } from '@genoffice/pptx-ops'
import { buildRenderSlide, EMU_PER_PX_96, HeuristicMetrics } from '@genoffice/pptx-render'

// Nine space-delimited words; the longest (6 syllables at 24pt = 192px) fits the box
const SENTENCE = '올해 매출은 지난해보다 크게 늘었고 신규 고객도 꾸준히 증가했습니다'
const WORDS = SENTENCE.split(' ')
// 230px wide: 210px of text between the default 0.1in insets
const BOX = { x: 952500, y: 952500, cx: 230 * EMU_PER_PX_96, cy: 3810000 }
const metrics = new HeuristicMetrics()

/** The laid-out lines of the text body that holds the sentence, one string per line. */
function sentenceLines(opened: OpenedPptx): string[] {
  const rendered = buildRenderSlide(opened.deck.slides[0]!, opened.deck.size, {
    fitWidthPx: opened.deck.size.cx / EMU_PER_PX_96,
    metrics,
  })
  for (const node of rendered.nodes) {
    if ((node.type !== 'text' && node.type !== 'shape') || !node.text) continue
    const lines = node.text.lines.map((line) =>
      line.runs
        .map((run) => run.text)
        .join('')
        .trim(),
    )
    if (lines.join('').startsWith(WORDS[0]!)) return lines
  }
  throw new Error('the sentence is not on the slide')
}

/** Fails naming the word a line break cut: a cut word shows up as two pieces. */
function expectWholeWords(lines: string[]): void {
  expect(lines.length).toBeGreaterThan(2)
  expect(lines.flatMap((line) => line.split(' '))).toEqual(WORDS)
}

describe('Korean text written through the ops wraps by word', () => {
  it('a text box added with its text (addElement)', async () => {
    const opened = await openPptx(await createBlankPptx())
    const r = runTxn(opened, {
      ops: [
        {
          op: 'addElement',
          target: { slide: 0 },
          kind: 'textbox',
          offset: BOX,
          paragraphs: [{ runs: [{ text: SENTENCE, fontSize: 24 }] }],
        },
      ],
    })
    expect(r.applied).toBe(true)
    expectWholeWords(sentenceLines(opened))
    expectWholeWords(sentenceLines(await openPptx(await savePptx(opened))))
  })

  it('text typed into a new text box (Insert > Text Box, then the editor commit)', async () => {
    const opened = await openPptx(await createBlankPptx())
    const added = runTxn(opened, {
      ops: [{ op: 'addElement', target: { slide: 0 }, kind: 'textbox', offset: BOX }],
    })
    const id = added.records![0]!.created![0]!
    // what TextEditOverlay sends on exit: paragraphs and runs traced to their sources,
    // with the formats the DOM shows
    const r = runTxn(opened, {
      ops: [
        {
          op: 'setText',
          target: { slide: 0, el: id },
          paragraphs: [
            {
              srcPara: 0,
              runs: [{ text: SENTENCE, srcRun: 0, bold: false, italic: false, fontSize: 24 }],
            },
          ],
        },
      ],
    })
    expect(r.applied).toBe(true)
    expectWholeWords(sentenceLines(opened))
    expectWholeWords(sentenceLines(await openPptx(await savePptx(opened))))
  })

  it('text replaced in an existing box (setText from the AI tools: plain runs, no tracing)', async () => {
    const opened = await openPptx(await createBlankPptx())
    const added = runTxn(opened, {
      ops: [
        {
          op: 'addElement',
          target: { slide: 0 },
          kind: 'textbox',
          offset: BOX,
          paragraphs: [{ runs: [{ text: 'Quarterly summary', fontSize: 24 }] }],
        },
      ],
    })
    const id = added.records![0]!.created![0]!
    const r = runTxn(opened, {
      ops: [
        {
          op: 'setText',
          target: { slide: 0, el: id },
          paragraphs: [{ runs: [{ text: SENTENCE }] }],
        },
      ],
    })
    expect(r.applied).toBe(true)
    expectWholeWords(sentenceLines(opened))
    expectWholeWords(sentenceLines(await openPptx(await savePptx(opened))))
  })
})
