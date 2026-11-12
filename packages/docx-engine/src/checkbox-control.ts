/**
 * Content-control checkboxes (w14:checkbox). Word draws the box from the
 * control's own state: w14:checked picks between the checkedState and
 * uncheckedState glyphs, whose values are hex code points. The run inside
 * sdtContent holds the same glyph, so in the editor the glyph is the state and
 * write-back derives w14:checked from it, the way FORMCHECKBOX does.
 */
import { invoke } from './engine'

export interface CheckboxGlyphs {
  readonly checked: string
  readonly unchecked: string
}
/** The checkbox glyph pair a w:sdtPr declares (defaults are Word's own). */
export function sdtCheckboxGlyphs(sdtPrXml: string): CheckboxGlyphs {
  return invoke('sdtCheckboxGlyphs', [sdtPrXml]) as never
}
/** Whether `glyph` reads as the checked state of a control declaring `sdtPrXml`. */
export function sdtCheckboxIsChecked(sdtPrXml: string, glyph: string): boolean {
  return invoke('sdtCheckboxIsChecked', [sdtPrXml, glyph]) as never
}
