import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import rawInspector from '../src/renderer/preview/inspector.js?raw'
import { readSlideReport } from '../src/renderer/preview/inspector-protocol'

const inspectorSource = rawInspector.replace('__GX_VERSION__', '1')

const ONE_AT_A_TIME_CSS = `<style>.slide { display: none } .slide.active { display: block }</style>`

/** A deck that shows one slide at a time and turns it on the arrow keys, keeping its own index. */
const KEYED_DECK = `<!doctype html><html><head>${ONE_AT_A_TIME_CSS}</head><body>
  <div class="deck">
    <div class="slide active" data-gx-sid="1"><h1 data-gx-sid="2">One</h1></div>
    <div class="slide" data-gx-sid="3"><h1 data-gx-sid="4">Two</h1></div>
    <div class="slide" data-gx-sid="5"><h1 data-gx-sid="6">Three</h1></div>
  </div>
  <script>
    window.deckIndex = 0
    const slides = document.querySelectorAll('.slide')
    const show = (i) => {
      window.deckIndex = Math.max(0, Math.min(slides.length - 1, i))
      slides.forEach((s, n) => s.classList.toggle('active', n === window.deckIndex))
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') show(window.deckIndex + 1)
      if (e.key === 'ArrowLeft') show(window.deckIndex - 1)
    })
  </script>
</body></html>`

/** The same deck without any key handling: only its classes say which slide shows. */
const KEYLESS_DECK = `<!doctype html><html><head>${ONE_AT_A_TIME_CSS}</head><body>
  <div class="slide active" data-gx-sid="1">One</div>
  <div class="slide" data-gx-sid="2">Two</div>
  <div class="slide" data-gx-sid="3">Three</div>
</body></html>`

const REVEAL_DECK = `<!doctype html><html><body>
  <div class="reveal"><div class="slides">
    <section>One</section><section>Two</section><section>Three</section><section>Four</section>
  </div></div>
  <script>
    window.revealCalls = []
    let at = 0
    window.Reveal = {
      slide: (h) => { window.revealCalls.push(h); at = h },
      getIndices: () => ({ h: at, v: 0 }),
    }
  </script>
</body></html>`

const STACKED_DECK = `<!doctype html><html><body>
  <section data-gx-sid="1">One</section>
  <section data-gx-sid="2">Two</section>
  <section data-gx-sid="3">Three</section>
</body></html>`

const SINGLE_SLIDE = `<!doctype html><html><body><div class="slide">Only</div></body></html>`

/** slides named their own way, one shown at a time */
const CONTAINER_DECK = `<!doctype html><html><head><style>
  .slide-container { display: none } .slide-container.active { display: block }
</style></head><body><div class="slides">
  <div class="slide-container active"><h2 class="slide-title">One</h2></div>
  <div class="slide-container"><h2 class="slide-title">Two</h2></div>
  <div class="slide-container"><h2 class="slide-title">Three</h2></div>
</div></body></html>`

/** a slide that holds slides of its own is one slide */
const NESTED_DECK = `<!doctype html><html><body>
  <div class="slide">One</div>
  <div class="slide">Two<div class="slide">a</div><div class="slide">b</div></div>
  <div class="slide">Three</div>
</body></html>`

/** no slide names at all: pages in a stage, one on show */
const UNNAMED_DECK = `<!doctype html><html><head><style>
  .page { display: none } .page.on { display: block }
</style></head><body><main>
  <div class="page on">One</div><div class="page">Two</div><div class="page">Three</div>
</main></body></html>`

/** a small carousel on an ordinary page is not a deck */
const CAROUSEL_PAGE = `<!doctype html><html><head><style>
  .carousel-slide { display: none } .carousel-slide.active { display: block }
</style></head><body>
  <h1>Shop</h1>
  <div class="carousel">
    <div class="carousel-slide active" data-box="400,200">A</div>
    <div class="carousel-slide" data-box="400,200">B</div>
    <div class="carousel-slide" data-box="400,200">C</div>
  </div>
</body></html>`

