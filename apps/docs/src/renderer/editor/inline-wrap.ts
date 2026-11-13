/**
 * Run-level wrapper elements the docx run model keeps as bytes instead of
 * fields (Run.wrap), carried through the editor so that editing a paragraph
 * never drops them:
 *
 * - `inlineWrap` mark: the chain of wrapper elements around the text (inline
 *   content controls, w:smartTag, w:customXml, w:dir, w:bdo). Text typed
 *   inside stays inside. The caret has one position at an edge, so the edges
 *   take sides: text typed at the end of an unlocked content control joins it
 *   (as in Word); at the end of any other wrapper, and at every start, it
 *   lands outside (`endTakesText`). The mark is structure, not formatting:
 *   "clear formatting" leaves it.
 * - the guard: the content of a control locked against editing
 *   (w:lock contentLocked / sdtContentLocked) refuses changes. The control can
 *   still be deleted whole.
 * - one element stays one element: what is inserted in the middle of a
 *   wrapper goes inside it, a paragraph split inside a content control leaves
 *   the control on the first half, and a pasted copy of a content control
 *   arrives without it, so no w:id is ever written twice.
 *
 * Elements without text (w:permStart, range markers, an empty control) are
 * not in the editor document: they stay in the bytes of a paragraph nobody
 * edits and go when it is rewritten, as they always did.
 */
import { Extension, Mark } from '@tiptap/core'
import { Slice, type Mark as PmMark, type Node as PmNode, type ResolvedPos } from '@tiptap/pm/model'
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state'
import { AddMarkStep, RemoveMarkStep, type Step } from '@tiptap/pm/transform'
import {
  inlineWrapContentLocked,
  sameInlineWrap,
  sameInlineWrapChain,
  type InlineWrap,
} from '@seuoffice/docx-engine'
import { notifyOdt, recordOdtRefusal } from '../odt-gate'
import { REDACT_MARK } from '../ai/redact'
import {
  INLINE_WRAP_MARK,
  contentControlKey,
  inlineWrapChainAttr,
  inlineWrapChainOf,
  inlineWrapChainOfDomKey,
  inlineWrapDomKey,
  inlineWrapsInside,
  inlineWrapsWithout,
  sharedInlineWraps,
} from './inline-wrap-chain'

export const InlineWrapMark = Mark.create({
  name: INLINE_WRAP_MARK,
  // the end of a control belongs to it: text typed there, or typed over a
  // selection that starts in it, is text of the control (as in Word). Its start
  // does not, and neither does the end of a locked one (`keepWrappersWhole`).
  inclusive: true,
  // a paragraph started with Enter at the end of a control is outside it
  keepOnSplit: false,
  addAttributes() {
    return { chain: { default: '', rendered: false } }
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-inline-wrap]',
        getAttrs: (el) => {
          const chain = inlineWrapChainOfDomKey(el.getAttribute('data-inline-wrap') ?? '')
          return chain === undefined ? false : { chain }
        },
      },
    ]
  },
  renderHTML({ mark }) {
    // a token, never the bytes: the DOM is what the clipboard and HTML export copy
    return [
      'span',
      { 'data-inline-wrap': inlineWrapDomKey(mark.attrs.chain), class: 'doc-inline-wrap' },
      0,
    ]
  },
})

const NO_WRAPS: InlineWrap[] = []

/** the wrappers an inline node sits in, outermost first */
function wrapsOf(node: PmNode): InlineWrap[] {
  const mark = node.marks.find((m) => m.type.name === INLINE_WRAP_MARK)
  return mark ? inlineWrapChainOf(mark.attrs.chain) : NO_WRAPS
}

/** the content-locked controls an inline node sits in */
function lockedWrapsOf(node: PmNode): InlineWrap[] {
  const wraps = wrapsOf(node)
  return wraps.length === 0 ? NO_WRAPS : wraps.filter(inlineWrapContentLocked)
}

const sitsIn = (node: PmNode, wrap: InlineWrap): boolean =>
  wrapsOf(node).some((w) => sameInlineWrap(w, wrap))

