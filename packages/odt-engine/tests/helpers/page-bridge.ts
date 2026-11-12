/**
 * Test plumbing for the page layer: the editor's ways of
 * changing sections (the trailing section through `saveDocx` options, the
 * others by rewriting the sectPr inside their break paragraph, as
 * `applySectPrRewrites` does in apps/docs).
 */
import {
  type Block,
  type HeaderFooter,
  type ParsedDocFull,
  type SectionInfo,
  type SectionSettings,
  applyPageNumType,
  applySectionSettings,
  applyTitlePg,
  parseDocx,
  readSections,
} from '@seuoffice/docx-engine'
import type { EditorOp } from './bridge'

/** The visible blocks of a parsed docx and its sections. */
export async function sectionsOf(
  docx: Uint8Array,
): Promise<{ parsed: ParsedDocFull; sections: SectionInfo[]; visible: Block[] }> {
  const parsed = await parseDocx(docx)
  return { parsed, sections: readSections(parsed), visible: parsed.blocks.filter((b) => !b.hidden) }
}

export interface SectionEdit {
  settings?: Partial<SectionSettings>
  titlePg?: boolean
  pageNumber?: { fmt?: string; start?: number }
}

/** The save op rewriting a non-final section's sectPr in its break paragraph (the editor's way). */
export function sectPrRewrite(
  parsed: ParsedDocFull,
  section: SectionInfo,
  edit: SectionEdit,
): { xml: string; docxIndex: number } {
  const block = parsed.blocks.find((b) => b.docxIndex === section.lastBlockIndex)
  if (!block?.originalXml) throw new Error('no break paragraph')
  let sectPr = section.sectPrXml
  if (edit.settings)
    sectPr = applySectionSettings(sectPr, { ...section.settings, ...edit.settings })
  if (edit.titlePg !== undefined) sectPr = applyTitlePg(sectPr, edit.titlePg)
  if (edit.pageNumber) sectPr = applyPageNumType(sectPr, edit.pageNumber.fmt, edit.pageNumber.start)
  return {
    xml: block.originalXml.replace(section.sectPrXml, sectPr),
    docxIndex: section.lastBlockIndex,
  }
}

/** A break paragraph's XML without its `w:sectPr` (the editor drops the section break). */
export function stripParagraphSectPr(xml: string): string {
  return xml
    .replace(/<w:sectPr(?:\s[^>]*)?\/>|<w:sectPr(?:\s[^>]*)?>[\s\S]*?<\/w:sectPr>/, '')
    .replace(/^(<w:p(?:\s[^>]*)?>)<w:pPr><\/w:pPr>/, '$1')
}

/** Keeps every visible block, replacing some by XML (keyed by docxIndex). */
export function keepAllBut(replace: Record<number, string>): (blocks: Block[]) => EditorOp[] {
  return (blocks) =>
    blocks.map((b, i) => {
      const x = b.docxIndex !== undefined && b.docxIndex !== null ? replace[b.docxIndex] : undefined
      return x !== undefined ? { xml: x, docxIndex: b.docxIndex as number } : { keep: i }
    })
}

/** A header/footer model with the text of one paragraph replaced (the editor's rich model). */
export function editedHf(
  parsed: ParsedDocFull,
  rId: string,
  change: (paras: NonNullable<HeaderFooter['paras']>) => void,
): HeaderFooter {
  const part = parsed.hfParts?.[rId]
  const paras = JSON.parse(JSON.stringify(part?.paras ?? [])) as NonNullable<HeaderFooter['paras']>
  change(paras)
  return { text: paras.map((p) => p.runs.map((r) => r.text).join('')).join('\n'), paras }
}
