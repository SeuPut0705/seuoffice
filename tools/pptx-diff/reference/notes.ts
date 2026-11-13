/**
 * Speaker notes (notesSlide) read/write — archive surgery, same approach as
 * duplicateSlide.
 *
 * - Read: slide rels → notesSlide part → body placeholder <a:t> text (\n-separated).
 * - Write: patch the existing notesSlide's body txBody; if there is no notesSlide,
 *   create one (creating a notesMaster too if needed and registering it in
 *   presentation.xml).
 * All changes land in archive.entries: savePptx persists automatically, and the
 * main process's snapshot-style undo (shallow copy of entries) covers them.
 */
import type { OpenedPptx } from './index'
import { relsPathFor, resolveTarget, type PackageArchive } from './zip'
import {
  attributeOf,
  decodeXml,
  elementRange,
  escapeXmlAttr,
  escapeXmlText,
  hasContentTypeOverride,
  maxRelationshipIdNumber,
  rootPrefixOf,
} from './xml-utils'

const XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'

const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NOTES_SLIDE_REL = `${REL_BASE}/notesSlide`
const NOTES_MASTER_REL = `${REL_BASE}/notesMaster`
const SLIDE_REL = `${REL_BASE}/slide`
const THEME_REL = `${REL_BASE}/theme`

const NOTES_SLIDE_CT = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml'
const NOTES_MASTER_CT =
  'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml'

function setEntry(archive: PackageArchive, path: string, xml: string): void {
  archive.entries.set(path, Buffer.from(xml, 'utf8'))
}

/**
 * Text or an attribute value read off raw XML, as XML reads it (`decodeXml`): one pass, so
 * `&amp;lt;` is the four characters `&lt;`. Never applied to a value the parser returned.
 */
export const unescapeXml = decodeXml

/** Path of the slide's notesSlide part (null if there is no notes slide). */
export function notesPathForSlide(archive: PackageArchive, slidePath: string): string | null {
  for (const rel of archive.readRels(slidePath).values()) {
    if (rel.type === NOTES_SLIDE_REL) return resolveTarget(slidePath, rel.target)
  }
  return null
}

/**
 * The prefixes a notes slide part binds PresentationML and DrawingML to (`p:` and `a:` as this
 * engine writes them, '' for a default namespace, or any other); null when it binds either to
 * none at its root, and the part is then neither read nor written.
 */
function notesPrefixes(xml: string): { p: string; a: string } | null {
  const p = rootPrefixOf(xml, NS_P)
  const a = rootPrefixOf(xml, NS_A)
  return p === null || a === null ? null : { p, a }
}

/** Find the body placeholder sp block in the notesSlide xml. */
function findBodySp(xml: string, p: string): { xml: string; start: number; end: number } | null {
  for (let sp = elementRange(xml, `${p}sp`); sp; sp = elementRange(xml, `${p}sp`, sp.end)) {
    const spXml = xml.slice(sp.start, sp.end)
    const ph = elementRange(spXml, `${p}ph`)
    if (ph && attributeOf(spXml.slice(ph.start, ph.end), 'type') === 'body') {
      return { xml: spXml, start: sp.start, end: sp.end }
    }
  }
  return null
}

/** The content of each element named `name` in `xml`, in document order. */
function contentsOf(xml: string, name: string): string[] {
  const out: string[] = []
  for (let at = elementRange(xml, name); at; at = elementRange(xml, name, at.end)) {
    out.push(xml.slice(at.contentStart, at.contentEnd))
  }
  return out
}

/** Read notes as plain text (body placeholder paragraphs joined by \n); '' if none. */
export function getSlideNotes(archive: PackageArchive, slidePath: string): string {
  const notesPath = notesPathForSlide(archive, slidePath)
  if (!notesPath) return ''
  const xml = archive.readText(notesPath)
  if (!xml) return ''
  const prefixes = notesPrefixes(xml)
  if (!prefixes) return ''
  const { p, a } = prefixes
  const body = findBodySp(xml, p)
  if (!body) return ''
  const tx = contentsOf(body.xml, `${p}txBody`)[0]
  if (!tx) return ''
  const paras = contentsOf(tx, `${a}p`).map((para) =>
    contentsOf(para, `${a}t`)
      .map((t) => unescapeXml(t))
      .join(''),
  )
  // Drop trailing empty paragraphs (PowerPoint templates often carry an empty placeholder paragraph)
  while (paras.length && paras[paras.length - 1] === '') paras.pop()
  return paras.join('\n')
}

