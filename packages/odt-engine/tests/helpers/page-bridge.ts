/**
 * Test plumbing for the page layer: open with the text and page converters
 * (T6's order), write back with the page pre-step, and the editor's ways of
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
} from '@genoffice/docx-engine'
import {
  ConversionRegistry,
  OdfToOoxmlContext,
  OoxmlToOdfContext,
  applyTextPatches,
  buildBridgeDocx,
  convertOdtBody,
  openOdt,
  readDocxPart,
  rebuildOdtBody,
} from '../../src/core'
import { convertOdtPage, preparePageWriteBack, registerPageConverters } from '../../src/page'
import { convertOdtStyles, registerTextConverters, updateOdtStyles } from '../../src/text'
import type { Bridge, EditorOp, WriteBack } from './bridge'
import { FULL_REGISTRY, fullWriteBack, registryOr } from './full'

export function pageRegistry(): ConversionRegistry {
  return registryOr(() => registerPageConverters(registerTextConverters(new ConversionRegistry())))
}

export async function odtToPageBridge(bytes: Uint8Array): Promise<Bridge> {
  const registry = pageRegistry()
  const doc = await openOdt(bytes)
  const ctx = new OdfToOoxmlContext(doc, registry)
  convertOdtStyles(ctx)
  convertOdtBody(ctx)
  convertOdtPage(ctx)
  const docx = await buildBridgeDocx(ctx)
  const map = JSON.parse(JSON.stringify(ctx.map)) as Bridge['map']
  return { doc, ctx, map, docx, registry }
}

/** Writes the edited docx back with the page layer's pre-step. */
export async function pageWriteBack(bridge: Bridge, edited: Uint8Array): Promise<WriteBack> {
  const parsed = await parseDocx(edited)
  const editedStylesXml = await readDocxPart(edited, 'word/styles.xml')
  if (FULL_REGISTRY)
    return fullWriteBack(bridge.doc, bridge.map, parsed, bridge.registry, editedStylesXml)
  const map = JSON.parse(JSON.stringify(bridge.map)) as Bridge['map']
  const rctx = new OoxmlToOdfContext(bridge.doc, map, parsed, bridge.registry, { editedStylesXml })
  const items = await preparePageWriteBack(rctx)
  rebuildOdtBody(rctx, items)
  updateOdtStyles(rctx)
  const patches = rctx.finish()
  return {
    content: applyTextPatches(bridge.doc.contentXml, patches['content.xml']),
    styles: applyTextPatches(bridge.doc.stylesXml ?? '', patches['styles.xml']),
    rctx,
  }
}

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
