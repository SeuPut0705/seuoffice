// How an export of this package reaches the Rust readers (crates/office-wasm,
// invoke/file_parse.rs): `fileParse.<name>` with the TypeScript arguments
// positionally, through the loader's `invoke` codec. Every call carries the
// host steps in callback slot 0 (host-steps.ts), which the readers ask for
// parse5, draw.io and EPUB HTML. An engine refusal comes back as the class the
// TypeScript threw.
import {
  EngineError,
  engineErrorOf,
  engineInvoke,
  engineReady,
  type Shape,
} from '@seuoffice/engine-wasm'
import { DamagedFileError } from './damaged-file'
import { hostStep } from './host-steps'
import { RedactionMarkError } from './redaction-error'

const DAMAGED_PREFIX = 'The file is damaged or is not a valid '
const DAMAGED_SUFFIX = ' document'

function classOf(error: EngineError): Error {
  const mapped = engineErrorOf(error)
  if (mapped.name === 'RedactionMarkError') {
    const thrown = new RedactionMarkError('')
    thrown.message = mapped.message
    return thrown
  }
  if (mapped.name === 'DamagedFileError' && mapped.message.startsWith(DAMAGED_PREFIX)) {
    const type = mapped.message.slice(DAMAGED_PREFIX.length, -DAMAGED_SUFFIX.length)
    return new DamagedFileError(type, undefined)
  }
  return mapped
}

/** One export of this package: the engine's answer to the TypeScript arguments. */
export function callEngine<T>(
  fn: string,
  args: readonly unknown[],
  options: { shape?: Shape; undef?: boolean } = {},
): T {
  if (!engineReady()) {
    throw new Error(
      'the file-parse engine is not started: initFileParseEngineSync(bytes) or await initFileParseEngine(url) once before the first call; under the `node` export condition it starts itself',
    )
  }
  try {
    return engineInvoke(`fileParse.${fn}`, args, {
      ...options,
      extraCallbacks: { 0: hostStep },
    }) as T
  } catch (error) {
    throw error instanceof EngineError ? classOf(error) : error
  }
}
