/**
 * `apps/hwp/src/main/hwp-main.ts` for the shell entry: the real module, with
 * the runtime the entry configures kept on the case's state, so the
 * `d2/pdf-tools:import-pdf-into-hwp` trigger calls the entry's own
 * `importPdf` (`importPdfAsHwp`), as the Hangul editor's File menu does.
 */
import { configureHwpRuntime as configure } from '../../../../../apps/hwp/src/main/hwp-main'
import { state } from './state.cts'

export * from '../../../../../apps/hwp/src/main/hwp-main'

export function configureHwpRuntime(paths: Parameters<typeof configure>[0]): void {
  state().importPdf = paths.importPdf
  configure(paths)
}
