/**
 * Checks that a `CollabStore` keeps the contract the server's ordering
 * guarantee rests on. Each case makes its own documents, under fresh ids,
 * so a store backed by one shared database can run every case. A case
 * throws on the first broken promise; nothing here depends on a test runner.
 */

import type { Change, Format, Json } from '../model.js'
import type { AppendRequest, AppendResult, CollabStore, EpochHead } from '../server/store.js'

export interface StoreContractCase {
  name: string
  /** set when the case cannot run against this store; `run` then does nothing */
  skip: string | undefined
  run(): Promise<void>
}

export interface StoreContractOptions {
  /**
   * A second store instance over the same backing data as `store`, as another server process
   * would open it. Leave it out for a store that lives in one process; that case is skipped.
   */
  reopen?: ((store: CollabStore) => CollabStore | Promise<CollabStore>) | undefined
  /** concurrent calls in the race cases; default 16 */
  concurrency?: number | undefined
}

const FORMAT: Format = { name: 'store-contract', schema: 1 }
const HASH = 'a'.repeat(64)

class ContractError extends Error {
  override name = 'StoreContractError'
}

function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new ContractError(message)
}

function show(value: unknown): string {
  const text = JSON.stringify(value)
  return text.length > 200 ? `${text.slice(0, 200)}...` : text
}

/** JSON equality that ignores key order: ops are opaque JSON, and many databases reorder keys */
function sameJson(a: Json, b: Json): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameJson(item, b[i] as Json))
    )
  }
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => key in b && sameJson(a[key] as Json, b[key] as Json))
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i])
}

function expectResult(actual: AppendResult, expected: AppendResult, what: string): void {
  check(
    sameJson(actual as unknown as Json, expected as unknown as Json),
    `${what}: expected ${show(expected)}, got ${show(actual)}`,
  )
}

async function rejects(work: () => Promise<unknown>, what: string): Promise<void> {
  let rejected = false
  try {
    await work()
  } catch {
    rejected = true
  }
  check(rejected, `${what}: expected a rejection`)
}

function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function base(size = 64): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff
  return bytes
}

function change(
  baseVersion: number,
  client: string,
  seq: number,
  ops: Json[] = [`${client}.${seq}`],
): AppendRequest {
  return { base: baseVersion, client, seq, author: `author of ${client}`, ops }
}

/** a document with a fresh epoch on `store` */
async function opened(store: CollabStore, baseBytes = base()) {
  const documentId = uniqueId('doc')
  const epochId = uniqueId('epoch')
  const created = await store.create(documentId, {
    id: epochId,
    format: FORMAT,
    baseHash: HASH,
    base: baseBytes,
  })
  check(created === 'created', `create on a new document: expected created, got ${show(created)}`)
  return { documentId, epochId }
}

async function appendAll(
  store: CollabStore,
  documentId: string,
  epochId: string,
  count: number,
  ops: (i: number) => Json[] = (i) => [i],
): Promise<AppendRequest[]> {
  const sent: AppendRequest[] = []
  for (let i = 0; i < count; i++) {
    const request = change(i, `c${i % 3}`, Math.floor(i / 3) + 1, ops(i))
    expectResult(
      await store.append(documentId, epochId, request),
      { kind: 'appended', v: i + 1 },
      `append ${i + 1} at its head`,
    )
    sent.push(request)
  }
  return sent
}

function expectLog(log: Change[], sent: AppendRequest[], from: number, what: string): void {
  log.forEach((entry, i) => {
    const v = from + i + 1
    check(entry.v === v, `${what}: position ${i} holds version ${entry.v}, expected ${v}`)
    const request = sent[v - 1]
    check(request !== undefined, `${what}: version ${v} was never appended`)
    const { client, seq, author, ops } = request
    check(
      entry.client === client && entry.seq === seq && entry.author === author,
      `${what}: version ${v} is ${show({ client: entry.client, seq: entry.seq, author: entry.author })}, expected ${show({ client, seq, author })}`,
    )
    check(
      sameJson(entry.ops, ops),
      `${what}: the ops of version ${v} changed on the way through the store`,
    )
  })
}

function expectHead(head: EpochHead | null, expected: Partial<EpochHead>, what: string): void {
  check(head !== null, `${what}: load found no epoch`)
  for (const [key, value] of Object.entries(expected)) {
    const actual = head[key as keyof EpochHead]
    check(
      sameJson(actual as unknown as Json, value as Json),
      `${what}: load gave ${key} ${show(actual)}, expected ${show(value)}`,
    )
  }
}