/** a screen-tall opening and a block under it: further down the page is not put away */
const LANDING_PAGE = `<!doctype html><html><body>
  <div>Welcome</div><div data-box="1000,300,600">Cards</div><p>More</p>
</body></html>`

/** tab panels show one at a time too, but they are not slides */
const TABS_PAGE = `<!doctype html><html><head><style>
  .panel { display: none } .panel.on { display: block }
</style></head><body><main>
  <div role="tablist"><button>A</button><button>B</button></div>
  <div class="panel on">A</div><div class="panel">B</div><div class="panel">C</div>
</main></body></html>`

const MARP_DECK = `<!doctype html><html><body><div class="marpit">
  <svg data-marpit-svg=""><foreignObject><section>One</section></foreignObject></svg>
  <svg data-marpit-svg=""><foreignObject><section>Two</section></foreignObject></svg>
  <svg data-marpit-svg=""><foreignObject><section>Three</section></foreignObject></svg>
</div></body></html>`

const SWIPER_DECK = `<!doctype html><html><body>
  <div class="swiper"><div class="swiper-wrapper">
    <div class="swiper-slide swiper-slide-duplicate">Three</div>
    <div class="swiper-slide swiper-slide-active">One</div>
    <div class="swiper-slide">Two</div>
    <div class="swiper-slide">Three</div>
  </div></div>
  <script>
    window.swiperCalls = []
    document.querySelector('.swiper').swiper = {
      params: { loop: true },
      slideTo: (i) => window.swiperCalls.push('slideTo:' + i),
      slideToLoop: (i) => window.swiperCalls.push('slideToLoop:' + i),
    }
  </script>
</body></html>`

const IMPRESS_DECK = `<!doctype html><html><body>
  <div id="impress"><div>
    <div class="step">One</div><div class="step active">Two</div><div class="step">Three</div>
  </div></div>
  <script>
    window.impressCalls = []
    window.impress = () => ({ goto: (el) => window.impressCalls.push(el.textContent) })
  </script>
</body></html>`

/** slides side by side in a row that scrolls sideways */
const ROW_DECK = `<!doctype html><html><head><style>.row { overflow-x: auto }</style></head><body>
  <div class="row">
    <div class="slide">One</div><div class="slide">Two</div><div class="slide">Three</div>
  </div>
</body></html>`

const W = 1000
const H = 600

let dom: JSDOM | null = null

afterEach(() => {
  dom?.window.close()
  dom = null
})

type Layout = 'overlap' | 'stacked' | 'row'

/**
 * jsdom lays nothing out: give each element the box a browser would. Overlapping slides all
 * fill the viewport when shown; stacked sections sit a screen each, one under the other; in a
 * row the children of `.row` sit a screen each side by side. `data-box="w,h,top"` sets another box.
 */
