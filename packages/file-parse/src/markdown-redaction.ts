import { callEngine } from './engine'

/**
 * A Markdown source with each withheld span of the Markdown editor
 * (`<span class="redact-span" data-redaction="" data-label="…">`) as its
 * `{{label}}` marker. A span whose end cannot be told for certain throws
 * `RedactionMarkError`; a file that only names the mark in prose reads as it is.
 */
export function redactMarkdownSource(source: string): string {
  return callEngine<string>('redactMarkdownSource', [source])
}