/**
 * Would replacing [from, to) of `doc` be refused for a control locked against
 * editing? Taking part of its text is; so is content put in the middle of it;
 * so is content put where the whole control stood (`inserts`: typing or
 * pasting over a selection that holds it). A range that only removes a control
 * whole is what the lock allows, and so is a range of whole blocks, which is a
 * block being replaced (a document loading, a block rewrite).
 */
export function lockedControlRefuses(
  doc: PmNode,
  from: number,
  to: number,
  inserts: boolean,
): boolean {
  if (from === to) {
    const $pos = doc.resolve(from)
    const before = $pos.nodeBefore
    const after = $pos.nodeAfter
    if (!before || !after) return false
    return lockedWrapsOf(before).some((wrap) => sitsIn(after, wrap))
  }
  let cut = false
  let whole = false
  doc.nodesBetween(from, to, (node, pos, parent, index) => {
    if (cut) return false
    if (!node.isInline || !parent) return true
    for (const wrap of lockedWrapsOf(node)) {
      let start = pos
      let end = pos + node.nodeSize
      for (let i = index - 1; i >= 0 && sitsIn(parent.child(i), wrap); i--) {
        start -= parent.child(i).nodeSize
      }
      for (let i = index + 1; i < parent.childCount && sitsIn(parent.child(i), wrap); i++) {
        end += parent.child(i).nodeSize
      }
      if (start < from || end > to) cut = true
      else whole = true
    }
    return false
  })
  if (cut) return true
  if (!whole || !inserts) return false
  return doc.resolve(from).parent.inlineContent || doc.resolve(to).parent.inlineContent
}

/** does [from, to) of `doc` hold any content-locked text? */
function holdsLockedContent(doc: PmNode, from: number, to: number): boolean {
  let found = false
  doc.nodesBetween(from, to, (node) => {
    if (found) return false
    if (!node.isInline) return true
    if (lockedWrapsOf(node).length > 0) found = true
    return false
  })
  return found
}

/** A control locked against editing inside a range */
export interface LockedControl {
  /** where its content starts */
  from: number
  /**
   * Its text; null when it holds more than plain text under one wrapper chain
   * (a picture, a field, an inner wrapper), which a rewrite from text cannot keep
   */
  text: string | null
  /** the wrapper mark its text carries */
  mark: PmNode['marks'][number]
}

/** the locked controls whose content lies in [from, to) of `doc`, in document order */
export function lockedControlsIn(doc: PmNode, from: number, to: number): LockedControl[] {
  const found: LockedControl[] = []
  let wrap: InlineWrap | undefined
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline) {
      wrap = undefined
      return true
    }
    const locked = lockedWrapsOf(node)[0]
    const mark = node.marks.find((m) => m.type.name === INLINE_WRAP_MARK)
    if (!locked || !mark) {
      wrap = undefined
      return false
    }
    if (!wrap || !sameInlineWrap(wrap, locked)) found.push({ from: pos, text: '', mark })
    wrap = locked
    const control = found[found.length - 1]
    control.text =
      node.isText && control.text !== null && mark.eq(control.mark)
        ? control.text + (node.text ?? '')
        : null
    return false
  })
  return found
}

/** would this step change what a locked control holds or covers? */
function refusedByLock(step: Step, doc: PmNode): boolean {
  if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
    const name = step.mark.type.name
    // a tracked deletion marks the text instead of removing it
    if (name === 'del') {
      return step instanceof AddMarkStep && holdsLockedContent(doc, step.from, step.to)
    }
    if (name !== INLINE_WRAP_MARK) return false
    // the wrapper mark is the control: taking it off its text, putting another
    // in its place, or stretching it over other text changes what the lock covers
    const removes = step instanceof RemoveMarkStep
    const brought = removes
      ? NO_WRAPS
      : inlineWrapChainOf(step.mark.attrs.chain).filter(inlineWrapContentLocked)
    let changed = false
    doc.nodesBetween(step.from, step.to, (node) => {
      if (changed) return false
      if (!node.isInline) return true
      if (lockedWrapsOf(node).length > 0 && step.mark.isInSet(node.marks) === removes) {
        changed = true
      }
      if (brought.some((wrap) => !sitsIn(node, wrap))) changed = true
      return false
    })
    return changed
  }
  const inserts = 'slice' in step && step.slice instanceof Slice && step.slice.size > 0
  let refused = false
  step.getMap().forEach((from, to) => {
    if (!refused && lockedControlRefuses(doc, from, to, inserts)) refused = true
  })
  return refused
}

