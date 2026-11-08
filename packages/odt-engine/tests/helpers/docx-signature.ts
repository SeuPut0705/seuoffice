/**
 * What a docx shows, reduced to comparable counts and values: paragraph and
 * drawable counts, text, table grids, notes, page geometry and the effective
 * fonts, sizes and line spacing. `docxToOdt` is checked by comparing the
 * source docx with the docx `odtToDocx` makes of the result.
 */
import { type Block, type ParsedDoc, type TableModel, readSections } from '@genoffice/docx-engine'

export interface DocSignature {
  paragraphs: number
  text: string
  tables: string[]
  drawables: number
  notes: string[]
  pages: string[]
  headers: string[]
  defaults: { size: number | undefined; font: string | undefined; line: number | undefined }
}

const isParagraphLike = (b: Block) =>
  b.type === 'paragraph' ||
  b.type === 'heading' ||
  b.type === 'listItem' ||
  b.type === 'image' ||
  (b.type === 'passthrough' && /^<w:p[\s>/]/.test(b.originalXml ?? ''))

const squash = (s: string) => s.replace(/\s+/g, '')

function blockText(b: Block): string {
  if (b.fieldDisplay) return `${b.fieldDisplay.left ?? ''}${b.fieldDisplay.right ?? ''}`
  return (b.runs ?? [])
    .filter((r) => !r.del && !r.math && !r.image)
    .map((r) => r.text)
    .join('')
}

function tableShape(t: TableModel): string {
  return t.rows
    .map((row) =>
      row
        .map(
          (c) =>
            `${c.gridGap ? 'g' : (c.colSpan ?? 1)}${c.vMerge === 'continue' ? 'c' : c.vMerge === 'restart' ? 'r' : ''}`,
        )
        .join(','),
    )
    .join('|')
}

function tableText(t: TableModel): string {
  return t.rows
    .flatMap((row) =>
      row.flatMap((c) => [
        ...(c.richParas ?? []).map((p) =>
          p.runs
            .filter((r) => !r.del)
            .map((r) => r.text)
            .join(''),
        ),
        ...(c.nestedTables ?? []).map(tableText),
      ]),
    )
    .join('')
}

function drawables(b: Block): number {
  if (b.type === 'image') return 1
  if (
    b.type === 'passthrough' &&
    /<w:drawing\b|<w:pict\b|<m:oMath\b|<w:object\b/.test(b.originalXml ?? '')
  )
    return 1
  return (b.runs ?? []).filter((r) => (r.image && !r.image.rule) || r.math).length
}

const breakOnly = (b: Block) =>
  !!b.runs?.length && b.runs.every((r) => !r.image && /^\f+$/.test(r.text))

export function signature(parsed: ParsedDoc): DocSignature {
  const visible = parsed.blocks.filter((b) => !b.hidden && !b.invisibleMarker)
  let text = ''
  for (const b of visible) {
    if (b.type === 'table' && b.table) text += tableText(b.table)
    else text += blockText(b)
  }
  const sections = readSections(parsed).filter(
    (s, i) => i === 0 || (s.startType !== 'continuous' && s.startType !== 'nextColumn'),
  )
  return {
    // a paragraph holding only a page break is a break before the next one in an ODT
    paragraphs: visible.filter((b) => isParagraphLike(b) && !breakOnly(b)).length,
    text: squash(text),
    tables: visible
      .filter((b) => b.type === 'table' && b.table)
      .map((b) => tableShape(b.table as TableModel)),
    drawables: visible.reduce((n, b) => n + drawables(b), 0),
    notes: [...parsed.footnotes, ...parsed.endnotes].map((n) => squash(n.text)),
    pages: sections.map((s) => {
      const t = s.settings
      return [
        t.pageWidth,
        t.pageHeight,
        t.orientation,
        t.marginTop,
        t.marginBottom,
        t.marginLeft,
        t.marginRight,
      ].join(',')
    }),
    headers: sections.map((s) => {
      const rId = s.headerRefs.default
      return rId ? squash(parsed.hfParts?.[rId]?.text ?? '') : ''
    }),
    defaults: {
      size: parsed.docDefaults?.sizeHalfPoints,
      font: parsed.docDefaults?.asciiFont,
      line: parsed.docDefaults?.lineSpacing
        ? Math.round(parsed.docDefaults.lineSpacing * 100)
        : undefined,
    },
  }
}
