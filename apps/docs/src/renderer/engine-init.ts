// Starts the Rust document engine behind @genoffice/docx-engine in this page or worker.
// Imported first by every entry (main.tsx, parse-worker.ts): a module with top-level
// await holds back the modules imported after it, so nothing evaluates before the engine runs.
import { initDocxEngine } from '@genoffice/docx-engine/init'
import engineUrl from '@genoffice/docx-engine/engine-url'

await initDocxEngine(engineUrl)
