/**
 * Group `b4-docs`: the modules of apps/docs/src/main, apps/diagram/src/main
 * and apps/mindmap/src/main that hold no Electron object.
 *
 * Names are `<ts-file>.<export>`; a file whose name more than one app has is
 * `<app>/<ts-file>` (`docs/atomic-write`, `docs/save-as-formats`,
 * `diagram/print-document`, `mindmap/atomic-write`, `mindmap/save-as-formats`).
 *
 * An argument the TypeScript takes as `unknown` is written as JSON: a
 * top-level `null` is `undefined`, and `{ "$val": "null" | "NaN" | "Infinity" |
 * "-Infinity" | "-0" }` is that value (JSON cannot carry it), see `js()`.
 * Bytes are hex strings. What the TypeScript takes as an object with methods
 * or a callback is a fake that the case describes; each of its calls is a log
 * line, and the Rust side writes the same lines.
 *
 * Module state (the byte handoffs, the print documents, the chunk coalescer,
 * the Zotero client) is driven as a scenario `{ ops: [...] }`. The timers of
 * the TypeScript are fakes the `advance` op moves; `crypto.randomUUID` and
 * `crypto.randomBytes` answer `uuid-1`, `uuid-2`, ... and `0101...`, `0202...`;
 * `net.createConnection` answers a fake socket. A scenario puts the module
 * state back (every timer fires, every document is dropped) before it ends.
 */
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import { atomicWriteFile, looksLikeZip } from '../../../apps/docs/src/main/atomic-write.ts'
import {
  handOffBytes,
  pendingHandoffCount,
  takeHandoff,
} from '../../../apps/docs/src/main/byte-handoff.ts'
import {
  MAX_COPY_IMAGE_DATA_URL,
  copyImageDisplaySize,
  validCopyImageDataUrl,
} from '../../../apps/docs/src/main/copy-image-guard.ts'
import {
  docFormatOfPath,
  isOdtPackage,
  prepareRecoveryBytes,
  prepareSaveBytes,
  recoveryExtFor,
  withDocExtension,
  zipEntryNames,
} from '../../../apps/docs/src/main/doc-format.ts'
import { isExternallyModified } from '../../../apps/docs/src/main/external-change.ts'
import {
  HwpExportFailure,
  convertInWorker,
  exportHwp,
  hwpLossMessageBox,
} from '../../../apps/docs/src/main/hwp-export.ts'
import { HWP_EXPORT_STRINGS } from '../../../apps/docs/src/main/hwp-export-strings.ts'
import { inlineLazyMediaInHtml } from '../../../apps/docs/src/main/lazy-media-inline.ts'
import { mergeOutputFileName, mergeOutputPath } from '../../../apps/docs/src/main/merge-output.ts'
import {
  printJobOptions,
  printPaperOption,
  printScaleOption,
  validPrintDim,
  validPrintGeometry,
  validPrintPaper,
  validPrintScale,
} from '../../../apps/docs/src/main/print-args.ts'
import {
  normalizeReadUrlRequest,
  unexpectedReadUrlFailure,
} from '../../../apps/docs/src/main/read-url-ipc.ts'
import {
  hwpExportFilters,
  hwpExportTarget,
  saveAsDefaultPath,
  saveAsFilters,
  saveAsTarget,
} from '../../../apps/docs/src/main/save-as-formats.ts'
import {
  assignStarredGroup,
  dropStarredItems,
  parseStarredItems,
  readStarredItems,
  renameStarredItem,
  starredGroupMap,
  starredGroupNames,
  toggleStarredItem,
  writeStarredItems,
} from '../../../apps/docs/src/main/starred-files.ts'
import {
  STREAM_COALESCE_MS,
  createChunkCoalescer,
} from '../../../apps/docs/src/main/stream-coalesce.ts'
import {
  ZOTERO_INTEGRATION_HOST,
  ZOTERO_INTEGRATION_PORT,
  ZoteroFrameDecoder,
  ZoteroWireClient,
  encodeZoteroFrame,
} from '../../../apps/docs/src/main/zotero-wire.ts'
import {
  DRAWIO_SCHEME_PRIVILEGE,
  PRINT_PAGE_CSP,
  contentTypeOf,
  drawioCsp,
  injectBridge,
  resolveDrawioRequest,
  responseHeaders,
} from '../../../apps/diagram/src/main/drawio-protocol.ts'
import { pageFilePaths } from '../../../apps/diagram/src/main/export-paths.ts'
import {
  DIAGRAM_PARTITION,
  REFUSED_ADDRESSES_KEPT,
  devServerOrigins,
  isAllowedDiagramRequest,
  isAllowedNavigation,
  newRequestLog,
  screenRequest,
  windowOpenAction,
} from '../../../apps/diagram/src/main/network-guard.ts'
import {
  buildPrintHtml,
  dropPrintDocument,
  holdPrintDocument,
  inertSvg,
  isPrintCancel,
  isPrintPage,
  takePrintDocument,
} from '../../../apps/diagram/src/main/print-document.ts'
import { atomicWriteFile as mindmapAtomicWriteFile } from '../../../apps/mindmap/src/main/atomic-write.ts'
import {
  saveAsDefaultPath as mindmapSaveAsDefaultPath,
  saveAsFilters as mindmapSaveAsFilters,
  saveAsTarget as mindmapSaveAsTarget,
} from '../../../apps/mindmap/src/main/save-as-formats.ts'
import type { Case, FileSpec, FnSpec, Group } from '../types.ts'

type Any = any

const CONSTANT = 'a constant'
const str = (a: unknown[], i: number): string => a[i] as string

// ---- the values a spec writes as JSON ----

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive)
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 1 && keys[0] === '$val') {
      switch (Object.values(value)[0]) {
        case 'null':
          return null
        case 'NaN':
          return NaN
        case 'Infinity':
          return Infinity
        case '-Infinity':
          return -Infinity
        case '-0':
          return -0
      }
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]))
  }
  return value
}

/** the argument as `unknown`: a top-level `null` is `undefined` */
const js = (value: unknown): unknown => (value === null ? undefined : revive(value))

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const bytesOf = (hex: string): Buffer => Buffer.from(hex, 'hex')

const maskTmp = (text: string): string => text.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')

/** the call, with a temp file's random name in a thrown message written `<hex>` */
async function masked<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof Error) error.message = maskTmp(error.message)
    throw error
  }
}

/** `setTimeout` and `clearTimeout` as a clock the scenario moves */
function withFakeTimers<T>(
  run: (clock: { advance(ms: number): void; fireAll(): void; pending(): number }) => T,
): T {
  const holder = globalThis as unknown as Record<string, unknown>
  const real = { setTimeout: holder.setTimeout, clearTimeout: holder.clearTimeout }
  interface Timer {
    id: number
    due: number
    fn: () => void
    live: boolean
    unref(): void
  }
  const timers: Timer[] = []
  let now = 0
  let next = 0
  holder.setTimeout = (fn: () => void, ms = 0): Timer => {
    const timer: Timer = { id: next++, due: now + ms, fn, live: true, unref() {} }
    timers.push(timer)
    return timer
  }
  holder.clearTimeout = (timer: Timer | null): void => {
    if (timer) timer.live = false
  }
  const fireUpTo = (limit: number): void => {
    for (;;) {
      let pick: Timer | undefined
      for (const t of timers) {
        if (!t.live || t.due > limit) continue
        if (!pick || t.due < pick.due || (t.due === pick.due && t.id < pick.id)) pick = t
      }
      if (!pick) return
      pick.live = false
      pick.fn()
    }
  }
  try {
    return run({
      advance(ms) {
        now += ms
        fireUpTo(now)
      },
      fireAll: () => fireUpTo(Infinity),
      pending: () => timers.filter((t) => t.live).length,
    })
  } finally {
    holder.setTimeout = real.setTimeout
    holder.clearTimeout = real.clearTimeout
  }
}

/** `crypto.<name>` replaced while `run` goes */
function withCrypto<T>(patch: Record<string, unknown>, run: () => T): T {
  const holder = crypto as unknown as Record<string, unknown>
  const real = Object.fromEntries(Object.keys(patch).map((k) => [k, holder[k]]))
  Object.assign(holder, patch)
  syncBuiltinESMExports()
  try {
    return run()
  } finally {
    Object.assign(holder, real)
    syncBuiltinESMExports()
  }
}

// ---- docs/atomic-write ----

const atomicCases: Case[] = [
  { args: ['$DIR/a.docx', 'new'] },
  { args: ['$DIR/a.docx', 'new'], files: { 'a.docx': 'old' } },
  { args: ['$DIR/a.docx', ''], files: { 'a.docx': 'old' }, note: 'empty data' },
  {
    args: ['$DIR/a.docx', 'new\u{1F600}'],
    files: { 'a.docx': { text: 'old', mode: 0o444 } },
    note: 'a read-only target is replaced',
  },
  {
    args: ['$DIR/a.docx', 'new'],
    files: { 'a.docx': { dir: true } },
    note: 'a folder as target: rescue copy, then the error',
  },
  { args: ['$DIR/none/a.docx', 'new'], note: 'no folder' },
  { args: ['$DIR/f/a.docx', 'new'], files: { f: 'a file' }, note: 'a file where the folder is' },
  { args: ['$DIR/\u00fcn\u00ef\u{1F600}.docx', 'caf\u00e9'] },
]

// ---- zip archives for doc-format ----

interface ZipEntry {
  name?: string
  /** raw bytes of the name, hex (overrides `name`) */
  nameHex?: string
  extra?: number
  comment?: number
}

