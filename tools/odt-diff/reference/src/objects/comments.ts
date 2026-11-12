/**
 * Existing comments (`office:annotation` … `office:annotation-end`).
 *
 * Forward: each annotation becomes a real docx comment (word/comments.xml,
 * plain text) anchored by `w:commentRangeStart`/`w:commentRangeEnd` over the
 * commented text, which stays ordinary editable text. An annotation without
 * an end is anchored by its reference alone.
 *
 * Save: the comment's own bytes are kept; its start and end are re-placed on
 * the edited text — over the runs the editor still marks with the comment
 * when the range lives in one paragraph, else at the mapped offsets of the
 * original positions. When all commented text was deleted (or the editor
 * dropped the comment) the comment is deleted. New comments and comment
 * edits are not saved into an ODT (the editor disables them); a new comment
 * that arrives anyway is dropped with a warning.
 */
import type {
  EditedParagraph,
  InlineConverter,
  OoxmlToOdfContext,
  ParagraphInjector,
  ParagraphWriteEnv,
} from '../core/convert'
import { pairAnnotations } from '../core/body'
import { attributeMap, escapeXmlAttr, escapeXmlText } from '../core/xml'
import { readParagraph } from '../text/paragraph-model'
import { plainTextOf, subElements } from './analyze'
import { OBJECTS_OWNER, type ObjectComment } from './model'
import { forwardState, lazyPart, saveState, sourceOf } from './state'

const COMMENTS_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'
const COMMENTS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'

export const annotationInlineConverter: InlineConverter = {
  id: OBJECTS_OWNER,
  names: ['office:annotation'],
  toOoxml(ctx, el, env) {
    if (el.part !== 'content.xml') return null
    const st = forwardState(ctx)
    if (st.nested > 0) return null
    if (!st.annotationEnds) {
      st.annotationEnds = new Map()
      for (const pair of pairAnnotations(ctx.doc.body))
        if (pair.end) st.annotationEnds.set(pair.annotation.start, pair.end)
    }
    const info = ctx.part(el.part)
    const attrs = attributeMap(el.xml, el.nameEnd, el.openEnd, info.prefixes)
    const subs =
      el.closeStart > el.openEnd
        ? subElements(el.xml, info.prefixes, el.openEnd, el.closeStart)
        : []
    const top = subs.filter((s) => s.depth === 0)
    const textOf = (name: string) => {
      const s = top.find((x) => x.name === name)
      return s ? plainTextOf(el.xml, info.prefixes, s.openEnd, s.closeStart).trim() : ''
    }
    const author = textOf('dc:creator')
    const date = textOf('dc:date')
    const paragraphs = top
      .filter((s) => s.name === 'text:p' || s.name === 'text:h')
      .map((s) => readParagraph({ info, styles: ctx.doc.styles }, s).text)
    const id = String(st.commentSeq++)
    const end = st.annotationEnds.get(el.start) ?? null
    const record: ObjectComment = {
      id,
      name: attrs['office:name'] ?? null,
      start: el.start,
      end: el.end,
      endStart: end?.start ?? null,
      endEnd: end?.end ?? null,
      paragraph: env.paragraphId,
      offset: env.offset,
      endParagraph: null,
      endOffset: null,
      ranged: false,
      text: paragraphs.join('\n'),
    }
    st.ext.comments.push(record)
    if (end) st.commentByEnd.set(end.start, record)
    const dateAttr = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.exec(date)?.[0]
    const paras = (paragraphs.length ? paragraphs : ['']).map((t) =>
      t ? `<w:p><w:r><w:t xml:space="preserve">${escapeXmlText(t)}</w:t></w:r></w:p>` : '<w:p/>',
    )
    st.comments.push(
      `<w:comment w:id="${id}" w:author="${escapeXmlAttr(author)}"` +
        (dateAttr ? ` w:date="${dateAttr}"` : '') +
        (author ? ` w:initials="${escapeXmlAttr([...author][0])}"` : '') +
        `>${paras.join('')}</w:comment>`,
    )
    lazyPart(
      ctx,
      'word/comments.xml',
      COMMENTS_TYPE,
      COMMENTS_REL,
      () =>
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
        `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${st.comments.join('')}</w:comments>`,
    )
    return {
      kind: 'xml',
      xml: end
        ? `<w:commentRangeStart w:id="${id}"/>`
        : `<w:r><w:commentReference w:id="${id}"/></w:r>`,
      text: '',
    }
  },
}

