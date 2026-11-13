import { invoke } from './engine'

/**
 * OMML (Office Math Markup) <-> display / authoring support.
 *
 * - ommlFragmentsOf: pull the <m:oMath> fragments out of a paragraph
 * - ommlToMathML: convert OMML to MathML Core for native Chromium rendering
 * - latexToOmml: build OMML from a practical LaTeX subset (insert dialog / gallery)
 */

// ---- fragment extraction ----

/** all <m:oMath> fragments of a paragraph, in document order (oMathPara unwrapped) */
export function ommlFragmentsOf(paragraphXml: string): string[] {
  return invoke('ommlFragmentsOf', [paragraphXml]) as never
}
/** a trailing <m:r><w:br/></m:r>: Word's manual line break inside a math zone */
export function ommlEndsWithBreak(ommlXml: string): boolean {
  return invoke('ommlEndsWithBreak', [ommlXml]) as never
}
/** visible <m:t> leaf texts in document order (the editable formula tokens) */
export function mathTokensOf(xml: string): string[] {
  return invoke('mathTokensOf', [xml]) as never
}
// ---- OMML -> MathML ----

/**
 * MathML Core markup for one or more <m:oMath> fragments (they may be passed
 * concatenated). Returns '' when nothing convertible is found.
 */
export function ommlToMathML(ommlXml: string): string {
  return invoke('ommlToMathML', [ommlXml]) as never
}
/**
 * Decompile a single <m:oMath> fragment back into the LaTeX subset that
 * latexToOmml accepts. Returns null when the formula uses structures the
 * subset cannot express (the caller then keeps token-level editing only).
 * The result is semantically equivalent, not byte-identical: it is only used
 * when the user actually edits the formula, so regeneration is expected.
 */
export function ommlToLatex(ommlXml: string): string | null {
  return invoke('ommlToLatex', [ommlXml]) as never
}
/**
 * Convert a practical LaTeX subset into OMML (the children of <m:oMath>).
 * Supported: \frac \binom \sqrt[n] ^ _ \sum/\int/... with limits,
 * \left(\right), matrix environments, accents, greek letters and common
 * symbols, \text{}, function names. Throws Error (with a Chinese message)
 * on syntax the subset does not cover.
 */
export function latexToOmml(latex: string): string {
  return invoke('latexToOmml', [latex]) as never
}
/** OMML for a display formula paragraph created by the editor */
export function mathParagraphXml(
  omml: string,
  align: 'left' | 'center' | 'right' = 'center',
): string {
  return invoke('mathParagraphXml', [omml, align]) as never
}
