/**
 * PowerPoint and the slide layout break Hangul by word only in a Korean-tagged run; an
 * untagged run breaks per syllable, inside words. Authoring writers therefore tag text they
 * are given without a language through one helper, `tagHangulRun`; the engine's own
 * text-writing edits (find/replace, footers, diagram labels) use it too, and the in-place run
 * patch writes a tag the model gained without ever replacing one that is already in the bytes.
 * `addElement` itself stays neutral: importers build slides with it, and a source run that
 * carried no language must stay untagged.
 */
import { describe, expect, it } from 'vitest'
import {
  addElement,
  addSmartArt,
  applyHeaderFooter,
  createBlankPptx,
  openPptx,
  patchSlideXml,
  patchTextElementXml,
  replaceAllInDeck,
  tagHangulParagraphs,
  tagHangulRun,
} from '../src/index'
import type { TextElement, TextRun } from '../src/types'

const BOX = { x: 0, y: 0, cx: 1828800, cy: 914400 }
const KO = { lang: 'ko-KR', eaLang: 'ko', fontScriptHint: 'ko' }

describe('tagHangulRun', () => {
  it('tags a run that holds Hangul, mixed with Latin or not', () => {
    expect(tagHangulRun({ text: '매출 성장', fontSize: 24 })).toEqual({
      text: '매출 성장',
      fontSize: 24,
      ...KO,
    })
    expect(tagHangulRun({ text: 'AI 도입 효과' })).toMatchObject(KO)
    // compatibility jamo typed on their own are Korean typing too
    expect(tagHangulRun({ text: 'ㅋㅋ' })).toMatchObject(KO)
  })

  it('leaves a run without Hangul as it is', () => {
    for (const text of ['Revenue 2026', '売上の成長', '收入增长', '', '· 2026 ·']) {
      const run = { text }
      expect(tagHangulRun(run)).toBe(run)
    }
  })

  it('never replaces a language the run already carries', () => {
    for (const run of [
      { text: '한글', lang: 'en-US' },
      { text: '한글', altLang: 'ja-JP' },
      { text: '한글', lang: 'ko-KR', altLang: 'en-US' },
    ]) {
      expect(tagHangulRun(run)).toBe(run)
    }
  })

  it('tagHangulParagraphs keeps the array when no run needs a tag', () => {
    const plain = [{ runs: [{ text: 'Title' }] }, { runs: [{ text: '한글', lang: 'en-US' }] }]
    expect(tagHangulParagraphs(plain)).toBe(plain)
    const mixed = [
      { runs: [{ text: 'Title' }], align: 'center' as const },
      { runs: [{ text: '제목' }] },
    ]
    const tagged = tagHangulParagraphs(mixed)
    expect(tagged[0]).toBe(mixed[0])
    expect(tagged[1]!.runs[0]).toMatchObject({ text: '제목', ...KO })
    // the caller's objects are not written to
    expect(mixed[1]!.runs[0]).toEqual({ text: '제목' })
  })
})

describe('in-place run patch and the language tag', () => {
  const el = (run: TextRun) =>
    ({ type: 'text', text: { paragraphs: [{ runs: [run] }] } }) as unknown as TextElement
  const sp = (run: string) => `<p:sp><p:txBody><a:p>${run}</a:p></p:txBody></p:sp>`

  it('writes a tag the model gained onto an rPr that has none', () => {
    const tagged = tagHangulRun({ text: '분기 실적', fontSize: 18 })
    expect(
      patchTextElementXml(el(tagged), sp('<a:r><a:rPr sz="1800"/><a:t>Title</a:t></a:r>')),
    ).toContain('<a:r><a:rPr lang="ko-KR" sz="1800"/><a:t>분기 실적</a:t></a:r>')
    expect(
      patchTextElementXml(
        el(tagged),
        sp('<a:r><a:rPr sz="1800"><a:latin typeface="Calibri"/></a:rPr><a:t>Title</a:t></a:r>'),
      ),
    ).toContain('<a:rPr lang="ko-KR" sz="1800"><a:latin typeface="Calibri"/></a:rPr>')
    expect(patchTextElementXml(el(tagged), sp('<a:r><a:t>Title</a:t></a:r>'))).toContain(
      '<a:r><a:rPr lang="ko-KR" sz="1800"/><a:t>분기 실적</a:t></a:r>',
    )
  })

  it('leaves a language that is already in the bytes alone', () => {
    const original = sp(
      '<a:r><a:rPr lang="en-US" altLang="ja-JP" sz="1800"/><a:t>Title</a:t></a:r>',
    )
    const out = patchTextElementXml(el({ text: '분기 실적', lang: 'ko-KR' }), original)
    expect(out).toContain('<a:rPr lang="en-US" altLang="ja-JP" sz="1800"/><a:t>분기 실적</a:t>')
  })

  it('adds nothing to a run whose model has no language', () => {
    const original = sp('<a:r><a:rPr sz="1800"/><a:t>가져온 문장</a:t></a:r>')
    expect(patchTextElementXml(el({ text: '가져온 문장' }), original)).toBe(original)
  })
})

