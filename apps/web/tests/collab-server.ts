/**
 * The co-editing server the browser tests talk to, on the launcher's own
 * origin (the launcher's CSP allows `connect-src 'self'`). A real host
 * authenticates the upgrade itself; this one trusts the query:
 * `/collab?doc=<id>&user=<id>&name=<shown name>&access=edit|view`.
 */
import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
// the server from its source: Node resolves the package without the seuoffice-source condition
import {
  createCollabServer,
  memoryStore,
  type ServerSocket,
} from '../../../packages/collab/src/server/index'

export const COLLAB_PATH = '/collab'

const serverSocket = (ws: WebSocket): ServerSocket => ({
  send: (frame) => {
    if (ws.readyState === ws.OPEN) ws.send(frame)
  },
  close: (code, reason) => ws.close(code, reason),
  onMessage: (handler) =>
    ws.on('message', (data, binary) =>
      handler(binary ? new Uint8Array(data as Buffer) : String(data)),
    ),
  onClose: (handler) => ws.on('close', handler),
})

export function attachCollabServer(http: Server): void {
  const collab = createCollabServer({ store: memoryStore() })
  const sockets = new WebSocketServer({ noServer: true })
  http.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== COLLAB_PATH) return
    const documentId = url.searchParams.get('doc')
    const userId = url.searchParams.get('user')
    if (!documentId || !userId) {
      socket.destroy()
      return
    }
    sockets.handleUpgrade(request, socket, head, (ws) =>
      collab.accept(serverSocket(ws), {
        documentId,
        userId,
        name: url.searchParams.get('name') ?? userId,
        canEdit: url.searchParams.get('access') !== 'view',
      }),
    )
  })
  http.on('close', () => void collab.close())
}