/**
 * Meta on a transaction that puts clipboard content into the document without
 * going through the editor's own paste (the App's lane that replaces an empty
 * paragraph with pasted blocks): its content is judged as a paste is.
 */
export const PASTED_CONTENT = 'inlineWrapPasted'

/** the meta prosemirror-history puts on an undo or redo transaction (its plugin key) */
const HISTORY_META = 'history$'

const inlineWrapGuardKey = new PluginKey('inlineWrapGuard')

/** did the editor put clipboard or dragged content into the document with `tr`? */
function bringsPastedContent(tr: Transaction): boolean {
  const event: unknown = tr.getMeta('uiEvent')
  return event === 'paste' || event === 'drop' || tr.getMeta(PASTED_CONTENT) === true
}

/**
 * The wrapper whose end takes what is put there (the mark is inclusive): an
 * unlocked content control that shows its own text. Every other wrapper ends
 * where the file has it end, as before the mark was inclusive:
 * - w:smartTag, w:customXml, w:dir, w:bdo: their element is the text it was
 *   read with, and a w:dir or w:bdo would set the direction of typed text;
 * - a locked control (any w:lock): its content may not grow, and nothing
 *   inside it may be cloned around the typed text;
 * - a control showing its placeholder: typed text there is no answer to it;
 * - a control inside a hyperlink: the text behind it would split the link.
 */
function endTakesText(wrap: InlineWrap): boolean {
  return (
    /^<w:sdt[\s>]/.test(wrap.open) &&
    wrap.inside !== 'link' &&
    !/<w:lock\b/.test(wrap.open) &&
    !/<w:showingPlcHdr\b/.test(wrap.open)
  )
}

/**
 * The wrappers text put in at a caret at `$pos` takes from its neighbour and
 * must not sit in. At a wrapper's end the chain is kept from the outside in as
 * long as each wrapper the text behind does not also sit in takes text
 * (`endTakesText`): a w:dir inside a control drops off, a control inside a
 * w:dir goes with it. At the start of a paragraph the text after is the only
 * neighbour, and a start belongs to no wrapper.
 */
function wrapsLeftOutside($pos: ResolvedPos): InlineWrap[] {
  if (!$pos.parent.inlineContent) return NO_WRAPS
  const before = $pos.nodeBefore
  const after = $pos.nodeAfter
  if (!before) return after ? wrapsOf(after) : NO_WRAPS
  const chain = wrapsOf(before)
  let kept = after ? sharedInlineWraps(chain, wrapsOf(after)).length : 0
  while (kept < chain.length && endTakesText(chain[kept]!)) kept++
  return chain.slice(kept)
}

/**
 * The wrappers text typed over [$from, $to) takes and must not sit in. The
 * editor gives typed text the wrappers of the first text it replaces (the mark
 * is inclusive); one whose end takes no text stays only if the text after the
 * selection sits in it, as before the mark was inclusive: a word typed over all
 * of a smart tag's text replaces the tag, and text typed over its last letters
 * lands behind it whole.
 */
function wrapsTypedOverLeftOutside($from: ResolvedPos, $to: ResolvedPos): InlineWrap[] {
  const first = $from.nodeAfter
  if (!$from.parent.inlineContent || !first) return NO_WRAPS
  const after = $to.parent.inlineContent ? $to.nodeAfter : null
  return wrapsOf(first).filter((wrap) => !endTakesText(wrap) && !(after && sitsIn(after, wrap)))
}

