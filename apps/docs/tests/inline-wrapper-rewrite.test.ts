import { Editor } from '@tiptap/core'
import { parseDocx, saveDocx } from '@seuoffice/docx-engine'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { executeTool } from '../src/renderer/ai/tools'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import {
  acceptAllRevisions,
  collectRevisions,
  rejectAllRevisions,
  type TrackChangesStorage,
} from '../src/renderer/editor/revisions'
import { takeOdtRefusal } from '../src/renderer/odt-gate'
import { createDocsAdapter, type DocsOp } from '../src/web/collab-adapter'

/**
 * An AI block rewrite arrives as plain blocks: the model sees the text of a
 * paragraph, never the content controls and smart tags in it. These tests
 * open a document the way the editor does, run the public tool, and read the
 * saved XML.
 */

;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }
;(globalThis as { ClipboardEvent?: unknown }).ClipboardEvent ??= class extends Event {}
const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
const struck = (text: string) => `<w:r><w:delText xml:space="preserve">${text}</w:delText></w:r>`
const LOCK = '<w:lock w:val="contentLocked"/>'
/** a content control around `inner` */
const sdtOf = (inner: string, id: number, locked = false) =>
  `<w:sdt><w:sdtPr><w:id w:val="${id}"/>${locked ? LOCK : ''}</w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`
const sdt = (text: string, id: number, locked = false) => sdtOf(run(text), id, locked)
const control = (locked = false) => sdt('5/6/2024', 1234567, locked)
const smart = `<w:smartTag w:uri="urn:place" w:element="city">${run('Paris')}</w:smartTag>`
const TAIL = `<w:p>${run('tail')}</w:p>`
const para = (inner: string) => `<w:p>${inner}</w:p>${TAIL}`
const body = (inside: string) => para(run('Due on ') + inside + run(' at noon'))
/** a revision's attributes, as Word writes them */
const rev = (id: number) => `w:id="${id}" w:author="Ann" w:date="2024-01-01T00:00:00Z"`
const cell = (inner: string) =>
  `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p>${inner}</w:p></w:tc>`
/** a one-column table: a row that stays, then a row marked `mark` holding a locked control */
const tableWithRow = (mark: 'ins' | 'del') =>
  `<w:p>${run('before')}</w:p><w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>` +
  `<w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr>${cell(run('keep'))}</w:tr>` +
  `<w:tr><w:trPr><w:${mark} ${rev(1)}/></w:trPr>${cell(run('Due ') + sdt('5/6/2024', 5, true))}</w:tr>` +
  `</w:tbl>${TAIL}`

/** the xml with every text run reduced to [its text] */
const flat = (xml: string) =>
  xml.replace(/<w:r>(?:<w:rPr>.*?<\/w:rPr>)?<w:t[^>]*>([^<]*)<\/w:t><\/w:r>/g, '[$1]')
const count = (xml: string, tag: string) => xml.split(`<w:${tag}`).length - 1

const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  takeOdtRefusal()
})
async function open(xml: string) {
  const parsed = await parseDocx(await buildDocx({ bodyXml: xml }))
  const make = () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks) as never,
    })
    editors.push(editor)
    return editor
  }
  const editor = make()
  const save = async (e = editor) =>
    (
      await parseDocx(
        await saveDocx(parsed, pmDocToSavePlan(e.getJSON() as PmNode, parsed.blocks).saveBlocks),
      )
    ).internal.documentXml
  return { editor, parsed, make, save }
}
const rewrite = (
  editor: Editor,
  html: string,
  tracked = false,
  name = 'replace_blocks',
  endBlockIndex = 0,
) =>
  executeTool(
    editor,
    {
      id: 'probe',
      name,
      input:
        name === 'write_document'
          ? { plan: 'Rewrite', replaceDocument: true }
          : { startBlockIndex: 0, endBlockIndex, html },
    },
    { bullet: null, ordered: null },
    tracked ? { author: 'Probe' } : undefined,
    undefined,
    null,
    undefined,
    undefined,
    {
      write: async (_spec, onProgress) => {
        onProgress(html)
        return { ok: true, html, truncated: false }
      },
    },
  )
