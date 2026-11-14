// Starts the Rust readers behind @seuoffice/file-parse in the extraction worker: a worker thread has
// an engine instance of its own. The main process that spawns it names the wasm file in
// SEUOFFICE_WASM (apps/*/src/main/engine-init.ts), which the worker inherits; a worker chunk cannot
// carry a ?asset import of its own.
import '@seuoffice/engine-wasm/node'