export const annotationEndInlineConverter: InlineConverter = {
  id: OBJECTS_OWNER,
  names: ['office:annotation-end'],
  toOoxml(ctx, el, env) {
    if (el.part !== 'content.xml') return null
    const st = forwardState(ctx)
    if (st.nested > 0) return null
    const record = st.commentByEnd.get(el.start)
    if (!record) return null
    record.endParagraph = env.paragraphId
    record.endOffset = env.offset
    record.ranged = !(record.paragraph === env.paragraphId && record.offset === env.offset)
    return {
      kind: 'xml',
      xml: `<w:commentRangeEnd w:id="${record.id}"/><w:r><w:commentReference w:id="${record.id}"/></w:r>`,
      text: '',
    }
  },
}

// ---------------------------------------------------------------------------
// Save

/** Comment ids the edited body still marks anywhere (ranges or references). */
function survivingComments(rctx: OoxmlToOdfContext): Set<string> {
  const st = saveState(rctx)
  if (!st.surviving) {
    const ids = new Set<string>()
    const re = /<w:comment(?:RangeStart|RangeEnd|Reference)\b[^>]*\bw:id\s*=\s*"([^"]+)"/g
    for (const b of rctx.edited.blocks) {
      for (const m of (b.originalXml ?? '').matchAll(re)) ids.add(m[1])
      for (const r of b.runs ?? []) for (const id of r.commentIds ?? []) ids.add(id)
    }
    st.surviving = ids
  }
  return st.surviving
}

/**
 * The comment was deleted: the editor dropped it, or all text of a range
 * within one paragraph is gone. A range across paragraphs lives on while its
 * paragraphs do (the editor keeps no position for its ends).
 */
function isDeleted(rctx: OoxmlToOdfContext, c: ObjectComment): boolean {
  if (!(rctx.edited.comments ?? []).some((x) => x.id === c.id)) return true
  return c.ranged && c.endParagraph === c.paragraph && !survivingComments(rctx).has(c.id)
}

/** The start of the paragraph holding a comment's annotation survived (as it was, or rewritten). */
function startKept(rctx: OoxmlToOdfContext, c: ObjectComment): boolean {
  const st = saveState(rctx)
  if (st.commentStarted.has(c.id)) return true
  const element = rctx.map.elements.find((e) => e.paragraph === c.paragraph)
  return element ? rctx.matched.has(element.id) : true
}

export const commentInjector: ParagraphInjector = {
  id: OBJECTS_OWNER,
  inject(rctx: OoxmlToOdfContext, para: EditedParagraph, env: ParagraphWriteEnv) {
    const st = saveState(rctx)
    const out: Array<{ offset: number; xml: string; attach: 'prev' | 'next' }> = []
    // where the editor still marks each comment in this paragraph
    const marked = new Map<string, { from: number; to: number }>()
    let offset = 0
    for (const run of para.runs) {
      for (const id of run.commentIds ?? []) {
        const r = marked.get(id)
        if (r) r.to = offset + run.text.length
        else marked.set(id, { from: offset, to: offset + run.text.length })
      }
      offset += run.text.length
    }
    for (const id of marked.keys())
      if (!st.comments.has(id))
        rctx.warn('dropped a new comment: ODT documents keep only their own comments')
    if (!st.comments.size) return out
    const origin = env.origin
    const start = (c: ObjectComment, at: number) => {
      out.push({ offset: at, xml: sourceOf(rctx, 'content.xml', c.start, c.end), attach: 'next' })
      st.commentStarted.add(c.id)
    }
    const end = (c: ObjectComment, at: number) => {
      if (c.endStart === null || c.endEnd === null) return
      out.push({
        offset: at,
        xml: sourceOf(rctx, 'content.xml', c.endStart, c.endEnd),
        attach: 'prev',
      })
      st.commentDone.add(c.id)
    }
    for (const c of st.comments.values()) {
      const ownStart = origin !== null && c.paragraph === origin.id
      const ownEnd = origin !== null && c.endParagraph === origin.id
      const here = marked.get(c.id)
      if (!ownStart && !ownEnd && !here) continue
      if (isDeleted(rctx, c)) continue
      const oneParagraph = c.endParagraph === c.paragraph
      if (c.ranged && oneParagraph) {
        // the comment goes where the editor still marks it (the first such paragraph)
        if (here && !st.commentStarted.has(c.id)) {
          start(c, here.from)
          end(c, here.to)
        }
        continue
      }
      if (ownStart && !st.commentStarted.has(c.id)) start(c, env.mapOffset(c.offset, 'start'))
      if (ownEnd && !oneParagraph && c.endOffset !== null && !st.commentDone.has(c.id)) {
        if (startKept(rctx, c)) end(c, env.mapOffset(c.endOffset, 'end'))
        else rctx.warn('a comment whose start was deleted lost its end too')
      }
    }
    return out
  },
}
