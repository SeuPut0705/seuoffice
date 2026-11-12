/**
 * PowerPoint and the slide layout break Hangul by word only in a Korean-tagged run; an
 * untagged run breaks per syllable, inside words. Text written through the ops without a
 * language gets lang="ko-KR" when it holds Hangul (what PowerPoint writes for a Korean
 * user's typing): in the bytes, and in the live model the canvas draws from before any
 * reparse. A language that is already on a run stays, and a run the edit did not rewrite
 * keeps its bytes.
 */
import { describe, expect, it } from 'vitest'
import {
  addElement,
  createBlankPptx,
  openPptx,
  patchSlideXml,
  savePptx,
  type OpenedPptx,
  type Paragraph,
  type TableElement,
  type TextElement,
} from '@seuoffice/pptx-engine'
import { runTxn } from '../src/ops/executor'
import '../src/ops/index'

const BOX = { x: 0, y: 0, cx: 1828800, cy: 914400 }

const blank = async (): Promise<OpenedPptx> => openPptx(await createBlankPptx())
const reopen = async (opened: OpenedPptx): Promise<OpenedPptx> => openPptx(await savePptx(opened))
const slideXml = (opened: OpenedPptx): string => patchSlideXml(opened.deck.slides[0]!)

/** The text element whose text contains `needle` (element ids change on reopen). */
function textEl(opened: OpenedPptx, needle: string): TextElement {
  const found = opened.deck.slides[0]!.elements.find(
    (el) =>
      (el.type === 'text' || el.type === 'shape') &&
      (el as TextElement).text?.paragraphs.some((p) => p.runs.some((r) => r.text.includes(needle))),
  )
  if (!found) throw new Error(`no text element holds "${needle}"`)
  return found as TextElement
}

/** [text, the run's own lang, its line-breaking language] of every run. */
const langs = (paragraphs: Paragraph[]) =>
  paragraphs.flatMap((p) => p.runs).map((r) => [r.text, r.lang ?? null, r.eaLang ?? null])

/** A text box as an importer leaves it: the runs written exactly as given. */
function importedBox(opened: OpenedPptx, paragraphs: Paragraph[]): string {
  return addElement(opened.deck.slides[0]!, { kind: 'textbox', offset: BOX, paragraphs }).id
}

const setText = (opened: OpenedPptx, el: string, paragraphs: unknown[]) =>
  runTxn(opened, { ops: [{ op: 'setText', target: { slide: 0, el }, paragraphs }] })

describe('addElement tags the Hangul runs it creates', () => {
  it('ko-KR on runs with Hangul, nothing on the others, and a given lang is kept', async () => {
    const opened = await blank()
    const r = runTxn(opened, {
      ops: [
        {
          op: 'addElement',
          target: { slide: 0 },
          kind: 'textbox',
          offset: BOX,
          paragraphs: [
            {
              runs: [
                { text: '매출 성장', fontSize: 24 },
                { text: 'Revenue 2026', fontSize: 24 },
                { text: 'AI 도입 효과', fontSize: 24 },
                { text: '한글 as English', fontSize: 24, lang: 'en-US' },
              ],
            },
          ],
        },
      ],
    })
    expect(r.applied).toBe(true)
    const xml = slideXml(opened)
    expect(xml).toContain('<a:rPr lang="ko-KR" sz="2400"/><a:t>매출 성장</a:t>')
    expect(xml).toContain('<a:rPr sz="2400"/><a:t>Revenue 2026</a:t>')
    expect(xml).toContain('<a:rPr lang="ko-KR" sz="2400"/><a:t>AI 도입 효과</a:t>')
    expect(xml).toContain('<a:rPr lang="en-US" sz="2400"/><a:t>한글 as English</a:t>')
    // the model the canvas draws from, before any reparse
    expect(langs(textEl(opened, '매출').text!.paragraphs).slice(0, 3)).toEqual([
      ['매출 성장', 'ko-KR', 'ko'],
      ['Revenue 2026', null, null],
      ['AI 도입 효과', 'ko-KR', 'ko'],
    ])
    expect(langs(textEl(await reopen(opened), '매출').text!.paragraphs)).toEqual([
      ['매출 성장', 'ko-KR', 'ko'],
      ['Revenue 2026', null, null],
      ['AI 도입 효과', 'ko-KR', 'ko'],
      ['한글 as English', 'en-US', 'none'],
    ])
  })
})

