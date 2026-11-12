// @vitest-environment jsdom
/**
 * Cells hidden from AI, copied in one workbook and pasted in another tab or
 * window of the app.
 *
 * The other workbook has no marks for them, so the values would arrive as
 * ordinary cells its AI can read. A paste inside one workbook is refused from
 * the copy the editor remembers (redact-move-guard); across workbooks the
 * only thing that travels is the clipboard payload, so the copy says there
 * what it holds and every paste in the app looks for that.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildRedactionIndex } from '../src/renderer/ai/redact'
import { isRangeCopyHtml } from '../src/renderer/copy-picture'
import { t } from '../src/renderer/i18n/locale'
import { readPasteSpecialSource } from '../src/renderer/paste-special'
import {
  createWithheldCopyLedger,
  guardClosedWorkbookPaste,
  guardExternalPaste,
  guardWindowPaste,
  isWithheldCopy,
  withWithheldCopyMark,
  type ExternalPasteService,
} from '../src/renderer/redact-clipboard'
import {
  pasteSourceHoldsHidden,
  type InternalPasteService,
} from '../src/renderer/redact-move-guard'
import type { UniverRuntime } from '../src/renderer/univer-state'

const SECRET = '13800138000'
/** What Univer's USMToHtmlService writes for a range copy (sheets-ui, `convert`). */
const rangeHtml = (copyId: string, cells = `<td>Kim</td><td>${SECRET}</td>`): string =>
  `<google-sheets-html-origin><table data-copy-id="${copyId}" xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" style="table-layout:fixed">` +
  '<colgroup><col width="88" /><col width="120" /></colgroup>\n' +
  `<tbody><tr style="height: 24px;">${cells}</tr></tbody></table>`
const PLAIN = `Kim\t${SECRET}`
const REFUSED = [t('redactMoveRefused')]

/** B2 of sheet `s` is hidden. */
const HIDDEN_B2 = buildRedactionIndex(
  [
    {
      sheetName: 'Sheet1',
      marks: [{ startRow: 1, endRow: 1, startColumn: 1, endColumn: 1, label: 'client phone' }],
    },
  ],
  [{ id: 's', name: 'Sheet1' }],
)
/** The copies the editor remembers, by copy id: what the range of each was. */
const COPIES: Record<string, { rows: number[]; cols: number[] }> = {
  'with-hidden': { rows: [1], cols: [0, 1] },
  'without-hidden': { rows: [2], cols: [0, 1] },
}
const holdsWithheld = (copyId: string): boolean => {
  const copy = COPIES[copyId]
  return copy === undefined || pasteSourceHoldsHidden(HIDDEN_B2, { subUnitId: 's', ...copy })
}

/** Run one copy through the write the editor installs; returns what reached the clipboard. */
async function written(html: string, text = PLAIN) {
  const clipboard = vi.fn(async () => {})
  await withWithheldCopyMark(clipboard, holdsWithheld)(text, html, { 'image/png': 'picture' })
  const [plain, markup, custom] = clipboard.mock.calls[0] as unknown as [string, string, object]
  return { plain, markup, custom }
}

describe('what a copy puts on the clipboard', () => {
  it('says so when the copied range holds a hidden cell', async () => {
    const { plain, markup, custom } = await written(rangeHtml('with-hidden'))
    expect(isWithheldCopy(markup)).toBe(true)
    // the rest of the payload is what it was: text for other programs, the
    // picture, and markup this editor still recognises as its own range copy
    expect(plain).toBe(PLAIN)
    expect(custom).toEqual({ 'image/png': 'picture' })
    expect(isRangeCopyHtml(markup)).toBe(true)
    expect(markup).toContain('data-copy-id="with-hidden"')
    expect(markup).toContain(`<td>${SECRET}</td>`)
  })

  it('leaves a copy without hidden cells exactly as it was', async () => {
    const html = rangeHtml('without-hidden', '<td>Lee</td><td>555</td>')
    const { markup } = await written(html)
    expect(markup).toBe(html)
    expect(isWithheldCopy(markup)).toBe(false)
  })

  it('marks a copy it cannot place, rather than guess that it is clean', async () => {
    expect(isWithheldCopy((await written(rangeHtml('forgotten'))).markup)).toBe(true)
  })

  it('leaves what is not a range copy alone', async () => {
    const editorText = '<p>cell editor text</p>'
    expect((await written(editorText)).markup).toBe(editorText)
  })

  it('is still readable when the clipboard hands the markup back inside a document', async () => {
    const { markup } = await written(rangeHtml('with-hidden'))
    expect(isWithheldCopy(`<html><head></head><body>${markup}</body></html>`)).toBe(true)
    expect(isWithheldCopy(`<meta charset='utf-8'>${markup}`)).toBe(true)
    // a table from anywhere else, and one that only mentions the attribute in its text
    expect(isWithheldCopy('<table><tr><td>data-gx-withheld="1"</td></tr></table>')).toBe(false)
  })
})

