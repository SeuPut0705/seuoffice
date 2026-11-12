// The classes of divergences.json that inputs of comparison (f) fall in (the
// form of tools/docx-diff/listed.ts): each predicate reads the input alone and
// is as narrow as the input allows. Each class has its entry in divergences.json.

import { readZip } from './zip-compare'

type Args = Record<string, unknown>

const isHigh = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff
const isLow = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff

/**
 * A numeric character reference to a surrogate code point that does not pair
 * with the reference next to it: decodeXmlEntities of the TypeScript writes a
 * lone surrogate, which a Rust string cannot hold (it writes U+FFFD). A high
 * reference followed at once by a low one decodes to one character on both
 * sides and is not in the class.
 */
export function loneSurrogateReference(text: string, _args: Args): string | undefined {
  const references = [...text.matchAll(/&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));/g)]
  for (let i = 0; i < references.length; i++) {
    const found = references[i]!
    const code = found[1] !== undefined ? parseInt(found[1], 16) : parseInt(found[2]!, 10)
    if (!isHigh(code) && !isLow(code)) continue
    const next = references[i + 1]
    const nextCode = next
      ? next[1] !== undefined
        ? parseInt(next[1], 16)
        : parseInt(next[2]!, 10)
      : NaN
    if (isHigh(code) && next && next.index === found.index! + found[0].length && isLow(nextCode)) {
      i++
      continue
    }
    return 'lone-surrogate-from-numeric-reference'
  }
  return undefined
}

/**
 * An offset argument between the two halves of a surrogate pair: the
 * TypeScript cuts the pair there; a Rust byte offset cannot point inside a
 * character, so the Rust reads from the end of it. Every caller of the engine
 * passes offsets of tag boundaries, which are never inside a pair.
 */
export function offsetInsidePair(text: string, args: Args): string | undefined {
  for (const key of ['nameEnd', 'tagEnd', 'from', 'to']) {
    const at = args[key]
    if (typeof at !== 'number' || !Number.isInteger(at) || at <= 0) continue
    if (isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at)))
      return 'offset-inside-surrogate-pair'
  }
  return undefined
}

/** Either class, the reference first: an input in both differs under the first. */
export function surrogateClasses(text: string, args: Args): string | undefined {
  return loneSurrogateReference(text, args) ?? offsetInsidePair(text, args)
}

/**
 * A docx whose `w:spacing` carries a `w:lineRule` outside `auto`, `exact` and
 * `atLeast`: the TypeScript docx engine keeps the text as it is and converts
 * the document; the Rust docx engine's model refuses the value and the whole
 * conversion (a defect of the Rust docx engine, with the docx stream). A
 * class of the wire comparison (c), read from the docx alone.
 */
export function lineRuleOutsideEnum(docx: Uint8Array): string | undefined {
  const decoder = new TextDecoder('utf-8')
  for (const record of readZip(docx).records) {
    if (record.nameText !== 'word/document.xml' && record.nameText !== 'word/styles.xml') continue
    if (typeof record.inflated === 'string') continue
    for (const found of decoder.decode(record.inflated).matchAll(/w:lineRule="([^"]*)"/g))
      if (!['auto', 'exact', 'atLeast'].includes(found[1]!)) return 'docx-line-rule-outside-enum'
  }
  return undefined
}

/** The wire classes met by the comparisons, and how many of their inputs differed. */
export const wireClasses = new Map<string, { inputs: number; differ: number }>()
