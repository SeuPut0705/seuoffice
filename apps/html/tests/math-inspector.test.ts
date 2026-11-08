import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import inspector from '../src/renderer/preview/inspector.js?raw'
import { instrumentForPreview } from '../src/renderer/preview/instrument'
import { buildParseMap } from '../src/renderer/document/parse-map'
import { mathHtml } from '../src/renderer/extensions/math/html-adapter'

let dom: JSDOM | undefined
afterEach(() => dom?.window.close())

describe('math inspector routing', () => {
  it('opens a whole equation when its fraction is clicked and never makes it plain editable text', async () => {
    const source = `<html><body><p>Text ${mathHtml({ latex: String.raw`\frac{a}{b}`, display: false })}</p></body></html>`
    const map = buildParseMap(source, 1)
    const formula = map.elements.find((e) => source.slice(...e.startTag).includes('data-latex'))!
    dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    })
    const doc = dom.window.document
    // The instrumented copy adds source ids without changing saved markup.
    const instrumented = instrumentForPreview(source, map, inspector)
    doc.open()
    doc.write(typeof instrumented === 'string' ? instrumented : '')
    doc.close()
    const messages: Array<{ type: string; sid?: number }> = []
    dom.window.addEventListener('message', (e) => messages.push(e.data))
    doc
      .querySelector('mi')!
      .dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'gx:editMath', sid: formula.sid }),
    )
    expect(doc.querySelector('[contenteditable="true"]')).toBeNull()
    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', { data: { type: 'gx:setMode', mode: 'browse' } }),
    )
    messages.length = 0
    doc
      .querySelector('mi')!
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, button: 0 }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(messages.some((m) => m.type === 'gx:editMath')).toBe(false)
  })
})
