// Starting the wasm engine that backs this package. The loader is
// @seuoffice/engine-wasm, and one instance serves every engine binding
// (@seuoffice/docx-engine too): whichever entry starts it first, the others
// find it started. This module is the one place the entries of the apps reach
// it through, so an app needs no dependency of its own on the loader.
//
// - Node (tools, tests, the CLI, Electron main): importing the package under
//   the `node` export condition starts the engine by itself
//   (@seuoffice/engine-wasm/node); an entry that bundles the package from its
//   source path calls `initPptxEngineSync(bytes)` itself, before the first call.
// - A page or a worker: `await initPptxEngine(url)` once, before the first
//   call (the editor mounts after it). `@seuoffice/pptx-engine/engine-url` is
//   the URL of the wasm file the bundler emits.
import { engineReady, initEngine, initEngineSync } from '@seuoffice/engine-wasm'

/** A URL, a fetch response or the bytes of the wasm file. */
export type PptxEngineSource = Parameters<typeof initEngine>[0]

/** Instantiate the engine from its bytes, synchronously. A second call does nothing. */
export function initPptxEngineSync(bytes: BufferSource): void {
  initEngineSync(bytes)
}

/** Instantiate the engine from a URL, a response or its bytes. Await it before the first call. A second call does nothing. */
export function initPptxEngine(source: PptxEngineSource): Promise<void> {
  return initEngine(source)
}

/** Whether the engine has been started. */
export function pptxEngineReady(): boolean {
  return engineReady()
}
