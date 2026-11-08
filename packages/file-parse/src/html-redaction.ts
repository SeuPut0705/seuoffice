import { parse, type DefaultTreeAdapterTypes as T } from 'parse5'
import { sanitizeLabel } from '@genoffice/agent-core/redact-core'
import { RedactionMarkError } from './redaction-error'

/**
 * Withheld regions of an HTML page, read as another file's material.
 *
 * The HTML editor stores three marks in the page itself and hands its own model
 * `{{label}}` in their place (apps/html `ai/redact.ts`):
 *
 * | mark | placed on | withholds |
 * |---|---|---|
 * | `data-gx-redact="label"` | any element | that element's content |
 * | `data-gx-redact-<attr>="label"` | any element | that attribute's value |
 * | `/*gx:redact:label*\/` | inside a `<script>` | the string literal after it |
 *
 * What is withheld here has to be what the editor withholds, so this is the same
 * walk over the same parser's source locations, restated because this package
 * cannot import an app. The tests feed both the same examples.
 *
 * One thing is added on top. The editor's scan reads the raw start tag with an
 * exact-case pattern, so a mark the HTML parser does see (a valueless
 * `data-gx-redact`, an upper-case name) can slip past it and withhold nothing.
 * In the editor that is the reader's own model seeing their own page; here it
 * would be the page leaving for another conversation. So every mark the parser
 * reports is checked against the scan, and one the scan did not honour fails the
 * read (`RedactionMarkError`).
 */

/** Attribute marking an element's own content. */
const MARK_ATTR = 'data-gx-redact'
/** Prefix for marking one attribute's value: `data-gx-redact-src="label"`. */
const MARK_ATTR_PREFIX = 'data-gx-redact-'
const SCRIPT_MARK_RE = /\/\*gx:redact:([^]*?)\*\//g
/** anything that could be one of the three marks, in any case the parser folds */
const ANY_MARK_RE = /data-gx-redact|gx:redact:/i

const ATTR_RE = /([^\s"'>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/dg

interface Span {
  rawFrom: number
  rawTo: number
  label: string
}

interface SourceElement {
  node: T.Element
  startTag: [number, number]
  /** content between the start tag and the end tag (or the implied end) */
  inner: [number, number]
}

function isElement(node: T.Node): node is T.Element {
  return 'tagName' in node && typeof (node as T.Element).tagName === 'string'
}

/**
 * Elements with a source location, in document order, deduped by start-tag
 * offset (the adoption agency re-creates formatting elements that share one
 * start tag). An explicit stack rather than recursion: a hostile page nests
 * deeper than the call stack allows.
 */
function sourceElements(source: string): SourceElement[] {
  const doc = parse(source, { sourceCodeLocationInfo: true })
  const out: SourceElement[] = []
  const seen = new Set<number>()
  const stack: T.Node[] = [doc]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (isElement(node)) {
      const loc = node.sourceCodeLocation
      if (loc?.startTag && !seen.has(loc.startTag.startOffset)) {
        seen.add(loc.startTag.startOffset)
        const startTag: [number, number] = [loc.startTag.startOffset, loc.startTag.endOffset]
        const innerEnd = loc.endTag ? loc.endTag.startOffset : Math.max(startTag[1], loc.endOffset)
        out.push({ node, startTag, inner: [startTag[1], innerEnd] })
      }
    }
    const children: T.Node[] = 'childNodes' in node ? [...node.childNodes] : []
    if (isElement(node) && node.tagName === 'template') {
      const content = (node as T.Template).content
      if (content) children.push(...content.childNodes)
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!)
  }
  return out
}

/** An attribute's value range inside a start tag, in source coordinates, or null. */
function attrValueRange(
  startTagXml: string,
  tagStart: number,
  name: string,
): [number, number] | null {
  for (const m of startTagXml.matchAll(ATTR_RE)) {
    if (m[1] !== name) continue
    // 1 = name, then one group per quoting style: "…" , '…', bare
    const group = m[2] !== undefined ? 2 : m[3] !== undefined ? 3 : 4
    const at = m.indices?.[group]
    if (!at) continue
    return [tagStart + at[0], tagStart + at[1]]
  }
  return null
}

/** every attribute name in a start tag, in order */
function attrNames(startTagXml: string): string[] {
  const head = startTagXml.replace(/^<[\w:-]+/, '')
  const re = /([^\s"'>/=]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  const names: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(head))) names.push(m[1]!)
  return names
}

/** the next string literal after `from`, or null */
function stringLiteralAt(src: string, from: number): { innerFrom: number; innerTo: number } | null {
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (c !== '"' && c !== "'" && c !== '`') continue
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') {
        j++
        continue
      }
      if (src[j] === c) return { innerFrom: i + 1, innerTo: j }
      if (src[j] === '\n' && c !== '`') break
    }
  }
  return null
}

