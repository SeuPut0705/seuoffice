// A panic of the Rust side traps the wasm (the release profile aborts) and
// poisons its instance: without this guard the first panic ends the whole
// gate. It wraps `engine.call` of the shared host: a trap loads a fresh
// instance and answers an outcome no TypeScript answer can equal, so a panic
// is counted as a difference, never taken for a refusal.
//   blob commands: `{ error: { code: 'panic', message } }` (the odt
//   comparisons compare codes, and no TypeScript side has the code `panic`)
//   `props` (comparison (f)): `{ panic }` for every call of the request
import { Engine, type Reply } from '../docx-diff/engine'
import { WASM_PATH, engine } from '../docx-diff/harness'

export let panics = 0
let current: Engine = engine
const original = engine.call.bind(engine)

/** The number of calls of each input of a `props` request, or null for another command. */
function propsCalls(command: object): number[] | null {
  if (!('cmd' in command) || command.cmd !== 'props' || !('inputs' in command)) return null
  const inputs: unknown = command.inputs
  if (!Array.isArray(inputs)) return null
  return inputs.map((input: unknown) =>
    input && typeof input === 'object' && 'calls' in input && Array.isArray(input.calls)
      ? input.calls.length
      : 0,
  )
}

engine.call = function guardedCall<Header extends object>(
  command: object,
  blobs?: Uint8Array[],
): Reply<Header> {
  try {
    return current === engine
      ? original<Header>(command, blobs)
      : current.call<Header>(command, blobs)
  } catch (error) {
    if (!(error instanceof WebAssembly.RuntimeError)) throw error
    panics += 1
    current = Engine.load(WASM_PATH)
    const message = `rust panic: ${error.message}`
    const calls = propsCalls(command)
    // the outcome shapes above stand in for the Header the caller expects
    const header: unknown =
      calls === null
        ? { error: { code: 'panic', message } }
        : {
            results: calls.map((count) =>
              Array.from({ length: count }, () => ({ panic: message })),
            ),
          }
    return { header: header as Header, blobs: [] }
  }
}
