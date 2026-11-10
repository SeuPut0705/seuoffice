/**
 * What a co-editing page takes from the wire. Every change of a peer passes the adapter's
 * `decode` and then `integrate`; a page run by modified code can send anything, so both must
 * throw on whatever the app itself never sends (the engine then stops this page's session
 * instead of showing the change).
 */
import { describe, expect, it } from 'vitest'
import type { Json } from '@seuoffice/collab/client'
import { suggestionMarkup } from '../src/renderer/highlight/locate'
import { PDFJS_ANNOT_TEXT, toSavedNote } from '../src/renderer/note-threads'
import { signatureDrawingForField } from '../src/renderer/signature-field'
import { DEFAULT_HEADER_FOOTER, DEFAULT_WATERMARK } from '../src/renderer/stamps'
import type { DrawingInput, FormFieldInput } from '../src/shared/ipc'
import { addBlankPage, draw, highlight, ink, note, picture, stamp } from './collab/actions'
import { Room, blankFile, fileBytes, openHeadless, type HeadlessPdf } from './collab/headless'
import { DATE_FORMATS } from '../src/renderer/FormDesignLayer'
import { dateFormatFromActions } from '../src/renderer/date-format'
import { WireError } from '../src/web/collab-wire'

const PAGES = 3
const open = () => openHeadless(fileBytes(blankFile(PAGES)))

/** decode one change holding `puts`, then integrate it, as the engine does with a peer's change */
function take(...puts: unknown[]): void {
  const page = open()
  page.adapter.listen(() => {})
  page.adapter.integrate([page.adapter.decode({ id: 'peer-1', puts } as Json)], [])
}

const RED = [1, 0, 0]
const rect = (extra: Record<string, unknown> = {}, id = 'd1') => ({
  b: 'drawings',
  id,
  v: {
    id,
    input: { kind: 'rect', pageIndex: 0, color: RED, width: 2, rect: [0, 0, 10, 10] },
    ...extra,
  },
})
const drawing = (input: Record<string, unknown>, id = 'd1') => ({
  b: 'drawings',
  id,
  v: { id, input: { pageIndex: 0, ...input } },
})
const link = (target: Record<string, unknown>) =>
  drawing({ kind: 'link', rect: [0, 0, 40, 12], ...target })
const savedNote = {
  pageIndex: 0,
  objNum: 7,
  type: 'note',
  rect: [0, 0, 20, 20],
  color: null,
  author: 'A',
  contents: 'on disk',
  timeMs: null,
  inReplyTo: null,
}
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'

