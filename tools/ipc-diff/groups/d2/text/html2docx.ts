/** `packages/html2docx`'s `convertHtmlToDocx`, answering from the case as `HtmlEngine::html_to_docx` */
import { fileURLToPath } from 'node:url'
import { answers, fileText } from './fakes.ts'

export async function convertHtmlToDocx(source: { url: string }): Promise<{ docx: Uint8Array }> {
  const a = answers()
  a.log.push(['convertHtmlToDocx', fileText(fileURLToPath(source.url))])
  return { docx: new Uint8Array(a.bytes('html_to_docx', 'DOCX')) }
}
