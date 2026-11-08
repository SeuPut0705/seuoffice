import { describe, expect, it } from 'vitest'
import { CommandRegistry } from '../src/registry'
import { CliError, EXIT } from '../src/result'
import { wasmAvailability, wasmMemoryFailure } from '../src/wasm'
import { run } from './helpers'

const ABORT =
  'Aborted(RangeError: WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance)'

describe('WebAssembly out of memory', () => {
  it('turns an engine abort into a resource_limit answer', () => {
    const error = wasmMemoryFailure(new Error(ABORT))
    expect(error).toBeInstanceOf(CliError)
    expect(error?.code).toBe(EXIT.conversion)
    expect(error?.reason).toBe('resource_limit')
    expect(error?.message).toContain('WebAssembly')
    expect(error?.suggestion).toContain('ulimit -v')
    expect(error?.detail).toMatchObject({ reason: 'virtual_memory' })
  })

  it('also catches V8’s own instantiation message', () => {
    const error = wasmMemoryFailure(
      new RangeError(
        'WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance',
      ),
    )
    expect(error?.reason).toBe('resource_limit')
  })

  it('leaves other failures alone', () => {
    expect(wasmMemoryFailure(new Error('file not found'))).toBeNull()
    expect(wasmMemoryFailure('no pdfium.wasm (set GENOFFICE_PDFIUM_WASM)')).toBeNull()
  })

  it('does not re-wrap an answer that is already resource_limit', () => {
    const already = new CliError(EXIT.conversion, ABORT, undefined, { reason: 'resource_limit' })
    expect(wasmMemoryFailure(already)).toBeNull()
  })

  it('answers the envelope from a command that hits the limit', async () => {
    const registry = new CommandRegistry().register({
      name: 'boom',
      summary: 'throws the WebAssembly abort',
      usage: 'boom',
      async run() {
        throw new Error(ABORT)
      },
    })
    const result = await run(['boom', '--json'], { registry })
    expect(result.code).toBe(EXIT.conversion)
    expect(result.json()).toMatchObject({
      status: 'error',
      command: 'boom',
      code: EXIT.conversion,
      error: 'resource_limit',
    })
    expect(result.json().suggestion).toContain('ulimit -v')
  })
})

describe('capabilities and WebAssembly', () => {
  it('reports whether the engines can allocate their memory', async () => {
    const result = await run(['capabilities', '--json'])
    expect(result.code).toBe(0)
    expect(typeof result.json().detail.wasm.available).toBe('boolean')
    expect(wasmAvailability().available).toBe(result.json().detail.wasm.available)
  })
})
