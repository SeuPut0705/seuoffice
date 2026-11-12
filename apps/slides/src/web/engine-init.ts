// Starts the Rust document engine behind @genoffice/docx-engine in this page (the equation ops
// of @genoffice/pptx-ops call it). Imported first by main.web.ts: a module with top-level await
// holds back the modules imported after it.
import { initDocxEngine } from '@genoffice/docx-engine/init'
import engineUrl from '@genoffice/docx-engine/engine-url'

await initDocxEngine(engineUrl)