describe('what the app itself sends is taken', () => {
  it.each([
    ['a rectangle', rect()],
    ['an ellipse', drawing({ kind: 'ellipse', color: RED, width: 1, rect: [0, 0, 5, 5] })],
    ['ink', drawing({ kind: 'ink', color: RED, width: 2, paths: [[1, 1, 2, 2, 3, 3]] })],
    ['a line', drawing({ kind: 'line', color: RED, width: 1, from: [0, 0], to: [9, 9] })],
    ['an arrow', drawing({ kind: 'arrow', color: RED, width: 1, from: [0, 0], to: [9, 9] })],
    [
      'a measurement',
      drawing({ kind: 'measure', color: RED, width: 1, from: [0, 0], to: [9, 9], label: '2.35 m' }),
    ],
    ['a caret', drawing({ kind: 'caret', color: RED, point: [5, 5] })],
    [
      'a polygon',
      drawing({
        kind: 'polygon',
        color: RED,
        width: 1,
        vertices: [
          [0, 0],
          [5, 0],
          [5, 5],
        ],
      }),
    ],
    ['a picture stamp', drawing({ kind: 'image', image: PNG, rect: [0, 0, 50, 20] })],
    [
      'a signature in a field',
      {
        b: 'drawings',
        id: 'd1',
        v: {
          id: 'd1',
          input: {
            kind: 'image',
            pageIndex: 0,
            image: PNG,
            rect: [0, 0, 5, 5],
            formFieldName: 'sig',
          },
          formWidgetId: '12R',
        },
      },
    ],
    [
      'a note',
      drawing({
        kind: 'note',
        color: RED,
        at: [4, 4],
        contents: 'hello',
        author: 'Kim',
        createdMs: 1_700_000_000_000,
        localId: 'd1',
      }),
    ],
    [
      'a reply to a saved note',
      drawing({
        kind: 'note',
        color: RED,
        at: [4, 4],
        contents: 'yes',
        localId: 'd1',
        replyToSaved: { objNum: 7, rect: [0, 0, 20, 20], contents: 'on disk' },
      }),
    ],
    ['a link to a web page', link({ url: 'https://example.com/a?b=c#d' })],
    ['a link to a plain http page', link({ url: 'http://example.com' })],
    ['a link to a mail address', link({ url: 'mailto:someone@example.com' })],
    ['a link to a page', link({ destPage: 2 })],
    [
      'a highlight',
      {
        b: 'markups',
        id: 'm1',
        v: {
          id: 'm1',
          pageIndex: 1,
          type: 'highlight',
          color: [1, 0.9, 0.3],
          quads: [[0, 10, 50, 10, 0, 0, 50, 0]],
          subject: 'key point',
        },
      },
    ],
    [
      'a saved note rewritten',
      { b: 'noteEdits', id: 'n1', v: { id: 'n1', annot: savedNote, contents: 'new' } },
    ],
    [
      'a form field',
      {
        b: 'formFields',
        id: 'f1',
        v: {
          id: 'f1',
          input: {
            name: 'city',
            kind: 'choice',
            pageIndex: 2,
            rect: [20, 20, 120, 40],
            required: true,
            options: ['Seoul', 'Busan'],
            value: 'Seoul',
          },
        },
      },
    ],
    [
      'a filled field',
      { b: 'formEdits', k: 'name', v: { name: 'name', kind: 'text', value: 'Kim' } },
    ],
    [
      'a field of the file moved',
      {
        b: 'formWidgetEdits',
        k: '12R',
        v: { widgetId: '12R', fieldName: 'name', rect: [0, 0, 9, 9] },
      },
    ],
    [
      'a watermark and a footer',
      {
        b: 'stampCfg',
        v: {
          wm: { text: 'DRAFT', angle: 35, opacity: 0.2, color: '#d0342c', sizeRatio: 0.11 },
          hf: {
            headerLeft: '',
            headerCenter: 'Report',
            headerRight: '',
            footerLeft: '',
            footerCenter: '',
            footerRight: '',
            pageNumber: true,
            startAt: 1,
            fontSize: 10,
            color: '#666666',
          },
        },
      },
    ],
    [
      'document info',
      { b: 'metadata', v: { title: 'T', author: 'A', subject: '', keywords: 'k' } },
    ],
    ['a quarter turn', { b: 'rotations', k: 1, v: 90, was: 0 }],
    ['a deleted page', { b: 'deleted', k: 2, v: true }],
    ['a new order', { b: 'order', v: [2, 0, 1], was: [0, 1, 2] }],
    ['something removed', { b: 'drawings', id: 'gone', v: null }],
  ])('%s', (_name, put) => {
    expect(() => take(put)).not.toThrow()
  })

  it('a blank page with its place in the order', () => {
    expect(() =>
      take(
        {
          b: 'blankPages',
          id: 'b1',
          v: { id: 'b1', input: { pageIndex: 3, width: 595, height: 842 } },
        },
        { b: 'order', v: [0, 3, 1, 2], was: [0, 1, 2] },
      ),
    ).not.toThrow()
  })
})

describe('what co-editing refuses a person is not taken from a peer either', () => {
  it.each([
    [
      'a text edit',
      {
        b: 'textEdits',
        id: 't1',
        v: {
          id: 't1',
          input: { pageIndex: 0, rect: [0, 0, 9, 9], oldText: 'a', newText: 'b', fontSize: 10 },
        },
      },
    ],
    [
      'added text',
      {
        b: 'textInserts',
        id: 't1',
        v: { id: 't1', input: { pageIndex: 0, at: [5, 5], text: 'x', fontSize: 10 } },
      },
    ],
    [
      'an image edit',
      {
        b: 'imageEdits',
        id: 'i1',
        v: { id: 'i1', input: { kind: 'delete', pageIndex: 0, rect: [0, 0, 9, 9] } },
      },
    ],
    [
      'a saved annotation removed',
      { b: 'annotDeletes', id: 'a1', v: { id: 'a1', annot: savedNote } },
    ],
    ['the removal of a text edit', { b: 'textEdits', id: 't1', v: null }],
  ])('%s', (_name, put) => {
    expect(() => take(put)).toThrow()
  })
})

