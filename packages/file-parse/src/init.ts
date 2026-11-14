// Starting the wasm engine behind this package (the loader is
// @seuoffice/engine-wasm, one instance shared with the other engine bindings).
// Under the `node` export condition the package starts it by itself; an
// Electron main that bundles the package starts it from its bundled asset
// with `initFileParseEngineSync(bytes)` before the first call.
import { engineReady, initEngine, initEngineSync } from '@seuoffice/engine-wasm'

/** Instantiate the engine from its bytes, synchronously. A second call does nothing. */
export function initFileParseEngineSync(bytes: BufferSource): void {
  initEngineSync(bytes)
}

/** Instantiate the engine from a URL, a response or its bytes. Await it before the first call. */
export function initFileParseEngine(source: Parameters<typeof initEngine>[0]): Promise<void> {
  return initEngine(source)
}

/** Whether the engine has been started. */
export function fileParseEngineReady(): boolean {
  return engineReady()
}
