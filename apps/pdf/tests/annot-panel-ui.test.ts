/**
 * The annotation panel on screen (reading-assist spec 4.3, 10.3): the list,
 * a not-found card's label, filters, clicks dispatching the item, the header
 * menu (copy as Markdown, open as a Markdown or Word document through
 * `createDocument` without any AI call), and the reason shown in a standalone
 * window that has no `createDocument`.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '@genoffice/i18n'
import { strings } from '../src/renderer/i18n/strings'
import type { TFunc } from '../src/renderer/i18n/locale'
import type { CreateDocumentRequest, CreateDocumentResult } from '../src/shared/ipc'
import { AnnotPanel, type AnnotPanelProps } from '../src/renderer/annot-panel/AnnotPanel'
import type { AnnotItem } from '../src/renderer/annot-panel/items'
import { annotHtml, annotMarkdown } from '../src/renderer/annot-panel/export'
import { sortAnnotItems } from '../src/renderer/annot-panel/filter'

const translate = createI18n(strings)
const t: TFunc = (key, params) => translate('en', key, params)
const tKo: TFunc = (key, params) => translate('ko', key, params)

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const item = (o: Partial<AnnotItem> & Pick<AnnotItem, 'key'>): AnnotItem => ({
  kind: 'highlight',
  kindLabel: 'Highlight',
  origin: 'saved',
  page: 0,
  pageNo: 1,
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

const ITEMS: AnnotItem[] = [
  item({ key: 'S1', seq: 0, text: 'alpha words' }),
  item({
    key: 'S2',
    seq: 1,
    kind: 'note',
    kindLabel: 'Note',
    text: 'a note\nsecond line',
    memo: 'a note\nsecond line\nthird',
    replies: 2,
    page: 1,
    pageNo: 2,
    target: { type: 'note', rootKey: 'S2' },
  }),
  item({
    key: 'Cc1',
    seq: 2,
    kind: 'card',
    kindLabel: 'AI explanation',
    text: 'lost passage',
    detail: 'first answer line',
    body: 'first answer line\nmore',
    page: null,
    pageNo: null,
    rect: null,
    color: null,
    notFound: true,
    target: { type: 'card', cardId: 'c1' },
  }),
  item({
    key: 'Lm1',
    seq: 3,
    origin: 'unsaved',
    kind: 'underline',
    kindLabel: 'Underline',
    text: 'beta words',
    color: [0.17, 0.4, 1],
    page: 2,
    pageNo: 3,
  }),
]

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
  delete (window as { pdfApi?: unknown }).pdfApi
})

function render(over: Partial<AnnotPanelProps> = {}) {
  const props: AnnotPanelProps = {
    items: ITEMS,
    loading: false,
    title: 'Report',
    t,
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onNotice: vi.fn(),
    ...over,
  }
  act(() => root.render(createElement(AnnotPanel, props)))
  return props
}

const rows = () => [...host.querySelectorAll<HTMLElement>('.pdf-annot-item')]
const button = (label: string) => {
  const b = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (el) => el.textContent?.includes(label) || el.getAttribute('aria-label') === label,
  )
  if (!b) throw new Error(`no button ${label}`)
  return b
}
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click()
  })
}
const type = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  act(() => {
    const proto =
      el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    )
  })
}

describe('AnnotPanel list', () => {
  it('shows every item in page order with its kind, text, page and reply count', () => {
    render()
    const r = rows()
    expect(r.map((el) => el.dataset.key)).toEqual(['S1', 'S2', 'Lm1', 'Cc1'])
    expect(r[0]!.textContent).toContain('alpha words')
    expect(r[0]!.textContent).toContain('Highlight')
    expect(r[0]!.textContent).toContain('p.1')
    expect(r[1]!.textContent).toContain('2 replies')
    expect(r[2]!.textContent).toContain('Not saved')
  })

  it('labels a card whose page cannot be found again', () => {
    render()
    const lost = rows().find((el) => el.dataset.key === 'Cc1')!
    expect(lost.textContent).toContain('Location not found')
    expect(lost.textContent).toContain('first answer line')
  })

  it('shows the annotation color as a swatch of the document color', () => {
    render()
    const swatch = rows()[0]!.querySelector<HTMLElement>('.pdf-annot-swatch')!
    expect(swatch.style.background).toMatch(/rgb\(255, 222, 89\)|#ffde59/i)
  })

  it('dispatches a click on an item', async () => {
    const props = render()
    await click(rows()[1]!.querySelector<HTMLButtonElement>('.pdf-annot-item-main')!)
    expect(props.onActivate).toHaveBeenCalledWith(ITEMS[1])
  })

  it('filters by text, kind and page range, and sorts by creation order', () => {
    render()
    type(host.querySelector<HTMLInputElement>('input[type="search"]')!, 'BETA')
    expect(rows().map((el) => el.dataset.key)).toEqual(['Lm1'])
    type(host.querySelector<HTMLInputElement>('input[type="search"]')!, '')
    type(host.querySelector<HTMLSelectElement>('select[name="kind"]')!, 'note')
    expect(rows().map((el) => el.dataset.key)).toEqual(['S2'])
    type(host.querySelector<HTMLSelectElement>('select[name="kind"]')!, '')
    type(host.querySelector<HTMLInputElement>('input[name="pageFrom"]')!, '2')
    expect(rows().map((el) => el.dataset.key)).toEqual(['S2', 'Lm1'])
    type(host.querySelector<HTMLInputElement>('input[name="pageFrom"]')!, '')
    type(host.querySelector<HTMLSelectElement>('select[name="sort"]')!, 'created')
    expect(rows().map((el) => el.dataset.key)).toEqual(['S1', 'S2', 'Cc1', 'Lm1'])
  })

  it('filters by color swatch', async () => {
    render()
    await click(host.querySelector<HTMLButtonElement>('button[data-color="#2b66ff"]')!)
    expect(rows().map((el) => el.dataset.key)).toEqual(['Lm1'])
  })

  it('shows the empty and loading states', () => {
    render({ items: [], loading: true })
    expect(host.textContent).toContain('Reading annotations')
    render({ items: [], loading: false })
    expect(host.textContent).toContain('This document has no annotations')
  })

  it('renders per-item actions from other features', async () => {
    const run = vi.fn()
    render({
      renderItemActions: (it) =>
        createElement(
          'button',
          { type: 'button', className: 'x-action', onClick: () => run(it.key) },
          'Extra',
        ),
    })
    const actions = host.querySelectorAll<HTMLButtonElement>('.x-action')
    expect(actions).toHaveLength(4)
    await click(actions[0]!)
    expect(run).toHaveBeenCalledWith('S1')
  })
})

describe('AnnotPanel menu', () => {
  const md = annotMarkdown({ title: 'Report', items: sortAnnotItems(ITEMS, 'page'), t })
  const html = annotHtml({ title: 'Report', items: sortAnnotItems(ITEMS, 'page'), t })

  it('copies the filtered list as Markdown', async () => {
    const copyText = vi.fn(async () => {})
    const props = render({ copyText })
    await click(button('Menu'))
    await click(button('Copy as Markdown'))
    expect(copyText).toHaveBeenCalledWith(md)
    expect(props.onNotice).toHaveBeenCalledWith('Copied as Markdown')
  })

  it('copies only what the filters leave', async () => {
    const copyText = vi.fn(async () => {})
    render({ copyText })
    type(host.querySelector<HTMLInputElement>('input[type="search"]')!, 'alpha')
    await click(button('Menu'))
    await click(button('Copy as Markdown'))
    const text = copyText.mock.calls[0]![0] as string
    expect(text).toContain('alpha words')
    expect(text).not.toContain('beta words')
  })

  it('opens a Markdown or Word document through createDocument, with no AI call', async () => {
    const aiStream = vi.fn()
    ;(window as { pdfApi?: unknown }).pdfApi = { aiStream }
    const createDocument = vi.fn(
      async (_r: CreateDocumentRequest): Promise<CreateDocumentResult> => ({ ok: true }),
    )
    render({ createDocument })
    await click(button('Menu'))
    await click(button('Open as Markdown document'))
    expect(createDocument).toHaveBeenLastCalledWith({
      type: 'md',
      title: 'Report — Annotations',
      content: md,
    })
    await click(button('Menu'))
    await click(button('Open as Word document'))
    expect(createDocument).toHaveBeenLastCalledWith({
      type: 'docx',
      title: 'Report — Annotations',
      content: html,
    })
    expect(createDocument).toHaveBeenCalledTimes(2)
    expect(aiStream).not.toHaveBeenCalled()
  })

  it('reports a failed document creation', async () => {
    const createDocument = vi.fn(async () => ({ ok: false, error: 'disk full' }))
    const props = render({ createDocument })
    await click(button('Menu'))
    await click(button('Open as Word document'))
    expect(props.onNotice).toHaveBeenCalledWith(expect.stringContaining('disk full'))
  })

  it('shows why the two document items are unavailable in a standalone window', async () => {
    render({ createDocument: undefined })
    await click(button('Menu'))
    const md = button('Open as Markdown document')
    const docx = button('Open as Word document')
    expect(md.disabled).toBe(true)
    expect(docx.disabled).toBe(true)
    const reason = t('apCreateUnavailable')
    expect(md.textContent).toContain(reason)
    expect(docx.textContent).toContain(reason)
    expect(button('Copy as Markdown').disabled).toBe(false)
  })
})

describe('AnnotPanel without the shell', () => {
  it('disables the Word item with a translated reason and keeps Markdown working', async () => {
    const createDocument = vi.fn(async (): Promise<CreateDocumentResult> => ({ ok: true }))
    render({ createDocument, docxAvailable: false, t: tKo })
    await click(button('메뉴'))
    const docx = button('워드 문서로 열기')
    expect(docx.disabled).toBe(true)
    const reason = tKo('apDocxUnavailable')
    expect(reason).not.toBe(t('apDocxUnavailable'))
    expect(docx.textContent).toContain(reason)
    const md = button('마크다운 문서로 열기')
    expect(md.disabled).toBe(false)
    expect(md.textContent).not.toContain(reason)
    await click(md)
    expect(createDocument).toHaveBeenCalledWith(expect.objectContaining({ type: 'md' }))
  })

  it('keeps the Word item disabled without a reason while the host is still being checked', async () => {
    render({ createDocument: vi.fn(async () => ({ ok: true })), docxAvailable: null })
    await click(button('Menu'))
    const docx = button('Open as Word document')
    expect(docx.disabled).toBe(true)
    expect(docx.textContent).not.toContain(t('apDocxUnavailable'))
  })
})

describe('AnnotPanel categories', () => {
  it("shows a saved markup's category with its kind", () => {
    render({ items: [item({ key: 'S7', category: 'Method' })] })
    expect(rows()[0]!.textContent).toContain('Highlight · Method')
  })
})
