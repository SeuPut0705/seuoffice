import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // Pin resolution to this repo's workspace sources: in a git worktree
  // node_modules links into the main checkout, so bare specifiers would test
  // against the other checkout's sources (matches tsconfig paths)
  resolve: {
    alias: {
      // Subpath before the bare name: string aliases are prefix replacements
      '@seuoffice/electron-utils/remote-image': resolve(
        here,
        '../electron-utils/src/remote-image.ts',
      ),
      '@seuoffice/electron-utils/safe-remote-url': resolve(
        here,
        '../electron-utils/src/safe-remote-url.ts',
      ),
      '@seuoffice/electron-utils/generated-images': resolve(
        here,
        '../electron-utils/src/generated-images.ts',
      ),
      // Subpath before the bare name: string aliases are prefix replacements
      '@seuoffice/ai-provider/subscription': resolve(here, '../ai-provider/src/subscription.ts'),
      '@seuoffice/ai-provider': resolve(here, '../ai-provider/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // every test process runs with a throwaway home folder, never the real one;
    // the second file keeps the temp dir beside that home (see the file)
    setupFiles: ['../../tools/test-home.ts', 'tests/setup-tmpdir.ts'],
  },
})
