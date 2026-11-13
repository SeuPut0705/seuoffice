/**
 * `apps/pdf/src/main/wasm-path.ts`: the job process's set-up never reaches a
 * real process here, so fixed paths stand for the wasm files.
 */
export const pdfiumWasmPath = (): string => '/wasm/pdfium.wasm'
export const qpdfWasmPath = (): string => '/wasm/qpdf.wasm'
export const hbSubsetWasmPath = (): string => '/wasm/hb-subset.wasm'
