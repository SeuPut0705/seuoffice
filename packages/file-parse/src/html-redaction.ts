import { callEngine } from './engine'

/**
 * An HTML page with its withheld regions as `{{label}}` markers, as the HTML
 * editor withholds them: `data-gx-redact` (the element's content),
 * `data-gx-redact-<attr>` (that attribute's value) and `/*gx:redact:label*\/`
 * before a string in a `<script>`. A mark the parser sees and the editor's scan
 * would not honour throws `RedactionMarkError`. parse5 is the host's
 * (host-steps.ts).
 */
export function redactHtmlSource(source: string): string {
  return callEngine<string>('redactHtmlSource', [source])
}
