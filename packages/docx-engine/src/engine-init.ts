// Starting the wasm engine that backs this package. The loader is
// @seuoffice/engine-wasm; this module is the one place the entries of the apps
// reach it through, so an app needs no dependency of its own on the loader.
//
// - Node (tools, tests, the CLI, Electron main): importing the package under
//   the `node` export condition starts the engine by itself (@seuoffice/engine-wasm/node);
//   an entry that bundles the package from its source path calls
//   `initDocxEngineSync(bytes)` itself, before the first call.
// - A page or a worker: `await initDocxEngine(url)` once, before the first
//   call (the editor mounts after it). `@seuoffice/docx-engine/engine-url` is
//   the URL of the wasm file the bundler emits.
import { engineReady, initEngine, initEngineSync } from '@seuoffice/engine-wasm'

/** A URL, a fetch response or the bytes of the wasm file. */
export type DocxEngineSource = Parameters<typeof initEngine>[0]

/** Instantiate the engine from its bytes, synchronously. A second call does nothing. */
export function initDocxEngineSync(bytes: BufferSource): void {
  initEngineSync(bytes)
}

/** Instantiate the engine from a URL, a response or its bytes. Await it before the first call. A second call does nothing. */
export function initDocxEngine(source: DocxEngineSource): Promise<void> {
  return initEngine(source)
}

/** Whether the engine has been started. */
export function docxEngineReady(): boolean {
  return engineReady()
}
