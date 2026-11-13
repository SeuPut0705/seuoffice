/**
 * File actions extracted from App.tsx: save / save-as, image & PDF
 * export. Each function takes the ActionCtx built fresh per call.
 * (Printing lives in components/PrintDialog.tsx — preview + options dialog.)
 */
import type { RenderSlide } from '@seuoffice/pptx-render'
import type { ExportPdfLink } from '../shared/ipc'
import { baseName } from '../shared/base-name'
import { modelSaveAsName } from './file-naming'
import type { ActionCtx } from './action-context'
import { collectExportPdfLinks } from './export-links'
import { renderSlidesToPdfPages } from './export-pages'
import { confirmExportWithoutMarks } from './export-marks'
import { renderSlidesToImageBase64 } from './export-render'
import { projectPanelText, runFileNaming } from '@seuoffice/ui'
import { getLang, t } from './i18n/locale'
import { showToast } from './components/toast-bus'

/**
 * If a text box/table is still being edited on ⌘S/close-save, blur first so the
 * overlay commits (blur→commitEdit), and save only after the commit lands —
 * otherwise we save pre-edit content and get a dirty-close prompt again.
 */
export async function flushActiveEdit(ctx: ActionCtx): Promise<void> {
  const active = document.activeElement as HTMLElement | null
  if (!active?.isContentEditable) return
  active.blur()
  for (let i = 0; i < 40 && ctx.editingActiveRef.current; i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
}

/**
 * After save, the main process reopens the file with all-new element ids: swap
 * the render tree, mapping selection/edit state to new ids by per-page node ordinal.
 */
export function adoptSavedSlides(ctx: ActionCtx, next: RenderSlide[]): void {
  const page = ctx.slides[ctx.current]
  const remap = (id: string) => {
    const i = page?.nodes.findIndex((n) => n.sourceId === id) ?? -1
    return i >= 0 ? (next[ctx.current]?.nodes[i]?.sourceId ?? null) : null
  }
  ctx.setSelectedIds((ids) => ids.map(remap).filter((x): x is string => x !== null))
  ctx.setEnteredGroupId(null) // Group children ids can't be mapped by top-level ordinal; exit in-group editing after save
  // A stale edit target (page gone, deck shrunk) cannot be mapped: drop it rather than keep an id no node owns
  ctx.setEditing((e) => {
    const id = e && remap(e.sourceId)
    return id ? { sourceId: id } : null
  })
  ctx.setEditingCell((c) => {
    const id = c && remap(c.sourceId)
    return id && c ? { ...c, sourceId: id } : null
  })
  ctx.setSlides(next)
}

/**
 * Serializes save passes: a call that arrives while a save is in flight waits
 * for it instead of running concurrently. Two overlapping saves write the
 * same file with two `createWriteStream` pipes — interleaved zip streams,
 * truncated pptx, or EPERM/EBUSY on Windows. The queue is a simple promise
 * chain: each caller awaits the previous tail, then runs its own pass.
 */
let saveTail: Promise<unknown> | null = null

/**
 * Runs `pass` after the in-flight save (if any) finishes, and becomes the
 * tail subsequent saves wait on. A pass that throws still releases the
 * queue; the error propagates to its own caller only.
 */
async function runSerialized<T>(pass: () => Promise<T>): Promise<T> {
  const prior = saveTail
  const current = (async (): Promise<T> => {
    if (prior) await prior.catch(() => undefined)
    return pass()
  })()
  const tail = current.then(
    () => undefined,
    () => undefined,
  )
  saveTail = tail
  void current.then(
    () => {
      if (saveTail === tail) saveTail = null
    },
    () => {
      if (saveTail === tail) saveTail = null
    },
  )
  return current
}

export async function save(getCtx: () => ActionCtx, auto = false): Promise<boolean> {
  return runSerialized(async () => {
    // resolved only now: a queued pass must remap selection against the tree the prior save adopted
    const ctx = getCtx()
    await flushActiveEdit(ctx)
    await ctx.flushNotes()
    const r = await window.slidesApi.save(auto)
    if (r.ok) {
      if (r.slides) adoptSavedSlides(ctx, r.slides)
      if (r.path) ctx.setPath(r.path)
      ctx.setDirty(false)
      const saved = t('appStatusSaved')
      ctx.setStatus(saved)
      if (!auto) showToast(saved)
    } else if (r.reason === 'ai-review') {
      // an AI run's edits wait for review: nothing was written. The AutoSave pass stays quiet
      // (it retries every tick); a save the person asked for says why it did nothing.
      if (!auto) {
        const held = t('aiRunLocked')
        ctx.setStatus(held)
        showToast(held, 'error')
      }
    } else if (r.reason === 'external-modified') {
      // the split-view guard sat this write out: the AutoSave pass deferred by
      // itself, or the user cancelled the overwrite prompt. The disk copy
      // stands, the deck stays dirty, and no banner repeats the question
      // (docs' save path is the model)
    } else {
      const failed = t('appStatusSaveFailed', { error: r.error ?? t('appErrorCanceled') })
      ctx.setStatus(failed)
      // a failed save (incl. the 30s auto-save) must surface, or edits silently
      // stop reaching disk
      showToast(failed, 'error')
    }
    return r.ok
  })
}

/**
 * Commit what the person still has open (a text box, a notes draft), as a save does before it
 * writes; nothing is saved. Same queue as save(): the web's co-editing export asks for the
 * deck as it is on screen, and must not run into a save pass.
 */
export function commitDrafts(getCtx: () => ActionCtx): Promise<void> {
  return runSerialized(async () => {
    const ctx = getCtx()
    await flushActiveEdit(ctx)
    await ctx.flushNotes()
  })
}

/**
 * Project folders (spec 6): the run a create flow handed to this untitled deck
 * ended well, so the deck is saved into its panel's project without a dialog.
 * The main process picks the folder and a free name; with no project nothing
 * happens. A refused write keeps the deck untitled and says why. Same queue as
 * save(): it must not interleave with a save the person started.
 */
export async function saveIntoProject(getCtx: () => ActionCtx): Promise<boolean> {
  return runSerialized(async () => {
    const ctx = getCtx()
    if (ctx.path || !window.slidesApi.saveIntoProject) return false
    await flushActiveEdit(ctx)
    await ctx.flushNotes()
    const r = await window.slidesApi.saveIntoProject()
    if (r.ok) {
      if (r.slides) adoptSavedSlides(ctx, r.slides)
      if (r.path) ctx.setPath(r.path)
      ctx.setDirty(false)
      ctx.setStatus(t('appStatusSaved'))
      return true
    }
    if (r.error) {
      const failed = projectPanelText(getLang(), 'newDocumentSaveFailed', { error: r.error })
      ctx.setStatus(failed)
      showToast(failed, 'error')
    }
    return false
  })
}

export async function saveAs(getCtx: () => ActionCtx): Promise<void> {
  await saveAsWithName(getCtx, null)
}

/**
 * Ask the model to name this deck, on request, then open Save As with its
 * answer prefilled.
 *
 * The stem goes into the dialog rather than renaming the file on disk: a deck
 * that may be open elsewhere, presented from another machine, or synced is not
 * something to move behind the reader's back. A declined or empty answer
 * leaves the dialog closed and the deck on its current name; the status line
 * says that the model is being asked, and then why it gave no name.
 */
export async function nameWithAi(getCtx: () => ActionCtx): Promise<void> {
  const ctx = getCtx()
  // the model reads the deck, so an edit still being typed has to land first
  const editing = ctx.editingActiveRef.current
  await flushActiveEdit(ctx)
  // that commit can replace the deck, so read it again rather than from the
  // snapshot taken before the flush
  const deck = editing ? getCtx() : ctx
  const stem = await runFileNaming(
    getLang(),
    {
      running: (text) => ctx.setStatus(text ?? ''),
      // as a failed save: the status line and a toast
      failed: (text) => {
        ctx.setStatus(text)
        showToast(text, 'error')
      },
    },
    () => modelSaveAsName(deck.slides),
  )
  if (stem === null) return
  await saveAsWithName(getCtx, `${stem}.pptx`)
}

/**
 * Save As with a name the reader (or the model, via `nameWithAi`) chose.
 *
 * A null name means "the deck's current name", which is read inside the queue:
 * a save that landed while this call was waiting may have changed it.
 */
export async function saveAsWithName(getCtx: () => ActionCtx, name: string | null): Promise<void> {
  // Same queue as save(): Save + Save As (or double Save As) write through
  // the same main-process pipe and would interleave without it.
  const copy = await runSerialized(async () => {
    const ctx = getCtx()
    await flushActiveEdit(ctx)
    await ctx.flushNotes()
    const target = name ?? (baseName(ctx.path ?? '') || 'presentation.pptx')
    const r = await window.slidesApi.saveAs(target)
    // a copy format was picked: no deck was written, the export runs below
    if (r.exportAs && r.path) return { kind: r.exportAs, path: r.path }
    if (r.ok) {
      if (r.slides) adoptSavedSlides(ctx, r.slides)
      ctx.setPath(r.path ?? ctx.path)
      ctx.setDirty(false)
      const saved = t('appStatusSavedAs')
      ctx.setStatus(saved)
      showToast(saved)
    } else if (r.reason === 'ai-review') {
      const held = t('aiRunLocked')
      ctx.setStatus(held)
      showToast(held, 'error')
    } else if (r.error) {
      // a canceled dialog returns ok:false without error — only real write
      // failures surface, matching the docs/sheets save-as feedback
      const failed = t('appStatusSaveFailed', { error: r.error })
      ctx.setStatus(failed)
      showToast(failed, 'error')
    }
    return null
  })
  // Save As › PDF / PNG: the Export command's own rendering and writer, to the
  // path picked in the Save As dialog. The deck keeps its path and dirty state.
  // Outside the save queue: an export writes no deck file.
  if (copy?.kind === 'pdf') await exportPdf(getCtx(), copy.path)
  else if (copy?.kind === 'png') await exportImages(getCtx(), 'png', copy.path)
}

/** Export base name: file name without the .pptx extension */
export function exportBaseName(ctx: ActionCtx): string {
  return (baseName(ctx.path ?? '') || t('appUntitledPresentation')).replace(/\.pptx$/i, '')
}

/**
 * Export as images: each page (skipping hidden ones) rendered offscreen to 2x
 * PNG or JPG, written to disk by the main process. `saveAsTarget` (Save As ›
 * PNG) is the name the Save As dialog returned: no folder picker, and the
 * files are that name, numbered per page when there is more than one.
 *
 * A deck with content hidden from the AI asks first: the images carry no mark.
 */
export async function exportImages(
  ctx: ActionCtx,
  format: 'png' | 'jpg' = 'png',
  saveAsTarget?: string,
): Promise<void> {
  const visible = ctx.slides.filter((s) => !s.hidden)
  if (visible.length === 0) {
    ctx.setStatus(t('appExportNoSlides'))
    return
  }
  if (!(await confirmExportWithoutMarks(ctx, visible, format === 'jpg' ? 'JPG' : 'PNG'))) return
  const dir =
    saveAsTarget !== undefined
      ? saveAsTarget.slice(0, saveAsTarget.length - baseName(saveAsTarget).length - 1)
      : await window.slidesApi.pickExportDir()
  if (dir === null) return
  ctx.setStatus(t('appExportImagesProgress', { count: visible.length }))
  try {
    const pages = await renderSlidesToImageBase64(visible, ctx.images, { format })
    const r = await window.slidesApi.exportImages({
      dir,
      baseName: exportBaseName(ctx),
      format,
      pngsBase64: pages,
      ...(saveAsTarget !== undefined ? { saveAsTarget } : {}),
    })
    ctx.setStatus(
      r.ok
        ? t('appExportImagesDone', { count: r.paths?.length ?? 0, dir })
        : t('appExportImagesFailed', { error: r.error ?? t('appUnknownError') }),
    )
  } catch (err) {
    ctx.setStatus(t('appExportImagesFailed', { error: String(err) }))
  }
}

/**
 * Element and text-run hyperlinks of every exported page as clickable overlay
 * rects (the pages are rasterized, so links must ride along separately). Link
 * fetch failures degrade to a link-less PDF rather than failing the export.
 */
async function collectPdfLinks(ctx: ActionCtx): Promise<ExportPdfLink[][]> {
  const modelIndexes = ctx.slides.flatMap((s, i) => (s.hidden ? [] : [i]))
  const pageOfModelIndex = new Map(modelIndexes.map((mi, page) => [mi, page] as const))
  try {
    const [linkLists, runLinkLists] = await Promise.all([
      Promise.all(modelIndexes.map((mi) => window.slidesApi.getSlideLinks(mi))),
      Promise.all(modelIndexes.map((mi) => window.slidesApi.getRunLinks(mi))),
    ])
    const visible = modelIndexes.map((mi) => ctx.slides[mi]!)
    return collectExportPdfLinks(visible, linkLists, runLinkLists, pageOfModelIndex)
  } catch {
    return []
  }
}

/**
 * Export as PDF: each page (skipping hidden ones) rendered to vector SVG (text
 * stays text; a page the SVG backend cannot build falls back to its 2x PNG);
 * main process printToPDF in a hidden window.
 *
 * `outPath` skips the save dialog — the headless CLI entry or the Save As
 * dialog (Save As › PDF) already chose where the file goes. Resolves true only
 * when a PDF was written.
 *
 * A deck with content hidden from the AI asks first: the PDF carries no mark.
 * `silent` (the headless CLI) has no one to ask, so such a deck throws instead.
 */
export async function exportPdf(
  ctx: ActionCtx,
  outPath?: string,
  options: { readonly silent?: boolean } = {},
): Promise<boolean> {
  const visible = ctx.slides.filter((s) => !s.hidden)
  if (visible.length === 0) {
    ctx.setStatus(t('appExportNoSlides'))
    return false
  }
  if (!(await confirmExportWithoutMarks(ctx, visible, 'PDF', options.silent))) return false
  const target = outPath ?? (await window.slidesApi.pickExportPdfPath(`${exportBaseName(ctx)}.pdf`))
  if (!target) return false
  ctx.setStatus(t('appExportPdfProgress'))
  try {
    const { pages, fontCss } = await renderSlidesToPdfPages(visible, ctx.images)
    const links = await collectPdfLinks(ctx)
    const r = await window.slidesApi.exportPdf({
      filePath: target,
      pages,
      widthPx: visible[0].widthPx,
      heightPx: visible[0].heightPx,
      links,
      fontCss,
    })
    ctx.setStatus(
      r.ok
        ? t('appExportPdfDone', { path: r.path ?? '' })
        : t('appExportPdfFailed', { error: r.error ?? t('appUnknownError') }),
    )
    return r.ok
  } catch (err) {
    ctx.setStatus(t('appExportPdfFailed', { error: String(err) }))
    return false
  }
}
