// Runs the xlsx engine (native/xlsx-wasm, wasm32-wasip1) off the main thread.
// Workbook bytes land in the preopened /work directory; requests are the sidecar's JSON protocol.
import wasmUrl from './generated/xlsx-wasm.wasm?url'
import { ConsoleStdout, File, OpenFile, PreopenDirectory, WASI } from '@seuoffice/web-platform/wasi'
import type { RedactionPartRead } from '../main/workbook-redactions'
import type { ResolvedWorkbookSave } from '../main/workbook-save-resolve'

const PROTOCOL_VERSION = 1

export type WorkerRequest =
  | { id: number; kind: 'put'; name: string; bytes: ArrayBuffer }
  | { id: number; kind: 'drop'; name: string }
  | { id: number; kind: 'call'; request: unknown }
  | { id: number; kind: 'save'; source: string; target: string; save: ResolvedWorkbookSave }
  | { id: number; kind: 'redactions'; source: string }

export type WorkerReply =
  { id: number; ok: true; result?: unknown } | { id: number; ok: false; error: string }

/** The result of a `save` request; the bytes are the saved package */
export interface WorkerSaveResult {
  bytes: Uint8Array
  touchedEntries: readonly string[]
}

interface EngineExports {
  memory: WebAssembly.Memory
  seu_alloc(length: number): number
  seu_free(pointer: number, length: number): void
  seu_call(pointer: number, length: number): bigint
}

interface SidecarResponse {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

const scope = self as unknown as {
  postMessage(message: WorkerReply, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void
}

const work = new Map<string, File>()
const scratch = new Map<string, File>()
const encoder = new TextEncoder()
const decoder = new TextDecoder()

async function compileEngine(): Promise<WebAssembly.Module> {
  try {
    return await WebAssembly.compileStreaming(fetch(wasmUrl))
  } catch {
    // a static host that serves .wasm without the application/wasm type rejects streaming compilation
    const response = await fetch(wasmUrl)
    return WebAssembly.compile(await response.arrayBuffer())
  }
}

async function startEngine(): Promise<EngineExports> {
  const wasi = new WASI(
    [],
    ['TMPDIR=/tmp'],
    [
      new OpenFile(new File(new Uint8Array(0))),
      ConsoleStdout.lineBuffered((line) => console.log(line)),
      ConsoleStdout.lineBuffered((line) => console.warn(line)),
      new PreopenDirectory('/work', work),
      new PreopenDirectory('/tmp', new Map()),
      new PreopenDirectory('/save', scratch),
    ],
    { debug: false },
  )
  const instance = await WebAssembly.instantiate(await compileEngine(), {
    wasi_snapshot_preview1: wasi.wasiImport,
  })
  wasi.initialize(instance as Parameters<WASI['initialize']>[0])
  return instance.exports as unknown as EngineExports
}

const engine = startEngine()

async function call(request: unknown): Promise<unknown> {
  const exports = await engine
  const body = encoder.encode(JSON.stringify(request))
  const input = exports.seu_alloc(body.length)
  new Uint8Array(exports.memory.buffer, input, body.length).set(body)
  const packed = exports.seu_call(input, body.length)
  exports.seu_free(input, body.length)
  const pointer = Number(packed >> 32n)
  const length = Number(packed & 0xffffffffn)
  // memory.buffer is re-read after the call: the engine may have grown it
  const text = decoder.decode(new Uint8Array(exports.memory.buffer, pointer, length))
  exports.seu_free(pointer, length)
  return JSON.parse(text)
}

let nextRequestId = 0

/** One protocol command from inside the worker; rejects with the engine's message */
async function command(name: string, fields: Record<string, unknown>): Promise<unknown> {
  const response = (await call({
    version: PROTOCOL_VERSION,
    requestId: `worker-${nextRequestId++}`,
    command: name,
    ...fields,
  })) as SidecarResponse
  if (!response.ok) throw new Error(response.error?.message ?? `xlsx engine: ${name} failed`)
  return response.result
}

async function save(message: Extract<WorkerRequest, { kind: 'save' }>): Promise<WorkerSaveResult> {
  // the planner and its OOXML code load on the first save, not with the viewer
  const { saveWorkbook } = await import('./xlsx-save')
  return saveWorkbook({ command, work, scratch }, message.source, message.target, message.save)
}

async function redactions(
  message: Extract<WorkerRequest, { kind: 'redactions' }>,
): Promise<RedactionPartRead> {
  // with the planner, which the viewer does not load (see save)
  const { readRedactions } = await import('./xlsx-save')
  return readRedactions({ command, work, scratch }, message.source)
}

function fail(id: number, error: unknown): void {
  scope.postMessage({
    id,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  })
}

scope.addEventListener('message', (event) => {
  const message = event.data
  const { id } = message
  if (message.kind === 'put') {
    work.set(message.name, new File(new Uint8Array(message.bytes)))
    scope.postMessage({ id, ok: true })
    return
  }
  if (message.kind === 'drop') {
    work.delete(message.name)
    scope.postMessage({ id, ok: true })
    return
  }
  if (message.kind === 'save') {
    save(message).then(
      (result) => scope.postMessage({ id, ok: true, result }, [result.bytes.buffer]),
      (error: unknown) => fail(id, error),
    )
    return
  }
  if (message.kind === 'redactions') {
    redactions(message).then(
      (result) => scope.postMessage({ id, ok: true, result }),
      (error: unknown) => fail(id, error),
    )
    return
  }
  call(message.request).then(
    (result) => scope.postMessage({ id, ok: true, result }),
    (error: unknown) => fail(id, error),
  )
})
