/**
 * What the text editor reads back from a box is what a co-editing page sends, so the wire check
 * (collab-wire.ts) must take all of it: a box the check stops on could not be edited at all.
 * Real decks and the formats the editor's commands write go through layout, the editor's DOM
 * and its extraction, and then through the check.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { layoutText, makeViewport, HeuristicMetrics } from '@genoffice/pptx-render'
import { openPptx, type Paragraph, type SlideElement } from '@genoffice/pptx-engine'
import type { EditParagraph } from '@genoffice/pptx-ops'
import { extractParagraphs, populateEditorDom } from '../src/renderer/TextEditOverlay'
import { decodeOp, encodeOp, unshareable } from '../src/web/collab-wire'

const vp = makeViewport({ cx: 12192000, cy: 6858000 }, 1280)
const metrics = new HeuristicMetrics()
const AT = { slide: 's_1', el: 'e_1a2b3c4d' }

function editorOf(paragraphs: Paragraph[]): HTMLElement {
  const div = document.createElement('div')
  document.body.appendChild(div)
  const { lines } = layoutText({
    body: { paragraphs, insets: { l: 0, t: 0, r: 0, b: 0 } },
    boxWidthPx: 800,
    boxHeightPx: 400,
    metrics,
    vp,
  })
  populateEditorDom(div, lines)
  return div
}

/** The fault the wire check finds in what the editor read back, with the place it names */
function faultOf(read: EditParagraph[]): string | null {
  const fault = unshareable({ kind: 'text', at: AT, paragraphs: read })
  if (fault) return fault
  try {
    decodeOp(encodeOp({ id: 'op-1', edit: { kind: 'text', at: AT, paragraphs: read } }))
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function readBack(paragraphs: Paragraph[], change?: (root: HTMLElement) => void): EditParagraph[] {
  const div = editorOf(paragraphs)
  change?.(div)
  const read = extractParagraphs(div, 1)
  div.remove()
  return read
}

const fixtures = resolve(__dirname, '../../../packages/pptx-engine/tests/fixtures')

describe('what the text editor reads back passes the wire check', () => {
  it.each(['01_standard_business.pptx', '05_unicode_cjk_emoji.pptx'])(
    'every text box of %s',
    async (name) => {
      const opened = await openPptx(new Uint8Array(readFileSync(resolve(fixtures, name))))
      const bodies = (elements: SlideElement[]): Paragraph[][] =>
        elements.flatMap((el) =>
          el.type === 'group'
            ? bodies(el.children)
            : 'text' in el && el.text
              ? [el.text.paragraphs]
              : [],
        )
      const boxes = opened.deck.slides.flatMap((slide) => bodies(slide.elements))
      expect(boxes.length).toBeGreaterThan(1)
      for (const paragraphs of boxes) {
        const read = readBack(paragraphs)
        expect(faultOf(read), JSON.stringify(read)).toBeNull()
      }
    },
  )

  it.each<[string, Paragraph[]]>([
    [
      'runs with every character format',
      [
        {
          runs: [
            { text: 'bold ', bold: true, fontSize: 18, fontFamily: 'Malgun Gothic' },
            { text: 'italic ', italic: true, fontSize: 9.5, fontFamily: 'Noto Sans KR' },
            { text: 'under ', underline: true, fontFamily: 'Bauhaus 93' },
            { text: 'strike ', strike: true, fontFamily: 'Modern No. 20' },
            { text: 'super', baseline: 30, fontFamily: 'ヒラギノ角ゴシック' },
            { text: 'sub', baseline: -25, fontFamily: '+mn-lt' },
            { text: ' mark', highlight: '#FFFF00', letterSpacing: 2 },
            { text: ' tight', letterSpacing: -1.5, color: '#FF8800' },
          ],
        },
      ],
    ],
    [
      'links of every kind, also the ones only a file brings',
      [
        {
          runs: [
            { text: 'web', hyperlink: 'https://example.com/a?b=c#d' },
            { text: ' mail', hyperlink: 'mailto:someone@example.com' },
            { text: ' slide', hyperlink: 'slide:2' },
            { text: ' end', hyperlink: 'action:endshow' },
            { text: ' phone', hyperlink: 'tel:+82-2-0000-0000' },
            { text: ' file', hyperlink: '..\\docs\\plan final.docx' },
          ],
        },
      ],
    ],
    [
      'a field and a withheld run',
      [
        {
          runs: [
            { text: 'Page ' },
            { text: '3', field: 'slidenum' },
            { text: ' Kim', redact: 'client name' },
          ],
        },
      ],
    ],
    [
      'paragraphs with bullets, levels, alignment and spacing',
      [
        {
          runs: [{ text: 'one' }],
          level: 0,
          align: 'center',
          bullet: { type: 'char', char: '•', font: 'Arial' },
        },
        {
          runs: [{ text: 'two' }],
          level: 1,
          bullet: { type: 'char', char: 'ü', font: 'Wingdings' },
        },
        {
          runs: [{ text: 'three' }],
          level: 8,
          bullet: { type: 'number', numType: 'romanLcParenR', startAt: 4 },
        },
        {
          runs: [{ text: 'four' }],
          align: 'justify',
          lineHeight: 150,
          spaceBefore: 6,
          spaceAfter: 12,
          rtl: true,
        },
        { runs: [{ text: 'five' }], bullet: { type: 'none' } },
        { runs: [] },
      ],
    ],
    ['an empty box', [{ runs: [] }]],
    ['soft breaks', [{ runs: [{ text: 'first' }, { text: '\n' }, { text: 'second' }] }]],
  ])('%s', (_name, paragraphs) => {
    const read = readBack(paragraphs)
    expect(faultOf(read), JSON.stringify(read)).toBeNull()
  })

  it('what the format commands write on a paragraph and on a selection', () => {
    const read = readBack(
      [
        { runs: [{ text: 'first' }] },
        { runs: [{ text: 'second' }] },
        { runs: [{ text: 'third' }] },
      ],
      (root) => {
        const blocks = Array.from(root.querySelectorAll<HTMLElement>('div, p'))
        expect(blocks.length).toBeGreaterThanOrEqual(3)
        // applySelectionParagraphFormat: a numbered list, a character bullet, a picture bullet
        Object.assign(blocks[0]!.dataset, {
          bullet: 'number',
          numType: 'alphaUcPeriod',
          startAt: '3',
        })
        Object.assign(blocks[1]!.dataset, { bullet: 'char', bulletChar: '§', bulletFont: 'Symbol' })
        Object.assign(blocks[2]!.dataset, {
          bullet: 'blip',
          bulletImgSrc:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          bulletImgExt: 'png',
          lineSpacingPct: '115.5',
          spaceBeforePt: '0',
          spaceAfterPt: '7.2',
          rtl: '0',
        })
        blocks[0]!.style.textAlign = 'right'
        // run commands: font, size, colour, highlight, spacing, link, withholding
        const span = document.createElement('a')
        span.setAttribute('href', 'https://example.com/new')
        span.style.fontFamily = '"Paperlogy 4", sans-serif'
        span.style.fontSize = '31.5px'
        span.style.color = 'rgb(18, 52, 86)'
        span.style.backgroundColor = 'rgb(255, 255, 0)'
        span.dataset.letterSpacing = '0.5'
        span.dataset.redact = 'a name'
        span.textContent = ' added'
        blocks[1]!.appendChild(span)
      },
    )
    expect(read.map((p) => p.bullet)).toEqual(['number', 'char', 'blip'])
    expect(read[1]!.runs.at(-1)).toMatchObject({ link: { kind: 'url' }, redact: 'a name' })
    expect(faultOf(read), JSON.stringify(read)).toBeNull()
  })
})
