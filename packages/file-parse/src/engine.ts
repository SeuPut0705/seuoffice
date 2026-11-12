// How an export of this package reaches the Rust readers (crates/office-wasm,
// invoke/file_parse.rs): `fileParse.<name>` with the TypeScript arguments
// positionally, through the loader's `invoke` codec. Every call carries the
// host steps in callback slot 0 (host-steps.ts), which the readers ask for
// parse5, draw.io and EPUB HTML. An engine refusal comes back as the class the
// TypeScript threw.
import { engineInvoke, engineReady } from '@seuoffice/engine-wasm'
import { DamagedFileError } from './damaged-file'
import { hostStep } from './host-steps'
import { RedactionMarkError } from './redaction-error'

const DAMAGED = /^The file is damaged or is not a valid (.*) document$/

/** The classes of this package, which the loader rebuilds as an Error with their name. */
function classOf(error: Error): Error {
  if (error.name === 'RedactionMarkError') {
    const thrown = new RedactionMarkError('')
    thrown.message = error.message
    return thrown
  }
  const damaged = error.name === 'DamagedFileError' ? DAMAGED.exec(error.message) : null
  if (damaged) return new DamagedFileError(damaged[1]!, undefined)
  return error
}

/** One export of this package: the engine's answer to the TypeScript arguments. */
export function callEngine<T>(fn: string, args: readonly unknown[]): T {
  if (!engineReady()) {
    throw new Error(
      'the file-parse engine is not started: initFileParseEngineSync(bytes) or await initFileParseEngine(url) once before the first call; under the `node` export condition it starts itself',
    )
  }
  try {
    return engineInvoke(fn, args, {
      fnPrefix: 'fileParse.',
      extraCallbacks: { 0: hostStep },
    }) as T
  } catch (error) {
    throw error instanceof Error ? classOf(error) : error
  }
}