/** a zip's central directory and its end record (no local entries: the readers never look) */
function zipHex(
  entries: ZipEntry[],
  o: {
    junk?: number
    trailing?: string
    count?: number
    offset?: number
    badSignature?: boolean
    comment?: number
  } = {},
): string {
  const parts: Buffer[] = []
  for (const e of entries) {
    const name = e.nameHex !== undefined ? bytesOf(e.nameHex) : Buffer.from(e.name ?? '')
    const head = Buffer.alloc(46)
    head.writeUInt32LE(o.badSignature ? 0x02014b51 : 0x02014b50, 0)
    head.writeUInt16LE(name.length, 28)
    head.writeUInt16LE(e.extra ?? 0, 30)
    head.writeUInt16LE(e.comment ?? 0, 32)
    parts.push(head, name, Buffer.alloc((e.extra ?? 0) + (e.comment ?? 0), 0x78))
  }
  const directory = Buffer.concat(parts)
  const junk = o.junk ?? 0
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(o.count ?? entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(o.offset ?? junk, 16)
  end.writeUInt16LE(o.comment ?? (o.trailing ? o.trailing.length / 2 : 0), 20)
  return Buffer.concat([
    Buffer.alloc(junk, 0x41),
    directory,
    end,
    o.trailing ? bytesOf(o.trailing) : Buffer.alloc(0),
  ]).toString('hex')
}

const DOCX = zipHex([{ name: '[Content_Types].xml' }, { name: 'word/document.xml' }])
const ODT = zipHex([
  { name: 'mimetype' },
  { name: 'content.xml' },
  { name: 'META-INF/manifest.xml' },
])
const ODT_WITH_TYPES = zipHex([
  { name: 'mimetype' },
  { name: 'content.xml' },
  { name: '[Content_Types].xml' },
])
const TEXT = (s: string): string => Buffer.from(s).toString('hex')

const zipCases: string[][] = [
  [DOCX],
  [ODT],
  [ODT_WITH_TYPES],
  [zipHex([])],
  [''],
  ['504b0506'],
  [TEXT('PK\u0005\u0006'.padEnd(21, 'x'))],
  [zipHex([{ name: 'a', extra: 5, comment: 3 }, { name: 'b/\u00e9.xml' }])],
  [zipHex([{ name: 'mimetype' }, { name: 'content.xml' }], { junk: 7 })],
  [zipHex([{ name: 'mimetype' }, { name: 'content.xml' }], { trailing: TEXT('a comment') })],
  [zipHex([{ name: 'a' }], { count: 0xffff })],
  [zipHex([{ name: 'a' }], { offset: 0xffffffff })],
  [zipHex([{ name: 'a' }], { badSignature: true })],
  [zipHex([{ name: 'a' }], { count: 2 })],
  [zipHex([{ name: 'a' }], { offset: 4000 })],
  [zipHex([{ nameHex: 'ff'.repeat(3) + '61' }])],
  [zipHex([{ nameHex: 'efbbbf6162' }])],
  [zipHex([{ nameHex: 'f09f9880' + '2f78' }])],
  [zipHex([{ nameHex: 'f09f98' }])],
  [zipHex([{ name: 'a' }], { trailing: 'ab'.repeat(0xffff - 1) })],
  [zipHex([{ name: 'a' }], { trailing: 'ab'.repeat(0xffff) })],
  [zipHex([{ name: 'a' }], { comment: 0xffff, trailing: 'ab'.repeat(0xffff + 40) })],
  [zipHex([{ name: 'z' }], { trailing: TEXT('xxPK\u0005\u0006') + '00'.repeat(18) })],
]

// ---- starred.json ----

const STAR = (items: unknown): FileSpec => JSON.stringify({ version: 1, items })

// ---- hwp export ----

type Thrown = { kind: 'error' | 'failure' | 'string'; message: string; code?: string }

function throwIt(t: Thrown): never {
  if (t.kind === 'failure') throw new HwpExportFailure(t.code as never, t.message)
  if (t.kind === 'string') throw t.message
  throw new Error(t.message)
}

const LOSS = (feature: string, kind: string, count: unknown) => ({ feature, kind, count })
const ALL_FEATURES = [
  'comment',
  'revision',
  'equation',
  'chart',
  'shape',
  'textbox',
  'object',
  'ink',
  'watermark',
  'hidden_text',
  'picture',
  'table',
  'note',
  'page_border',
  'para_border',
  'line_numbers',
  'protection',
  'hyperlink',
  'section',
  'columns',
  'header_variant',
  'header_content',
  'floating_picture',
  'nested_table',
  'table_layout',
  'numbering',
  'tab_stop',
  'toc',
  'field',
  'text_effect',
  'note_format',
  'text_direction',
  'plain_paragraph',
]

/** a worker whose events the case scripts: each after `postMessage`, the first one settles */
class FakeWorker {
  private readonly listeners: Record<string, ((arg: Any) => void)[]> = {}
  constructor(
    private readonly script: Any,
    private readonly log: (...line: unknown[]) => void,
  ) {}
  on(event: string, listener: (arg: Any) => void): this {
    ;(this.listeners[event] ??= []).push(listener)
    return this
  }
  postMessage(job: { docx: Uint8Array; format: string; wasmPath: string }): void {
    this.log('postMessage', {
      docx: hexOf(job.docx),
      format: job.format,
      wasmPath: job.wasmPath,
    })
    if (this.script.postThrows) throw new Error(this.script.postThrows)
    setImmediate(() => {
      for (const ev of this.script.events as Any[]) {
        if (ev.message) {
          const m = ev.message
          const reply = m.ok
            ? { ok: true, bytes: bytesOf(m.bytesHex ?? ''), losses: js(m.losses ?? []) }
            : { ok: false, code: m.code, error: m.error }
          for (const l of this.listeners.message ?? []) l(reply)
        } else if (ev.error !== undefined) {
          for (const l of this.listeners.error ?? []) l(new Error(ev.error))
        } else {
          for (const l of this.listeners.exit ?? []) l(js(ev.exit))
        }
      }
    })
  }
  terminate(): Promise<number> {
    this.log('terminate')
    return Promise.resolve(0)
  }
}

const reply = (bytesHex: string, losses: unknown[] = []) => ({
  message: { ok: true, bytesHex, losses },
})
const refusal = (code: string, error: string) => ({ message: { ok: false, code, error } })

function convertCase(job: Any, script: Any, note?: string): Case {
  return { args: [job, script], note }
}

const JOB = { docx: '504b0304aa', format: 'hwpx', wasmPath: '/w/engine.wasm' }

function exportCase(spec: Any, note?: string): Case {
  return { args: [{ docx: '0102', passwordSet: false, ...spec }], note }
}

// ---- zotero client ----

const frameHex = (id: number, payload: string): string => {
  const body = Buffer.from(payload)
  const frame = Buffer.alloc(8 + body.length)
  frame.writeUInt32BE(id, 0)
  frame.writeUInt32BE(body.length, 4)
  body.copy(frame, 8)
  return frame.toString('hex')
}
const request = (id: number, command: string, args: unknown[] = []): string =>
  frameHex(id, JSON.stringify([command, args]))

class FakeSocket extends EventEmitter {
  destroyed = false
  constructor(
    readonly id: number,
    private readonly log: (...line: unknown[]) => void,
  ) {
    super()
  }
  write(frame: Buffer): boolean {
    this.log('write', this.id, hexOf(frame))
    return true
  }
  end(): this {
    this.log('end', this.id)
    return this
  }
  destroy(error?: Error): this {
    if (this.destroyed) return this
    this.destroyed = true
    this.log('destroy', this.id, error ? error.message : null)
    setImmediate(() => {
      if (error) this.emit('error', error)
      this.emit('close')
    })
    return this
  }
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

async function zoteroScenario(spec: Any, log: (...line: unknown[]) => void): Promise<unknown> {
  const real = net.createConnection
  const sockets: FakeSocket[] = []
  let connect: Any = 'ok'
  ;(net as unknown as { createConnection: unknown }).createConnection = (options: Any) => {
    log('connect', options.host, options.port)
    const socket = new FakeSocket(sockets.length + 1, log)
    sockets.push(socket)
    const outcome = connect
    setImmediate(() => {
      if (outcome && outcome.error !== undefined) socket.emit('error', new Error(outcome.error))
      else socket.emit('connect')
    })
    return socket
  }
  syncBuiltinESMExports()
  try {
    const client = new ZoteroWireClient(spec.host ?? undefined, spec.port ?? undefined)
    const handlers = spec.handlers ?? {}
    const handle = async (req: { command: string; args: unknown[] }): Promise<unknown> => {
      log('handle', req.command, req.args)
      if (Object.hasOwn(handlers, req.command)) {
        const entry = handlers[req.command]
        if (typeof entry.throws === 'string') throw new Error(entry.throws)
        return 'value' in entry ? revive(entry.value) : null
      }
      return `ok:${req.command}`
    }
    let runs = 0
    for (const op of spec.ops as Any[]) {
      const target = (): FakeSocket => sockets[(op.socket ?? sockets.length) - 1]
      switch (op.op) {
        case 'run': {
          const n = ++runs
          connect = op.connect ?? 'ok'
          client.run(op.command, handle).then(
            () => log('settled', n, 'ok'),
            (error: Error) => log('settled', n, error.message),
          )
          break
        }
        case 'data':
          target().emit('data', bytesOf(op.hex))
          break
        case 'error':
          target().emit('error', new Error(op.message))
          break
        case 'close':
          target().emit('close')
          break
        case 'clientClose':
          client.close()
          break
        case 'active':
          log('active', client.isActive)
          break
        default:
          throw new Error(`unknown op ${op.op}`)
      }
      await flush()
    }
    return { active: client.isActive }
  } finally {
    ;(net as unknown as { createConnection: unknown }).createConnection = real
    syncBuiltinESMExports()
  }
}

const run = (command: string, connect?: unknown): Any => ({ op: 'run', command, connect })
const data = (...frames: string[]): Any => ({ op: 'data', hex: frames.join('') })

// ---- diagram ----

const PAGE = (o: Record<string, unknown> = {}) => ({
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
  width: 300,
  height: 200,
  pageWidth: 827,
  pageHeight: 1169,
  ...o,
})

// ---- byte handoffs ----

/** `{ tokens?, ops }` through handOffBytes, takeHandoff and pendingHandoffCount */
function runHandoffs(spec: Any): unknown {
  const tokens = (spec.tokens ?? []) as string[]
  let made = 0
  return withCrypto(
    {
      randomUUID: () => {
        const n = made++
        return tokens[n] ?? `uuid-${n + 1}`
      },
    },
    () =>
      withFakeTimers((clock) => {
        const urls: string[] = []
        const out: unknown[] = []
        let now = 0
        for (const op of spec.ops as Any[]) {
          if (op.op === 'handOff') {
            const bytes =
              op.hex !== undefined
                ? { length: op.hex.length / 2, hex: op.hex }
                : { length: op.len ?? 0, hex: undefined }
            const url = handOffBytes(bytes as unknown as Buffer)
            urls.push(url)
            out.push({ op: 'handOff', url })
          } else if (op.op === 'take') {
            const got = takeHandoff(op.url ?? urls[op.ref] ?? '') as unknown as {
              length: number
              hex?: string
            } | null
            out.push(
              got === null
                ? { op: 'take', found: false }
                : {
                    op: 'take',
                    found: true,
                    len: got.length,
                    ...(got.hex !== undefined ? { hex: got.hex } : {}),
                  },
            )
          } else if (op.op === 'count') {
            out.push({ op: 'count', n: pendingHandoffCount() })
          } else if (op.op === 'advance') {
            now += op.ms ?? 0
            clock.advance(op.ms ?? 0)
            out.push({ op: 'advance', now })
          } else {
            throw new Error('unknown op')
          }
        }
        clock.fireAll()
        return out
      }),
  )
}

const MIB = 1024 * 1024
const hand = (len: number, extra: Record<string, unknown> = {}) => ({
  op: 'handOff',
  len,
  ...extra,
})
const takeRef = (ref: number) => ({ op: 'take', ref })
const takeUrl = (url: string) => ({ op: 'take', url })
const COUNT = { op: 'count' }
const advance = (ms: number) => ({ op: 'advance', ms })
const many = (n: number) => Array.from({ length: n }, (_, i) => hand(i + 1))

function handoffCases(focus: string): Case[] {
  const scenarios: Record<string, Any[][]> = {
    handOffBytes: [
      [hand(0)],
      [hand(3, { hex: '010203' }), hand(0, { hex: '' })],
      [...many(8), COUNT],
      [...many(9), COUNT, takeRef(0), takeRef(1)],
      [...many(10), COUNT, takeRef(0), takeRef(1), takeRef(2), takeRef(9)],
      [hand(600 * MIB), hand(600 * MIB), COUNT, takeRef(0), takeRef(1)],
      [hand(400 * MIB), hand(400 * MIB), hand(400 * MIB), COUNT, takeRef(0), takeRef(2)],
      [hand(3 * 1024 * MIB), COUNT, hand(1), COUNT, takeRef(0)],
      [hand(1024 * MIB), COUNT, hand(1), COUNT],
      [hand(1024 * MIB - 1), hand(1), COUNT, hand(1), COUNT],
      [hand(512 * MIB), hand(512 * MIB), COUNT, hand(1), COUNT, takeRef(0), takeRef(1)],
    ],
    takeHandoff: [
      [hand(2, { hex: 'abcd' }), takeRef(0), takeRef(0)],
      [hand(1), takeRef(0), COUNT],
      [hand(1), takeRef(1)],
      [hand(1), takeRef(-1)],
      [hand(1), takeUrl('https://example.com/handoff/uuid-1')],
      [hand(1), takeUrl('')],
      [hand(1), takeUrl('seuoffice-docx-media://handoff/')],
      [hand(1), takeUrl('seuoffice-docx-media://other/uuid-1')],
      [hand(1), takeUrl('SEUOFFICE-DOCX-MEDIA://handoff/uuid-1')],
      [hand(1), takeUrl('seuoffice-docx-media://handoff/uuid-1/')],
      [hand(1), takeUrl('seuoffice-docx-media://handoff/uuid-1')],
      [
        hand(1),
        takeUrl('seuoffice-docx-media://handoff/uuid-1'),
        takeUrl('seuoffice-docx-media://handoff/uuid-1'),
      ],
      [hand(1), hand(2), takeRef(1), takeRef(0), COUNT],
      [hand(1), advance(60000), takeRef(0)],
      [hand(1), advance(59999), takeRef(0)],
    ],
    pendingHandoffCount: [
      [COUNT],
      [hand(1), COUNT],
      [hand(1), hand(1), COUNT, takeRef(0), COUNT],
      [hand(1), advance(59999), COUNT, advance(1), COUNT],
      [
        hand(1),
        advance(30000),
        hand(2),
        advance(30000),
        COUNT,
        takeRef(1),
        COUNT,
        advance(30000),
        COUNT,
      ],
      [hand(1), takeRef(0), advance(60000), COUNT],
      [hand(1), advance(0), COUNT],
      [
        hand(1),
        hand(1),
        hand(1),
        advance(20000),
        hand(1),
        advance(40000),
        COUNT,
        advance(20000),
        COUNT,
      ],
      [...many(9), COUNT, advance(60000), COUNT],
    ],
  }
  const withTokens: Any[] = [
    {
      tokens: ['a/b', 'c d', '\u00e9\u{1F600}'],
      ops: [hand(1), hand(2), hand(3), takeRef(1), takeRef(0), takeRef(2), takeRef(2)],
    },
  ]
  return [
    ...scenarios[focus].map((ops): Case => ({ args: [{ ops }] })),
    ...(focus === 'takeHandoff' ? withTokens.map((spec): Case => ({ args: [spec] })) : []),
  ]
}

// ---- print documents ----

function runPrintDocuments(spec: Any): unknown {
  const tokens = (spec.tokens ?? []) as string[]
  let made = 0
  const held: string[] = []
  return withCrypto(
    {
      randomBytes: (size: number) => {
        const n = made++
        return tokens[n] !== undefined ? bytesOf(tokens[n]) : Buffer.alloc(size, n + 1)
      },
    },
    () => {
      try {
        return (spec.ops as Any[]).map((op) => {
          const named = (): string => op.token ?? held[op.ref] ?? ''
          if (op.op === 'hold') {
            const token = holdPrintDocument(op.html)
            held.push(token)
            return { op: 'hold', token }
          }
          if (op.op === 'take') return { op: 'take', html: takePrintDocument(named()) }
          if (op.op === 'drop') {
            dropPrintDocument(named())
            return { op: 'drop' }
          }
          throw new Error('unknown op')
        })
      } finally {
        for (const token of held) dropPrintDocument(token)
      }
    },
  )
}

function printDocumentCases(focus: string): Case[] {
  const hold = (html: string) => ({ op: 'hold', html })
  const take = (ref: number) => ({ op: 'take', ref })
  const drop = (ref: number) => ({ op: 'drop', ref })
  const scenarios: Record<string, Any[][]> = {
    holdPrintDocument: [
      [hold('<p>a</p>')],
      [hold('<p>a</p>'), hold('<p>b</p>'), hold('')],
      [hold('caf\u00e9 \u{1F600}'), take(0)],
      [hold('a'), hold('b'), hold('c'), take(2), take(0), take(1)],
    ],
    takePrintDocument: [
      [hold('<p>a</p>'), take(0), take(0)],
      [hold('<p>a</p>'), hold('<p>b</p>'), take(1), take(0), take(1)],
      [take(0)],
      [{ op: 'take', token: 'f'.repeat(32) }],
      [{ op: 'take', token: '' }],
      [hold('x'), { op: 'take', token: '01'.repeat(16) }, { op: 'take', token: '01'.repeat(16) }],
      [hold('x'), { op: 'take', token: '01'.repeat(16).toUpperCase() }],
      [hold('x'), { op: 'take', token: '01'.repeat(15) }],
      [hold('x'), drop(0), take(0)],
      [hold('\u00e9\u{1F600}'), take(0)],
    ],
    dropPrintDocument: [
      [hold('x'), drop(0), take(0)],
      [hold('x'), hold('y'), drop(0), take(0), take(1)],
      [drop(0)],
      [{ op: 'drop', token: 'nope' }, hold('x'), take(0)],
      [hold('x'), drop(0), drop(0)],
      [hold('x'), take(0), drop(0), hold('y'), take(1)],
    ],
  }
  const tokens: Any = {
    tokens: ['ab'.repeat(16), 'cd'.repeat(16), 'ab'.repeat(16)],
    ops: [hold('first'), hold('second'), take(0), take(1)],
  }
  return [
    ...scenarios[focus].map((ops): Case => ({ args: [{ ops }] })),
    ...(focus === 'holdPrintDocument' ? [{ args: [tokens] } as Case] : []),
  ]
}

export const group: Group = {
  // ================= apps/docs/src/main =================

  // ---------- atomic-write.ts ----------
  'docs/atomic-write.looksLikeZip': {
    ts: (a) => looksLikeZip(bytesOf(str(a, 0))),
    cases: [
      '504b0304',
      '504b030400',
      '504b0506',
      '504b03',
      '',
      '04034b50',
      '504b0304ffffffff',
      '504b0305',
      '514b0304',
    ].map((hex): Case => ({ args: [hex] })),
  },
  'docs/atomic-write.atomicWriteFile': {
    ts: (a) => masked(() => atomicWriteFile(str(a, 0), Buffer.from(str(a, 1)))),
    cases: atomicCases,
  },

  // ---------- byte-handoff.ts ----------
  ...Object.fromEntries(
    ['handOffBytes', 'takeHandoff', 'pendingHandoffCount'].map((name): [string, FnSpec] => [
      `byte-handoff.${name}`,
      {
        ts: (a) => runHandoffs(a[0] as Any),
        cases: handoffCases(name),
      },
    ]),
  ),

  // ---------- copy-image-guard.ts ----------
  'copy-image-guard.MAX_COPY_IMAGE_DATA_URL': {
    ts: () => MAX_COPY_IMAGE_DATA_URL,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'copy-image-guard.validCopyImageDataUrl': {
    ts: (a) => validCopyImageDataUrl(js(a[0])),
    cases: [
      ...[
        'data:image/png;base64,AAAA',
        'data:image/jpeg;base64,AAAA',
        'data:image/jpg;base64,AAAA',
        'data:image/gif;base64,AAAA',
        'data:image/webp;base64,AAAA',
        'data:image/bmp;base64,AAAA',
        'DATA:IMAGE/PNG;base64,AAAA',
        'data:image/PnG;base64,AAAA',
        'data:image/svg+xml;base64,AAAA',
        'data:text/html;base64,AAAA',
        'data:image/png,AAAA',
        'data:image/png',
        'data:',
        'data:image/jpegx;base64,AA',
        'data:image/gif ;base64,AA',
        'data:image/g\u0131f;base64,AA',
        'data:image/\u017Febp;base64,AA',
        'Data:image/png;base64,AA',
        '\u{FEFF}data:image/png;base64,AA',
        ' data:text/html,x',
        'seuoffice-docx-media://abc/word%2Fmedia%2Fimage1.png',
        '',
        'https://example.com/a.png',
        'data:image/png;base64,\u{1F600}',
      ].map((url): Case => ({ args: [url] })),
      { args: [null], note: 'left out' },
      { args: [{ $val: 'null' }] },
      { args: [5] },
      { args: [['data:image/png;']] },
      { args: [{ a: 1 }] },
      { args: [true] },
      {
        args: ['data:image/png;base64,' + 'A'.repeat(MAX_COPY_IMAGE_DATA_URL - 22)],
        note: 'exactly the cap',
      },
      {
        args: ['data:image/png;base64,' + 'A'.repeat(MAX_COPY_IMAGE_DATA_URL - 21)],
        note: 'one past the cap',
      },
    ],
  },
  'copy-image-guard.copyImageDisplaySize': {
    ts: (a) => copyImageDisplaySize(js(a[0])),
    cases: [
      ...[
        '{"imageWidthPx":100,"imageHeightPx":50}',
        '{"imageWidthPx":100.5,"imageHeightPx":49.5}',
        '{"imageWidthPx":0.4}',
        '{"imageWidthPx":0.5}',
        '{"imageWidthPx":-3,"imageHeightPx":2}',
        '{"imageHeightPx":2e5}',
        '{"imageWidthPx":100000,"imageHeightPx":100000.4}',
        '{"imageWidthPx":1e999}',
        '{"imageWidthPx":"100"}',
        '{"imageWidthPx":null,"imageHeightPx":true}',
        '{"imageWidthPx":0,"imageHeightPx":0}',
        '{"imageWidthPx":2.5,"imageHeightPx":3.5}',
        '{"imageWidthPx":1.4999999999999999}',
        '{}',
        '[]',
        '[1,2]',
        'null',
        '5',
        '"imageWidthPx"',
        'true',
        '',
        '{"imageWidthPx":',
        'not json',
        '\u{FEFF}{"imageWidthPx":5}',
        ' {"imageWidthPx":5} ',
        '{"imageWidthPx":5,"imageWidthPx":7}',
        '{"imageWidthPx":5e-324}',
        '{"imageWidthPx":1e21}',
        '{"\\u0069mageWidthPx":9}',
        '{"imageWidthPx":9,"x":"\u{1F600}"}',
      ].map((meta): Case => ({ args: [meta] })),
      { args: [null], note: 'left out' },
      { args: [7] },
      { args: [{ imageWidthPx: 5 }], note: 'an object, not its text' },
      {
        args: ['{"imageWidthPx":5}' + ' '.repeat(2048 - 18)],
        note: 'exactly 2048 characters',
      },
      {
        args: ['{"imageWidthPx":5}' + ' '.repeat(2048 - 17)],
        note: 'one past 2048 characters',
      },
      {
        args: ['{"a":"' + '\u{1F600}'.repeat(1020) + '","imageWidthPx":5}'],
        note: 'astral characters count two units each: past 2048 units, under 2048 characters',
      },
    ],
  },

  // ---------- doc-format.ts ----------
  'doc-format.docFormatOfPath': {
    ts: (a) => docFormatOfPath(str(a, 0)),
    cases: [
      'a.docx',
      'A.DOCX',
      'a.DocX',
      'a.odt',
      'a.ODT',
      'a.doc',
      'a.docx.txt',
      'a.docx\n',
      'a.docx ',
      '.docx',
      'docx',
      '',
      'dir.odt/file',
      'x.odt.docx',
      'a.d\u00f6cx',
      'C:\\docs\\a.docx',
      'a\u{1F600}.odt',
      'a.\u212Aodt',
    ].map((path): Case => ({ args: [path] })),
  },
  'doc-format.zipEntryNames': {
    ts: (a) => zipEntryNames(bytesOf(str(a, 0))),
    cases: [
      ...zipCases.map((args): Case => ({ args })),
      {
        args: ['504b0506' + '00000000' + '0000' + '0000' + '00000000' + 'ffffffff' + '0000'],
        note: 'no entries, but a central directory offset that is the zip64 sentinel',
      },
    ],
  },
  'doc-format.isOdtPackage': {
    ts: (a) => isOdtPackage(bytesOf(str(a, 0))),
    cases: [
      ...zipCases.map((args): Case => ({ args })),
      { args: [zipHex([{ name: 'content.xml' }])] },
      { args: [zipHex([{ name: 'mimetype' }])] },
    ],
  },
  'doc-format.withDocExtension': {
    ts: (a) => withDocExtension(str(a, 0), str(a, 1) as 'docx' | 'odt'),
    cases: [
      ['a.docx', 'odt'],
      ['a.odt', 'docx'],
      ['a', 'docx'],
      ['a', 'odt'],
      ['', 'docx'],
      ['a.doc', 'docx'],
      ['a.DOCX', 'odt'],
      ['dir.docx/file', 'odt'],
      ['a.docx.bak', 'odt'],
      ['\u00fcn\u{1F600}', 'docx'],
    ].map((args): Case => ({ args })),
  },
  'doc-format.recoveryExtFor': {
    ts: (a) => recoveryExtFor(str(a, 0)),
    cases: ['a.odt', 'a.ODT', 'a.docx', 'a.doc', 'a', '', 'a.odt.docx', 'a.docx.odt', '.odt'].map(
      (path): Case => ({ args: [path] }),
    ),
  },
  'doc-format.prepareSaveBytes': {
    ts: async (a, cx) => {
      const [format, data, d] = [str(a, 0), str(a, 1), a[2] as Any]
      const out = await prepareSaveBytes(format as 'docx' | 'odt', bytesOf(data), {
        materialize: async (plain) => {
          cx.log('materialize', hexOf(plain))
          if (d.materialize?.throws) throw new Error(d.materialize.throws)
          return {
            bytes: Buffer.concat([plain, bytesOf(d.materialize?.append ?? '')]),
            hashes: new Set<string>(d.materialize?.hashes ?? []),
          }
        },
        encrypt: (plain, password) => {
          cx.log('encrypt', hexOf(plain), password)
          if (d.encrypt?.throws) throw new Error(d.encrypt.throws)
          return Buffer.concat([Buffer.from(`ENC:${password}`), plain])
        },
        password: d.password ?? null,
      })
      return {
        bytes: hexOf(out.bytes),
        plain: hexOf(out.plain),
        hashes: [...out.hashes],
        encrypted: out.encrypted,
      }
    },
    cases: [
      { args: ['docx', DOCX, {}] },
      { args: ['docx', DOCX, { materialize: { append: 'aabb', hashes: ['h1', 'h2', 'h1'] } }] },
      {
        args: ['docx', DOCX, { password: 'secret', materialize: { append: '00', hashes: ['x'] } }],
        note: 'an open password wraps the plain bytes',
      },
      { args: ['docx', DOCX, { password: '' }], note: 'an empty password is plain' },
      { args: ['docx', DOCX, { password: 'p\u00e4ss\u{1F600}' }] },
      { args: ['docx', ODT, {}], note: 'ODT bytes for a docx path' },
      { args: ['docx', ODT_WITH_TYPES, {}] },
      { args: ['docx', '', {}], note: 'not a zip: handed to the docx writer' },
      { args: ['docx', DOCX, { materialize: { throws: 'pictures gone' } }] },
      { args: ['docx', DOCX, { password: 'x', encrypt: { throws: 'no cipher' } }] },
      { args: ['odt', ODT, {}] },
      { args: ['odt', ODT, { password: 'ignored', materialize: { throws: 'never called' } }] },
      { args: ['odt', DOCX, {}], note: 'docx bytes for an odt path' },
      { args: ['odt', '', {}] },
      { args: ['odt', ODT_WITH_TYPES, {}] },
    ],
  },
  'doc-format.prepareRecoveryBytes': {
    ts: async (a, cx) => {
      const [format, data, d] = [str(a, 0), str(a, 1), a[2] as Any]
      const out = await prepareRecoveryBytes(format as 'docx' | 'odt', bytesOf(data), {
        materialize: async (plain) => {
          cx.log('materialize', hexOf(plain))
          if (d.materialize?.throws) throw new Error(d.materialize.throws)
          return {
            bytes: Buffer.concat([plain, bytesOf(d.materialize?.append ?? '')]),
            hashes: new Set<string>(d.materialize?.hashes ?? []),
          }
        },
        protect: (plain) => {
          cx.log('protect', hexOf(plain))
          const mode = d.protect?.mode ?? 'prefix'
          if (mode === 'null') return null
          if (mode === 'throws') throw new Error('protect failed')
          return Buffer.concat([Buffer.from('P:'), plain])
        },
      })
      return out === null ? null : hexOf(out)
    },
    cases: [
      { args: ['docx', DOCX, {}] },
      { args: ['docx', DOCX, { materialize: { append: 'cc' } }] },
      { args: ['docx', DOCX, { materialize: { throws: 'source gone' } }], note: 'copy as built' },
      { args: ['docx', DOCX, { protect: { mode: 'null' } }], note: 'skip this copy' },
      { args: ['docx', DOCX, { protect: { mode: 'throws' } }] },
      { args: ['docx', ODT, {}], note: 'odt bytes for a docx path' },
      { args: ['docx', '', {}] },
      { args: ['odt', ODT, { protect: { mode: 'throws' } }] },
      { args: ['odt', DOCX, {}] },
      { args: ['odt', '', {}] },
    ],
  },

  // ---------- external-change.ts ----------
  'external-change.isExternallyModified': {
    ts: async (a, cx) => {
      const recorded = a[0] === null ? undefined : (revive(a[0]) as Any)
      const current = a[1] === null ? null : (revive(a[1]) as Any)
      const reader = a[2] as Any
      return isExternallyModified(recorded, current, () => {
        cx.log('readHash')
        if (reader.throws) throw new Error(reader.throws)
        return reader.hash ?? null
      })
    },
    cases: (() => {
      const rec = { mtimeMs: 1000, size: 10, hash: 'aa' }
      const nan = { $val: 'NaN' }
      return [
        [rec, { mtimeMs: 1000, size: 10 }, { hash: 'bb' }],
        [rec, { mtimeMs: 2000, size: 10 }, { hash: 'bb' }],
        [rec, { mtimeMs: 2000, size: 10 }, { hash: 'aa' }],
        [rec, { mtimeMs: 1000, size: 11 }, { hash: 'bb' }],
        [rec, { mtimeMs: 1000, size: 11 }, { hash: null }],
        [rec, { mtimeMs: 1000, size: 11 }, { throws: 'unreadable' }],
        [rec, { mtimeMs: 1000.5, size: 10 }, { hash: 'bb' }],
        [rec, { mtimeMs: -1, size: 10 }, { hash: 'bb' }],
        [rec, { mtimeMs: nan, size: 10 }, { hash: 'bb' }],
        [{ mtimeMs: nan, size: 10, hash: 'aa' }, { mtimeMs: nan, size: 10 }, { hash: 'bb' }],
        [rec, { mtimeMs: 1000, size: nan }, { hash: 'aa' }],
        [rec, { mtimeMs: 1000, size: 10 }, { throws: 'not read' }],
        [null, { mtimeMs: 5, size: 5 }, { hash: 'bb' }],
        [rec, null, { hash: 'bb' }],
        [null, null, { hash: 'bb' }],
        [{ mtimeMs: 0, size: 0, hash: '' }, { mtimeMs: 1, size: 0 }, { hash: '' }],
        [{ mtimeMs: 0, size: 0, hash: '' }, { mtimeMs: 1, size: 0 }, { hash: 'x' }],
        [{ mtimeMs: { $val: '-0' }, size: 0, hash: 'h' }, { mtimeMs: 0, size: 0 }, { hash: 'x' }],
      ].map((args): Case => ({ args }))
    })(),
  },

  // ---------- hwp-export.ts ----------
  'hwp-export.convertInWorker': {
    ts: async (a, cx) => {
      const [jobSpec, script] = [a[0] as Any, a[1] as Any]
      const out = await convertInWorker(
        {
          docx: bytesOf(jobSpec.docx) as unknown as Uint8Array,
          format: jobSpec.format,
          wasmPath: jobSpec.wasmPath,
        },
        () => {
          cx.log('spawn')
          if (script.spawnThrows) throw new Error(script.spawnThrows)
          return new FakeWorker(script, cx.log) as never
        },
      )
      return { bytes: hexOf(out.bytes), losses: out.losses }
    },
    cases: [
      convertCase(JOB, { events: [reply('ff00')] }, 'answered'),
      convertCase(
        JOB,
        {
          events: [
            reply('01', [
              LOSS('comment', 'dropped', 2),
              LOSS('table', 'changed', 1.5),
              LOSS('ink', 'dropped', { $val: 'NaN' }),
            ]),
          ],
        },
        'with losses',
      ),
      convertCase({ ...JOB, format: 'hwp', docx: '' }, { events: [reply('')] }, 'empty bytes'),
      convertCase(JOB, { events: [refusal('unsupported', 'cannot convert')] }, 'refused'),
      convertCase(JOB, { events: [refusal('', '')] }, 'refused with empty text'),
      convertCase(JOB, { events: [{ error: 'worker exploded' }] }, 'the worker errored'),
      convertCase(JOB, { events: [{ exit: 3 }] }, 'the worker exited'),
      convertCase(JOB, { events: [{ exit: 0 }] }),
      convertCase(JOB, { events: [{ exit: -1.5 }] }),
      convertCase(JOB, { events: [{ exit: { $val: 'NaN' } }] }),
      convertCase(
        JOB,
        { events: [reply('aa'), { error: 'late' }, { exit: 1 }] },
        'only the first event counts',
      ),
      convertCase(JOB, { events: [{ exit: 1 }, reply('aa')] }, 'an exit before the answer'),
      convertCase(JOB, { events: [{ error: 'first' }, refusal('x', 'y')] }),
      convertCase(JOB, { postThrows: 'cannot post', events: [reply('aa')] }, 'postMessage throws'),
      convertCase(JOB, { spawnThrows: 'no thread', events: [reply('aa')] }, 'spawn throws'),
    ],
  },
  'hwp-export.HwpExportFailure': {
    ts: (a) => {
      const e = new HwpExportFailure(str(a, 0) as never, str(a, 1))
      return { name: e.name, code: e.code, message: e.message, isError: e instanceof Error }
    },
    cases: [
      ['unsupported', 'cannot convert'],
      ['', ''],
      ['failed', 'h\u00e9llo \u{1F600}'],
    ].map((args): Case => ({ args })),
  },
  'hwp-export.exportHwp': {
    ts: async (a, cx) => {
      const spec = a[0] as Any
      const flag = (key: string, fallback: boolean): boolean => {
        const v = spec[key]
        if (typeof v === 'boolean') return v
        if (v && typeof v === 'object' && 'throws' in v) throwIt(v.throws)
        return fallback
      }
      const guard = (key: string): void => {
        if (spec[key]?.throws) throwIt(spec[key].throws)
      }
      let asked = 0
      const out = await exportHwp(
        {
          authorized: (path) => {
            cx.log('authorized', path)
            return flag('authorized', true)
          },
          pickPath: async () => {
            cx.log('pickPath')
            guard('pick')
            return spec.pick ?? null
          },
          materialize: async (docx) => {
            cx.log('materialize', hexOf(docx))
            guard('materialize')
            return Buffer.concat([docx, bytesOf(spec.materialize?.append ?? '')])
          },
          convert: async (docx, format) => {
            cx.log('convert', hexOf(docx), format)
            guard('convert')
            return {
              bytes: bytesOf(spec.convert?.bytesHex ?? ''),
              losses: js(spec.convert?.losses ?? []) as never,
            }
          },
          confirm: async (losses, passwordDropped) => {
            cx.log('confirm', losses, passwordDropped)
            return flag('confirm', true)
          },
          stillOpen: () => {
            cx.log('stillOpen')
            const seq = (spec.stillOpen ?? []) as boolean[]
            const answer = seq[asked] ?? seq[seq.length - 1] ?? true
            asked++
            return answer
          },
          write: async (path, bytes) => {
            cx.log('write', path, hexOf(bytes))
            guard('write')
          },
          open: (path) => {
            cx.log('open', path)
            guard('open')
          },
        },
        {
          docx: bytesOf(spec.docx),
          passwordSet: spec.passwordSet,
          ...(spec.outPath === undefined || spec.outPath === null ? {} : { outPath: spec.outPath }),
        },
      )
      return out
    },
    cases: (() => {
      const lost = [LOSS('comment', 'dropped', 1)]
      const err = (message: string): Thrown => ({ kind: 'error', message })
      const fail = (code: string, message: string): Thrown => ({ kind: 'failure', code, message })
      const text = (message: string): Thrown => ({ kind: 'string', message })
      return [
        exportCase({ outPath: '/out/a.hwp' }, 'no losses: written and opened'),
        exportCase({ outPath: '/out/a.hwpx', convert: { bytesHex: 'aa' } }, 'hwpx by extension'),
        exportCase({ outPath: '/out/a.HWPX', convert: { bytesHex: 'aa' } }),
        exportCase({ outPath: '/out/a.hwpx.bak', convert: { bytesHex: 'aa' } }, 'not hwpx'),
        exportCase({ outPath: '/out/a.hwpx\n' }, 'a newline after the extension'),
        exportCase({ outPath: '' }, 'an empty path is a path'),
        exportCase({ outPath: '/out/a.hwp', authorized: false }, 'unauthorized'),
        exportCase({ outPath: '/out/a.hwp', authorized: { throws: err('policy') } }),
        exportCase({ pick: null }, 'canceled in the dialog'),
        exportCase({ pick: { path: '/out/b.hwpx', format: 'hwpx' }, convert: { bytesHex: '01' } }),
        exportCase({ pick: { path: '/out/b.hwp', format: 'hwp' } }, 'format from the dialog'),
        exportCase({ pick: { throws: err('dialog broke') } }, 'the dialog throws'),
        exportCase({ pick: { throws: text('dialog text') } }),
        exportCase({
          outPath: '/o.hwp',
          materialize: { append: 'ee' },
          convert: { bytesHex: '99', losses: lost },
        }),
        exportCase({ outPath: '/o.hwp', convert: { losses: lost }, confirm: true }, 'confirmed'),
        exportCase({ outPath: '/o.hwp', convert: { losses: lost }, confirm: false }, 'declined'),
        exportCase({ outPath: '/o.hwp', passwordSet: true }, 'a password: confirm without losses'),
        exportCase({ outPath: '/o.hwp', passwordSet: true, confirm: false }),
        exportCase({ outPath: '/o.hwp', stillOpen: [false] }, 'tab gone after the conversion'),
        exportCase(
          { outPath: '/o.hwp', convert: { losses: lost }, stillOpen: [true, false] },
          'tab gone after the confirmation',
        ),
        exportCase(
          { outPath: '/o.hwp', convert: { losses: lost }, stillOpen: [true, true] },
          'tab open throughout',
        ),
        exportCase(
          {
            outPath: '/o.hwp',
            convert: { losses: lost },
            confirm: false,
            stillOpen: [true, false],
          },
          'declined: stillOpen is not asked again',
        ),
        exportCase({ outPath: '/o.hwp', materialize: { throws: err('no pictures') } }),
        exportCase({ outPath: '/o.hwp', convert: { throws: fail('too_large', 'file too big') } }),
        exportCase({ outPath: '/o.hwp', convert: { throws: err('engine crashed') } }),
        exportCase({ outPath: '/o.hwp', convert: { throws: text('plain text thrown') } }),
        exportCase({ outPath: '/o.hwp', write: { throws: err('disk full') } }),
        exportCase({ outPath: '/o.hwp', open: { throws: fail('x', 'cannot open') } }),
        exportCase({
          outPath: '/o.hwp',
          convert: { losses: lost },
          confirm: { throws: err('box failed') },
        }),
        exportCase({
          pick: { path: '/p/\u00e9.hwp', format: 'hwp' },
          materialize: { throws: err('h\u00e9llo \u{1F600}') },
        }),
      ]
    })(),
  },
  'hwp-export.hwpLossMessageBox': {
    ts: (a) => hwpLossMessageBox(revive(a[0]) as never, a[1] as boolean, a[2] as 'en' | 'ko'),
    cases: (() => {
      const everyDropped = ALL_FEATURES.map((f) => LOSS(f, 'dropped', 1))
      const everyChanged = ALL_FEATURES.map((f, i) => LOSS(f, 'changed', i + 1))
      return [
        [[LOSS('comment', 'dropped', 1)], false, 'en'],
        [[LOSS('comment', 'dropped', 1)], false, 'ko'],
        [[LOSS('table', 'changed', 3)], false, 'en'],
        [[LOSS('table', 'changed', 3)], true, 'ko'],
        [[], true, 'en'],
        [[], true, 'ko'],
        [[], false, 'en'],
        [everyDropped, false, 'en'],
        [everyChanged, true, 'ko'],
        [[...everyChanged, ...everyDropped], true, 'en'],
        [
          [LOSS('picture', 'changed', 1.5), LOSS('field', 'dropped', 2), LOSS('toc', 'changed', 0)],
          false,
          'en',
        ],
        [[LOSS('shape', 'dropped', -2), LOSS('ink', 'dropped', { $val: 'NaN' })], false, 'ko'],
        [[LOSS('shape', 'dropped', { $val: 'Infinity' })], false, 'en'],
        [[LOSS('chart', 'dropped', 1), LOSS('chart', 'dropped', 2)], false, 'en'],
        [[LOSS('note', 'weird', 5), LOSS('note', 'changed', 5)], false, 'ko'],
        [[LOSS('hyperlink', 'dropped', 10)], true, 'ko'],
      ].map((args): Case => ({ args }))
    })(),
  },

  // ---------- hwp-export-strings.ts ----------
  'hwp-export-strings.HWP_EXPORT_STRINGS': {
    ts: () => HWP_EXPORT_STRINGS,
    cases: [{ args: [] }],
    single: CONSTANT,
  },

  // ---------- lazy-media-inline.ts ----------
  'lazy-media-inline.inlineLazyMediaInHtml': {
    ts: async (a, cx) => {
      const reads = a[1] as Any
      return inlineLazyMediaInHtml(str(a, 0), async (url) => {
        cx.log('read', url)
        if (!Object.hasOwn(reads, url) || reads[url] === null) return null
        const entry = reads[url]
        if (entry.throws) throw new Error(entry.throws)
        return { body: bytesOf(entry.hex ?? ''), mime: entry.mime ?? '' }
      })
    },
    cases: (() => {
      const S = 'seuoffice-docx-media://'
      const U1 = `${S}${'a'.repeat(64)}/word%2Fmedia%2Fimage1.png`
      const U2 = `${S}${'b'.repeat(64)}/word%2Fmedia%2Fimage2.jpg`
      const png = { hex: '89504e47', mime: 'image/png' }
      const jpg = { hex: 'ffd8ff', mime: 'image/jpeg' }
      const one = { hex: '41', mime: 'text/plain' }
      return [
        ['<p>no pictures</p>', {}],
        ['', {}],
        [`<img src="${U1}">`, { [U1]: png }],
        [`<img src="${U1}"><img src="${U2}">`, { [U1]: png, [U2]: jpg }],
        [`<img src="${U1}"><img src="${U1}">`, { [U1]: png }],
        [`<img src="${U1}"><img src="${U2}"><img src="${U1}">`, { [U1]: png, [U2]: jpg }],
        [`<img src="${U1}"><img src="${U2}">`, { [U1]: png }],
        [`<img src="${U1}">`, {}],
        [`<img src="${U1}">`, { [U1]: null }],
        [`<img src="${U1}">`, { [U1]: { throws: 'source went away' } }],
        [`<img src="${U1}"><img src="${U2}">`, { [U1]: { throws: 'x' }, [U2]: jpg }],
        [`<img src='${S}h/it's.png'>`, { [`${S}h/it's.png'`]: one }],
        [`<img src='${S}h/it's.png'>`, { [`${S}h/it's.png`]: one }],
        [`<a href="${U1}">x</a>`, { [U1]: { hex: '', mime: 'image/png' } }],
        [`${U1} and ${U2}`, { [U1]: one, [U2]: one }],
        [`${U1}<b>`, { [U1]: one }],
        [`url(${U1})`, { [`${U1})`]: one }],
        [`<img src="${U1}\u00a0tail">`, { [U1]: one }],
        [`<img src="${U1}\u{FEFF}tail">`, { [U1]: one }],
        [`<img src="${U1}\u2028tail">`, { [U1]: one }],
        [`<img src="${U1}\u00e9\u{1F600}">`, { [`${U1}\u00e9\u{1F600}`]: one }],
        [`caf\u00e9 \u{1F600} <img src="${U1}"> \u{1F600}`, { [U1]: png }],
        [`<img src="${S}">`, {}],
        [`<img src="${S}x">`, { [`${S}x`]: { hex: '4142', mime: 'a/b' } }],
        [`<img src="${S}x">`, { [`${S}x`]: { hex: '414243', mime: 'a/b' } }],
        [`<img src="${S}x">`, { [`${S}x`]: { hex: '41424344', mime: '$&' } }],
        [`<img src="SEUOFFICE-DOCX-MEDIA://x">`, {}],
        [`a${S}x"b${S}y"`, { [`${S}x`]: one, [`${S}y`]: jpg }],
      ].map((args): Case => ({ args }))
    })(),
  },

  // ---------- merge-output.ts ----------
  'merge-output.mergeOutputFileName': {
    ts: (a) => mergeOutputFileName(str(a, 0)),
    cases: [
      'letter.docx',
      'Letter.DOCX',
      'letter',
      '',
      '.',
      '..',
      '   ',
      ' a ',
      'a/b/c.docx',
      'a\\b\\c',
      'a/b/',
      '/',
      '\\',
      '../../etc/passwd',
      'dir/..',
      'a:b*c?d"e<f>g|h',
      'x.docx.docx',
      'x.docx.',
      '.docx',
      'a.DocX',
      '\u00a0name\u00a0',
      '\u{FEFF}name\u{FEFF}',
      '\u0085name',
      'caf\u00e9 \u{1F600}',
      'k\u212A',
      'CON',
      'a b.docx',
      '**.docx',
      '...',
      'a/./b',
      '.\u00a0',
    ].map((name): Case => ({ args: [name] })),
  },
  'merge-output.mergeOutputPath': {
    ts: (a) => mergeOutputPath(str(a, 0), str(a, 1)),
    cases: [
      { args: ['$DIR/out', 'letter'], files: { out: { dir: true } } },
      { args: ['$DIR/out', 'letter.docx'], files: { 'out/letter.docx': 'x' } },
      {
        args: ['$DIR/out', 'letter.docx'],
        files: { 'out/letter.docx': 'x', 'out/letter-2.docx': 'y', 'out/letter-3.docx': 'z' },
      },
      {
        args: ['$DIR/out', 'letter'],
        files: { 'out/letter.docx': 'x', 'out/letter-3.docx': 'z' },
        note: 'the first free number',
      },
      { args: ['$DIR/out', 'a/b/c.docx'], files: { 'out/c.docx': 'x' } },
      {
        args: ['$DIR/out', '.docx'],
        files: { 'out/.docx': 'x' },
        note: 'a name that is only an extension',
      },
      { args: ['$DIR/out', '.docx'], files: { 'out/.docx': 'x', 'out/.docx-2': 'y' } },
      { args: ['$DIR/out', '..'], files: { 'out/document.docx': 'x' } },
      { args: ['$DIR/out', ''], files: { 'out/document.docx': 'x', 'out/document-2.docx': 'y' } },
      { args: ['$DIR/out', 'x.DOCX'], files: { 'out/x.DOCX': 'x' } },
      { args: ['$DIR/out', 'caf\u00e9'], files: { 'out/caf\u00e9.docx': 'x' } },
      { args: ['$DIR/out', '\u{1F600}'], files: { 'out/\u{1F600}.docx': 'x' } },
      { args: ['$DIR/out', 'folder'], files: { 'out/folder.docx': { dir: true } } },
      { args: ['$DIR/out/', 'a'], files: { 'out/a.docx': 'x' }, note: 'a trailing slash' },
      { args: ['$DIR/out//sub/../', 'a'], files: { 'out/a.docx': 'x' } },
      { args: ['$DIR/none', 'a'], note: 'a folder that is not there' },
      { args: ['$DIR/out', 'n.docx.docx'], files: { 'out/n.docx.docx': 'x' } },
    ],
  },

  // ---------- print-args.ts ----------
  'print-args.validPrintDim': {
    ts: (a) => validPrintDim(js(a[0])),
    cases: [
      144,
      143.9,
      143.999999,
      72000,
      72000.1,
      1440,
      11906,
      0,
      -144,
      { $val: 'NaN' },
      { $val: 'Infinity' },
      { $val: '-Infinity' },
      { $val: '-0' },
      '1440',
      true,
      { $val: 'null' },
      null,
      [],
      [1440],
      {},
      1e21,
    ].map((v): Case => ({ args: [v] })),
  },
  'print-args.validPrintScale': {
    ts: (a) => validPrintScale(js(a[0])),
    cases: [
      null,
      { $val: 'null' },
      0.1,
      0.09,
      0.0999999,
      5,
      5.01,
      1,
      0,
      -1,
      { $val: 'NaN' },
      { $val: 'Infinity' },
      { $val: '-0' },
      '1',
      false,
      {},
    ].map((v): Case => ({ args: [v] })),
  },
  'print-args.validPrintGeometry': {
    ts: (a) => validPrintGeometry(js(a[0]), js(a[1]), js(a[2])),
    cases: [
      [11906, 16838, null],
      [11906, 16838, 1],
      [11906, 16838, 0.05],
      [11906, 16838, 5],
      [11906, 16838, { $val: 'null' }],
      [11906, 143, 1],
      [143, 16838, 1],
      [{ $val: 'NaN' }, 16838, 1],
      [11906, { $val: 'Infinity' }, 1],
      [null, 16838, 1],
      [11906, null, null],
      [144, 72000, 0.1],
      ['11906', 16838, 1],
      [11906, 16838, '2'],
      [72001, 72001, 9],
    ].map((args): Case => ({ args })),
  },
  'print-args.printScaleOption': {
    ts: (a) => printScaleOption(js(a[0])),
    cases: [
      null,
      1,
      1.0000001,
      0.5,
      2,
      5000,
      1e-300,
      0,
      -2,
      { $val: 'NaN' },
      { $val: 'Infinity' },
      { $val: '-Infinity' },
      { $val: '-0' },
      '2',
      true,
      {},
    ].map((v): Case => ({ args: [v] })),
  },
  'print-args.validPrintPaper': {
    ts: (a) => validPrintPaper(js(a[0])),
    cases: [
      { widthTwips: 11906, heightTwips: 16838 },
      { widthTwips: 11906.5, heightTwips: 16838.25 },
      { widthTwips: 11906, heightTwips: 16838, extra: 1 },
      { heightTwips: 16838, widthTwips: 11906 },
      { widthTwips: 143, heightTwips: 16838 },
      { widthTwips: 11906, heightTwips: 72001 },
      { widthTwips: 11906 },
      { heightTwips: 16838 },
      { widthTwips: '11906', heightTwips: 16838 },
      { widthTwips: { $val: 'NaN' }, heightTwips: 16838 },
      { widthTwips: 11906, heightTwips: { $val: 'Infinity' } },
      { widthTwips: null, heightTwips: 16838 },
      {},
      [],
      [11906, 16838],
      null,
      { $val: 'null' },
      'A4',
      5,
      true,
    ].map((v): Case => ({ args: [v] })),
  },
  'print-args.printPaperOption': {
    ts: (a) => printPaperOption(js(a[0])),
    cases: [
      { widthTwips: 11906, heightTwips: 16838 },
      { widthTwips: 12240, heightTwips: 15840 },
      { widthTwips: 144, heightTwips: 144 },
      { widthTwips: 72000, heightTwips: 72000 },
      { widthTwips: 1440.5, heightTwips: 2880.75 },
      { widthTwips: 10000.4, heightTwips: 1234.567 },
      { widthTwips: 1500, heightTwips: 1500 },
      { widthTwips: 11906 },
      { widthTwips: 11, heightTwips: 16838 },
      {},
      null,
      [],
      'A4',
      { widthTwips: { $val: 'NaN' }, heightTwips: 1440 },
    ].map((v): Case => ({ args: [v] })),
  },
  'print-args.printJobOptions': {
    ts: (a) => printJobOptions(a[0] as never),
    cases: [
      null,
      {},
      { deviceName: 'HP LaserJet' },
      { deviceName: '' },
      { deviceName: 'HP', copies: 2, collate: true, duplexMode: 'longEdge' },
      { deviceName: 'HP', copies: 0 },
      { deviceName: 'HP', copies: 1.5 },
      { deviceName: 'HP', copies: 1000 },
      { deviceName: 'HP', duplexMode: 'sideways' },
      { deviceName: 'HP', duplexMode: 'shortEdge', collate: false },
      { deviceName: 'HP', pageWidthIn: 8.27, pageHeightIn: 11.69 },
      { deviceName: 'HP', pageWidthIn: 0, pageHeightIn: 11.69 },
      { deviceName: 'HP', pageWidthIn: 8.27, pageHeightIn: 201 },
      { deviceName: 'HP', driverOptions: [{ name: 'InputSlot', value: 'Tray1' }] },
      { deviceName: 'HP', driverOptions: [{ name: 'bad name!', value: 'x' }] },
      { deviceName: 5 },
      5,
      'HP',
      [],
    ].map((v): Case => ({ args: [v] })),
  },

  // ---------- read-url-ipc.ts ----------
  'read-url-ipc.unexpectedReadUrlFailure': {
    ts: () => unexpectedReadUrlFailure(),
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'read-url-ipc.normalizeReadUrlRequest': {
    ts: (a) => normalizeReadUrlRequest(js(a[0]), js(a[1])),
    cases: [
      ['https://example.com', null],
      ['https://example.com', 100],
      ['https://example.com', 0],
      ['https://example.com', -5],
      ['https://example.com', 1.5],
      ['https://example.com', 1e21],
      ['https://example.com', { $val: 'NaN' }],
      ['https://example.com', { $val: 'Infinity' }],
      ['https://example.com', { $val: '-0' }],
      ['https://example.com', '10'],
      ['https://example.com', { $val: 'null' }],
      ['https://example.com', true],
      ['  https://example.com  ', 7],
      ['', 5],
      ['   ', 5],
      ['\u00a0\u{FEFF}', 5],
      ['\u0085', 5],
      ['\t\n x', 5],
      [null, 5],
      [{ $val: 'null' }, 5],
      [5, 5],
      [['https://example.com'], 5],
      [{ url: 'x' }, 5],
      ['caf\u00e9 \u{1F600}', 3],
      ['not a url at all', null],
    ].map((args): Case => ({ args })),
  },

  // ---------- save-as-formats.ts ----------
  'docs/save-as-formats.saveAsFilters': {
    ts: (a, cx) =>
      saveAsFilters(str(a, 0) as 'docx' | 'odt', a[1] as boolean, (key) => {
        cx.log('label', key)
        return `L:${key}`
      }),
    cases: [
      ['docx', false],
      ['odt', false],
      ['docx', true],
      ['odt', true],
    ].map((args): Case => ({ args })),
  },
  'docs/save-as-formats.saveAsDefaultPath': {
    ts: (a) => saveAsDefaultPath(str(a, 0), a[1] as boolean),
    cases: [
      ['/d/report.docx', true],
      ['/d/report.docx', false],
      ['/d/report.odt', true],
      ['/d/REPORT.DOCX', true],
      ['/d/report.Odt', true],
      ['/d/report.pdf', true],
      ['/d/report.docx.docx', true],
      ['/d/report.docx ', true],
      ['/d/report.docx\n', true],
      ['report', true],
      ['', true],
      ['.docx', true],
      ['/d/\u00e9.odt', true],
      ['/d/\u{1F600}.docx', true],
      ['/d/a.docx/b', true],
    ].map((args): Case => ({ args })),
  },
  'docs/save-as-formats.saveAsTarget': {
    ts: (a) => saveAsTarget(str(a, 0), str(a, 1) as 'docx' | 'odt', a[2] as boolean),
    cases: [
      ['/d/a.docx', 'odt', true],
      ['/d/a.odt', 'docx', false],
      ['/d/a.DOCX', 'odt', true],
      ['/d/a.pdf', 'docx', true],
      ['/d/a.pdf', 'docx', false],
      ['/d/a.PDF', 'odt', true],
      ['/d/a.hwp', 'docx', true],
      ['/d/a.hwpx', 'docx', true],
      ['/d/a.html', 'docx', true],
      ['/d/a.htm', 'docx', true],
      ['/d/a.md', 'docx', true],
      ['/d/a.markdown', 'docx', true],
      ['/d/a.MARKDOWN', 'docx', true],
      ['/d/a.mar\u212Adown', 'docx', true],
      ['/d/a.png', 'odt', true],
      ['/d/a.txt', 'docx', true],
      ['/d/a.txt', 'odt', false],
      ['/d/a', 'docx', true],
      ['/d/a', 'odt', false],
      ['/d.pdf/a', 'docx', true],
      ['C:\\d.pdf\\a', 'docx', true],
      ['/d/a.', 'docx', true],
      ['/d/.pdf', 'docx', true],
      ['/d/a.pdf.bak', 'docx', true],
      ['/d/a.p\u00f1g', 'odt', true],
      ['/d/\u{1F600}.png', 'odt', true],
      ['/d/a.pdf\n', 'docx', true],
      ['', 'docx', true],
      ['/d/a.docx.pdf', 'docx', true],
      ['/d/a.pdf.docx', 'docx', true],
    ].map((args): Case => ({ args })),
  },
  'docs/save-as-formats.hwpExportFilters': {
    ts: (a, cx) =>
      hwpExportFilters(str(a, 0) as 'hwp' | 'hwpx', (key) => {
        cx.log('label', key)
        return `L:${key}`
      }),
    cases: [['hwp'], ['hwpx']].map((args): Case => ({ args })),
  },
  'docs/save-as-formats.hwpExportTarget': {
    ts: (a) => hwpExportTarget(str(a, 0), str(a, 1) as 'hwp' | 'hwpx'),
    cases: [
      ['/d/a.hwp', 'hwpx'],
      ['/d/a.hwpx', 'hwp'],
      ['/d/a.HWPX', 'hwp'],
      ['/d/a.Hwp', 'hwpx'],
      ['/d/a', 'hwp'],
      ['/d/a', 'hwpx'],
      ['/d/a.txt', 'hwp'],
      ['/d/a.txt', 'hwpx'],
      ['/d/a.hwp.txt', 'hwpx'],
      ['/d.hwp/a', 'hwpx'],
      ['C:\\d.hwpx\\a', 'hwp'],
      ['/d/a.', 'hwpx'],
      ['', 'hwp'],
      ['/d/a.hw\u0070', 'hwpx'],
      ['/d/\u00e9\u{1F600}.hwpx', 'hwp'],
      ['/d/a.hwp\n', 'hwpx'],
    ].map((args): Case => ({ args })),
  },

  // ---------- starred-files.ts ----------
  'starred-files.parseStarredItems': {
    ts: (a) => parseStarredItems(js(a[0])),
    cases: [
      ['/a.docx', '/b.docx'],
      [],
      [{ path: '/a', group: 'Work' }, { path: '/b' }],
      [{ path: '/a', group: '  Work  ' }],
      [{ path: '/a', group: '   ' }],
      [{ path: '/a', group: '' }],
      [{ path: '/a', group: 5 }],
      [{ path: '/a', group: null }],
      [{ path: '/a', group: '\u00a0\u{FEFF}x\u00a0' }],
      [{ group: 'g' }],
      [{ path: 5 }],
      [{ path: null }],
      [null, 0, 1, true, false, '', 'x', [], [1], {}],
      [{ path: '/a', extra: 1 }],
      [{ group: 'g', path: '/a' }],
      [['/nested']],
      [{ path: '' }, '', { path: '', group: 'g' }],
      ['/same', '/same', { path: '/same', group: 'g' }],
      { version: 1, items: [{ path: '/a', group: 'g' }, '/b', 7] },
      { items: [] },
      { items: 'x' },
      { items: { path: '/a' } },
      { version: 1 },
      {},
      { 2: 'x', 10: 'y', items: ['/z'] },
      'text',
      5,
      true,
      null,
      { $val: 'null' },
      { $val: 'NaN' },
      [{ path: '/\u00e9\u{1F600}', group: 'g\u{1F600}' }],
    ].map((v): Case => ({ args: [v] })),
  },
  'starred-files.readStarredItems': {
    ts: (a) => readStarredItems(str(a, 0)),
    cases: [
      {
        args: ['$DIR/starred.json'],
        files: { 'starred.json': STAR([{ path: '/a', group: 'g' }]) },
      },
      { args: ['$DIR/starred.json'], files: { 'starred.json': '["/a","/b"]' } },
      { args: ['$DIR/starred.json'], files: { 'starred.json': STAR([]) } },
      { args: ['$DIR/starred.json'], files: { 'starred.json': '{"version":1,' }, note: 'corrupt' },
      { args: ['$DIR/starred.json'], files: { 'starred.json': '' } },
      { args: ['$DIR/starred.json'], files: { 'starred.json': 'null' } },
      { args: ['$DIR/starred.json'], files: { 'starred.json': '\u{FEFF}["/a"]' }, note: 'BOM' },
      { args: ['$DIR/starred.json'], files: { 'starred.json': { hex: '5b222f61ff225d' } } },
      {
        args: ['$DIR/starred.json'],
        files: { 'starred.json': { hex: '5b222fe4bd22' + '5d' } },
        note: 'a truncated multibyte character',
      },
      { args: ['$DIR/none.json'], note: 'missing' },
      { args: ['$DIR/starred.json'], files: { 'starred.json': { dir: true } }, note: 'a folder' },
      {
        args: ['$DIR/starred.json'],
        files: { 'starred.json': { text: '["/a"]', mode: 0 } },
        note: 'unreadable',
      },
      { args: ['$DIR/starred.json'], files: { 'starred.json': ' \n["/a"]\n ' } },
      { args: ['$DIR/starred.json'], files: { 'starred.json': '["/\u00e9\u{1F600}"]' } },
    ],
  },
  'starred-files.writeStarredItems': {
    ts: (a) =>
      masked(() => writeStarredItems(str(a, 0), a[1] as { path: string; group?: string }[])),
    cases: [
      { args: ['$DIR/starred.json', [{ path: '/a' }]] },
      { args: ['$DIR/starred.json', [{ path: '/a', group: 'g' }, { path: '/b' }]] },
      { args: ['$DIR/starred.json', []], files: { 'starred.json': 'old' } },
      { args: ['$DIR/starred.json', [{ path: '/\u00e9\u{1F600}', group: '\u{1F600}' }]] },
      { args: ['$DIR/ud/starred.json', [{ path: '/a' }]], note: 'the folder is made' },
      {
        args: ['$DIR/starred.json', [{ path: '/a' }]],
        files: { 'starred.json': { dir: true } },
        note: 'a folder where the file is',
      },
      {
        args: ['$DIR/f/starred.json', [{ path: '/a' }]],
        files: { f: 'a file' },
        note: 'a file where the folder is',
      },
      { args: ['$DIR/starred.json', [{ path: 'a\\b"c\n' }]] },
      { args: ['$DIR/starred.json', [{ path: '/a', group: '' }]] },
    ],
  },
  'starred-files.toggleStarredItem': {
    ts: (a) => toggleStarredItem(a[0] as never, str(a, 1)),
    cases: [
      [[], '/a'],
      [[{ path: '/a' }], '/a'],
      [[{ path: '/a', group: 'g' }], '/a'],
      [[{ path: '/a', group: 'g' }], '/b'],
      [[{ path: '/a' }, { path: '/b', group: 'g' }, { path: '/c' }], '/b'],
      [[{ path: '/a' }, { path: '/a' }], '/a'],
      [[{ path: '/a' }], ''],
      [[{ path: '' }], ''],
      [[{ path: '/A' }], '/a'],
      [[{ path: '/\u00e9\u{1F600}' }], '/\u00e9\u{1F600}'],
    ].map((args): Case => ({ args })),
  },
  'starred-files.dropStarredItems': {
    ts: (a) => dropStarredItems(a[0] as never, a[1] as string[]),
    cases: [
      [[{ path: '/a' }, { path: '/b' }], ['/a']],
      [
        [{ path: '/a' }, { path: '/b' }],
        ['/a', '/b'],
      ],
      [[{ path: '/a' }, { path: '/b' }], ['/c']],
      [[{ path: '/a' }, { path: '/b' }], []],
      [[], ['/a']],
      [[], []],
      [
        [{ path: '/a', group: 'g' }, { path: '/b' }],
        ['/a', '/a', '/zzz'],
      ],
      [[{ path: '/a' }, { path: '/a' }], ['/a']],
      [[{ path: '' }], ['']],
      [[{ path: '/a' }], ['/A']],
    ].map((args): Case => ({ args })),
  },
  'starred-files.assignStarredGroup': {
    ts: (a) => assignStarredGroup(a[0] as never, a[1] as string[], (a[2] as string | null) ?? null),
    cases: [
      [[{ path: '/a' }, { path: '/b' }], ['/a'], 'Work'],
      [[{ path: '/a', group: 'Work' }], ['/a'], 'Work'],
      [[{ path: '/a', group: 'Work' }], ['/a'], '  Work  '],
      [[{ path: '/a', group: 'Work' }], ['/a'], null],
      [[{ path: '/a', group: 'Work' }], ['/a'], ''],
      [[{ path: '/a', group: 'Work' }], ['/a'], '   '],
      [[{ path: '/a' }], ['/a'], null],
      [[{ path: '/a' }], ['/a'], ''],
      [[{ path: '/a', group: '' }], ['/a'], ''],
      [[{ path: '/a' }], [], 'g'],
      [[{ path: '/a' }], ['/zzz'], 'g'],
      [[{ path: '/a' }, { path: '/b', group: 'h' }, { path: '/c' }], ['/a', '/b', '/q'], 'g'],
      [[{ path: '/a' }, { path: '/b', group: 'g' }], ['/a', '/b'], 'g'],
      [[], ['/a'], 'g'],
      [[{ path: '/a' }], ['/a'], '\u00a0\u{FEFF}Team\u{1F600}\u00a0'],
      [[{ path: '/a' }], ['/a'], '\u0085x'],
    ].map((args): Case => ({ args })),
  },
  'starred-files.renameStarredItem': {
    ts: (a) => renameStarredItem(a[0] as never, str(a, 1), str(a, 2)),
    cases: [
      [[{ path: '/a' }], '/a', '/b'],
      [[{ path: '/a', group: 'g' }], '/a', '/b'],
      [[{ path: '/a' }, { path: '/c', group: 'g' }], '/c', '/d'],
      [[{ path: '/a' }], '/x', '/b'],
      [[], '/a', '/b'],
      [[{ path: '/a' }, { path: '/a', group: 'g' }], '/a', '/b'],
      [[{ path: '/a' }], '/a', '/a'],
      [[{ path: '/a' }, { path: '/b' }], '/a', '/b'],
      [[{ path: '/a' }], '/a', ''],
      [[{ path: '/\u00e9' }], '/\u00e9', '/\u{1F600}'],
    ].map((args): Case => ({ args })),
  },
  'starred-files.starredGroupNames': {
    ts: (a) => starredGroupNames(a[0] as never),
    cases: [
      [[]],
      [[{ path: '/a' }]],
      [[{ path: '/a', group: 'g' }]],
      [
        [
          { path: '/a', group: 'g' },
          { path: '/b', group: 'h' },
          { path: '/c', group: 'g' },
        ],
      ],
      [[{ path: '/a', group: 'h' }, { path: '/b' }, { path: '/c', group: 'g' }]],
      [
        [
          { path: '/a', group: '' },
          { path: '/b', group: 'x' },
        ],
      ],
      [
        [
          { path: '/a', group: 'G' },
          { path: '/b', group: 'g' },
        ],
      ],
      [
        [
          { path: '/a', group: '2' },
          { path: '/b', group: '10' },
          { path: '/c', group: '1' },
        ],
      ],
      [
        [
          { path: '/a', group: '\u{1F600}' },
          { path: '/b', group: '\u00e9' },
        ],
      ],
    ].map((args): Case => ({ args })),
  },
  'starred-files.starredGroupMap': {
    ts: (a) => [...starredGroupMap(a[0] as never)],
    cases: [
      [[]],
      [[{ path: '/a' }]],
      [[{ path: '/a', group: 'g' }, { path: '/b' }, { path: '/c', group: 'h' }]],
      [
        [
          { path: '/a', group: 'g' },
          { path: '/a', group: 'h' },
        ],
      ],
      [
        [
          { path: '/b', group: 'g' },
          { path: '/a', group: 'h' },
          { path: '/b', group: 'i' },
        ],
      ],
      [[{ path: '/a', group: '' }]],
      [
        [
          { path: '10', group: 'x' },
          { path: '2', group: 'y' },
          { path: 'b', group: 'z' },
        ],
      ],
      [
        [
          { path: '__proto__', group: 'p' },
          { path: 'constructor', group: 'c' },
        ],
      ],
    ].map((args): Case => ({ args })),
  },

  // ---------- stream-coalesce.ts ----------
  'stream-coalesce.STREAM_COALESCE_MS': {
    ts: () => STREAM_COALESCE_MS,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'stream-coalesce.createChunkCoalescer': {
    ts: (a, cx) =>
      withFakeTimers((clock) => {
        const chunk = (c: Any) => revive(c) as never
        const co = createChunkCoalescer(
          (c) => cx.log('send', c),
          (js(a[0]) as number | undefined) ?? undefined,
        )
        const out: unknown[] = []
        for (const op of a[1] as Any[]) {
          if (op.op === 'push') co.push(chunk(op.chunk))
          else if (op.op === 'flush') co.flush()
          else if (op.op === 'advance') clock.advance(op.ms ?? 0)
          else throw new Error('unknown op')
          out.push({ op: op.op, timer: clock.pending() > 0 })
        }
        clock.fireAll()
        return out
      }),
    cases: (() => {
      const delta = (text: unknown, extra: Record<string, unknown> = {}) => ({
        op: 'push',
        chunk: { requestId: 'r1', type: 'delta', text, ...extra },
      })
      const reasoning = (text: unknown) => ({
        op: 'push',
        chunk: { requestId: 'r1', type: 'reasoning', text },
      })
      const other = (type: unknown, extra: Record<string, unknown> = {}) => ({
        op: 'push',
        chunk: { requestId: 'r1', type, ...extra },
      })
      const adv = (ms: number) => ({ op: 'advance', ms })
      const flush = { op: 'flush' }
      return [
        [null, [delta('a'), delta('b'), delta('c'), flush]],
        [null, [delta('a'), delta('b'), adv(31), delta('c'), adv(1)]],
        [null, [delta('a'), adv(32), delta('b'), adv(32)]],
        [null, [delta('a'), adv(10), delta('b'), adv(21), delta('c'), adv(1)]],
        [null, [delta('a'), reasoning('r'), delta('b'), flush]],
        [null, [delta('a'), other('done'), delta('b')]],
        [null, [other('done'), other('usage', { tokens: 5 })]],
        [null, [delta(5), delta('b')]],
        [null, [delta(null), delta('b')]],
        [null, [other('delta'), delta('b')]],
        [null, [{ op: 'push', chunk: { requestId: 'r1', type: 'delta' } }, delta('b')]],
        [null, [delta('a', { id: 1 }), delta('b', { id: 2, extra: true }), flush]],
        [null, [delta('', {}), delta(''), flush]],
        [null, [delta('\u00e9\u{1F600}'), delta('\u{1F600}x'), flush]],
        [null, [flush, flush]],
        [null, [adv(100)]],
        [null, [delta('a'), delta('b')]],
        [null, [other(5), other(null), other('delta ')]],
        [0, [delta('a'), delta('b'), adv(0), delta('c')]],
        [100, [delta('a'), adv(99), delta('b'), adv(1), delta('c'), adv(100)]],
        [10, [delta('a'), adv(5), reasoning('r'), adv(5), adv(5)]],
        [null, [delta('x', { 2: 'two', 10: 'ten', a: 'a', 1: 'one' }), flush]],
        [
          null,
          [
            delta('a'),
            { op: 'push', chunk: { requestId: 'r1', type: 'delta', text: 'b', type2: 1 } },
            flush,
          ],
        ],
        [null, [reasoning('a'), reasoning('b'), delta('c'), reasoning('d'), flush]],
      ].map((args): Case => ({ args }))
    })(),
  },

  // ---------- zotero-wire.ts ----------
  'zotero-wire.ZOTERO_INTEGRATION_HOST': {
    ts: () => ZOTERO_INTEGRATION_HOST,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'zotero-wire.ZOTERO_INTEGRATION_PORT': {
    ts: () => ZOTERO_INTEGRATION_PORT,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'zotero-wire.encodeZoteroFrame': {
    ts: (a) => hexOf(encodeZoteroFrame(js(a[0]) as number, str(a, 1))),
    cases: [
      [0, ''],
      [1, 'hello'],
      [1, '{"a":1}'],
      [255, 'x'],
      [256, 'x'],
      [65537, 'x'],
      [4294967295, 'x'],
      [4294967296, 'x'],
      [4294967297, 'x'],
      [-1, 'x'],
      [-4294967296, 'x'],
      [1.9, 'x'],
      [-1.9, 'x'],
      [0.5, 'x'],
      [{ $val: 'NaN' }, 'x'],
      [{ $val: 'Infinity' }, 'x'],
      [{ $val: '-Infinity' }, 'x'],
      [{ $val: '-0' }, 'x'],
      [2 ** 53, 'x'],
      [2 ** 53 + 2, 'x'],
      [1e21, 'x'],
      [2147483648, 'x'],
      [7, 'caf\u00e9 \u{1F600}'],
      [7, 'a'.repeat(300)],
      [7, '\u{FEFF}'],
    ].map((args): Case => ({ args })),
  },
  'zotero-wire.ZoteroFrameDecoder': {
    ts: (a) => {
      const decoder = new ZoteroFrameDecoder()
      return (a[0] as string[]).map((chunk) => {
        try {
          return { frames: decoder.push(bytesOf(chunk)) }
        } catch (error) {
          return { error: (error as Error).message }
        }
      })
    },
    cases: (() => {
      const f = frameHex
      const big = (len: number) => '00000001' + len.toString(16).padStart(8, '0')
      return [
        [[f(1, 'hello')]],
        [[f(1, 'a') + f(2, 'bb') + f(0, '')]],
        [[f(1, 'hello').slice(0, 10), f(1, 'hello').slice(10)]],
        [[f(1, 'hello').slice(0, 6), f(1, 'hello').slice(6, 18), f(1, 'hello').slice(18)]],
        [[f(1, 'one') + f(2, 'tw').slice(0, 14), f(2, 'tw').slice(14)]],
        [[f(1, 'one').slice(0, 14)]],
        [['']],
        [[f(4294967295, 'x')]],
        [[f(1, 'caf\u00e9 \u{1F600}')]],
        [[f(1, '\u{FEFF}bom')]],
        [['00000001' + '00000003' + 'e29c', 'ff']],
        [['00000001' + '00000002' + 'c328']],
        [['00000001' + '00000003' + 'f09f98']],
        [['00000001' + '00000001' + '80']],
        [[big(16 * 1024 * 1024)]],
        [[big(16 * 1024 * 1024 + 1)]],
        [[big(0xffffffff)]],
        [[f(1, 'ok') + big(16 * 1024 * 1024 + 1)]],
        [[big(16 * 1024 * 1024 + 1), f(1, 'ok')]],
        [[big(16 * 1024 * 1024 + 1).slice(0, 12), big(16 * 1024 * 1024 + 1).slice(12)]],
        [[f(1, '')]],
        [['0000000100'], ['000000'], ['00']],
      ].map((args): Case => ({ args }))
    })(),
  },
  'zotero-wire.ZoteroWireClient': {
    ts: (a, cx) => zoteroScenario(a[0] as Any, cx.log),
    cases: (() => {
      const ops = (...list: Any[]) => ({ args: [{ ops: list }] }) as Case
      return [
        ops(
          run('Application_getActiveDocument'),
          data(request(1, 'Document_getFields', ['a', 2])),
          data(request(2, 'Document_complete')),
          { op: 'close' },
          { op: 'active' },
        ),
        ops(run('x', { error: 'ECONNREFUSED' }), { op: 'active' }),
        ops(run('x'), run('y'), { op: 'active' }, { op: 'close' }, { op: 'active' }),
        ops(run('x'), { op: 'clientClose' }, { op: 'active' }),
        ops(run('x'), { op: 'error', message: 'socket hang up' }, { op: 'close' }),
        ops(run('x'), { op: 'error', message: 'first' }, { op: 'close' }, { op: 'close' }),
        ops(run('x'), { op: 'close' }, run('y'), { op: 'close', socket: 2 }),
        ops(run('x'), { op: 'close' }, { op: 'close' }, { op: 'active' }),
        ops(run('x'), data(frameHex(0, 'ignored'), request(0, 'Never'), request(3, 'Real'))),
        ops(run('x'), data(request(1, 'A'), request(2, 'B'), request(3, 'C')), { op: 'active' }),
        ops(run('x'), data(frameHex(1, 'not a request list')), { op: 'active' }),
        ops(run('x'), data(frameHex(1, '"just a string"'))),
        ops(run('x'), data(frameHex(1, '[1,[]]'))),
        ops(run('x'), data(frameHex(1, '["cmd"]'))),
        ops(run('x'), data(frameHex(1, '["cmd",{}]'))),
        ops(run('x'), data(frameHex(1, '["cmd",[]]'))),
        ops(
          run('x'),
          data(frameHex(1, 'null') + request(2, 'Good')),
          data(request(3, 'Good2') + frameHex(4, '{}')),
        ),
        ops(run('x'), data(request(1, 'Document_complete') + frameHex(2, '5')), { op: 'active' }),
        {
          args: [
            {
              handlers: {
                Boom: { throws: 'handler failed' },
                Value: { value: { nested: [1, 'two', null], text: 'caf\u00e9 \u{1F600}' } },
                Nothing: { value: null },
                Num: { value: { $val: 'NaN' } },
                Big: { value: 1e21 },
                Quote: { value: 'a"b\\c\nd' },
                Document_complete: { throws: 'finish failed' },
                Order: { value: { 2: 'two', 10: 'ten', a: 1, 1: 'one' } },
              },
              ops: [
                run('x'),
                data(request(1, 'Boom'), request(2, 'Value', [1, 2]), request(3, 'Nothing')),
                data(
                  request(4, 'Num'),
                  request(5, 'Big'),
                  request(6, 'Quote'),
                  request(7, 'Order'),
                ),
                data(request(8, 'Document_complete')),
              ],
            },
          ],
        } as Case,
        {
          args: [
            {
              host: 'zotero.local',
              port: 1234,
              ops: [run('Application_getActiveDocument'), { op: 'close' }],
            },
          ],
          note: 'the host and the port the client was made with',
        } as Case,
        ops(run('x'), data(request(1, 'A').slice(0, 10)), data(request(1, 'A').slice(10)), {
          op: 'active',
        }),
        ops(run('x'), data('00000001' + '01000001' + '00'), { op: 'active' }, run('y')),
        ops(run('x'), data(request(1, 'A') + '00000002' + '01000001'), { op: 'active' }),
        ops(run('x'), data('ff'.repeat(3)), data('ff'.repeat(5)), { op: 'close' }),
        ops(run('caf\u00e9 "q" \u{1F600}'), { op: 'clientClose' }, { op: 'clientClose' }),
        ops(
          run('x'),
          { op: 'clientClose' },
          run('y'),
          data(request(1, 'Late')),
          { op: 'close', socket: 1 },
          { op: 'active' },
        ),
        ops(run('x', { error: 'refused' }), run('y'), data(request(1, 'Y')), { op: 'close' }),
        ops(run('x'), { op: 'error', message: 'e1' }, { op: 'clientClose' }, { op: 'active' }),
      ]
    })(),
  },

  // ================= apps/diagram/src/main =================

  // ---------- drawio-protocol.ts ----------
  'drawio-protocol.DRAWIO_SCHEME_PRIVILEGE': {
    ts: () => DRAWIO_SCHEME_PRIVILEGE,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'drawio-protocol.drawioCsp': {
    ts: (a) => drawioCsp(a[0] as string[]),
    cases: [
      [[]],
      [['genoffice-app://diagram']],
      [['genoffice-app://diagram', 'http://localhost:5173']],
      [['']],
      [['\u00e9']],
    ].map((args): Case => ({ args })),
  },
  'drawio-protocol.PRINT_PAGE_CSP': {
    ts: () => PRINT_PAGE_CSP,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'drawio-protocol.contentTypeOf': {
    ts: (a) => contentTypeOf(str(a, 0)),
    cases: [
      'index.html',
      'a.htm',
      'a.js',
      'a.mjs',
      'a.css',
      'a.json',
      'a.xml',
      'a.txt',
      'a.svg',
      'a.png',
      'a.gif',
      'a.jpg',
      'a.jpeg',
      'a.webp',
      'a.ico',
      'a.woff',
      'a.woff2',
      'a.ttf',
      'a.otf',
      'a.eot',
      'a.wasm',
      'a.map',
      'a.INDEX',
      'a.HTML',
      'a.JpG',
      'a.xm\u004C',
      'a.\u212Aml',
      'a.\u0131co',
      'a.exe',
      'a',
      '',
      '.',
      'a.',
      '.html',
      '.htaccess',
      'dir.html/file',
      'dir/a.b/c',
      'dir/a.png/',
      'a\\b.png',
      '/a/b/c.js',
      'a.tar.gz',
      'a.png.exe',
      'a.png\n',
      'a\u00e9.png',
      '\u{1F600}.svg',
      '/.js',
    ].map((path): Case => ({ args: [path] })),
  },
  'drawio-protocol.resolveDrawioRequest': {
    ts: (a) => resolveDrawioRequest(str(a, 0), str(a, 1)),
    cases: (() => {
      const root = '$DIR/bundle'
      const h = 'drawio-app://editor'
      const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
      return [
        `${h}/index.html`,
        `${h}/js/app.min.js`,
        `${h}/a/b/c.png?x=1#y`,
        `${h}/a%20b.png`,
        `${h}/caf%C3%A9.png`,
        `${h}/%F0%9F%98%80.png`,
        `${h}/\u00e9.png`,
        `${h}/\u{1F600}.png`,
        `${h}/a/./b`,
        `${h}/a/../b`,
        `${h}/../etc/passwd`,
        `${h}/a/../../etc/passwd`,
        `${h}/%2e%2e/etc/passwd`,
        `${h}/.%2e/etc/passwd`,
        `${h}/%252e%252e/x`,
        `${h}/a%2fb`,
        `${h}/a%2Fb`,
        `${h}/a%5cb`,
        `${h}/a%5Cb`,
        `${h}/a%00b`,
        `${h}/a%E0%A4%A`,
        `${h}/a%`,
        `${h}/%ff`,
        `${h}/a\\b`,
        `${h}/${'a'.repeat(4096)}`,
        `${h}/${'a'.repeat(4095)}`,
        `${h}/${'\u{1F600}'.repeat(2048)}`,
        `${h}/${'\u{1F600}'.repeat(2047)}`,
        `${h}/`,
        `${h}`,
        `${h}//x`,
        `${h}///x/y`,
        `${h}/dir/`,
        `${h}/.`,
        `${h}/..`,
        `${h}/__ieum/bridge.js`,
        `${h}/__ieum/bridge.js/`,
        `${h}/__ieum/BRIDGE.JS`,
        `${h}/__ieum/other.js`,
        `${h}/__ieum/`,
        `${h}/__ieum`,
        `${h}/__ieum/print/${token}`,
        `${h}/__ieum/print/${token.toUpperCase()}`,
        `${h}/__ieum/print/${token}0`,
        `${h}/__ieum/print/${token.slice(1)}`,
        `${h}/__ieum/print/`,
        `${h}/__ieum/print/${token}/x`,
        `${h}/__ieum/print/${token}\n`,
        `${h}/__ieum/print/${'g'.repeat(32)}`,
        `${h}/__ieum/%70rint/${token}`,
        `${h}/%5F%5Fieum/bridge.js`,
        `${h}:8080/index.html`,
        `${h}:80/index.html`,
        'drawio-app://EDITOR/index.html',
        'DRAWIO-APP://editor/index.html',
        'drawio-app://editor./index.html',
        'drawio-app://user:pw@editor/index.html',
        'drawio-app://other/index.html',
        'drawio-app:///index.html',
        'drawio-app:index.html',
        'drawio-app:/index.html',
        'https://editor/index.html',
        'file:///index.html',
        'genoffice-app://editor/index.html',
        '/index.html',
        'index.html',
        '',
        'not a url',
        ' drawio-app://editor/index.html ',
        '\tdrawio-app://editor/in\tdex.html\n',
        `${h}/a b`,
        `${h}/a?b/c`,
        `${h}/a#b/c`,
        `${h}/~user/x`,
        `${h}/;x`,
        `${h}/ \u00a0`,
      ]
        .map((url): Case => ({ args: [root, url] }))
        .concat([
          { args: ['/', `${h}/index.html`], note: 'a root of "/" never holds "//"' },
          { args: ['/', `${h}/etc/passwd`] },
          { args: ['$DIR/bundle/', `${h}/js/app.js`], note: 'a root with a trailing separator' },
        ])
    })(),
  },
  'drawio-protocol.injectBridge': {
    ts: (a) => injectBridge(str(a, 0)),
    cases: [
      '<html><head><title>x</title></head><body></body></html>',
      '<html><head></head></html>',
      '<head>',
      '<HEAD>x',
      '<Head lang="en">x</Head>',
      '<head\tdata-a="1">',
      '<head\n>',
      '<head data-x=">">',
      '<head  >',
      '<headx>',
      '<header>',
      '<head',
      '<head/>',
      '<html><body></body></html>',
      '',
      'no tags',
      '<!-- <head> --><head>',
      '<head><head>',
      '<html>\u00e9\u{1F600}<head>\u00e9</head>',
      '<\u{1F600}><head>',
      '\u{FEFF}<head\u{FEFF}>',
      '<head\u00a0a>',
      '<head\u2028a>',
      '<head\u0085a>',
    ].map((html): Case => ({ args: [html] })),
  },
  'drawio-protocol.responseHeaders': {
    ts: (a) => responseHeaders(str(a, 0), str(a, 1)),
    cases: [
      ['text/html; charset=utf-8', "default-src 'none'"],
      ['image/png', ''],
      ['', 'x'],
      ['application/json; charset=utf-8', 'a; b; c'],
      ['t/\u00e9', '\u{1F600}'],
    ].map((args): Case => ({ args })),
  },

  // ---------- export-paths.ts ----------
  'export-paths.pageFilePaths': {
    ts: (a) =>
      pageFilePaths(
        str(a, 0),
        str(a, 1) as 'png' | 'svg',
        revive(a[2]) as number[],
        a[3] as boolean,
      ),
    cases: [
      ['/out/diagram.png', 'png', [1], false],
      ['/out/diagram.png', 'png', [1], true],
      ['/out/diagram.png', 'png', [1, 2, 3], false],
      ['/out/diagram.png', 'png', [1, 2, 3], true],
      ['/out/diagram', 'png', [1, 2], false],
      ['/out/diagram.svg', 'png', [1, 2], false],
      ['/out/diagram.PNG', 'png', [2, 3], false],
      ['/out/diagram.Svg', 'svg', [1, 2], true],
      ['/out/diagram.png.png', 'png', [1, 2], false],
      ['/out/.png', 'png', [1, 2], false],
      ['/out/png', 'png', [1, 2], false],
      ['/out/a.b.png', 'png', [1, 2], false],
      ['/out/', 'png', [1, 2], false],
      ['', 'png', [1, 2], false],
      ['diagram.png', 'png', [1, 2], false],
      ['/out/diagram.png', 'png', [], false],
      ['/out/diagram.png', 'png', [], true],
      ['/out/a:b*c?.png', 'png', [1, 2], false],
      ['/out/' + 'x'.repeat(100) + '.png', 'png', [1, 2], false],
      ['/out/' + 'x'.repeat(79) + ' y.png', 'png', [1, 2], false],
      ['/out/' + ' '.repeat(10) + '.png', 'png', [1, 2], false],
      ['/out/\u00a0\u00a0.png', 'png', [1, 2], false],
      ['/out/ spaced name .png', 'png', [1, 2], false],
      ['/out/caf\u00e9 \u{1F600}.png', 'png', [1, 2], false],
      ['/out/' + '\u{1F600}'.repeat(39) + 'ab.png', 'png', [1, 2], false],
      ['/out/diagram.png', 'png', [1.5, 2], false],
      ['/out/diagram.png', 'png', [0, -1, 10], false],
      ['/out/diagram.png', 'png', [{ $val: 'NaN' }, 2], false],
      ['/out/diagram.png', 'png', [1e21, 2], false],
      ['/out/diagram.png', 'png', [{ $val: '-0' }, 2], false],
      ['/out/d/../e.svg', 'svg', [4, 5], false],
      ['/out//e.svg', 'svg', [4, 5], false],
      ['/out/a\\b.png', 'png', [1, 2], false],
      ['/out/\\.png', 'png', [1, 2], true],
    ].map((args): Case => ({ args })),
  },

  // ---------- network-guard.ts ----------
  'network-guard.DIAGRAM_PARTITION': {
    ts: () => DIAGRAM_PARTITION,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'network-guard.devServerOrigins': {
    ts: (a) =>
      devServerOrigins(
        (a[0] as (string | null)[]).map((x) => x ?? undefined),
        a[1] as boolean,
      ),
    cases: [
      [['http://localhost:5173'], false],
      [['http://localhost:5173'], true],
      [['http://localhost:5173', 'http://127.0.0.1:5173'], false],
      [['http://localhost:5173/a?b#c', 'http://localhost:5173/other'], false],
      [['https://localhost'], false],
      [['https://localhost:443', 'https://localhost'], false],
      [['http://localhost:80', 'http://localhost'], false],
      [['http://[::1]:3000'], false],
      [['http://[::1]'], false],
      [['http://LOCALHOST:5173'], false],
      [['http://127.0.0.1.:5173'], false],
      [['http://127.1:5173'], false],
      [['http://0.0.0.0:5173'], false],
      [['http://example.com'], false],
      [['https://localhost.example.com'], false],
      [['http://user:pw@localhost:5173'], false],
      [['ftp://localhost'], false],
      [['ws://localhost:5173'], false],
      [['file:///x'], false],
      [['localhost:5173'], false],
      [['not a url'], false],
      [[null, '', 'http://localhost:1'], false],
      [[null], false],
      [[], false],
      [['http://localhost:99999'], false],
      [['http://localhost:0'], false],
      [['  http://localhost:5173  '], false],
      [['http://localhost\u{1F600}:5173'], false],
    ].map((args): Case => ({ args })),
  },
  'network-guard.isAllowedDiagramRequest': {
    ts: (a) => isAllowedDiagramRequest(str(a, 0), (js(a[1]) as string[] | undefined) ?? undefined),
    cases: (() => {
      const dev = ['http://localhost:5173']
      return [
        ['drawio-app://editor/index.html', null],
        ['DRAWIO-APP://editor/x', null],
        ['genoffice-app://docs/index.html', null],
        ['data:text/plain,hi', null],
        ['blob:genoffice-app://docs/abc', null],
        ['blob:https://example.com/abc', null],
        ['https://example.com/a', null],
        ['http://example.com/a', null],
        ['file:///etc/passwd', null],
        ['ftp://example.com', null],
        ['javascript:alert(1)', null],
        ['about:blank', null],
        ['chrome://gpu', null],
        ['', null],
        ['not a url', null],
        ['//example.com', null],
        ['http://localhost:5173/', null],
        ['http://localhost:5173/', dev],
        ['http://localhost:5173/a/b?c#d', dev],
        ['http://localhost:5174/', dev],
        ['http://localhost/', dev],
        ['https://localhost:5173/', dev],
        ['http://LOCALHOST:5173/', dev],
        ['http://127.0.0.1:5173/', dev],
        ['http://localhost:5173/', []],
        ['ws://localhost:5173/', dev],
        ['wss://localhost:5173/', dev],
        ['ws://localhost:5173/', []],
        ['ws://localhost:5173/', ['https://localhost:5173']],
        ['wss://localhost:5173/', ['https://localhost:5173']],
        ['ws://localhost:80/', ['http://localhost']],
        ['wss://localhost:443/', ['https://localhost']],
        ['ws://localhost:8080/', ['http://localhost:8080']],
        ['ws://example.com/', dev],
        ['http://example.com/', ['null']],
        ['ftp://example.com/', ['null']],
        ['http://a/', ['http://a', 'http://b']],
        ['http://b/', ['http://a', 'http://b']],
        ['http://[::1]:3000/', ['http://[::1]:3000']],
        ['ws://[::1]:3000/', ['http://[::1]:3000']],
        ['http://\u00e9.example/', ['http://xn--9ca.example']],
      ].map((args): Case => ({ args }))
    })(),
  },
  'network-guard.windowOpenAction': {
    ts: () => windowOpenAction(),
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'network-guard.isAllowedNavigation': {
    ts: (a) =>
      isAllowedNavigation({ url: str(a, 0), isMainFrame: a[1] as boolean, currentUrl: str(a, 2) }),
    cases: [
      ['genoffice-app://diagram/index.html', true, 'genoffice-app://diagram/index.html'],
      ['genoffice-app://diagram/index.html#x', true, 'genoffice-app://diagram/index.html'],
      ['https://example.com/', true, 'genoffice-app://diagram/index.html'],
      ['', true, ''],
      ['drawio-app://editor/index.html', false, 'genoffice-app://diagram/index.html'],
      ['drawio-app://editor/index.html?x=1', false, 'x'],
      ['drawio-app://editor/index.html#x', false, 'x'],
      ['DRAWIO-APP://editor/index.html', false, 'x'],
      ['drawio-app://EDITOR/index.html', false, 'x'],
      ['drawio-app://editor:8080/index.html', false, 'x'],
      ['drawio-app://editor/index.htm', false, 'x'],
      ['drawio-app://editor/', false, 'x'],
      ['drawio-app://editor/a/../index.html', false, 'x'],
      ['drawio-app://editor//index.html', false, 'x'],
      ['drawio-app://editor/INDEX.html', false, 'x'],
      ['drawio-app://other/index.html', false, 'x'],
      ['https://editor/index.html', false, 'x'],
      ['genoffice-app://diagram/index.html', false, 'x'],
      ['about:blank', false, 'x'],
      ['not a url', false, 'x'],
      ['', false, 'x'],
    ].map((args): Case => ({ args })),
  },
  'network-guard.REFUSED_ADDRESSES_KEPT': {
    ts: () => REFUSED_ADDRESSES_KEPT,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'network-guard.newRequestLog': {
    ts: () => {
      const log = newRequestLog()
      return { ...log, schemes: [...log.schemes] }
    },
    cases: [{ args: [] }],
    single: 'a new log is always empty',
  },
  'network-guard.screenRequest': {
    ts: (a) => {
      const log = newRequestLog()
      const verdicts = (a[0] as string[]).map((url) => screenRequest(log, url, a[1] as string[]))
      return { verdicts, log: { ...log, schemes: [...log.schemes] } }
    },
    cases: (() => {
      const refused = Array.from({ length: 105 }, (_, i) => `https://example.com/${i}`)
      return [
        [[], []],
        [['drawio-app://editor/index.html'], []],
        [['https://example.com/a?secret=1'], []],
        [['https://example.com/a?secret=1', 'https://example.com/a?secret=2'], []],
        [
          [
            'drawio-app://editor/a',
            'genoffice-app://docs/a',
            'data:text/plain,a',
            'blob:genoffice-app://docs/x',
            'drawio-app://editor/b',
            'data:text/plain,b',
          ],
          [],
        ],
        [['https://a/1', 'drawio-app://editor/x', 'https://a/2', 'not a url', ''], []],
        [
          ['http://localhost:5173/', 'ws://localhost:5173/', 'http://localhost:5173/x'],
          ['http://localhost:5173'],
        ],
        [['ws://localhost:5173/', 'wss://localhost:5173/'], ['http://localhost:5173']],
        [refused, []],
        [refused.slice(0, 100), []],
        [refused.slice(0, 101), []],
        [['https://example.com/' + 'x'.repeat(300)], []],
        [['https://example.com/' + 'x'.repeat(180) + '?' + 'y'.repeat(300)], []],
        [['x'.repeat(200), 'x'.repeat(201), 'x'.repeat(199)], []],
        [['\u{1F600}'.repeat(100), '\u{1F600}'.repeat(101)], []],
        [['caf\u00e9/' + 'z'.repeat(250)], []],
        [['?only-a-query', '?', 'a?b?c'], []],
        [['not a url?x'], []],
      ].map((args): Case => ({ args }))
    })(),
  },

  // ---------- print-document.ts ----------
  'diagram/print-document.isPrintPage': {
    ts: (a) => isPrintPage(js(a[0])),
    cases: [
      PAGE(),
      PAGE({ svg: '  <svg>' }),
      PAGE({ svg: '\n\t<SVG xmlns="x">' }),
      PAGE({ svg: '<svg' }),
      PAGE({ svg: '<svg>' }),
      PAGE({ svg: '<svgx>' }),
      PAGE({ svg: '<svg\n>' }),
      PAGE({ svg: '\u{FEFF}<svg>' }),
      PAGE({ svg: '\u00a0<svg>' }),
      PAGE({ svg: '\u0085<svg>' }),
      PAGE({ svg: '\u2028<svg>' }),
      PAGE({ svg: '<?xml version="1.0"?><svg>' }),
      PAGE({ svg: '<div><svg>' }),
      PAGE({ svg: '' }),
      PAGE({ svg: 5 }),
      PAGE({ svg: null }),
      PAGE({ width: '300' }),
      PAGE({ height: null }),
      PAGE({ pageWidth: undefined }),
      PAGE({ pageHeight: { $val: 'NaN' } }),
      PAGE({ width: { $val: 'Infinity' } }),
      PAGE({ width: 0, height: -1 }),
      { svg: '<svg>', width: 1, height: 1, pageWidth: 1 },
      { svg: '<svg>' },
      {},
      [],
      [PAGE()],
      null,
      { $val: 'null' },
      'text',
      7,
      true,
    ].map((v): Case => ({ args: [v] })),
  },
  'diagram/print-document.inertSvg': {
    ts: (a) => inertSvg(str(a, 0)),
    cases: [
      '<svg><rect/></svg>',
      '<svg><script>alert(1)</script><rect/></svg>',
      '<svg><SCRIPT type="x">a</SCRIPT ><rect/></svg>',
      '<svg><script>a</script><script>b</script></svg>',
      '<svg><script/><rect/></svg>',
      '<svg><script src="x"/><rect/></svg>',
      '<svg><script>a\nb</script>after</svg>',
      '<svg><script>never closed</svg>',
      '<svg><scriptx>keep</scriptx></svg>',
      '<svg><script-x>x</script>y</svg>',
      '<svg><script\n>x</script\n></svg>',
      '<svg><script>x</script  >y</svg>',
      '<svg><script>x</scrip>y</script></svg>',
      '<svg onload="alert(1)"><rect/></svg>',
      "<svg onload='alert(1)'><rect/></svg>",
      '<svg ONLOAD="x" onClick = "y"><rect/></svg>',
      '<svg onload=alert(1)><rect/></svg>',
      '<svg onload=""><rect/></svg>',
      '<svg\nonload="x"\n onclick\t=\t\'y\'><rect/></svg>',
      '<svg data-onload="x"><rect/></svg>',
      '<svg on="x"><rect/></svg>',
      '<svg on1="x"><rect/></svg>',
      '<svg onab-c="x"><rect/></svg>',
      '<svg onclic\u212A="x"><rect/></svg>',
      '<svg onclic\u017F="x"><rect/></svg>',
      '<svg on\u0131="x"><rect/></svg>',
      '<svg\u00a0onload="x"><rect/></svg>',
      '<svg\u{FEFF}onload="x"><rect/></svg>',
      '<svg onload="a\'b" onclick=\'c"d\'><rect/></svg>',
      '<svg onload="a\nb"><rect/></svg>',
      '<text onclick="x">caf\u00e9 \u{1F600}</text>',
      '<svg><title>onclick="x"</title></svg>',
      '<svg> onload="x"</svg>',
      '',
      '<script>x</script>',
    ].map((svg): Case => ({ args: [svg] })),
  },
  'diagram/print-document.buildPrintHtml': {
    ts: (a) => buildPrintHtml(revive(a[0]) as never, (js(a[1]) as string | undefined) ?? undefined),
    cases: [
      [[PAGE()], null],
      [[PAGE()], 'My diagram'],
      [[PAGE(), PAGE({ width: 100, height: 100, pageWidth: 400, pageHeight: 300 })], 'Two'],
      [[], null],
      [[], 'No pages'],
      [[PAGE({ width: { $val: 'NaN' }, height: 0 })], null],
      [[PAGE({ pageWidth: 0, pageHeight: -5 })], null],
      [[PAGE({ pageWidth: 100001, pageHeight: 100000 })], null],
      [[PAGE({ pageWidth: { $val: 'Infinity' }, width: { $val: '-Infinity' } })], null],
      [
        [PAGE({ pageWidth: { $val: 'NaN' }, pageHeight: { $val: 'NaN' }, width: 50, height: 60 })],
        null,
      ],
      [[PAGE({ width: 100.555, height: 200.5, pageWidth: 827.5, pageHeight: 1169.25 })], null],
      [[PAGE({ width: 0.004, height: 0.005, pageWidth: 0.006, pageHeight: 1e-7 })], null],
      [[PAGE({ width: 1.005, height: 1.015, pageWidth: 3.145, pageHeight: 2.675 })], null],
      [[PAGE({ width: 99999.99, height: 100000, pageWidth: 100000, pageHeight: 99999.995 })], null],
      [[PAGE({ svg: '<svg onclick="x"><script>a</script></svg>' })], null],
      [[PAGE({ svg: '<svg>caf\u00e9 \u{1F600}</svg>' })], '<b>"T&C"</b>'],
      [[PAGE()], 'a'.repeat(200)],
      [[PAGE()], 'a'.repeat(201)],
      [[PAGE()], 'a'.repeat(199) + '<'],
      [[PAGE()], 'a'.repeat(190) + '\u{1F600}'.repeat(4)],
      [[PAGE()], '\u{1F600}'.repeat(100)],
      [[PAGE()], ''],
      [[PAGE()], '&amp; &lt; &gt; &quot; \' < > " &'],
      [[PAGE(), PAGE(), PAGE()], 'Three'],
    ].map((args): Case => ({ args })),
  },
  'diagram/print-document.isPrintCancel': {
    ts: (a) => isPrintCancel(js(a[0])),
    cases: [
      'cancelled',
      'canceled',
      'Print job canceled',
      'CANCELLED',
      'Cancel',
      'xcancelx',
      'failed',
      '',
      'cance',
      'ca ncel',
      'cance\u212A',
      'c\u0061ncel',
      'CANCEL\u{1F600}',
      'cancel\n',
      '\u00e9cancel',
      'canc\u0065l',
      null,
      { $val: 'null' },
      5,
      true,
      ['cancel'],
      { reason: 'cancel' },
    ].map((v): Case => ({ args: [v] })),
  },
  ...Object.fromEntries(
    ['holdPrintDocument', 'takePrintDocument', 'dropPrintDocument'].map(
      (name): [string, FnSpec] => [
        `diagram/print-document.${name}`,
        {
          ts: (a) => runPrintDocuments(a[0] as Any),
          cases: printDocumentCases(name),
        },
      ],
    ),
  ),

  // ================= apps/mindmap/src/main =================

  'mindmap/atomic-write.atomicWriteFile': {
    ts: (a) => masked(() => mindmapAtomicWriteFile(str(a, 0), Buffer.from(str(a, 1)))),
    cases: atomicCases,
  },
  'mindmap/save-as-formats.saveAsFilters': {
    ts: (a, cx) =>
      mindmapSaveAsFilters(a[0] as boolean, (key) => {
        cx.log('label', key)
        return `L:${key}`
      }),
    cases: [[false], [true]].map((args): Case => ({ args })),
  },
  'mindmap/save-as-formats.saveAsDefaultPath': {
    ts: (a) => mindmapSaveAsDefaultPath(str(a, 0), a[1] as boolean),
    cases: [
      ['/d/map.xmind', true],
      ['/d/map.xmind', false],
      ['/d/MAP.XMIND', true],
      ['/d/map.Xmind', true],
      ['/d/map.png', true],
      ['/d/map.xmind.xmind', true],
      ['/d/map.xmind ', true],
      ['/d/map.xmind\n', true],
      ['map', true],
      ['', true],
      ['.xmind', true],
      ['/d/\u00e9.xmind', true],
      ['/d/\u{1F600}.xmind', true],
      ['/d/a.xmind/b', true],
      ['/d/map.\u212Amind', true],
    ].map((args): Case => ({ args })),
  },
  'mindmap/save-as-formats.saveAsTarget': {
    ts: (a) => mindmapSaveAsTarget(str(a, 0), a[1] as boolean),
    cases: [
      ['/d/a.xmind', true],
      ['/d/a.xmind', false],
      ['/d/a.XMIND', true],
      ['/d/a.png', true],
      ['/d/a.png', false],
      ['/d/a.PNG', true],
      ['/d/a.svg', true],
      ['/d/a.SVG', true],
      ['/d/a.pdf', true],
      ['/d/a.md', true],
      ['/d/a.MD', true],
      ['/d/a.markdown', true],
      ['/d/a.txt', true],
      ['/d/a.txt', false],
      ['/d/a', true],
      ['/d/a', false],
      ['/d.png/a', true],
      ['C:\\d.png\\a', true],
      ['/d/a.', true],
      ['/d/.png', true],
      ['/d/a.png.bak', true],
      ['/d/a.xmind.png', true],
      ['/d/a.png.xmind', true],
      ['/d/a.p\u00f1g', true],
      ['/d/\u{1F600}.svg', true],
      ['/d/a.png\n', true],
      ['/d/a.xmind\n', false],
      ['', true],
      ['', false],
      ['/d/a.s\u017Fg', true],
      ['/d/a.\u212Aml', true],
    ].map((args): Case => ({ args })),
  },
}
