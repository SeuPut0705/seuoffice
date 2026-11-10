import { toyMap, type ToyEditor, type MapOp } from '@seuoffice/collab/conformance'
import {
  createCollabServer,
  memoryStore,
  type CollabServer,
  type CollabStore,
  type ServerSocket,
} from '@seuoffice/collab/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChannelModule from '../src/embed-channel'
import type * as PageModule from '../src/collab-page'
import type { CollabStatus } from '../src/collab-types'

const HOST = location.origin

let host: Window
let sent: Record<string, unknown>[]
let channel: typeof ChannelModule
let page: typeof PageModule
let server: CollabServer
let store: CollabStore

function fromHost(data: Record<string, unknown>): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: host,
      origin: HOST,
      data: { source: 'seuoffice', version: 1, ...data },
    }),
  )
}

/**
 * The host end of the embed channel as `@seuoffice/embed` plays it: each
 * `collab_connect` opens a socket on the real server, frames go both ways
 * verbatim, and a `save` is stored and answered.
 */
function playHost(options: { canEdit: boolean }): {
  stored: { bytes: Uint8Array; version: unknown }[]
} {
  const stored: { bytes: Uint8Array; version: unknown }[] = []
  const sockets = new Map<number, { message?: (frame: string | Uint8Array) => void }>()
  vi.spyOn(host, 'postMessage').mockImplementation((message: unknown) => {
    const data = message as Record<string, unknown>
    sent.push(data)
    const id = data.connectId as number
    if (data.type === 'collab_connect') {
      const socket: { message?: (frame: string | Uint8Array) => void } = {}
      sockets.set(id, socket)
      const serverSocket: ServerSocket = {
        send: (frame) =>
          queueMicrotask(() =>
            fromHost({
              type: 'collab_frame',
              connectId: id,
              frame: typeof frame === 'string' ? frame : frame.slice().buffer,
            }),
          ),
        close: () => queueMicrotask(() => fromHost({ type: 'collab_close', connectId: id })),
        onMessage: (handler) => (socket.message = handler),
        onClose: () => {},
      }
      server.accept(serverSocket, {
        documentId: 'memo',
        userId: 'u1',
        name: 'User 1',
        canEdit: options.canEdit,
      })
      queueMicrotask(() => fromHost({ type: 'collab_open', connectId: id }))
    } else if (data.type === 'collab_frame') {
      const frame = data.frame
      sockets
        .get(id)
        ?.message?.(typeof frame === 'string' ? frame : new Uint8Array(frame as ArrayBuffer))
    } else if (data.type === 'save') {
      stored.push({ bytes: new Uint8Array(data.bytes as ArrayBuffer), version: data.collabVersion })
      queueMicrotask(() => fromHost({ type: 'saved', saveId: data.saveId }))
    }
  })
  return { stored }
}

async function open(collab: boolean): Promise<void> {
  const opening = channel.receiveOpen()
  fromHost({ type: 'open', fileName: 'memo.toy', bytes: new ArrayBuffer(1), collab })
  await opening
}

const statuses = (): CollabStatus[] =>
  sent
    .filter((message) => message.type === 'collab_status')
    .map((message) => message.status as CollabStatus)

function join(editors: ToyEditor<MapOp>[]) {
  return page.joinPageCollab<{ bytes: Uint8Array }, MapOp>({
    format: toyMap.format,
    fileName: 'memo.toy',
    bytes: toyMap.file(),
    adapter: ({ bytes }) => {
      const editor = toyMap.open(bytes)
      editors.push(editor)
      return editor
    },
  })
}

beforeEach(async () => {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  host = frame.contentWindow!
  sent = []
  Object.defineProperty(window, 'parent', { value: host, configurable: true })
  store = memoryStore()
  server = createCollabServer({ store })
  // the channel keeps one host per page load, so each test loads a fresh copy
  // the host opened the page for editing, so a save request finds the session's handler
  history.replaceState(null, '', '/?mode=edit')
  vi.resetModules()
  channel = await import('../src/embed-channel')
  page = await import('../src/collab-page')
})

afterEach(async () => {
  await server.close()
  delete window.seuCollab
  Object.defineProperty(window, 'parent', { value: window, configurable: true })
  document.body.replaceChildren()
})

