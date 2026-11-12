import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Breadcrumb } from '../src/renderer/components/Breadcrumb'
import { PreviewFrame } from '../src/renderer/preview/PreviewFrame'
import { DraftPreview } from '../src/renderer/preview/DraftPreview'
import { buildParseMap } from '../src/renderer/document/parse-map'
import { LocaleProvider } from '../src/renderer/i18n/locale'
import { strings } from '../src/renderer/i18n/strings'

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.assign(window, { htmlApi: { onLanguageChanged: () => () => {} } })
})
const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  delete (window as { htmlApi?: unknown }).htmlApi
  vi.unstubAllGlobals()
})

// Korean, not the default: a label typed as an English literal would pass under English
function mount(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(createElement(LocaleProvider, { initial: 'ko', children: element })))
  cleanups.push(() => {
    act(() => root.unmount())
    container.remove()
  })
  return container
}

describe('aria-label/title i18n (existing keys)', () => {
  it('Breadcrumb uses the translated element toolbar key, not the English literal', () => {
    const text = '<div><p>hi</p></div>'
    const map = buildParseMap(text, 1)
    const target = map.elements.find((e) => e.tag === 'p') ?? map.elements[0]!
    const container = mount(
      createElement(Breadcrumb, {
        text,
        map,
        sid: target.sid,
        state: 'static',
        onSelect: () => {},
      }),
    )
    const nav = container.querySelector('.crumbs')
    expect(nav).not.toBeNull()
    expect(nav!.getAttribute('aria-label')).toBe(strings.ko.elementPath)
    expect(nav!.getAttribute('aria-label')).not.toBe(strings.en.elementPath)
  })

  it('PreviewFrame uses the translated preview key, not the English literal', () => {
    const container = mount(
      createElement(PreviewFrame, {
        url: null,
        nonce: 0,
        zoom: 100,
        onMessage: () => {},
      }),
    )
    const frame = container.querySelector('iframe.preview-frame')
    expect(frame).not.toBeNull()
    expect(frame!.getAttribute('title')).toBe(strings.ko.viewPreview)
    expect(frame!.getAttribute('title')).not.toBe(strings.en.viewPreview)
  })

  it('DraftPreview reuses the translated preview key, not the English literal', () => {
    const container = mount(createElement(DraftPreview, { html: '<p>hi</p>' }))
    const frame = container.querySelector('iframe.draft-preview-frame')
    expect(frame).not.toBeNull()
    expect(frame!.getAttribute('title')).toBe(strings.ko.viewPreview)
    expect(frame!.getAttribute('title')).not.toBe(strings.en.viewPreview)
  })
})
