/**
 * The slides editor plugged into the co-editing engine.
 *
 * The page's deck is the confirmed deck with this person's unconfirmed edits applied on top.
 * Remote edits are integrated by replay: the deck goes back to the confirmed state, takes the
 * remote edits in server order, and this person's edits are applied again after them. An edit
 * whose slide a remote edit deleted no longer applies: it stays in the log as an edit that
 * changes nothing, and the person is told. Two edits of the same text box keep the one the
 * server ordered last, whole: text is not merged character by character.
 *
 * The confirmed state is kept as a copy only while this person has unconfirmed edits; with none,
 * the deck itself is the confirmed state and remote edits apply to it directly.
 */
import {
  matchesElementRef,
  slideDurableId,
  type OpenedPptx,
  type TextElement,
} from '@genoffice/pptx-engine'
import type { EditParagraph } from '@genoffice/pptx-ops'
import type { RenderSlide } from '@genoffice/pptx-render'
import type { CollabAdapter } from '@seuoffice/collab/client'
import { applyAutofitResize, syncAutofitScale } from '../main/autofit-writeback'
import { rebuildSlide, type Session } from '../main/session-state'
import type { SlideUpdate } from '../shared/ipc'
import {
  applyOp,
  decodeOp,
  deckFile,
  elementRefOf,
  elementRefs,
  encodeOp,
  fingerprint,
  putState,
  slideIndexOf,
  takeState,
  type Applied,
  type Autofit,
  type DeckState,
  type ElementRef,
  type SlidesEdit,
  type SlidesOp,
} from './collab-ops'

/** Why a person's edit is not in the deck: input is frozen, or a peer removed what it changed */
export type Refusal = 'frozen' | 'gone'

export interface SlidesCollabOptions {
  session: Session
  fileName: string
  /** other people's edits are about to change the deck: until now it is what the renderer shows */
  changing(): void
  /** the deck changed under the renderer: draw what changed */
  refresh(): void
  /** tell the person their edit is not in the deck */
  refused(reason: Refusal): void
}

export interface SlidesCollab {
  adapter: CollabAdapter<SlidesOp>
  /**
   * The element a parse-time id the renderer holds stands for. A replay parses some slides
   * again, so ids the renderer was given before it are looked up as they were then.
   */
  refOf(sourceId: string, groupId?: string): ElementRef | null
  /**
   * Run one person's edit: `apply` changes the deck and returns the op that makes the same
   * change on another page, or null when it changed nothing. Null when input is frozen.
   */
  edit<T extends { op: SlidesOp }>(apply: () => T | null): T | null
}

/** A slide id no slide has: an edit naming it applies as nothing, on every page */
const GONE = '\u0000gone'

const createsSlide = (
  edit: SlidesEdit,
): edit is Extract<SlidesEdit, { kind: 'duplicateSlide' | 'blankSlide' }> =>
  edit.kind === 'duplicateSlide' || edit.kind === 'blankSlide'

/** `op` with every slide it names passed through `to`; `op` itself when none changed */
function renamed(op: SlidesOp, to: (slide: string) => string): SlidesOp {
  const edit = op.edit
  switch (edit.kind) {
    case 'text': {
      const slide = to(edit.at.slide)
      return slide === edit.at.slide ? op : { ...op, edit: { ...edit, at: { ...edit.at, slide } } }
    }
    case 'deleteSlides': {
      const slides = edit.slides.map(to)
      return slides.every((s, i) => s === edit.slides[i])
        ? op
        : { ...op, edit: { ...edit, slides } }
    }
    default: {
      const slide = to(edit.slide)
      return slide === edit.slide ? op : { ...op, edit: { ...edit, slide } }
    }
  }
}

const slideIds = (opened: OpenedPptx): string[] => opened.deck.slides.map(slideDurableId)

