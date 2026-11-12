// Starts the Rust readers behind @seuoffice/file-parse in the extraction worker: a worker thread has
// an engine instance of its own. electron-vite copies the wasm file into the bundle and returns its
// runtime path.
import { readFileSync } from 'node:fs'
import { fileParseEngineReady, initFileParseEngineSync } from '@seuoffice/file-parse/init'
import engineWasmPath from '../../../../../crates/target/wasm32-wasip1/release/office_wasm.wasm?asset'

if (!fileParseEngineReady()) initFileParseEngineSync(readFileSync(engineWasmPath))
