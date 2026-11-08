// The rules behind the shared ai:read-url handler (docs, pdf, markdown,
// html): what a request must look like before the read-url tool runs, and
// what an exception the tool promised never to throw answers. Nothing here
// imports Electron — the ipcMain wiring itself is a code-review matter.
import { describe, expect, it } from 'vitest'
import { normalizeReadUrlRequest, unexpectedReadUrlFailure } from '../src/main/read-url-ipc'

describe('normalizeReadUrlRequest', () => {
  it('refuses a url that is not a string with invalid_url', () => {
    for (const url of [undefined, null, 42, true, {}, ['https://example.com']]) {
      expect(normalizeReadUrlRequest(url, 0)).toEqual({
        ok: false,
        error: 'url must be a string',
        errorCode: 'invalid_url',
      })
    }
  })

  it('refuses an empty or blank url the same way', () => {
    for (const url of ['', '   ', '\n\t']) {
      expect(normalizeReadUrlRequest(url, 0)).toEqual({
        ok: false,
        error: 'url must be a string',
        errorCode: 'invalid_url',
      })
    }
  })

  it('passes a usable url through as given: trimming and the address check belong to the tool', () => {
    expect(normalizeReadUrlRequest(' https://example.com/a ', 0)).toEqual({
      ok: true,
      url: ' https://example.com/a ',
      offset: 0,
    })
  })

  it('reads a non-number offset from the start', () => {
    for (const offset of [undefined, null, '500', true, {}]) {
      expect(normalizeReadUrlRequest('https://example.com', offset)).toEqual({
        ok: true,
        url: 'https://example.com',
        offset: 0,
      })
    }
  })

  it('passes a number offset through as given: the tool floors and clamps it', () => {
    expect(normalizeReadUrlRequest('https://example.com', 500)).toEqual({
      ok: true,
      url: 'https://example.com',
      offset: 500,
    })
    expect(normalizeReadUrlRequest('https://example.com', 2.9)).toEqual({
      ok: true,
      url: 'https://example.com',
      offset: 2.9,
    })
  })
})

describe('unexpectedReadUrlFailure', () => {
  it("answers an exception that escaped the tool with the tool's network cause", () => {
    expect(unexpectedReadUrlFailure()).toEqual({
      ok: false,
      error: 'The read failed.',
      errorCode: 'network',
    })
  })

  it('answers a fresh object each time, so one caller cannot poison the next', () => {
    const first = unexpectedReadUrlFailure()
    first.error = 'changed'
    expect(unexpectedReadUrlFailure().error).toBe('The read failed.')
  })
})
