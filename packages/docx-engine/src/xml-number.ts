/**
 * The one place a number becomes the text of an integer XML attribute or
 * element (EMU, twips, ranks, ids). NaN, an infinity, or a value whose decimal
 * form needs an exponent ("1e+21") is schema-invalid there, so it has no text:
 * a patch then keeps what the XML held, a builder refuses the call.
 */

/** The rounded value as plain decimal digits, or null when it has none. */
import { invoke } from './engine'

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
  return invoke('usableNumber', [typeof value === 'number' ? value : NaN, emuPerUnit], {
    undef: true,
  }) as never
}
/** A picture's size in px: both sides when both are usable and positive, else the default square. */
export function usablePictureSize(
  widthPx: unknown,
  heightPx: unknown,
): { widthPx: number; heightPx: number } {
  const [w, h] = invoke('usablePictureSize', [
    typeof widthPx === 'number' ? widthPx : NaN,
    typeof heightPx === 'number' ? heightPx : NaN,
  ]) as [number, number]
  return { widthPx: w, heightPx: h }
}
/**
 * A number from the document as a wp:posOffset may take it, in units of
 * `emuPerUnit` EMU: undefined when it is no finite number or, in EMU, lies
 * outside the xsd:int a position is (narrower than the widest coordinate).
 */
export function usablePositionOffset(value: unknown, emuPerUnit = 1): number | undefined {
  return invoke('usablePositionOffset', [typeof value === 'number' ? value : NaN, emuPerUnit], {
    undef: true,
  }) as never
}
