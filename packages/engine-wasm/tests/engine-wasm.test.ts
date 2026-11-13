import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EngineError,
  engineCall,
  engineInvoke,
  engineReady,
  initEngineSync,
  revive,
} from '../src/index'

const WASM = resolve(__dirname, '../../../crates/target/wasm32-wasip1/release/office_wasm.wasm')

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

  // an argument the engine reads reaches the function: the call fails on its
  // name, after the request was read
  const reachesTheTable = (args: unknown[]): void => {
    expect(() => engineInvoke('noSuchFunction', args)).toThrow('no function noSuchFunction')
  }

  const nested = (depth: number): unknown => {
    let tree: unknown = { leaf: true }
    for (let i = 0; i < depth; i++) tree = { children: [tree] }
    return tree
  }

  // the request without the binding's encoding, which recurses on the JS stack
  const invokeRaw = (tree: unknown): unknown =>
    engineCall({ cmd: 'invoke', fn: 'noSuchFunction', args: [tree], nowMs: 0 })

  it('reads an argument nested as deep as the TypeScript builds one', () => {
    reachesTheTable([nested(400)])
    expect(() => invokeRaw(nested(500))).toThrow('no function noSuchFunction')
  })

  it('refuses a deeper argument as a stack overflow and keeps answering', () => {
    expect(() => invokeRaw(nested(1_000))).toThrow('RangeError: Maximum call stack size exceeded')
    reachesTheTable(['still answering'])
  })

  it('reads a text holding a lone surrogate, short or long', () => {
    reachesTheTable(['a\uD800b'])
    reachesTheTable(['x'.repeat(1 << 17) + '\uDC00'])
  })
})

describe('revive', () => {
  it('turns the engine spelling of a non-finite number back into the number', () => {
    expect(
      revive(
        { a: { $num: 'Infinity' }, b: [{ $num: '-Infinity' }, { $num: 'NaN' }] },
        [],
        undefined,
      ),
    ).toEqual({ a: Infinity, b: [-Infinity, NaN] })
  })
})
