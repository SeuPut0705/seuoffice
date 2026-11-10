/**
 * The data both sides share (design section 2). A document has one epoch at a
 * time: a base file plus a gapless log of changes; the state at version V is
 * the base opened, then changes 1..V applied in order. Nothing on the server
 * reads `ops`.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** The editor format a document is edited in; a client with another format cannot join */
export interface Format {
  name: string
  schema: number
}

/** Version `v` of an epoch: submit `seq` of `client`, made by the user `author` */
export interface Change {
  v: number
  client: string
  seq: number
  author: string
  ops: Json[]
}

/** One connected client, as everyone sees it */
export interface Peer {
  client: string
  name: string
}
