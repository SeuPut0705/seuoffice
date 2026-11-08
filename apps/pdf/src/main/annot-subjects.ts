/**
 * The /Subj of the markup annotations in a file (reading-assist spec 4.3): an
 * accepted AI highlight keeps its category there, and the screen's PDF.js
 * does not read it. The annotation panel shows the category and filters by
 * it. Reading only; the bytes are not changed.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib'
import type { PdfAnnotSubject } from '../shared/ipc'

const MARKUP_SUBTYPES = new Set(['Highlight', 'Underline', 'StrikeOut'])

/**
 * Every markup annotation with a /Subj text: its 0-based page, its object
 * number (pdf.js shows it as the annotation id "<n>R") and the text. An
 * encrypted file answers none: its strings cannot be read without the key.
 * A file pdf-lib cannot read answers none.
 */
export async function readAnnotSubjects(bytes: Uint8Array): Promise<PdfAnnotSubject[]> {
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  } catch {
    return []
  }
  if (doc.isEncrypted) return []
  const out: PdfAnnotSubject[] = []
  doc.getPages().forEach((page, pageIndex) => {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    if (!annots) return
    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i)
      // a direct annotation dictionary has no object number for the panel to match
      if (!(entry instanceof PDFRef)) continue
      const dict = doc.context.lookupMaybe(entry, PDFDict)
      if (!dict) continue
      const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText()
      if (!subtype || !MARKUP_SUBTYPES.has(subtype)) continue
      const subj = dict.lookup(PDFName.of('Subj'))
      if (!(subj instanceof PDFString) && !(subj instanceof PDFHexString)) continue
      const text = subj.decodeText().trim()
      if (text) out.push({ pageIndex, objNum: entry.objectNumber, subj: text })
    }
  })
  return out
}