describe('shapes the app does not make are not taken', () => {
  it.each([
    [
      'a drawing of an unknown kind',
      drawing({ kind: 'insertImage', rect: [0, 0, 9, 9], image: 'x' }),
    ],
    [
      'a drawing with a field the app does not write',
      rect({ html: '<img src=x onerror=alert(1)>' }),
    ],
    [
      'a drawing whose input has a field the app does not write',
      drawing({ kind: 'rect', color: RED, width: 2, rect: [0, 0, 1, 1], onclick: 'x' }),
    ],
    [
      'a colour outside 0..1',
      drawing({ kind: 'rect', color: [2, 0, 0], width: 2, rect: [0, 0, 1, 1] }),
    ],
    [
      'a rectangle that is not four numbers',
      drawing({ kind: 'rect', color: RED, width: 2, rect: [0, 0, 1] }),
    ],
    [
      'a coordinate that is not a finite number',
      drawing({ kind: 'caret', color: RED, point: [0, '1'] }),
    ],
    [
      'a picture that is not base64 PNG',
      drawing({ kind: 'image', image: 'data:text/html,<p>', rect: [0, 0, 5, 5] }),
    ],
    [
      'a picture of another format',
      drawing({ kind: 'image', image: '/9j/4AAQSkZJRgABAQ', rect: [0, 0, 5, 5] }),
    ],
    [
      'a markup of an unknown type',
      {
        b: 'markups',
        id: 'm',
        v: { id: 'm', pageIndex: 0, type: 'blink', color: RED, quads: [[0, 0, 0, 0, 0, 0, 0, 0]] },
      },
    ],
    [
      'a markup quad that is not eight numbers',
      {
        b: 'markups',
        id: 'm',
        v: { id: 'm', pageIndex: 0, type: 'highlight', color: RED, quads: [[0, 0]] },
      },
    ],
    [
      'a form field of an unknown kind',
      {
        b: 'formFields',
        id: 'f',
        v: { id: 'f', input: { name: 'n', kind: 'script', pageIndex: 0, rect: [0, 0, 9, 9] } },
      },
    ],
    [
      'a filled field under another name than its own',
      { b: 'formEdits', k: 'a', v: { name: 'b', kind: 'text', value: '' } },
    ],
    [
      'a watermark colour that is not a hex colour',
      {
        b: 'stampCfg',
        v: {
          wm: { text: 'x', angle: 0, opacity: 1, color: 'url(https://x)', sizeRatio: 0.1 },
          hf: null,
        },
      },
    ],
    [
      'document info with a field the app does not write',
      { b: 'metadata', v: { title: 'T', producer: 'x' } },
    ],
    ['a turn that is not a quarter turn', { b: 'rotations', k: 0, v: 45, was: 0 }],
    [
      'a note edit of something that is not a note',
      {
        b: 'noteEdits',
        id: 'n',
        v: { id: 'n', annot: { ...savedNote, type: 'highlight' }, contents: 'x' },
      },
    ],
    ['a put with a field the app does not write', { ...rect(), also: 1 }],
  ])('%s', (_name, put) => {
    expect(() => take(put)).toThrow()
  })

  it('a change that is not a list of edits', () => {
    const page = open()
    expect(() => page.adapter.decode({ id: 'x', puts: 'none' } as Json)).toThrow()
    expect(() => page.adapter.decode({ id: 7, puts: [] } as Json)).toThrow()
    expect(() => page.adapter.decode({ id: 'x', puts: [], extra: true } as Json)).toThrow()
  })

  const dateFieldPut = (dateFormat: string) => ({
    b: 'formFields',
    id: 'f',
    v: {
      id: 'f',
      input: { name: 'd', kind: 'text', pageIndex: 0, rect: [10, 60, 200, 90], dateFormat },
    },
  })

  it.each([
    'y) >> /Fo << /S /JavaScript /JS (app.alert(1)) >> /Zz << /JS (',
    ')) >> /Fo << /S /JavaScript /JS (app.alert(1)) >> /Zz << /JS ((',
    '',
    'yyyy\\mm',
    'yyyy"mm',
    "yyyy'mm",
    'yyyy\nmm',
    'yyyy\u0000mm',
    'yyyy\u2028mm',
    'yyyy<mm>',
    'y'.repeat(65),
  ])('a date format no file carries is not taken: %j', (dateFormat) => {
    const page = open()
    expect(() =>
      page.adapter.decode({ id: 'x', puts: [dateFieldPut(dateFormat)] } as Json),
    ).toThrow(WireError)
  })

  /** Acrobat's legacy AFDate_Keystroke(n) formats, as date-format.ts reads them from a file */
  const legacy: string[] = []
  for (let n = 0; ; n++) {
    const format = dateFormatFromActions({ Keystroke: [`AFDate_Keystroke(${n});`] })
    if (format === null) break
    legacy.push(format)
  }

  it.each([
    ...DATE_FORMATS,
    ...legacy,
    'dd.mm.yyyy',
    'yyyy-mm-dd HH:MM',
    'm/d/yyyy h:MM tt',
    'yyyy년 mm월 dd일',
    'yyyy年mm月dd日',
  ])('a date field of a format a file carries travels to a peer: %j', (format) => {
    expect(dateFormatFromActions({ Format: [`AFDate_FormatEx("${format}");`] })).toBe(format)
    const room = new Room()
    const a = room.join()
    const b = room.join()
    const field: FormFieldInput = {
      name: 'Date 1',
      kind: 'text',
      pageIndex: 0,
      rect: [10, 60, 200, 90],
      dateFormat: format,
    }
    expect(a.app.apply([{ op: 'addFormField', field }]).failures).toEqual([])
    expect(a.app.refusals).toEqual([])
    room.settle(a)
    expect(b.app.state.formFields.map((f) => f.input.dateFormat)).toEqual([format])
  })
})

