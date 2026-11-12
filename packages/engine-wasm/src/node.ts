// Node host: starts the wasm engine on import, synchronously, from the file
// named by SEUOFFICE_WASM or, without it, the release build of crates/office-wasm
// in this checkout. Imported first by the `node` entries of the engine
// bindings and by the vitest setupFiles of the packages that alias a binding
// to its source.
//
// It starts nothing that is already started (an Electron main or the CLI starts
// the engine from its bundled asset before it gets here), and it leaves the
// engine unstarted where the build output is not beside this file: a bundle
// that merely imports a binding must not fail at startup, and a call made on
// an unstarted engine says so ("call initEngine or initEngineSync first"). A
// SEUOFFICE_WASM that names no file is an error.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { engineReady, initEngineSync } from './index'

if (!engineReady()) {
  const named = process.env.SEUOFFICE_WASM
  const path =
    named ??
    fileURLToPath(
      new URL('../../../crates/target/wasm32-wasip1/release/office_wasm.wasm', import.meta.url),
    )
  if (named !== undefined || existsSync(path)) initEngineSync(readFileSync(path))
}
