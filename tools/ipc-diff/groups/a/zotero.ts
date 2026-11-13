/**
 * Group `a/zotero`: Zotero's word-processor integration
 * (`apps/docs/src/main/zotero-ipc.ts`), `registerZoteroIpc()` as
 * `docs-main.ts` calls it.
 *
 * The module connects to Zotero's integration port (127.0.0.1:23116, a
 * constant of `zotero-wire.ts`), so each case plays Zotero on that port:
 * `hosts.a.zotero.server` is a list of connections the case's Zotero accepts
 * one after the other, each a list of steps (crates/shell-ipc/a/src/probe/zotero.rs
 * plays the same script from the Rust side, with the same words):
 *
 * - `['recv']`: reads one frame and logs `['zotero.receive', transactionId, payload]`
 * - `['send', transactionId, payload]`: writes one frame
 * - `['sendHex', hex]`: writes the bytes as they are
 * - `['wait']`: waits for the client to close the connection and logs `['zotero.wait', closed]` (false: the wait ran out)
 *
 * When the steps are over the connection is ended and waited for. After the
 * last connection is accepted nothing listens any more. A case without
 * `server` leaves the port closed (what Zotero not running looks like).
 *
 * The question ids of `zotero:request` are `randomUUID()`: the group numbers
 * them (`00000000-0000-4000-8000-000000000001`, ...) as the Rust probe does,
 * so a case can answer a question by its id.
 *
 * A `zotero:command` stays open while Zotero asks questions (a case defers
 * it and answers the questions with `zotero:response` calls), and the events
 * of a call are the ones that arrived before the harness went on to the next
 * call. So that a question reaches the call it belongs to on both sides, the
 * harness's settling (`settle` of main.ts: a few `setImmediate`s) lasts, while
 * a command is open, until the connection has been quiet for `SETTLE`
 * (a connect, a frame either way, a `zotero:response` moves the quiet on);
 * ipc-probe waits the same after each call (probe/zotero.rs, `Hold`).
 *
 * Not covered, as it would end the process: an answer `{ok: true}` without a
 * `result` (`zotero-wire.ts` throws from the frame encoder in a promise
 * nobody awaits).
 */
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { createServer, type Server, type Socket } from 'node:net'
import {
  encodeZoteroFrame,
  ZOTERO_INTEGRATION_HOST,
  ZOTERO_INTEGRATION_PORT,
} from '../../../../apps/docs/src/main/zotero-wire.ts'
import type { Call, Case, Group, View } from '../../types.ts'

const MODULE = 'apps/docs/src/main/zotero-ipc.ts'
type ZoteroIpc = typeof import('../../../../apps/docs/src/main/zotero-ipc.ts')

type Step = ['recv'] | ['send', number, string] | ['sendHex', string] | ['wait']

/** how long a step may wait for the client; the Rust side waits the same */
const STEP_TIMEOUT = 10_000
/** how long a closed connection is waited on for the client to follow */
const CLOSE_TIMEOUT = 5_000
/** a server nobody connected to for this long closes (the Rust side too), so one stuck case does not hold the port for the rest */
const IDLE_TIMEOUT = 8_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** how long the connection must be quiet before a call may end while a command is open */
const SETTLE = 150
/** the longest one settling lasts */
const SETTLE_LIMIT = 20_000

/** commands open, and the time the connection is quiet from */
const open = { commands: 0, until: 0 }
const stir = (): void => {
  open.until = Date.now() + SETTLE
}

/** One connection of the case's Zotero: frames read off it, waits that end when it closes */
class Peer {
  private buffered: Buffer = Buffer.alloc(0)
  private closed = false
  private wake: (() => void) | null = null

  constructor(readonly socket: Socket) {
    socket.on('data', (chunk) => {
      this.buffered = Buffer.concat([this.buffered, chunk])
      stir()
      this.wake?.()
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      this.closed = true
      this.wake?.()
    })
  }

  private async until(ready: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (!ready()) {
      if (this.closed || Date.now() >= deadline) return false
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()))
        this.wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    return true
  }

  async frame(): Promise<{ id: number; payload: string } | null> {
    if (!(await this.until(() => this.buffered.length >= 8, STEP_TIMEOUT))) return null
    const id = this.buffered.readUInt32BE(0)
    const length = this.buffered.readUInt32BE(4)
    if (!(await this.until(() => this.buffered.length >= 8 + length, STEP_TIMEOUT))) return null
    const payload = this.buffered.subarray(8, 8 + length).toString('utf8')
    this.buffered = this.buffered.subarray(8 + length)
    return { id, payload }
  }

  /** false when the wait ran out before the client closed */
  async untilClosed(ms: number): Promise<boolean> {
    await this.until(() => false, ms)
    return this.closed
  }
}

