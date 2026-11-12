// Starts the Rust document engine behind @seuoffice/docx-engine in this page (the equation ops
// of @seuoffice/pptx-ops call it). Imported first by main.web.ts: a module with top-level await
// holds back the modules imported after it.
import { initDocxEngine } from '@seuoffice/docx-engine/init'
import engineUrl from '@seuoffice/docx-engine/engine-url'

await initDocxEngine(engineUrl)
