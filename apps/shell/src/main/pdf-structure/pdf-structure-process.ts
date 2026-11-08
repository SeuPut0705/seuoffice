/**
 * Entry of a structure-job process (Electron utilityProcess, started by
 * pdf-structure-ipc.ts; bundled as its own chunk via `?modulePath`). It takes
 * one `run` message, sets PDFium and the local OCR engine up the way
 * pdf2docx-local.ts does, runs the job and answers. The parent ends the
 * process after the answer, on cancel, and when the document's tab closes.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { OcrEngine, PdfiumModule } from '../../../../../packages/pdf2docx/src'
import {
  createVisionOcrEngine,
  createWindowsOcrEngine,
} from '../../../../../packages/pdf2docx/src/ocr-vision'
import type { HbSubsetWasm } from '../../../../../packages/pdf-structure/src/writeback'
import { aiReadingsFromStore, runStructureJob, translationsFromStore } from './jobs'
import { errorMessageOf, parseRunMessage, type ChildMessage, type ProcessSetup } from './protocol'

interface ParentPort {
  once(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: ChildMessage): void
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort

function loadPdfium(wasmPath: string): () => Promise<PdfiumModule> {
  let pending: Promise<PdfiumModule> | null = null
  return () => {
    pending ??= (async () => {
      const { init } = (await import('@embedpdf/pdfium')) as unknown as {
        init(overrides: object): Promise<object>
      }
      const raw = readFileSync(wasmPath)
      // exact slice: Buffer.buffer may be a shared pool larger than the file
      const wasmBinary = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
      // thisProgram: emscripten writes argv[1] through an ASCII-only path;
      // a CJK document path would abort init (see pdf2docx-local.ts)
      const wrapped = (await init({ wasmBinary, thisProgram: 'genoffice-pdf' })) as {
        pdfium?: unknown
      }
      const m = (wrapped.pdfium ?? wrapped) as PdfiumModule & { _PDFiumExt_Init(): void }
      m._PDFiumExt_Init()
      return m
    })()
    return pending
  }
}

/** the font subsetter wasm, read once when a translated PDF needs it */
function loadHbSubsetWasm(path: string): () => Promise<HbSubsetWasm> {
  let pending: Promise<HbSubsetWasm> | null = null
  return () => (pending ??= readFile(path).then((buf) => new Uint8Array(buf)))
}

/** first helper that yields an engine; null = scanned pages stay page images */
function ocrEngine(setup: ProcessSetup): () => OcrEngine | null {
  let engine: OcrEngine | null | undefined
  return () => {
    if (engine !== undefined) return engine
    const create = process.platform === 'darwin' ? createVisionOcrEngine : createWindowsOcrEngine
    engine = null
    for (const path of setup.ocrHelperPaths) {
      const found = create(path)
      if (found) {
        engine = found
        break
      }
    }
    return engine
  }
}

if (port) {
  port.once('message', (event) => {
    const run = parseRunMessage(event.data)
    if (!run) {
      port.postMessage({ type: 'error', error: 'invalid-request', message: 'bad run message' })
      return
    }
    const deps = {
      pdfium: loadPdfium(run.setup.wasmPath),
      ocr: ocrEngine(run.setup),
      aiReadings: run.setup.userDataDir ? aiReadingsFromStore(run.setup.userDataDir) : null,
      translations: run.setup.userDataDir ? translationsFromStore(run.setup.userDataDir) : null,
      hbSubsetWasm: run.setup.hbSubsetWasmPath
        ? loadHbSubsetWasm(run.setup.hbSubsetWasmPath)
        : null,
      qpdfWasmPath: run.setup.qpdfWasmPath ?? null,
    }
    runStructureJob(run.job, deps, (done, total) =>
      port.postMessage({ type: 'progress', done, total }),
    ).then(
      (value) => port.postMessage({ type: 'result', value }),
      (err: unknown) => port.postMessage(errorMessageOf(err)),
    )
  })
}
