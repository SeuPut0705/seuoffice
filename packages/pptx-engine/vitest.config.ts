import { defineConfig } from 'vitest/config'
import { ENGINE_NODE_SETUP } from '../engine-wasm/src/vitest'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // the binding calls the wasm engine, and a test reads a deck back through
    // @seuoffice/file-parse, whose readers are that engine: started before any test module loads
    setupFiles: [ENGINE_NODE_SETUP],
  },
})
