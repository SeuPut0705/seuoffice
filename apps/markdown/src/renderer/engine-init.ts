// Starts the Rust document engine behind @seuoffice/docx-engine in this page (the Word export
// calls it). Imported first by main.tsx: a module with top-level await holds back the modules
// imported after it.
import { initDocxEngine } from '@seuoffice/docx-engine/init'
import engineUrl from '@seuoffice/docx-engine/engine-url'

await initDocxEngine(engineUrl)
