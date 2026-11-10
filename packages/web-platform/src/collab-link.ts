import type { CollabLink, CollabLinkEvent, CollabStatus } from './collab-types'
import { hostRelaysCollab, onCollabMessage, reply } from './embed-channel'

export type { CollabLink, CollabLinkEvent, CollabStatus } from './collab-types'

/**
 * One connection at a time. `connectId` fences it: the host tags every
 * open, frame and close with the id of the connect it answers, and anything
 * tagged with an older id is dropped, so frames of a replaced socket never
 * reach the engine and the engine's frames never reach a replaced socket.
 */
type LinkState = { kind: 'idle' } | { kind: 'connecting' | 'open'; id: number }

let link: CollabLink | undefined

/** The pipe to the host's co-editing socket; null unless the host's `open` asked for it */
export function collabLink(): CollabLink | null {
  if (!hostRelaysCollab()) return null
  link ??= createLink()
  return link
}

/** Tell the host the co-editing state; nothing is sent unless the host asked for co-editing */
export function reportCollabStatus(status: CollabStatus): void {
  if (hostRelaysCollab()) reply({ type: 'collab_status', status })
}

function createLink(): CollabLink {
  let state: LinkState = { kind: 'idle' }
  let nextId = 1
  const handlers = new Set<(event: CollabLinkEvent) => void>()
  const emit = (event: CollabLinkEvent): void => {
    for (const handler of [...handlers]) handler(event)
  }

  onCollabMessage((data) => {
    if (state.kind === 'idle' || data.connectId !== state.id) return
    if (data.type === 'collab_open' && state.kind === 'connecting') {
      state = { kind: 'open', id: state.id }
      emit({ type: 'open' })
    } else if (data.type === 'collab_frame' && state.kind === 'open') {
      const frame = data.frame
      if (typeof frame === 'string') emit({ type: 'frame', frame })
      else if (frame instanceof ArrayBuffer) emit({ type: 'frame', frame: new Uint8Array(frame) })
    } else if (data.type === 'collab_close') {
      state = { kind: 'idle' }
      emit({ type: 'close' })
    }
  })

  return {
    open() {
      if (state.kind !== 'idle') return
      state = { kind: 'connecting', id: nextId++ }
      reply({ type: 'collab_connect', connectId: state.id })
    },
    send(frame) {
      // a frame after the socket closed is dropped: the engine learns of the close from its event
      if (state.kind !== 'open') return
      if (typeof frame === 'string') {
        reply({ type: 'collab_frame', connectId: state.id, frame })
        return
      }
      // an exact fresh copy the page can transfer without losing its own
      const copy = new Uint8Array(frame.byteLength)
      copy.set(frame)
      reply({ type: 'collab_frame', connectId: state.id, frame: copy.buffer }, [copy.buffer])
    },
    close() {
      if (state.kind === 'idle') return
      reply({ type: 'collab_disconnect', connectId: state.id })
      state = { kind: 'idle' }
    },
    subscribe(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
}
