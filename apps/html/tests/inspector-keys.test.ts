import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import rawInspector from '../src/renderer/preview/inspector.js?raw'

const inspectorSource = rawInspector.replace('__GX_VERSION__', '1')

/** A slide deck that turns the page on Space and the arrows, the way generated decks do. */
const DECK = `<!doctype html><html><head><script>
  window.turns = []
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      window.turns.push('keydown:' + e.key)
    }
  })
  window.addEventListener('keyup', (e) => window.turns.push('keyup:' + e.key))
</script></head><body>
  <section data-gx-sid="1"><p data-gx-sid="2">Slide one</p></section>
</body></html>`

let dom: JSDOM | null = null

afterEach(() => {
  dom?.window.close()
  dom = null
})

function openDeck() {
  dom = new JSDOM(DECK, { runScripts: 'dangerously', pretendToBeVisual: true })
  const { window } = dom
  const script = window.document.createElement('script')
  script.textContent = inspectorSource
  window.document.body.appendChild(script)
  const send = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }))
  const key = (type: 'keydown' | 'keyup', key: string, code: string) => {
    const target = window.document.activeElement ?? window.document.body
    const event = new window.KeyboardEvent(type, { key, code, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event
  }
  const turns = () => (window as unknown as { turns: string[] }).turns
  return { window, send, key, turns }
}

describe("preview keys and the page's own key listeners", () => {
  it('keeps keys typed into a text edit away from the page, without blocking the typing', () => {
    const { window, send, key, turns } = openDeck()
    send({ type: 'gx:beginTextEdit', sid: 2 })
    const edited = window.document.querySelector('[data-gx-sid="2"]')!
    expect(edited.getAttribute('contenteditable')).toBe('true')

    const space = key('keydown', ' ', 'Space')
    key('keyup', ' ', 'Space')
    key('keydown', 'ArrowRight', 'ArrowRight')
    expect(turns()).toEqual([])
    // the default action (the typed space, the caret move) is left to the browser
    expect(space.defaultPrevented).toBe(false)
  })

  it('keeps the keyup of the key that closed the edit away from the page', () => {
    const { window, send, key, turns } = openDeck()
    send({ type: 'gx:beginTextEdit', sid: 2 })
    key('keydown', 'Escape', 'Escape')
    expect(window.document.querySelector('[contenteditable]')).toBeNull()
    key('keyup', 'Escape', 'Escape')
    expect(turns()).toEqual([])
  })

  it('leaves keys to the page when no text edit is open', () => {
    const { key, turns } = openDeck()
    key('keydown', ' ', 'Space')
    key('keyup', ' ', 'Space')
    expect(turns()).toEqual(['keydown: ', 'keyup: '])
  })

  it('does not hand the page an arrow the inspector used to move the selection', () => {
    const { send, key, turns } = openDeck()
    send({ type: 'gx:select', sid: 2 })
    key('keydown', 'ArrowDown', 'ArrowDown')
    expect(turns()).toEqual([])
  })

  it('leaves every key to the page in the present view', () => {
    const { send, key, turns } = openDeck()
    send({ type: 'gx:setMode', mode: 'browse' })
    key('keydown', 'ArrowRight', 'ArrowRight')
    expect(turns()).toEqual(['keydown:ArrowRight'])
  })
})
