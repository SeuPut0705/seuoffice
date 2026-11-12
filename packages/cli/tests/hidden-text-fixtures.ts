import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OLD_REDACT_NS } from '../../agent-core/src/old-names'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'

/** Fixtures for text a person marked "hidden from AI", as the apps write it. */

export const OWN_REDACT_NS = 'https://github.com/SeuPut0705/seuoffice/redaction/2026'
export const NAMESPACES: Array<[string, string]> = [
  ['the old namespace', OLD_REDACT_NS],
  ['this product’s own namespace', OWN_REDACT_NS],
]
export const LABEL = 'client phone'
export const SECRET = '13800138000'
export const PLACEHOLDER = `{{${LABEL}}}`

const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'

/** A docx whose one paragraph holds a span marked hidden from AI under `ns`. */
export async function hiddenDocx(dir: string, ns: string, name = 'hidden.docx'): Promise<string> {
  const bytes = await buildDocx({
    docRootExtraAttrs: `xmlns:mc="${MC}" xmlns:go="${ns}" mc:Ignorable="go"`,
    bodyXml:
      '<w:p><w:r><w:t xml:space="preserve">Call </w:t></w:r>' +
      '<w:r><w:rPr><w:bdr w:val="single" w:sz="6" w:color="6B4FC0"/>' +
      `<go:redact w:label="${LABEL}"/></w:rPr><w:t>${SECRET}</w:t></w:r>` +
      '<w:r><w:t xml:space="preserve"> now</w:t></w:r></w:p>',
  })
  const file = join(dir, name)
  writeFileSync(file, bytes)
  return file
}