describe('joining a co-edited page', () => {
  it('is null and loads nothing when the host did not ask for co-editing', async () => {
    playHost({ canEdit: true })
    await open(false)
    expect(await join([])).toBeNull()
    expect(window.seuCollab).toBeUndefined()
    expect(sent.some((message) => String(message.type).startsWith('collab_'))).toBe(false)
  })

  it('joins before the editor opens and goes live once the renderer attaches', async () => {
    playHost({ canEdit: true })
    await open(true)
    const editors: ToyEditor<MapOp>[] = []
    const collab = (await join(editors))!
    expect(collab.baseBytes).toEqual(toyMap.file())
    expect(statuses()).toEqual([])

    await window.seuCollab!.attach({ bytes: collab.baseBytes })
    await vi.waitFor(() =>
      expect(statuses().at(-1)).toMatchObject({ phase: 'live', canEdit: true }),
    )
    // a second attach is the same session
    await collab.attach({ bytes: collab.baseBytes })
    expect(editors).toHaveLength(1)
  })

  it('answers a host save with the bytes of one exact version and reports it stored', async () => {
    const { stored } = playHost({ canEdit: true })
    await open(true)
    const editors: ToyEditor<MapOp>[] = []
    const collab = (await join(editors))!
    await collab.attach({ bytes: collab.baseBytes })
    editors[0].perform({ id: 'a', key: 'a', value: 1 })
    editors[0].perform({ id: 'b', key: 'b', value: 2 })
    await vi.waitFor(() => expect(statuses().at(-1)).toMatchObject({ version: 2, unconfirmed: 0 }))

    fromHost({ type: 'request_save', requestId: 7 })
    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'request_save_done', requestId: 7, ok: true }),
      ),
    )
    expect(stored).toHaveLength(1)
    expect(stored[0].version).toBe(2)
    expect(new TextDecoder().decode(stored[0].bytes)).toBe('[["a",1],["b",2]]')
    await vi.waitFor(() => expect(statuses().at(-1)).toMatchObject({ saved: 2 }))
    // the host hears unsaved while the log is ahead of the stored file, saved once it caught up
    const dirty = sent.filter((message) => message.type === 'dirty').map((message) => message.dirty)
    expect(dirty).toEqual([false, true, false])
  })

  it('tells the editor every status it tells the host, from the attach on', async () => {
    playHost({ canEdit: true })
    await open(true)
    const editors: ToyEditor<MapOp>[] = []
    const heard: CollabStatus[] = []
    const collab = (await page.joinPageCollab<{ bytes: Uint8Array }, MapOp>({
      format: toyMap.format,
      fileName: 'memo.toy',
      bytes: toyMap.file(),
      adapter: ({ bytes }) => {
        const editor = toyMap.open(bytes)
        editors.push(editor)
        return editor
      },
      status: (status) => heard.push(status),
    }))!
    expect(heard).toEqual([])
    await collab.attach({ bytes: collab.baseBytes })
    editors[0].perform({ id: 'a', key: 'a', value: 1 })
    await vi.waitFor(() => expect(heard.at(-1)).toMatchObject({ version: 1, unconfirmed: 0 }))
    fromHost({ type: 'request_save', requestId: 1 })
    await vi.waitFor(() => expect(heard.at(-1)).toMatchObject({ version: 1, saved: 1 }))
    expect(heard).toEqual(statuses())
  })

  it('refuses a host save before the renderer attached', async () => {
    playHost({ canEdit: true })
    await open(true)
    await join([])
    fromHost({ type: 'request_save', requestId: 3 })
    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'request_save_done', requestId: 3, ok: false }),
      ),
    )
  })

  it('forwards a principal that cannot edit as a live, read-only status', async () => {
    // a viewer never seeds a session: an editor opened this document first
    const base = toyMap.file()
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(base)))
    const baseHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
    await store.create('memo', { id: 'epoch', format: toyMap.format, baseHash, base })
    playHost({ canEdit: false })
    await open(true)
    const editors: ToyEditor<MapOp>[] = []
    const collab = (await join(editors))!
    await collab.attach({ bytes: collab.baseBytes })
    await vi.waitFor(() =>
      expect(statuses().at(-1)).toMatchObject({ phase: 'live', canEdit: false }),
    )
    expect(editors[0].editable).toBe(false)
  })

  it('leaves the session and tells the host when the editor cannot co-edit', async () => {
    playHost({ canEdit: true })
    await open(true)
    const collab = (await page.joinPageCollab<null, MapOp>({
      format: toyMap.format,
      fileName: 'memo.toy',
      bytes: toyMap.file(),
      adapter: async () => {
        throw new Error('an edit kind this editor cannot sync')
      },
    }))!
    await collab.attach(null)
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'error',
        code: 'collab_unavailable',
        message: 'an edit kind this editor cannot sync',
      }),
    )
    expect(sent).toContainEqual(expect.objectContaining({ type: 'collab_disconnect' }))
    await expect(collab.save()).rejects.toThrow()
  })
})

