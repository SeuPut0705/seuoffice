// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { ExternalLinksPanel } from '../src/renderer/ExternalLinksPanel'
import { t } from '../src/renderer/i18n/locale'
import type { ExternalLinkRow } from '../src/shared/desktop-api'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = null
  container = null
  document.body.innerHTML = ''
})

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(element)
    await Promise.resolve()
  })
  return container
}

function click(element: Element): void {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

/// What read-on-open produces: identity fields only, no reachability verdict.
const LISTED: ExternalLinkRow[] = [
  {
    index: 1,
    rawTarget: 'gone.xlsx',
    source: null,
    sheetNames: ['Sheet1'],
  },
  {
    index: 2,
    rawTarget: 'source.xlsx',
    source: '/tmp/data/source.xlsx',
    sheetNames: ['Sheet1', 'Extra'],
  },
]

/// What the update report produces: the same rows with reachability answered.
const UPDATED: ExternalLinkRow[] = [
  { ...LISTED[0]!, reachable: false },
  { ...LISTED[1]!, reachable: true },
]

function panel(links: readonly ExternalLinkRow[], overrides: Record<string, unknown> = {}) {
  return createElement(ExternalLinksPanel, {
    links,
    busy: false,
    onUpdate: () => {},
    onBreak: () => {},
    onChangeSource: () => {},
    onReveal: () => {},
    onClose: () => {},
    ...overrides,
  })
}

describe('external links panel', () => {
  it('lists the links on open with reachability unknown', async () => {
    const host = await mount(panel(LISTED))
    expect(host.textContent).toContain('gone.xlsx')
    expect(host.textContent).toContain('/tmp/data/source.xlsx')
    expect(host.textContent).toContain('Sheet1, Extra')
    // read-on-open never probes the targets: the status is unknown until Update
    expect(host.textContent).toContain('—')
    expect(host.textContent).not.toContain(t('appLinksReachable'))
    expect(host.textContent).not.toContain(t('appLinksBroken'))
    expect(host.querySelectorAll(`[data-tip="${t('appLinksLocate')}"]`)).toHaveLength(0)
  })

  it('shows the reachability the update answered', async () => {
    const host = await mount(panel(UPDATED))
    expect(host.textContent).toContain(t('appLinksReachable'))
    expect(host.textContent).toContain(t('appLinksBroken'))
    // locate only on the reachable link
    expect(host.querySelectorAll(`[data-tip="${t('appLinksLocate')}"]`)).toHaveLength(1)
  })

  it('an empty workbook shows the no-links note', async () => {
    const host = await mount(panel([]))
    expect(host.textContent).toContain(t('appLinksNone'))
  })

  it('a never-saved workbook explains why the panel is empty', async () => {
    const host = await mount(panel([], { notice: 'unsaved' }))
    expect(host.textContent).toContain(t('appLinksUnsaved'))
    expect(host.textContent).not.toContain(t('appLinksNone'))
  })

  it('a busy panel ignores update clicks', async () => {
    const onUpdate = vi.fn()
    const host = await mount(panel(LISTED, { busy: true, onUpdate }))
    const update = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === t('appLinksUpdate'),
    )!
    expect(update.hasAttribute('disabled')).toBe(true)
    click(update)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('a click on update reaches the handler', async () => {
    const onUpdate = vi.fn()
    const host = await mount(panel(LISTED, { onUpdate }))
    const update = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === t('appLinksUpdate'),
    )!
    click(update)
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('a reachable row asks to locate its link index, not a path', async () => {
    const onReveal = vi.fn()
    const host = await mount(panel(UPDATED, { onReveal }))
    const locate = host.querySelector(`[data-tip="${t('appLinksLocate')}"]`)!
    click(locate)
    // the main process resolves the source from the session's own listing
    expect(onReveal).toHaveBeenCalledWith(2)
  })

  it('break asks for confirmation before reaching the handler', async () => {
    const onBreak = vi.fn()
    const host = await mount(panel(LISTED, { onBreak }))
    const scissors = [...host.querySelectorAll('button')].find(
      (button) => button.getAttribute('data-tip') === t('appLinksBreak'),
    )!
    click(scissors)
    // first click only arms the confirm step
    expect(onBreak).not.toHaveBeenCalled()
    const confirm = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === t('appLinksBreakConfirm'),
    )!
    click(confirm)
    expect(onBreak).toHaveBeenCalledTimes(1)
    expect(onBreak).toHaveBeenCalledWith(1)
  })

  it('a click on change source reaches the handler', async () => {
    const onChangeSource = vi.fn()
    const host = await mount(panel(LISTED, { onChangeSource }))
    const sources = [...host.querySelectorAll('button')].filter(
      (button) => button.getAttribute('data-tip') === t('appLinksChangeSource'),
    )
    // only the file-backed link offers it (row 1 is a web source)
    expect(sources).toHaveLength(1)
    click(sources[0]!)
    expect(onChangeSource).toHaveBeenCalledWith(2)
  })

  it('does not offer change source for a link with no local file', async () => {
    const onChangeSource = vi.fn()
    const host = await mount(panel(LISTED, { onChangeSource }))
    const rows = [...host.querySelectorAll('tbody tr')]
    const webRow = rows.find((row) => row.textContent?.includes('gone.xlsx'))!
    expect(webRow.querySelector(`[data-tip="${t('appLinksChangeSource')}"]`)).toBeNull()
    const fileRow = rows.find((row) => row.textContent?.includes('source.xlsx'))!
    expect(fileRow.querySelector(`[data-tip="${t('appLinksChangeSource')}"]`)).not.toBeNull()
  })
})