describe('a link goes only where the app opens links', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'ftp://example.com/file',
    'smb://server/share',
    'https://',
    'not a url',
    '',
  ])('%s is not taken', (url) => {
    expect(() => take(link({ url }))).toThrow()
  })

  it('a link needs exactly one target', () => {
    expect(() => take(link({}))).toThrow()
    expect(() => take(link({ url: 'https://example.com', destPage: 1 }))).toThrow()
    expect(() => take(link({ destPage: 0 }))).toThrow()
    expect(() => take(link({ destPage: 1.5 }))).toThrow()
  })

  it('an address longer than any real one is not taken', () => {
    expect(() => take(link({ url: `https://example.com/${'a'.repeat(5000)}` }))).toThrow()
  })
})

describe('one change cannot be made large enough to hang a page', () => {
  it('more edits than one change of a person ever holds', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => ({ b: 'drawings', id: `d${i}`, v: null }))
    const page = open()
    expect(() => page.adapter.decode({ id: 'x', puts: many } as Json)).toThrow()
  })

  it('an ink stroke of more points than a hand draws', () => {
    const stroke = Array.from({ length: 600_000 }, (_, i) => i % 500)
    expect(() => take(drawing({ kind: 'ink', color: RED, width: 2, paths: [stroke] }))).toThrow()
  })

  it('ink of many strokes that together hold as many points', () => {
    const stroke = Array.from({ length: 1000 }, (_, i) => i % 500)
    const paths = Array.from({ length: 600 }, () => stroke)
    expect(() => take(drawing({ kind: 'ink', color: RED, width: 2, paths }))).toThrow()
  })

  it('an ink stroke with an odd number of coordinates', () => {
    expect(() => take(drawing({ kind: 'ink', color: RED, width: 2, paths: [[1, 2, 3]] }))).toThrow()
  })

  it('a note longer than a comment', () => {
    const contents = 'x'.repeat(400_000)
    expect(() => take(drawing({ kind: 'note', color: RED, at: [1, 1], contents }))).toThrow()
  })

  it('a polygon of more corners than a person clicks', () => {
    const vertices = Array.from({ length: 50_000 }, (_, i) => [i % 100, i % 90])
    expect(() => take(drawing({ kind: 'polygon', color: RED, width: 1, vertices }))).toThrow()
  })

  it('a markup of more rectangles than a page of text has', () => {
    const quads = Array.from({ length: 100_000 }, () => [0, 1, 1, 1, 0, 0, 1, 0])
    expect(() =>
      take({
        b: 'markups',
        id: 'm',
        v: { id: 'm', pageIndex: 0, type: 'highlight', color: RED, quads },
      }),
    ).toThrow()
  })

  it('an id, a field name or a label longer than the app makes', () => {
    expect(() => take(rect({}, 'd'.repeat(500)))).toThrow()
    expect(() => take({ b: 'formEdits', k: 'n'.repeat(5000), v: null })).toThrow()
    expect(() =>
      take(
        drawing({
          kind: 'measure',
          color: RED,
          width: 1,
          from: [0, 0],
          to: [1, 1],
          label: 'x'.repeat(65),
        }),
      ),
    ).toThrow()
  })

  it('a page order longer than any document', () => {
    const order = Array.from({ length: 500_000 }, (_, i) => i)
    expect(() => take({ b: 'order', v: order, was: [0, 1, 2] })).toThrow()
  })

  it('a choice field with more options than a list holds', () => {
    const options = Array.from({ length: 50_000 }, (_, i) => `o${i}`)
    expect(() =>
      take({
        b: 'formFields',
        id: 'f',
        v: {
          id: 'f',
          input: { name: 'n', kind: 'choice', pageIndex: 0, rect: [0, 0, 9, 9], options },
        },
      }),
    ).toThrow()
  })
})

