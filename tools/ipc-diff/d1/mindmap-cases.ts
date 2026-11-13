/** What the mind map groups share: the folder every case starts from and how a call is written. */
import type { Call, Case, FileSpec, View } from '../types.ts'

export const MAP = 'XMIND-map'
export const CHANGED = 'XMIND-changed'
export const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]
export const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>'

export const FILES: Record<string, FileSpec> = {
  'a.xmind': MAP,
  'b.xmind': MAP,
  'bad.xmind': 'junk',
  'old.xmind': 'OLD-format',
  'enc.xmind': 'ENC-protected',
  'empty.xmind': '',
  'dir.xmind': { dir: true },
  'm.mm': '<map version="1.0"/>',
  'Upper.MM': '<map/>',
  'dir.mm': { dir: true },
  'n.txt': '0123456789',
  'x.zip': 'zz',
  'pic.png': 'png-bytes',
  'notes.md': '# notes',
}

/** the mind map's webview `n` */
export const view = (n = 1): View => ({ view: n, window: n, surface: 'Mindmap' })

/** bytes in a call's arguments, a marker `call` turns into the wire form */
export class Bin {
  constructor(readonly data: Uint8Array) {}
}
export const bin = (text: string | number[]): Bin =>
  new Bin(typeof text === 'string' ? Buffer.from(text) : Uint8Array.from(text))
export const UNDEFINED = Symbol('undefined')

/** `call(channel, args, options)`: arguments in the wire form of crates/shell/bridge/wire.ts */
export function call(
  channel: string,
  args: unknown[] = [],
  options: { view?: number; kind?: Call['kind'] } = {},
): Call {
  const buffers: string[] = []
  const wire = (value: unknown): unknown => {
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

export const send = (channel: string, args: unknown[] = [], view?: number): Call =>
  call(channel, args, { kind: 'send', view })

/** `hosts.d1.mindmap` and the shared hosts of a case */
export interface Host {
  d1?: Record<string, unknown>
  saves?: (string | null)[]
  opens?: (string[] | null)[]
  messages?: number[]
  osShell?: Record<string, unknown>
}

export function mindmapCase(
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
      d1: { mindmap: host.d1 ?? {} },
    },
    calls,
  }
}

/** views opened on files of the case folder: view 1 on the first name, and so on */
export const opened = (...names: (string | { name: string; decision?: string })[]) => ({
  open: names.map((n, i) => {
    const entry = typeof n === 'string' ? { name: n } : n
    return {
      view: i + 1,
      path: `$DIR/${entry.name}`,
      ...(entry.decision ? { decision: entry.decision } : {}),
    }
  }),
})

/** `save`'s request */
export const save = (bytes: unknown, mode?: string, extra: Record<string, unknown> = {}) =>
  call('mindmap:save', [{ bytes, ...(mode ? { mode } : {}), ...extra }])
export const dirty = (flag: unknown, view?: number) => send('mindmap:dirty-changed', [flag], view)
export const OPEN_A = call('mindmap:open-file', ['$DIR/a.xmind'])
