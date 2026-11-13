// Node host: starts the wasm engine on import, synchronously, from the file
// named by SEUOFFICE_WASM or, without it, the release build of crates/office-wasm
// in the checkout the process runs in. Imported first by the `node` entries of
// the engine bindings and by the vitest setupFiles of the packages that alias a
// binding to its source.
//
// It starts nothing that is already started (an Electron main or the CLI starts
// the engine from its bundled asset before it gets here), and it leaves the
// engine unstarted where no build is found: a bundle that merely imports a
// binding must not fail at startup, and a call made on an unstarted engine says
// so ("call initEngine or initEngineSync first"). A SEUOFFICE_WASM that names
// no file is an error.
//
// The checkout is found from the working directory, not from this module's own
// URL: Playwright loads it as CommonJS, where `import.meta` does not parse, and
// under vitest's jsdom environment its URL is a dev-server one.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { engineReady, initEngineSync } from './index'

const BUILD = join('crates', 'target', 'wasm32-wasip1', 'release', 'office_wasm.wasm')

/** The release build in the nearest folder at or above `from` that holds one. */
function buildAbove(from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const path = join(dir, BUILD)
    if (existsSync(path)) return path
    if (dirname(dir) === dir) return null
  }
}

if (!engineReady()) {
  const named = process.env.SEUOFFICE_WASM
  const path = named ?? buildAbove(process.cwd())
  if (path !== null) initEngineSync(readFileSync(path))
}
