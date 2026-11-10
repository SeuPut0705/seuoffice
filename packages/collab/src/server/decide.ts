/**
 * The server's decisions as pure functions of the stored epoch head and one
 * frame (design section 4, Rules). The socket and store shell in server.ts
 * carries them out.
 */

import type { HelloFrame, SubmitFrame } from '../wire.js'
import type { AppendRequest, EpochHead } from './store.js'

export type HelloDecision =
  | { kind: 'need_base' }
  | { kind: 'wait' }
  | { kind: 'reject'; code: 'schema_mismatch' | 'reset' }
  /** `client` null: issue a new client id */
  | { kind: 'welcome'; epoch: EpochHead; client: string | null; start: number; sendBase: boolean }

export interface HelloContext {
  /** another socket of the document was already asked for the base */
  seeding: boolean
  /** the user who was issued `hello.resume.client` in this epoch, when the server knows */
  owner: string | undefined
  /** the user saying hello */
  user: string
}

export function decideHello(
  epoch: EpochHead | null,
  hello: HelloFrame,
  { seeding, owner, user }: HelloContext,
): HelloDecision {
  // Someone else's client id is not this user's to resume or to supersede
  const resume = owner === undefined || owner === user ? hello.resume : undefined
  if (!epoch) {
    if (resume) return { kind: 'reject', code: 'reset' }
    return seeding ? { kind: 'wait' } : { kind: 'need_base' }
  }
  if (epoch.format.name !== hello.format.name || epoch.format.schema !== hello.format.schema) {
    return { kind: 'reject', code: 'schema_mismatch' }
  }
  if (resume) {
    // A version past the head cannot belong to this epoch's log
    if (resume.epoch !== epoch.id || resume.v > epoch.head) return { kind: 'reject', code: 'reset' }
    return { kind: 'welcome', epoch, client: resume.client, start: resume.v, sendBase: false }
  }
  return {
    kind: 'welcome',
    epoch,
    client: null,
    start: 0,
    sendBase: hello.fileHash !== epoch.baseHash,
  }
}

export type SubmitDecision =
  { kind: 'reject'; code: 'bad_frame' | 'forbidden' } | { kind: 'append'; change: AppendRequest }

/** `client` is null until the socket was welcomed */
export function decideSubmit(
  sender: { client: string | null; canEdit: boolean; author: string },
  submit: SubmitFrame,
): SubmitDecision {
  if (sender.client === null) return { kind: 'reject', code: 'bad_frame' }
  if (!sender.canEdit) return { kind: 'reject', code: 'forbidden' }
  const { seq, base, ops } = submit
  return {
    kind: 'append',
    change: { base, client: sender.client, seq, author: sender.author, ops },
  }
}
