/**
 * The host end of the co-editing pipe. The host owns the WebSocket (it holds
 * the credentials and authenticates the upgrade); the page only sees frames.
 *
 * Every connection carries the page's `connectId`. A frame, open or close
 * that belongs to an older connection is dropped on both sides, so a
 * reconnect can never mix the frames of two sockets.
 */

/** The subset of the browser WebSocket the pipe uses; `new WebSocket(url)` satisfies it */
export interface WebSocketLike {
  binaryType: 'blob' | 'arraybuffer'
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
}

export interface CollabRelay {
  /**
   * Open a socket to the co-editing server for this document, authenticated
   * by the host. Return it before it opens (right after `new WebSocket`):
   * the pipe listens for its `open` event.
   */
  connect(): Promise<WebSocketLike> | WebSocketLike
  /** the page's co-editing state, every time it changes */
  onStatus?(status: CollabStatus): void
}

type Post = (message: Record<string, unknown>, transfer?: Transferable[]) => void

interface Connection {
  id: number
  socket: WebSocketLike | null
  open: boolean
}

export interface CollabPipe {
  /** a page message whose type starts with `collab_`; anything malformed is ignored */
  onPageMessage(data: Record<string, unknown>): void
  close(): void
}

export function createCollabPipe(relay: CollabRelay, post: Post): CollabPipe {
  let current: Connection | null = null

  const drop = (): void => {
    const connection = current
    current = null
    connection?.socket?.close()
  }

  const connect = async (id: number): Promise<void> => {
    drop()
    const connection: Connection = { id, socket: null, open: false }
    current = connection
    let socket: WebSocketLike
    try {
      socket = await relay.connect()
    } catch {
      if (current !== connection) return
      current = null
      post({ type: 'collab_close', connectId: id })
      return
    }
    // a newer connect, a disconnect or destroy() came first: this socket is nobody's
    if (current !== connection) {
      socket.close()
      return
    }
    connection.socket = socket
    socket.binaryType = 'arraybuffer'
    const end = (): void => {
      if (current !== connection) return
      current = null
      socket.close()
      post({ type: 'collab_close', connectId: id })
    }
    socket.addEventListener('open', () => {
      if (current !== connection || connection.open) return
      connection.open = true
      post({ type: 'collab_open', connectId: id })
    })
    socket.addEventListener('message', (event) => {
      if (current !== connection || !connection.open) return
      const frame = event.data
      if (typeof frame === 'string') post({ type: 'collab_frame', connectId: id, frame })
      else if (frame instanceof ArrayBuffer)
        post({ type: 'collab_frame', connectId: id, frame }, [frame])
    })
    socket.addEventListener('close', end)
    socket.addEventListener('error', end)
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
        void connect(id)
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
