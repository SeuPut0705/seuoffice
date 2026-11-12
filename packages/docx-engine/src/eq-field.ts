// Legacy EQ field instructions (`EQ \f(a,b)`, `EQ \a \al (x,y)` ...) laid out
// as OMML so the math renderer draws them; Word computes these fields live and
// stores no cached result, so without this the field shows nothing.
import { invoke } from './engine'

export interface EqField {
  omml: string
  /** linear text of the layout (previews, word count) */
  text: string
}
/** null when the instruction is not an EQ field or uses an unsupported switch */
export function eqFieldToOmml(instr: string): EqField | null {
  return invoke('eqFieldToOmml', [instr]) as never
}
/**
 * Paragraph XML with every renderable EQ field replaced by a plain run of its
 * linear text (in the field code's rPr), so the field-result text/size scans
 * see the layout Word would compute.
 */
export function inlineEqFieldResults(xml: string): string {
  return invoke('inlineEqFieldResults', [xml]) as never
}