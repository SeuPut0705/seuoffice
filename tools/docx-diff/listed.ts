// The classes of divergences.json that inputs of comparison (f) fall in: where
// main decided that the Rust is right and the TypeScript is to be fixed, or
// where the answer is the host's. A spec names its class with `CallSpec.listed`;
// each predicate reads the input alone, and is as narrow as the input allows.

type Args = Record<string, unknown>

/**
 * A name pattern long enough for mergeOutputFileName's slice(0, 120) to reach a
 * character outside the BMP: the cut may leave half of it, which a Rust string
 * cannot hold.
 */
export function mergeFileNameLongAstral(text: string, _args: Args): string | undefined {
  return text.length > 120 && /[\ud800-\udbff][\udc00-\udfff]/.test(text)
    ? 'merge-file-name-cuts-a-surrogate-pair'
    : undefined
}

/**
 * A character-granularity comparison of text holding a character outside the
 * BMP: the TypeScript diff may split it into lone surrogates, which a Rust
 * string cannot hold.
 */
export function compareCharAstral(_text: string, args: Args): string | undefined {
  const options = args.options as { granularity?: unknown } | undefined
  return options?.granularity === 'char' &&
    /[\ud800-\udbff][\udc00-\udfff]/.test(JSON.stringify([args.original, args.revised]))
    ? 'compare-char-granularity-cuts-a-surrogate-pair'
    : undefined
}

/**
 * A w:spacing w:lineRule that is none of auto, atLeast, exact, in the text or
 * in a part of the arguments: the TypeScript passes whatever the attribute
 * holds into ParaFormat.lineRule against its declared type, which the generated
 * Rust model refuses. Only a mutated or hand-broken document gets there.
 */
export function lineRuleOutsideItsType(text: string, args: Args): string | undefined {
  for (const source of [text, JSON.stringify(args)]) {
    for (const rule of source.matchAll(/w:lineRule\s*=\s*\\?["']([^"'\\]*)/g)) {
      if (!['auto', 'atLeast', 'exact'].includes(rule[1]!)) return 'line-rule-outside-its-type'
    }
  }
  return undefined
}