describe('what the page allows around the session', () => {
  const keydown = (): boolean => {
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    return event.defaultPrevented
  }

  it('takes no input between the join and the attach', async () => {
    playHost({ canEdit: true })
    await open(true)
    const collab = (await join([]))!
    expect(keydown()).toBe(true)
    await collab.attach({ bytes: collab.baseBytes })
    expect(keydown()).toBe(false)
  })

  it('takes input before the attach only where the editor asks for it', async () => {
    playHost({ canEdit: true })
    await open(true)
    const prompt = document.createElement('input')
    prompt.className = 'password'
    document.body.appendChild(prompt)
    const collab = (await page.joinPageCollab<{ bytes: Uint8Array }, MapOp>({
      format: toyMap.format,
      fileName: 'memo.toy',
      bytes: toyMap.file(),
      adapter: ({ bytes }) => toyMap.open(bytes),
      inputBeforeAttach: (target) => target instanceof Element && target.matches('.password'),
    }))!
    const typed = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    prompt.dispatchEvent(typed)
    expect(typed.defaultPrevented).toBe(false)
    expect(keydown()).toBe(true)
    await collab.attach({ bytes: collab.baseBytes })
    expect(keydown()).toBe(false)
  })

  it('runs the editor’s own flow on a host save, which commits what is open before the session saves', async () => {
    const { stored } = playHost({ canEdit: true })
    await open(true)
    const editors: ToyEditor<MapOp>[] = []
    const collab = (await page.joinPageCollab<{ bytes: Uint8Array }, MapOp>({
      format: toyMap.format,
      fileName: 'memo.toy',
      bytes: toyMap.file(),
      adapter: ({ bytes }) => {
        const editor = toyMap.open(bytes)
        editors.push(editor)
        return editor
      },
      hostSave: async (save) => {
        editors[0].perform({ id: 'open', key: 'draft', value: 7 })
        await save()
      },
    }))!
    await collab.attach({ bytes: collab.baseBytes })
    fromHost({ type: 'request_save', requestId: 4 })
    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'request_save_done', requestId: 4, ok: true }),
      ),
    )
    expect(stored).toHaveLength(1)
    expect(stored[0].version).toBe(1)
    expect(new TextDecoder().decode(stored[0].bytes)).toBe('[["draft",7]]')
    // the app's own save does not run the host's flow again
    await collab.save()
    expect(stored).toHaveLength(2)
    expect(new TextDecoder().decode(stored[1].bytes)).toBe('[["draft",7]]')
  })

  it('answers no save request on a page the host opened for viewing', async () => {
    history.replaceState(null, '', '/?mode=view')
    playHost({ canEdit: true })
    await open(true)
    const collab = (await join([]))!
    await collab.attach({ bytes: collab.baseBytes })
    fromHost({ type: 'request_save', requestId: 9 })
    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'request_save_done', requestId: 9, ok: false }),
      ),
    )
  })

  it('stores nothing for the app’s repeated save when the host holds the head', async () => {
    const { stored } = playHost({ canEdit: true })
    await open(true)
    const editors: ToyEditor<MapOp>[] = []
    const collab = (await join(editors))!
    await collab.attach({ bytes: collab.baseBytes })
    editors[0].perform({ id: 'a', key: 'a', value: 1 })
    await vi.waitFor(() => expect(statuses().at(-1)).toMatchObject({ version: 1, unconfirmed: 0 }))
    await collab.save({ skipWhenSaved: true })
    await vi.waitFor(() => expect(statuses().at(-1)).toMatchObject({ saved: 1 }))
    await collab.save({ skipWhenSaved: true })
    expect(stored).toHaveLength(1)
  })

  it('names this page as the host named its user, once the editor attached', async () => {
    playHost({ canEdit: true })
    await open(true)
    const collab = (await join([]))!
    expect(collab.self()).toBeNull()
    await collab.attach({ bytes: collab.baseBytes })
    expect(collab.self()).toMatchObject({ name: 'User 1' })
  })

  it('tells the editor the document is unsaved from an edit until a save stored it', async () => {
    playHost({ canEdit: true })
    await open(true)
    const editors: ToyEditor<MapOp>[] = []
    const collab = (await join(editors))!
    await collab.attach({ bytes: collab.baseBytes })
    const unsaved = () => window.seuCollab!.unsaved!()
    expect(unsaved()).toBe(false)
    editors[0].perform({ id: 'a', key: 'a', value: 1 })
    // unconfirmed already counts: the edit is in no stored file
    expect(unsaved()).toBe(true)
    await vi.waitFor(() => expect(statuses().at(-1)).toMatchObject({ version: 1, unconfirmed: 0 }))
    expect(unsaved()).toBe(true)
    await collab.save()
    await vi.waitFor(() => expect(unsaved()).toBe(false))
  })
})
