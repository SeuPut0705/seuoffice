import { serializeXNode, type XNode, xmlParser } from './reference/xml-utils'
import { failed } from './engine'
import { type Comparison, engine } from './harness'

export type Outcome = { xml: string } | { error: string }

/** `maxNestedTags` of the engine's `xmlParser`. */
const MAX_NESTED_TAGS = 100

/** What parse.ts stores as `rawRPr`: the parsed fragment serialized again. */
export function typescriptRoundTrip(fragment: string): Outcome {
  try {
    return { xml: (xmlParser.parse(fragment) as XNode[]).map(serializeXNode).join('') }
  } catch (error) {
    return { error: String(error) }
  }
}

export function rustRoundTrip(fragments: string[]): Outcome[] {
  const { header } = engine.call<{ results: Outcome[] }>({
    cmd: 'roundTripXml',
    fragments,
    maxNestedTags: MAX_NESTED_TAGS,
  })
  if (failed(header)) throw new Error(`roundTripXml failed: ${header.error.message}`)
  return header.results
}

/** Equal means the same text, or both sides refusing the fragment. */
export function compareRoundTrips(
  comparison: Comparison,
  where: string,
  fragments: string[],
): void {
  if (fragments.length === 0) return
  const results = rustRoundTrip(fragments)
  fragments.forEach((fragment, index) => {
    const typescript = typescriptRoundTrip(fragment)
    if ('error' in typescript) comparison.typescriptThrew += 1
    const rust = results[index]!
    const same =
      'xml' in typescript ? 'xml' in rust && rust.xml === typescript.xml : 'error' in rust
    comparison.record(
      same
        ? null
        : `${where}, fragment ${index}: ${JSON.stringify(fragment.slice(0, 400))}\n` +
            `      typescript ${JSON.stringify(typescript).slice(0, 400)}\n` +
            `      rust       ${JSON.stringify(rust).slice(0, 400)}`,
    )
  })
}

const MUTATION_TOKENS = [
  ...'<>/"\'=&; \t\r\n',
  '\r\n',
  '&amp;',
  '&lt;',
  '&quot;',
  '&#0;',
  '&#x1F;',
  '&#65;',
  '&#xD800;',
  '&unknown;',
  '<!--',
  '-->',
  '<![CDATA[',
  ']]>',
  '<![',
  '<?',
  '?>',
  '<?xml version="1.1"?>',
  '</w:x>',
  '<w:x>',
  '<w:x/>',
  ' a="b"',
  '\u00E9',
  '\u{1F600}',
  '\u00A0',
  '\uFEFF',
  '\u0001',
  'constructor',
  'toString',
  '__proto__',
  '#text',
  '10',
]

/**
 * One to three edits: delete, insert a token, duplicate a slice. Edits fall on
 * code point boundaries so the result has no lone surrogate, which JSON could
 * not carry to the Rust side.
 */
export function mutate(fragment: string, random: () => number): string {
  const points = Array.from(fragment)
  const at = (): number => Math.floor(random() * (points.length + 1))
  for (let edits = 1 + Math.floor(random() * 3); edits > 0; edits--) {
    const kind = random()
    if (kind < 0.35) {
      points.splice(at(), 1 + Math.floor(random() * 6))
    } else if (kind < 0.85) {
      const token = MUTATION_TOKENS[Math.floor(random() * MUTATION_TOKENS.length)]!
      points.splice(at(), 0, token)
    } else {
      const from = at()
      points.splice(at(), 0, ...points.slice(from, from + 1 + Math.floor(random() * 12)))
    }
  }
  return points.join('')
}
