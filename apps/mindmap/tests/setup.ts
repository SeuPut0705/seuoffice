/**
 * Test environment fixes for jsdom.
 *
 * jsdom brings its own typed arrays, while Node's TextEncoder and streams hand
 * back Node's. The zip library tells bytes from other values with `instanceof`,
 * so bytes of the "other" kind are refused. One kind for everything: Node's.
 * A browser has only one, so this is a property of the test environment alone.
 */
const sample = new TextEncoder().encode('')
globalThis.Uint8Array = sample.constructor as Uint8ArrayConstructor
globalThis.ArrayBuffer = sample.buffer.constructor as ArrayBufferConstructor

// The drawing library asks for the colour scheme once when it is created.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

// jsdom has no innerText; the drawing library reads and writes it for plain text.
if (typeof HTMLElement !== 'undefined' && !('innerText' in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? ''
    },
    set(this: HTMLElement, value: string) {
      this.textContent = value
    },
  })
}

// jsdom has no pointer capture; the drawing library takes it when a topic is pressed.
if (typeof Element !== 'undefined' && typeof Element.prototype.setPointerCapture !== 'function') {
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.hasPointerCapture = () => false
}
