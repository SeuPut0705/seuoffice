import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDocument, type EmbeddedDocument } from '../src/index'

const BASE = 'https://office.example/'
const ORIGIN = 'https://office.example'

function post(source: Window | null, data: Record<string, unknown>): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      source,
      origin: ORIGIN,
      data: { source: 'seuoffice', version: 1, ...data },
    }),
  )
}

/** A co-edited document the page has shown; `requests` are the export ids this side asked for */
function openShown() {
  const onSave = vi.fn(async () => {})
  const connect = vi.fn(() => {
    throw new Error('the export must not touch the socket')
  })
  const doc = openDocument(document.body, {
    baseUrl: BASE,
    fileName: 'memo.docx',
    bytes: new Uint8Array([1]),
    mode: 'edit',
    collab: { connect, exportTimeoutMs: 1000 },
    onSave,
  })
  const spy = vi.spyOn(doc.iframe.contentWindow!, 'postMessage').mockImplementation(() => {})
  const page = (data: Record<string, unknown>) => post(doc.iframe.contentWindow, data)
  page({ type: 'ready', collab: true })
  page({ type: 'opened' })
  const requests = () =>
    spy.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((message) => message.type === 'collab_export')
      .map((message) => message.requestId as string)
  return { doc, page, requests, onSave, connect }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('exporting what the page shows', () => {
  it("resolves with the page's file and never saves or connects", async () => {
    const { doc, page, requests, onSave, connect } = openShown()
    const exporting = doc.exportLocal()
    const [requestId] = requests()
    expect(typeof requestId).toBe('string')
    page({
      type: 'collab_export_done',
      requestId,
      ok: true,
      fileName: 'memo.docx',
      bytes: new Uint8Array([4, 2]).buffer,
    })
    await expect(exporting).resolves.toEqual({
      fileName: 'memo.docx',
      bytes: new Uint8Array([4, 2]),
    })
    expect(onSave).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it("rejects with the page's reason when it refuses", async () => {
    const { doc, page, requests } = openShown()
    const exporting = doc.exportLocal()
    page({ type: 'collab_export_done', requestId: requests()[0], ok: false, message: 'no model' })
    await expect(exporting).rejects.toMatchObject({ code: 'save_failed', message: 'no model' })
  })

  it('rejects when the page does not answer in time and ignores a late answer', async () => {
    const { doc, page, requests } = openShown()
    const exporting = doc.exportLocal()
    const refused = expect(exporting).rejects.toMatchObject({ code: 'save_failed' })
    await vi.advanceTimersByTimeAsync(999)
    let done = false
    void exporting.catch(() => (done = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await refused
    page({
      type: 'collab_export_done',
      requestId: requests()[0],
      ok: true,
      fileName: 'memo.docx',
      bytes: new ArrayBuffer(1),
    })
  })

  it('rejects every export in flight on destroy()', async () => {
    const { doc } = openShown()
    const exporting = doc.exportLocal()
    doc.destroy()
    await expect(exporting).rejects.toMatchObject({ code: 'save_failed' })
  })

  it('gives each of two concurrent exports its own answer', async () => {
    const { doc, page, requests } = openShown()
    const first = doc.exportLocal()
    const second = doc.exportLocal()
    const [a, b] = requests()
    expect(a).not.toBe(b)
    page({ type: 'collab_export_done', requestId: b, ok: false, message: 'second refused' })
    page({
      type: 'collab_export_done',
      requestId: a,
      ok: true,
      fileName: 'memo.docx',
      bytes: new Uint8Array([1]).buffer,
    })
    await expect(first).resolves.toMatchObject({ bytes: new Uint8Array([1]) })
    await expect(second).rejects.toThrow('second refused')
  })

  it('rejects without asking the page when the document was opened without co-editing', async () => {
    const doc = openDocument(document.body, {
      baseUrl: BASE,
      fileName: 'memo.docx',
      bytes: new Uint8Array([1]),
    })
    const spy = vi.spyOn(doc.iframe.contentWindow!, 'postMessage').mockImplementation(() => {})
    post(doc.iframe.contentWindow, { type: 'ready' })
    post(doc.iframe.contentWindow, { type: 'opened' })
    // the member is typed only for co-editing; a host that reaches it anyway gets a refusal
    const exportLocal = Reflect.get(doc, 'exportLocal') as () => Promise<unknown>
    await expect(exportLocal()).rejects.toMatchObject({ code: 'save_failed' })
    expect(spy.mock.calls.map((call) => (call[0] as { type: string }).type)).toEqual(['open'])
    // @ts-expect-error exportLocal exists only on documents opened with `collab`
    void (doc satisfies EmbeddedDocument).exportLocal
  })
})