async function serve(socket: Socket, steps: Step[], log: unknown[]): Promise<void> {
  const peer = new Peer(socket)
  for (const step of steps) {
    if (step[0] === 'recv') {
      const frame = await peer.frame()
      if (!frame) return void socket.destroy()
      log.push(['zotero.receive', frame.id, frame.payload])
    } else if (step[0] === 'send') {
      socket.write(encodeZoteroFrame(step[1], step[2]))
      stir()
    } else if (step[0] === 'sendHex') {
      socket.write(Buffer.from(step[1], 'hex'))
      stir()
    } else {
      log.push(['zotero.wait', await peer.untilClosed(CLOSE_TIMEOUT)])
      return void socket.destroy()
    }
  }
  socket.end()
  await peer.untilClosed(CLOSE_TIMEOUT)
  socket.destroy()
}

/** the case's Zotero, listening until its last connection is accepted */
let current: { server: Server; sockets: Set<Socket>; idle: NodeJS.Timeout } | undefined

function stopServer(): void {
  if (!current) return
  clearTimeout(current.idle)
  for (const socket of current.sockets) socket.destroy()
  current.server.close()
  current = undefined
}

async function startServer(connections: Step[][], log: unknown[]): Promise<void> {
  const until = Date.now() + 12_000
  for (;;) {
    const sockets = new Set<Socket>()
    let served = 0
    const server: Server = createServer((socket) => {
      sockets.add(socket)
      stir()
      socket.once('close', () => sockets.delete(socket))
      const steps = connections[served++]
      // nothing listens after the last connection: the port refuses
      if (served === connections.length) closeListener()
      void serve(socket, steps, log).catch(() => socket.destroy())
    })
    const closeListener = (): void => {
      clearTimeout(idle)
      server.close()
    }
    const idle = setTimeout(closeListener, IDLE_TIMEOUT)
    idle.unref()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen({ host: ZOTERO_INTEGRATION_HOST, port: ZOTERO_INTEGRATION_PORT }, () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      clearTimeout(idle)
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || Date.now() >= until) throw error
      await sleep(50)
      continue
    }
    server.unref()
    current = { server, sockets, idle }
    if (connections.length === 0) closeListener()
    return
  }
}

/** `randomUUID()` as the Rust probe numbers it: one count for the case */
function numberRequestIds(): void {
  let next = 0
  const crypto = createRequire(import.meta.url)('node:crypto') as Record<string, unknown>
  Object.defineProperty(crypto, 'randomUUID', {
    value: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
    writable: true,
    configurable: true,
    enumerable: true,
  })
  syncBuiltinESMExports()
}

let timersLetGo = false
/**
 * A question the renderer never answers keeps a 10-minute timer; the group
 * ends cases without answering some, so those timers must not hold the
 * process open.
 */
function letQuestionTimersGo(): void {
  if (timersLetGo) return
  timersLetGo = true
  const real = globalThis.setTimeout
  globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
    const timer = (real as (...args: unknown[]) => NodeJS.Timeout)(handler, ms, ...rest)
    if (ms === 600_000) timer.unref()
    return timer
  }) as unknown as typeof setTimeout
}

let settlingHeld = false
/**
 * Makes the harness's `settle` (only that one: it is the `setImmediate`
 * whose stack holds a function of that name) last, while a command is open,
 * until the connection has been quiet for `SETTLE`.
 */
function holdSettlingWhileCommandsOpen(): void {
  if (settlingHeld) return
  settlingHeld = true
  const real = globalThis.setImmediate
  globalThis.setImmediate = ((handler: (...args: unknown[]) => void, ...args: unknown[]) => {
    if (!/\bsettle\b/.test(new Error().stack ?? '')) return real(handler, ...args)
    const limit = Date.now() + SETTLE_LIMIT
    const check = (): void => {
      if (open.commands > 0 && Date.now() < open.until && Date.now() < limit) {
        setTimeout(check, 5)
      } else handler(...args)
    }
    return real(check)
  }) as unknown as typeof setImmediate
}

const docs: View = { view: 1, window: 1, surface: 'Docs' }
const second: View = { view: 2, window: 2, surface: 'Docs' }

