/**
 * The host end of the co-editing pipe. The host owns the WebSocket (it holds
 * the credentials and authenticates the upgrade); the page only sees frames.
 *
 * Every connection carries the page's `connectId`. A frame, open or close
 * that belongs to an older connection is dropped on both sides, so a
 * reconnect can never mix the frames of two sockets.
 *
 * The page cannot make the host open sockets in a loop: `connect()` runs at
 * most once per MIN_CONNECT_INTERVAL_MS; a request that comes sooner waits,
 * and a newer request replaces a waiting one.
 */

/** The subset of the browser WebSocket the pipe uses; `new WebSocket(url)` satisfies it */
export interface WebSocketLike {
  binaryType: 'blob' | 'arraybuffer'
  /** 0 connecting, 1 open, 2 closing, 3 closed; read once, when `connect()` hands the socket over */
  readonly readyState?: number
  send(data: string | ArrayBuffer): void
  close(code?: number, reason?: string): void
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: unknown }) => void,
  ): void
}

/** Structurally identical to `CollabStatus` of `@seuoffice/collab/client`, which owns it */
export type CollabStatus = {
  phase: 'joining' | 'live' | 'offline' | 'failed'
  failure?: 'schema_mismatch' | 'reset' | 'diverged' | 'superseded' | 'forbidden' | 'adapter'
  canEdit: boolean
  version: number
  saved: number
  unconfirmed: number
  peers: { client: string; name: string }[]
  /** this page as the others see it among `peers`; null before the first welcome */
  self: { client: string; name: string } | null
}

export interface CollabRelay {
  /**
   * Open a socket to the co-editing server for this document, authenticated
   * by the host. A socket still connecting, or already open, both work.
   */
  connect(): Promise<WebSocketLike> | WebSocketLike
  /** the page's co-editing state, every time it changes */
  onStatus?(status: CollabStatus): void
  /** how long `connect()` plus the socket's opening may take; default 15000 */
  connectTimeoutMs?: number
}

const MIN_CONNECT_INTERVAL_MS = 250
const OPEN = 1
const CLOSING = 2

type Post = (message: Record<string, unknown>, transfer?: Transferable[]) => void

interface Connection {
  id: number
  socket: WebSocketLike | null
  open: boolean
  /** the wait before `connect()`, then the open deadline; cleared once open or dropped */
  timer: ReturnType<typeof setTimeout> | undefined
}

export interface CollabPipe {
  /** a page message whose type starts with `collab_`; anything malformed is ignored */
  onPageMessage(data: Record<string, unknown>): void
  close(): void
}

export function createCollabPipe(relay: CollabRelay, post: Post): CollabPipe {
  let current: Connection | null = null
  let lastConnectAt = -Infinity

  const drop = (): void => {
    const connection = current
    current = null
    clearTimeout(connection?.timer)
    connection?.socket?.close()
  }

  /** this connection failed: close what it has and tell the page, unless it was already replaced */
  const fail = (connection: Connection): void => {
    if (current !== connection) return
    drop()
    post({ type: 'collab_close', connectId: connection.id })
  }

  const markOpen = (connection: Connection): void => {
    if (current !== connection || connection.open) return
    connection.open = true
    clearTimeout(connection.timer)
    post({ type: 'collab_open', connectId: connection.id })
  }

  const start = async (connection: Connection): Promise<void> => {
    lastConnectAt = Date.now()
    connection.timer = setTimeout(() => fail(connection), relay.connectTimeoutMs ?? 15000)
    let socket: WebSocketLike
    try {
      socket = await relay.connect()
    } catch {
      fail(connection)
      return
    }
    // a newer connect, a disconnect, a timeout or destroy() came first: this socket is nobody's
    if (current !== connection) {
      socket.close()
      return
    }
    connection.socket = socket
    socket.binaryType = 'arraybuffer'
    const id = connection.id
    socket.addEventListener('open', () => markOpen(connection))
    socket.addEventListener('message', (event) => {
      if (current !== connection || !connection.open) return
      const frame = event.data
      if (typeof frame === 'string') post({ type: 'collab_frame', connectId: id, frame })
      else if (frame instanceof ArrayBuffer)
        post({ type: 'collab_frame', connectId: id, frame }, [frame])
    })
    socket.addEventListener('close', () => fail(connection))
    socket.addEventListener('error', () => fail(connection))
    // an already open socket fires no `open` event again; a closing one never opens
    if (socket.readyState === OPEN) markOpen(connection)
    else if (socket.readyState !== undefined && socket.readyState >= CLOSING) fail(connection)
  }

  const connect = (id: number): void => {
    drop()
    const connection: Connection = { id, socket: null, open: false, timer: undefined }
    current = connection
    const wait = lastConnectAt + MIN_CONNECT_INTERVAL_MS - Date.now()
    if (wait <= 0) void start(connection)
    else connection.timer = setTimeout(() => void start(connection), wait)
  }

  return {
    onPageMessage(data) {
      if (data.type === 'collab_status') {
        if (data.status && typeof data.status === 'object')
          relay.onStatus?.(data.status as CollabStatus)
        return
      }
      const id = data.connectId
      if (typeof id !== 'number') return
      if (data.type === 'collab_connect') {
        connect(id)
      } else if (data.type === 'collab_disconnect') {
        if (current?.id === id) drop()
      } else if (data.type === 'collab_frame') {
        if (current?.id !== id || !current.open || !current.socket) return
        const frame = data.frame
        if (typeof frame === 'string' || frame instanceof ArrayBuffer) current.socket.send(frame)
      }
    },
    close: drop,
  }
}
