/**
 * Spec 9's input for a conversion without AI (8.6): the shell records "a
 * conversion opened this new tab, from these sources" in memory, beside the
 * AI run-started records, for the provenance reader.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  generateConvertedEvents,
  generateRunStartedEvents,
  recordGenerateConverted,
  resetGenerateHandoffsForTest,
  setGenerateTabIdResolver,
} from '../src/generate-handoff'

afterEach(() => resetGenerateHandoffsForTest())

describe('recordGenerateConverted', () => {
  it('keeps the tab, the sources and the convert mode, and leaves the AI runs alone', () => {
    setGenerateTabIdResolver((id) => (id === 5 ? 't9' : undefined))
    const event = recordGenerateConverted({
      webContentsId: 5,
      target: 'mindmap',
      kind: 'markdown-to-mindmap',
      sources: ['C:\\work\\notes.md'],
      conversionId: 'c-1',
    })
    expect(event).toMatchObject({
      tabId: 't9',
      webContentsId: 5,
      target: 'mindmap',
      kind: 'markdown-to-mindmap',
      mode: 'convert',
      sources: ['C:\\work\\notes.md'],
      conversionId: 'c-1',
    })
    expect(generateConvertedEvents()).toEqual([event])
    expect(generateRunStartedEvents()).toEqual([])
  })

  it('hands out copies', () => {
    recordGenerateConverted({
      webContentsId: 6,
      target: 'markdown',
      kind: 'mindmap-to-markdown',
      sources: ['C:\\work\\plan.xmind'],
      conversionId: 'c-2',
    })
    generateConvertedEvents()[0]!.sources.push('changed')
    expect(generateConvertedEvents()[0]!.sources).toEqual(['C:\\work\\plan.xmind'])
    expect(generateConvertedEvents()[0]!.tabId).toBeUndefined()
  })
})
