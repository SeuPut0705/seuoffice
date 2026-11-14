import { defaultServerConditions } from 'vite'
import { defineConfig } from 'vitest/config'
import {
  ENGINE_NODE_SETUP,
  engineWasmAsset,
  engineWasmEnv,
} from '../../packages/engine-wasm/src/vitest'

export default defineConfig({
  // the engine behind @seuoffice/file-parse: the mains start it from a ?asset path
  plugins: [engineWasmAsset()],
  // @seuoffice/collab ships TypeScript source under this export condition
  ssr: { resolve: { conditions: ['seuoffice-source', ...defaultServerConditions] } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: engineWasmEnv(),
    setupFiles: [ENGINE_NODE_SETUP],
  },
})