describe('setText tags the Hangul it writes', () => {
  it('typed into an untagged run, in place (the editor commit: traced paragraph and run)', async () => {
    const opened = await blank()
    const id = importedBox(opened, [{ runs: [{ text: 'Title', fontSize: 24 }] }])
    const r = setText(opened, id, [{ srcPara: 0, runs: [{ text: '분기 실적 요약', srcRun: 0 }] }])
    expect(r.applied).toBe(true)
    expect(slideXml(opened)).toContain('<a:rPr lang="ko-KR" sz="2400"/><a:t>분기 실적 요약</a:t>')
    expect(langs(textEl(opened, '분기').text!.paragraphs)).toEqual([
      ['분기 실적 요약', 'ko-KR', 'ko'],
    ])
    expect(langs(textEl(await reopen(opened), '분기').text!.paragraphs)).toEqual([
      ['분기 실적 요약', 'ko-KR', 'ko'],
    ])
  })

  it('a plain rewrite that changes the paragraph count (the AI tools) tags each Hangul run', async () => {
    const opened = await blank()
    const id = importedBox(opened, [{ runs: [{ text: 'Title', fontSize: 24 }] }])
    const r = setText(opened, id, [
      { runs: [{ text: '핵심 요약' }] },
      { runs: [{ text: 'Key points' }] },
      { runs: [{ text: '다음 단계 next' }] },
    ])
    expect(r.applied).toBe(true)
    const xml = slideXml(opened)
    expect(xml).toContain('<a:rPr lang="ko-KR" sz="2400"/><a:t>핵심 요약</a:t>')
    expect(xml).toContain('<a:rPr sz="2400"/><a:t>Key points</a:t>')
    expect(xml).toContain('<a:rPr lang="ko-KR" sz="2400"/><a:t>다음 단계 next</a:t>')
    expect(langs(textEl(opened, '핵심').text!.paragraphs)).toEqual([
      ['핵심 요약', 'ko-KR', 'ko'],
      ['Key points', null, null],
      ['다음 단계 next', 'ko-KR', 'ko'],
    ])
  })

  it('first text on a shape that had no text body', async () => {
    const opened = await blank()
    const added = runTxn(opened, {
      ops: [{ op: 'addElement', target: { slide: 0 }, kind: 'roundRect', offset: BOX }],
    })
    const id = added.records![0]!.created![0]!
    expect(setText(opened, id, [{ runs: [{ text: '신규 고객' }] }]).applied).toBe(true)
    expect(slideXml(opened)).toMatch(/<a:rPr lang="ko-KR"[^>]*\/><a:t>신규 고객<\/a:t>/)
    expect(langs(textEl(opened, '신규').text!.paragraphs)).toEqual([['신규 고객', 'ko-KR', 'ko']])
  })

  it('keeps a language that is already on the run: Hangul typed into an en-US run stays en-US', async () => {
    const seeded = await blank()
    importedBox(seeded, [{ runs: [{ text: 'Title', lang: 'en-US', altLang: 'ja-JP' }] }])
    const opened = await reopen(seeded)
    const id = textEl(opened, 'Title').id
    expect(setText(opened, id, [{ srcPara: 0, runs: [{ text: '제목', srcRun: 0 }] }]).applied).toBe(
      true,
    )
    const xml = slideXml(opened)
    expect(xml).toContain('<a:rPr lang="en-US" altLang="ja-JP"/><a:t>제목</a:t>')
    expect(xml).not.toContain('ko-KR')
    expect(langs(textEl(opened, '제목').text!.paragraphs)).toEqual([['제목', 'en-US', 'ja']])
  })

  it('leaves an untagged Hangul run the edit did not rewrite as it was', async () => {
    const seeded = await blank()
    importedBox(seeded, [{ runs: [{ text: '가져온 문장' }] }, { runs: [{ text: 'second' }] }])
    const opened = await reopen(seeded)
    const id = textEl(opened, '가져온').id
    const r = setText(opened, id, [
      { srcPara: 0, runs: [{ text: '가져온 문장', srcRun: 0 }] },
      { srcPara: 1, runs: [{ text: '둘째 문장', srcRun: 0 }] },
    ])
    expect(r.applied).toBe(true)
    const xml = slideXml(opened)
    expect(xml).toContain('<a:rPr/><a:t>가져온 문장</a:t>')
    expect(xml).toContain('<a:rPr lang="ko-KR"/><a:t>둘째 문장</a:t>')
    expect(langs(textEl(opened, '가져온').text!.paragraphs)).toEqual([
      ['가져온 문장', null, null],
      ['둘째 문장', 'ko-KR', 'ko'],
    ])
  })
})

describe('the other text-writing ops', () => {
  it('setTableCell tags Hangul written into a cell', async () => {
    const opened = await blank()
    const added = runTxn(opened, {
      ops: [{ op: 'addTable', target: { slide: 0 }, rows: 1, cols: 2, offset: BOX }],
    })
    const id = added.records![0]!.created![0]!
    const r = runTxn(opened, {
      ops: [
        {
          op: 'setTableCell',
          target: { slide: 0, el: id },
          row: 0,
          col: 0,
          paragraphs: [{ runs: [{ text: '매출 합계' }] }],
        },
        {
          op: 'setTableCell',
          target: { slide: 0, el: id },
          row: 0,
          col: 1,
          paragraphs: [{ runs: [{ text: 'Total' }] }],
        },
      ],
    })
    expect(r.applied).toBe(true)
    const table = opened.deck.slides[0]!.elements.find((e) => e.type === 'table') as TableElement
    expect(table.anchor.originalXml).toMatch(/<a:rPr lang="ko-KR"[^>]*\/><a:t>매출 합계<\/a:t>/)
    expect(table.anchor.originalXml).toMatch(/<a:rPr(?! lang)[^>]*\/><a:t>Total<\/a:t>/)
    expect(langs(table.rows[0]![0]!.text!.paragraphs)).toEqual([['매출 합계', 'ko-KR', 'ko']])
    expect(langs(table.rows[0]![1]!.text!.paragraphs)).toEqual([['Total', null, null]])
  })

  it('findReplace tags the run a Hangul replacement lands in', async () => {
    const opened = await blank()
    importedBox(opened, [{ runs: [{ text: 'Draft title', fontSize: 24 }] }])
    const r = runTxn(opened, { ops: [{ op: 'findReplace', find: 'Draft', replace: '초안' }] })
    expect(r.applied).toBe(true)
    expect(slideXml(opened)).toContain('<a:rPr lang="ko-KR" sz="2400"/><a:t>초안 title</a:t>')
    expect(langs(textEl(opened, '초안').text!.paragraphs)).toEqual([['초안 title', 'ko-KR', 'ko']])
  })
})
