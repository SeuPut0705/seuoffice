/**
 * `apps/shell/src/main/pdf2docx-local.ts` for the shell entry: the conversion
 * answers from the case (`convert_to_office`), as the Rust
 * `PdfToolsEngine::convert_to_office` fake does, and logs the same line.
 */
import { PdfLoadError } from '../../../../../apps/shell/src/main/pdf2docx-local'
import { answer, bytes, log } from './state.cts'

export * from '../../../../../apps/shell/src/main/pdf2docx-local'

const field = (v: unknown, key: string): unknown =>
  v && typeof v === 'object' && key in v ? (v as Record<string, unknown>)[key] : undefined

/** one attempt: the password retry loop is the real one */
async function convert(
  pdfPath: string,
  password: string | undefined,
  onProgress?: (page: number, total: number) => void,
) {
  log(['convertPdfFileToOfficeLocal', ['docx', pdfPath, password ?? null]])
  const a = answer('convert_to_office') ?? {}
  onProgress?.(1, 1)
  const load = field(a, 'load')
  if (load !== undefined) throw new PdfLoadError(load as never, 0)
  const error = field(a, 'error')
  if (error !== undefined) throw new Error(String(error))
  const results = field(a, 'pageResults')
  return {
    docx: bytes(field(a, 'bytes')),
    scannedDocument: field(a, 'scannedDocument') === true,
    pageResults: (Array.isArray(results) ? results : []).map(([page, status]) => ({
      page,
      status,
    })),
  }
}

export async function convertPdfFileToDocxLocalWithPrompt(
  pdfPath: string,
  promptPassword: (retry: boolean) => Promise<string | null>,
  onProgress?: (page: number, total: number) => void,
) {
  let password: string | undefined
  for (;;) {
    try {
      return await convert(pdfPath, password, onProgress)
    } catch (err) {
      if (!(err instanceof PdfLoadError) || err.code !== 'password-required') throw err
      const entered = await promptPassword(password !== undefined)
      if (entered === null) return null
      password = entered
    }
  }
}