const command = (name: unknown): Call => ({ channel: 'zotero:command', args: [name] })
const respond = (response: unknown, view?: number): Call => ({
  channel: 'zotero:response',
  kind: 'send',
  args: [response],
  ...(view === undefined ? {} : { view }),
})
/** the id of the nth question of the case */
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const zotero = (...connections: Step[][]): Record<string, unknown> => ({
  a: { zotero: { server: connections } },
})
const hex = (transactionId: number, payload: string): string =>
  encodeZoteroFrame(transactionId, payload).toString('hex')
/** a frame's header alone */
const header = (transactionId: number, length: number): string =>
  transactionId.toString(16).padStart(8, '0') + length.toString(16).padStart(8, '0')
const question = (transactionId: number, name: string, ...args: unknown[]): Step => [
  'send',
  transactionId,
  JSON.stringify([name, args]),
]

/** a malformed request, sent and its ERR frame read back */
const malformed = (payloads: string[]): Step[] =>
  payloads.flatMap((payload, i): Step[] => [['send', i + 1, payload], ['recv']])

const commands = ['addEditCitation', 'addEditBibliography', 'refresh', 'setDocPrefs', 'removeCodes']

/** a command left open: its answer is taken by `done` */
const defer = (name: unknown): Call => ({ ...command(name), defer: true })
/** the answer of the deferred call at `at` */
const done = (at: number): Call => ({ channel: 'zotero:command', args: [], await: at })
/** Zotero asks `count` questions, one frame each, then reads the `count` answers */
const asking = (count: number, name = 'Field_getText'): Step[] => [
  ['recv'],
  ...Array.from({ length: count }, (_, i): Step => question(i + 1, name, i + 1)),
  ...Array.from({ length: count }, (): Step => ['recv']),
]
/** the renderer's answer to the nth question */
const answer = (n: number, rest: Record<string, unknown>, view?: number): Call =>
  respond({ requestId: id(n), ...rest }, view)