describe('pasting such a copy into another workbook of the app', () => {
  /** Stands in for Univer's clipboard service on the receiving side: the paste of markup it did not copy. */
  function receiver() {
    const pasted = vi.fn(async () => true)
    const service: ExternalPasteService = { _pasteExternal: pasted }
    const notices: string[] = []
    guardExternalPaste(service, { notify: (message) => notices.push(message) })
    return { service, pasted, notices }
  }

  it('refuses the paste into the grid', async () => {
    const { markup } = await written(rangeHtml('with-hidden'))
    const { service, pasted, notices } = receiver()
    const fromClipboard = `<html><head></head><body>${markup}</body></html>`
    expect(await service._pasteExternal(fromClipboard, 'default-paste')).toBe(false)
    expect(await service._pasteExternal(fromClipboard, 'special-paste-value')).toBe(false)
    expect(pasted).not.toHaveBeenCalled()
    expect(notices).toEqual([...REFUSED, ...REFUSED])
  })

  it('pastes a copy without hidden cells, and a table from another program', async () => {
    const { markup } = await written(rangeHtml('without-hidden', '<td>Lee</td><td>555</td>'))
    const { service, pasted, notices } = receiver()
    expect(await service._pasteExternal(markup, 'default-paste')).toBe(true)
    expect(
      await service._pasteExternal('<table><tr><td>1</td></tr></table>', 'default-paste'),
    ).toBe(true)
    expect(pasted).toHaveBeenCalledTimes(2)
    expect(notices).toEqual([])
  })

  /** A paste event as the browser raises it, with the clipboard's two flavours. */
  function pasteInto(target: Element, html: string): Event {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/html' ? html : PLAIN) },
    })
    target.dispatchEvent(event)
    return event
  }

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('refuses it in the AI panel and in a cell editor, where only the text would arrive', async () => {
    const { markup } = await written(rangeHtml('with-hidden'))
    document.body.innerHTML =
      '<div class="copilot"><textarea id="composer"></textarea></div>' +
      '<div contenteditable="true" data-u-comp="editor" id="editor"></div><input id="find" />'
    const notices: string[] = []
    // another workbook's editor: it never made this copy
    const guard = guardWindowPaste(window, {
      notify: (message) => notices.push(message),
      knowsCopy: () => false,
      editing: () => false,
    })
    expect(pasteInto(document.getElementById('composer')!, markup).defaultPrevented).toBe(true)
    expect(pasteInto(document.getElementById('editor')!, markup).defaultPrevented).toBe(true)
    expect(pasteInto(document.getElementById('find')!, markup).defaultPrevented).toBe(true)
    expect(notices).toEqual([...REFUSED, ...REFUSED, ...REFUSED])
    guard.dispose()
    expect(pasteInto(document.getElementById('composer')!, markup).defaultPrevented).toBe(false)
  })

  it('in the workbook that made the copy, leaves the grid to its own guard and refuses the rest', async () => {
    const { markup } = await written(rangeHtml('with-hidden'))
    document.body.innerHTML =
      '<div class="copilot"><textarea id="composer"></textarea></div>' +
      '<div contenteditable="true" data-u-comp="editor" id="grid"></div>'
    const notices: string[] = []
    let editing = false
    guardWindowPaste(window, {
      notify: (message) => notices.push(message),
      knowsCopy: (copyId) => copyId === 'with-hidden',
      editing: () => editing,
    })
    const grid = document.getElementById('grid')!
    // the grid: the paste goes on to the editor, which checks the marks as they are now
    expect(pasteInto(grid, markup).defaultPrevented).toBe(false)
    expect(notices).toEqual([])
    // typing in a cell: the text of the copy would land in it as a plain value
    editing = true
    expect(pasteInto(grid, markup).defaultPrevented).toBe(true)
    editing = false
    expect(pasteInto(document.getElementById('composer')!, markup).defaultPrevented).toBe(true)
    expect(notices).toEqual([...REFUSED, ...REFUSED])
  })

  it('lets every other paste through', async () => {
    const clean = (await written(rangeHtml('without-hidden', '<td>Lee</td><td>555</td>'))).markup
    document.body.innerHTML = '<div class="copilot"><textarea id="composer"></textarea></div>'
    const notices: string[] = []
    guardWindowPaste(window, { notify: (message) => notices.push(message) })
    const composer = document.getElementById('composer')!
    expect(pasteInto(composer, clean).defaultPrevented).toBe(false)
    expect(pasteInto(composer, '').defaultPrevented).toBe(false)
    expect(notices).toEqual([])
  })

  it('tells the Paste Special dialog, which reads the clipboard itself', async () => {
    const { markup } = await written(rangeHtml('with-hidden'))
    const blob = (text: string) => ({ text: async () => text })
    const clipboardWith = (html: string) => ({
      read: async () => [
        {
          types: ['text/html', 'text/plain'],
          getType: async (type: string) => blob(type === 'text/html' ? html : PLAIN),
        },
      ],
    })
    // the receiving editor has never seen this copy
    const runtime = {
      univer: {
        __getInjector: () => ({
          get: () => ({ _copyContentCache: { get: () => undefined, getLastCopyId: () => null } }),
        }),
      },
    } as unknown as UniverRuntime
    vi.stubGlobal('navigator', { clipboard: clipboardWith(markup) })
    expect(await readPasteSpecialSource(runtime)).toEqual({
      kind: 'text',
      rows: [['Kim', SECRET]],
      withheld: true,
    })
    vi.stubGlobal('navigator', {
      clipboard: clipboardWith(rangeHtml('elsewhere', '<td>Lee</td><td>555</td>')),
    })
    expect(await readPasteSpecialSource(runtime)).toEqual({ kind: 'text', rows: [['Kim', SECRET]] })
    vi.unstubAllGlobals()
  })
})

