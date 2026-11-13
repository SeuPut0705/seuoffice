import { Mark, type Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { REDACT_EL } from '@seuoffice/docx-engine'
import { REDACT_MARK } from '../ai/redact'
import { recordOdtRefusal } from '../odt-gate'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    docsRedaction: {
      /** withhold the current selection from the model */
      setRedaction: (label: string) => ReturnType
      /** stop withholding, keeping the text */
      unsetRedaction: () => ReturnType
    }
  }
}

/** 0.75pt solid line, the same weight the docs border UI offers */
const BDR = { val: 'single', sz: 6, color: '6B4FC0' }

/**
 * A mark over the real words, so the reader keeps their data and only the
 * model's view changes.
 *
 * ## How it is stored
 *
 * The visual is a plain character border (`w:bdr`) on the run — real OOXML, so
 * Word renders the words with a line under them and round-trips the mark
 * without this app. The *label* rides alongside in a custom element inside the
 * run's `rPr`, which the docx engine keeps verbatim (`rawRPr`): the save path
 * compares each modelled group against the original bytes and writes back what
 * it does not manage, so an element the model never mentions survives
 * untouched. A comment in marks.ts already relies on the same property for
 * `w:em` and `w:textOutline`.
 *
 * `inclusive: false` stops the mark from swallowing what the reader types at
 * its edge, which would silently withhold their next word.
 *
 * ## What the model sees
 *
 * Nothing here: the placeholder is substituted in redact-view.ts, on the
 * request path only. A save writes the words and the border, never `{{…}}`.
 */
export const DocRedaction = Mark.create({
  name: REDACT_MARK,
  inclusive: false,
  exitable: true,
  spanning: false,

  addAttributes() {
    return {
      label: { default: 'private' },
      /**
       * The complete run properties: the w:bdr Word draws plus the custom
       * element carrying the label. The save path writes this back verbatim,
       * so the mark needs no separate modelling.
       */
      rawRPr: { default: null as string | null, rendered: false },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-redaction]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      {
        'data-redaction': '',
        'data-label': String(HTMLAttributes.label ?? 'private'),
        class: 'redact-span',
      },
      0,
    ]
  },

  addCommands() {
    return {
      setRedaction:
        (label: string) =>
        ({ tr, dispatch }) => {
          const clean = label.trim()
          if (!clean) return false
          if (dispatch) {
            // tr.selection, not editor.state: the dialog chains setTextSelection
            // to re-assert the captured range before this command runs
            tr.addMark(
              tr.selection.from,
              tr.selection.to,
              this.type.create({
                label: clean,
                // the label has to live in the file, not only in the editor
                rawRPr: `<w:rPr><w:bdr w:val="${BDR.val}" w:sz="${BDR.sz}" w:color="${BDR.color}"/><${REDACT_EL} w:label="${escapeXmlAttr(clean)}"/></w:rPr>`,
              }),
            )
            dispatch(tr)
          }
          return true
        },
      unsetRedaction:
        () =>
        ({ editor, tr, dispatch }) => {
          const { from, to, empty, $from } = editor.state.selection
          // no selection: clear across the block the caret is in
          const range = empty
            ? { from: $from.pos, to: $from.pos + $from.parent.content.size }
            : { from, to }
          if (dispatch) {
            tr.removeMark(range.from, range.to, this.type)
            dispatch(tr)
          }
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('redactionModelEditGuard'),
        filterTransaction: (tr) => {
          if (modelEditDepth === 0 || !tr.docChanged) return true
          if (!removesHidden(tr.before, tr.doc)) return true
          recordOdtRefusal('hiddenContent')
          return false
        },
      }),
    ]
  },
})

let modelEditDepth = 0

/**
 * Runs a model's edit: while it runs, a transaction that would take away
 * anything a person hid from AI (the words, a hidden picture or block, or the
 * mark itself) is refused, and the refusal becomes the tool call's error. The
 * person's own edits are never held back.
 */
export function asModelEdit<T>(run: () => T): T {
  modelEditDepth++
  try {
    return run()
  } finally {
    modelEditDepth--
  }
}

/** how many of each hidden character, picture or block a document holds, per label */
function hiddenInventory(doc: PmNode): Map<string, number> {
  const counts = new Map<string, number>()
  const add = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
  doc.descendants((node) => {
    const mark = node.marks.find((m) => m.type.name === REDACT_MARK)
    const label = mark ? String(mark.attrs.label) : node.attrs.redact
    if (typeof label !== 'string') return true
    if (node.isText) for (const ch of node.text!) add(`${label}\u0000${ch}`)
    else add(`${label}\u0000<${node.type.name}>`)
    return !node.isAtom
  })
  return counts
}

function removesHidden(before: PmNode, after: PmNode): boolean {
  const kept = hiddenInventory(after)
  for (const [key, count] of hiddenInventory(before)) if ((kept.get(key) ?? 0) < count) return true
  return false
}

/**
 * Whether any part of a range carries the redaction mark.
 *
 * The un-hide entry needs this before it can be offered: a reader who hid a
 * span weeks ago and no longer remembers where would otherwise have no way back
 * short of deleting the words, which is the state this branch exists to undo.
 *
 * Overlap is the test, not equality, because a selection that clips the edge of
 * a hidden span is still part of one — and `unsetRedaction` clears the whole
 * selection, so offering the entry on a partial selection does what it says.
 *
 * A bare caret answers false, and that needs no guard here: a range with
 * `from === to` holds no marked text, so ProseMirror reports false whatever the
 * document carries. That is the behaviour the menu relies on — the reader has
 * to select the words, as they did to hide them, and an entry point that
 * appeared under a collapsed caret would clear nothing.
 */
export function hasRedactionIn(editor: Editor, from: number, to: number): boolean {
  const type = editor.state.schema.marks[REDACT_MARK]
  if (!type) return false
  return editor.state.doc.rangeHasMark(from, to, type)
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
