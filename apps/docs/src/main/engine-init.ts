// Starts the Rust document engine behind @genoffice/docx-engine in this process (Electron main, and the worker threads that import this module first).
// electron-vite copies the wasm file into the bundle and returns its runtime path. Every
// app main that embeds another (the shell) imports its own copy of this module: the first
// one to run starts the engine, the others find it started.
import { readFileSync } from 'node:fs'
import { docxEngineReady, initDocxEngineSync } from '@genoffice/docx-engine/init'
import engineWasmPath from '../../../../crates/target/wasm32-wasip1/release/office_wasm.wasm?asset'

if (!docxEngineReady()) initDocxEngineSync(readFileSync(engineWasmPath))
