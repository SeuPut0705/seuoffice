// No imports here: packages/collab/tests/host-types.test.ts compiles this
// file alone to prove the copies below still equal the engine's own types.

/**
 * Structurally identical to `CollabLink` of `@seuoffice/collab/client`,
 * which owns it: what the co-editing engine needs from the network.
 */
export interface CollabLink {
  open(): void
  send(frame: string | Uint8Array): void
  close(): void
  subscribe(handler: (event: CollabLinkEvent) => void): () => void
}

export type CollabLinkEvent =
  { type: 'open' } | { type: 'close' } | { type: 'frame'; frame: string | Uint8Array }

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