/** an op of a few hundred KiB: every byte value of UTF-16, surrogate pairs and nesting included */
function largeOp(): Json {
  let text = ''
  for (let i = 0; i < 150_000; i++) {
    const code = 0x20 + ((i * 7919) % 0xd7c0)
    text += String.fromCharCode(code)
    if (i % 997 === 0) text += '\u{1F600}\u{10FFFD}"\\\n\t'
  }
  return { text, nested: [1, -2.5, 1e21, null, true, false, { deep: [[], {}, ''] }], n: 0 }
}

export function storeContract(
  makeStore: () => CollabStore | Promise<CollabStore>,
  options: StoreContractOptions = {},
): StoreContractCase[] {
  const concurrency = options.concurrency ?? 16
  const reopen = options.reopen

  const cases: (Omit<StoreContractCase, 'skip'> & { needsReopen?: true })[] = [
    {
      name: 'load finds nothing on a new document, then the head of the epoch create made',
      async run() {
        const store = await makeStore()
        check((await store.load(uniqueId('doc'))) === null, 'load on a new document: expected null')
        const { documentId, epochId } = await opened(store)
        expectHead(
          await store.load(documentId),
          { id: epochId, format: FORMAT, baseHash: HASH, head: 0, saved: 0 },
          'a fresh epoch',
        )
      },
    },
    {
      name: 'create is first-wins: created, then exists, and the first epoch stays',
      async run() {
        const store = await makeStore()
        const { documentId, epochId } = await opened(store)
        const again = await store.create(documentId, {
          id: uniqueId('epoch'),
          format: { name: 'other', schema: 9 },
          baseHash: 'b'.repeat(64),
          base: base(8),
        })
        check(again === 'exists', `a second create: expected exists, got ${show(again)}`)
        expectHead(
          await store.load(documentId),
          { id: epochId, format: FORMAT },
          'after a second create',
        )
        check(
          sameBytes(await store.readBase(documentId, epochId), base()),
          'a second create replaced the base',
        )
      },
    },
    {
      name: `create is first-wins under ${concurrency} concurrent creates`,
      async run() {
        const store = await makeStore()
        const documentId = uniqueId('doc')
        const ids = Array.from({ length: concurrency }, () => uniqueId('epoch'))
        const answers = await Promise.all(
          ids.map((id, i) =>
            store.create(documentId, { id, format: FORMAT, baseHash: HASH, base: base(16 + i) }),
          ),
        )
        const winners = ids.filter((_, i) => answers[i] === 'created')
        check(
          winners.length === 1,
          `concurrent creates: ${winners.length} answered created, expected 1`,
        )
        check(
          answers.every((answer) => answer === 'created' || answer === 'exists'),
          `concurrent creates: unexpected answers ${show(answers)}`,
        )
        const winner = winners[0]!
        expectHead(
          await store.load(documentId),
          { id: winner, head: 0 },
          'after concurrent creates',
        )
        const winnerBase = base(16 + ids.indexOf(winner))
        check(
          sameBytes(await store.readBase(documentId, winner), winnerBase),
          'concurrent creates: the base is not the one the winner gave',
        )
      },
    },
    {
      name: 'readBase returns exactly the bytes given to create',
      async run() {
        const store = await makeStore()
        const bytes = base(1024 * 1024 + 3)
        const { documentId, epochId } = await opened(store, bytes)
        check(
          sameBytes(await store.readBase(documentId, epochId), bytes),
          'readBase changed the base',
        )
      },
    },
    {
      name: 'append appends only at the head, and answers stale with the head otherwise',
      async run() {
        const store = await makeStore()
        const { documentId, epochId } = await opened(store)
        await appendAll(store, documentId, epochId, 2)
        expectResult(
          await store.append(documentId, epochId, change(1, 'late', 1)),
          { kind: 'stale', head: 2 },
          'append below the head',
        )
        expectResult(
          await store.append(documentId, epochId, change(5, 'early', 1)),
          { kind: 'stale', head: 2 },
          'append past the head',
        )
        expectResult(
          await store.append(documentId, epochId, change(2, 'late', 1)),
          { kind: 'appended', v: 3 },
          'the stale submit again, at the head',
        )
        expectHead(await store.load(documentId), { head: 3 }, 'after stale answers')
      },
    },
    {
      name: 'a repeated (client, seq) is a duplicate with its first version, whatever its base',
      async run() {
        const store = await makeStore()
        const { documentId, epochId } = await opened(store)
        const first = change(0, 'twice', 1)
        expectResult(
          await store.append(documentId, epochId, first),
          { kind: 'appended', v: 1 },
          'first append',
        )
        expectResult(
          await store.append(documentId, epochId, change(1, 'other', 1)),
          { kind: 'appended', v: 2 },
          'another client',
        )
        expectResult(
          await store.append(documentId, epochId, first),
          { kind: 'duplicate', v: 1 },
          'the same submit again, its base now stale',
        )
        expectResult(
          await store.append(documentId, epochId, { ...first, base: 2 }),
          { kind: 'duplicate', v: 1 },
          'the same (client, seq) at the current head',
        )
        expectResult(
          await store.append(documentId, epochId, change(2, 'twice', 2)),
          { kind: 'appended', v: 3 },
          'the next seq of that client',
        )
        expectHead(await store.load(documentId), { head: 3 }, 'after duplicates')
      },
    },
    {
      name: 'append answers gone for an unknown document, another epoch, and a dropped epoch',
      async run() {
        const store = await makeStore()
        expectResult(
          await store.append(uniqueId('doc'), uniqueId('epoch'), change(0, 'c', 1)),
          { kind: 'gone' },
          'append on an unknown document',
        )
        const { documentId, epochId } = await opened(store)
        expectResult(
          await store.append(documentId, uniqueId('epoch'), change(0, 'c', 1)),
          { kind: 'gone' },
          'append naming another epoch',
        )
        await store.drop(documentId, epochId)
        expectResult(
          await store.append(documentId, epochId, change(0, 'c', 1)),
          { kind: 'gone' },
          'append on a dropped epoch',
        )
      },
    },
    {
      name: `${concurrency} concurrent appends at one base: one appended, the rest stale`,
      async run() {
        const store = await makeStore()
        const { documentId, epochId } = await opened(store)
        await appendAll(store, documentId, epochId, 1)
        const answers = await Promise.all(
          Array.from({ length: concurrency }, (_, i) =>
            store.append(documentId, epochId, change(1, `racer${i}`, 1)),
          ),
        )
        const appended = answers.filter((answer) => answer.kind === 'appended')
        check(
          appended.length === 1,
          `concurrent appends at one base: ${appended.length} appended, expected 1 (${show(answers)})`,
        )
        expectResult(appended[0]!, { kind: 'appended', v: 2 }, 'the one that won')
        for (const answer of answers) {
          if (answer.kind !== 'appended')
            expectResult(answer, { kind: 'stale', head: 2 }, 'a loser')
        }
        const log = await store.read(documentId, epochId, 0, 10)
        check(log.length === 2, `concurrent appends left ${log.length} versions, expected 2`)
      },
    },
    {
      name: `${concurrency} concurrent copies of one submit: one appended, the rest duplicate`,
      async run() {
        const store = await makeStore()
        const { documentId, epochId } = await opened(store)
        const submit = change(0, 'resent', 1)
        const answers = await Promise.all(
          Array.from({ length: concurrency }, () => store.append(documentId, epochId, submit)),
        )
        const appended = answers.filter((answer) => answer.kind === 'appended')
        check(
          appended.length === 1,
          `copies of one submit: ${appended.length} appended, expected 1`,
        )
        for (const answer of answers) {
          if (answer.kind !== 'appended') {
            expectResult(answer, { kind: 'duplicate', v: 1 }, 'a later copy')
          }
        }
        const log = await store.read(documentId, epochId, 0, 10)
        check(log.length === 1, `copies of one submit left ${log.length} versions, expected 1`)
      },
    },
    {
      name: 'read is ordered, gapless, honours its limit and returns what was appended',
      async run() {
        const store = await makeStore()
        const { documentId, epochId } = await opened(store)
        const sent = await appendAll(store, documentId, epochId, 10)
        expectLog(await store.read(documentId, epochId, 0, 3), sent, 0, 'read(0, 3)')
        check(
          (await store.read(documentId, epochId, 0, 3)).length === 3,
          'read(0, 3) did not give 3',
        )
        const rest = await store.read(documentId, epochId, 3, 100)
        check(rest.length === 7, `read(3, 100) gave ${rest.length} changes, expected 7`)
        expectLog(rest, sent, 3, 'read(3, 100)')
        check(
          (await store.read(documentId, epochId, 9, 1)).length === 1,
          'read(9, 1) did not give 1',
        )
        check(
          (await store.read(documentId, epochId, 10, 5)).length === 0,
          'read past the head gave changes',
        )
      },
    },
    {
      name: 'an op of several hundred KiB comes back from read exactly as appended',
      async run() {
        const store = await makeStore()
        const { documentId, epochId } = await opened(store)
        const op = largeOp()
        const sent = await appendAll(store, documentId, epochId, 3, (i) =>
          i === 1 ? [op, 'x'] : [i],
        )
        expectLog(await store.read(documentId, epochId, 0, 10), sent, 0, 'read with a large op')
      },
    },
    {
      name: 'markSaved returns the highest version reported and never moves back',
      async run() {
        const store = await makeStore()
        const { documentId, epochId } = await opened(store)
        await appendAll(store, documentId, epochId, 3)
        const answers = [
          await store.markSaved(documentId, epochId, 2),
          await store.markSaved(documentId, epochId, 1),
          await store.markSaved(documentId, epochId, 3),
          await store.markSaved(documentId, epochId, 2),
        ]
        check(
          sameJson(answers, [2, 2, 3, 3]),
          `markSaved answered ${show(answers)}, expected [2,2,3,3]`,
        )
        expectHead(await store.load(documentId), { head: 3, saved: 3 }, 'after markSaved')
      },
    },
    {
      name: 'drop ends the epoch it names; a later create starts again at version 0',
      async run() {
        const store = await makeStore()
        const { documentId, epochId } = await opened(store)
        await appendAll(store, documentId, epochId, 2)
        await store.markSaved(documentId, epochId, 2)
        await store.drop(documentId, uniqueId('epoch'))
        expectHead(
          await store.load(documentId),
          { id: epochId, head: 2 },
          'after dropping another epoch',
        )

        await store.drop(documentId, epochId)
        check((await store.load(documentId)) === null, 'load after drop: expected null')
        await rejects(() => store.read(documentId, epochId, 0, 10), 'read on a dropped epoch')
        await rejects(() => store.readBase(documentId, epochId), 'readBase on a dropped epoch')

        const next = uniqueId('epoch')
        const created = await store.create(documentId, {
          id: next,
          format: FORMAT,
          baseHash: HASH,
          base: base(5),
        })
        check(created === 'created', `create after drop: expected created, got ${show(created)}`)
        expectHead(await store.load(documentId), { id: next, head: 0, saved: 0 }, 'the next epoch')
        check(
          (await store.read(documentId, next, 0, 10)).length === 0,
          'the next epoch inherited changes',
        )
        expectResult(
          await store.append(documentId, next, change(0, 'c0', 1)),
          { kind: 'appended', v: 1 },
          'a seq the dropped epoch had already used',
        )
      },
    },
    {
      name: 'documents do not share epochs, logs or seqs',
      async run() {
        const store = await makeStore()
        const one = await opened(store)
        const two = await opened(store)
        await appendAll(store, one.documentId, one.epochId, 3)
        expectHead(await store.load(two.documentId), { head: 0 }, 'the other document')
        expectResult(
          await store.append(two.documentId, two.epochId, change(0, 'c0', 1)),
          { kind: 'appended', v: 1 },
          'a (client, seq) used on another document',
        )
        expectResult(
          await store.append(two.documentId, one.epochId, change(1, 'c9', 1)),
          { kind: 'gone' },
          "append naming another document's epoch",
        )
      },
    },
    {
      name: 'a second instance over the same data sees the same epoch and shares its guarantees',
      needsReopen: true,
      async run() {
        if (!reopen) return
        const first = await makeStore()
        const { documentId, epochId } = await opened(first, base(300))
        const sent = await appendAll(first, documentId, epochId, 4)
        await first.markSaved(documentId, epochId, 3)

        const second = await reopen(first)
        expectHead(
          await second.load(documentId),
          { id: epochId, format: FORMAT, baseHash: HASH, head: 4, saved: 3 },
          'the second instance',
        )
        check(
          sameBytes(await second.readBase(documentId, epochId), base(300)),
          'the second instance has another base',
        )
        expectLog(await second.read(documentId, epochId, 0, 10), sent, 0, 'the second instance')

        const next = change(4, 'from-second', 1)
        expectResult(
          await second.append(documentId, epochId, next),
          { kind: 'appended', v: 5 },
          'append on the second',
        )
        expectResult(
          await first.append(documentId, epochId, next),
          { kind: 'duplicate', v: 5 },
          'the same on the first',
        )
        const answers = await Promise.all([
          first.append(documentId, epochId, change(5, 'a', 9)),
          second.append(documentId, epochId, change(5, 'b', 9)),
        ])
        check(
          answers.filter((answer) => answer.kind === 'appended').length === 1,
          `one append at one base from each instance: ${show(answers)}`,
        )
      },
    },
  ]

  return cases.map(({ needsReopen, ...each }) => ({
    ...each,
    skip: needsReopen && !reopen ? 'the store lives in one process: no reopen given' : undefined,
  }))
}