describe('a change must fit the document it lands on', () => {
  it('nothing goes on a page the document does not have', () => {
    expect(() =>
      take(drawing({ kind: 'rect', pageIndex: 3, color: RED, width: 2, rect: [0, 0, 1, 1] })),
    ).toThrow()
    expect(() => take({ b: 'rotations', k: 9, v: 90, was: 0 })).toThrow()
    expect(() => take({ b: 'deleted', k: 9, v: true })).toThrow()
  })

  it('nothing goes on a page that was deleted', () => {
    expect(() => take({ b: 'deleted', k: 0, v: true }, rect())).toThrow()
  })

  it('the last page cannot be deleted', () => {
    expect(() =>
      take(
        { b: 'deleted', k: 0, v: true },
        { b: 'deleted', k: 1, v: true },
        { b: 'deleted', k: 2, v: true },
      ),
    ).toThrow()
  })

  it('a blank page takes the next page index and no other', () => {
    const blank = (pageIndex: number) => ({
      b: 'blankPages',
      id: 'b1',
      v: { id: 'b1', input: { pageIndex, width: 595, height: 842 } },
    })
    expect(() => take(blank(7), { b: 'order', v: [0, 1, 2, 7], was: [0, 1, 2] })).toThrow()
    expect(() => take(blank(1))).toThrow()
    // and it stays: only a deleted flag takes a page away
    expect(() => take({ b: 'blankPages', id: 'b1', v: null })).toThrow()
  })

  it('an order lists every page once', () => {
    expect(() => take({ b: 'order', v: [0, 1], was: [0, 1, 2] })).toThrow()
    expect(() => take({ b: 'order', v: [0, 1, 1], was: [0, 1, 2] })).toThrow()
    expect(() => take({ b: 'order', v: [0, 1, 5], was: [0, 1, 2] })).toThrow()
  })
})

describe('a person’s own change that a peer would not take is not sent', () => {
  it('a link somewhere the app does not open is refused with a reason, and the page shows no link', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    draw(a.app, { kind: 'link', pageIndex: 0, rect: [0, 0, 40, 12], url: 'ftp://example.com/x' })
    expect(a.app.refusals).toEqual([{ kind: 'unshareable', why: 'link' }])
    expect(a.app.state.drawings).toEqual([])
    expect(a.local).toEqual([])
    // the same person can go on
    expect(
      draw(a.app, { kind: 'link', pageIndex: 0, rect: [0, 0, 40, 12], url: 'https://example.com' }),
    ).toBe(true)
    room.settle(a)
    expect(b.app.state.drawings).toHaveLength(1)
  })

  it('a comment longer than a peer takes is refused with a reason', () => {
    const page = openHeadless(fileBytes(blankFile(PAGES)), { maxOpBytes: 8 * 1024 * 1024 })
    const sent: unknown[] = []
    page.adapter.listen((ops) => sent.push(...ops))
    draw(page.app, note(0, 'x'.repeat(400_000)))
    expect(page.app.refusals).toEqual([{ kind: 'unshareable', why: 'size' }])
    expect(page.app.state.drawings).toEqual([])
    expect(sent).toEqual([])
  })

  it('everything else a person does still travels', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    highlight(a.app, 0)
    draw(a.app, ink(1))
    draw(a.app, note(2, 'hello'))
    draw(a.app, stamp(0, 400))
    room.settle(a)
    expect(a.app.refusals).toEqual([])
    expect(b.print()).toBe(a.print())
  })
})

