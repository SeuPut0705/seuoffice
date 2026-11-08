/**
 * The note buttons (reading-assist spec 4.9, 10.10): what "Add to note" sends
 * for a card, a panel item and an overview section (text parts, the file's
 * own page, no path), "Open note" and "Add to note" calling their channels,
 * the buttons off with "Save the PDF first" on an unsaved PDF, the notices,
 * and the panel's item buttons composed with another feature's.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@genoffice/i18n'
import { strings } from '../src/renderer/i18n/strings'
import type { TFunc } from '../src/renderer/i18n/locale'
import type { PdfNoteInsertRequest, PdfNoteResult } from '../src/shared/ipc'
import { AnnotPanel } from '../src/renderer/annot-panel/AnnotPanel'
import type { AnnotItem } from '../src/renderer/annot-panel/items'
import {
  NoteOpenBar,
  NoteOpenRibbonButton,
  joinActions,
  noteInsertAction,
  useNoteActions,
  type NoteActions,
  type NoteApi,
} from '../src/renderer/notes/NoteActions'
import {
  annotNoteRequest,
  cardNoteRequest,
  noteResultNotice,
  overviewNoteRequest,
} from '../src/renderer/notes/note-requests'

const translate = createI18n(strings)
const t: TFunc = (key, params) => translate('en', key, params)

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const item = (o: Partial<AnnotItem> & Pick<AnnotItem, 'key'>): AnnotItem => ({
  kind: 'highlight',
  kindLabel: 'Highlight',
  origin: 'saved',
  page: 2,
  pageNo: 3,
  rect: [100, 688, 200, 700],
  pos: [0, 0],
  seq: 0,
  color: [1, 0.87, 0.35],
  text: 'marked text',
  createdMs: 1,
  notFound: false,
  target: { type: 'location' },
  ...o,
})

describe('what "Add to note" sends', () => {
  it('a card: its passage, its answer, the page found by fingerprint (else the stored one)', () => {
    const card = { excerpt: 'the passage', text: 'the answer', page: 4 }
    expect(cardNoteRequest(card, 6)).toEqual({
      kind: 'quote',
      excerpt: 'the passage',
      page: 7,
      body: 'the answer',
    })
    expect(cardNoteRequest(card, null).page).toBe(4)
  })

  it('a markup: the marked text on the file’s page (original index + 1), no body', () => {
    expect(annotNoteRequest(item({ key: 'S1', page: 2, pageNo: 9 }))).toEqual({
      kind: 'quote',
      excerpt: 'marked text',
      page: 3,
    })
  })

  it('a note: the memo and its replies as the body', () => {
    expect(
      annotNoteRequest(
        item({ key: 'S2', kind: 'note', text: 'a', memo: 'a memo', replyTexts: ['re 1', ' '] }),
      ),
    ).toEqual({ kind: 'quote', excerpt: '', page: 3, body: 'a memo\n\nre 1' })
  })

  it('a card item: passage and whole answer', () => {
    expect(
      annotNoteRequest(item({ key: 'Cc', kind: 'card', text: 'p', body: 'answer\nmore' })),
    ).toEqual({ kind: 'quote', excerpt: 'p', page: 3, body: 'answer\nmore' })
  })

  it('nothing for drawings, suggestions, unknown or lost places', () => {
    expect(annotNoteRequest(item({ key: 'O1', kind: 'other', text: '' }))).toBeNull()
    expect(annotNoteRequest(item({ key: 'G1', kind: 'suggestion' }))).toBeNull()
    expect(annotNoteRequest(item({ key: 'S3', page: null, pageNo: null }))).toBeNull()
    expect(annotNoteRequest(item({ key: 'C2', kind: 'card', notFound: true }))).toBeNull()
  })

  it('an overview section: under the overview heading', () => {
    expect(overviewNoteRequest({ text: '- one\n- two' }, 'Document overview')).toEqual({
      kind: 'overview',
      heading: 'Document overview',
      body: '- one\n- two',
    })
    expect(overviewNoteRequest({ text: ' ' }, 'Document overview')).toBeNull()
  })

  it('never carries a path', () => {
    const requests = [
      cardNoteRequest({ excerpt: 'a', text: 'b', page: 1 }, 0, 'T'),
      annotNoteRequest(item({ key: 'S1' }), 'T'),
      overviewNoteRequest({ text: 'x' }, 'H', 'T'),
    ]
    for (const r of requests) {
      expect(Object.keys(r ?? {}).some((key) => /path/i.test(key))).toBe(false)
    }
  })
})

describe('noteResultNotice', () => {
  it('says why, or nothing for a cancelled dialog or a second click', () => {
    expect(noteResultNotice({ ok: true }, t, 'insert')).toBe('Added to the note')
    expect(noteResultNotice({ ok: true }, t, 'open')).toBeNull()
    expect(noteResultNotice({ ok: false, reason: 'unsaved' }, t, 'open')).toBe('Save the PDF first')
    expect(noteResultNotice({ ok: false, reason: 'unavailable' }, t, 'open')).toMatch(/inside/)
    expect(noteResultNotice({ ok: false, reason: 'cancelled' }, t, 'open')).toBeNull()
    expect(noteResultNotice({ ok: false, reason: 'busy' }, t, 'insert')).toBeNull()
    expect(noteResultNotice({ ok: false, reason: 'failed', message: 'EACCES' }, t, 'open')).toBe(
      'The note could not be opened. EACCES',
    )
  })
})

// ── on screen ──

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function fakeApi(o: { untitled?: boolean; result?: PdfNoteResult } = {}) {
  const state = { unsaved: o.untitled === true }
  const api = {
    noteOpen: vi.fn(async (_request?: { title?: string }) => o.result ?? { ok: true }),
    noteInsert: vi.fn(async (_request: PdfNoteInsertRequest) => o.result ?? { ok: true }),
    noteUnsaved: vi.fn(async () => state.unsaved),
  } satisfies NoteApi
  return Object.assign(api, { state })
}

async function mountButtons(
  api: NoteApi,
  filePath: string,
  notices: string[],
  request: PdfNoteInsertRequest | null = { kind: 'quote', excerpt: 'x', page: 1 },
  savedRev = 0,
): Promise<void> {
  function Harness() {
    const actions: NoteActions = useNoteActions({
      filePath,
      savedRev,
      title: 'A Study',
      t,
      onNotice: (m) => notices.push(m),
      api,
    })
    useEffect(() => {}, [])
    return createElement(
      'div',
      null,
      createElement(NoteOpenRibbonButton, { actions, t }),
      createElement(NoteOpenBar, { actions, t }),
      noteInsertAction(actions, request, t, 'pdf-modal-btn'),
    )
  }
  await act(async () => {
    root.render(createElement(Harness))
  })
  await act(async () => {})
}

const buttons = (action: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>(`button[data-action="${action}"]`))

describe('note buttons', () => {
  it('"Open note" (ribbon and panel) calls the open channel with the title only', async () => {
    const api = fakeApi()
    const notices: string[] = []
    await mountButtons(api, 'C:\\d\\a.pdf', notices)
    const open = buttons('note-open')
    expect(open).toHaveLength(2)
    for (const b of open) {
      expect(b.disabled).toBe(false)
      await act(async () => b.click())
    }
    expect(api.noteOpen).toHaveBeenCalledTimes(2)
    expect(api.noteOpen).toHaveBeenLastCalledWith({ title: 'A Study' })
    expect(api.noteInsert).not.toHaveBeenCalled()
    expect(notices).toEqual([])
  })

  it('"Add to note" calls the insert channel with the item’s parts and says it is done', async () => {
    const api = fakeApi()
    const notices: string[] = []
    await mountButtons(api, 'C:\\d\\a.pdf', notices, { kind: 'quote', excerpt: 'q', page: 5 })
    const [insert] = buttons('note-insert')
    expect(insert.textContent).toBe('Add to note')
    await act(async () => insert.click())
    expect(api.noteInsert).toHaveBeenCalledWith({
      kind: 'quote',
      excerpt: 'q',
      page: 5,
      title: 'A Study',
    })
    expect(api.noteOpen).not.toHaveBeenCalled()
    expect(notices).toEqual(['Added to the note'])
  })

  it('renders no "Add to note" for an item that cannot go to the note', async () => {
    await mountButtons(fakeApi(), 'C:\\d\\a.pdf', [], null)
    expect(buttons('note-insert')).toHaveLength(0)
  })

  it('is off with "Save the PDF first" for an untitled blank or a PDF without a path', async () => {
    for (const [api, path] of [
      [fakeApi({ untitled: true }), 'C:\\d\\Untitled.pdf'],
      [fakeApi(), ''],
    ] as const) {
      await mountButtons(api, path, [])
      const all = [...buttons('note-open'), ...buttons('note-insert')]
      expect(all).toHaveLength(3)
      for (const b of all) expect(b.disabled).toBe(true)
      expect(host.textContent).toContain('Save the PDF first')
    }
  })

  it('a new blank saved with Ctrl+S is no longer "not saved": the buttons ask again after the save', async () => {
    const api = fakeApi({ untitled: true })
    await mountButtons(api, 'C:\\d\\Untitled.pdf', [])
    expect(buttons('note-open').every((b) => b.disabled)).toBe(true)
    // the save succeeded: the main process no longer counts the blank as unsaved
    api.state.unsaved = false
    await mountButtons(api, 'C:\\d\\Untitled.pdf', [], undefined, 1)
    expect(api.noteUnsaved).toHaveBeenCalledTimes(2)
    for (const b of [...buttons('note-open'), ...buttons('note-insert')]) {
      expect(b.disabled).toBe(false)
    }
    expect(host.textContent).not.toContain('Save the PDF first')
  })

  it('shows the main process’s refusal', async () => {
    const notices: string[] = []
    await mountButtons(
      fakeApi({ result: { ok: false, reason: 'unavailable' } }),
      'C:\\a.pdf',
      notices,
    )
    await act(async () => buttons('note-open')[0].click())
    expect(notices).toEqual([t('ntUnavailable')])
  })
})

describe('the annotation panel’s item buttons', () => {
  it('keep another feature’s buttons and add "Add to note"', async () => {
    const api = fakeApi()
    function Harness() {
      const actions = useNoteActions({
        filePath: 'C:\\a.pdf',
        title: '',
        t,
        onNotice: () => {},
        api,
      })
      return createElement(AnnotPanel, {
        items: [item({ key: 'S1', text: 'alpha' }), item({ key: 'O1', kind: 'other', text: '' })],
        loading: false,
        title: 'Doc',
        t,
        onActivate: () => {},
        onClose: () => {},
        onNotice: () => {},
        renderItemActions: (i: AnnotItem) =>
          joinActions(
            i.key === 'S1'
              ? createElement('button', { 'data-action': 'other-feature' }, 'X')
              : null,
            noteInsertAction(actions, annotNoteRequest(i), t, 'pdf-modal-btn'),
          ),
      })
    }
    await act(async () => {
      root.render(createElement(Harness))
    })
    await act(async () => {})
    const s1 = host.querySelector('[data-key="S1"]')!
    expect(s1.querySelector('[data-action="other-feature"]')).not.toBeNull()
    const insert = s1.querySelector<HTMLButtonElement>('[data-action="note-insert"]')!
    await act(async () => insert.click())
    expect(api.noteInsert).toHaveBeenCalledWith({ kind: 'quote', excerpt: 'alpha', page: 3 })
    // a drawing has no note button and no empty action row
    expect(host.querySelector('[data-key="O1"] .pdf-annot-item-actions')).toBeNull()
  })

  it('joinActions is null when no feature has a button', () => {
    expect(joinActions(null, undefined, false)).toBeNull()
  })
})

describe('editor wiring', () => {
  const app = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8')

  it('puts "Open note" in the ribbon and the annotation panel', () => {
    expect(app).toContain('<NoteOpenRibbonButton actions={noteActions} t={t} />')
    expect(app).toContain('<NoteOpenBar actions={noteActions} t={t} />')
  })

  it('adds "Add to note" to passage cards, panel items (with the highlight buttons) and overview sections', () => {
    expect(app).toMatch(
      /cardActions=\{\(card\) =>\s*noteInsertAction\(\s*noteActions,\s*cardNoteRequest\(card, passageCards\.pageOf\(card\)\)/,
    )
    expect(app).toMatch(
      /joinActions\(\s*highlightItemActions\(item,[\s\S]*?noteInsertAction\(noteActions, annotNoteRequest\(item\)/,
    )
    expect(app).toMatch(
      /sectionActions=\{\(section\) =>\s*noteInsertAction\(\s*noteActions,\s*overviewNoteRequest\(section, t\('airOverview'\)\)/,
    )
  })
})
