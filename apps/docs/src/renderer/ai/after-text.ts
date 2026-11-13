import type { Mark, Node as PmNode } from '@tiptap/pm/model'
import { placeholderSource, REDACT_MARK } from './redact'

const FIELD_MARKS = new Set(['instrField', 'refField'])

/**
 * right after the first `afterText` in the live text whose end is not inside a field result (inserting there would split the field).
 *
 * The words a person hid from AI are not text the model can anchor on: a match
 * that reaches into them is no match, and is answered as a plain miss. Finding
 * one would tell the model that the hidden words hold what it guessed, and an
 * error that quotes the block must quote what the model was shown (each hidden
 * run as its placeholder), never the words themselves.
 */
export function posAfterText(
  block: PmNode,
  contentStart: number,
  afterText: string,
  blockLabel: string,
): { pos: number } | { error: string } {
  const chars: number[] = []
  const fields: Array<Mark | undefined> = []
  const hidden: boolean[] = []
  let text = ''
  // the text as the model reads it: each hidden run as its placeholder
  let view = ''
  let viewLabel: string | null = null
  block.descendants((child, offset) => {
    if (!child.isText || child.marks.some((m) => m.type.name === 'del')) return true
    const field = child.marks.find((m) => FIELD_MARKS.has(m.type.name))
    const mark = child.marks.find((m) => m.type.name === REDACT_MARK)
    const start = contentStart + offset
    for (let i = 0; i < (child.text ?? '').length; i++) {
      chars.push(start + i)
      fields.push(field)
      hidden.push(mark !== undefined)
    }
    text += child.text ?? ''
    if (!mark) {
      view += child.text ?? ''
      viewLabel = null
    } else {
      const label = String(mark.attrs.label ?? 'private')
      if (label !== viewLabel) view += placeholderSource(label)
      viewLabel = label
    }
    return true
  })
  let splits: Mark | undefined
  for (let at = text.indexOf(afterText); at >= 0; at = text.indexOf(afterText, at + 1)) {
    const end = at + afterText.length - 1
    // a match that reaches into hidden words is no match
    if (hidden.slice(at, end + 1).some(Boolean)) continue
    const field = fields[end]
    const next = fields[end + 1]
    if (field && next && field.eq(next)) {
      splits ??= field
      continue
    }
    return { pos: chars[end]! + 1 }
  }
  if (splits) {
    const label = splits.type.name === 'refField' ? `REF ${splits.attrs.name}` : splits.attrs.instr
    return {
      error: `afterText "${afterText}" ends inside the field { ${label} }; include the whole field result or choose text outside it`,
    }
  }
  return {
    error: `afterText "${afterText}" does not occur in ${blockLabel} ("${view.slice(0, 60)}")`,
  }
}
