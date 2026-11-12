import { decodeEntities, decodeNumericCharRefs } from './parse-xml-text'
import { applyRevisionResolutions } from './revision-xml'
import { patchParagraphTexts } from './text-patch'
import type { NoteInfo, NoteRun } from './types'
import {
  attrsOf,
  childrenOf,
  escapeXmlAttr,
  escapeXmlText,
  findChildren,
  serializeXNode,
  type XNode,
} from './xml-utils'
import { placeholderSource } from '@seuoffice/agent-core/redact-core'
import { parseEntry, runsText, withheldText } from './withheld'

/**
 * Footnotes / endnotes part handling (word/footnotes.xml, word/endnotes.xml).
 *
 * Both parts share one schema: a list of w:footnote / w:endnote elements.
 * Entries carrying a w:type attribute (separator, continuationSeparator, ...)
 * are structural and must be preserved; only typeless entries are real notes.
 */

export type NoteKind = 'footnote' | 'endnote'

const ROOT: Record<NoteKind, string> = { footnote: 'w:footnotes', endnote: 'w:endnotes' }
const ENTRY: Record<NoteKind, string> = { footnote: 'w:footnote', endnote: 'w:endnote' }

export const NOTE_PART_PATH: Record<NoteKind, string> = {
  footnote: 'word/footnotes.xml',
  endnote: 'word/endnotes.xml',
}

export const NOTE_REL_TYPE: Record<NoteKind, string> = {
  footnote: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes',
  endnote: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes',
}

export const NOTE_CONTENT_TYPE: Record<NoteKind, string> = {
  footnote: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
  endnote: 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml',
}

const NOTE_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

/**
 * Root attributes for a regenerated part. Entries are spliced back in as original bytes, so
 * the root has to keep declaring whatever prefixes those bytes use: Word puts w14:paraId on
 * every paragraph it writes, and a literal namespace list leaves that prefix unbound.
 *
 * `required` lists namespaces the rebuild itself emits (e.g. w14 on rebuilt comments): they
 * are appended when the reused original root does not declare them, since an original from
 * a non-Word producer may bind fewer prefixes than our generated markup uses.
 */
export function rootAttributes(
  originalXml: string | null,
  rootTag: string,
  fallback: string,
  required: Record<string, string> = {},
): string {
  const attrs = originalXml
    ? new RegExp(`<${rootTag}\\b([^>]*?)/?>`).exec(originalXml)?.[1]?.trim()
    : undefined
  const base = attrs && attrs.includes('xmlns:') ? attrs : fallback
  const missing = Object.entries(required)
    .filter(([prefix]) => !base.includes(`xmlns:${prefix}=`))
    .map(([prefix, uri]) => ` xmlns:${prefix}="${uri}"`)
    .join('')
  return base + missing
}

/**
 * The note's self-reference mark run (`<w:footnoteRef/>` / `<w:endnoteRef/>`).
 * Tolerates the spaced self-closing form (`<w:footnoteRef />`, .NET XmlWriter /
 * Open XML SDK output) and the open/close pair; the exact `<w:footnoteRef/>`
 * match hid every note number in such documents.
 */
const NOTE_REF_MARK_RE = /<w:(?:footnote|endnote)Ref\b\s*\/?>/

/** one note paragraph read through the document's run extraction and property resolver */
export interface NoteParagraph {
  /** display runs, the self-reference mark run excluded */
  runs: NoteRun[]
  /** w:pStyle of the paragraph */
  styleId?: string
  /** before / after / line resolved through the style chain and docDefaults */
  spacing: NonNullable<NoteInfo['spacing']>
}

/** supplied by the document parser; without it notes carry plain text only */
export type NoteParagraphReader = (pXml: string) => NoteParagraph

/**
 * A note's text as a model may read it, from its display runs: each run hidden
 * from AI as its placeholder (neighbours under one label as one), undefined
 * when no run hides anything. Kept in step with the runs when a person accepts
 * or rejects a change in the note.
 */
export function noteModelText(richParas: readonly NoteRun[][]): string | undefined {
  if (!richParas.some((runs) => runs.some((r) => r.redact !== undefined && !r.del)))
    return undefined
  return richParas
    .map((runs) => {
      let line = ''
      let label: string | undefined
      for (const run of runs) {
        if (run.del) continue
        if (run.redact === undefined) line += run.text
        else if (run.redact !== label) line += placeholderSource(run.redact)
        label = run.redact
      }
      return line
    })
    .join('\n')
}

