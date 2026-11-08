/**
 * Repair a damaged PDF (the PDF tools window, decision 0030): PDFium reads
 * the file leniently, rebuilding a broken cross-reference table as it goes,
 * and writes it out again in full. A file cut short that PDFium gives up on
 * can still have whole pages pdf-lib finds by reading it object by object;
 * salvagePdfBytes copies those into a new file. Runs in the shell's PDF job
 * process.
 */
import { PDFArray, PDFDocument, PDFName, PDFRef } from 'pdf-lib'

/** the PDFium calls this needs */
export interface RepairPdfium {
  HEAPU8: Uint8Array
  _malloc(size: number): number
  _free(ptr: number): void
  _FPDF_LoadMemDocument(ptr: number, size: number, password: number): number
  _FPDF_CloseDocument(doc: number): void
  _FPDF_GetPageCount(doc: number): number
  _FPDF_GetLastError(): number
  _PDFiumExt_OpenFileWriter(): number
  _PDFiumExt_CloseFileWriter(writer: number): void
  _PDFiumExt_GetFileWriterSize(writer: number): number
  _PDFiumExt_GetFileWriterData(writer: number, buffer: number, size: number): number
  _FPDF_SaveAsCopy(doc: number, writer: number, flags: number): number
}

/** FPDF_ERR_PASSWORD */
const ERR_PASSWORD = 4
/** FPDF_NO_INCREMENTAL: write the whole file, not an update appended to the old one */
const NO_INCREMENTAL = 2

export class RepairFailedError extends Error {
  constructor(readonly reason: 'unreadable' | 'encrypted') {
    super(
      reason === 'encrypted' ? 'the PDF is password-protected' : 'PDFium could not read the PDF',
    )
  }
}

/** Whether `password` opens `bytes` (PDFium reads AES-256 too): 'wrong-password' only for that */
export function pdfiumOpens(
  m: RepairPdfium,
  bytes: Uint8Array,
  password: string,
): 'ok' | 'wrong-password' | 'unreadable' {
  const ptr = m._malloc(bytes.length)
  const pw = Buffer.from(`${password}\0`, 'utf8')
  const pwPtr = m._malloc(pw.length)
  if (!ptr || !pwPtr) {
    if (ptr) m._free(ptr)
    if (pwPtr) m._free(pwPtr)
    return 'unreadable'
  }
  try {
    m.HEAPU8.set(bytes, ptr)
    m.HEAPU8.set(pw, pwPtr)
    const doc = m._FPDF_LoadMemDocument(ptr, bytes.length, pwPtr)
    if (doc) {
      m._FPDF_CloseDocument(doc)
      return 'ok'
    }
    return m._FPDF_GetLastError() === ERR_PASSWORD ? 'wrong-password' : 'unreadable'
  } finally {
    // the password's copy in the WebAssembly heap is wiped before it is freed
    m.HEAPU8.fill(0, pwPtr, pwPtr + pw.length)
    m._free(pwPtr)
    m._free(ptr)
  }
}

/** `bytes` written out again by PDFium, and its page count */
export function repairPdfBytes(
  m: RepairPdfium,
  bytes: Uint8Array,
): { bytes: Uint8Array; pages: number } {
  const ptr = m._malloc(bytes.length)
  if (!ptr) throw new RepairFailedError('unreadable')
  try {
    m.HEAPU8.set(bytes, ptr)
    const doc = m._FPDF_LoadMemDocument(ptr, bytes.length, 0)
    if (!doc) {
      throw new RepairFailedError(
        m._FPDF_GetLastError() === ERR_PASSWORD ? 'encrypted' : 'unreadable',
      )
    }
    try {
      const pages = m._FPDF_GetPageCount(doc)
      if (pages < 1) throw new RepairFailedError('unreadable')
      const writer = m._PDFiumExt_OpenFileWriter()
      try {
        if (!m._FPDF_SaveAsCopy(doc, writer, NO_INCREMENTAL)) {
          throw new RepairFailedError('unreadable')
        }
        const size = m._PDFiumExt_GetFileWriterSize(writer)
        const buf = m._malloc(size)
        try {
          m._PDFiumExt_GetFileWriterData(writer, buf, size)
          return { bytes: Uint8Array.from(m.HEAPU8.subarray(buf, buf + size)), pages }
        } finally {
          m._free(buf)
        }
      } finally {
        m._PDFiumExt_CloseFileWriter(writer)
      }
    } finally {
      m._FPDF_CloseDocument(doc)
    }
  } finally {
    m._free(ptr)
  }
}

/** pdf-lib's reading of `bytes` and its pages; null when it finds no page tree */
async function readPages(
  bytes: Uint8Array,
): Promise<{ doc: PDFDocument; indices: number[] } | null> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    // a file with no catalog loads, then has no page tree to ask
    return { doc, indices: doc.getPageIndices() }
  } catch {
    return null
  }
}

/** `bytes` up to the end of its last complete object; null when it has none */
function toLastObject(bytes: Uint8Array): Uint8Array | null {
  const end = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).lastIndexOf('endobj')
  return end < 0 ? null : bytes.subarray(0, end + 'endobj'.length)
}

/** Whether every content stream page `index` names is in the file */
function contentsPresent(doc: PDFDocument, index: number): boolean {
  const contents = doc.getPage(index).node.get(PDFName.of('Contents'))
  if (!contents) return true
  const resolved = contents instanceof PDFRef ? doc.context.lookup(contents) : contents
  if (!resolved) return false
  if (!(resolved instanceof PDFArray)) return true
  return resolved.asArray().every((item) => !(item instanceof PDFRef) || !!doc.context.lookup(item))
}

/** The pages pdf-lib can read out of `bytes`, copied into a new file; null when there are none */
export async function salvagePdfBytes(
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; pages: number } | null> {
  // pdf-lib stops at an object cut off partway; without it, the rest still reads
  const trimmed = toLastObject(bytes)
  const read = (await readPages(bytes)) ?? (trimmed ? await readPages(trimmed) : null)
  if (!read) return null
  const { doc: source, indices } = read
  const out = await PDFDocument.create({ updateMetadata: false })
  let pages = 0
  for (const index of indices) {
    try {
      // a page whose drawing was cut off would come back blank: left out
      if (!contentsPresent(source, index)) continue
      const [page] = await out.copyPages(source, [index])
      out.addPage(page)
      pages++
    } catch {
      // a page whose objects are gone is left out
    }
  }
  if (pages === 0) return null
  return { bytes: await out.save(), pages }
}
