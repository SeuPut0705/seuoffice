import type { Server } from 'node:http'
import { resolve } from 'node:path'
import { defaultClientConditions, defineConfig, type Plugin } from 'vite'

/**
 * `SEUOFFICE_COLLAB_SERVER=1 vite preview` also serves the browser tests'
 * co-editing server on the launcher's origin (tests/collab-server.ts). A
 * build and a plain preview never load it.
 */
function testCollabServer(): Plugin {
  return {
    name: 'seuoffice:test-collab-server',
    async configurePreviewServer(server) {
      if (process.env.SEUOFFICE_COLLAB_SERVER !== '1' || !server.httpServer) return
      const { attachCollabServer } = await import('./tests/collab-server')
      attachCollabServer(server.httpServer as Server)
    },
  }
}

// The launcher page; the suite apps are built into dist/<app>/ by scripts/build.mjs
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [testCollabServer()],
  // workspace builds read @seuoffice/embed from its source; the published package ships dist
  resolve: { conditions: ['seuoffice-source', ...defaultClientConditions] },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: false,
    target: 'es2022',
  },
  preview: {
    port: 5300,
    strictPort: true,
  },
})