const cases: Case[] = [
  {
    note: 'Zotero is not running: the port refuses, and a refused run lets the next one start',
    views: [docs],
    calls: [command('refresh'), command('addEditCitation')],
  },
  {
    note: 'every command opens its connection with its own name',
    views: [docs],
    hosts: zotero(...commands.map((): Step[] => [['recv']])),
    calls: commands.map(command),
  },
  {
    note: 'what is not one of the five commands is refused without connecting',
    views: [docs],
    calls: [
      command('formatBibliography'),
      command(''),
      command('Refresh'),
      command('refresh\n'),
      command(' refresh'),
      command('xrefresh'),
      command('refresh,addEditCitation'),
      command(42),
      command(null),
      command(true),
      command({ command: 'refresh' }),
      command({ $: 'u' }),
      command([]),
      command([null]),
      command(['refresh', 'refresh']),
      command([['refresh', 'refresh']]),
      { channel: 'zotero:command', args: [] },
    ],
  },
  {
    note: 'an array that stringifies to a command passes the pattern and goes out as sent',
    views: [docs],
    hosts: zotero([['recv']], [['recv']], [['recv']]),
    calls: [command(['refresh']), command([[['setDocPrefs']]]), command([['removeCodes']])],
  },
  {
    note: 'a frame with transaction id 0 is ignored, even one that would not parse',
    views: [docs],
    hosts: zotero([['recv'], question(0, 'Application_getActiveDocument', 1), ['send', 0, 'nope']]),
    calls: [command('refresh')],
  },
  {
    note: 'a request that does not parse is answered with the ERR frame of what JSON.parse said',
    views: [docs],
    hosts: zotero([
      ['recv'],
      ...malformed([
        'nope',
        '',
        '{',
        '[1,',
        '{"a":1}x',
        '"s"',
        'null',
        '[]',
        '["only"]',
        '[1,[]]',
        '["x",5]',
        '{"a":1}',
        'é',
        `x${'y'.repeat(30)}`,
        `[1,1,1,1,1,1,1,x,1,1,1,1,1,1,1]`,
        '[1,1,1,1,1,1,1,1,1,1,1,1,x]',
      ]),
    ]),
    calls: [command('refresh')],
  },
  {
    note: 'frames cut into pieces, and several in one chunk, decode the same',
    views: [docs],
    hosts: zotero([
      ['recv'],
      ['sendHex', hex(1, 'nope').slice(0, 6)],
      ['sendHex', hex(1, 'nope').slice(6, 20)],
      ['sendHex', hex(1, 'nope').slice(20)],
      ['recv'],
      ['sendHex', hex(2, '[]') + hex(3, '{') + hex(4, '"é"')],
      ['recv'],
      ['recv'],
      ['recv'],
    ]),
    calls: [command('refresh')],
  },
  {
    note: 'a payload over the limit destroys the connection: the run fails with that',
    views: [docs],
    hosts: zotero([['recv'], ['sendHex', header(1, 0x01000001)], ['wait']]),
    calls: [command('refresh')],
  },
  {
    note: 'a frame at the limit waits for its body; one cut short ends the run quietly',
    views: [docs],
    hosts: zotero(
      [['recv'], ['sendHex', header(1, 0x01000000)]],
      [['recv'], ['sendHex', header(2, 16) + 'aa']],
    ),
    calls: [command('refresh'), command('refresh')],
  },
  {
    note: 'questions go to the renderer as zotero:request, in order, under numbered ids; the run ends when Zotero closes',
    views: [docs],
    hosts: zotero([
      ['recv'],
      question(1, 'Field_getText', 1, 'é😀', 2.5, null, true, { a: [1, 'b'] }, []),
      ['send', 2, '["Document_complete",[1]]'],
      ['send', 3, 'not a request'],
      ['recv'],
      question(4, 'Document_getString'),
      ['send', 5, JSON.stringify(['Document_setText', [{ nested: { deeper: ['x'] } }], 'extra'])],
    ]),
    calls: [command('addEditCitation')],
  },
  {
    note: 'each view runs and is asked on its own; a view on the shell surface is not served',
    views: [docs, second, { view: 3, window: 3, surface: 'Shell' }],
    hosts: zotero(
      [['recv'], question(1, 'Document_getString', 1)],
      [['recv'], question(2, 'Document_getString', 2)],
      [['recv'], question(3, 'Document_getString', 3)],
    ),
    calls: [
      command('refresh'),
      { ...command('refresh'), view: 2 },
      command('refresh'),
      { ...command('refresh'), view: 3 },
    ],
  },
  {
    note: 'a run that failed, then one that went well, then Zotero gone: each run is free to start',
    views: [docs],
    hosts: zotero([['recv']], [['recv'], ['sendHex', header(1, 0x01000001)], ['wait']]),
    calls: [command('removeCodes'), command('refresh'), command('setDocPrefs')],
  },
  {
    note: 'a response after the run is over answers nothing, whoever sends it and whatever it says',
    views: [docs, second],
    hosts: zotero([['recv'], question(1, 'Field_getText', 1), question(2, 'Field_getText', 2)]),
    calls: [
      command('refresh'),
      respond({ requestId: id(1), ok: true, result: 'text' }),
      respond({ requestId: id(2), ok: false, error: 'no' }, 2),
      respond({ requestId: id(2), ok: false }),
      respond({ requestId: id(3), ok: true }),
    ],
  },
  {
    note: 'a response that is not one is dropped',
    views: [docs],
    calls: [
      respond({ $: 'u' }),
      respond(null),
      respond('requestId'),
      respond(5),
      respond({}),
      respond({ requestId: 5, ok: true }),
      respond({ requestId: null }),
      respond({ requestId: 'unknown', ok: true, result: 1 }),
      respond({ requestId: id(1), ok: false, error: 'x' }),
      { channel: 'zotero:response', kind: 'send', args: [] },
    ],
  },
  {
    note: 'the renderer answers a question: its result goes back to Zotero on the transaction of the question',
    views: [docs],
    hosts: zotero(asking(1)),
    calls: [defer('refresh'), answer(1, { ok: true, result: 'text' }), done(0)],
  },
  {
    note: 'results of every shape are written as JSON.stringify writes them',
    views: [docs],
    hosts: zotero(asking(8)),
    calls: [
      defer('addEditCitation'),
      answer(1, { ok: true, result: { a: [1, 'é', null, { $: 'u' }], b: {}, c: { $: 'u' } } }),
      answer(2, { ok: true, result: null }),
      answer(3, { ok: true, result: 0 }),
      answer(4, { ok: true, result: false }),
      answer(5, { ok: true, result: [] }),
      answer(6, { ok: true, result: 1e21 }),
      answer(7, { ok: true, result: 'multi\nline "quoted" é😀' }),
      answer(8, { ok: 1, result: [{ $: 'u' }, 2.5] }),
      done(0),
    ],
  },
  {
    note: 'a failed answer becomes ERR: and the message of the error, worded as new Error words it',
    views: [docs],
    hosts: zotero(asking(10)),
    calls: [
      defer('refresh'),
      answer(1, { ok: false, error: 'boom' }),
      answer(2, { ok: false }),
      answer(3, { ok: false, error: '' }),
      answer(4, { ok: 0, error: 'zero' }),
      answer(5, { ok: false, error: ['a', 1, null, ['b']] }),
      answer(6, { ok: null, error: { message: 'm' } }),
      answer(7, { ok: false, error: 5 }),
      answer(8, { ok: false, error: true }),
      answer(9, { error: 'no ok at all' }),
      answer(10, { ok: 'yes', error: 'unused', result: 's' }),
      done(0),
    ],
  },
  {
    note: 'answers need not come in the order of the questions',
    views: [docs],
    hosts: zotero([
      ['recv'],
      question(10, 'Field_getText', 1),
      question(20, 'Field_getText', 2),
      question(30, 'Field_getText', 3),
      ['recv'],
      ['recv'],
      ['recv'],
    ]),
    calls: [
      defer('setDocPrefs'),
      answer(3, { ok: true, result: 'c' }),
      answer(1, { ok: true, result: 'a' }),
      answer(2, { ok: false, error: 'b' }),
      done(0),
    ],
  },
  {
    note: 'the answer to Document_complete ends the connection, a failed one as well',
    views: [docs],
    hosts: zotero(
      [['recv'], question(1, 'Document_complete', 1), ['recv'], ['wait']],
      [['recv'], question(1, 'Document_complete', 2), ['recv'], ['wait']],
    ),
    calls: [
      defer('refresh'),
      answer(1, { ok: true, result: null }),
      done(0),
      defer('refresh'),
      answer(2, { ok: false, error: 'declined' }),
      done(3),
    ],
  },
  {
    note: 'an answer from another view, or one that names nothing, leaves the question open',
    views: [docs, second],
    hosts: zotero(asking(1)),
    calls: [
      defer('refresh'),
      respond(5),
      respond(null),
      respond({ requestId: 7, ok: true }),
      answer(2, { ok: true, result: 'nobody asked' }),
      answer(1, { ok: true, result: 'from the other view' }, 2),
      answer(1, { ok: true, result: 'right' }),
      done(0),
    ],
  },
  {
    note: 'a second command from a view whose command is open is refused; the first goes on',
    views: [docs],
    hosts: zotero(asking(1)),
    calls: [
      defer('refresh'),
      command('setDocPrefs'),
      answer(1, { ok: true, result: 1 }),
      done(0),
      command('setDocPrefs'),
    ],
  },
  {
    note: 'Zotero closes the connection with a question open: the run ends well, and a late answer is dropped',
    views: [docs],
    hosts: zotero([['recv'], question(1, 'Field_getText', 1)]),
    calls: [defer('refresh'), answer(1, { ok: true, result: 'late' }), done(0)],
  },
  {
    note: 'an answer written to a connection Zotero closed does not matter either',
    views: [docs],
    hosts: zotero([['recv'], question(1, 'Document_complete', 1)]),
    calls: [defer('removeCodes'), answer(1, { ok: true, result: null }), done(0)],
  },
]

export const group: Group = {
  batch: 'A',
  async load(cx) {
    stopServer()
    numberRequestIds()
    letQuestionTimersGo()
    holdSettlingWhileCommandsOpen()
    open.commands = 0
    const given = ((cx.case.hosts?.a ?? {}) as { zotero?: { server?: Step[][] } }).zotero
    if (given?.server) await startServer(given.server, cx.electron.log)
    const mod = await cx.fresh<ZoteroIpc>(MODULE)
    mod.registerZoteroIpc()
    // a command is open from its call to its answer, which the settling of the harness waits on
    const { invoke, on } = cx.electron.handlers
    const run = invoke.get('zotero:command')
    if (!run) throw new Error('zotero:command was not registered')
    invoke.set('zotero:command', async (...args) => {
      open.commands++
      stir()
      try {
        return await run(...args)
      } finally {
        open.commands--
      }
    })
    on.set(
      'zotero:response',
      (on.get('zotero:response') ?? []).map((listener) => (...args: unknown[]) => {
        stir()
        return listener(...args)
      }),
    )
  },
  cases,
  single: {
    'zotero:response':
      'a send has no answer: what it does shows in the frames Zotero receives (the host log), in the answer of the deferred command and in the questions that follow',
  },
}