describe('what the app’s own builders and edit ops make travels to a peer', () => {
  /** `act` on one page of a room of two; nothing is refused and the peer ends the same */
  function travels(act: (app: HeadlessPdf) => void): void {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    act(a.app)
    expect(a.app.refusals).toEqual([])
    expect(a.local.length).toBeGreaterThan(0)
    room.settle(a)
    expect(b.print()).toBe(a.print())
  }
  const widget = { id: '31R', fieldName: 'approval', pageIndex: 1, rect: [100, 100, 260, 160] }

  it('a picture signature fitted into a signature field', () => {
    travels((app) => {
      const drawing = signatureDrawingForField(
        { kind: 'image', image: picture(600), width: 400, height: 100 },
        widget as never,
        [0, 0, 0],
      )
      expect(app.apply([{ op: 'addDrawing', drawing, formWidgetId: widget.id }]).failures).toEqual(
        [],
      )
    })
  })

  it('a drawn signature fitted into a signature field', () => {
    travels((app) => {
      const sig = {
        kind: 'draw',
        paths: [
          [0, 0, 10, 12, 20, 3.5],
          [5, 5, 9, 9],
        ],
        width: 40,
        height: 20,
      }
      const drawing = signatureDrawingForField(sig as never, widget as never, [0.1, 0.1, 0.4])
      expect(drawing.kind).toBe('ink')
      expect(app.apply([{ op: 'addDrawing', drawing, formWidgetId: widget.id }]).failures).toEqual(
        [],
      )
    })
  })

  it('a saved note as pdf.js reads it, rewritten, and a reply to it', () => {
    travels((app) => {
      const annot = toSavedNote(
        {
          id: '12R',
          annotationType: PDFJS_ANNOT_TEXT,
          rect: [10.5, 700.25, 30.5, 720.25],
          color: new Uint8ClampedArray([255, 200, 33]),
          titleObj: { str: '김 검토' },
          contentsObj: { str: 'on disk' },
          creationDate: "D:20260812175959+09'00'",
        },
        0,
      )!
      expect(
        app.apply([
          { op: 'editSavedNote', annot, contents: 'rewritten' },
          {
            op: 'addDrawing',
            drawing: {
              kind: 'note',
              pageIndex: 0,
              color: annot.color ?? [1, 0.78, 0.13],
              at: [annot.rect[0], annot.rect[3]],
              contents: 'a reply',
              author: undefined,
              createdMs: Date.now(),
              replyToSaved: { objNum: annot.objNum, rect: annot.rect, contents: annot.contents },
            },
          },
        ]).failures,
      ).toEqual([])
    })
  })

  it('a note without a colour or a date in the file', () => {
    travels((app) => {
      const annot = toSavedNote(
        { id: '7R', annotationType: PDFJS_ANNOT_TEXT, rect: [0, 0, 20, 20] },
        2,
      )!
      expect(
        app.apply([{ op: 'editSavedNote', annot, contents: 'now with words' }]).failures,
      ).toEqual([])
    })
  })

  it('an accepted AI highlight', () => {
    travels((app) => {
      const markup = suggestionMarkup({
        found: {
          origIdx: 1,
          rects: [
            [72, 700, 300, 712],
            [72, 686, 180, 698],
          ],
        },
        label: { name: '핵심 주장', color: [1, 0.87, 0.35] },
      } as never)!
      expect(app.apply([{ op: 'addMarkup', markup }]).failures).toEqual([])
    })
  })

  it('every drawing tool, then moved', () => {
    travels((app) => {
      const drawings: DrawingInput[] = [
        {
          kind: 'rect',
          pageIndex: 0,
          color: [0.86, 0.22, 0.18],
          width: 2,
          rect: [10, 10, 60.5, 40.25],
        },
        { kind: 'ellipse', pageIndex: 0, color: [0, 0, 0], width: 1, rect: [10, 10, 60, 40] },
        // DrawLayer makes the three line tools one way: a line and an arrow carry the empty
        // label a measurement gets filled in
        ...(['line', 'arrow'] as const).map(
          (kind) =>
            ({
              kind,
              pageIndex: 1,
              color: [0, 0, 0],
              width: 1.5,
              from: [0, 0],
              to: [50, 50],
              label: '',
            }) as DrawingInput,
        ),
        {
          kind: 'measure',
          pageIndex: 1,
          color: [0, 0, 0],
          width: 1,
          from: [0, 0],
          to: [72, 0],
          label: '2.54 cm',
        },
        { kind: 'caret', pageIndex: 2, color: [0.86, 0.22, 0.18], point: [100, 100] },
        {
          kind: 'polygon',
          pageIndex: 2,
          color: [0, 0, 0],
          width: 1,
          vertices: [
            [0, 0],
            [30, 0],
            [15, 20],
          ],
        },
        { kind: 'link', pageIndex: 0, rect: [0, 0, 40, 12], destPage: 3 },
        { kind: 'link', pageIndex: 0, rect: [0, 20, 40, 32], url: 'https://www.example.com' },
        ink(0),
        stamp(1, 300),
      ]
      for (const drawing of drawings) {
        expect(app.apply([{ op: 'addDrawing', drawing }]).failures).toEqual([])
      }
      for (const d of app.state.drawings) {
        expect(app.apply([{ op: 'moveDrawing', id: d.id, dx: 3.25, dy: -7.5 }]).failures).toEqual(
          [],
        )
      }
      const picture = app.state.drawings.find((d) => d.input.kind === 'image')!
      expect(
        app.apply([{ op: 'setDrawingRect', id: picture.id, rect: [5, 5, 205, 105] }]).failures,
      ).toEqual([])
    })
  })

  it('form design: every field kind, a patch that clears a value, a field of the file moved and removed', () => {
    travels((app) => {
      const rect: [number, number, number, number] = [20, 20, 160, 44]
      const fields: FormFieldInput[] = [
        {
          name: 'Text 1',
          kind: 'text',
          pageIndex: 0,
          rect,
          multiLine: true,
          maxLen: 40,
          fontSize: 11,
        },
        {
          name: 'Date 1',
          kind: 'text',
          pageIndex: 0,
          rect,
          dateFormat: 'yyyy-mm-dd',
          textAlignment: 'center',
        },
        { name: 'Check 1', kind: 'checkbox', pageIndex: 1, rect, checked: true, required: true },
        { name: 'Group 1', kind: 'radio', pageIndex: 1, rect, exportValue: 'Choice 1' },
        {
          name: 'List 1',
          kind: 'choice',
          pageIndex: 2,
          rect,
          options: ['Option 1', 'Option 2'],
          value: 'Option 2',
        },
        { name: 'Sign 1', kind: 'signature', pageIndex: 2, rect },
      ]
      for (const input of fields) {
        expect(app.apply([{ op: 'addFormField', field: input }]).failures).toEqual([])
      }
      const list = app.state.formFields.find((f) => f.input.kind === 'choice')!
      expect(
        app.apply([
          // the selected option goes away: the reducer leaves `value` undefined
          { op: 'patchFormField', id: list.id, input: { options: ['Option 1', 'Option 3'] } },
          {
            op: 'editFormWidget',
            widgetId: '31R',
            fieldName: 'approval',
            input: { rect, required: true },
          },
          { op: 'editFormWidget', widgetId: '44R', fieldName: 'old', input: { remove: true } },
          { op: 'setFormValue', value: { name: 'agree', kind: 'checkbox', checked: true } },
          { op: 'setFormValue', value: { name: 'city', kind: 'choice', value: '' } },
        ]).failures,
      ).toEqual([])
    })
  })

  it('a watermark with a footer, document info, and a blank page', () => {
    travels((app) => {
      expect(
        app.apply([
          {
            op: 'setStamps',
            cfg: { wm: { ...DEFAULT_WATERMARK, text: '대외비' }, hf: DEFAULT_HEADER_FOOTER },
          },
          {
            op: 'setMetadata',
            metadata: { title: '계획', author: '', subject: 'Q3', keywords: 'a, b' },
          },
        ]).failures,
      ).toEqual([])
      expect(addBlankPage(app, 0)).toBe(true)
    })
  })
})