/** real notes (separator entries excluded), in file order */
export function parseNotesXml(xml: string, kind: NoteKind, read?: NoteParagraphReader): NoteInfo[] {
  // the entries as the parser finds them: markup inside CDATA is text, not a note
  const root = parseEntry(xml)
  const entries = root ? findChildren(root, ENTRY[kind]) : []
  return entries.flatMap((entry) => {
    const attrs = attrsOf(entry)
    if (attrs['w:type'] !== undefined) return [] // separator / continuation entries
    const id = attrs['w:id']
    // an entry with no body at all (<w:footnote w:id="1"/>) is no note
    if (!id || childrenOf(entry).length === 0) return []
    const text = noteTreeText(entry)
    // each run hidden from AI as its placeholder, or the whole note withheld
    // when a mark sits where no run accounts for it
    const modelText = withheldText(entry, noteTreeText)
    // the entry as the parser read it, for the readers below that take XML
    const entryXml = serializeXNode(entry)
    const paras = read ? noteParagraphsOf(entryXml).map(read) : []
    const first = paras[0]
    const richParas = paras.map((p) => p.runs)
    // the first paragraph opens with the self-reference mark and a spacer; a
    // spacer that was its own run empties out and is dropped entirely
    if (richParas[0]?.[0]) {
      richParas[0][0] = { ...richParas[0][0], text: richParas[0][0].text.replace(/^\s+/, '') }
      if (richParas[0][0].text === '') richParas[0].shift()
    }
    const styleId = first ? first.styleId : /<w:pStyle w:val="([^"]+)"/.exec(entryXml)?.[1]
    // Word draws the entry number only where a self-reference mark run exists
    // (empty-body notes keep their line but show no numeral — Word probe 2026-09-01)
    const noRefMark = !NOTE_REF_MARK_RE.test(entryXml)
    return {
      id,
      text,
      ...(modelText !== undefined && modelText !== text ? { modelText } : {}),
      ...(first ? { richParas } : {}),
      ...(styleId ? { styleId } : {}),
      ...(/ADDIN\s+(?:ZOTERO_|CSL_)/.test(entryXml) ? { zoteroField: true as const } : {}),
      ...(first ? { spacing: first.spacing } : {}),
      ...(noRefMark ? { noRefMark: true as const } : {}),
    }
  })
}

/** the entry's paragraph slices in order (self-closing form first: the
 *  open-to-close alternative would swallow it) */
function noteParagraphsOf(entryXml: string): string[] {
  return entryXml.match(/<w:p(?:\s[^>]*)?\/>|<w:p[\s>][\s\S]*?<\/w:p>/g) ?? []
}

/**
 * Every entry of a notes part with its exact XML slice, found the way the
 * parser finds them: any quotes, white space around = and before >, `>` or
 * `/>` inside a value, and nothing inside a comment or CDATA taken for a tag.
 * The save keeps an entry's bytes only when it finds it here; one it misses
 * is written anew from plain text and loses its runs, a hidden-from-AI mark
 * among them.
 */
function noteSlicesOf(
  xml: string,
  kind: NoteKind,
): Array<{ id: string | undefined; typed: boolean; xml: string }> {
  const out: Array<{ id: string | undefined; typed: boolean; xml: string }> = []
  const tokens = new RegExp(
    `<!--[\\s\\S]*?-->|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|<\\?[\\s\\S]*?\\?>|` +
      `<(/?)${ENTRY[kind]}\\b((?:[^>"']|"[^"]*"|'[^']*')*?)(/?)>`,
    'g',
  )
  let open: { start: number; attrs: string } | null = null
  let m: RegExpExecArray | null
  while ((m = tokens.exec(xml)) !== null) {
    if (m[2] === undefined) continue // a comment, CDATA or a processing instruction
    if (m[1] !== '/') {
      // a self-closing entry has no body: it is no note, and nothing to keep
      if (m[3] !== '/') open = { start: m.index, attrs: m[2] }
      continue
    }
    if (!open) continue
    const attr = (name: string) => {
      const v = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(open!.attrs)
      return v ? decodeEntities(v[1] ?? v[2]!) : undefined
    }
    out.push({
      id: attr('w:id'),
      typed: attr('w:type') !== undefined,
      xml: xml.slice(open.start, tokens.lastIndex),
    })
    open = null
  }
  return out
}

