/**
 * Pictures and locked placeholders inside paragraphs.
 *
 * Forward: a drawing element of a paragraph (`draw:frame`, shapes, groups …)
 * becomes one picture run. A frame holding one displayable `draw:image` is an
 * editable picture (`odt-pic:<id>`); anything else the editor cannot change
 * is a placeholder (`odt-keep:<id>:<kind>`) showing the file's preview
 * picture or the neutral picture, at the object's size. A text box holding a
 * table is left to the table owner (the converter declines it).
 *
 * Save: a placeholder writes its original bytes (size changes are ignored);
 * a picture writes its original frame, with `svg:width`/`svg:height` (and the
 * offsets of a floating picture) patched when they changed and the image
 * reference re-pointed at a new `Pictures/` entry when its bytes were
 * replaced; a picture the bridge never had becomes a new frame and entry.
 */
import type { Run } from '@genoffice/docx-engine'
import type {
  InlineConverter,
  InlineOoxml,
  OdfToOoxmlContext,
  OoxmlToOdfContext,
  ParagraphInjector,
  ParagraphWriteEnv,
  RunWriter,
} from '../core/convert'
import { escapeXmlAttr } from '../core/xml'
import { patchStartTag } from '../text/style-xml'
import { DRAW_OBJECT_NAMES, analyzeObject, anchorOf } from './analyze'
import { drawingXml, emuToCm, readDrawing } from './geometry'
import { dataUrlBytes, sameBytes, sniffImage } from './media'
import {
  OBJECTS_OWNER,
  type ObjectPicture,
  type ObjectPlaceholder,
  keepName,
  parseKeepName,
  parsePictureName,
  pictureName,
} from './model'
import { notesRunWriter } from './notes'
import {
  addPictureEntry,
  bridgeMedia,
  forwardState,
  neutralMedia,
  saveState,
  sourceOf,
} from './state'

// ---------------------------------------------------------------------------
// Forward

export const drawingInlineConverter: InlineConverter = {
  id: OBJECTS_OWNER,
  names: DRAW_OBJECT_NAMES,
  toOoxml(ctx, el, env): InlineOoxml | null {
    // pictures in headers/footers need the header part's relationships: kept for now
    if (el.part !== 'content.xml') return null
    const st = forwardState(ctx)
    if (st.nested > 0) return null
    const info = ctx.part(el.part)
    const a = analyzeObject(ctx.doc, el.part, el.xml, info.prefixes, el)
    if (a.type === 'skip') return null
    const id = String(++st.seq)
    const anchor = anchorOf(ctx.doc, el.part, a.anchor)
    if (a.type === 'picture' && a.image) {
      const image = a.image
      const rId = bridgeMedia(ctx, image.entry, image.bytes, image.format)
      const record: ObjectPicture = {
        id,
        name: pictureName(id),
        part: el.part,
        start: el.start,
        end: el.end,
        openEnd: el.openEnd,
        imageStart: image.start,
        imageOpenEnd: image.openEnd,
        href: image.href,
        entry: image.entry,
        rId,
        widthEmu: a.widthEmu,
        heightEmu: a.heightEmu,
        anchored: anchor !== null,
        xEmu: anchor?.h.offset ?? null,
        yEmu: anchor?.v.offset ?? null,
        paragraph: env.paragraphId,
        entries: a.entries,
      }
      st.ext.pictures.push(record)
      return {
        kind: 'xml',
        xml: `<w:r>${drawingXml({ docPrId: ++st.docPrSeq, name: record.name, rId, cx: a.widthEmu, cy: a.heightEmu, anchor })}</w:r>`,
        text: '',
      }
    }
    const placeholder: ObjectPlaceholder = {
      id,
      kind: a.kind,
      name: keepName(id, a.kind),
      part: el.part,
      start: el.start,
      end: el.end,
      paragraph: env.paragraphId,
      block: null,
      element: null,
      widthEmu: a.widthEmu,
      heightEmu: a.heightEmu,
      preview: a.preview !== null,
      entries: a.entries,
      finalText: null,
    }
    st.ext.placeholders.push(placeholder)
    return {
      kind: 'xml',
      xml: `<w:r>${placeholderDrawing(ctx, placeholder, a.preview, anchor)}</w:r>`,
      text: '',
    }
  },
}

/** The `<w:drawing>` of a placeholder. */
export function placeholderDrawing(
  ctx: OdfToOoxmlContext,
  p: ObjectPlaceholder,
  preview: { bytes: Uint8Array; format: { ext: string; mime: string } } | null,
  anchor: Parameters<typeof drawingXml>[0]['anchor'],
): string {
  const st = forwardState(ctx)
  const rId = preview
    ? bridgeMedia(ctx, `#preview:${p.id}`, preview.bytes, preview.format)
    : neutralMedia(ctx)
  return drawingXml({
    docPrId: ++st.docPrSeq,
    name: p.name,
    rId,
    cx: p.widthEmu,
    cy: p.heightEmu,
    anchor,
  })
}

