/**
 * Randomized runs of several engines against the real server and
 * `memoryStore()` (design section 6). A seed fixes the whole schedule: which
 * frame is delivered next, edits, saves, late joiners and broken connections,
 * including a break between the store's append and the server's answer. At the
 * end the run goes quiet and the kit checks the invariants. Every failure
 * names its seed.
 */

import { CollabError, type CollabFile } from '../client/api.js'
import type { Change } from '../model.js'
import { parseServerFrame } from '../wire.js'
import {
  oldest,
  SimNetwork,
  type SimClient,
  type SimConnection,
  type SimulatedEditor,
} from './network.js'

/**
 * Chances of what the network does. A frame is never lost or duplicated
 * within a live WebSocket, so the faults are about connections: one breaks,
 * what it had sent is lost (`drop`) or reaches the server only after the
 * client reconnected (`duplicate`, the old submit and its resend both arrive),
 * and different connections overtake each other.
 */
export interface NetworkFaults {
  /** chance per step that a live connection breaks, and per append that its sender's does */
  disconnect: number
  /** chance that a breaking connection loses the frames it had not yet delivered */
  drop: number
  /** chance that those frames wait until the client's next hello reached the server */
  duplicate: number
  reorderAcrossSockets: boolean
}

export interface SimulateOptions<Op> {
  seed: number
  clients: number
  /** scheduler steps before the run goes quiet */
  steps: number
  /** the file every client opens */
  file: CollabFile
  adapterFactory: (bytes: Uint8Array) => SimulatedEditor<Op>
  network?: Partial<NetworkFaults>
}

export interface SimulationReport {
  seed: number
  /** versions in the log */
  head: number
  ops: number
  breaks: number
  /** frames the server got from a connection its client had already given up */
  lateFrames: number
  stale: number
  saves: number
  /** saves that gave up because their edits could not be confirmed in time */
  saveTimeouts: number
  exports: number
  joiners: number
}

const DOCUMENT = 'simulated'
const QUIET_TURNS = 200_000

export async function simulate<Op>(options: SimulateOptions<Op>): Promise<SimulationReport> {
  try {
    return await run(options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`simulate seed ${options.seed}: ${message}`, { cause: error })
  }
}

function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

