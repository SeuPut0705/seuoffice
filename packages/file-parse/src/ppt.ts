import { callEngine } from './engine'

/**
 * Extract one readable text section per slide from a legacy PowerPoint 97-2003
 * file. A compound file the gate refuses throws `DamagedFileError`; only code
 * page 1200 (UTF-16LE) is decoded.
 */
export async function pptToText(bytes: Uint8Array): Promise<string> {
  return callEngine<string>('pptToText', [bytes])
}