// ---------------------------------------------------------------------------
// Save

/** Writes the ODF for one picture or placeholder drawing of the edited docx. */
export function writeDrawing(
  rctx: OoxmlToOdfContext,
  xml: string,
  dataUrl: string | undefined,
  env: Pick<ParagraphWriteEnv, 'part'>,
): string {
  const st = saveState(rctx)
  const facts = readDrawing(xml)
  const keep = facts.name !== null ? parseKeepName(facts.name) : null
  if (facts.name !== null) st.emittedNames.add(facts.name)
  if (keep) {
    const p = st.placeholders.get(keep.id)
    if (!p) {
      rctx.warn(`dropped an unknown locked object ${facts.name}`)
      return ''
    }
    if (p.block !== null) {
      rctx.warn('a locked block object moved into a paragraph was dropped')
      return ''
    }
    return sourceOf(rctx, p.part, p.start, p.end)
  }
  const picId = facts.name !== null ? parsePictureName(facts.name) : null
  const pic = picId !== null ? st.pictures.get(picId) : undefined
  if (pic) return writeExistingPicture(rctx, pic, facts, dataUrl)
  return writeNewPicture(rctx, facts, dataUrl, env.part)
}

function writeExistingPicture(
  rctx: OoxmlToOdfContext,
  pic: ObjectPicture,
  facts: ReturnType<typeof readDrawing>,
  dataUrl: string | undefined,
): string {
  const st = saveState(rctx)
  const info = rctx.part(pic.part)
  const xml = info.xml
  const copy = st.emittedPictures.has(pic.id)
  st.emittedPictures.add(pic.id)
  const overrides: Record<string, string> = {}
  const cx = facts.cx ?? pic.widthEmu
  const cy = facts.cy ?? pic.heightEmu
  if (cx !== pic.widthEmu || cy !== pic.heightEmu) {
    overrides['svg:width'] = emuToCm(cx)
    overrides['svg:height'] = emuToCm(cy)
  }
  if (pic.anchored && facts.anchored) {
    if (pic.xEmu !== null && facts.xOffset !== null && facts.xOffset !== pic.xEmu)
      overrides['svg:x'] = emuToCm(facts.xOffset)
    if (pic.yEmu !== null && facts.yOffset !== null && facts.yOffset !== pic.yEmu)
      overrides['svg:y'] = emuToCm(facts.yOffset)
  }
  let inner = xml.slice(pic.openEnd, pic.end)
  if (facts.rId !== null && facts.rId !== pic.rId) {
    const bytes = dataUrlBytes(dataUrl)
    const original = rctx.doc.pkg.get(pic.entry)?.bytes
    if (!bytes) {
      rctx.warn('a replaced picture could not be read; kept the original picture')
    } else if (!original || !sameBytes(bytes, original)) {
      const format = sniffImage(bytes) ?? formatOfDataUrl(dataUrl)
      const path = addPictureEntry(rctx, bytes, format)
      const tag = patchStartTag(xml.slice(pic.imageStart, pic.imageOpenEnd), info.prefixes, {
        'xlink:href': path,
      })
      inner = xml.slice(pic.openEnd, pic.imageStart) + tag + xml.slice(pic.imageOpenEnd, pic.end)
    }
  }
  let open = xml.slice(pic.start, pic.openEnd)
  if (Object.keys(overrides).length) open = patchStartTag(open, info.prefixes, overrides)
  // a copy must not repeat a unique frame name
  if (copy) open = patchStartTag(open, info.prefixes, { 'draw:name': null, 'xml:id': null })
  return open + inner
}

function formatOfDataUrl(url: string | undefined): { ext: string; mime: string } {
  const mime = /^data:([^;,]+)/.exec(url ?? '')?.[1] ?? 'image/png'
  const ext = /\/(?:x-)?([a-z0-9]+)/.exec(mime)?.[1] ?? 'png'
  return { ext, mime }
}