/** mulberry32: small, fast and the same on every engine */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function run<Op>(options: SimulateOptions<Op>): Promise<SimulationReport> {
  const random = seeded(options.seed)
  const faults: NetworkFaults = {
    disconnect: 0.03,
    drop: 0.3,
    duplicate: 0.3,
    reorderAcrossSockets: true,
    ...options.network,
  }
  // A saved epoch would end after ten idle minutes, by design and with its own scenario. The
  // scheduler may jump the virtual clock that far while every client's connect is still
  // queued, so the runs keep idle epochs.
  const net = new SimNetwork({
    limits: { catchUpPage: 1 + Math.floor(random() * 8), idleEpochMs: Infinity },
  })
  const clients: SimClient<Op>[] = []
  const saves: { version: number; bytes: Uint8Array }[] = []
  const saving = new Set<SimClient<Op>>()
  const failures: string[] = []
  const expected = new Map<SimConnection, number>()
  const clientIds = new Map<string, SimClient<Op>>()
  let stale = 0
  let joiners = 0
  let saveTimeouts = 0
  let exports = 0
  const exporting = new Set<SimClient<Op>>()

  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]

  // Invariant 4, checked on the wire: after welcome, versions arrive one by one
  net.onDeliver = (connection, raw) => {
    const frame = parseServerFrame(raw)
    if (frame.t === 'welcome') {
      expected.set(connection, frame.start + 1)
      clientIds.set(
        frame.client,
        clients.find((client) => client.link === connection.link)!,
      )
    } else if (frame.t === 'change' || frame.t === 'ack') {
      const next = expected.get(connection)
      check(frame.v === next, `a socket got version ${frame.v} where ${next} was due`)
      expected.set(connection, frame.v + 1)
    } else if (frame.t === 'stale') stale += 1
  }

  net.afterAppend = (change, result) => {
    if (result.kind !== 'appended' || random() >= faults.disconnect) return
    const connection = clientIds.get(change.client)?.link.current
    if (connection?.clientOpen) breakConnection(connection)
  }

  function breakConnection(connection: SimConnection): void {
    const drop = random() < faults.drop
    net.break(connection, { drop, hold: !drop && random() < faults.duplicate })
  }

  async function addClient(bytes: Uint8Array): Promise<void> {
    const index = clients.length
    const principal = {
      documentId: DOCUMENT,
      userId: `u${index}`,
      name: `User ${index}`,
      canEdit: true,
    }
    clients.push(
      await net.client(principal, { format: options.file.format, bytes }, options.adapterFactory),
    )
  }

  function save(client: SimClient<Op>): void {
    saving.add(client)
    client.session!.save().then(
      (file) => {
        saving.delete(client)
        saves.push({ version: file.version, bytes: file.bytes })
        client.session!.reportSaved(file.version)
      },
      (error: unknown) => {
        // The virtual clock may run past the save timeout while the network is down; the
        // edits stay pending, and the checks at the end find them confirmed like any other
        if (error instanceof CollabError && error.code === 'offline') {
          saving.delete(client)
          saveTimeouts += 1
        } else failures.push(`save on ${client.principal.userId} failed: ${String(error)}`)
      },
    )
  }

  function exportLocal(client: SimClient<Op>): void {
    exporting.add(client)
    client.session!.exportLocal().then(
      (file) => {
        exporting.delete(client)
        exports += 1
        try {
          options.adapterFactory(file.bytes)
        } catch (error) {
          failures.push(
            `the file ${client.principal.userId} exported does not open: ${String(error)}`,
          )
        }
      },
      (error: unknown) =>
        failures.push(`export on ${client.principal.userId} failed: ${String(error)}`),
    )
  }

  async function deliverOne(): Promise<boolean> {
    const up = net.upReady()
    const down = net.downReady()
    if (up.length === 0 && down.length === 0) return false
    if (faults.reorderAcrossSockets) {
      const toServer = down.length === 0 || (up.length > 0 && random() < 0.5)
      if (toServer) await net.deliverUp(pick(up))
      else await net.deliverDown(pick(down))
    } else {
      const next = oldest(up, 'up', oldest(down, 'down'))!
      await (next.direction === 'up'
        ? net.deliverUp(next.connection)
        : net.deliverDown(next.connection))
    }
    return true
  }

  async function quiet(): Promise<void> {
    for (let turn = 0; turn < QUIET_TURNS; turn++) {
      if (await deliverOne()) continue
      const joined = clients.find((client) => client.join && !client.session)
      if (joined) {
        joined.attach()
        await net.settle()
        continue
      }
      if (net.clock.fire()) {
        await net.settle()
        continue
      }
      return
    }
    throw new Error('the run did not go quiet')
  }

  for (let i = 0; i < options.clients; i++) await addClient(options.file.bytes)

  for (let step = 0; step < options.steps; step++) {
    if (random() < faults.disconnect) {
      const candidates = net.connections().filter((connection) => connection.clientOpen)
      if (candidates.length > 0) breakConnection(pick(candidates))
    }
    const attached = clients.filter((client) => client.session)
    if (random() < 0.02) {
      const idle = attached.filter((client) => !saving.has(client))
      if (idle.length > 0) save(pick(idle))
    }
    if (random() < 0.01) {
      const idle = attached.filter((client) => !exporting.has(client))
      if (idle.length > 0) exportLocal(pick(idle))
    }
    if (joiners < 2 && random() < 0.01) {
      joiners += 1
      // A joiner holding an older saved file is sent the epoch's base instead
      await addClient(saves.length > 0 && random() < 0.5 ? pick(saves).bytes : options.file.bytes)
    }
    const roll = random()
    if (roll < 0.3 && attached.length > 0) pick(attached).edit(random)
    else if (roll < 0.4 && clients.some((client) => client.join && !client.session)) {
      clients.find((client) => client.join && !client.session)!.attach()
    } else if (roll < 0.45 && net.clock.pending > 0) net.clock.fire()
    else await deliverOne()
    await net.settle()
  }

  await quiet()

  for (const client of clients) {
    check(
      client.joinError === null,
      `${client.principal.userId} could not join: ${String(client.joinError)}`,
    )
  }
  check(failures.length === 0, failures.join('; '))
  check(saving.size === 0, 'a save never finished')
  check(exporting.size === 0, 'an export never finished')

  const epoch = await net.store.load(DOCUMENT)
  check(epoch !== null, 'the epoch is gone')
  const log = await net.store.read(DOCUMENT, epoch.id, 0, epoch.head)
  check(log.length === epoch.head, 'the log is shorter than its head')
  const submits = new Set<string>()
  log.forEach((change, i) => {
    check(change.v === i + 1, `version ${change.v} sits at position ${i + 1}`)
    const key = `${change.client}\n${change.seq}`
    check(!submits.has(key), `submit ${change.seq} of ${change.client} was appended twice`)
    submits.add(key)
  })

  for (const client of clients) {
    const status = client.session!.status()
    check(
      status.phase === 'live',
      `${client.principal.userId} ended ${status.phase} (${status.failure ?? 'no failure'})`,
    )
    check(
      status.unconfirmed === 0,
      `${client.principal.userId} still has ${status.unconfirmed} unconfirmed ops`,
    )
    check(
      status.version === epoch.head,
      `${client.principal.userId} is at ${status.version}, the log at ${epoch.head}`,
    )
  }

  const base = await net.store.readBase(DOCUMENT, epoch.id)
  const reference = await replay(options.adapterFactory, base, log, [
    epoch.head,
    ...saves.map((s) => s.version),
  ])
  const final = reference.get(epoch.head)
  for (const client of clients) {
    const fp = await client.editor!.fingerprint()
    check(
      fp === final,
      `${client.principal.userId} shows ${fp} where version ${epoch.head} is ${final}`,
    )
  }

  const probe = options.adapterFactory(base)
  const inLog = new Map<string, number>()
  for (const change of log)
    for (const op of change.ops) {
      const key = probe.opKey(op)
      inLog.set(key, (inLog.get(key) ?? 0) + 1)
    }
  let emitted = 0
  for (const client of clients)
    for (const id of client.emitted) {
      emitted += 1
      check(inLog.get(id) === 1, `op ${id} is in the log ${inLog.get(id) ?? 0} times`)
    }
  check(
    inLog.size === emitted,
    `the log holds ${inLog.size} distinct ops, the editors emitted ${emitted}`,
  )

  for (const saved of saves) {
    const fp = await options.adapterFactory(saved.bytes).fingerprint()
    check(
      fp === reference.get(saved.version),
      `the file saved at version ${saved.version} does not reopen as that version`,
    )
  }

  await addClient(options.file.bytes)
  await quiet()
  const late = clients[clients.length - 1]
  check(late.session?.status().version === epoch.head, 'the late joiner did not reach the head')
  const lateFp = await late.editor!.fingerprint()
  check(lateFp === final, `the late joiner shows ${lateFp} where version ${epoch.head} is ${final}`)

  return {
    seed: options.seed,
    head: epoch.head,
    ops: emitted,
    breaks: net.stats.breaks,
    lateFrames: net.stats.lateFrames,
    stale,
    saves: saves.length,
    saveTimeouts,
    exports,
    joiners,
  }
}

/** Fingerprints at each of `versions`, from the base and the log alone */
async function replay<Op>(
  factory: (bytes: Uint8Array) => SimulatedEditor<Op>,
  base: Uint8Array,
  log: Change[],
  versions: number[],
): Promise<Map<number, string>> {
  const editor = factory(base)
  const fingerprints = new Map<number, string>()
  let at = 0
  for (const version of [...new Set(versions)].sort((a, b) => a - b)) {
    for (; at < version; at++)
      editor.integrate(
        log[at].ops.map((op) => editor.decode(op)),
        [],
      )
    fingerprints.set(version, await editor.fingerprint())
  }
  return fingerprints
}
