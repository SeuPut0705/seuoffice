/** @vitest-environment jsdom */
// The document check reads the document when it opens, and again a moment after something
// changed it. While it reads, its findings are not shown and "Hand the fixing to the AI" is
// off, so a read nothing called for takes the button away from under a click. The app counts
// every call that may change the document from the moment it starts (the memo panel makes
// some as it mounts), so the count is already above zero when the panel opens.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DocCheckPanel } from '../src/renderer/check/DocCheckPanel'
import type { AgentBridge } from '../src/renderer/ai/agent-bridge'
import { t } from '../src/renderer/i18n/locale'

/** well past the delay the panel waits after a change before it reads again */
const AFTER_REREAD_DELAY_MS = 5000

/** what the plugin reads from a document with a table inside a table: one finding */
const NESTED_TABLE = {
  charShapes: [],
  paragraphs: [],
  tables: [
    { index: 2, anchor: { para: 0 }, rows: 2, cols: 2, titleAbove: '표 1 개요', nested: true },
  ],
  pictures: [],
}

let container: HTMLElement
let root: Root | null = null

/** A bridge whose document read is counted, and answered only when the test says so. */
function readingBridge() {
  const answers: Array<() => void> = []
  const bridge = {
    documentProfile: () => {
      const { promise, resolve } = Promise.withResolvers<typeof NESTED_TABLE>()
      answers.push(() => resolve(NESTED_TABLE))
      return promise
    },
  } as unknown as AgentBridge
  return {
    bridge,
    /** how many times the document was read */
    reads: () => answers.length,
    /** the read that is on its way comes back */
    async answer() {
      await act(async () => answers.at(-1)!())
    },
  }
}

async function mount(bridge: AgentBridge, revision: number, onHandOff: (request: string) => void) {
  await act(async () => {
    root!.render(
      createElement(DocCheckPanel, {
        bridge,
        format: 'hwp',
        onClose: () => undefined,
        aiHold: { isHeld: () => false, subscribe: () => () => {} },
        onHandOff,
        revision,
      }),
    )
  })
}

const handOffButton = () =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === t('checkAskAi'),
  )
const later = () => act(async () => vi.advanceTimersByTime(AFTER_REREAD_DELAY_MS))

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root!.unmount())
  root = null
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the document check, opened in an app that has already counted changes', () => {
  it('reads the document once: a count from before it opened is not a change', async () => {
    const doc = readingBridge()
    await mount(doc.bridge, 2, () => undefined)
    await doc.answer()
    await later()
    expect(doc.reads()).toBe(1)
    expect(container.textContent).not.toContain(t('checkRunning'))
  })

  it('hands the findings over on a click made after the panel has been open a while', async () => {
    const doc = readingBridge()
    const handed: string[] = []
    await mount(doc.bridge, 2, (request) => handed.push(request))
    await doc.answer()
    await later()
    expect(handOffButton()?.disabled).toBe(false)
    await act(async () => handOffButton()!.click())
    expect(handed).toHaveLength(1)
    expect(handed[0]).toContain('표 안의 표')
  })

  it('keeps its findings and its switch where they are while the user turns the switch on', async () => {
    // A read hides the findings: the panel shrinks and its footer moves under a click aimed at
    // the switch ("Include the checks that are off by default"), which then lands elsewhere.
    const doc = readingBridge()
    await mount(doc.bridge, 2, () => undefined)
    await doc.answer()
    const findings = () => container.querySelectorAll('.doc-check-finding').length
    const shown = findings()
    expect(shown).toBeGreaterThan(0)
    // the moment a second read would start, and well after it
    await later()
    expect(container.textContent).not.toContain(t('checkRunning'))
    expect(findings()).toBe(shown)
    const toggle = container.querySelector<HTMLInputElement>('.doc-check-extra input')!
    await act(async () => toggle.click())
    expect(toggle.checked).toBe(true)
    // the switch judges the facts already read: no read for it either
    await later()
    expect(doc.reads()).toBe(1)
    expect(toggle.checked).toBe(true)
  })
})

describe('the document check, when the document changes while it is open', () => {
  it('reads it again, once, after the change', async () => {
    const doc = readingBridge()
    await mount(doc.bridge, 2, () => undefined)
    await doc.answer()
    await mount(doc.bridge, 3, () => undefined)
    await later()
    expect(doc.reads()).toBe(2)
    await doc.answer()
    await later()
    expect(doc.reads()).toBe(2)
  })

  it('hands the findings over whether the click comes before the second read or after it', async () => {
    const doc = readingBridge()
    const handed: string[] = []
    const onHandOff = (request: string) => handed.push(request)
    await mount(doc.bridge, 2, onHandOff)
    await doc.answer()

    // the change is counted, the click comes before the panel reads again
    await mount(doc.bridge, 3, onHandOff)
    await act(async () => handOffButton()!.click())
    expect(handed).toHaveLength(1)

    // the second read is on its way: the findings are stale, so the button is off and says so
    await later()
    expect(doc.reads()).toBe(2)
    expect(handOffButton()?.disabled).toBe(true)
    expect(container.textContent).toContain(t('checkRunning'))

    // it is back: the button works again
    await doc.answer()
    expect(handOffButton()?.disabled).toBe(false)
    await act(async () => handOffButton()!.click())
    expect(handed).toHaveLength(2)
  })
})
