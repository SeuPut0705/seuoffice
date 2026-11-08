/**
 * Existing comments (`office:annotation` … `office:annotation-end`) become
 * real docx comments, so the commented text stays ordinary editable text. On
 * save the comment's own bytes are kept and its anchors follow the edited
 * text; deleting all commented text deletes the comment. New comments are
 * not saved into ODT documents.
 */
import { describe, expect, it } from 'vitest'
import { bodyOf, editOnly, editorSave, replaceText, runText } from './helpers/bridge'
import { hAnnotation, hPara, hParaWith, hancomRunText } from './helpers/hancom-fragments'
import { objectsBridge, visibleBlocks, writeBackObjects } from './helpers/objects-fixtures'

const memo = hAnnotation('memo1', 'memo text', '달린 글')

describe('comments: ODF → OOXML', () => {
  it('an annotation becomes a docx comment over the commented text', async () => {
    const fx = await objectsBridge({ body: hParaWith(`앞 ${memo.xml} 뒤`) })
    const { parsed, blocks } = await visibleBlocks(fx.bridge.docx)
    expect(parsed.comments).toEqual([
      expect.objectContaining({ id: '0', author: 'user', text: 'memo text' }),
    ])
    expect(runText(blocks[0])).toBe('앞 달린 글 뒤')
    const commented = (blocks[0].runs ?? []).filter((r) => r.commentIds?.includes('0'))
    expect(commented.map((r) => r.text).join('')).toBe('달린 글')
    expect(fx.ext.comments).toEqual([
      expect.objectContaining({ id: '0', name: 'memo1', paragraph: 0, endParagraph: 0 }),
    ])
  })

  it('an annotation without an end is a point comment', async () => {
    const fx = await objectsBridge({ body: hParaWith(`앞${memo.annotation}뒤`) })
    const { parsed } = await visibleBlocks(fx.bridge.docx)
    expect(parsed.comments.map((c) => c.text)).toEqual(['memo text'])
    expect(fx.ext.comments[0]).toMatchObject({ endParagraph: null, ranged: false })
  })
})

describe('comments: OOXML → ODF', () => {
  const body = hParaWith(`앞 ${memo.xml} 뒤`) + hPara('다음')

  it('an unedited save is identical', async () => {
    const fx = await objectsBridge({ body })
    const { bytes } = await editorSave(fx.bridge.docx, (blocks) =>
      blocks.map((_, i) => ({ keep: i })),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(wb.content).toBe(fx.bridge.doc.contentXml)
  })

  it('commented text edited: the comment is kept and re-anchored', async () => {
    const fx = await objectsBridge({ body })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({
        0: (g) => {
          replaceText(g, 5, 6, '그')
          replaceText(g, 0, 1, '맨앞')
        },
      }),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(bodyOf(wb.content)).toBe(
      hParaWith(`맨앞 ${memo.annotation}${hancomRunText('달린 그')}${memo.end} 뒤`) + hPara('다음'),
    )
  })

  it('deleting all commented text deletes the comment', async () => {
    const fx = await objectsBridge({ body })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({ 0: (g) => replaceText(g, 2, 6, '') }),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(bodyOf(wb.content)).toBe(hParaWith(hancomRunText('앞  뒤')) + hPara('다음'))
  })

  it('a point comment follows its position', async () => {
    const fx = await objectsBridge({ body: hParaWith(`앞${memo.annotation}뒤`) })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({ 0: (g) => replaceText(g, 0, 0, '맨 ') }),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(bodyOf(wb.content)).toBe(hParaWith(`맨 앞${memo.annotation}뒤`))
  })

  it('a comment across two paragraphs keeps both ends where their text went', async () => {
    const first = hParaWith(`처음 ${memo.annotation}가운데`)
    const second = hParaWith(`이어서${memo.end} 끝`)
    const fx = await objectsBridge({ body: first + second })
    expect(fx.ext.comments[0]).toMatchObject({ paragraph: 0, endParagraph: 1, ranged: true })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({
        0: (g) => replaceText(g, 0, 0, '맨 '),
        1: (g) => replaceText(g, 3, 5, ' 마지막'),
      }),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(bodyOf(wb.content)).toBe(
      hParaWith(`맨 처음 ${memo.annotation}가운데`) + hParaWith(`이어서${memo.end} 마지막`),
    )
  })

  it('a new comment is dropped with a warning', async () => {
    const fx = await objectsBridge({ body })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({
        1: (g) => {
          g.runs = g.runs.map((r) => ({ ...r, commentIds: ['7'] }))
        },
      }),
      (() => ({
        comments: [
          { id: '0', author: 'user', text: 'memo text' },
          { id: '7', author: 'me', text: '새 메모' },
        ],
      }))(),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(bodyOf(wb.content)).toBe(body)
    expect(wb.rctx.warnings.some((w) => w.includes('new comment'))).toBe(true)
  })
})