function openPage(html: string, layout: Layout = 'overlap') {
  dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true })
  const { window } = dom
  Object.defineProperty(window, 'innerWidth', { value: W, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: H, configurable: true })
  const scrolled: string[] = []
  window.Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.textContent?.trim() ?? '')
  }
  window.Element.prototype.getBoundingClientRect = function (this: Element) {
    const none = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
    if (window.getComputedStyle(this).display === 'none') return none as DOMRect
    let top = 0
    let left = 0
    if (layout === 'stacked' && this.tagName === 'SECTION') {
      const sections = Array.from(window.document.querySelectorAll('body > section'))
      top = sections.indexOf(this) * H
    }
    if (layout === 'row' && this.parentElement?.classList.contains('row'))
      left = Array.from(this.parentElement.children).indexOf(this) * W
    const [width, height, boxTop] = (this.getAttribute('data-box') ?? `${W},${H}`)
      .split(',')
      .map(Number)
    if (boxTop !== undefined) top = boxTop
    const box = {
      x: left,
      y: top,
      top,
      left,
      right: left + width,
      bottom: top + height,
      width,
      height,
    }
    return { ...box, toJSON: () => box } as DOMRect
  }
  const messages: Array<Record<string, unknown>> = []
  window.addEventListener('message', (e) => {
    if (e.data && typeof e.data.type === 'string') messages.push(e.data)
  })
  const script = window.document.createElement('script')
  script.textContent = inspectorSource
  window.document.body.appendChild(script)
  const send = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }))
  const lastSlides = () => [...messages].reverse().find((m) => m.type === 'gx:slides')
  /** waits until the frame has reported a deck that satisfies `test` */
  const slidesWhere = async (test: (m: Record<string, unknown>) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const last = lastSlides()
      if (last && test(last)) return last
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`no matching gx:slides report; last: ${JSON.stringify(lastSlides())}`)
  }
  const shown = (selector = '.slide', on = 'active') =>
    Array.from(window.document.querySelectorAll(selector))
      .map((el, i) => (el.classList.contains(on) ? i : -1))
      .filter((i) => i >= 0)
  return { window, send, messages, slidesWhere, shown, scrolled }
}

