import { parseDocx, type ParsedDoc } from '@genoffice/docx-engine'
import {
  joinCollab,
  MAX_CHANGE_BYTES,
  type CollabLink,
  type CollabLinkEvent,
  type CollabSession,
} from '@seuoffice/collab/client'
import { createCollabServer, memoryStore, type CollabServer } from '@seuoffice/collab/server'
import { Editor } from '@tiptap/core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { authorName, onAuthorNameChanged, setAuthorName } from '../src/renderer/author-name'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { installBridges } from '../src/web/bridge'
import { createDocsAdapter } from '../src/web/collab-adapter'
import { docsSide } from '../src/web/collab-side'
import { fakeApp } from './helpers/collab-app'

const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
const FORMAT = { name: 'docx', schema: 2 }

let server: CollabServer
let bytes: Uint8Array
let parsed: ParsedDoc
const editors: Editor[] = []

function socketFor(name: string, events: (event: CollabLinkEvent) => void) {
  let toServer: ((frame: string | Uint8Array) => void) | undefined
  server.accept(
    {
      send: (frame) =>
        queueMicrotask(() =>
          events({
            type: 'frame',
            frame: typeof frame === 'string' ? frame : new Uint8Array(frame),
          }),
        ),
      close: () => queueMicrotask(() => events({ type: 'close' })),
      onMessage: (handler) => (toServer = handler),
      onClose: () => {},
    },
    { documentId: 'memo', userId: name, name, canEdit: true },
  )
  queueMicrotask(() => events({ type: 'open' }))
  return (frame: string | Uint8Array) =>
    toServer?.(typeof frame === 'string' ? frame : new Uint8Array(frame))
}

/**
 * The embedding host for the docs web page: it opens the page's document for
 * co-editing and relays the page's socket, which the server knows as Bob.
 */
function playHost(): void {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const host = frame.contentWindow!
  Object.defineProperty(window, 'parent', { value: host, configurable: true })
  const fromHost = (data: Record<string, unknown>) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source: host,
        origin: location.origin,
        data: { source: 'seuoffice', version: 1, ...data },
      }),
    )
  const sockets = new Map<unknown, (frame: string | Uint8Array) => void>()
  vi.spyOn(host, 'postMessage').mockImplementation((message: unknown) => {
    const data = message as Record<string, unknown>
    if (data.type === 'ready') {
      const copy = bytes.slice().buffer
      queueMicrotask(() =>
        fromHost({ type: 'open', fileName: 'memo.docx', bytes: copy, collab: true }),
      )
    } else if (data.type === 'collab_connect') {
      const id = data.connectId
      sockets.set(
        id,
        socketFor('Bob', (event) =>
          fromHost({
            type: `collab_${event.type}`,
            connectId: id,
            ...(event.type === 'frame'
              ? {
                  frame: typeof event.frame === 'string' ? event.frame : event.frame.slice().buffer,
                }
              : {}),
          }),
        ),
      )
    } else if (data.type === 'collab_frame') {
      const frame = data.frame
      sockets.get(data.connectId)?.(
        typeof frame === 'string' ? frame : new Uint8Array(frame as ArrayBuffer),
      )
    }
  })
}

/** A page that reaches the server on its own socket, as another browser does */
function directLink(name: string): CollabLink {
  let handler: ((event: CollabLinkEvent) => void) | null = null
  let send: ((frame: string | Uint8Array) => void) | null = null
  return {
    open: () => {
      send ??= socketFor(name, (event) => handler?.(event))
    },
    send: (frame) => send?.(frame),
    close: () => {
      send = null
    },
    subscribe: (next) => {
      handler = next
      return () => (handler = null)
    },
  }
}

/** an editor showing the document with track changes on, and the App state the side store reads */
function openEditor(path: string) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  editors.push(editor)
  editor.storage.trackChanges.enabled = true
  const app = fakeApp({ doc: { filePath: path, format: 'docx', parsed } })
  return { editor, context: app.context }
}

const typeAt = (editor: Editor, before: string, text: string) => {
  let pos = -1
  editor.state.doc.descendants((node, at) => {
    if (pos < 0 && node.isTextblock && node.textContent.includes(before)) pos = at + 1
    return pos < 0
  })
  editor.view.dispatch(editor.state.tr.insertText(text, pos))
}

/** each tracked insertion's text with its author */
const insertions = (editor: Editor): Record<string, string> => {
  const found: Record<string, string> = {}
  editor.state.doc.descendants((node) => {
    const ins = node.isText && node.marks.find((mark) => mark.type.name === 'ins')
    if (ins)
      found[node.text!] = (found[node.text!] ? `${found[node.text!]},` : '') + ins.attrs.author
  })
  return found
}

beforeAll(async () => {
  bytes = new Uint8Array(await buildDocx({ bodyXml: para('alpha beta') + para('zeta eta') }))
  parsed = await parseDocx(bytes)
  server = createCollabServer({ store: memoryStore() })
  history.replaceState(null, '', '/?mode=edit')
})

afterAll(async () => {
  for (const editor of editors.splice(0)) editor.destroy()
  await server.close()
  Object.defineProperty(window, 'parent', { value: window, configurable: true })
})

describe('track changes while two people co-edit', () => {
  it('labels each insertion with the name the host gave its author, on both pages', async () => {
    playHost()
    installBridges()
    // the renderer's boot (main.tsx) and the App's track-changes effect
    setAuthorName(await window.desktop.getAuthorName())
    window.desktop.onAuthorNameChanged(setAuthorName)
    const opened = await window.desktop.consumePendingOpenDocx()
    if (!opened || !('path' in opened)) throw new Error('the page opened no document')
    const bob = openEditor(opened.path)
    const recorder = bob.editor.storage.trackChanges
    recorder.author = authorName()
    onAuthorNameChanged(() => (recorder.author = authorName()))
    await window.seuCollab!.attach(bob)

    const join = await joinCollab(directLink('Alice'), { format: FORMAT, bytes })
    const alice = openEditor('/alice/memo.docx')
    const aliceSession: CollabSession = join.attach(
      createDocsAdapter({
        editor: alice.editor,
        side: docsSide(alice),
        produce: async () => ({ fileName: 'memo.docx', bytes: new Uint8Array() }),
        maxOpBytes: MAX_CHANGE_BYTES - 4096,
      }),
    )
    await vi.waitFor(() => expect(aliceSession.status().phase).toBe('live'))
    alice.editor.storage.trackChanges.author = aliceSession.status().self!.name

    typeAt(alice.editor, 'alpha', 'from alice ')
    typeAt(bob.editor, 'zeta', 'from bob ')
    const both = { 'from alice ': 'Alice', 'from bob ': 'Bob' }
    await vi.waitFor(() => {
      expect(insertions(alice.editor)).toEqual(both)
      expect(insertions(bob.editor)).toEqual(both)
    })
  })
})
