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
 * A block whose originalXml holds a self-closing w:pPrChange with attributes
 * and a later `</w:pPrChange>`: applyProtectedLeadingBreaks strips everything
 * between the two in the TypeScript, the live pPr included.
 */
export function selfClosingPprChange(_text: string, args: Args): string | undefined {
  const blocks = Array.isArray(args.blocks) ? (args.blocks as unknown[]) : []
  const found = blocks.some((block) => {
    const xml = (block as { originalXml?: unknown } | null)?.originalXml
    if (typeof xml !== 'string') return false
    const record = /<w:pPrChange\s[^>]*\/>/.exec(xml)
    return record !== null && xml.includes('</w:pPrChange>', record.index + record[0].length)
  })
  return found ? 'self-closing-ppr-change-read-as-paired' : undefined
}

/**
 * What the functions that resolve revisions answer differently by decision:
 * an attribute in single quotes, or, where the call can revert it (no accept,
 * and for resolvePropChangeXml the change it is asked for), a w:pPrChange
 * whose old properties the TypeScript loses. That is one right after the open
 * tag of its w:pPr, or one after a paragraph-mark w:rPr that opens the w:pPr
 * and that the same call removes whole: one holding only an empty record
 * (any revert of formatting empties it), or only a w:ins or w:del mark
 * (every revision rejected, with no filter). The same loss, a restore
 * inserted where a removal starts, happens for the record of any holder that
 * a mark with a close tag opens when the holder itself never closes (a
 * mutated text): there the restore has no length. An input of both is
 * counted under the first.
 */
export function revisionClass(text: string, args: Args): string | undefined {
  if (SINGLE_QUOTED_REVISION_ATTRIBUTE.test(text)) return 'revision-attribute-in-single-quotes'
  if (args.mode === 'accept') return undefined
  const all = args.changeName === undefined
  const loses =
    ((all || args.changeName === 'w:pPrChange') &&
      /<w:pPr(?:\s[^>]*)?><w:pPrChange[\s>]/.test(text)) ||
    (all &&
      (args.filter === undefined || (args.filter as Args | null)?.type === 'formatting') &&
      /<w:pPr(?:\s[^>]*)?><w:rPr><w:rPrChange(?:\s[^>]*)?><w:rPr\/><\/w:rPrChange><\/w:rPr><w:pPrChange[\s>]/.test(
        text,
      )) ||
    (all &&
      args.filter === undefined &&
      args.resolutions === undefined &&
      /<w:pPr(?:\s[^>]*)?><w:rPr><w:(?:ins|del)\s[^>]*\/><\/w:rPr><w:pPrChange[\s>]/.test(text)) ||
    (all &&
      args.filter === undefined &&
      args.resolutions === undefined &&
      unclosedHolderOpenedByMark(text))
  return loses ? 'reject-of-a-ppr-change-that-opens-its-ppr' : undefined
}

/**
 * A w:tcPr, w:trPr or w:rPr that opens with a revision mark written with a
 * close tag, followed by its own property change, and that is never closed.
 * The same text with the holder closed is compared like any other: it is
 * the input that shows the end tiebreak of the edit sort.
 */
function unclosedHolderOpenedByMark(text: string): boolean {
  for (const found of text.matchAll(
    /<w:(tcPr|trPr|rPr)(?:\s[^>]*)?><w:(cellIns|cellDel|ins|del)\s[^>]*><\/w:\2><w:\1Change[\s>]/g,
  )) {
    // the record holds a holder of the same name: count the depth to find the outer close
    let depth = 1
    const tags = new RegExp(`<(/?)w:${found[1]}(?=[\\s/>])[^>]*?(/?)>`, 'g')
    tags.lastIndex = found.index + found[0].length
    for (let tag = tags.exec(text); tag && depth > 0; tag = tags.exec(text)) {
      if (tag[1]) depth--
      else if (!tag[2]) depth++
    }
    if (depth > 0) return true
  }
  return false
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
 * never does. The input is compared under `maskNonFinite`.
 */
export function nonFiniteNumber(_text: string, args: Args): string | undefined {
  return holdsNonFinite(args) ? NON_FINITE_NUMBER : undefined
}

/** What a non-finite number looks like once a result holds it: the token, or a number in exponent form. */
const NON_FINITE_TOKEN = /NaN|Infinity|\de[+-]\d/
const MASK = '\u25a0'

/** A text as its tags and the texts between them, in turn: even places are text. */
const pieces = (xml: string): string[] => xml.split(/(<[^>]*>)/)

/**
 * Both results with every attribute value and every text between tags that
 * holds a non-finite token on the TypeScript side replaced by a placeholder,
 * at the same place on both sides: the n-th tag and the attribute's name, or
 * the n-th text. An attribute the TypeScript wrote with such a value and the
 * Rust did not write at all (there was no earlier value to keep) is taken
 * out of the TypeScript side. `undefined` where the TypeScript result holds
 * no such token. Where the two results do not have the same number of tags
 * nothing is masked, so they differ as they are.
 */
export function maskNonFinite(
  typescript: unknown,
  rust: unknown,
): { typescript: unknown; rust: unknown } | undefined {
  if (!NON_FINITE_TOKEN.test(JSON.stringify(typescript))) return undefined
  if (typeof typescript === 'string' && typeof rust === 'string') {
    const ours = pieces(typescript)
    const theirs = pieces(rust)
    if (ours.length !== theirs.length) return { typescript, rust }
    for (const [at, piece] of ours.entries()) {
      if (at % 2 === 0) {
        if (NON_FINITE_TOKEN.test(piece)) ours[at] = theirs[at] = MASK
        continue
      }
      for (const [, name, value] of piece.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
        if (!NON_FINITE_TOKEN.test(value!)) continue
        const attribute = new RegExp(`(\\s${name!.replace(/[.]/g, '\\.')}\\s*=\\s*")[^"]*"`)
        if (attribute.test(theirs[at]!)) {
          ours[at] = ours[at]!.replace(attribute, `$1${MASK}"`)
          theirs[at] = theirs[at]!.replace(attribute, `$1${MASK}"`)
        } else {
          ours[at] = ours[at]!.replace(attribute, '')
        }
      }
    }
    return { typescript: ours.join(''), rust: theirs.join('') }
  }
  if (Array.isArray(typescript) && Array.isArray(rust) && typescript.length === rust.length) {
    const pairs = typescript.map((item, at) => maskNonFinite(item, rust[at]) ?? { typescript: item, rust: rust[at] })
    return { typescript: pairs.map((pair) => pair.typescript), rust: pairs.map((pair) => pair.rust) }
  }
  if (typeof typescript === 'object' && typescript !== null && typeof rust === 'object' && rust !== null) {
    const out = { typescript: { ...typescript } as Args, rust: { ...rust } as Args }
    for (const [key, item] of Object.entries(typescript)) {
      if (!(key in out.rust)) continue
      const pair = maskNonFinite(item, out.rust[key])
      if (pair) [out.typescript[key], out.rust[key]] = [pair.typescript, pair.rust]
    }
    return out
  }
  return { typescript, rust }
}