/** typeless (real) note entries with their exact XML slice and their text as the parser reads it */
function noteEntriesOf(
  xml: string,
  kind: NoteKind,
): Array<{ id: string; text: string; xml: string }> {
  return noteSlicesOf(xml, kind).flatMap(({ id, typed, xml: entryXml }) =>
    typed || !id ? [] : [{ id, text: entryText(entryXml), xml: entryXml }],
  )
}

/** a note slice's text as the parser reads it (the pattern's reading when it does not parse) */
function entryText(entryXml: string): string {
  const node = parseEntry(entryXml)
  return node ? noteTreeText(node) : noteEntryPlainText(entryXml)
}

/** a parsed note's text: its paragraphs' run text, the first one's leading spacer dropped */
function noteTreeText(entry: XNode): string {
  const paras = findChildren(entry, 'w:p').map((p) => decodeNumericCharRefs(runsText(p)))
  if (paras.length > 0) paras[0] = paras[0]!.replace(/^\s+/, '')
  return paras.join('\n')
}

/** paragraph texts joined with newlines; the first paragraph starts with the self-reference mark + a spacer */
function noteEntryPlainText(innerXml: string): string {
  const paras = noteParagraphsOf(innerXml).map(notePlainText)
  if (paras.length > 0) paras[0] = paras[0].replace(/^\s+/, '')
  return paras.join('\n')
}

function notePlainText(xml: string): string {
  const texts: string[] = []
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) texts.push(m[1])
  return decodeEntities(texts.join(''))
}

/** default separator entries required by Word when the part is created fresh */
function separatorEntries(kind: NoteKind): string {
  const entry = ENTRY[kind]
  return (
    `<${entry} w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></${entry}>` +
    `<${entry} w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></${entry}>`
  )
}

/** one rich display run → run XML (size/font/bold…; save-side of NoteRun) */
function noteRunXml(run: NoteRun): string {
  const props: string[] = []
  const fonts: string[] = []
  if (run.fontAscii) {
    fonts.push(
      `w:ascii="${escapeXmlAttr(run.fontAscii)}" w:hAnsi="${escapeXmlAttr(run.fontAscii)}"`,
    )
  }
  if (run.font) fonts.push(`w:eastAsia="${escapeXmlAttr(run.font)}"`)
  if (fonts.length > 0) props.push(`<w:rFonts ${fonts.join(' ')}/>`)
  if (run.bold) props.push('<w:b/>')
  if (run.italic) props.push('<w:i/>')
  if (run.underline) props.push('<w:u w:val="single"/>')
  if (run.strike) props.push('<w:strike/>')
  if (run.color) props.push(`<w:color w:val="${escapeXmlAttr(run.color)}"/>`)
  if (run.sizeHalfPoints) {
    props.push(`<w:sz w:val="${run.sizeHalfPoints}"/><w:szCs w:val="${run.sizeHalfPoints}"/>`)
  }
  const rPr = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : ''
  const textTag = run.del ? 'w:delText' : 'w:t'
  return `<w:r>${rPr}<${textTag} xml:space="preserve">${escapeXmlText(run.text)}</${textTag}></w:r>`
}

type NoteRev = NonNullable<NoteRun['ins']>
const noteRevKey = (r: NoteRun) =>
  r.ins || r.del ? JSON.stringify([r.ins ?? null, r.del ?? null]) : ''

/** w:ins / w:del attributes with ids unique across one notes part (kept
 *  original entries included, so a rebuilt entry never reuses their ids) */
type NoteRevAttrs = (info: NoteRev) => string
function noteRevAllocator(originalXml: string | null): NoteRevAttrs {
  let seq = 7001
  const emitted = new Set<string>()
  for (const m of (originalXml ?? '').matchAll(/<w:(?:ins|del)\s[^>]*?\bw:id="([^"]*)"/g)) {
    emitted.add(m[1])
  }
  return (info) => {
    let id = info.id && !emitted.has(info.id) ? info.id : String(seq++)
    while (emitted.has(id)) id = String(seq++)
    emitted.add(id)
    return (
      ` w:id="${escapeXmlAttr(id)}" w:author="${escapeXmlAttr(info.author)}"` +
      (info.date ? ` w:date="${escapeXmlAttr(info.date)}"` : '')
    )
  }
}