function posOf(editor: Editor, text: string) {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    const at = node.isText ? node.text!.indexOf(text) : -1
    if (found < 0 && at >= 0) found = pos + at
  })
  if (found < 0) throw new Error(`Missing ${text}`)
  return found
}
/** the text of every top-level block */
function texts(editor: Editor): string[] {
  const out: string[] = []
  editor.state.doc.forEach((node) => out.push(node.textContent))
  return out
}
const pending = (editor: Editor) => collectRevisions(editor.state.doc).map((r) => r.kind)
const finish = (editor: Editor, mode: 'accept' | 'reject') =>
  mode === 'accept' ? acceptAllRevisions(editor) : rejectAllRevisions(editor)

describe('an AI block rewrite and a control locked against editing', () => {
  for (const name of ['replace_blocks', 'write_document']) {
    it(`${name}: refuses changing a locked date into a table with and without tracking`, async () => {
      const { editor, save } = await open(body(control(true)))
      const before = await save()
      for (const tracked of [true, false]) {
        const result = await rewrite(
          editor,
          '<table><tr><td>Due on 5/6/2025</td></tr></table>',
          tracked,
          name,
        )
        expect(result.isError).toBe(true)
        expect(result.mutated).not.toBe(true)
        acceptAllRevisions(editor)
        expect(await save()).toBe(before)
      }
    })
  }

  for (const html of [
    '<p>Due on 5/6/2024 at night</p>',
    '<table><tr><td>Due on 5/6/2024 at night</td></tr></table>',
  ]) {
    it(`a tracked rewrite of its block is refused though its text is kept: ${html}`, async () => {
      const { editor, save } = await open(body(control(true)))
      const before = await save()
      const result = await rewrite(editor, html, true)
      expect(result.isError).toBe(true)
      expect(result.mutated).not.toBe(true)
      expect(pending(editor)).toEqual([])
      expect(await save()).toBe(before)
    })
  }
})

describe('a block an untracked AI rewrite gives back as it was keeps its bytes', () => {
  const placeholder = (id: number) =>
    `<w:sdt><w:sdtPr><w:id w:val="${id}"/><w:showingPlcHdr/></w:sdtPr><w:sdtContent>` +
    `${run('Click or tap here to enter text.')}</w:sdtContent></w:sdt>`
  const nested =
    `<w:p>${run('Due on ')}` +
    sdtOf(
      run('5/6/') + `<w:smartTag w:uri="urn:date" w:element="year">${run('2024')}</w:smartTag>`,
      37,
    ) +
    `${run(' at noon')}</w:p>`
  const twins = `<w:p>${run('From ')}${sdt('2024', 17)}${run(' to ')}${sdt('2024', 18)}</w:p>`
  /** the paragraphs of the file, the html the model sends back, the paragraphs it left as they were */
  const SHAPES: Array<[string, string[], string, number[]]> = [
    [
      'two controls that show the same placeholder, in two paragraphs',
      [
        `<w:p>${run('Name: ')}${placeholder(1)}</w:p>`,
        `<w:p>${run('Address: ')}${placeholder(2)}</w:p>`,
      ],
      '<p>Name: Click or tap here to enter text.</p><p>Address: Click or tap here to enter text.</p>',
      [0, 1],
    ],
    [
      'two controls around the same text in one paragraph',
      [twins],
      '<p>From 2024 to 2024</p>',
      [0],
    ],
    [
      'a control whose text also stands outside it',
      [`<w:p>${run('Signed 2024, due ')}${sdt('2024', 12)}</w:p>`],
      '<p>Signed 2024, due 2024</p>',
      [0],
    ],
    [
      'a control around one space',
      [`<w:p>${run('one two')}${sdt(' ', 15)}${run('three')}</w:p>`],
      '<p>one two three</p>',
      [0],
    ],
    [
      'a control around punctuation only',
      [`<w:p>${run('Total ')}${sdt('-', 33)}${run(' units')}</w:p>`],
      '<p>Total - units</p>',
      [0],
    ],
    ['a smart tag inside a control', [nested], '<p>Due on 5/6/2024 at noon</p>', [0]],
    [
      'a control inside a control',
      [`<w:p>${run('Due on ')}${sdtOf(run('5/6/') + sdt('2024', 39), 38)}${run(' at noon')}</w:p>`],
      '<p>Due on 5/6/2024 at noon</p>',
      [0],
    ],
    [
      'two smart tags around the same word',
      [`<w:p>${run('From ')}${smart}${run(' to ')}${smart}</w:p>`],
      '<p>From Paris to Paris</p>',
      [0],
    ],
    [
      'two blocks given back, the wrapped word also standing in the second',
      [`<w:p>${run('Due ')}${sdt('2024', 17)}</w:p>`, `<w:p>${run('Year 2024 again')}</w:p>`],
      '<p>Due 2024</p><p>Year 2024 again</p>',
      [0, 1],
    ],
    [
      'the middle block of three, the other two rewritten',
      [`<w:p>${run('First old')}</w:p>`, twins, `<w:p>${run('Third old')}</w:p>`],
      '<p>First new</p><p>From 2024 to 2024</p><p>Third new</p>',
      [1],
    ],
  ]
  for (const [name, paragraphs, html, untouched] of SHAPES) {
    it(name, async () => {
      const { editor, save } = await open(paragraphs.join('') + TAIL)
      const result = await rewrite(editor, html, false, 'replace_blocks', paragraphs.length - 1)
      expect(result.isError).toBeFalsy()
      const xml = await save()
      for (const index of untouched) expect(xml).toContain(paragraphs[index])
      expect(count(xml, 'sdt>')).toBe(count(paragraphs.join(''), 'sdt>'))
      expect(count(xml, 'smartTag ')).toBe(count(paragraphs.join(''), 'smartTag '))
    })
  }

  it('a locked control that cannot be put back still refuses the rewrite, and the file stays as it was', async () => {
    const locked = `<w:p>${run('From ')}${sdt('2024', 17, true)}${run(' to ')}${sdt('2024', 18, true)}</w:p>`
    const { editor, save } = await open(locked + TAIL)
    const before = await save()
    const result = await rewrite(editor, '<p>From 2024 to 2024</p>')
    expect(result.isError).toBe(true)
    expect(result.mutated).not.toBe(true)
    expect(await save()).toBe(before)
    // the lock still holds in the editor
    editor.commands.insertContentAt(posOf(editor, '024'), 'X')
    expect(texts(editor)).toEqual(['From 2024 to 2024', 'tail'])
  })
})

