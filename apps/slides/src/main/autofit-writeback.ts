/**
 * Text-edit autofit write-back, shared by the desktop's `slides:*` handlers (slides-main.ts) and
 * the web build's page-side edits (src/web/deck-edits.ts): after a text change the rendered
 * layout decides the box size (spAutoFit) or the shrink ratio (normAutofit), and the model
 * follows it so the saved file opens at the same size.
 */
import { patchBodyPrAutofit, type Slide, type TextElement } from '@seuoffice/pptx-engine'
import { matchesElementRef } from '@seuoffice/pptx-engine/identity'
import {
  EMU_PER_PX_96,
  layoutText,
  makeViewport,
  type RenderSlide,
  type RenderTextLayout,
} from '@seuoffice/pptx-render'
import { getFontMetrics, rebuildSlide, type Session } from './session-state'

function findEl(slide: Slide, sourceId: string): TextElement | undefined {
  const el = slide.elements.find((e) => matchesElementRef(e, sourceId))
  if (el && (el.type === 'text' || el.type === 'shape')) return el as TextElement
  return undefined
}

/**
 * spAutoFit (autofit='resize', "resize shape to fit text"): after a text change, the box height
 * grows/shrinks with the content and is written back to cy; a wrap="none" body (PowerPoint's
 * click-to-type text box) also follows its widest line in cx. rendered = the rebuilt result
 * after this change; when the size changed, update the transform and rebuild once more.
 * Top-level elements only (group children use a different coordinate system, skip).
 */
export function applyAutofitResize(
  session: Session,
  slideIndex: number,
  sourceId: string,
  rendered: RenderSlide | null,
): RenderSlide | null {
  if (!rendered) return rendered
  const slide = session.opened.deck.slides[slideIndex]
  const el = slide ? findEl(slide, sourceId) : undefined
  if (!el?.text || el.text.autofit !== 'resize') return rendered
  const node = rendered.nodes.find((n) => n.sourceId === el.id)
  if (!node || (node.type !== 'shape' && node.type !== 'text') || !node.text) return rendered
  const text = node.text
  const needH = text.contentHeight + text.insets.t + text.insets.b
  const needW = !text.wrap && !text.vert ? nowrapContentWidth(text) : node.box.w
  if (Math.abs(needH - node.box.h) < 1 && Math.abs(needW - node.box.w) < 1) return rendered
  const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
  const scale = session.fitWidthPx / baseWidthPx
  const toEmu = (px: number) => Math.max(Math.round((px / scale) * EMU_PER_PX_96), 1)
  // A nowrap box grows around its alignment: right-aligned text keeps the right edge, centered keeps the center
  const align = text.lines[0]?.align
  const shiftX =
    align === 'right' ? node.box.w - needW : align === 'center' ? (node.box.w - needW) / 2 : 0
  el.transform = {
    ...el.transform,
    offset: {
      ...el.transform.offset,
      x: el.transform.offset.x + Math.round((shiftX / scale) * EMU_PER_PX_96),
      cx: toEmu(needW),
      cy: toEmu(needH),
    },
  }
  el.dirtyTransform = true
  return rebuildSlide(session, slideIndex)
}

/** Box width a nowrap body needs: widest laid-out line plus the insets (an empty body keeps the insets alone). */
function nowrapContentWidth(text: RenderTextLayout): number {
  let left = Infinity
  let right = -Infinity
  for (const line of text.lines)
    for (const run of line.runs) {
      left = Math.min(left, run.x)
      right = Math.max(right, run.x + run.widthPx)
    }
  const content = right > left ? right - left : 0
  return content + text.insets.l + text.insets.r
}

/**
 * normAutofit fontScale write-back: when the shrink ratio the layout actually used after a text
 * edit (≤ the stored cap, shrink-only) differs from the stored model value, sync the model and
 * patch the bodyPr attribute — only then does PowerPoint show the same size on open.
 * Triggered only by text edits (resize gestures do not write: the layout cap locks the stored
 * value, and writing back during a gesture would ratchet one way); top-level elements only.
 */
export function syncAutofitScale(
  session: Session,
  slideIndex: number,
  sourceId: string,
  rendered: RenderSlide | null,
): RenderSlide | null {
  if (!rendered) return rendered
  const slide = session.opened.deck.slides[slideIndex]
  const el = slide ? findEl(slide, sourceId) : undefined
  if (!el?.text || el.text.autofit !== 'shrink') return rendered
  const node = rendered.nodes.find((n) => n.sourceId === el.id)
  if (!node || (node.type !== 'shape' && node.type !== 'text') || !node.text) return rendered
  // The plain render honors the stored fontScale as-is (PowerPoint-on-open semantics);
  // after a text edit, re-run the layout with the autofit ladder enabled to find the
  // ratio PowerPoint would now use (still capped at the stored value).
  const refit = layoutText({
    body: el.text,
    boxWidthPx: node.box.w,
    boxHeightPx: node.box.h,
    metrics: getFontMetrics(),
    vp: makeViewport(session.opened.deck.size, session.fitWidthPx),
    refitAutofit: true,
  })
  const effective = refit.fontScale
  const effectiveRed = refit.lnSpcReduction ?? 0
  if (
    Math.abs(effective - (el.text.fontScale ?? 1)) < 0.005 &&
    Math.abs(effectiveRed - (el.text.lnSpcReduction ?? 0)) < 0.005
  )
    return rendered
  el.text.fontScale = effective
  if (effectiveRed) el.text.lnSpcReduction = effectiveRed
  else delete el.text.lnSpcReduction
  el.anchor.originalXml = patchBodyPrAutofit(el.anchor.originalXml, effective, effectiveRed)
  slide!.structureDirty = true
  // The render above used the pre-edit stored scale; redo it at the written-back value
  return rebuildSlide(session, slideIndex) ?? rendered
}