/** rich runs → run XML; consecutive runs of one tracked change share a w:ins / w:del wrapper */
function noteRunsXml(runs: NoteRun[], attrs: NoteRevAttrs): string {
  let out = ''
  for (let g = 0; g < runs.length;) {
    const key = noteRevKey(runs[g])
    let end = g
    while (end < runs.length && noteRevKey(runs[end]) === key) end++
    const { ins, del } = runs[g]
    const inner = runs.slice(g, end).map(noteRunXml).join('')
    const wrapped = del ? `<w:del${attrs(del)}>${inner}</w:del>` : inner
    out += ins ? `<w:ins${attrs(ins)}>${wrapped}</w:ins>` : wrapped
    g = end
  }
  return out
}

function noteEntryXml(kind: NoteKind, note: NoteInfo, revAttrs: NoteRevAttrs): string {
  const entry = ENTRY[kind]
  const refTag = kind === 'footnote' ? 'w:footnoteRef' : 'w:endnoteRef'
  if (note.richParas?.length) {
    // rich rebuild (P17): runs keep their measured size/font, the reference
    // mark + spacer shrink to the first run's size, and the paragraph pins
    // single spacing — a note rendered from measured source content must not
    // inflate past its source area via template docDefaults (after=120,
    // line=276) or a body-sized marker run
    const paras = note.richParas.map((runs, i) => {
      const sz = runs[0]?.sizeHalfPoints
      const szXml = sz ? `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` : ''
      const refRun =
        i === 0
          ? `<w:r><w:rPr><w:vertAlign w:val="superscript"/>${szXml}</w:rPr><${refTag}/></w:r>` +
            `<w:r>${sz ? `<w:rPr>${szXml}</w:rPr>` : ''}<w:t xml:space="preserve"> </w:t></w:r>`
          : ''
      const pPr = '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
      return `<w:p>${pPr}${refRun}${noteRunsXml(runs, revAttrs)}</w:p>`
    })
    return `<${entry} w:id="${escapeXmlAttr(note.id)}">${paras.join('')}</${entry}>`
  }
  const paras = note.text.split('\n').map((line, i) => {
    // OOXML convention: the note body starts with the self-reference mark
    const refRun =
      i === 0
        ? `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><${refTag}/></w:r>` +
          '<w:r><w:t xml:space="preserve"> </w:t></w:r>'
        : ''
    const textRun =
      line === '' ? '' : `<w:r><w:t xml:space="preserve">${escapeXmlText(line)}</w:t></w:r>`
    return `<w:p>${refRun}${textRun}</w:p>`
  })
  return `<${entry} w:id="${escapeXmlAttr(note.id)}">${paras.join('')}</${entry}>`
}

/**
 * Regenerate the notes part from the full desired list. Structural entries
 * (separator/continuation) from the original part are kept byte-identical;
 * when there is no original part, standard separators are created.
 * Surgical: existing entries whose text is unchanged keep their original bytes (inline
 * formatting, images, and hyperlinks are preserved); entries with changed text first try
 * an in-paragraph w:t-level patch (formatting still preserved), and only fall back to a
 * plain-text rebuild when patching fails (paragraph count changed, etc.).
 */
export function buildNotesXml(
  kind: NoteKind,
  notes: NoteInfo[],
  originalXml: string | null,
): string {
  let structural = ''
  const originals = new Map<string, { text: string; xml: string }>()
  if (originalXml) {
    structural = noteSlicesOf(originalXml, kind)
      .filter((e) => e.typed)
      .map((e) => e.xml)
      .join('')
    for (const e of noteEntriesOf(originalXml, kind)) originals.set(e.id, e)
  }
  if (!structural) structural = separatorEntries(kind)
  const revAttrs = noteRevAllocator(originalXml)
  const body = notes
    .map((n) => {
      let orig = originals.get(n.id)
      if (!orig) return noteEntryXml(kind, n, revAttrs)
      if (n.revisionsResolved?.length) {
        const xml = applyRevisionResolutions(orig.xml, n.revisionsResolved)
        orig = { text: entryText(xml), xml }
      }
      if (orig.text === n.text) return orig.xml
      const patched = patchParagraphTexts(orig.xml, n.text, {
        stripFirstParaLeadingSpace: true,
      })
      return patched ?? noteEntryXml(kind, n, revAttrs)
    })
    .join('')
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<${ROOT[kind]} ${rootAttributes(originalXml, ROOT[kind], NOTE_NS)}>${structural}${body}</${ROOT[kind]}>`
  )
}

/** next free numeric note id (separator ids -1/0 and existing notes considered) */
export function nextNoteId(notes: NoteInfo[]): string {
  let max = 0
  for (const note of notes) {
    const n = parseInt(note.id, 10)
    if (Number.isFinite(n)) max = Math.max(max, n)
  }
  return String(max + 1)
}
