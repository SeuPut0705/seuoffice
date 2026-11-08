/**
 * Footnotes and endnotes (`text:note`).
 *
 * Forward: the citation becomes a `w:footnoteReference`/`w:endnoteReference`
 * run; the body paragraphs are converted by the text layer
 * (`paragraphToOoxml`, owner `objects`) into word/footnotes.xml or
 * word/endnotes.xml. Objects inside a note body are kept, not converted.
 *
 * Save: the reference run writes the original `text:note` when the note's
 * text is unchanged; otherwise the body is rewritten paragraph by paragraph
 * with the text layer (`paragraphToOdf`, origin = the original note
 * paragraph). The docx note is plain text in the editor, so every edited
 * character takes the formatting of the original character it continues. A
 * reference the bridge never had becomes a new `text:note` shaped like the
 * document's other notes; a removed reference removes the note.
 */
import { type Run, parseNotesXml } from '@genoffice/docx-engine'
import type {
  BridgeParagraph,
  EditedParagraph,
  InlineConverter,
  OoxmlToOdfContext,
  ParagraphWriteEnv,
} from '../core/convert'
import { attributeMap, escapeXmlText } from '../core/xml'
import { alignTexts } from '../text/align'
import { originalModel, paragraphToOdf } from '../text/paragraph-odf'
import { paragraphStyleInfo, paragraphToOoxml } from '../text/paragraph-ooxml'
import { paraFormatFromOdf, textFormatFromOdf } from '../text/props'
import { plainTextOf, subElements } from './analyze'
import { type NoteKind, OBJECTS_OWNER, type ObjectNote } from './model'
import { editedNote, forwardState, lazyPart, noteKey, saveState, sourceOf } from './state'

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

const PART: Record<
  NoteKind,
  { path: string; root: string; entry: string; type: string; rel: string }
> = {
  footnote: {
    path: 'word/footnotes.xml',
    root: 'w:footnotes',
    entry: 'w:footnote',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
    rel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes',
  },
  endnote: {
    path: 'word/endnotes.xml',
    root: 'w:endnotes',
    entry: 'w:endnote',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml',
    rel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes',
  },
}

function separators(kind: NoteKind): string {
  const e = PART[kind].entry
  return (
    `<${e} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></${e}>` +
    `<${e} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></${e}>`
  )
}

/** One note entry: the paragraphs, the first one opening with the note's own reference mark. */
function noteEntryXml(kind: NoteKind, id: string, paragraphs: string[]): string {
  const ref = `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${kind}Ref/></w:r>`
  const paras = paragraphs.length ? [...paragraphs] : ['<w:p></w:p>']
  const head =
    /^<w:p>(?:<w:pPr>[\s\S]*?<\/w:pPr>)?(?:<w:bookmarkStart [^>]*\/><w:bookmarkEnd [^>]*\/>)?/.exec(
      paras[0],
    )?.[0] ?? '<w:p>'
  paras[0] = head + ref + paras[0].slice(head.length)
  const e = PART[kind].entry
  return `<${e} w:id="${id}">${paras.join('')}</${e}>`
}

