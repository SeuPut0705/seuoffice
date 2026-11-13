import {
  hasRedactExtIn,
  notesPathForSlide,
  type OpenedPptx,
  type Slide,
  type SlideElement,
} from '@seuoffice/pptx-engine'
import {
  GuidedError,
  matchesElementRef,
  resolveGroupChildId,
  resolveSlide,
  type Op,
  type OpContext,
} from './registry'

/**
 * Keep an agent's ops off text a person hid from AI.
 *
 * An agent reads a hidden run as its `{{label}}` and never sees the words, so an op that
 * writes into the element holding it (or drops the element, or the page) can only destroy
 * words it was never shown. The slide editor's own AI guard refuses the same ops
 * (apps/slides `redact-guard.ts`); this is that guard for the command line and the MCP
 * tools, run by the executor before each op when the transaction asks for it.
 *
 * `findReplace` is not refused but made blind to the hidden words (see
 * `ReplaceOptions.skipWithheld`): a refusal, or a count, for a search that hits only hidden
 * words would tell the agent that they are there.
 */

/** Ops that write into an element's content: touching a withheld element with one costs the person their words. */
const CONTENT_OPS = new Set([
  'setText',
  'deleteElement',
  'setTableCell',
  'tableMerge',
  'tableStructure',
  'ungroupElement',
  'replacePicture',
  'addMedia',
  'insertEquation',
  'pasteElements',
  'setShapeCustomGeometry',
  'setChart',
])

type Paragraphs =
  ReadonlyArray<{ runs: ReadonlyArray<{ redact?: string | undefined }> }> | undefined

function labelInParagraphs(paragraphs: Paragraphs): string | undefined {
  for (const p of paragraphs ?? []) for (const r of p.runs) if (r.redact) return r.redact
  return undefined
}

/** The label of whatever the element withholds (itself, a run, a cell, a group's descendant), if anything. */
export function withheldLabel(el: SlideElement): string | undefined {
  if (el.redact) return el.redact
  if (el.type === 'text' || el.type === 'shape') return labelInParagraphs(el.text?.paragraphs)
  if (el.type === 'table') {
    for (const row of el.rows) {
      for (const cell of row) {
        const hit = labelInParagraphs(cell.text?.paragraphs)
        if (hit) return hit
      }
    }
    return undefined
  }
  if (el.type === 'group') {
    for (const child of el.children) {
      const hit = withheldLabel(child)
      if (hit) return hit
    }
  }
  return undefined
}

function withheldOnSlide(slide: Slide): string | undefined {
  for (const el of slide.elements) {
    const hit = withheldLabel(el)
    if (hit) return hit
  }
  return undefined
}

/** The element an op addresses (a group's child when the op says `group`), or undefined. */
function targetOf(op: Op, ctx: OpContext, slide: Slide): SlideElement | undefined {
  const ref = op.target?.el
  if (typeof ref !== 'string' || !ref) return undefined
  if (typeof op.group === 'string' && op.group) {
    const group = slide.elements.find(
      (x) => x.type === 'group' && matchesElementRef(x, op.group as string),
    )
    if (group?.type !== 'group') return undefined
    const id = resolveGroupChildId(slide, group.id, ref)
    return group.children.find((c) => c.id === id)
  }
  return slide.elements.find((x) => matchesElementRef(x, ref))
}

const refuse = (label: string, what: string): never => {
  throw new GuidedError(
    `this ${what} would overwrite text withheld from AI ({{${label}}}). Its words stay in the deck; ` +
      `work around the placeholder instead of replacing it.`,
  )
}

/** Throws a GuidedError when `op` would damage text withheld from AI; returns quietly otherwise. */
export function guardWithheld(op: Op, ctx: OpContext): void {
  let slide: Slide
  try {
    slide = resolveSlide(ctx, op, { allowPart: true }).slide
  } catch {
    // an op that names no slide fails on its own terms
    return
  }
  if (CONTENT_OPS.has(op.op)) {
    const el = targetOf(op, ctx, slide)
    const label = el && withheldLabel(el)
    if (label) refuse(label, `${op.op} edit`)
    return
  }
  if (op.op === 'deleteSlide') {
    const label = withheldOnSlide(slide)
    if (label) refuse(label, 'page delete')
    // the notes are the page's too
  }
  if (op.op === 'deleteSlide' || op.op === 'setNotes') {
    const notes = notesPathForSlide(ctx.opened.archive, slide.path)
    const xml = notes ? ctx.opened.archive.readText(notes) : null
    if (xml && hasRedactExtIn(xml))
      refuse('private', op.op === 'setNotes' ? 'notes edit' : 'page delete')
  }
}

/** The label of text withheld from AI anywhere on the slide, notes included, or undefined. */
export function slideWithheldLabel(opened: OpenedPptx, slide: Slide): string | undefined {
  const onSlide = withheldOnSlide(slide)
  if (onSlide) return onSlide
  const notes = notesPathForSlide(opened.archive, slide.path)
  const xml = notes ? opened.archive.readText(notes) : null
  return xml && hasRedactExtIn(xml) ? 'private' : undefined
}