describe('an untracked AI block rewrite keeps the wrapper it cannot misplace', () => {
  for (const [label, inside, html, tags] of [
    ['unlocked date', control(), '<p>Due on 5/6/2024 at night</p>', ['sdt>']],
    ['smart tag', smart, '<p>Due on Paris at night</p>', ['smartTag ']],
    ['locked date', control(true), '<p>Due on 5/6/2024 at night</p>', ['sdt>']],
  ] as const) {
    it(`keeps ${label} when only outside text changes`, async () => {
      const { editor, save } = await open(body(inside))
      const result = await rewrite(editor, html)
      expect(result.isError).toBeFalsy()
      const xml = await save()
      for (const tag of tags) expect(count(xml, tag)).toBe(1)
      expect(editor.state.doc.textContent).toContain('at night')
      expect(xml).not.toContain('at noon')
      if (label === 'unlocked date') {
        await rewrite(editor, '<p>Due on 5/6/2025 at night</p>')
        const changed = await save()
        for (const tag of tags) expect(count(changed, tag)).toBe(0)
        expect(editor.state.doc.textContent).toContain('5/6/2025')
      }
    })
  }

  it('writes the control of a table cell it left alone once', async () => {
    const { editor, save } = await open(
      '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/>' +
        `<w:gridCol w:w="2000"/></w:tblGrid><w:tr>${cell(control())}${cell(run('noon'))}</w:tr>` +
        `</w:tbl>${TAIL}`,
    )
    const result = await rewrite(editor, '<table><tr><td>5/6/2024</td><td>night</td></tr></table>')
    expect(result.isError).toBeFalsy()
    const xml = await save()
    expect(count(xml, 'sdt>')).toBe(1)
    expect(flat(xml)).toContain('<w:sdtContent>[5/6/2024]</w:sdtContent>')
    expect(editor.state.doc.textContent).toContain('night')
  })

  // where the old rule (the same occurrence, counted from the start) put the
  // structure around other text than it was around
  const MISPLACED: Array<{
    name: string
    inner: (locked: boolean) => string
    html: string
    text: string
    tags: string[]
    lockable: boolean
  }> = [
    {
      name: 'its text also stands inside a number ("5" beside "15")',
      inner: (locked) => run('Order ') + sdt('5', 11, locked) + run(' of 15 items'),
      html: '<p>15 items in order 5</p>',
      text: '15 items in order 5',
      tags: ['sdt>'],
      lockable: true,
    },
    {
      name: 'its text stands twice and the clauses change places',
      inner: (locked) => run('Signed 2024, due ') + sdt('2024', 12, locked),
      html: '<p>Due 2024, signed 2024</p>',
      text: 'Due 2024, signed 2024',
      tags: ['sdt>'],
      lockable: true,
    },
    {
      name: 'it is around one letter of a word',
      inner: (locked) => run('A c') + sdt('a', 16, locked) + run('t sat'),
      html: '<p>a dog sat</p>',
      text: 'a dog sat',
      tags: ['sdt>'],
      lockable: true,
    },
    {
      name: 'it is around a single space',
      inner: (locked) => run('one two') + sdt(' ', 15, locked) + run('three'),
      html: '<p>zero one twothree</p>',
      text: 'zero one twothree',
      tags: ['sdt>'],
      lockable: true,
    },
    {
      name: 'two controls are around the same text',
      inner: (locked) =>
        run('From ') + sdt('2024', 17, locked) + run(' to ') + sdt('2024', 18, locked),
      html: '<p>To 2024 from 2024</p>',
      text: 'To 2024 from 2024',
      tags: ['sdt>'],
      lockable: true,
    },
    {
      name: 'a smart tag is on a word that stands twice ("Paris")',
      inner: () => run('From ') + smart + run(' to Paris'),
      html: '<p>To Paris from Paris</p>',
      text: 'To Paris from Paris',
      tags: ['smartTag '],
      lockable: false,
    },
    {
      name: 'the particle after it changes ("서울에서" becomes "서울은")',
      inner: (locked) => sdt('서울', 31, locked) + run('에서 열립니다'),
      html: '<p>서울은 큽니다</p>',
      text: '서울은 큽니다',
      tags: ['sdt>'],
      lockable: true,
    },
    {
      name: 'a digit is put in front of its number ("5" becomes "15")',
      inner: (locked) => run('Order ') + sdt('5', 32, locked) + run(' of ten'),
      html: '<p>Order 15 of ten</p>',
      text: 'Order 15 of ten',
      tags: ['sdt>'],
      lockable: true,
    },
    {
      name: 'it is around punctuation only ("-")',
      inner: (locked) => run('Total ') + sdt('-', 33, locked) + run(' units'),
      html: '<p>Total - units now</p>',
      text: 'Total - units now',
      tags: ['sdt>'],
      lockable: true,
    },
    {
      name: 'it is around a full stop only',
      inner: (locked) => run('Done') + sdt('.', 34, locked) + run(' Next'),
      html: '<p>Done. Next up</p>',
      text: 'Done. Next up',
      tags: ['sdt>'],
      lockable: true,
    },
    {
      name: 'two controls would land on text that overlaps ("A/" and "/B" in "A/B")',
      inner: (locked) => sdt('A/', 35, locked) + run(' or ') + sdt('/B', 36),
      html: '<p>A/B</p>',
      text: 'A/B',
      tags: ['sdt>'],
      lockable: true,
    },
    {
      name: 'one wrapper lies inside another (a smart tag inside a control)',
      inner: (locked) =>
        run('Due on ') +
        sdtOf(
          run('5/6/') + `<w:smartTag w:uri="urn:date" w:element="year">${run('2024')}</w:smartTag>`,
          37,
          locked,
        ) +
        run(' at noon'),
      html: '<p>Due on 5/6/2024 at night</p>',
      text: 'Due on 5/6/2024 at night',
      tags: ['sdt>', 'smartTag '],
      lockable: true,
    },
  ]
  for (const { name, inner, html, text, tags, lockable } of MISPLACED) {
    it(`drops the structure instead of putting it elsewhere: ${name}`, async () => {
      const { editor, save } = await open(para(inner(false)))
      const result = await rewrite(editor, html)
      expect(result.isError).toBeFalsy()
      const xml = await save()
      for (const tag of tags) expect(count(xml, tag)).toBe(0)
      expect(texts(editor)).toEqual([text, 'tail'])
    })
    if (!lockable) continue
    it(`refuses the rewrite when the control is locked: ${name}`, async () => {
      const { editor, save } = await open(para(inner(true)))
      const before = await save()
      const result = await rewrite(editor, html)
      expect(result.isError).toBe(true)
      expect(result.mutated).not.toBe(true)
      expect(await save()).toBe(before)
    })
  }

  // Korean writes a particle or a counter right after the word, without a space
  for (const locked of [false, true]) {
    const which = locked ? 'a locked control' : 'a control'
    it(`keeps ${which} that a particle follows when the rewrite keeps both ("홍길동님께")`, async () => {
      const { editor, save } = await open(para(sdt('홍길동', 41, locked) + run('님께 보냅니다')))
      const result = await rewrite(editor, '<p>홍길동님께 드립니다</p>')
      expect(result.isError).toBeFalsy()
      expect(flat(await save())).toContain(
        '<w:sdtContent>[홍길동]</w:sdtContent></w:sdt>[님께 드립니다]',
      )
    })

    it(`keeps ${which} around a year and one around a month when only other text changes`, async () => {
      const { editor, save } = await open(
        para(sdt('2024', 42, locked) + run('년 ') + sdt('5', 43, locked) + run('월 회의')),
      )
      const result = await rewrite(editor, '<p>2024년 5월 총회</p>')
      expect(result.isError).toBeFalsy()
      const xml = flat(await save())
      expect(xml).toContain('<w:sdtContent>[2024]</w:sdtContent></w:sdt>[년 ]<w:sdt>')
      expect(xml).toContain('<w:sdtContent>[5]</w:sdtContent></w:sdt>[월 총회]')
    })
  }
})

