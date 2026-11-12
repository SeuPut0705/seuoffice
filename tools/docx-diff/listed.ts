// The classes of divergences.json that inputs of comparison (f) fall in: where
// main decided that the Rust is right and the TypeScript is to be fixed, or
// where the answer is the host's. A spec names its class with `CallSpec.listed`;
// each predicate reads the input alone, and is as narrow as the input allows.

type Args = Record<string, unknown>

const partOf = (args: Args, name: string): string =>
  (args.parts as Array<[string, string]> | undefined)?.find(([part]) => part === name)?.[1] ?? ''

/**
 * resolveRunProps takes no paragraph style where the paragraph names one the
 * document does not have; the Rust falls back to the default paragraph style.
 * `args.paraStyleId`, or the w:pStyle of the text, is no style of `args.parts`.
 */
export function missingParagraphStyle(text: string, args: Args): string | undefined {
  const named = /<w:pStyle\b[^>]*?\bw:val\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(text)
  const id =
    typeof args.paraStyleId === 'string' ? args.paraStyleId : (named?.[1] ?? named?.[2] ?? '')
  if (id === '') return undefined
  const styles = partOf(args, 'word/styles.xml')
  return styles.includes(`w:styleId="${id}"`) || styles.includes(`w:styleId='${id}'`)
    ? undefined
    : 'run-of-a-paragraph-whose-style-is-missing'
}

/** A wp:wrapNone after the first a:graphic belongs to a nested drawing. */
export function nestedWrapNone(text: string): string | undefined {
  const graphicAt = text.indexOf('<a:graphic')
  return graphicAt !== -1 && text.includes('<wp:wrapNone', graphicAt)
    ? 'wrap-none-of-a-nested-drawing'
    : undefined
}

/**
 * What the revision functions answer differently by decision: an attribute
 * they look for in single quotes, or a w:pPrChange right after the open tag of
 * its w:pPr, whose old properties a reject loses in the TypeScript.
 */
export function revisionClass(text: string): string | undefined {
  if (/\s(?:w:author|w:date|w:id|w16du:dateUtc|w:vMerge|w:vMergeOrig)='/.test(text)) {
    return 'revision-attribute-in-single-quotes'
  }
  return /<w:pPr(?:\s[^>]*)?><w:pPrChange[\s>]/.test(text)
    ? 'reject-of-a-ppr-change-that-opens-its-ppr'
    : undefined
}

/** A v:fill opacity given as a percentage. */
export function percentOpacity(text: string, args: Args): string | undefined {
  const types = typeof args.types === 'string' ? args.types : ''
  return /\bopacity\s*=\s*(?:"[^"]*%\s*"|'[^']*%\s*')/.test(text + types)
    ? 'vml-fill-opacity-in-percent'
    : undefined
}

const SAME_ON_EVERY_HOST =
  /^(?:utf-?8|utf-16(?:le|be)?|unicode|us-ascii|ascii|latin1|iso-8859-1|windows-1252|cp1252)$/i

/**
 * Bytes that declare a legacy charset: `TextDecoder` is ICU's on Node and the
 * Encoding Standard's in Chromium and in the Rust, and they differ on bytes
 * outside the common tables.
 */
export function legacyCharset(text: string, args: Args): string | undefined {
  const head = Array.isArray(args.bytes)
    ? String.fromCharCode(...(args.bytes as number[]).slice(0, 70_000))
    : text
  for (const found of head.matchAll(/(?:charset|encoding)\s*=\s*["']?\s*([\w-]+)/gi)) {
    if (!SAME_ON_EVERY_HOST.test(found[1]!)) return 'legacy-charset-decoding-is-the-hosts'
  }
  return undefined
}

export const NON_FINITE_NUMBER = 'non-finite-number-in-a-drawing'

function holdsNonFinite(value: unknown): boolean {
  if (typeof value === 'string') return /^-?(?:NaN|Infinity)$/.test(value)
  return typeof value === 'object' && value !== null && Object.values(value).some(holdsNonFinite)
}

/**
 * A drawing function given a NaN or an infinity (crossing as the text 'NaN',
 * 'Infinity', '-Infinity'): the TypeScript writes it into the XML, the Rust
 * never does. Where the TypeScript writes none the two agree.
 */
export function nonFiniteNumber(_text: string, args: Args): string | undefined {
  return holdsNonFinite(args) ? NON_FINITE_NUMBER : undefined
}
