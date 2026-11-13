// Starts the Rust document engine behind @seuoffice/docx-engine in this page or worker.
// Imported first by the page entry (main.tsx): a module with top-level
// await holds back the modules imported after it, so nothing evaluates before the engine runs.
import { initDocxEngine } from '@seuoffice/docx-engine/init'
import engineUrl from '@seuoffice/docx-engine/engine-url'

await initDocxEngine(engineUrl)
