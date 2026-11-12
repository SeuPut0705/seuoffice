/**
 * w:altChunk import (display only). The chunk part stays untouched in the
 * package and is re-emitted verbatim on save; the host converts HTML / MHT
 * to a docx with the html2docx chain (needs a browser), which the parser
 * then reads like any other document. A .docx chunk is parsed directly.
 */
import type { RelInfo } from './parse-xml-text'
import { invoke, invokeAsync } from './engine'

export type AltChunkHtmlConverter = (html: string) => Promise<Uint8Array | null>
let htmlConverter: AltChunkHtmlConverter | null = null
export function setAltChunkHtmlConverter(fn: AltChunkHtmlConverter | null): void {
  htmlConverter = fn
}
export type AltChunkKind = 'html' | 'mht' | 'docx'
export function decodeQuotedPrintable(text: string): Uint8Array {
  return invoke('decodeQuotedPrintable', [text]) as never
}
/**
 * MHT (Word "Single File Web Page") -> the HTML document string. Referenced
 * image parts are inlined as data URLs by Content-Location / Content-ID so
 * the converter sees them without the package.
 */
export async function decodeMhtToHtml(bytes: Uint8Array): Promise<string | null> {
  return invokeAsync('decodeMhtToHtml', [bytes]) as never
}
export function altChunkPartPath(
  rels: Map<string, RelInfo>,
  rId: string,
  sourcePath = 'word/document.xml',
): string | null {
  return invoke('altChunkPartPath', [rels, rId, sourcePath]) as never
}
/** the converter the host installed, for the engine's alt-chunk pass (engine-hand.ts) */
export function altChunkHtmlConverter(): AltChunkHtmlConverter | null {
  return htmlConverter
}
