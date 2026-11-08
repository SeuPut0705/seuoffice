/**
 * Footnotes and endnotes: `text:note` ⇄ docx footnotes/endnotes. The note
 * body is written back by the text layer (original note paragraphs as the
 * origin); the citation stays a `text:note` inside its paragraph.
 */
import { describe, expect, it } from 'vitest'
import { bodyOf, editOnly, editorSave, replaceText } from './helpers/bridge'
import { escapeText, hFootnote, hPara, hParaWith } from './helpers/hancom-fragments'
import { objectsBridge, visibleBlocks, writeBackObjects } from './helpers/objects-fixtures'

const note = hFootnote(' 각주 내용')
const endnote = `<text:note text:note-class="endnote"><text:note-citation>i</text:note-citation><text:note-body>${hPara('미주 글', { style: 'P425_11', span: 'T270' })}</text:note-body></text:note>`
const twoParagraphNote = `<text:note text:note-class="footnote"><text:note-body>${hPara('첫 문단', { style: 'P425_11', span: 'T270' })}${hPara('둘째 문단', { style: 'P425_11', span: 'T270' })}</text:note-body><text:note-citation>2)</text:note-citation></text:note>`

const notePara = (text: string) =>
  `<text:p text:style-name="P425_11"><text:span text:style-name="T270">${escapeText(text)}</text:span></text:p>`

describe('notes: ODF → OOXML', () => {
  it('footnotes and endnotes become docx notes with references in the text', async () => {
    const fx = await objectsBridge({
      body: hParaWith(`본문${note} 둘째${twoParagraphNote}`) + hParaWith(`끝${endnote}`),
    })
    const { parsed, blocks } = await visibleBlocks(fx.bridge.docx)
    expect(parsed.footnotes.map((n) => [n.id, n.text])).toEqual([
      ['1', '각주 내용'],
      ['2', '첫 문단\n둘째 문단'],
    ])
    expect(parsed.endnotes.map((n) => [n.id, n.text])).toEqual([['1', '미주 글']])
    expect(blocks[0].runs?.map((r) => [r.text, r.noteRef?.id ?? null])).toEqual([
      ['본문', null],
      ['1', '1'],
      [' 둘째', null],
      ['2', '2'],
    ])
    expect(blocks[1].runs?.[1].noteRef).toEqual({ kind: 'endnote', id: '1' })
    expect(fx.ext.notes.map((n) => [n.kind, n.id, n.citation, n.text])).toEqual([
      ['footnote', '1', '1)', '각주 내용'],
      ['footnote', '2', '2)', '첫 문단\n둘째 문단'],
      ['endnote', '1', 'i', '미주 글'],
    ])
    // the recorded paragraph text matches what the engine reads back
    expect(fx.bridge.map.paragraphs[0].text).toBe('본문1 둘째2')
  })
})

describe('notes: OOXML → ODF', () => {
  const body = hParaWith(`본문${note} 뒤`) + hPara('다음')

  it('an unedited save is identical', async () => {
    const fx = await objectsBridge({ body })
    const { bytes } = await editorSave(fx.bridge.docx, (blocks) =>
      blocks.map((_, i) => ({ keep: i })),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(wb.content).toBe(fx.bridge.doc.contentXml)
  })

  it('text edited next to a note keeps the note bytes', async () => {
    const fx = await objectsBridge({ body })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({ 0: (g) => replaceText(g, 0, 2, '본 문') }),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(bodyOf(wb.content)).toBe(hParaWith(`본 문${note} 뒤`) + hPara('다음'))
  })

  it('a note whose text was edited is rewritten in place (paragraph untouched in the editor)', async () => {
    const fx = await objectsBridge({ body })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      (blocks) => blocks.map((_, i) => ({ keep: i })),
      { footnotes: [{ id: '1', text: '고친 각주 내용' }] },
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(bodyOf(wb.content)).toBe(
      hParaWith(`본문${note.replace(notePara(' 각주 내용'), notePara('고친 각주 내용'))} 뒤`) +
        hPara('다음'),
    )
  })

  it('a note edited together with its paragraph', async () => {
    const fx = await objectsBridge({ body: hParaWith(`본문${twoParagraphNote}`) })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({ 0: (g) => replaceText(g, 0, 0, '새 ') }),
      { footnotes: [{ id: '1', text: '첫 문단\n둘째 문단 고침\n셋째' }] },
    )
    const wb = await writeBackObjects(fx, bytes)
    const rewritten = twoParagraphNote.replace(
      notePara('둘째 문단'),
      notePara('둘째 문단 고침') + notePara('셋째'),
    )
    expect(bodyOf(wb.content)).toBe(hParaWith(`새 본문${rewritten}`))
  })

  it('a new footnote becomes a new text:note shaped like the others', async () => {
    const fx = await objectsBridge({ body })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({
        0: (g) => {
          g.runs.push({ text: '2', noteRef: { kind: 'footnote', id: '2' } })
        },
      }),
      (() => ({
        footnotes: [
          { id: '1', text: '각주 내용' },
          { id: '2', text: '새 각주' },
        ],
      }))(),
    )
    const wb = await writeBackObjects(fx, bytes)
    const added = `<text:note text:note-class="footnote"><text:note-body>${notePara('새 각주')}</text:note-body><text:note-citation>2)</text:note-citation></text:note>`
    expect(bodyOf(wb.content)).toBe(hParaWith(`본문${note} 뒤${added}`) + hPara('다음'))
  })

  it('a deleted footnote is removed', async () => {
    const fx = await objectsBridge({ body })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({ 0: (g) => (g.runs = g.runs.filter((r) => !r.noteRef)) }),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(bodyOf(wb.content)).toBe(hParaWith('본문 뒤') + hPara('다음'))
  })
})
