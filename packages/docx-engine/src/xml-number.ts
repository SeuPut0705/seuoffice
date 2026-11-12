/**
 * The one place a number becomes the text of an integer XML attribute or
 * element (EMU, twips, ranks, ids). NaN, an infinity, or a value whose decimal
 * form needs an exponent ("1e+21") is schema-invalid there, so it has no text:
 * a patch then keeps what the XML held, a builder refuses the call.
 */

/** The rounded value as plain decimal digits, or null when it has none. */
export function xmlInt(n: number): string | null {
  const rounded = Math.round(n)
  return Number.isSafeInteger(rounded) ? String(rounded) : null
}

/**
 * An id must already be an integer: rounding 2.5 to a neighbour could
 * duplicate an id the part already holds.
 */
export function xmlId(n: number): string | null {
  return Number.isSafeInteger(n) ? String(n) : null
}

/** A decimal value (VML points) as plain digits, or null for NaN, an infinity or an exponent form. */
export function xmlDecimal(n: number): string | null {
  const text = String(n)
  return Number.isFinite(n) && !text.includes('e') ? text : null
}

/** A builder's refusal of an option that has no XML text. */
export function nonFinite(option: string): never {
  throw new RangeError(`a non-finite number: ${option}`)
}
