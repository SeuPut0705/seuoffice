/** `@seuoffice/odt-engine`'s `docxToOdt`, answering from the case as the Rust fakes' `docx_to_odt` */
import { answers } from './fakes.ts'

interface Answer {
  odt?: string
  report?: { kind: string; feature: string; count?: number }[]
  error?: string
}

export async function docxToOdt(docx: Uint8Array): Promise<unknown> {
  const a = answers()
  a.log.push(['docxToOdt', Buffer.from(docx).toString('hex')])
  const v = a.answer('docx_to_odt')
  const answer: Answer = v !== null && typeof v === 'object' ? v : {}
  if (typeof answer.error === 'string') throw new Error(answer.error)
  return {
    odtBytes: new Uint8Array(Buffer.from(answer.odt ?? 'ODT', 'utf8')),
    report: (answer.report ?? []).map((r) => ({ ...r, count: r.count ?? 1 })),
  }
}
