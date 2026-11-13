/**
 * `@seuoffice/file-parse` for the quick-look group: `extract.ts` asks it for
 * the text of a file, and the case says what it answers (`hosts.w.quickLook.parse`, a list
 * of `{ path, ok, text, error }` or `{ path, throws }`; a path not listed is read as
 * UTF-8 text). Each call is one line of the host log, as the Rust fake writes it.
 */
import { readFileSync } from 'node:fs'
import { quickLookBox } from './quick-look-box.ts'

export async function parseFileToText(path: string): Promise<unknown> {
  const box = quickLookBox()
  box.log.push(['parseFileToText', path])
  const spec = box.parse[path]
  if (!spec) return { ok: true, kind: 'text', text: readFileSync(path, 'utf8') }
  if (spec.throws !== undefined) throw new Error(spec.throws)
  return {
    ok: spec.ok ?? true,
    kind: 'text',
    ...(spec.text === undefined ? {} : { text: spec.text }),
    ...(spec.error === undefined ? {} : { error: spec.error }),
  }
}
