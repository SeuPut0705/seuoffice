// Starts the Rust readers behind @seuoffice/file-parse in this process (attachments read for the AI).
// electron-vite copies the wasm file into the bundle and returns its runtime path. Every app main
// that embeds another (the shell) imports its own copy of this module: the first one to run starts
// the engine, the others find it started.
import { readFileSync } from 'node:fs'
import { fileParseEngineReady, initFileParseEngineSync } from '@seuoffice/file-parse/init'
import engineWasmPath from '../../../../crates/target/wasm32-wasip1/release/office_wasm.wasm?asset'

if (!fileParseEngineReady()) initFileParseEngineSync(readFileSync(engineWasmPath))