describe('a tracked AI block rewrite of a paragraph with unlocked wrappers', () => {
  const KINDS: Array<[string, string, string, string[]]> = [
    ['content control', control(), '<p>Due on 5/6/2024 at night</p>', ['sdt>']],
    ['smart tag', smart, '<p>Due on Paris at night</p>', ['smartTag ']],
  ]
  for (const [label, inside, html, tags] of KINDS) {
    it(`${label}: strikes the old text and inserts the new, and the file holds the structure once`, async () => {
      const { editor, save } = await open(body(inside))
      const result = await rewrite(editor, html, true)
      expect(result.isError).toBeFalsy()
      expect(new Set(pending(editor))).toEqual(new Set(['del', 'ins']))
      const xml = await save()
      // a deleted or inserted paragraph is marked inside the paragraph, never around it
      expect(xml).not.toMatch(/<w:(?:del|ins) [^>]*><w:p[ >]/)
      for (const tag of tags) expect(count(xml, tag)).toBe(1)
    })
    it(`${label}: Accept All leaves the new paragraph and nothing pending`, async () => {
      const { editor, save } = await open(body(inside))
      await rewrite(editor, html, true)
      expect(acceptAllRevisions(editor)).toEqual([])
      expect(pending(editor)).toEqual([])
      expect(texts(editor)).toEqual([html.replace(/<\/?p>/g, ''), 'tail'])
      expect(await save()).not.toMatch(/<w:(?:del|ins)\b/)
    })

    it(`${label}: Reject All gives the file back as it was`, async () => {
      const { editor, save } = await open(body(inside))
      const before = await save()
      await rewrite(editor, html, true)
      expect(rejectAllRevisions(editor)).toEqual([])
      expect(pending(editor)).toEqual([])
      expect(await save()).toBe(before)
    })
  }
})

