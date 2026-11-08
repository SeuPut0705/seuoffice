// Runs the xlsx engine (native/xlsx-wasm, wasm32-wasip1) off the main thread.
// Workbook bytes land in the preopened /work directory; requests are the sidecar's JSON protocol.
import wasmUrl from './generated/xlsx-wasm.wasm?url'
import { ConsoleStdout, File, OpenFile, PreopenDirectory, WASI } from '@seuoffice/web-platform/wasi'

export type WorkerRequest =
  | { id: number; kind: 'put'; name: string; bytes: ArrayBuffer }
  | { id: number; kind: 'call'; request: unknown }

export type WorkerReply =
  { id: number; ok: true; result?: unknown } | { id: number; ok: false; error: string }

interface EngineExports {
  memory: WebAssembly.Memory
  seu_alloc(length: number): number
  seu_free(pointer: number, length: number): void
  seu_call(pointer: number, length: number): bigint
}

const scope = self as unknown as {
  postMessage(message: WorkerReply): void
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void
}

const work = new Map<string, File>()
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

scope.addEventListener('message', (event) => {
  const message = event.data
  const { id } = message
  if (message.kind === 'put') {
    work.set(message.name, new File(new Uint8Array(message.bytes)))
    scope.postMessage({ id, ok: true })
    return
  }
  call(message.request).then(
    (result) => scope.postMessage({ id, ok: true, result }),
    (error: unknown) =>
      scope.postMessage({
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
  )
})
