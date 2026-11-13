/**
 * `apps/shell/src/main/pdf-tools/tools.ts` with its pdf-lib calls answering
 * from the case, as the Rust `PdfToolsEngine` fake does: `inspect_pdf`,
 * `encrypted_page_count`, `is_image`, `run_tool`. The option checks and
 * names are the real module's.
 */
import { PdfToolRefusal } from '../../../../../apps/shell/src/main/pdf-tools/tools'
import type { InspectResult, RunDeps } from '../../../../../apps/shell/src/main/pdf-tools/tools'
import { answer, bytes, log } from './state.cts'

export * from '../../../../../apps/shell/src/main/pdf-tools/tools'

const field = (v: unknown, key: string): unknown =>
  v && typeof v === 'object' && key in v ? (v as Record<string, unknown>)[key] : undefined

export async function inspectPdf(_bytes: Uint8Array): Promise<InspectResult> {
  const a = answer('inspect_pdf')
  const problem = field(a, 'problem')
  if (problem !== undefined) return { ok: false, problem: problem as never }
  const pages = field(a, 'pages')
  return { ok: true, pages: typeof pages === 'number' ? pages : 1 }
}

export async function encryptedPageCount(_bytes: Uint8Array): Promise<number> {
  const a = answer('encrypted_page_count')
  return typeof a === 'number' ? a : 0
}

export function inspectImage(_bytes: Uint8Array): InspectResult {
  return answer('is_image') === false ? { ok: false, problem: 'not-image' } : { ok: true, pages: 1 }
}

export async function runPdfTool(
  tool: string,
  inputs: Uint8Array[],
  options: unknown,
  deps: RunDeps = {},
): Promise<Uint8Array[]> {
  log(['runPdfTool', tool, inputs.length, options])
  const a = answer('run_tool')
  if (a === undefined) return inputs.slice(0, 1)
  const progress = field(a, 'progress')
  for (const step of Array.isArray(progress) ? progress : []) deps.onProgress?.(step[0], step[1])
  if (deps.signal?.aborted) throw new Error('aborted')
  const refusal = field(a, 'refusal')
  if (refusal !== undefined) throw new PdfToolRefusal(refusal as never)
  const error = field(a, 'error')
  if (error !== undefined) throw new Error(String(error))
  const outputs = field(a, 'outputs')
  return (Array.isArray(outputs) ? outputs : []).map(bytes)
}