/** A new picture: a new `Pictures/` entry and a new frame with its own graphic style. */
function writeNewPicture(
  rctx: OoxmlToOdfContext,
  facts: ReturnType<typeof readDrawing>,
  dataUrl: string | undefined,
  part: ParagraphWriteEnv['part'],
): string {
  const bytes = dataUrlBytes(dataUrl)
  if (!bytes || !bytes.length) {
    rctx.warn('dropped a new picture whose bytes are not available')
    return ''
  }
  const format = sniffImage(bytes) ?? formatOfDataUrl(dataUrl)
  const path = addPictureEntry(rctx, bytes, format)
  const st = saveState(rctx)
  if (st.zIndex === null) {
    let max = -1
    for (const m of rctx.doc.contentXml.matchAll(/draw:z-index\s*=\s*"(\d+)"/g))
      max = Math.max(max, parseInt(m[1], 10))
    st.zIndex = max + 1
  }
  const z = st.zIndex++
  const anchored = facts.anchored
  const props = anchored
    ? 'style:wrap="parallel" style:horizontal-pos="from-left" style:horizontal-rel="paragraph" style:vertical-pos="from-top" style:vertical-rel="paragraph"'
    : 'style:vertical-pos="top" style:vertical-rel="baseline"'
  const style = rctx.derivedStyle(
    part,
    `objects-graphic:${anchored ? 'anchor' : 'inline'}`,
    'fr',
    (name) =>
      `<style:style style:name="${escapeXmlAttr(name)}" style:family="graphic"><style:graphic-properties ${props} fo:border="none" fo:padding="0cm"/></style:style>`,
  )
  const cx = facts.cx ?? 914400
  const cy = facts.cy ?? 914400
  const position = anchored
    ? ` svg:x="${emuToCm(facts.xOffset ?? 0)}" svg:y="${emuToCm(facts.yOffset ?? 0)}"`
    : ''
  return (
    `<draw:frame draw:style-name="${escapeXmlAttr(style)}" text:anchor-type="${anchored ? 'paragraph' : 'as-char'}"${position} svg:width="${emuToCm(cx)}" svg:height="${emuToCm(cy)}" draw:z-index="${z}">` +
    `<draw:image xlink:href="${escapeXmlAttr(path)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`
  )
}

/** Picture runs and note references of edited paragraphs. */
export const objectsRunWriter: RunWriter = {
  id: OBJECTS_OWNER,
  match(run: Run) {
    return !!run.image || !!run.noteRef
  },
  toOdf(rctx, run, env) {
    if (run.noteRef) return notesRunWriter(rctx, run.noteRef, env)
    const image = run.image
    if (!image) return ''
    if (image.rule || !/<w:drawing>/.test(image.xml)) {
      rctx.warn('dropped a picture the ODT cannot hold')
      return ''
    }
    return writeDrawing(rctx, image.xml, image.dataUrl, env)
  },
}

// ---------------------------------------------------------------------------
// Pictures the engine could not read

/** Every `wp:docPr` name in the edited body XML, and those carried by a picture run. */
function editedNames(rctx: OoxmlToOdfContext): { xml: Set<string>; runs: Set<string> } {
  const st = saveState(rctx)
  if (!st.editedNames) {
    const xml = new Set<string>()
    const runs = new Set<string>()
    const seen = new Set<unknown>()
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object' || seen.has(value)) return
      seen.add(value)
      if (Array.isArray(value)) {
        for (const v of value) visit(v)
        return
      }
      const o = value as Record<string, unknown>
      const image = o.image as { xml?: unknown } | undefined
      if (typeof o.text === 'string' && image && typeof image.xml === 'string') {
        const name = readDrawing(image.xml).name
        if (name !== null) runs.add(name)
      }
      for (const [k, v] of Object.entries(o))
        if (k !== 'originalXml' && typeof v === 'object') visit(v)
    }
    for (const b of rctx.edited.blocks) {
      for (const m of (b.originalXml ?? '').matchAll(/<wp:docPr\b[^>]*\bname="([^"]*)"/g))
        xml.add(m[1])
      visit(b)
    }
    st.editedNames = { xml, runs }
  }
  return st.editedNames
}

/**
 * A picture the docx engine cannot read where the save runs (a metafile
 * without a canvas, a broken picture) has no run in the edited paragraph
 * although its drawing is still in the edited XML. Such objects are written
 * back at their original position instead of being dropped.
 */
export const droppedDrawingInjector: ParagraphInjector = {
  id: OBJECTS_OWNER,
  inject(rctx, _para, env) {
    const origin = env.origin
    if (!origin) return []
    const handlers = origin.markers.filter(
      (m) =>
        m.kind === 'handler' && m.owner === OBJECTS_OWNER && DRAW_OBJECT_NAMES.includes(m.name),
    )
    if (!handlers.length) return []
    const st = saveState(rctx)
    const out: Array<{ offset: number; xml: string; attach: 'next' }> = []
    for (const m of handlers) {
      const object =
        st.ext.pictures.find((p) => p.part === origin.part && p.start === m.start) ??
        st.ext.placeholders.find((p) => p.part === origin.part && p.start === m.start)
      if (!object || st.emittedNames.has(object.name)) continue
      const names = editedNames(rctx)
      if (names.runs.has(object.name) || !names.xml.has(object.name)) continue
      st.emittedNames.add(object.name)
      out.push({
        offset: env.mapOffset(m.offset, 'start'),
        xml: sourceOf(rctx, object.part, object.start, object.end),
        attach: 'next',
      })
    }
    return out
  },
}