/** What one step put into the document, as a range of the document the edits end in */
interface Arrival {
  from: number
  to: number
  /** the wrappers the step cut in two: the content landed in the middle of them */
  cut: InlineWrap[]
  /** the wrappers the content may have taken from its neighbour and does not belong in */
  outside: InlineWrap[]
  /** clipboard or dragged content */
  pasted: boolean
}

/**
 * Keeps one wrapper element one element after the edits in `trs`:
 * - content that landed between two pieces of one wrapper (a line break, a
 *   field, pasted text) goes inside it, or the save would write the wrapper
 *   twice around the halves;
 * - content typed or pasted at the end of a wrapper whose end takes no text,
 *   or at the start of a paragraph that begins with a wrapper, comes out of
 *   it (`wrapsLeftOutside`);
 * - a paragraph split inside a content control leaves the control on the
 *   first half: the save cannot see across paragraphs that both halves carry
 *   the same w:id. Wrappers without an id (w:bdo, w:dir, w:smartTag,
 *   w:customXml) stay on both halves, where each is written as its own element;
 * - pasted or dropped content that brings a content control the document
 *   still holds (a copy: a cut, or a drag that moves, took the original away
 *   first) arrives as its text. Content controls are told apart by their w:id.
 */
function keepWrappersWhole(trs: readonly Transaction[], state: EditorState): Transaction | null {
  const doc = state.doc
  const type = doc.type.schema.marks[INLINE_WRAP_MARK]
  if (!type) return null
  const arrivals: Arrival[] = []
  for (const tr of trs) {
    for (const arrival of arrivals) {
      arrival.from = tr.mapping.map(arrival.from, 1)
      arrival.to = tr.mapping.map(arrival.to, -1)
    }
    // a peer's edit carries its own upkeep; so does this person's when it is
    // re-applied. Undo and redo restore a document that already had its upkeep
    // (and an appended edit would wipe the redo stack).
    if (!tr.docChanged || tr.getMeta('rebased') !== undefined || tr.getMeta(HISTORY_META)) continue
    const pasted = bringsPastedContent(tr)
    tr.steps.forEach((step, i) => {
      const before = tr.docs[i]
      step.getMap().forEach((oldFrom, oldTo, newFrom, newTo) => {
        const $from = before.resolve(oldFrom)
        const $to = before.resolve(oldTo)
        const inside =
          $from.parent.inlineContent && $from.sameParent($to) && $from.nodeBefore && $to.nodeAfter
        const cut = inside
          ? sharedInlineWraps(wrapsOf($from.nodeBefore!), wrapsOf($to.nodeAfter!))
          : NO_WRAPS
        // typed or pasted at a caret; text typed over a selection got its marks
        // as it was typed (`typedOverMarks`), and Replace, the AI and the
        // clipboard bring their own
        const outside = oldFrom === oldTo ? wrapsLeftOutside($from) : NO_WRAPS
        if (cut.length === 0 && outside.length === 0 && !pasted) return
        const rest = tr.mapping.slice(i + 1)
        arrivals.push({
          from: rest.map(newFrom, 1),
          to: rest.map(newTo, -1),
          cut,
          outside,
          pasted,
        })
      })
    })
  }
  const arrived = arrivals.filter((arrival) => arrival.from < arrival.to)
  if (arrived.length === 0) return null

  // the content controls the document holds outside what was pasted
  let held: Set<string> | null = null
  const heldElsewhere = () => {
    if (held) return held
    const pastes = arrived.filter((arrival) => arrival.pasted)
    const controls = new Set<string>()
    doc.descendants((node, pos) => {
      if (!node.isInline) return true
      const end = pos + node.nodeSize
      if (pastes.some((paste) => pos >= paste.from && end <= paste.to)) return false
      for (const wrap of wrapsOf(node)) {
        const key = contentControlKey(wrap)
        if (key !== null) controls.add(key)
      }
      return false
    })
    return (held = controls)
  }

  const marks: Array<{ from: number; to: number; chain: readonly InlineWrap[] }> = []
  for (const { from, to, cut, outside, pasted } of arrived) {
    const $from = doc.resolve(from)
    const $to = doc.resolve(to)
    // only what both sides still sit in: a later step may have changed either
    const around =
      cut.length > 0 && $from.nodeBefore && $to.nodeAfter
        ? sharedInlineWraps(
            cut,
            sharedInlineWraps(wrapsOf($from.nodeBefore), wrapsOf($to.nodeAfter)),
          )
        : NO_WRAPS
    const oneBlock = $from.sameParent($to)
    doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isInline) return true
      const range = { from: Math.max(pos, from), to: Math.min(pos + node.nodeSize, to) }
      const own = wrapsOf(node)
      let chain: readonly InlineWrap[] = own
      if (pasted && own.some((wrap) => contentControlKey(wrap) !== null)) {
        const controls = heldElsewhere()
        chain = own.filter((wrap) => {
          const key = contentControlKey(wrap)
          return key === null || !controls.has(key)
        })
      }
      if (outside.length > 0) chain = inlineWrapsWithout(chain, outside)
      if (oneBlock && around.length > 0) chain = inlineWrapsInside(around, chain)
      if (!sameInlineWrapChain(chain, own)) marks.push({ ...range, chain })
      return false
    })
    const controls = oneBlock ? [] : around.filter((wrap) => contentControlKey(wrap) !== null)
    if (controls.length === 0) continue
    const half = $to.parent
    let pos = to
    for (let i = $to.index(); i < half.childCount; i++) {
      const node = half.child(i)
      const own = wrapsOf(node)
      const kept = inlineWrapsWithout(own, controls)
      if (kept.length === own.length) break
      marks.push({ from: pos, to: pos + node.nodeSize, chain: kept })
      pos += node.nodeSize
    }
  }
  if (marks.length === 0) return null
  // the lock is about what the user changes; this puts back what the edit broke
  const fix = state.tr.setMeta(inlineWrapGuardKey, true)
  // mark steps move no position, so every change applies where it was found
  for (const { from, to, chain } of marks) {
    if (chain.length === 0) fix.removeMark(from, to, type)
    else fix.addMark(from, to, type.create({ chain: inlineWrapChainAttr(chain) }))
  }
  return fix
}

