import type { SourceInfo } from './types'
import { invoke } from './engine'

export function parseSourcesXml(xml: string): SourceInfo[] {
  return invoke('parseSourcesXml', [xml]) as never
}
/** in-text citation, e.g. "(Smith, 2024)" */
export function citationText(source: SourceInfo): string {
  return invoke('citationText', [source]) as never
}
/** one bibliography line in a simple APA-like format */
export function bibliographyLine(source: SourceInfo): string {
  return invoke('bibliographyLine', [source]) as never
}
