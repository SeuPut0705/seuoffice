/** What the slides groups share: the folder every case starts from and how a call is written. */
import type { Call, Case, FileSpec, View } from '../types.ts'

/** a deck in the fake engine's file form (slides-engine.ts `toBytes`) */
export const deck = (...slides: string[]): string =>
  `FAKEPPTX 9144000 5143500 5\n${slides.map((s, i) => `ppt/slides/slide${i + 1}.xml 0 ${s}`).join('\n')}\n`

export const DECK = deck('e1=Hello|e2=World', 'e3=Second')

export const FILES: Record<string, FileSpec> = {
  'userData/app-settings.json': '{"authorName":"Ann"}',
  'a.pptx': DECK,
  'b.pptx': deck('e1=B one'),
  'bad.pptx': 'junk',
  'empty.pptx': '',
  'dir.pptx': { dir: true },
}

/** the slides webview `n` */
export const view = (n = 1): View => ({ view: n, window: n, surface: 'Slides' })

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

/** `hosts` of a case: the fake hosts of the slides batch and the shared ones */
export interface Host {
  slides?: Record<string, unknown>
  saves?: (string | null)[]
  opens?: (string[] | null)[]
  messages?: { response: number; checkboxChecked?: boolean }[]
  shared?: Record<string, unknown>
}

export function slidesCase(
  note: string,
  host: Host,
  calls: Call[],
  options: { files?: Record<string, FileSpec>; views?: View[] } = {},
): Case {
  const shared: Record<string, unknown> = { ...host.shared }
  const dialogs: Record<string, unknown> = {}
  if (host.saves) dialogs.save = host.saves
  if (host.opens) dialogs.open = host.opens
  if (host.messages) dialogs.message = host.messages
  if (Object.keys(dialogs).length > 0) shared.dialogs = dialogs
  return {
    note,
    views: options.views ?? [view(1)],
    files: { ...FILES, ...options.files },
    hosts: {
      ...(Object.keys(shared).length > 0 ? { shared } : {}),
      ...(host.slides ? { d1: { slides: host.slides } } : {}),
    },
    calls,
  }
}

/** the calls that put a deck of the case into view 1 */
export const NEW = call('slides:new-blank', [1280])
export const OPEN_A = call('slides:open-path', ['$DIR/a.pptx', 1280])