describe('Accept All and Reject All finish a change that takes a locked control whole', () => {
  const FILES: Array<[string, string, string[], string[]]> = [
    [
      'a deletion of all the text of the control, from a file',
      para(
        run('Due on ') +
          sdtOf(`<w:del ${rev(1)}>${struck('5/6/2024')}</w:del>`, 5, true) +
          run(' at noon'),
      ),
      ['Due on  at noon', 'tail'],
      ['Due on 5/6/2024 at noon', 'tail'],
    ],
    [
      'a deleted paragraph that holds the control, from a file',
      `<w:p><w:pPr><w:rPr><w:del ${rev(4)}/></w:rPr></w:pPr><w:del ${rev(1)}>${struck('Due on ')}</w:del>` +
        sdtOf(`<w:del ${rev(2)}>${struck('5/6/2024')}</w:del>`, 5, true) +
        `<w:del ${rev(3)}>${struck(' at noon')}</w:del></w:p>${TAIL}`,
      ['tail'],
      ['Due on 5/6/2024 at noon', 'tail'],
    ],
    [
      'a deleted table row that holds the control, from a file',
      tableWithRow('del'),
      ['before', 'keep', 'tail'],
      ['before', 'keepDue 5/6/2024', 'tail'],
    ],
    [
      'an inserted table row that holds the control, from a file',
      tableWithRow('ins'),
      ['before', 'keepDue 5/6/2024', 'tail'],
      ['before', 'keep', 'tail'],
    ],
  ]
  for (const [name, xml, accepted, rejected] of FILES) {
    for (const mode of ['accept', 'reject'] as const) {
      it(`${name}: ${mode} all`, async () => {
        const { editor, save } = await open(xml)
        expect(pending(editor)).not.toEqual([])
        expect(finish(editor, mode)).toEqual([])
        expect(pending(editor)).toEqual([])
        expect(texts(editor)).toEqual(mode === 'accept' ? accepted : rejected)
        // the text is decided; a paragraph mark's own revision is not this test's
        expect(await save()).not.toMatch(/<w:delText\b|<w:ins\b/)
      })
    }
  }

  for (const mode of ['accept', 'reject'] as const) {
    it(`the control deleted whole by hand with tracking on: ${mode} all`, async () => {
      const { editor, save } = await open(body(control(true)))
      const before = await save()
      const tracking = editor.storage.trackChanges as TrackChangesStorage
      tracking.enabled = true
      tracking.author = 'User'
      const from = posOf(editor, '5/6/2024')
      editor.commands.setTextSelection({ from, to: from + '5/6/2024'.length })
      editor.commands.deleteSelection()
      tracking.enabled = false
      expect(pending(editor)).toEqual(['del'])
      expect(finish(editor, mode)).toEqual([])
      expect(pending(editor)).toEqual([])
      if (mode === 'reject') expect(await save()).toBe(before)
      else {
        expect(texts(editor)).toEqual(['Due on  at noon', 'tail'])
        expect(count(await save(), 'sdt>')).toBe(0)
      }
    })
  }

  it('a deletion of part of its text stays pending on Accept All', async () => {
    const { editor, save } = await open(
      para(
        run('Due on ') +
          sdtOf(run('5/6/') + `<w:del ${rev(1)}>${struck('2024')}</w:del>`, 5, true) +
          run(' at noon'),
      ),
    )
    const before = await save()
    expect(acceptAllRevisions(editor)).toHaveLength(1)
    expect(pending(editor)).toEqual(['del'])
    expect(await save()).toBe(before)
  })
})

