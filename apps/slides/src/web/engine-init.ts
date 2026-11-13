// Starts the Rust engine behind @seuoffice/pptx-engine in this page; the same instance answers
// @seuoffice/docx-engine (the equation ops of @seuoffice/pptx-ops call it). Imported first by
// main.web.ts: a module with top-level await holds back the modules imported after it.
import { initPptxEngine } from '@seuoffice/pptx-engine/init'
import engineUrl from '@seuoffice/pptx-engine/engine-url'

await initPptxEngine(engineUrl)
