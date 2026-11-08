import { afterEach, describe, expect, it } from 'vitest'
import { appForFileName, openDocument, SeuofficeEmbedError } from '../src/index'

const BASE = 'https://office.example/'

function post(source: Window | null, origin: string, data: Record<string, unknown>): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      source,
      origin,
      data: { source: 'seuoffice', version: 1, ...data },
    }),
  )
}

async function codeOf(promise: Promise<void>): Promise<string> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(SeuofficeEmbedError)
  return (error as SeuofficeEmbedError).code
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('appForFileName', () => {
  it('maps extensions case-insensitively and rejects the rest', () => {
    expect(appForFileName('a.HWPX')).toBe('hwp')
    expect(appForFileName('x.doc')).toBeNull()
    expect(appForFileName('noext')).toBeNull()
    expect(appForFileName('r.tar.pdf')).toBe('pdf')
  })
})

describe('openDocument', () => {
  it('rejects a file over the size limit without creating a frame', async () => {
    const doc = openDocument(document.body, {
      baseUrl: BASE,
      fileName: 'big.pdf',
      bytes: new Uint8Array(51 * 1024 * 1024),
    })
    expect(await codeOf(doc.opened)).toBe('too_large')
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('rejects an unknown format', async () => {
    const doc = openDocument(document.body, {
      baseUrl: BASE,
      fileName: 'notes.txt',
      bytes: new Uint8Array(1),
    })
    expect(await codeOf(doc.opened)).toBe('unsupported_format')
  })

  it('ignores ready from another origin and times out', async () => {
    const doc = openDocument(document.body, {
      baseUrl: BASE,
      fileName: 'a.pdf',
      bytes: new Uint8Array(4),
      readyTimeoutMs: 50,
    })
    post(doc.iframe.contentWindow, 'https://evil.example', { type: 'ready' })
    post(doc.iframe.contentWindow, 'https://evil.example', { type: 'opened' })
    expect(await codeOf(doc.opened)).toBe('timeout')
  })

  it('rejects with the page error code after a valid ready', async () => {
    const doc = openDocument(document.body, {
      baseUrl: BASE,
      fileName: 'a.docx',
      bytes: new Uint8Array(4),
    })
    expect(doc.iframe.src).toBe('https://office.example/docs/index.html?mode=view&lang=ko')
    post(doc.iframe.contentWindow, 'https://office.example', { type: 'ready' })
    post(doc.iframe.contentWindow, 'https://office.example', {
      type: 'error',
      code: 'open_failed',
      message: 'x',
    })
    expect(await codeOf(doc.opened)).toBe('open_failed')
    doc.destroy()
    expect(document.querySelector('iframe')).toBeNull()
  })
})
