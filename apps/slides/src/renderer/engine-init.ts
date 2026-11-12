// Starts the Rust engine behind @seuoffice/pptx-engine in this window: the renderer calls
// the engine through the subpaths it imports (model3d). Imported first by main.tsx: a module
// with top-level await holds back the modules imported after it, so nothing evaluates before
// the engine runs.
import { initPptxEngine } from '@seuoffice/pptx-engine/init'
import engineUrl from '@seuoffice/pptx-engine/engine-url'

await initPptxEngine(engineUrl)
