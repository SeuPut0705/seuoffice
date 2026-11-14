import { callEngine } from './engine'

/**
 * Extract readable body and text-box content from a legacy Word 97-2003 file
 * (a DOCX under a .doc name is read by the docx reader). A compound file the
 * gate refuses throws `DamagedFileError`.
 */
export async function docToText(bytes: Uint8Array): Promise<string> {
  return callEngine<string>('docToText', [bytes])
}