/** text (\n-separated) → notes txBody, under the part's prefixes. */
function buildNotesTxBody(text: string, p: string, a: string): string {
  const empty = `<${a}p><${a}endParaRPr lang="zh-CN"/></${a}p>`
  const lines = text.split(/\r\n|\r|\n/)
  const paras = lines.every((l) => l === '')
    ? empty
    : lines
        .map((line) =>
          line === ''
            ? empty
            : `<${a}p><${a}r><${a}rPr lang="zh-CN" dirty="0"/><${a}t>${escapeXmlText(line)}</${a}t></${a}r></${a}p>`,
        )
        .join('')
  return `<${p}txBody><${a}bodyPr/><${a}lstStyle/>${paras}</${p}txBody>`
}

/** The body placeholder of a notes slide, holding `txBody`, under the part's prefixes. */
function notesBodySp(p: string, a: string, txBody: string): string {
  return (
    `<${p}sp><${p}nvSpPr><${p}cNvPr id="3" name="Notes Placeholder"/>` +
    `<${p}cNvSpPr><${a}spLocks noGrp="1"/></${p}cNvSpPr>` +
    `<${p}nvPr><${p}ph type="body" idx="1"/></${p}nvPr></${p}nvSpPr><${p}spPr/>` +
    `${txBody}</${p}sp>`
  )
}

/**
 * Write notes (overwrite): patch the existing notesSlide's body txBody;
 * if there is no notesSlide, create the part (with a notesMaster if needed).
 * A notes slide part is written under the prefixes it binds its namespaces to; false, and
 * nothing written to it, when it binds them to none or has no shape tree to hold the body.
 */
export function setSlideNotes(opened: OpenedPptx, slideIndex: number, text: string): boolean {
  const slide = opened.deck.slides[slideIndex]
  if (!slide) return false
  const { archive } = opened
  const notesPath = notesPathForSlide(archive, slide.path) ?? createNotesSlide(opened, slide.path)
  if (!notesPath) return false
  const xml = archive.readText(notesPath)
  if (!xml) return false
  const prefixes = notesPrefixes(xml)
  if (!prefixes) return false
  const { p, a } = prefixes

  const txBody = buildNotesTxBody(text, p, a)
  const body = findBodySp(xml, p)
  let next: string
  if (body) {
    const old = elementRange(body.xml, `${p}txBody`)
    const at = old ?? { start: body.xml.lastIndexOf('</'), end: body.xml.lastIndexOf('</') }
    const patched = body.xml.slice(0, at.start) + txBody + body.xml.slice(at.end)
    next = xml.slice(0, body.start) + patched + xml.slice(body.end)
  } else {
    const tree = elementRange(xml, `${p}spTree`)
    if (!tree || tree.contentStart === tree.end) return false
    next = xml.slice(0, tree.contentEnd) + notesBodySp(p, a, txBody) + xml.slice(tree.contentEnd)
  }
  setEntry(archive, notesPath, next)
  return true
}

/** Add an Override to [Content_Types].xml (skipped if already present). */
export function addContentTypeOverride(
  archive: PackageArchive,
  partPath: string,
  contentType: string,
): void {
  const ctPath = '[Content_Types].xml'
  const ct = archive.readText(ctPath)
  if (!ct || hasContentTypeOverride(ct, partPath)) return
  setEntry(
    archive,
    ctPath,
    ct.replace(
      '</Types>',
      () => `<Override PartName="/${partPath}" ContentType="${contentType}"/></Types>`,
    ),
  )
}

/** Append a relationship to a part's rels, creating the rels file if missing. Returns the new rId. */
export function appendRelationship(
  archive: PackageArchive,
  partPath: string,
  type: string,
  target: string,
): string {
  const relsPath = relsPathFor(partPath)
  let xml =
    archive.readText(relsPath) ??
    XMLDECL +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  const maxRid = maxRelationshipIdNumber(xml)
  const rid = `rId${maxRid + 1}`
  // A function, not a string: the target can be a part name the deck chose (the slide a notes
  // slide belongs to), and a replacement string would expand a `$&` or `$$` in it. Escaped for
  // the same reason: the name may hold `&`.
  xml = xml.replace(
    '</Relationships>',
    () =>
      `<Relationship Id="${rid}" Type="${type}" Target="${escapeXmlAttr(target)}"/></Relationships>`,
  )
  setEntry(archive, relsPath, xml)
  return rid
}

