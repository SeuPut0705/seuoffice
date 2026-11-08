import { describe, expect, it } from 'vitest'
import { withInertHeaders } from '../src/dom'

/**
 * jsdom 28's own undici copy reads `globalThis.Headers` while it is evaluated,
 * which pulls in Node's built-in undici and its WebAssembly HTTP parser. The
 * parser aborts the process under a low `ulimit -v`, so the loader hides that
 * global for exactly the import (see withInertHeaders in src/dom.ts).
 */
describe('loading jsdom without the built-in WebAssembly parser', () => {
  // the built-in comes back on first read, through Response (see withInertHeaders)
  function expectBuiltinHeaders(): void {
    expect(globalThis.Headers).toBe(new Response().headers.constructor)
    expect(new Headers({ a: '1' }).get('a')).toBe('1')
  }

  it('replaces globalThis.Headers while the loader runs, then restores it', async () => {
    let during: PropertyDescriptor | undefined
    const answer = await withInertHeaders(async () => {
      during = Object.getOwnPropertyDescriptor(globalThis, 'Headers')
      return 'loaded'
    })
    expect(answer).toBe('loaded')
    // a plain value, not Node's lazy accessor over its bundled undici
    expect(during?.value).toBeTypeOf('function')
    expect(during?.get).toBeUndefined()
    expectBuiltinHeaders()
  })

  it('restores the built-in when the loader throws', async () => {
    await expect(
      withInertHeaders(async () => {
        throw new Error('jsdom refused to load')
      }),
    ).rejects.toThrow('jsdom refused to load')
    expectBuiltinHeaders()
  })

  it('leaves no stub behind in a process that had no Headers', async () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, 'Headers')
    delete (globalThis as { Headers?: unknown }).Headers
    try {
      await withInertHeaders(async () => undefined)
      expect('Headers' in globalThis).toBe(false)
    } finally {
      if (before) Object.defineProperty(globalThis, 'Headers', before)
    }
  })

  it('still loads a usable jsdom', async () => {
    const { JSDOM } = await withInertHeaders(() => import('jsdom'))
    const dom = new JSDOM('<!doctype html><html><head><title>ok</title></head></html>')
    expect(dom.window.document.title).toBe('ok')
  })
})