describe('pasting such a copy after the tab opened another workbook', () => {
  it('refuses the copy the editor still remembers from the workbook it closed', async () => {
    const ledger = createWithheldCopyLedger()
    const write = withWithheldCopyMark(
      vi.fn(async () => {}),
      holdsWithheld,
      (copyId) => ledger.note(copyId, 'book-a'),
    )
    await write(PLAIN, rangeHtml('with-hidden'))
    await write('Lee\t555', rangeHtml('without-hidden', '<td>Lee</td><td>555</td>'))
    // stands in for Univer's paste of a copy it still has in its own cache
    const pasted = vi.fn(async () => true)
    const service: Pick<InternalPasteService, '_pasteInternal'> = { _pasteInternal: pasted }
    const notices: string[] = []
    guardClosedWorkbookPaste(service, ledger, { notify: (message) => notices.push(message) })

    // the workbook of the copy is still open: its marks decide (redact-move-guard)
    expect(await service._pasteInternal('with-hidden', 'default-paste')).toBe(true)
    // another workbook's closing changes nothing
    ledger.unitDisposed('book-b')
    expect(await service._pasteInternal('with-hidden', 'default-paste')).toBe(true)
    expect(notices).toEqual([])

    // the tab opens another workbook: the marks that covered the copy are gone with the first
    ledger.unitDisposed('book-a')
    pasted.mockClear()
    expect(await service._pasteInternal('with-hidden', 'default-paste')).toBe(false)
    expect(await service._pasteInternal('with-hidden', 'special-paste-value')).toBe(false)
    expect(pasted).not.toHaveBeenCalled()
    expect(notices).toEqual([...REFUSED, ...REFUSED])
    // formatting holds no value, and a copy without hidden cells is an ordinary copy
    expect(await service._pasteInternal('with-hidden', 'special-paste-format')).toBe(true)
    expect(await service._pasteInternal('without-hidden', 'default-paste')).toBe(true)
    expect(pasted).toHaveBeenCalledTimes(2)
  })
})