/**
 * The marks text typed over [from, to) gets when a wrapper it would take must
 * stay behind (`wrapsTypedOverLeftOutside`); null when the editor's own marks
 * are right. Only typed text goes through here: a replacement made with its
 * own marks (Replace, the AI, the clipboard) keeps them.
 */
function typedOverMarks(state: EditorState, from: number, to: number): readonly PmMark[] | null {
  const $from = state.doc.resolve(from)
  const $to = state.doc.resolve(to)
  const outside = wrapsTypedOverLeftOutside($from, $to)
  if (outside.length === 0) return null
  const marks = $from.marksAcross($to) ?? []
  const mark = marks.find((m) => m.type.name === INLINE_WRAP_MARK)
  if (!mark) return null
  const chain = inlineWrapsWithout(inlineWrapChainOf(mark.attrs.chain), outside)
  const rest = mark.removeFromSet(marks)
  return chain.length > 0
    ? mark.type.create({ chain: inlineWrapChainAttr(chain) }).addToSet(rest)
    : rest
}

/**
 * Before a composition starts at a caret whose text must land outside a
 * wrapper (`wrapsLeftOutside`): stores the caret's marks without it.
 */
function composeOutside(view: {
  composing: boolean
  state: EditorState
  dispatch: (tr: Transaction) => void
}): void {
  const { selection, storedMarks } = view.state
  if (view.composing || !(selection instanceof TextSelection) || !selection.empty) return
  const outside = wrapsLeftOutside(selection.$from)
  if (outside.length === 0) return
  const marks = storedMarks ?? selection.$from.marks()
  const mark = marks.find((m) => m.type.name === INLINE_WRAP_MARK)
  if (!mark) return
  const chain = inlineWrapsWithout(inlineWrapChainOf(mark.attrs.chain), outside)
  const rest = mark.removeFromSet(marks)
  view.dispatch(
    view.state.tr.setStoredMarks(
      chain.length > 0
        ? mark.type.create({ chain: inlineWrapChainAttr(chain) }).addToSet(rest)
        : rest,
    ),
  )
}

