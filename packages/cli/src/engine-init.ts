// Starts the Rust document engine behind @seuoffice/docx-engine in this process. Imported first
// by cli.ts, so the engine runs before any module that calls it evaluates: the bundle is one
// CommonJS file, where the node start-up beside the loader's source (@seuoffice/engine-wasm/node) has no
// build output to find.
import { readFileSync } from 'node:fs'
import { docxEngineReady, initDocxEngineSync } from '@seuoffice/docx-engine/init'
import { engineWasmPath } from './resources'

if (!docxEngineReady()) initDocxEngineSync(readFileSync(engineWasmPath()))
