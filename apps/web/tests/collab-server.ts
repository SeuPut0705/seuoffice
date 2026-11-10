/**
 * The co-editing server the browser tests talk to, on the launcher's own
 * origin (the launcher's CSP allows `connect-src 'self'`). A real host
 * authenticates the upgrade itself; this one trusts the query:
 * `/collab?doc=<id>&user=<id>&name=<shown name>&access=edit|view`.
 *
 * Specs steer it from Node through `/collab-test?op=<op>&doc=<id>[&user=<id>]`
 * (`serverHook` in collab.ts), a socket that answers one JSON frame and closes:
 * - `cut`: drop the user's sockets abruptly, as a network does; the page reconnects
 * - `hold`: drop them and refuse the user's upgrades until `release`
 * - `release`: take the user's upgrades again
 * - `diverge`: an extra editor socket joins the document and reports a fingerprint no page
 *   has, so the session ends as `diverged` at its current version
 * - `reset`: the host's `collab.reset(documentId)`
 */
import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
// the server from its source: Node resolves the package without the seuoffice-source condition
import {
  createCollabServer,
  memoryStore,
  type CollabServer,
  type ServerSocket,
} from '../../../packages/collab/src/server/index'

export const COLLAB_PATH = '/collab'
export const CONTROL_PATH = '/collab-test'

/** how long `diverge` waits for a page to report its fingerprint (pages report every 10 s) */
const DIVERGE_WAIT_MS = 30_000

interface Session {
  ws: WebSocket
  documentId: string
  userId: string
}

/** What `diverge` repeats of an editor's hello: the epoch's format and a file that joins it */
interface Hello {
  format: { name: string; schema: number }
  fileHash: string
}

const userKey = (documentId: string, userId: string): string => `${documentId}\n${userId}`

export function attachCollabServer(http: Server): void {
  const collab = createCollabServer({ store: memoryStore() })
  const sockets = new WebSocketServer({ noServer: true })
  const sessions = new Set<Session>()
  const held = new Set<string>()
  // the format and file of each document's latest editor hello: what `diverge` says hello with
  const hellos = new Map<string, Hello>()

  const serverSocket = (session: Session): ServerSocket => ({
    send: (frame) => {
      if (session.ws.readyState === session.ws.OPEN) session.ws.send(frame)
    },
    close: (code, reason) => session.ws.close(code, reason),
    onMessage: (handler) =>
      session.ws.on('message', (data, binary) => {
        if (!binary) noteHello(session.documentId, String(data))
        handler(binary ? new Uint8Array(data as Buffer) : String(data))
      }),
    onClose: (handler) => session.ws.on('close', handler),
  })

  function noteHello(documentId: string, frame: string): void {
    if (!frame.startsWith('{"t":"hello"')) return
    // a frame the collab server will refuse must not throw in the socket's handler
    let hello: Hello
    try {
      hello = JSON.parse(frame) as Hello
    } catch {
      return
    }
    hellos.set(documentId, { format: hello.format, fileHash: hello.fileHash })
  }

  function dropUser(documentId: string, userId: string): number {
    let dropped = 0
    for (const session of sessions) {
      if (session.documentId !== documentId || session.userId !== userId) continue
      session.ws.terminate()
      dropped += 1
    }
    return dropped
  }

  async function control(query: URLSearchParams): Promise<Record<string, unknown>> {
    const documentId = query.get('doc')
    const userId = query.get('user')
    if (!documentId) throw new Error('no doc')
    switch (query.get('op')) {
      case 'cut':
        return { dropped: dropUser(documentId, need(userId)) }
      case 'hold':
        held.add(userKey(documentId, need(userId)))
        return { dropped: dropUser(documentId, need(userId)) }
      case 'release':
        held.delete(userKey(documentId, need(userId)))
        return {}
      case 'diverge':
        return diverge(collab, documentId, hellos.get(documentId))
      case 'reset':
        await collab.reset(documentId)
        return {}
      default:
        throw new Error(`no op ${query.get('op')}`)
    }
  }

  http.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === CONTROL_PATH) {
      sockets.handleUpgrade(request, socket, head, (ws) => {
        control(url.searchParams).then(
          (answer) => ws.send(JSON.stringify({ ok: true, ...answer }), () => ws.close()),
          (error: unknown) =>
            ws.send(JSON.stringify({ ok: false, error: String(error) }), () => ws.close()),
        )
      })
      return
    }
    if (url.pathname !== COLLAB_PATH) return
    const documentId = url.searchParams.get('doc')
    const userId = url.searchParams.get('user')
    if (!documentId || !userId || held.has(userKey(documentId, userId))) {
      socket.destroy()
      return
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const session: Session = { ws, documentId, userId }
      sessions.add(session)
      ws.on('close', () => sessions.delete(session))
      collab.accept(serverSocket(session), {
        documentId,
        userId,
        name: url.searchParams.get('name') ?? userId,
        canEdit: url.searchParams.get('access') !== 'view',
      })
    })
  })
  http.on('close', () => void collab.close())
}

function need(userId: string | null): string {
  if (!userId) throw new Error('no user')
  return userId
}

/**
 * Join `documentId` as one more editor and report, at the head it was welcomed at, a
 * fingerprint no page computes. The server compares it with the pages' own report at that
 * version (now, or when they next report) and ends the session as `diverged`.
 */
function diverge(
  collab: CollabServer,
  documentId: string,
  hello: Hello | undefined,
): Promise<Record<string, unknown>> {
  if (!hello) return Promise.reject(new Error(`no editor said hello to ${documentId}`))
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>()
  let deliver: ((frame: string | Uint8Array) => void) | undefined
  let leave: (() => void) | undefined
  let head = -1
  const timer = setTimeout(() => {
    leave?.()
    reject(new Error(`no page reported a fingerprint at ${head} in time`))
  }, DIVERGE_WAIT_MS)
  const socket: ServerSocket = {
    send: (frame) => {
      if (typeof frame !== 'string') return
      const sent = JSON.parse(frame) as { t: string; head?: number; v?: number; code?: string }
      if (sent.t === 'welcome') {
        head = sent.head!
        // queued behind the welcome's catch-up, so the server has sent this socket every change
        deliver!(JSON.stringify({ t: 'fingerprint', v: head, fp: 'not-the-document' }))
      } else if (sent.t === 'diverged') {
        clearTimeout(timer)
        resolve({ v: sent.v })
      } else if (sent.t === 'error') {
        clearTimeout(timer)
        reject(new Error(`the server refused the extra editor: ${sent.code}`))
      }
    },
    close: () => {},
    onMessage: (handler) => (deliver = handler),
    onClose: (handler) => (leave = handler),
  }
  collab.accept(socket, {
    documentId,
    userId: 'diverging-editor',
    name: 'diverging-editor',
    canEdit: true,
  })
  deliver!(JSON.stringify({ t: 'hello', p: 1, format: hello.format, fileHash: hello.fileHash }))
  return promise
}
