/** What the diagram groups share: the folder every case starts from and how a call is written. */
import type { Call, Case, FileSpec, View } from '../types.ts'

export const DIAGRAM = '<mxfile><diagram id="1" name="Page-1"></diagram></mxfile>'
export const CHANGED = '<mxfile><diagram id="1" name="Changed"></diagram></mxfile>'
/** the first save token of a case: tokens count up from here on both sides */
export const TOKEN = '00000000000000000000000000000001'
export const TOKEN2 = '00000000000000000000000000000002'

export const FILES: Record<string, FileSpec> = {
  'a.drawio': DIAGRAM,
  'b.drawio': DIAGRAM,
  'bad.drawio': 'not a diagram',
  'c.txt': 'plain text',
  'v.vsdx': 'VSDX',
  'dir.drawio': { dir: true },
}

/** the diagram's webview `n` */
export const view = (n = 1): View => ({ view: n, window: n, surface: 'Diagram' })

/** bytes in a call's arguments, a marker `call` turns into the wire form */
export class Bin {
  constructor(readonly data: Uint8Array) {}
}
export const bin = (data: string | number[] | Uint8Array): Bin =>
  new Bin(typeof data === 'string' ? Buffer.from(data) : Uint8Array.from(data))
export const UNDEFINED = Symbol('undefined')

type Arg = unknown

/** `call(channel, args, view?)`: arguments in the wire form of crates/shell/bridge/wire.ts */
export function call(
  channel: string,
  args: Arg[] = [],
  options: { view?: number; kind?: Call['kind'] } = {},
): Call {
  const buffers: string[] = []
  const wire = (value: Arg): unknown => {
    if (value === UNDEFINED) return { $: 'u' }
    if (value instanceof Bin) {
      buffers.push(Buffer.from(value.data).toString('hex'))
      return { $: 'b', k: 'u8', i: buffers.length - 1 }
    }
    if (Array.isArray(value)) return value.map(wire)
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wire(v)]))
    return value
  }
  return {
    channel,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.view ? { view: options.view } : {}),
    args: args.map(wire),
    ...(buffers.length > 0 ? { buffers } : {}),
  }
}

export const send = (channel: string, args: Arg[] = [], view?: number): Call =>
  call(channel, args, { kind: 'send', view })

/** `hosts.d1.diagram` and the shared dialogs of a case */
export interface Host {
  d1?: Record<string, unknown>
  saves?: (string | null)[]
  opens?: (string[] | null)[]
  messages?: number[]
  osShell?: Record<string, unknown>
}

export function diagramCase(
  note: string,
  host: Host,
  calls: Call[],
  options: { files?: Record<string, FileSpec>; views?: View[] } = {},
): Case {
  const shared: Record<string, unknown> = {}
  if (host.saves || host.opens || host.messages) {
    shared.dialogs = {
      ...(host.saves ? { save: host.saves } : {}),
      ...(host.opens ? { open: host.opens } : {}),
      ...(host.messages ? { message: host.messages.map((response) => ({ response })) } : {}),
    }
  }
  if (host.osShell) shared.osShell = host.osShell
  return {
    note,
    views: options.views ?? [view(1)],
    files: options.files ?? FILES,
    hosts: {
      ...(Object.keys(shared).length > 0 ? { shared } : {}),
      d1: { diagram: host.d1 ?? {} },
    },
    calls,
  }
}

/** a view opened on a file of the case folder */
export const opened = (...names: (string | { name: string; decision?: string })[]) => ({
  open: names.map((n, i) => {
    const entry = typeof n === 'string' ? { name: n } : n
    return { view: i + 1, path: `$DIR/${entry.name}`, ...(entry.decision ? { decision: entry.decision } : {}) }
  }),
})