describe('rebased wrappers have one saved content-control identity', () => {
  // This bounded two-peer schedule directly exercises the reported race; a
  // separate model would abstract away the ProseMirror mark rebasing at fault.
  for (const bobEdit of ['type', 'Shift-Enter'] as const) {
    it(`Alice splits first while Bob does ${bobEdit} in the second half`, async () => {
      const { editor: alice, make, save } = await open(body(control()))
      const bob = make()
      const peer = (editor: Editor) => {
        const sent: DocsOp[] = []
        const refused: string[] = []
        const adapter = createDocsAdapter({
          editor,
          side: { read: () => new Map(), write() {}, observe: () => () => {} } as never,
          produce: async () => ({ fileName: 'x.docx', bytes: new Uint8Array() }),
          maxOpBytes: 8 * 1024 * 1024 - 4096,
          refused: (reason) => refused.push(reason),
        })
        adapter.listen((ops) => sent.push(...ops))
        return { adapter, sent, refused }
      }
      const a = peer(alice),
        b = peer(bob)
      alice.commands.setTextSelection(posOf(alice, '6/2024'))
      alice.commands.keyboardShortcut('Enter')
      if (bobEdit === 'type') bob.commands.insertContentAt(posOf(bob, '2024'), 'B')
      else {
        bob.commands.setTextSelection(posOf(bob, '2024'))
        bob.commands.keyboardShortcut('Shift-Enter')
      }
      const aOps = a.sent.splice(0),
        bOps = b.sent.splice(0)
      const rebased = b.adapter.integrate(
        aOps.map((op) => b.adapter.decode(a.adapter.encode(op))),
        bOps,
      )
      a.adapter.confirmed?.(aOps)
      a.adapter.integrate(
        rebased.map((op) => a.adapter.decode(b.adapter.encode(op))),
        [],
      )
      b.adapter.confirmed?.(rebased)
      expect(alice.getJSON()).toEqual(bob.getJSON())
      expect(a.sent).toEqual([])
      expect(b.sent).toEqual([])
      expect([...a.refused, ...b.refused]).toEqual([])
      const xml = await save(alice)
      expect(count(xml, 'sdt>')).toBe(1)
      expect(await save(bob)).toBe(xml)
      expect(xml).toContain('1234567')
    })
  }
})
