import { isDeepStrictEqual } from 'node:util'
import { failed } from './engine'
import { describeTextDifference, engine, type Comparison } from './harness'
import { keyOrderDifferences, parseKeepingOrder } from './key-order'
import type { ModelInput } from './model-wire'

const encode = new TextEncoder()
const decode = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export interface ModelOutcome {
  json?: string
  error?: string
}

/** JSON travels in a blob so the command frame cannot reorder or reprint the result. */
export function rustModel(input: Pick<ModelInput, 'type' | 'json'>): ModelOutcome {
  const reply = engine.call<{ model: boolean }>({ cmd: 'modelRoundTrip', typeName: input.type }, [
    encode.encode(input.json),
  ])
  if (failed(reply.header))
    return { error: `${reply.header.error.code}: ${reply.header.error.message}` }
  if (!reply.header.model || reply.blobs.length !== 1)
    throw new Error('invalid modelRoundTrip reply')
  return { json: decode.decode(reply.blobs[0]!) }
}

export function compareModel(comparison: Comparison, input: ModelInput): ModelOutcome {
  const rust = rustModel(input)
  if (input.expect === 'refuse') {
    comparison.record(
      rust.error !== undefined
        ? null
        : `${input.where} (${input.type}): Rust accepted invalid input`,
    )
    return rust
  }
  if (rust.error !== undefined) {
    comparison.record(`${input.where} (${input.type}): Rust refused ${rust.error}`)
  } else if (rust.json === input.json) {
    comparison.record(null)
  } else {
    const equal = isDeepStrictEqual(JSON.parse(input.json), JSON.parse(rust.json!))
    comparison.record(
      `${input.where} (${input.type}): ${describeTextDifference(input.json, rust.json!)}`,
      equal &&
        keyOrderDifferences(JSON.parse(input.json), parseKeepingOrder(rust.json!)).length > 0,
    )
  }
  return rust
}