describe('slides the preview finds', () => {
  it('reports a deck of named slides and the one on show', async () => {
    const { slidesWhere } = openPage(KEYED_DECK)
    const report = await slidesWhere((m) => m.count === 3)
    expect(readSlideReport(report)).toEqual({ count: 3, current: 0, width: W, height: H })
  })

  it('turns a keyed deck with its own keys, so its own index follows', async () => {
    const { window, send, slidesWhere, shown } = openPage(KEYED_DECK)
    await slidesWhere((m) => m.count === 3)
    send({ type: 'gx:goToSlide', index: 2 })
    await slidesWhere((m) => m.current === 2)
    expect(shown()).toEqual([2])
    expect((window as unknown as { deckIndex: number }).deckIndex).toBe(2)
    send({ type: 'gx:goToSlide', index: 1 })
    await slidesWhere((m) => m.current === 1)
    expect((window as unknown as { deckIndex: number }).deckIndex).toBe(1)
  })

  it('keeps the keys it hands the deck away from its own shortcuts', async () => {
    const { send, messages, slidesWhere } = openPage(KEYED_DECK)
    await slidesWhere((m) => m.count === 3)
    // with an element selected, ArrowRight would otherwise select its first child
    send({ type: 'gx:select', sid: 2 })
    send({ type: 'gx:goToSlide', index: 2 })
    await slidesWhere((m) => m.current === 2)
    expect(messages.filter((m) => m.type === 'gx:keyCommand')).toEqual([])
  })

  it('moves the classes of the shown slide when the deck answers no key', async () => {
    const { send, slidesWhere, shown } = openPage(KEYLESS_DECK)
    await slidesWhere((m) => m.count === 3)
    send({ type: 'gx:goToSlide', index: 1 })
    await slidesWhere((m) => m.current === 1)
    expect(shown()).toEqual([1])
  })

  it('asks reveal.js for the slide', async () => {
    const { window, send, slidesWhere } = openPage(REVEAL_DECK)
    await slidesWhere((m) => m.count === 4)
    send({ type: 'gx:goToSlide', index: 3 })
    await slidesWhere((m) => m.current === 3)
    expect((window as unknown as { revealCalls: number[] }).revealCalls).toEqual([3])
  })

  it('scrolls to a section of a deck stacked a screen at a time', async () => {
    const { send, slidesWhere, scrolled } = openPage(STACKED_DECK, 'stacked')
    await slidesWhere((m) => m.count === 3)
    send({ type: 'gx:goToSlide', index: 2 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(scrolled).toEqual(['Three'])
  })

  it('reports a page with a single slide as no deck', async () => {
    const { slidesWhere } = openPage(SINGLE_SLIDE)
    const report = await slidesWhere(() => true)
    expect(report.count).toBe(0)
  })

  it('finds slides named their own way, and not the parts inside them', async () => {
    const { send, slidesWhere, shown } = openPage(CONTAINER_DECK)
    await slidesWhere((m) => m.count === 3)
    send({ type: 'gx:goToSlide', index: 2 })
    await slidesWhere((m) => m.current === 2)
    expect(shown('.slide-container')).toEqual([2])
  })

  it('counts a slide that holds slides as one', async () => {
    const { slidesWhere } = openPage(NESTED_DECK)
    await slidesWhere((m) => m.count === 3)
  })

  it('finds unnamed pages shown one at a time in a stage', async () => {
    const { send, slidesWhere, shown } = openPage(UNNAMED_DECK)
    await slidesWhere((m) => m.count === 3)
    send({ type: 'gx:goToSlide', index: 1 })
    await slidesWhere((m) => m.current === 1)
    expect(shown('.page', 'on')).toEqual([1])
  })

  it('reports no deck for a small carousel, a set of tabs or a long page', async () => {
    for (const page of [CAROUSEL_PAGE, TABS_PAGE, LANDING_PAGE]) {
      const { slidesWhere } = openPage(page)
      const report = await slidesWhere(() => true)
      expect(report.count).toBe(0)
      dom?.window.close()
    }
  })

  it("finds Marp's pages", async () => {
    const { slidesWhere } = openPage(MARP_DECK)
    await slidesWhere((m) => m.count === 3)
  })

  it('asks swiper for the slide, leaving out its loop copies', async () => {
    const { window, send, slidesWhere } = openPage(SWIPER_DECK)
    await slidesWhere((m) => m.count === 3 && m.current === 0)
    send({ type: 'gx:goToSlide', index: 2 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((window as unknown as { swiperCalls: string[] }).swiperCalls).toEqual(['slideToLoop:2'])
  })

  it('asks impress.js for the step, and takes the step it marks as the one on show', async () => {
    const { window, send, slidesWhere } = openPage(IMPRESS_DECK)
    await slidesWhere((m) => m.count === 3 && m.current === 1)
    send({ type: 'gx:goToSlide', index: 2 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((window as unknown as { impressCalls: string[] }).impressCalls).toEqual(['Three'])
  })

  it('scrolls sideways to a slide in a row that scrolls', async () => {
    const { send, slidesWhere, scrolled } = openPage(ROW_DECK, 'row')
    await slidesWhere((m) => m.count === 3)
    send({ type: 'gx:goToSlide', index: 2 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(scrolled).toEqual(['Three'])
  })

  it('turns a thumbnail frame to its slide and hides its scrollbars', async () => {
    const { window, send, slidesWhere, shown } = openPage(KEYED_DECK)
    send({ type: 'gx:setMode', mode: 'browse' })
    send({ type: 'gx:thumbnail', slide: 1 })
    await slidesWhere((m) => m.current === 1)
    expect(shown()).toEqual([1])
    const styles = Array.from(window.document.querySelectorAll('style[data-gx-inspector]'))
    expect(styles.some((style) => style.textContent?.includes('scrollbar'))).toBe(true)
  })
})

describe('readSlideReport', () => {
  it('takes small whole numbers only', () => {
    expect(readSlideReport({ count: 4, current: 9, width: 800, height: 450 })).toEqual({
      count: 4,
      current: 3,
      width: 800,
      height: 450,
    })
    expect(readSlideReport({ count: -1, current: 0, width: 800, height: 450 })).toBeNull()
    expect(readSlideReport({ count: 2, current: 0.5, width: 800, height: 450 })).toBeNull()
    expect(readSlideReport({ count: 2, current: 0, width: 0, height: 450 })).toBeNull()
    expect(readSlideReport({ count: '2', current: 0, width: 800, height: 450 })).toBeNull()
  })
})
