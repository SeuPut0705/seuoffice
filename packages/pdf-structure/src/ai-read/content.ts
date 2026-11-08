/**
 * The content of one AI-read page in two forms:
 *
 * - page-free content (`AiPageContent`): what the parser produces and the
 *   store keeps. It knows nothing of page numbers, ids or fingerprints, so
 *   pages that share a fingerprint share it. Footnote markers carry the
 *   printed label (`FootnoteRefRun.id` = label).
 * - a reading (`AiPageReading`): the content as tree blocks of one page, with
 *   ids, the page number, the page fingerprint and source 'ai'.
 */
import type {
  CaptionBlock,
  FootnoteDef,
  HeadingBlock,
  ImageBlock,
  InlineRun,
  ListItemBlock,
  MathBlock,
  ParagraphBlock,
  TableBlock,
  TreeTable,
} from '../tree/types'

export interface AiContentCaption {
  position: 'above' | 'below'
  runs: InlineRun[]
}

export type AiContentBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; runs: InlineRun[] }
  | { kind: 'paragraph'; runs: InlineRun[] }
  | { kind: 'listItem'; ordered: boolean; level: number; marker?: string; runs: InlineRun[] }
  | { kind: 'math'; latex: string }
  | { kind: 'table'; table: TreeTable; caption?: AiContentCaption }
  | { kind: 'figure'; caption?: AiContentCaption }

export interface AiContentFootnote {
  /** printed marker ("1", "*") */
  label: string
  /** note paragraphs */
  paragraphs: InlineRun[][]
}

export interface AiPageContent {
  blocks: AiContentBlock[]
  footnotes: AiContentFootnote[]
}

/** the tree blocks an AI-read page can produce */
export type AiReadBlock =
  HeadingBlock | ParagraphBlock | ListItemBlock | MathBlock | TableBlock | ImageBlock

/** one AI-read page as tree blocks; `payload` is what the store keeps */
export interface AiPageReading {
  /** 1-based original page number */
  page: number
  pageFingerprint: string
  /** in reading order; ids `p{page}.ai{n}` */
  blocks: AiReadBlock[]
  /** ids `p{page}.fn{k}`, in the order the answer listed them */
  footnotes: FootnoteDef[]
  /** a marker without a note, or a note without a marker */
  footnoteLinkFailed: boolean
  /** blocks the repetition filter dropped */
  droppedRepetitions: number
  /** the first answer was malformed and the page was asked again */
  reasked: boolean
  payload: AiReadPagePayload
}

/** current payload format; a stored payload of another version counts as absent */
export const AI_READ_PAYLOAD_VERSION = 1

/** the store payload of one AI-read page (store/AiReadPayload, version 1) */
export interface AiReadPagePayload extends AiPageContent {
  version: typeof AI_READ_PAYLOAD_VERSION
  droppedRepetitions: number
  reasked: boolean
  [key: string]: unknown
}

function mapRefs(runs: InlineRun[], idOf: (label: string) => string): InlineRun[] {
  return runs.map((r) =>
    r.kind === 'footnoteRef' ? { ...r, id: idOf(r.id), marker: r.id } : { ...r },
  )
}

/** the reading of `payload` on one page */
export function materializeReading(
  payload: AiReadPagePayload,
  page: number,
  pageFingerprint: string,
): AiPageReading {
  // a later note with the same label continues the first one
  const noteIdOf = new Map<string, string>()
  const paragraphsOf = new Map<string, InlineRun[][]>()
  for (const f of payload.footnotes) {
    if (!noteIdOf.has(f.label)) noteIdOf.set(f.label, `p${page}.fn${noteIdOf.size + 1}`)
    paragraphsOf.set(f.label, [...(paragraphsOf.get(f.label) ?? []), ...f.paragraphs])
  }
  const referenced = new Set<string>()
  let unlinked = false
  const idOf = (label: string): string => {
    const id = noteIdOf.get(label)
    if (id !== undefined) {
      referenced.add(label)
      return id
    }
    unlinked = true
    return `p${page}.fn-missing-${label}`
  }
  const runs = (r: InlineRun[]) => mapRefs(r, idOf)

  let n = 0
  const head = () => ({ id: `p${page}.ai${++n}`, page, pageFingerprint, source: 'ai' as const })
  const caption = (c: AiContentCaption | undefined): CaptionBlock | undefined =>
    c && { ...head(), kind: 'caption', position: c.position, runs: runs(c.runs) }

  const blocks: AiReadBlock[] = payload.blocks.map((b): AiReadBlock => {
    switch (b.kind) {
      case 'heading':
        return { ...head(), kind: 'heading', level: b.level, levelSource: 'ai', runs: runs(b.runs) }
      case 'paragraph':
        return { ...head(), kind: 'paragraph', runs: runs(b.runs) }
      case 'listItem':
        return {
          ...head(),
          kind: 'listItem',
          ordered: b.ordered,
          level: b.level,
          ...(b.marker !== undefined ? { marker: b.marker } : {}),
          runs: runs(b.runs),
        }
      case 'math':
        return { ...head(), kind: 'math', latex: b.latex }
      case 'table': {
        const h = head()
        const cap = caption(b.caption)
        return {
          ...h,
          kind: 'table',
          table: {
            rowCount: b.table.rowCount,
            colCount: b.table.colCount,
            cells: b.table.cells.map((c) => ({ ...c, paragraphs: c.paragraphs.map(runs) })),
          },
          ...(cap ? { caption: cap } : {}),
        }
      }
      case 'figure': {
        const h = head()
        const cap = caption(b.caption)
        return {
          ...h,
          kind: 'image',
          data: new Uint8Array(0),
          mime: 'image/png',
          pixelWidth: 0,
          pixelHeight: 0,
          widthPt: 0,
          heightPt: 0,
          placeholder: true,
          ...(cap ? { caption: cap } : {}),
        }
      }
    }
  })

  // a marker inside a note points at its note too, but does not count as the link
  const noteRuns = (p: InlineRun[]): InlineRun[] =>
    mapRefs(p, (label) => noteIdOf.get(label) ?? `p${page}.fn-missing-${label}`)
  const footnotes: FootnoteDef[] = [...noteIdOf].map(([label, id]) => ({
    id,
    marker: label,
    page,
    pageFingerprint,
    blocks: paragraphsOf.get(label)!.map((p, j): ParagraphBlock => ({
      id: `${id}.${j + 1}`,
      page,
      pageFingerprint,
      source: 'ai',
      kind: 'paragraph',
      runs: noteRuns(p),
    })),
  }))
  for (const label of noteIdOf.keys()) if (!referenced.has(label)) unlinked = true

  return {
    page,
    pageFingerprint,
    blocks,
    footnotes,
    footnoteLinkFailed: unlinked,
    droppedRepetitions: payload.droppedRepetitions,
    reasked: payload.reasked,
    payload,
  }
}
