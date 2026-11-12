// The classes of divergences.json that inputs of comparison (f) fall in: where
// main decided that the Rust is right and the TypeScript is to be fixed, or
// where the answer is the host's. A spec names its class with `CallSpec.listed`;
// each predicate reads the input alone, and is as narrow as the input allows.

type Args = Record<string, unknown>

/** The names every plain object inherits from `Object.prototype`. */
const OBJECT_PROTOTYPE_MEMBERS = new Set([
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
])

/**
 * An a:custGeom naming an `Object.prototype` member as a guide, in an a:gd
 * name or formula or in a point or arc operand: parseCustGeom of the
 * TypeScript reads that name off the prototype (tools/pptx-diff's class of
 * the same id).
 */
export function custgeomInheritedGuide(text: string, _args: Args): string | undefined {
  for (const geom of text.matchAll(/<a:custGeom\b[\s\S]*?<\/a:custGeom>/g)) {
    for (const attr of geom[0].matchAll(/\b(?:name|fmla|x|y|wR|hR|stAng|swAng)\s*=\s*"([^"]*)"/g)) {
      if (attr[1]!.trim().split(/\s+/).some((token) => OBJECT_PROTOTYPE_MEMBERS.has(token))) {
        return 'custgeom-inherited-guide'
      }
    }
  }
  return undefined
}

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