describe("the engine's own text writers", () => {
  it('addElement writes the runs it is given: untagged Hangul stays untagged (importers)', async () => {
    const opened = await openPptx(await createBlankPptx())
    const slide = opened.deck.slides[0]!
    const added = addElement(slide, {
      kind: 'textbox',
      offset: BOX,
      paragraphs: [{ runs: [{ text: '가져온 문장' }] }],
    })
    expect(patchSlideXml(slide)).toContain('<a:rPr/><a:t>가져온 문장</a:t>')
    expect(added.text!.paragraphs[0]!.runs[0]).toEqual({ text: '가져온 문장' })
  })

  it('find/replace tags the run a Hangul replacement lands in, and only that run', async () => {
    const opened = await openPptx(await createBlankPptx())
    const slide = opened.deck.slides[0]!
    const draft = addElement(slide, {
      kind: 'textbox',
      offset: BOX,
      paragraphs: [
        { runs: [{ text: 'Draft title' }] },
        { runs: [{ text: 'Draft, tagged', lang: 'en-US' }] },
      ],
    })
    const imported = addElement(slide, {
      kind: 'textbox',
      offset: BOX,
      paragraphs: [{ runs: [{ text: '기존 문장 old' }] }],
    })
    expect(replaceAllInDeck(opened.deck, 'Draft', '초안').count).toBe(2)
    expect(replaceAllInDeck(opened.deck, 'old', 'new').count).toBe(1)
    const xml = patchSlideXml(slide)
    expect(xml).toContain('<a:rPr lang="ko-KR"/><a:t>초안 title</a:t>')
    expect(xml).toContain('<a:rPr lang="en-US"/><a:t>초안, tagged</a:t>')
    // Latin written into an untagged Hangul run: the run keeps the breaking it had
    expect(xml).toContain('<a:rPr/><a:t>기존 문장 new</a:t>')
    expect(draft.text!.paragraphs[0]!.runs[0]).toMatchObject({ text: '초안 title', ...KO })
    expect(imported.text!.paragraphs[0]!.runs[0]).toEqual({ text: '기존 문장 new' })
  })

  it('a footer and a diagram label typed in Korean are tagged; Latin ones are not', async () => {
    const opened = await openPptx(await createBlankPptx())
    expect(applyHeaderFooter(opened, { footer: '분기 실적 보고서', date: '2026-11-12' })).toBe(true)
    const footerXml = patchSlideXml(opened.deck.slides[0]!)
    expect(footerXml).toMatch(
      /<a:rPr lang="ko-KR" sz="1200">(?:(?!<\/a:r>).)*<a:t>분기 실적 보고서<\/a:t>/,
    )
    expect(footerXml).toMatch(/<a:rPr sz="1200">(?:(?!<\/a:r>).)*<a:t>2026-11-12<\/a:t>/)

    const added = addSmartArt(opened, 0, {
      layout: 'process',
      items: ['기획 단계', 'Build'],
      offset: { x: 0, y: 0, cx: 6096000, cy: 1828800 },
    })!
    const diagramXml = patchSlideXml(added.slide)
    expect(diagramXml).toMatch(
      /<a:rPr lang="ko-KR" sz="\d+" b="1">(?:(?!<\/a:r>).)*<a:t>기획 단계<\/a:t>/,
    )
    expect(diagramXml).toMatch(/<a:rPr sz="\d+" b="1">(?:(?!<\/a:r>).)*<a:t>Build<\/a:t>/)
  })
})
