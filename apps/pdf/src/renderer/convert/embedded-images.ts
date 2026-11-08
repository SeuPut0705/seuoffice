/**
 * "Export images to folder › Only the pictures in the pages" (spec §4): the
 * pictures embedded in the pages are written as PNG files at their own
 * resolution by the shell's structure process. Pictures smaller than 32 px
 * and repeats are skipped there.
 */
import type {
  PdfConvertOutputRequest,
  PdfStructureImagesRequest,
  PdfStructureImagesResult,
  PdfStructureOutcome,
  PdfStructurePickTargetRequest,
  PdfStructureProgress,
} from '../../shared/ipc'
import type { TFunc } from '../i18n/locale'
import { structureFailureText } from './messages'

export interface EmbeddedImagesApi {
  pickTarget(request: PdfStructurePickTargetRequest): Promise<string | null>
  extractImages(
    request: PdfStructureImagesRequest,
  ): Promise<PdfStructureOutcome<PdfStructureImagesResult>>
  onProgress(handler: (progress: PdfStructureProgress) => void): () => void
  revealResult(request: PdfConvertOutputRequest): Promise<boolean>
}

export interface EmbeddedImagesRun {
  api: EmbeddedImagesApi
  /** the open file */
  filePath: string
  password: string | undefined
  /** file name prefix of the written pictures */
  baseName: string
  t: TFunc
  /** save pending edits first; false = not saved (the editor said why) */
  prepare: () => Promise<boolean>
  onProgress: (done: number, total: number) => void
  notice: (text: string) => void
}

/** Pick a folder, write the pictures, show the first one in the file manager. */
export async function exportEmbeddedImages(run: EmbeddedImagesRun): Promise<void> {
  const { api, filePath, t } = run
  if (!(await run.prepare())) return
  const outDir = await api.pickTarget({
    kind: 'folder',
    path: filePath,
    title: t('imgExportFolderTitle'),
  })
  if (!outDir) return
  const jobId = `images-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const off = api.onProgress((progress) => {
    if (progress.jobId === jobId) run.onProgress(progress.done, progress.total)
  })
  let result: PdfStructureOutcome<PdfStructureImagesResult>
  try {
    result = await api.extractImages({
      jobId,
      path: filePath,
      ...(run.password !== undefined ? { password: run.password } : {}),
      outDir,
      baseName: run.baseName,
    })
  } catch (err) {
    result = { ok: false, error: 'failed', message: String(err) }
  } finally {
    off()
  }
  if (!result.ok) {
    if (result.error !== 'cancelled') {
      run.notice(t('imgExportFailed', { reason: structureFailureText(result, t) }))
    }
    return
  }
  const first = result.images[0]
  if (!first) {
    run.notice(t('imgExportNone'))
    return
  }
  void api.revealResult({ source: filePath, path: first.file })
  run.notice(t('imgExportDone', { count: result.images.length }))
}
