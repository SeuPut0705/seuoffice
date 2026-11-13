import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { typescriptOutcome } from '../fileparse-diff/outcome'
import { parseXml } from '../../packages/epub-engine/src/xml-positions'
import { SPECS } from './xml-cases'

/**
 * Writes `crates/epub-engine/tests/xml-answers.json`: the inputs of the gate cases that no step of the host is needed
 * for, with the answer of the TypeScript, which `crates/epub-engine/tests/xml.rs` replays through `book_call::call`.
 * Run with `npx tsx xml-fixture.ts` from this directory, on Node 22.
 */
/** A doctype and a named reference parse5 resolves: the only way a position-tracking parse asks the host. */
const needsHost = (text = ''): boolean =>
  /<!DOCTYPE/i.test(text) && /&(?!(?:amp|lt|gt|quot|apos);)[^\s&;<]+;/.test(text)
const BOOKS_WITH_HTML = /HTML|soup|entities, namespaces|chapters that are/

/** Whether the inputs of a function can be answered without parse5. */
const wanted: Record<
  string,
  (input: { label: string; text?: string; args?: Record<string, unknown> }) => boolean
> = {
  parseXml: () => true,
  resolveHtmlEntity: (input) => !/^[A-Za-z][A-Za-z0-9]*$/.test(input.text ?? ''),
  decodeCharacterData: (input) => input.args?.withHtml === false,
  parseXmlPositions: (input) => !needsHost(input.text),
  checkWellFormed: (input) => !needsHost(input.text),
  textRawOffset: (input) => !needsHost(input.text) && /#[01] k=(0|2|5|100000)$/.test(input.label),
  extractChapterText: (input) => !needsHost(input.text) && parseXml(input.text ?? '').ok,
  maskUndefinedEntities: () => true,
  formatModifiedTimestamp: () => true,
  modifiedReplacements: () => true,
  epubTranslationUnits: () => true,
  buildTranslatedEpub: (input) =>
    /^(epub3|epub3 with many block kinds|epub2 vertical rtl|epub3 vertical|epub3 with obfuscated fonts|epub3 with a nav that is also a chapter|epub3 without identifiers and languages): /.test(
      input.label,
    ),
  parseTranslationOutput: () => true,
  estimateTokens: () => true,
  batchEpubTranslationItems: () => true,
  createEpubTranslationModelCall: () => true,
  openEpub: (input) => !BOOKS_WITH_HTML.test(input.label),
  saveEpub: (input) =>
    !BOOKS_WITH_HTML.test(input.label) &&
    !/^save time (?!now|epoch|NaN|year 10000)|edit with (a bad|a known) entity/.test(input.label),
}

const cases = []
for (const spec of SPECS) {
  const keep = wanted[spec.fn]
  if (keep === undefined) continue
  for (const input of await spec.built()) {
    // serde_json reads nesting to 128 levels, and these answers nest deeper
    if (!keep(input) || /deep nesting|deep XML/.test(input.label)) continue
    cases.push({
      fn: spec.fn,
      label: input.label,
      text: input.text ?? '',
      ...(input.bytes === undefined
        ? {}
        : { bytesBase64: Buffer.from(input.bytes).toString('base64') }),
      args: input.args ?? {},
      expected: await typescriptOutcome(spec, input),
    })
  }
}
const out = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../crates/epub-engine/tests/xml-answers.json',
)
writeFileSync(out, JSON.stringify(cases), 'utf8')
console.log(`${cases.length} cases written to ${out}`)
