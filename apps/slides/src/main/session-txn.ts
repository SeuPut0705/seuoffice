/**
 * The AI batch surface core (`slides:apply-txn`), for any holder of a slides session: the
 * desktop main process, the shell's MCP slides bridge (both through `applySessionTxn` in
 * slides-main.ts) and the web page (seuoffice), which keeps its own history bookkeeping.
 * Raw ops arrive as one transaction; the registry validates (guided errors), the executor
 * owns atomicity and rollback, and dry-run rehearses the plan without touching the deck.
 */
import { materializeSlide, slideDurableId } from '@seuoffice/pptx-engine'
import { runTxn, type OpRecord, type TxnRequest, type TxnResult } from '@seuoffice/pptx-ops'
import type { ApplyTxnOp, ApplyTxnResult } from '../shared/ipc'
import { applyAutofitResize, syncAutofitScale } from './autofit-writeback'
import {
  buildAllRenderSlides,
  markMetaDirty,
  rebuildSlide,
  rebuildSlideWithReparse,
  type Session,
} from './session-state'

/** How the session's holder records one applied transaction */
export interface TxnHistory {
  /** record the deck before the transaction as one undo step */
  push(session: Session): void
  /** take back the step `push` recorded: the transaction applied nothing */
  drop(session: Session): void
  /** run the transaction against the live deck */
  run(session: Session, req: TxnRequest): TxnResult
}

export function applyTxnToSession(
  session: Session,
  req: ApplyTxnOp,
  history: TxnHistory,
): ApplyTxnResult | null {
  const ops = Array.isArray(req?.ops) ? (req.ops as Parameters<typeof runTxn>[1]['ops']) : []
  if (ops.length === 0 || ops.length > 50) {
    return {
      applied: false,
      failures: [
        { index: 0, error: 'ops must be a non-empty array (at most 50 per transaction).' },
      ],
    }
  }
  const isolation = req.isolation === 'per_op' ? ('per_op' as const) : ('atomic' as const)
  const compact = (fails?: Array<{ index: number; error: string }>) =>
    fails?.map((f) => ({ index: f.index, error: f.error }))
  if (req.dryRun) {
    const r = runTxn(session.opened, { ops, isolation, dryRun: true })
    return {
      applied: false,
      dryRun: true,
      plan: r.plan ?? [],
      ...(r.failures?.length ? { failures: compact(r.failures) } : {}),
    }
  }
  // Plan before pushing history (a no-op request must not clear the redo stack)
  const plan = runTxn(session.opened, { ops, isolation, dryRun: true })
  const invalid = plan.failures?.length ?? 0
  if (isolation === 'atomic' ? invalid > 0 : invalid >= ops.length) {
    return { applied: false, failures: compact(plan.failures) }
  }
  history.push(session)
  const r = history.run(session, { ops, isolation })
  if (!r.applied) {
    history.drop(session)
    return { applied: false, failures: compact(r.failures) }
  }
  // Some ops change only package state (setNotes, a theme commit) and leave no
  // element dirty, so without this the session would still look clean and a
  // close could discard the edit. Element-level ops set their own flags; this
  // covers the archive-only ones.
  markMetaDirty(session)
  // Post-pass mirroring the dedicated shims (autofit/reparse are render concerns and live
  // outside the executor): text ops get autofit resize + fontScale write-back, level changes
  // materialize, and XML-patching ops reparse the page so the final render reflects them.
  // Slides are re-found by the executor-stamped durable id: a numeric target.slide drifts
  // when a later structural op (deleteSlide/moveSlide/duplicateSlide) shifts pages.
  const slideIdxOf = (rec: OpRecord): number => {
    if (rec.slideId)
      return session.opened.deck.slides.findIndex((s) => slideDurableId(s) === rec.slideId)
    return -1
  }
  const renderedByIdx = new Map<number, ReturnType<typeof rebuildSlide>>()
  for (const rec of r.records ?? []) {
    const o = rec.op
    const idx = slideIdxOf(rec)
    if (idx < 0) continue
    if (o.op === 'setTableStyle' || o.op === 'setChart') {
      rebuildSlideWithReparse(session, idx)
      renderedByIdx.delete(idx)
      continue
    }
    const id = o.target?.el
    if (!id || o.group) continue
    if (o.op !== 'setText' && o.op !== 'setFont' && o.op !== 'setParagraphFormat') continue
    if (o.op === 'setText' && (rec.after as { levelDirty?: boolean } | undefined)?.levelDirty)
      continue
    if (
      o.op === 'setParagraphFormat' &&
      (o.format as { indentDelta?: number } | undefined)?.indentDelta
    ) {
      materializeSlide(session.opened, idx)
      renderedByIdx.delete(idx)
      continue
    }
    let rendered = renderedByIdx.has(idx) ? renderedByIdx.get(idx)! : rebuildSlide(session, idx)
    rendered = applyAutofitResize(session, idx, id, rendered)
    rendered = syncAutofitScale(session, idx, id, rendered)
    renderedByIdx.set(idx, rendered)
  }
  return {
    applied: true,
    records: (r.records ?? []).map((rec) => ({
      op: rec.op.op,
      ...(rec.op.target
        ? { target: `${rec.op.target.slide}${rec.op.target.el ? `/${rec.op.target.el}` : ''}` }
        : {}),
      ...(rec.created ? { created: rec.created } : {}),
    })),
    ...(r.failures?.length ? { failures: compact(r.failures) } : {}),
    slides: buildAllRenderSlides(session.opened, session.fitWidthPx),
  }
}
