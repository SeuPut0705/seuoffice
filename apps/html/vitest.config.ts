import { defineConfig } from 'vitest/config'
import {
  ENGINE_NODE_SETUP,
  engineWasmAsset,
  engineWasmEnv,
} from '../../packages/engine-wasm/src/vitest'

export default defineConfig({
  // the engine behind @seuoffice/docx-engine: the mains start it from a ?asset path
  plugins: [engineWasmAsset()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
    // jsdom resolves packages without the `node` condition: the engine behind @seuoffice/docx-engine starts here
    env: engineWasmEnv(),
    setupFiles: [ENGINE_NODE_SETUP],
    testTimeout: 20000,
  },
})