export const noteInlineConverter: InlineConverter = {
  id: OBJECTS_OWNER,
  names: ['text:note'],
  toOoxml(ctx, el, env) {
    if (el.part !== 'content.xml' || el.closeStart <= el.openEnd) return null
    const st = forwardState(ctx)
    if (st.nested > 0) return null
    const info = ctx.part(el.part)
    const subs = subElements(el.xml, info.prefixes, el.openEnd, el.closeStart)
    const top = subs.filter((s) => s.depth === 0)
    const body = top.find((s) => s.name === 'text:note-body')
    const citation = top.find((s) => s.name === 'text:note-citation')
    if (!body) return null
    const noteClass = attributeMap(el.xml, el.nameEnd, el.openEnd, info.prefixes)['text:note-class']
    const kind: NoteKind = noteClass === 'endnote' ? 'endnote' : 'footnote'
    const id = String(++st.noteSeq[kind])

    const paragraphs: number[] = []
    const paraXml: string[] = []
    let editable = true
    st.nested++
    try {
      for (const child of subs.filter(
        (s) => s.depth === 1 && s.start >= body.openEnd && s.end <= body.closeStart,
      )) {
        if (child.name === 'text:p' || child.name === 'text:h') {
          const { xml, paragraph } = paragraphToOoxml(ctx, child, {
            part: el.part,
            owner: OBJECTS_OWNER,
            block: null,
          })
          paragraphs.push(paragraph.id)
          paraXml.push(xml)
        } else editable = false
      }
    } finally {
      st.nested--
    }
    const entry = noteEntryXml(kind, id, paraXml)
    const root = PART[kind].root
    const text = parseNotesXml(`<${root}>${entry}</${root}>`, kind)[0]?.text ?? ''
    st.noteEntries[kind].push(entry)
    lazyPart(
      ctx,
      PART[kind].path,
      PART[kind].type,
      PART[kind].rel,
      () =>
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<${root} ${W_NS}>${separators(kind)}${st.noteEntries[kind].join('')}</${root}>`,
    )
    const record: ObjectNote = {
      id,
      kind,
      start: el.start,
      end: el.end,
      bodyStart: body.openEnd,
      bodyEnd: body.closeStart,
      citation: citation
        ? plainTextOf(el.xml, info.prefixes, citation.openEnd, citation.closeStart)
        : '',
      bodyFirst: !citation || body.start < citation.start,
      paragraph: env.paragraphId,
      paragraphs,
      text,
      editable,
    }
    st.ext.notes.push(record)
    // the docx engine numbers references in body order; notes convert in that order
    return {
      kind: 'xml',
      xml: `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${kind}Reference w:id="${id}"/></w:r>`,
      text: id,
    }
  },
}

// ---------------------------------------------------------------------------
// Save

/** The engine-visible text of a paragraph record: no tabs/breaks, a first paragraph without leading space. */
function engineMap(text: string, first: boolean): { text: string; at: number[] } {
  const at: number[] = []
  for (let i = 0; i < text.length; i++) if (!'\t\n\f'.includes(text[i])) at.push(i)
  let engine = at.map((i) => text[i]).join('')
  if (first) {
    const lead = engine.length - engine.replace(/^\s+/, '').length
    at.splice(0, lead)
    engine = engine.slice(lead)
  }
  return { text: engine, at }
}

/** Runs for `text` carrying, per character, the formatting of the original character it continues. */
function runsLike(rctx: OoxmlToOdfContext, record: BridgeParagraph, text: string): Run[] {
  const model = originalModel(rctx, record)
  if (!model) return text ? [{ text }] : []
  const style = paragraphStyleInfo(rctx, record.part, record.styleName)
  const fonts = rctx.part(record.part).fontFaces
  const align = alignTexts(record.text, text)
  const setAt = (i: number): number => {
    if (!record.text.length) return model.emptySet
    const idx = Math.max(0, Math.min(record.text.length - 1, align.originalOf(i)))
    for (let k = idx; k >= 0; k--) if (model.charSets[k] >= 0) return model.charSets[k]
    for (let k = idx; k < model.charSets.length; k++)
      if (model.charSets[k] >= 0) return model.charSets[k]
    return model.emptySet
  }
  const formatOf = (set: number): Run => {
    const s = model.sets[set]
    const run: Run = { text: '', ...textFormatFromOdf({ ...style.ownText, ...s.attrs }, fonts) }
    if (s.href !== null) run.link = { href: s.href, plain: true }
    return run
  }
  const runs: Run[] = []
  let last = -2
  for (let i = 0; i < text.length; i++) {
    const set = setAt(i)
    if (set === last) runs[runs.length - 1].text += text[i]
    else {
      runs.push({ ...formatOf(set), text: text[i] })
      last = set
    }
  }
  return runs
}

function editedParagraphFor(
  rctx: OoxmlToOdfContext,
  record: BridgeParagraph,
  runs: Run[],
): EditedParagraph {
  const style = paragraphStyleInfo(rctx, record.part, record.styleName)
  const model = originalModel(rctx, record)
  return {
    type: record.element === 'text:h' ? 'heading' : 'paragraph',
    level: model?.outlineLevel ?? undefined,
    runs,
    rawPPr: record.pPr,
    styleId: style.styleId,
    format: paraFormatFromOdf(style.ownParagraph, style.tabStops, style.marginLeft),
  }
}

/** One original note paragraph with its engine text changed from `before` to `after`. */
function rewriteParagraph(
  rctx: OoxmlToOdfContext,
  record: BridgeParagraph,
  before: string,
  after: string,
  first: boolean,
): string {
  const T = record.text
  const map = engineMap(T, first)
  let full: string
  if (map.text !== before) {
    full = after
  } else {
    const O = map.text
    let p = 0
    while (p < O.length && p < after.length && O[p] === after[p]) p++
    let s = 0
    while (
      s < O.length - p &&
      s < after.length - p &&
      O[O.length - 1 - s] === after[after.length - 1 - s]
    )
      s++
    const start = p > 0 ? map.at[p - 1] + 1 : map.at.length ? map.at[0] : T.length
    let end = s > 0 ? map.at[O.length - s] : p < O.length ? map.at[O.length - 1] + 1 : start
    if (end < start) end = start
    full = T.slice(0, start) + after.slice(p, after.length - s) + T.slice(end)
  }
  return paragraphToOdf(
    rctx,
    editedParagraphFor(rctx, record, runsLike(rctx, record, full)),
    record,
    {
      part: record.part,
    },
  )
}

/** A new note paragraph shaped like `template` (the paragraph before it, or another note's). */
function newParagraph(
  rctx: OoxmlToOdfContext,
  text: string,
  template: BridgeParagraph | null,
): string {
  const runs: Run[] = []
  if (text) {
    if (template) {
      const like = runsLike(rctx, template, template.text + text).slice(-1)[0]
      runs.push({ ...like, text })
    } else runs.push({ text })
  }
  const para: EditedParagraph = template
    ? { ...editedParagraphFor(rctx, template, runs), type: 'paragraph', rawPPr: undefined }
    : { type: 'paragraph', runs }
  return paragraphToOdf(rctx, para, null, {
    part: 'content.xml',
    neighbour: template,
    follows: template,
  })
}

/** The note body for the edited text, reusing unchanged original paragraphs byte for byte. */
function rewriteBody(rctx: OoxmlToOdfContext, note: ObjectNote, text: string): string {
  const records = note.paragraphs.map((id) => rctx.map.paragraphs[id]).filter(Boolean)
  const xml = rctx.part('content.xml').xml
  const before = note.text.split('\n')
  const after = text.split('\n')
  const n = records.length
  const m = after.length
  let p = 0
  while (p < n && p < m && after[p] === before[p]) p++
  let s = 0
  while (s < n - p && s < m - p && after[m - 1 - s] === before[n - 1 - s]) s++
  const out: string[] = []
  for (let i = 0; i < p; i++) out.push(xml.slice(records[i].start, records[i].end))
  let template: BridgeParagraph | null = p > 0 ? records[p - 1] : null
  for (let k = 0; k < m - p - s; k++) {
    const i = p + k
    if (i < n - s) {
      out.push(rewriteParagraph(rctx, records[i], before[i] ?? '', after[i], i === 0))
      template = records[i]
    } else out.push(newParagraph(rctx, after[i], template ?? records[0] ?? null))
  }
  if (m - p - s < n - p - s) rctx.warn('paragraphs deleted from a note were removed')
  for (let i = n - s; i < n; i++) out.push(xml.slice(records[i].start, records[i].end))
  return out.join('')
}

/** The citation of a new note: the number, written like the document's other citations. */
function citationFor(
  rctx: OoxmlToOdfContext,
  kind: NoteKind,
  id: string,
  template: ObjectNote | null,
): string {
  const n = rctx.edited.noteNumbers?.[`${kind}:${id}`]
  const number = n === undefined ? id : String(n)
  if (template && /\d+/.test(template.citation)) return template.citation.replace(/\d+/, number)
  return number
}

/** Writes the `text:note` for a note reference run of an edited paragraph. */
export function notesRunWriter(
  rctx: OoxmlToOdfContext,
  ref: NonNullable<Run['noteRef']>,
  _env: ParagraphWriteEnv,
): string {
  const st = saveState(rctx)
  const key = noteKey(ref.kind, ref.id)
  const note = st.notes.get(key)
  const edited = editedNote(rctx, ref.kind, ref.id)
  if (note) {
    if (st.emittedNotes.has(key)) {
      rctx.warn('a repeated note reference was dropped')
      return ''
    }
    st.emittedNotes.add(key)
    const original = sourceOf(rctx, 'content.xml', note.start, note.end)
    if (!edited || edited.text === note.text) return original
    if (!note.editable) {
      rctx.warn('a note holding more than paragraphs keeps its original text')
      return original
    }
    const xml = rctx.part('content.xml').xml
    return (
      xml.slice(note.start, note.bodyStart) +
      rewriteBody(rctx, note, edited.text) +
      xml.slice(note.bodyEnd, note.end)
    )
  }
  if (!edited) {
    rctx.warn('dropped a note reference without a note')
    return ''
  }
  st.emittedNotes.add(key)
  const template =
    st.ext.notes.find((x) => x.kind === ref.kind && x.paragraphs.length) ??
    st.ext.notes.find((x) => x.paragraphs.length) ??
    null
  const templatePara = template ? (rctx.map.paragraphs[template.paragraphs[0]] ?? null) : null
  const body = edited.text
    .split('\n')
    .map((t) => newParagraph(rctx, t, templatePara))
    .join('')
  const citation = `<text:note-citation>${escapeXmlText(citationFor(rctx, ref.kind, ref.id, template))}</text:note-citation>`
  const noteBody = `<text:note-body>${body}</text:note-body>`
  const inner = (template?.bodyFirst ?? false) ? noteBody + citation : citation + noteBody
  return `<text:note text:note-class="${ref.kind}">${inner}</text:note>`
}
