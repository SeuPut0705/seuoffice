/**
 * The change report: what a conversion turns into something else
 * (`converted`) or leaves out (`dropped`), by feature, so the save dialog can
 * say "바뀌는 것" before the user commits to a format.
 *
 * - ODT → docx (`odtToDocx`): what changes if this ODT is saved as docx.
 * - docx → ODT (`docxToOdt`): what the ODT will not keep as it was.
 */
import type { BridgeMap } from '../core/convert'
import type { OdtDocument } from '../core/open'
import type { ObjectsExt } from '../objects'
import type { TableExt } from '../table'

export const REPORT_FEATURES = [
  'toc',
  'chart',
  'equation',
  'shape',
  'textbox',
  'columns',
  'citation',
  'cross_reference',
  'page_color',
  'mirror_margins',
  'theme',
  'comment',
  'revision',
  'ink',
  'watermark',
  'password',
  'protection',
  'form_field',
  'object',
] as const

export type ReportFeature = (typeof REPORT_FEATURES)[number]

export interface ReportItem {
  kind: 'converted' | 'dropped'
  feature: ReportFeature
  count: number
}

export type ConversionReport = ReportItem[]

/** Collects counts; items come out in the fixed feature order, zero counts left out. */
export class ReportBuilder {
  private readonly counts = new Map<string, number>()

  add(kind: ReportItem['kind'], feature: ReportFeature, count = 1): this {
    if (count <= 0) return this
    const key = `${kind}:${feature}`
    this.counts.set(key, (this.counts.get(key) ?? 0) + count)
    return this
  }

  build(): ConversionReport {
    const out: ConversionReport = []
    for (const feature of REPORT_FEATURES)
      for (const kind of ['converted', 'dropped'] as const) {
        const count = this.counts.get(`${kind}:${feature}`)
        if (count) out.push({ kind, feature, count })
      }
    return out
  }
}

/**
 * What saving the opened ODT as docx changes: locked objects become pictures
 * (by kind), Hancom fill-in fields become plain text, locked cells lose their
 * lock, tracked changes are flattened to their final text.
 */
export function odtToDocxReport(doc: OdtDocument, map: BridgeMap): ConversionReport {
  const report = new ReportBuilder()
  const objects = map.ext.objects as unknown as ObjectsExt | undefined
  for (const p of objects?.placeholders ?? []) {
    const feature: ReportFeature =
      p.kind === 'toc' ||
      p.kind === 'chart' ||
      p.kind === 'equation' ||
      p.kind === 'shape' ||
      p.kind === 'textbox' ||
      p.kind === 'revision'
        ? p.kind
        : 'object'
    if (feature !== 'revision') report.add('converted', feature)
  }
  // tracked changes: every change region the document records
  const regions = doc.contentXml.match(/<[\w-]*:?changed-region[\s>]/g)?.length ?? 0
  const revisionPlaceholders = (objects?.placeholders ?? []).filter(
    (p) => p.kind === 'revision',
  ).length
  report.add('converted', 'revision', Math.max(regions, revisionPlaceholders))
  // Hancom fill-in fields: one per start (or point) bookmark
  let fields = 0
  for (const p of map.paragraphs) {
    if (!p) continue
    for (const m of p.markers)
      if (m.field && (m.kind === 'bookmark-start' || m.kind === 'bookmark')) fields++
  }
  report.add('converted', 'form_field', fields)
  const table = map.ext.table as unknown as TableExt | undefined
  const sections = doc.contentXml.match(/<text:section\b[^>]*\stext:protected="true"/g)?.length ?? 0
  report.add('dropped', 'protection', (table?.protectedCells.length ?? 0) + sections)
  return report.build()
}
