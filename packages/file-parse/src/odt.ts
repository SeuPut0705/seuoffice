import { odtToText as engineOdtToText } from '@genoffice/odt-engine'

/**
 * Plain text of an OpenDocument text file: paragraphs, tables (including the
 * ones Hancom puts in text boxes and nested ones) and notes. The engine runs
 * the zip gate before inflating anything and throws `OdtOpenError` for a
 * password-protected, non-ODT-text, gate-rejected or corrupt package.
 */
export async function odtToText(bytes: Uint8Array): Promise<string> {
  return engineOdtToText(new Uint8Array(bytes))
}
