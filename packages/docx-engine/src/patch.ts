import { type RemovePartsOptions } from './remove-parts'
import { type ParseExtras } from './parse'
import { type CustomNumberingLevel } from './blank'
import type { CommentInfo, DocProtection, WriteProtection, GeneratedBlock, HeaderFooter, NewChart, NewImage, NewInkImage, NoteInfo, ParsedDoc, RevisionInfo, SectionSettings, SourceInfo, ThemeColors, ThemeFonts } from './types'
import { type DefaultFonts, type StyleUpsert } from './style-upsert'
import { type Watermark } from './watermark'
import { type ContentControlSpec } from './content-control'
import { type PropertyChanges } from './doc-properties'
import { invoke, invokeAsync } from './engine'
import * as hand from './engine-hand'

/** The `<Relationship ` half of relTagWithId's shape, which anchors a candidate tag. */
const RELATIONSHIP_TAG_MARKER = /<Relationship\s/
/**
 * An exact `Id="rIdN"` inside a candidate tag. The id text is captured
 * verbatim, so a zero-padded `rId02` is kept distinct from `rId2` exactly as
 * relTagWithId's literal comparison keeps them distinct.
 */
const RELATIONSHIP_TAG_ID = /\bId\s*=\s*(["'])(rId\d+)\1/g
/**
 * Every relationship id a .rels part already hands out. One pass over the part,
 * answering the same question as relTagWithId for every id at once: a tag only
 * counts when it opens with `<Relationship `, self-closes, and spells that id
 * inside itself, so the ids the allocator treats as taken stay exactly the ids
 * the reclaim can free. Testing one candidate id at a time instead costs a full
 * scan of the part per candidate, which is quadratic in the relationship count -
 * a few MB of relationships then takes minutes to allocate a single id.
 */
const occupiedRelIds = (relsXml: string): Set<string> => {
  const taken = new Set<string>()
  let pos = 0
  while (pos < relsXml.length) {
    const gt = relsXml.indexOf('>', pos)
    if (gt === -1) break
    // relTagWithId's `[^>]*` cannot cross a `>`, so one candidate tag is one
    // `>`-delimited run, and it only matches when that run self-closes
    if (relsXml[gt - 1] === '/') {
      const chunk = relsXml.slice(pos, gt)
      const marker = chunk.search(RELATIONSHIP_TAG_MARKER)
      if (marker !== -1) {
        RELATIONSHIP_TAG_ID.lastIndex = marker
        let m: RegExpExecArray | null
        while ((m = RELATIONSHIP_TAG_ID.exec(chunk)) !== null) taken.add(m[2])
      }
    }
    pos = gt + 1
  }
  return taken
}
/**
 * Lowest id from rId1 this part does not already hand out, so a gap is reused
 * rather than skipped. Deliberately not maxRelId + 1: that never fills a gap and
 * starts at rId1001 for an absent part, so it would hand out a different id
 * than the part's own numbering implies.
 */
export const nextFreeRelId = (relsXml: string): string => {
  const taken = occupiedRelIds(relsXml)
  let n = 1
  while (taken.has(`rId${n}`)) n++
  return `rId${n}`
}
export type ParsedDocFull = ParsedDoc & { extras: ParseExtras }
/** Body content in final editor order (hidden trailing elements are appended automatically). */
export type SaveBlock = (
  | { kind: 'original'; docxIndex: number }
  | { kind: 'generated'; block: GeneratedBlock; docxIndex?: number }
  /** self-contained OOXML fragment created by the editor (e.g. a new table);
   *  docxIndex marks the source block (kept when a section-break paragraph is
   *  rewritten, used to inject per-section header references); replaceImage
   *  swaps the fragment's picture bytes in place (new media part, a:blip
   *  re-pointed) so crop/background-removal keep the original drawing XML */
  | {
      kind: 'xml'
      xml: string
      docxIndex?: number
      replaceImage?: { base64: string; mime: NewImage['mime'] }
    }
  /** a new inline image; bytes become word/media/... + relationship */
  | { kind: 'image'; image: NewImage }
  /** several anchored pictures sharing one holder paragraph (page-pinned floats
   *  of a rebuilt page): one block instead of one empty paragraph per picture */
  | { kind: 'images'; images: NewImage[] }
  /** a new embedded chart; data becomes word/charts/chartN.xml + relationship */
  | { kind: 'chart'; chart: NewChart; extentPx?: { w: number; h: number } }
) & {
  /** Top-level tracked insertion/deletion wrapper. */
  revision?: { kind: 'ins' | 'del' } & RevisionInfo
}
export interface SaveOptions {
  /** save timestamp (ISO), written to docProps/core.xml dcterms:modified; default = now */
  savedAt?: string
  /**
   * Block-level content controls (w:sdt) for the saved body. `wrap` puts the
   * listed body blocks into one new control (the blocks stay individually
   * editable). `unwrap` removes the wrapper of every control with that tag and
   * leaves its blocks as plain body children; nested controls are unwrapped
   * level by level (unwrapping an inner tag keeps the outer shell, unwrapping
   * the outer tag keeps inner controls as their blocks' own shells) and a tag
   * that appears more than once is unwrapped everywhere. Inline (run-level)
   * controls are reported read-only and are not unwrapped by this option.
   */
  contentControls?: {
    wrap?: Array<{ docxIndexes: number[]; spec: ContentControlSpec }>
    unwrap?: Array<{ tag: string }>
  }
  /** first revision id the save may mint; a caller that assigned ids itself passes the one after its last */
  revisionIdFloor?: number
  /** total page count at save time: the cached result written into NUMPAGES fields (viewers that do not recompute fields show it); default 1 */
  pageCount?: number
  /** bytes of pictures the editor placed inside existing paragraphs (table cells),
   *  keyed by the placeholder token their drawing XML carries (NEW_PICTURE_TOKEN_PREFIX) */
  newPictures?: Record<string, { base64: string; mime: NewImage['mime'] }>
  /** Zotero document preferences; written as Word-compatible 255-character custom-property chunks */
  zoteroDocumentData?: string
  /** replace the trailing w:sectPr with this XML before the field-level options below apply (headless editors that keep the sectPr itself) */
  trailingSectPr?: string
  /** resolve the trailing sectPr's tracked w:sectPrChange: accept drops the record, reject restores the previous sectPr */
  trailingSectPrChange?: 'accept' | 'reject'
  /** rewrite page size / margins in the trailing w:sectPr */
  section?: SectionSettings
  /** last-section start type (w:type); rewrites the trailing sectPr when inserting a continuous section break; undefined = keep */
  sectionStartType?: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage' | 'nextColumn'
  /** last-section page numbering (w:pgNumType): both fmt/start unset = remove the tag; undefined = keep */
  pgNumType?: { fmt?: string; start?: number }
  /** page color: hex without '#' to set, null to remove, undefined to keep as-is */
  pageColor?: string | null
  /** replace/create the default page header (single centered line); undefined = keep */
  header?: HeaderFooter
  /** replace/create the default page footer; undefined = keep */
  footer?: HeaderFooter
  /** first-page header/footer parts (w:type="first"); undefined = keep */
  headerFirst?: HeaderFooter
  footerFirst?: HeaderFooter
  /** even-page header/footer parts (w:type="even"); undefined = keep */
  headerEven?: HeaderFooter
  footerEven?: HeaderFooter
  /** "different first page": set/remove w:titlePg in the trailing sectPr */
  titlePg?: boolean
  /**
   * Per-section header/footer edits (non-last sections of multi-section docs, default
   * variant). lastBlockIndex locates the section's break paragraph: if the section
   * already has a matching reference, the referenced part is rewritten (earlier sections
   * sharing the part change with it — Word's "same as previous" semantics); if there is
   * no reference (inherited from the previous section), a new part is created and the
   * reference injected into this section's sectPr (the section becomes independent,
   * earlier sections are unaffected).
   */
  sectionHf?: Array<{
    lastBlockIndex: number
    kind: 'header' | 'footer'
    hf: HeaderFooter
    /** w:type of the reference; absent = default */
    variant?: 'default' | 'first' | 'even'
  }>
  /**
   * Word's "Link to Previous" switched on: drop the section's own header/footer
   * reference of that variant so it inherits the previous section's part again.
   * lastBlockIndex locates the sectPr (a break paragraph or the trailing sectPr).
   */
  sectionHfUnlink?: Array<{
    lastBlockIndex: number
    kind: 'header' | 'footer'
    variant?: 'default' | 'first' | 'even'
  }>
  /** "different odd & even pages": set/remove settings.xml w:evenAndOddHeaders */
  evenAndOddHeaders?: boolean
  /** mirrored facing pages: set/remove settings.xml w:mirrorMargins */
  mirrorMargins?: boolean
  /** Track Changes left on at save time: set/remove settings.xml w:trackRevisions */
  trackRevisions?: boolean
  /**
   * Inject the newly created header/footer references into EVERY body sectPr
   * that has none (not just the trailing one). Generated multi-section
   * documents (pdf2docx) need the same header on every section: sections
   * inherit forward from the previous section only, so a reference on the
   * trailing sectPr alone leaves all earlier sections blank.
   */
  hfAllSections?: boolean
  /**
   * Append numbering definitions to word/numbering.xml (when the part is missing, it is
   * created from the blank template, including rel/ContentType). newDefs = brand-new
   * abstractNum + w:num (new lists); restartNums = new w:num pointing at an existing
   * abstractNum + startOverride (restart numbering). Append-only: existing entries keep
   * their original bytes.
   */
  numbering?: {
    /** with levels, generates the abstractNum from custom levels (multilevel list / bullet library); otherwise uses the blank-template style */
    newDefs?: Array<{ numId: string; kind: 'bullet' | 'ordered'; levels?: CustomNumberingLevel[] }>
    restartNums?: Array<{
      numId: string
      abstractNumId: string
      startOverrides: Record<number, number>
    }>
    /** replace one w:lvl of an existing abstractNum (Adjust List Indents / define on an existing list) */
    levelEdits?: Array<{ abstractNumId: string; ilvl: number; level: CustomNumberingLevel }>
    /** new w:numPicBullet images referenced by levels' picBulletId */
    picBullets?: Array<{ id: number; base64: string; mime: NewImage['mime'] }>
  }
  /** create/modify styles: surgical upsert of word/styles.xml by styleId (replace when present, else append) */
  styleUpserts?: StyleUpsert[]
  defaultFonts?: DefaultFonts
  /**
   * Replace whole zip parts by path (e.g. patched chart parts from
   * patchChartPartXml). Only paths that already exist in the package are
   * rewritten; unknown paths are ignored.
   */
  partXml?: Record<string, string>
  /**
   * Replace whole zip parts with binary data (base64) — used to update
   * embedded xlsx workbooks alongside patched chart parts.
   * Only paths already present in the package are rewritten; unknown paths are
   * ignored.
   */
  partBinary?: Record<string, string>
  /**
   * Full desired comment list; word/comments.xml is regenerated from it
   * (plain-text bodies). undefined = keep the part byte-identical.
   */
  comments?: CommentInfo[]
  /** editing restriction; null removes w:documentProtection, undefined keeps */
  protection?: DocProtection | null
  /** password to modify / read-only recommended; null removes w:writeProtection, undefined keeps */
  writeProtection?: WriteProtection | null
  /**
   * settings.xml w:removePersonalInformation flag; undefined keeps the current value.
   * Whenever the flag is effective (set here or already in the document), the save
   * removes known author and organization metadata throughout the final package.
   */
  removePersonalInfo?: boolean
  /**
   * Full desired footnote / endnote lists; the part is regenerated from them
   * (separator entries preserved). undefined = keep byte-identical.
   */
  footnotes?: NoteInfo[]
  endnotes?: NoteInfo[]
  /**
   * Watermark in every active section header: a string / text spec / picture spec
   * sets it, null removes it, undefined keeps each header's existing watermark.
   */
  watermark?: Watermark | null
  /**
   * Full desired ink-annotation list (freehand strokes), as floating anchored pictures.
   * Existing aidocs-ink runs are stripped and re-emitted from this list, so
   * passing [] removes all our ink. undefined = keep whatever is in the file.
   */
  inks?: NewInkImage[]
  /** full bibliography source list; regenerates the b:Sources customXml part */
  sources?: SourceInfo[]
  /** theme font pair; patches (or creates) word/theme/theme1.xml */
  themeFonts?: ThemeFonts
  /** theme color scheme; patches (or creates) word/theme/theme1.xml */
  themeColors?: ThemeColors
  /**
   * Document properties to write into the docProps parts: a string sets a
   * property, null removes it, clear: "all" empties all three parts. undefined
   * keeps every property as it is.
   */
  properties?: PropertyChanges
  /**
   * Remove metadata-carrying package parts (customXml stores, web-extension
   * parts, explicit paths) in the final package pass, together with their
   * relationships, content-type entries and empty folders. Content controls
   * bound to a removed customXml store refuse the save by default; pass
   * dataBinding: 'strip' to unbind them and keep their text.
   */
  removeParts?: RemovePartsOptions
  /**
   * An accept / reject found move-range markers whose partner is gone and
   * nothing else to resolve: strip them from the body and the story parts.
   * A save that rewrites the package for any other reason strips them anyway;
   * a save with no change returns the original bytes, orphan markers included,
   * unless this is set.
   */
  dropOrphanMoveRanges?: true
}
export type { StyleUpsert } from './style-upsert'
/**
 * Given the original docx bytes and a chart part path (e.g.
 * "word/charts/chart1.xml"), returns the zip-relative path of the embedded
 * workbook (e.g. "word/charts/embeddings/workbook1.xlsx") by reading the
 * chart's rels file, or null when no workbook relationship exists.
 */
export async function findChartWorkbookPath(
  docxBytes: Uint8Array,
  chartPath: string,
): Promise<string | null> {
  return invokeAsync('findChartWorkbookPath', [docxBytes, chartPath]) as never
}
/**
 * Read the raw base64 bytes of a zip part from a docx file.
 * Returns null if the part doesn't exist.
 */
export async function readDocxPartBase64(
  docxBytes: Uint8Array,
  path: string,
): Promise<string | null> {
  return invokeAsync('readDocxPartBase64', [docxBytes, path]) as never
}
/**
 * Heading levels the generated body uses that the document has no heading
 * style for. An explicit styleId (a custom heading style) and an outline-only
 * heading (written as w:outlineLvl) carry themselves.
 */
export function missingHeadingLevels(
  blocks: readonly SaveBlock[],
  headingStyleIds: ReadonlyMap<number, string>,
): number[] {
  return invoke('missingHeadingLevels', [blocks, headingStyleIds]) as never
}
/**
 * Paragraph-patch save.
 *
 * - Blocks marked 'original' are copied as the exact substring of the original
 *   word/document.xml (byte-for-byte after UTF-8 re-encode).
 * - Blocks marked 'generated' become fresh OOXML fragments referencing only
 *   styles that exist in the document — a heading level the document has no
 *   style for gets Word's built-in definition added to word/styles.xml.
 * - 'xml' blocks are self-contained fragments inserted verbatim; 'image' blocks
 *   additionally add media entries and relationships.
 * - Every other zip entry is copied without modification.
 * - If nothing changed at all, the original file bytes are returned untouched.
 */
export async function saveDocx(
  parsed: ParsedDocFull,
  finalBlocks: SaveBlock[],
  options: SaveOptions = {},
): Promise<Uint8Array> {
  return hand.saveDocx(parsed, finalBlocks, options) as never
}