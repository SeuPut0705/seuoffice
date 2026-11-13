// Starts the Rust document engine behind @seuoffice/docx-engine in the Electron main process.
// electron-vite copies the wasm file into the bundle and returns its runtime path. Every
// app main that embeds another (the shell) imports its own copy of this module: the first
// one to run starts the engine, the others find it started.
import { readFileSync } from 'node:fs'
import { docxEngineReady, initDocxEngineSync } from '@seuoffice/docx-engine/init'
import engineWasmPath from '../../../../crates/target/wasm32-wasip1/release/office_wasm.wasm?asset'

if (!docxEngineReady()) initDocxEngineSync(readFileSync(engineWasmPath))
// the worker threads of this process (the Hangul export) start theirs from the same file
process.env.SEUOFFICE_WASM ??= engineWasmPath
