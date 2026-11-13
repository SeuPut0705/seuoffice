// What a vitest config needs to run code that starts the engine the way an
// Electron main does (`import path from '…/office_wasm.wasm?asset'`, then
// initEngineSync): vite has no meaning for `?asset` on a .wasm file outside
// electron-vite, and a jsdom environment gives modules an import.meta.url that
// is not a file URL, so node.ts cannot find the build beside itself there.
//
//   plugins: [engineWasmAsset()],
//   test: { env: engineWasmEnv(), setupFiles: [ENGINE_NODE_SETUP] }
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))

/** The release build of crates/office-wasm in this checkout. */
export const ENGINE_WASM_PATH = resolve(
  here,
  '../../../crates/target/wasm32-wasip1/release/office_wasm.wasm',
)

/** The setup file that starts the engine before a test module evaluates. */
export const ENGINE_NODE_SETUP = resolve(here, 'node.ts')

/** `SEUOFFICE_WASM` for node.ts: the build to start, unless the environment names another. */
export function engineWasmEnv(): Record<string, string> {
  return { SEUOFFICE_WASM: process.env.SEUOFFICE_WASM ?? ENGINE_WASM_PATH }
}

const PREFIX = '\0seuoffice-wasm-asset:'

/** `import path from '….wasm?asset'` as electron-vite answers it: the file's path on disk. */
export function engineWasmAsset(): Plugin {
  return {
    name: 'seuoffice-engine-wasm-asset',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.endsWith('.wasm?asset') || !importer) return null
      return PREFIX + resolve(dirname(importer), source.slice(0, -'?asset'.length))
    },
    load(id) {
      return id.startsWith(PREFIX)
        ? `export default ${JSON.stringify(id.slice(PREFIX.length))}`
        : null
    },
  }
}
