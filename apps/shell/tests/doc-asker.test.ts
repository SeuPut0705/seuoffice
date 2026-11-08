import { describe, expect, it } from 'vitest'
import { resolveDocAsker, type DocAskerSources } from '../src/main/doc-picker/doc-asker'

/**
 * Which editor asked for the document list: an in-window tab first, then a
 * detached window. The other split pane is the pane only for a tab that is one
 * of the two panes; a detached window has none; an unknown sender is no error.
 */

function sources(over: Partial<DocAskerSources> = {}): DocAskerSources {
  return {
    tabFor: () => undefined,
    split: () => null,
    detachedFor: () => undefined,
    ...over,
  }
}

describe('resolveDocAsker', () => {
  it('names an in-window tab, its path, and the other pane when it is one of the two panes', () => {
    const src = sources({
      tabFor: (wcId) => (wcId === 7 ? { id: 'tab-a', filePath: 'C:/docs/a.docx' } : undefined),
      split: () => ({ aTabId: 'tab-a', bTabId: 'tab-b' }),
    })
    expect(resolveDocAsker(7, src)).toEqual({
      tabId: 'tab-a',
      path: 'C:/docs/a.docx',
      paneTabId: 'tab-b',
    })
  })

  it('takes pane a for a tab in pane b', () => {
    const src = sources({
      tabFor: () => ({ id: 'tab-b' }),
      split: () => ({ aTabId: 'tab-a', bTabId: 'tab-b' }),
    })
    expect(resolveDocAsker(1, src)).toEqual({ tabId: 'tab-b', paneTabId: 'tab-a' })
  })

  it('has no pane when the view is not split', () => {
    const src = sources({ tabFor: () => ({ id: 'tab-a', filePath: 'C:/docs/a.docx' }) })
    expect(resolveDocAsker(1, src)).toEqual({ tabId: 'tab-a', path: 'C:/docs/a.docx' })
  })

  it('has no pane when the asking tab is not one of the two panes', () => {
    const src = sources({
      tabFor: () => ({ id: 'tab-c' }),
      split: () => ({ aTabId: 'tab-a', bTabId: 'tab-b' }),
    })
    expect(resolveDocAsker(1, src)).toEqual({ tabId: 'tab-c' })
  })

  it('falls back to a detached window, which never has a pane', () => {
    const src = sources({
      split: () => ({ aTabId: 'tab-a', bTabId: 'tab-b' }),
      detachedFor: (wcId) =>
        wcId === 9 ? { id: 'detached:9', filePath: 'C:/docs/d.docx' } : undefined,
    })
    expect(resolveDocAsker(9, src)).toEqual({ tabId: 'detached:9', path: 'C:/docs/d.docx' })
  })

  it('prefers the in-window tab over a detached record for the same sender', () => {
    const src = sources({
      tabFor: () => ({ id: 'tab-a' }),
      detachedFor: () => ({ id: 'detached:1' }),
    })
    expect(resolveDocAsker(1, src)).toEqual({ tabId: 'tab-a' })
  })

  it('returns an empty asker for an unknown sender', () => {
    expect(resolveDocAsker(42, sources({ split: () => ({ aTabId: 'a', bTabId: 'b' }) }))).toEqual(
      {},
    )
  })
})
