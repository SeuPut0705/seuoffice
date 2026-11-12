/**
 * Type shim (same recipe as docx-engine-math.d.ts): the engine start-up modules of
 * @seuoffice/docx-engine ship as TS source and fail under sheets' stricter compiler options.
 * Keep in sync with packages/docx-engine/src/engine-init.ts and engine-url.ts.
 */
declare module '@seuoffice/docx-engine/init' {
  /** Instantiate the engine from a URL, a fetch response or its bytes; await it before the first call */
  export function initDocxEngine(source: string | URL | Response | BufferSource): Promise<void>
}

declare module '@seuoffice/docx-engine/engine-url' {
  /** the URL the bundler serves the wasm engine from */
  const url: string
  export default url
}
