import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EngineError, engineCall, engineReady, initEngineSync } from '../src/index'

const WASM = resolve(
  __dirname,
  '../../../crates/target/wasm32-wasip1/release/office_wasm.wasm',
)

describe.skipIf(!existsSync(WASM))('engine-wasm', () => {
  it('answers a command after a synchronous init, and throws an engine failure', () => {
    initEngineSync(readFileSync(WASM))
    expect(engineReady()).toBe(true)
    const { header } = engineCall<{ results: Array<Array<{ value?: unknown }>> }>({
      cmd: 'props',
      inputs: [{ xml: '', calls: [{ fn: 'pptxLeaves.crc32.crc32', args: { bytes: [97] } }] }],
    })
    expect(header.results[0]![0]).toHaveProperty('value')
    expect(() => engineCall({ cmd: 'noSuchCommand' })).toThrow(EngineError)
  })
})
