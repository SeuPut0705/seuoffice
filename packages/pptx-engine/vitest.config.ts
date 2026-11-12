import { defineConfig } from 'vitest/config'
import { ENGINE_NODE_SETUP } from '../engine-wasm/src/vitest'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // a test reads a deck back through @seuoffice/file-parse, whose readers are the wasm engine
    setupFiles: [ENGINE_NODE_SETUP],
  },
})
