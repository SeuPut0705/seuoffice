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

/** `n` rounded, as plain digits, when it lies in [min, max]; else null. */
function xmlIntIn(n: number, min: number, max: number): string | null {
  // the value may come from a node attribute or a peer: null rounds to 0 and
  // '12' to 12, but neither is a number the caller meant to write
  if (typeof n !== 'number') return null
  const rounded = Math.round(n)
  return Number.isSafeInteger(rounded) && rounded >= min && rounded <= max ? String(rounded) : null
}

/** wp:posOffset (ST_PositionOffset, an xsd:int), in EMU */
export const xmlPositionOffset = (emu: number): string | null =>
  xmlIntIn(emu, -2147483648, 2147483647)

/** an extent's cx / cy (ST_PositiveCoordinate), in EMU */
export const xmlPositiveCoordinate = (emu: number): string | null =>
  xmlIntIn(emu, 0, MAX_COORDINATE_EMU)

/** an xsd:unsignedInt: wp:anchor relativeHeight, distT / distB / distL / distR */
export const xmlUnsignedInt = (n: number): string | null => xmlIntIn(n, 0, 4294967295)

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

/** EMU in one CSS px */
export const EMU_PER_PX = 9525

/** The widest coordinate a drawing admits (ST_Coordinate), in EMU. */
export const MAX_COORDINATE_EMU = 27273042316900

/** The side of a new picture whose own size is no usable number, in px (one inch). */
export const DEFAULT_PICTURE_PX = 96

/**
 * A number from the document, a node attribute or a peer, as drawing code may
 * take it: undefined when it is not a finite number or when, times
 * `emuPerUnit`, it lies beyond the widest drawing coordinate (1 for a plain
 * number such as a rotation or a rank). Callers on the open, edit and save
 * paths treat undefined as absent before they call a builder, which refuses
 * what still slips through.
 */
export function usableNumber(value: unknown, emuPerUnit = 1): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.abs(value * emuPerUnit) <= MAX_COORDINATE_EMU ? value : undefined
}

/** A picture's size in px: both sides when both are usable and positive, else the default square. */
export function usablePictureSize(
  widthPx: unknown,
  heightPx: unknown,
): { widthPx: number; heightPx: number } {
  const w = usableNumber(widthPx, EMU_PER_PX)
  const h = usableNumber(heightPx, EMU_PER_PX)
  return w !== undefined && h !== undefined && w > 0 && h > 0
    ? { widthPx: w, heightPx: h }
    : { widthPx: DEFAULT_PICTURE_PX, heightPx: DEFAULT_PICTURE_PX }
}

/**
 * A number from the document as a wp:posOffset may take it, in units of
 * `emuPerUnit` EMU: undefined when it is no finite number or, in EMU, lies
 * outside the xsd:int a position is (narrower than the widest coordinate).
 */
export function usablePositionOffset(value: unknown, emuPerUnit = 1): number | undefined {
  if (typeof value !== 'number') return undefined
  return xmlPositionOffset(value * emuPerUnit) === null ? undefined : value
}
