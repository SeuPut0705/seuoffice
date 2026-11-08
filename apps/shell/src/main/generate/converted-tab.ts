/**
 * The last step of a conversion without AI (8.6): the new tab of the result's
 * editor exists, its renderer has not asked yet; queue the content for that
 * tab's webContents (taken once, as a new unsaved document) and record that
 * the conversion happened into this tab from these sources, for the
 * provenance reader (spec 9).
 */
import type { HandoffWebContents } from '@genoffice/electron-utils/generate-handoff'
import { queueMarkdownSeedFor } from '../../../../markdown/src/main/seed-main'
import { queueMindmapSeedFor } from '../../../../mindmap/src/main/seed-main'
import { queueSlidesSeedFor } from '../../../../slides/src/main/seed-queue'
import type { ConvertedDocument } from './convert'
import { recordGenerateConverted } from './handoff'

export function queueConvertedContent(contents: HandoffWebContents, doc: ConvertedDocument): void {
  const { content } = doc
  if (content.target === 'markdown') queueMarkdownSeedFor(contents, content.markdown)
  else if (content.target === 'slides') queueSlidesSeedFor(contents, content.deck)
  else queueMindmapSeedFor(contents, { outline: content.outline })
  recordGenerateConverted({
    webContentsId: contents.id,
    target: content.target,
    kind: content.kind,
    sources: doc.sources,
    conversionId: doc.id,
  })
}
