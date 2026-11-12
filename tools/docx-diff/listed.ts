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

const SINGLE_QUOTED_REVISION_ATTRIBUTE =
  /\s(?:w:author|w:date|w:id|w16du:dateUtc|w:vMerge|w:vMergeOrig)='/

/** An attribute the revision readers look for, in single quotes. */
export function singleQuotedRevisionAttribute(text: string): string | undefined {
  return SINGLE_QUOTED_REVISION_ATTRIBUTE.test(text)
    ? 'revision-attribute-in-single-quotes'
    : undefined
}

/**
 * What the functions that resolve revisions answer differently by decision:
 * an attribute in single quotes, or, where the call can revert it (no accept,
 * and for resolvePropChangeXml the change it is asked for), a w:pPrChange
 * right after the open tag of its w:pPr, whose old properties the TypeScript
 * loses. An input of both is counted under the first.
 */
export function revisionClass(text: string, args: Args): string | undefined {
  if (SINGLE_QUOTED_REVISION_ATTRIBUTE.test(text)) return 'revision-attribute-in-single-quotes'
  const reverts =
    args.mode !== 'accept' && (args.changeName === undefined || args.changeName === 'w:pPrChange')
  return reverts && /<w:pPr(?:\s[^>]*)?><w:pPrChange[\s>]/.test(text)
    ? 'reject-of-a-ppr-change-that-opens-its-ppr'
    : undefined
}

/** A v:fill opacity given as a percentage. */
export function percentOpacity(text: string, args: Args): string | undefined {
  const types = typeof args.types === 'string' ? args.types : ''
  return /<v:fill\b[^>]*\bopacity\s*=\s*(?:"[^"]*%\s*"|'[^']*%\s*')/.test(text + types)
    ? 'vml-fill-opacity-in-percent'
    : undefined
}

const SAME_ON_EVERY_HOST =
  /^(?:utf-?8|utf-16(?:le|be)?|unicode|us-ascii|ascii|latin1|iso-8859-1|windows-1252|cp1252)$/i

const bytesOf = (text: string, args: Args): Buffer =>
  Array.isArray(args.bytes) ? Buffer.from(args.bytes as number[]) : Buffer.from(text, 'utf8')

/**
 * The bytes decodeHtmlBytes decodes with a legacy charset: `TextDecoder` is
 * ICU's on Node and the Encoding Standard's in Chromium and in the Rust, and
 * they differ on bytes outside the common tables. The label is read as the
 * function reads it: none after a byte order mark, else the first meta
 * charset or xml encoding of the first 4096 bytes.
 */
export function legacyCharsetOfHtml(text: string, args: Args): string | undefined {
  const bytes = bytesOf(text, args)
  const mark = bytes.subarray(0, 3).toString('hex')
  if (mark === 'efbbbf' || mark.startsWith('fffe') || mark.startsWith('feff')) return undefined
  const head = bytes.subarray(0, 4096).toString('latin1')
  const label =
    /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i.exec(head)?.[1]
  return label !== undefined && !SAME_ON_EVERY_HOST.test(label)
    ? 'legacy-charset-decoding-is-the-hosts'
    : undefined
}

/**
 * The same for decodeMhtToHtml, where the label is in a MIME header or in the
 * part once its transfer encoding is undone: any legacy label anywhere in the
 * message. Wider than the defect, since reading it as the function does
 * would be the function again.
 */
export function legacyCharsetOfMht(text: string, args: Args): string | undefined {
  const message = bytesOf(text, args).toString('latin1')
  for (const found of message.matchAll(/(?:charset|encoding)\s*=\s*["']?\s*([\w-]+)/gi)) {
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
