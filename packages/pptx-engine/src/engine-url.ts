// The URL the bundler (vite) serves the wasm engine from: `await initPptxEngine(engineUrl)`
// in a page or a worker. Bundler-only: the `?url` import has no meaning under plain Node.
import engineUrl from '../../../crates/target/wasm32-wasip1/release/office_wasm.wasm?url'

export default engineUrl
