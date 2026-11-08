import { parseFragment, type DefaultTreeAdapterTypes as T } from 'parse5'
import type { ElementEntry, ParseMap } from '../../document/parse-map'
import { insertOp } from '../../document/insert-presets'
import type { HtmlOp } from '../../document/ops'
import { escapeMathText, renderMath, type MathValue } from './model'

export interface HtmlMathTarget {
  entry: ElementEntry
  value: MathValue
}

/** Read source attributes, never script-mutated preview DOM or a message's LaTeX. */
export function readMath(source: string, entry: ElementEntry): MathValue | null {
  if (!['span', 'div'].includes(entry.tag) || !entry.endTag) return null
  const fragment = parseFragment(source.slice(...entry.startTag) + `</${entry.tag}>`)
  const node = fragment.childNodes[0] as T.Element | undefined
  const attrs = new Map(node && 'attrs' in node ? node.attrs.map((a) => [a.name, a.value]) : [])
  const latex = attrs.get('data-latex')
  if (latex === undefined) return null
  // Unknown future versions must not be silently rewritten by this adapter.
  if (attrs.has('data-gx-math') && attrs.get('data-gx-math') !== '1') return null
  return { latex, display: attrs.get('data-display') === 'true' }
}

/** Descendants of rendered MathML / KaTeX belong to their enclosing source object. */
export function findMath(source: string, map: ParseMap, sid: number | null): HtmlMathTarget | null {
  let entry = sid === null ? undefined : map.bySid.get(sid)
  while (entry) {
    const value = readMath(source, entry)
    if (value) return { entry, value }
    entry = entry.parentSid === null ? undefined : map.bySid.get(entry.parentSid)
  }
  return null
}

/** Static MathML plus original LaTeX: portable HTML, no runtime or network needed. */
export function mathHtml(value: MathValue): string {
  const rendered = renderMath(value)
  return `<span data-gx-math="1" data-latex="${escapeMathText(value.latex)}" data-display="${value.display}" contenteditable="false">${rendered.html}</span>`
}

export function mathEditOps(target: HtmlMathTarget, value: MathValue): HtmlOp[] {
  if (target.value.latex === value.latex && target.value.display === value.display) return []
  const sid = target.entry.sid
  // Attribute-sized patches preserve authored classes, styling and surrounding source.
  return [
    { op: 'set_attr', sid, name: 'data-latex', value: value.latex },
    { op: 'set_attr', sid, name: 'data-display', value: String(value.display) },
    { op: 'set_inner_html', sid, html: renderMath(value).html },
  ]
}

export function mathInsertOp(map: ParseMap, sid: number | null, value: MathValue): HtmlOp | null {
  const entry = sid === null ? undefined : map.bySid.get(sid)
  const html = mathHtml(value)
  // Inline math goes at the end of the selected paragraph, before its closing tag.
  if (
    !value.display &&
    entry?.endTag &&
    /^(p|h[1-6]|li|td|th|blockquote|figcaption)$/.test(entry.tag)
  )
    return { op: 'insert_html', sid: entry.sid, position: 'append', html }
  return insertOp(map, entry, html)
}