export const InlineWrapGuardExtension = Extension.create({
  name: 'inlineWrapGuard',
  addCommands() {
    return {
      // "Clear formatting" takes every mark off the selection. The wrapper
      // mark is the control around the text, not formatting, and so is the
      // mark that hides the words from AI: both stay.
      unsetAllMarks:
        () =>
        ({ tr, dispatch }) => {
          const { empty, ranges } = tr.selection
          if (empty) return true
          if (dispatch) {
            for (const range of ranges) {
              for (const type of Object.values(tr.doc.type.schema.marks)) {
                if (type.name === INLINE_WRAP_MARK || type.name === REDACT_MARK) continue
                tr.removeMark(range.$from.pos, range.$to.pos, type)
              }
            }
          }
          return true
        },
    }
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: inlineWrapGuardKey,
        filterTransaction: (tr) => {
          if (!tr.docChanged) return true
          // A peer's edit was admitted on the page that made it (a page without
          // this rule included), and the log holds it: refusing it here would
          // leave this page with another document than everyone else's. The
          // same transaction re-applies this person's own unconfirmed edits.
          if (tr.getMeta('rebased') !== undefined) return true
          // this plugin's own upkeep (keepWrappersWhole)
          if (tr.getMeta(inlineWrapGuardKey) === true) return true
          // Undo and redo go back to a document this guard let through. Taken
          // step by step they can look like a change to locked text: undoing
          // the paste of a copy right behind a locked control removes text
          // that sat in the same run as the control's own.
          if (tr.getMeta(HISTORY_META)) return true
          for (let i = 0; i < tr.steps.length; i++) {
            if (!refusedByLock(tr.steps[i], tr.docs[i])) continue
            recordOdtRefusal('lockedControl')
            notifyOdt('appOdtLockedObject')
            return false
          }
          return true
        },
        appendTransaction: (trs, _before, state) => keepWrappersWhole(trs, state),
        props: {
          // Text typed into a locked control is refused here, before it is a
          // transaction. The page reports a click's caret a moment after the
          // click, so a key typed at once arrives as one change that also
          // moves the caret into the control: refusing that change whole
          // (filterTransaction) left the caret where it was before the click,
          // and the next text typed landed there as a real edit. The caret
          // goes where the text was typed instead (a selection typed over
          // stays selected), and nothing is inserted.
          handleTextInput: (view, from, to, text) => {
            if (!lockedControlRefuses(view.state.doc, from, to, true)) {
              // typed over a selection: the text gets the marks it had before
              // the mark was inclusive (`typedOverMarks`)
              const marks = from === to ? null : typedOverMarks(view.state, from, to)
              if (!marks) return false
              view.dispatch(
                view.state.tr.setStoredMarks(marks).insertText(text, from, to).scrollIntoView(),
              )
              return true
            }
            recordOdtRefusal('lockedControl')
            notifyOdt('appOdtLockedObject')
            // over a selection the selection stays, as the text did not replace it
            const kept = TextSelection.create(view.state.doc, from, to)
            if (!view.state.selection.eq(kept)) view.dispatch(view.state.tr.setSelection(kept))
            return true
          },
          handleDOMEvents: {
            // An IME draws its text where the caret's marks put it, and text
            // moved out of a wrapper afterwards (keepWrappersWhole) would be
            // moved under the IME's hands. So the marks are set before the
            // composition starts: it is drawn outside from its first letter.
            compositionstart: (view) => {
              composeOutside(view)
              return false
            },
            compositionupdate: (view) => {
              composeOutside(view)
              return false
            },
          },
        },
        // no transformPasted here: its presence is how the paste actions tell
        // the document editor from a text box or header editor (paste-actions.ts)
      }),
    ]
  },
})
