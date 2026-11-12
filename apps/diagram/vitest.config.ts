import { defineConfig } from 'vitest/config'
import {
  ENGINE_NODE_SETUP,
  engineWasmAsset,
  engineWasmEnv,
} from '../../packages/engine-wasm/src/vitest'

export default defineConfig({
  // the engine behind @seuoffice/file-parse: the mains start it from a ?asset path
  plugins: [engineWasmAsset()],
  test: {
    include: ['tests/**/*.test.ts'],
    env: engineWasmEnv(),
    setupFiles: [ENGINE_NODE_SETUP],
    environment: 'jsdom',
    testTimeout: 20000,
  },
})
