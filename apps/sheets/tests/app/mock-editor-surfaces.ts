// Replaces the Univer chrome installers App.tsx wires at mount (canvas, DOM and render-service
// patches). Everything else in those modules stays real.
import { vi } from 'vitest'

vi.mock('../../src/renderer/univer-sync', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/grid-growth', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/alt-enter-wrap', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/mcp-bridge', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/lazy-find', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/replace-autosearch', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/cross-highlight', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/outline-gutter', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/template-fonts', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/clipboard-tsv', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/filtered-copy', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/filter-range-outline', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/very-hidden-sheets', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/formula-bar-autosize', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/function-arguments-runtime', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/formula-view', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/formula-cached-fallback', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/function-registry-probe', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/cell-function', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/sheet-rtl-view', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/formula-lexer-fix', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/error-value-align', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/formula-newline-display', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/cf-duplicate-key', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/cf-formula-fold', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/sheet-rename-fix', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/arrow-collapse-fix', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/sheet-protection', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/ctrl-drag-fill', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/context-submenu-reopen-fix', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/menu-input-enter', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/cell-context-menu', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/clipboard-anchor-tile', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/selection-wrap-fix', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/selection-appearance', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/cell-clip-anchor-fix', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/border-overflow-exclusion', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/cf-empty-fast-path', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/styles-cache-reuse', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/merge-border-fix', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/thick-border-fix', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/center-continuous', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/filter-button-excel-style', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/large-filter', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/long-text-render', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/autofit-wrap-budget', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/autofit-line-pitch', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/load-perf-patches', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/copy-animation-idle', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/number-as-text-alert', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/formula-stream-hold', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/rich-text-bidi-fix', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/rtl-text-fix', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/rtl-grid-mirror', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/vert-align-render', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/autofit-multi-row', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/remove-disjoint-lines', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/format-painter', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/copy-materialize', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/copy-picture', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/statusbar-file-stats', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/status-bar-stats', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/univer-rule-detail', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/data-validation-dropdown', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/data-validation-marker', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/threaded-comment-marker', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/formula-null-result', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/korean-date-input', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/numfmt-fix', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/ifs-empty-set', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/criteria-compare-cache', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/rate-function', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/page-break-preview', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/picture-paste', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/wheel-zoom', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('../../src/renderer/WorkbookVisuals', async (original) =>
  (await import('./stub-installers')).stubInstallers(await original()),
)
vi.mock('@univerjs/sheets-ui/facade', () => ({}))
vi.mock('../../src/renderer/create-univer', async () =>
  (await import('./minimal-univer')).minimalUniverModule(),
)
vi.mock('../../src/renderer/univer-state', async (original) =>
  (await import('./minimal-univer')).univerStateWithGatedCommit(
    (await import('./stub-installers')).stubInstallers(await original()),
  ),
)