/** every withheld region of the page, in the coordinates of the source */
function collectWithheld(source: string): Span[] {
  const out: Span[] = []
  const scriptInner: Array<[number, number]> = []

  for (const e of sourceElements(source)) {
    const startTag = source.slice(e.startTag[0], e.startTag[1])
    if (e.node.tagName === 'script') scriptInner.push(e.inner)

    // data-gx-redact="label" → this element's content
    const own = attrValueRange(startTag, e.startTag[0], MARK_ATTR)
    if (own) {
      out.push({ rawFrom: e.inner[0], rawTo: e.inner[1], label: source.slice(own[0], own[1]) })
    }

    // data-gx-redact-<attr>="label" → that one attribute's value
    const reached = new Set<string>()
    for (const name of attrNames(startTag)) {
      if (!name.startsWith(MARK_ATTR_PREFIX)) continue
      const target = name.slice(MARK_ATTR_PREFIX.length)
      if (!target) continue
      const mark = attrValueRange(startTag, e.startTag[0], name)
      const range = attrValueRange(startTag, e.startTag[0], target)
      if (!range) continue
      reached.add(target.toLowerCase())
      if (range[0] === range[1]) continue
      out.push({
        rawFrom: range[0],
        rawTo: range[1],
        label: mark ? source.slice(mark[0], mark[1]) : target,
      })
    }

    // the parser's own attribute list is the witness: a mark it reports that
    // the scan above did not honour would hand the words over
    for (const attr of e.node.attrs) {
      const name = attr.name.toLowerCase()
      if (name === MARK_ATTR) {
        if (!own && e.inner[1] > e.inner[0]) {
          throw new RedactionMarkError(`a ${MARK_ATTR} mark on <${e.node.tagName}> cannot be read`)
        }
      } else if (name.startsWith(MARK_ATTR_PREFIX)) {
        const target = name.slice(MARK_ATTR_PREFIX.length)
        const held = e.node.attrs.find((a) => a.name.toLowerCase() === target)
        // no such attribute, or an empty one: the mark has nothing to withhold
        if (held && held.value !== '' && !reached.has(target)) {
          throw new RedactionMarkError(`a ${name} mark on <${e.node.tagName}> cannot be read`)
        }
      }
    }
  }

  // /*gx:redact:label*/ inside a real <script> → the string literal after it
  SCRIPT_MARK_RE.lastIndex = 0
  for (let m = SCRIPT_MARK_RE.exec(source); m; m = SCRIPT_MARK_RE.exec(source)) {
    const at = m.index
    const script = scriptInner.find(([a, b]) => at >= a && at < b)
    if (!script) continue
    const lit = stringLiteralAt(source, at + m[0].length)
    // the editor withholds nothing for a mark with no literal after it, and
    // whatever literal comes next when that one is past the script: either way
    // the value the mark was put in front of is not the one being withheld
    if (!lit || lit.innerTo > script[1]) {
      throw new RedactionMarkError('a script mark has no string literal after it')
    }
    out.push({ rawFrom: lit.innerFrom, rawTo: lit.innerTo, label: m[1] ?? '' })
  }

  return outermost(out)
}

/** Keep the outermost regions only, so the same range is never withheld twice. */
function outermost(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.rawFrom - b.rawFrom || b.rawTo - a.rawTo)
  const out: Span[] = []
  for (const s of sorted) {
    if (s.rawTo <= s.rawFrom) continue
    if (out.some((k) => s.rawFrom >= k.rawFrom && s.rawTo <= k.rawTo)) continue
    out.push(s)
  }
  return out.sort((a, b) => a.rawFrom - b.rawFrom)
}

/**
 * The marker a page's label reads as. The stricter cleaning is the editor's: a
 * page's label can sit in a script comment, where `*` and `/` would end it.
 */
function placeholderSource(label: string): string {
  return `{{${sanitizeLabel(label, { forComment: true }) || 'private'}}}`
}

/** the page's source with every withheld region replaced by its `{{label}}` marker */
export function redactHtmlSource(source: string): string {
  if (!ANY_MARK_RE.test(source)) return source
  const parts: string[] = []
  let cursor = 0
  for (const s of collectWithheld(source)) {
    // two regions can overlap without one holding the other; the words between
    // the cursor and this one are already gone, so nothing is sliced backwards
    parts.push(source.slice(cursor, Math.max(cursor, s.rawFrom)), placeholderSource(s.label))
    cursor = Math.max(cursor, s.rawTo)
  }
  parts.push(source.slice(cursor))
  return parts.join('')
}
