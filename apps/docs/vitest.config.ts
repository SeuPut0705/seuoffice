import { fileURLToPath } from 'node:url'
import { defaultClientConditions } from 'vite'
import { defineConfig } from 'vitest/config'

// resolve sibling source packages by path (not via node_modules), so a git
// worktree whose node_modules is linked to another checkout still tests
// against this checkout's edits (same convention as packages/pdf2docx)
const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  resolve: {
    conditions: ['seuoffice-source', ...defaultClientConditions],
    alias: {
      '@seuoffice/docx-engine/lazy-media': local('../../packages/docx-engine/src/lazy-media.ts'),
      '@seuoffice/docx-engine/zip-splice': local('../../packages/docx-engine/src/zip-splice.ts'),
      '@seuoffice/docx-engine': local('../../packages/docx-engine/src/index.ts'),
      '@seuoffice/odt-engine': local('../../packages/odt-engine/src/index.ts'),
      '@seuoffice/docx2hwp': local('../../packages/docx2hwp/src/index.ts'),
      '@seuoffice/font-metrics/resolve': local('../../packages/font-metrics/src/resolve.ts'),
      '@seuoffice/font-metrics/word-faces.json': local(
        '../../packages/font-metrics/word-faces.json',
      ),
      '@seuoffice/font-metrics': local('../../packages/font-metrics/src/index.ts'),
      // subpath before the bare name: string aliases are prefix replacements
      '@seuoffice/electron-utils/doc-attach-channels': local(
        '../../packages/electron-utils/src/doc-attach-channels.ts',
      ),
      '@seuoffice/electron-utils/headless-export': local(
        '../../packages/electron-utils/src/headless-export.ts',
      ),
      '@seuoffice/electron-utils/print-cups': local(
        '../../packages/electron-utils/src/print-cups.ts',
      ),
      '@seuoffice/electron-utils/print-job': local(
        '../../packages/electron-utils/src/print-job.ts',
      ),
      '@seuoffice/electron-utils/atomic-write': local(
        '../../packages/electron-utils/src/atomic-write.ts',
      ),
      '@seuoffice/electron-utils/safe-external-url': local(
        '../../packages/electron-utils/src/safe-external-url.ts',
      ),
      '@seuoffice/electron-utils/renderer-scheme': local(
        '../../packages/electron-utils/src/renderer-scheme.ts',
      ),
      '@seuoffice/electron-utils/template-font-response': local(
        '../../packages/electron-utils/src/template-font-response.ts',
      ),
      '@seuoffice/electron-utils/ai-run-guard': local(
        '../../packages/electron-utils/src/ai-run-guard.ts',
      ),
      '@seuoffice/electron-utils/generated-images': local(
        '../../packages/electron-utils/src/generated-images.ts',
      ),
      '@seuoffice/electron-utils/remote-image': local(
        '../../packages/electron-utils/src/remote-image.ts',
      ),
      '@seuoffice/electron-utils/safe-remote-url': local(
        '../../packages/electron-utils/src/safe-remote-url.ts',
      ),
      '@seuoffice/electron-utils/numbered-export-paths': local(
        '../../packages/electron-utils/src/numbered-export-paths.ts',
      ),
      '@seuoffice/electron-utils': local('../../packages/electron-utils/src/index.ts'),
      '@seuoffice/ai-provider/trace': local('../../packages/ai-provider/src/trace.ts'),
      '@seuoffice/ai-provider/browser': local('../../packages/ai-provider/src/browser.ts'),
      '@seuoffice/ai-provider/codex-app-server': local(
        '../../packages/ai-provider/src/codex-app-server.ts',
      ),
      '@seuoffice/ai-provider/custom-models': local(
        '../../packages/ai-provider/src/custom-models.ts',
      ),
      '@seuoffice/ai-provider/key-models': local(
        '../../packages/ai-provider/src/key-model-refresh.ts',
      ),
      '@seuoffice/ai-provider/free-connect': local(
        '../../packages/ai-provider/src/free-connect.ts',
      ),
      '@seuoffice/ai-provider/subscription': local(
        '../../packages/ai-provider/src/subscription.ts',
      ),
      '@seuoffice/ai-provider': local('../../packages/ai-provider/src/index.ts'),
      // before the package alias below, which would otherwise swallow the subpath
      '@seuoffice/i18n/old-names-env': local('../../packages/i18n/src/old-names-env.ts'),
      '@seuoffice/i18n': local('../../packages/i18n/src/index.ts'),
      '@seuoffice/ui/template-fonts': local('../../packages/ui/src/template-fonts.ts'),
      '@seuoffice/ui/ai-subscription-login-window': local(
        '../../packages/ui/src/ai-subscription-login-window.ts',
      ),
      '@seuoffice/ui': local('../../packages/ui/src/index.ts'),
      '@seuoffice/xlsx-gateway/*': local('../../packages/xlsx-gateway/src/*'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // the engine's display-only `effective` keys stay out of saved-model toEqual
    setupFiles: [local('../../packages/docx-engine/tests/setup-equality.ts')],
    environment: 'jsdom',
    testTimeout: 20000,
  },
})