/**
 * Apply remote ops in server order; returns the slides they deleted. A part name can come back
 * (a new slide takes the highest free number), so an edit made before such a delete must not
 * reach the newcomer that inherited the name.
 */
function applyRemote(opened: OpenedPptx, remote: SlidesOp[]): Set<string> {
  const gone = new Set<string>()
  for (const op of remote) {
    const before = op.edit.kind === 'deleteSlides' ? slideIds(opened) : []
    applyOp(opened, op)
    if (before.length === 0) continue
    const after = new Set(slideIds(opened))
    for (const id of before) if (!after.has(id)) gone.add(id)
  }
  return gone
}

export function createSlidesCollab(options: SlidesCollabOptions): SlidesCollab {
  const { session } = options
  const deck = (): OpenedPptx => session.opened
  let emit: ((ops: SlidesOp[]) => void) | null = null
  // nothing is reported until the engine says the person may edit
  let frozen = true
  /** the confirmed deck, as a copy and the confirmed ops after it; null while the deck is it */
  let confirmed: { state: DeckState; ops: SlidesOp[] } | null = null
  let unconfirmed = 0
  /** parse-time ids the renderer may still hold, from every state it was shown */
  const seen = new Map<string, ElementRef>()

  /**
   * Apply this person's unconfirmed `local` again on the new confirmed deck. Each op stays (the
   * log holds every op a person sent); one that no longer applies is rewritten to name no slide,
   * so it applies as nothing wherever and whenever it is applied again.
   */
  function replay(local: SlidesOp[], gone: ReadonlySet<string>): SlidesOp[] {
    const names = new Map<string, string>()
    const to = (slide: string): string => names.get(slide) ?? (gone.has(slide) ? GONE : slide)
    let dropped = false
    const kept = local.map((original) => {
      const op = renamed(original, to)
      const applied = applyOp(deck(), op)
      const edit = op.edit
      if (!applied) {
        // an edit naming the slide this one made must not land on a peer's slide of that name
        if (createsSlide(edit)) names.set(edit.made, GONE)
        // told once: an op an earlier replay emptied names no slide left
        if (renamed(original, () => GONE) !== original) dropped = true
        return renamed(op, () => GONE)
      }
      if (!createsSlide(edit) || !applied.made || applied.made === edit.made) return op
      names.set(edit.made, applied.made)
      return { ...op, edit: { ...edit, made: applied.made } }
    })
    if (dropped) options.refused('gone')
    return kept
  }

  const adapter: CollabAdapter<SlidesOp> = {
    encode: encodeOp,
    decode: decodeOp,

    listen(handler) {
      emit = handler
      return () => {
        if (emit === handler) emit = null
      }
    },

    integrate(remote, local) {
      options.changing()
      for (const [key, ref] of elementRefs(deck())) seen.set(key, ref)
      let kept: SlidesOp[] = []
      let gone: Set<string>
      if (local.length === 0) {
        gone = applyRemote(deck(), remote)
      } else {
        const base = confirmed!
        putState(deck(), base.state)
        for (const op of base.ops) applyOp(deck(), op)
        gone = applyRemote(deck(), remote)
        confirmed = { state: takeState(deck()), ops: [] }
        kept = replay(local, gone)
      }
      for (const [key, ref] of seen) if (gone.has(ref.slide)) seen.delete(key)
      unconfirmed = kept.length
      if (unconfirmed === 0) confirmed = null
      options.refresh()
      return kept
    },

    confirmed(ops) {
      confirmed?.ops.push(...ops)
      unconfirmed -= ops.length
      if (unconfirmed <= 0) {
        unconfirmed = 0
        confirmed = null
      }
    },

    fingerprint: () => fingerprint(deck()),

    setEditable(editable) {
      frozen = !editable
    },

    produceFile: async () => ({ fileName: options.fileName, bytes: await deckFile(deck()) }),
  }

  return {
    adapter,

    refOf(sourceId, groupId) {
      return (
        elementRefOf(deck(), sourceId, groupId) ?? seen.get(`${groupId ?? ''}/${sourceId}`) ?? null
      )
    },

    edit(apply) {
      if (frozen || !emit) {
        options.refused('frozen')
        return null
      }
      // the deck is about to stop being the confirmed state: keep that state first
      const base = confirmed ?? { state: takeState(deck()), ops: [] }
      const done = apply()
      if (!done) return null
      confirmed = base
      unconfirmed += 1
      emit([done.op])
      return done
    },
  }
}