/**
 * Lists a notes master in presentation.xml, under the prefixes the part binds PresentationML and
 * the relationships namespace to: the list goes where the schema puts it, right after
 * `sldMasterIdLst` (before `handoutMasterIdLst`, `sldIdLst`, `sldSz`, `notesSz`), and replaces
 * a list already there (it holds one entry at most). Null when there is nowhere to put it, and
 * the caller then writes nothing: a notes master presentation.xml does not list makes
 * PowerPoint offer to repair the file.
 */
function notesMasterLister(pres: string): ((rid: string) => string) | null {
  const p = rootPrefixOf(pres, NS_P)
  if (p === null) return null
  // an unprefixed attribute is in no namespace, so `r:` is declared where it is not bound
  const r = rootPrefixOf(pres, NS_R)
  const idName = r ? `${r}id` : `xmlns:r="${NS_R}" r:id`
  const list = (rid: string) =>
    `<${p}notesMasterIdLst><${p}notesMasterId ${idName}="${escapeXmlAttr(rid)}"/></${p}notesMasterIdLst>`
  const existing = elementRange(pres, `${p}notesMasterIdLst`)
  if (existing) return (rid) => pres.slice(0, existing.start) + list(rid) + pres.slice(existing.end)
  let at = elementRange(pres, `${p}sldMasterIdLst`)?.end
  for (const next of ['handoutMasterIdLst', 'sldIdLst', 'sldSz', 'notesSz']) {
    at ??= elementRange(pres, `${p}${next}`)?.start
  }
  return at === undefined ? null : (rid) => pres.slice(0, at) + list(rid) + pres.slice(at)
}

/** Ensure a notesMaster exists and return its part path. Created and registered in the presentation if missing. */
function ensureNotesMaster(archive: PackageArchive): string | null {
  const presPath = 'ppt/presentation.xml'
  for (const rel of archive.readRels(presPath).values()) {
    if (rel.type !== NOTES_MASTER_REL) continue
    const listed = resolveTarget(presPath, rel.target)
    if (archive.has(listed)) return listed
  }
  for (const path of archive.entries.keys()) {
    if (/^ppt\/notesMasters\/notesMaster\d+\.xml$/.test(path)) return path
  }
  // decided before anything is written: a deck that cannot list the master is left as it was
  const pres = archive.readText(presPath)
  const listed = pres === null ? null : notesMasterLister(pres)
  if (!listed) return null

  const path = 'ppt/notesMasters/notesMaster1.xml'
  const emptyTree =
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>'
  const xml =
    XMLDECL +
    `<p:notesMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
    `<p:cSld>${emptyTree}</p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"' +
    ' accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '</p:notesMaster>'
  setEntry(archive, path, xml)
  addContentTypeOverride(archive, path, NOTES_MASTER_CT)
  // rels: reuse an existing theme part (valid: multiple parts may point to the same theme)
  const theme = [...archive.entries.keys()].find((p) => /^ppt\/theme\/theme\d+\.xml$/.test(p))
  if (theme) appendRelationship(archive, path, THEME_REL, `../${theme.slice(4)}`)
  const rid = appendRelationship(
    archive,
    presPath,
    NOTES_MASTER_REL,
    'notesMasters/notesMaster1.xml',
  )
  setEntry(archive, presPath, listed(rid))
  return path
}

/** Create an empty notesSlide for a slide (part + rels + CT + slide rels); returns the part path. */
function createNotesSlide(opened: OpenedPptx, slidePath: string): string | null {
  const { archive } = opened
  const master = ensureNotesMaster(archive)
  if (!master) return null

  let maxNum = 0
  for (const path of archive.entries.keys()) {
    const m = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/.exec(path)
    if (m) maxNum = Math.max(maxNum, Number(m[1]))
  }
  const notesPath = `ppt/notesSlides/notesSlide${maxNum + 1}.xml`

  const xml =
    XMLDECL +
    `<p:notes xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
    '<p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder"/>' +
    '<p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
    notesBodySp(
      'p:',
      'a:',
      '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody>',
    ) +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>'
  setEntry(archive, notesPath, xml)
  addContentTypeOverride(archive, notesPath, NOTES_SLIDE_CT)

  // notesSlide rels: notesMaster + owning slide
  appendRelationship(archive, notesPath, NOTES_MASTER_REL, `../${master.slice(4)}`)
  appendRelationship(archive, notesPath, SLIDE_REL, `../${slidePath.slice(4)}`)

  // slide rels: point to the new notesSlide
  appendRelationship(archive, slidePath, NOTES_SLIDE_REL, `../${notesPath.slice(4)}`)
  return notesPath
}
