/**
 * `@seuoffice/file-parse` for the text editors' groups: the attachable-format
 * constants are the real ones (the Rust side ports them); reading a file's
 * text and sniffing a draw.io picture answer from the case, as
 * `HtmlEngine::parse_file_to_text` and `diagram_picture_ext_of` do.
 */
import { answers } from './fakes.ts'

export * from '@seuoffice/file-parse'

export async function parseFileToText(filePath: string): Promise<unknown> {
  const a = answers()
  a.log.push(['parseFileToText', filePath])
  const parsed = a.answer('parse_file_to_text')
  return parsed !== null && typeof parsed === 'object'
    ? parsed
    : { ok: true, kind: 'text', text: '' }
}

export function diagramPictureExtOf(_filePath: string): string | null {
  return answers().string('diagram_picture_ext_of')
}
