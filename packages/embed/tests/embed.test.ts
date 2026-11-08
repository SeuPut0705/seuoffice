import { afterEach, describe, expect, it, vi } from 'vitest'
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
    // inherited object keys are not extensions
    expect(appForFileName('x.constructor')).toBeNull()
    expect(appForFileName('x.__proto__')).toBeNull()
    expect(appForFileName('x.toString')).toBeNull()
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

  it('sends only the bytes of a Buffer view and leaves the caller storage intact', () => {
    const backing = new Uint8Array([0xaa, 1, 2, 3, 0xbb])
    // Buffer#slice returns a view, unlike Uint8Array#slice
    const view = Buffer.from(backing.buffer, 1, 3)
    const doc = openDocument(document.body, { baseUrl: BASE, fileName: 'a.pdf', bytes: view })
    const sent = vi.spyOn(doc.iframe.contentWindow!, 'postMessage').mockImplementation(() => {})
    post(doc.iframe.contentWindow, 'https://office.example', { type: 'ready' })
    const message = sent.mock.calls[0]![0] as { bytes: ArrayBuffer }
    expect(Array.from(new Uint8Array(message.bytes))).toEqual([1, 2, 3])
    expect(Array.from(backing)).toEqual([0xaa, 1, 2, 3, 0xbb])
    doc.destroy()
  })
})

describe('editing', () => {
  const ORIGIN = 'https://office.example'

  function openForEdit(onSave: (file: { fileName: string; bytes: Uint8Array }) => Promise<void>) {
    const dirty: boolean[] = []
    const doc = openDocument(document.body, {
      baseUrl: BASE,
      fileName: 'memo.hwpx',
      bytes: new Uint8Array([1]),
      mode: 'edit',
      onSave,
      onDirtyChange: (value) => dirty.push(value),
    })
    const sent = vi.spyOn(doc.iframe.contentWindow!, 'postMessage').mockImplementation(() => {})
    post(doc.iframe.contentWindow, ORIGIN, { type: 'ready' })
    post(doc.iframe.contentWindow, ORIGIN, { type: 'opened' })
    const replies = () =>
      sent.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((m) => m.type !== 'open')
    return { doc, dirty, replies }
  }

  it('stores saves one at a time in the order the page sent them', async () => {
    const started: number[] = []
    const finishers: Array<() => void> = []
    const { doc, replies } = openForEdit((file) => {
      started.push(file.bytes[0]!)
      return new Promise<void>((resolve) => finishers.push(resolve))
    })
    post(doc.iframe.contentWindow, ORIGIN, {
      type: 'save',
      saveId: 1,
      fileName: 'memo.hwpx',
      bytes: new Uint8Array([1]).buffer,
    })
    post(doc.iframe.contentWindow, ORIGIN, {
      type: 'save',
      saveId: 2,
      fileName: 'memo.hwpx',
      bytes: new Uint8Array([2]).buffer,
    })
    await vi.waitFor(() => expect(started).toEqual([1]))
    // the newer save waits: a slow older store must not land after it
    expect(replies()).toEqual([])
    finishers[0]!()
    await vi.waitFor(() => expect(started).toEqual([1, 2]))
    finishers[1]!()
    await vi.waitFor(() => expect(replies().map((m) => m.saveId)).toEqual([1, 2]))
    doc.destroy()
  })

  it('opens the page in edit mode and stores what the page saves under the opened name', async () => {
    const stored: { fileName: string; bytes: number[] }[] = []
    const { doc, replies } = openForEdit(async (file) => {
      stored.push({ fileName: file.fileName, bytes: Array.from(file.bytes) })
    })
    expect(doc.iframe.src).toBe('https://office.example/hwp/index.html?mode=edit&lang=ko')
    post(doc.iframe.contentWindow, ORIGIN, {
      type: 'save',
      saveId: 7,
      fileName: 'other.hwpx',
      bytes: new Uint8Array([4, 5]).buffer,
    })
    await vi.waitFor(() =>
      expect(replies()).toEqual([{ source: 'seuoffice', version: 1, type: 'saved', saveId: 7 }]),
    )
    expect(stored).toEqual([{ fileName: 'memo.hwpx', bytes: [4, 5] }])
    doc.destroy()
  })

  it('tells the page why the host did not store the bytes', async () => {
    const { doc, replies } = openForEdit(async () => {
      throw new Error('lock lost')
    })
    post(doc.iframe.contentWindow, ORIGIN, {
      type: 'save',
      saveId: 1,
      fileName: 'memo.hwpx',
      bytes: new ArrayBuffer(1),
    })
    await vi.waitFor(() =>
      expect(replies()).toEqual([
        { source: 'seuoffice', version: 1, type: 'save_failed', saveId: 1, message: 'lock lost' },
      ]),
    )
    doc.destroy()
  })

  it('ignores a save from another origin', () => {
    const onSave = vi.fn(async () => {})
    const { doc } = openForEdit(onSave)
    post(doc.iframe.contentWindow, 'https://evil.example', {
      type: 'save',
      saveId: 1,
      fileName: 'memo.hwpx',
      bytes: new ArrayBuffer(1),
    })
    expect(onSave).not.toHaveBeenCalled()
    doc.destroy()
  })

  it('forwards dirty changes', () => {
    const { doc, dirty } = openForEdit(async () => {})
    post(doc.iframe.contentWindow, ORIGIN, { type: 'dirty', dirty: true })
    post(doc.iframe.contentWindow, ORIGIN, { type: 'dirty', dirty: false })
    expect(dirty).toEqual([true, false])
    doc.destroy()
  })

  it('save() asks the page and settles with its answer', async () => {
    const { doc, replies } = openForEdit(async () => {})
    const first = doc.save()
    const second = doc.save()
    const [one, two] = replies() as { requestId: number }[]
    expect(replies().map((m) => m.type)).toEqual(['request_save', 'request_save'])
    post(doc.iframe.contentWindow, ORIGIN, {
      type: 'request_save_done',
      requestId: two!.requestId,
      ok: false,
      message: 'disk full',
    })
    post(doc.iframe.contentWindow, ORIGIN, {
      type: 'request_save_done',
      requestId: one!.requestId,
      ok: true,
    })
    await expect(first).resolves.toBeUndefined()
    expect(await codeOf(second)).toBe('save_failed')
    doc.destroy()
  })

  it('save() refuses in view mode and rejects pending requests on destroy', async () => {
    const view = openDocument(document.body, {
      baseUrl: BASE,
      fileName: 'a.pdf',
      bytes: new Uint8Array(1),
    })
    expect(await codeOf(view.save())).toBe('save_failed')
    view.destroy()
    const { doc } = openForEdit(async () => {})
    const pending = doc.save()
    doc.destroy()
    expect(await codeOf(pending)).toBe('save_failed')
  })
})
