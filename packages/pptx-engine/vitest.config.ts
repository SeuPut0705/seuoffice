import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // the binding calls the wasm engine: started before any test module loads
    setupFiles: ['../engine-wasm/src/node.ts'],
  },
})