// ── a person's edits, as the page makes them ────────────────────────────

/**
 * A text box's new text. The layout this page draws then decides the box size (spAutoFit) or
 * the shrink (normAutofit); that result travels with the edit, since another page lays the
 * text out at its own width.
 */
export function textEdit(
  session: Session,
  id: string,
  at: ElementRef,
  paragraphs: EditParagraph[],
): { op: SlidesOp; applied: Applied } | null {
  const op: SlidesOp = { id, edit: { kind: 'text', at, paragraphs } }
  const applied = applyOp(session.opened, op)
  if (!applied) return null
  if (at.group || applied.levelDirty) return { op, applied }
  const index = slideIndexOf(session.opened, at.slide)
  const find = (): TextElement | undefined =>
    session.opened.deck.slides[index]?.elements.find((e) => matchesElementRef(e, at.el)) as
      TextElement | undefined
  const before = find()
  const offset = before?.transform.offset
  const scale = [before?.text?.fontScale, before?.text?.lnSpcReduction]
  syncAutofitScale(
    session,
    index,
    at.el,
    applyAutofitResize(session, index, at.el, rebuildSlide(session, index)),
  )
  const after = find()
  if (!after) return { op, applied }
  const fit: Autofit = {}
  const o = after.transform.offset
  if (o !== offset) fit.offset = { x: o.x, y: o.y, cx: o.cx, cy: o.cy }
  if (after.text?.fontScale !== scale[0] || after.text?.lnSpcReduction !== scale[1]) {
    fit.fontScale = after.text?.fontScale ?? 1
    fit.lnSpcReduction = after.text?.lnSpcReduction ?? 0
  }
  if (!fit.offset && fit.fontScale === undefined) return { op, applied }
  return { op: { id, edit: { kind: 'text', at, paragraphs, autofit: fit } }, applied }
}

/** A slide added, removed or annotated; a created slide's id goes into the edit */
export function slideEdit(
  session: Session,
  id: string,
  edit: Exclude<SlidesEdit, { kind: 'text' }>,
): { op: SlidesOp; applied: Applied } | null {
  const applied = applyOp(session.opened, { id, edit })
  if (!applied) return null
  const made = createsSlide(edit) && applied.made ? { made: applied.made } : {}
  return { op: { id, edit: { ...edit, ...made } }, applied }
}

// ── what the renderer draws again ───────────────────────────────────────

/** Each slide's render as text, by part path: a slide that draws the same gives the same text */
export type Drawn = ReadonlyMap<string, string>

export const drawnOf = (slides: readonly RenderSlide[]): Drawn =>
  new Map(slides.map((slide) => [slide.partPath ?? '', JSON.stringify(slide)]))

/**
 * What the renderer needs after other people's edits: the order of the slides, and only the
 * slides that draw differently from `before`. The renderer keeps its own objects for the rest
 * (shared/slide-update.ts), so the text box a person is typing in on a slide nobody else
 * touched stays open with what they typed; a whole new deck would open it again from the slide.
 */
export function redrawFrom(before: Drawn, slides: readonly RenderSlide[]): SlideUpdate {
  const now = drawnOf(slides)
  return {
    order: slides.map((slide) => slide.partPath ?? ''),
    slides: slides.filter((slide) => {
      const path = slide.partPath ?? ''
      return before.get(path) !== now.get(path)
    }),
  }
}
