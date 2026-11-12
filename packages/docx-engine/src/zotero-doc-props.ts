import { invoke } from './engine'

export function parseZoteroDocumentDataXml(xml: string): string {
  return invoke('parseZoteroDocumentDataXml', [xml]) as never
}
export function patchZoteroDocumentDataXml(xml: string | null, data: string): string {
  return invoke('patchZoteroDocumentDataXml', [xml, data]) as never
}