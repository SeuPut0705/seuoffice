/**
 * The LaTeX reader and characters outside the BMP (an emoji, a mathematical
 * alphanumeric symbol). Such a character is two UTF-16 units; as the argument
 * of ^, _ or of a command without braces it is one argument, exactly as a BMP
 * character is, and never two halves.
 */
import { describe, expect, it } from 'vitest'
import { latexToOmml, mathTokensOf, ommlToLatex, ommlToMathML } from '../src/index'

const EMOJI = '\u{1F600}'
const SCRIPT_A = '\u{1D49C}'

/** half of a surrogate pair without its partner (the u flag reads a whole pair as one character) */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u

const wrap = (omml: string): string => `<m:oMath>${omml}</m:oMath>`

const errorMessageOf = (latex: string): string => {
  try {
    latexToOmml(latex)
  } catch (e) {
    return (e as Error).message
  }
  throw new Error(`expected latexToOmml to reject ${JSON.stringify(latex)}`)
}

/** [without braces, the same formula with the argument in braces, the visible tokens] */
const SHAPES: Array<[string, string, string[]]> = [
  [`x^${EMOJI}`, `x^{${EMOJI}}`, ['x', EMOJI]],
  [`x_${SCRIPT_A}`, `x_{${SCRIPT_A}}`, ['x', SCRIPT_A]],
  [`x^${EMOJI}_${SCRIPT_A}`, `x^{${EMOJI}}_{${SCRIPT_A}}`, ['x', SCRIPT_A, EMOJI]],
  [`\\frac${EMOJI}${EMOJI}`, `\\frac{${EMOJI}}{${EMOJI}}`, [EMOJI, EMOJI]],
  [`\\frac${SCRIPT_A}${EMOJI}`, `\\frac{${SCRIPT_A}}{${EMOJI}}`, [SCRIPT_A, EMOJI]],
  [`\\hat${EMOJI}`, `\\hat{${EMOJI}}`, [EMOJI]],
  [`\\sqrt${SCRIPT_A}`, `\\sqrt{${SCRIPT_A}}`, [SCRIPT_A]],
  [`\\overline${SCRIPT_A}`, `\\overline{${SCRIPT_A}}`, [SCRIPT_A]],
  [`\\sum_${SCRIPT_A}^${EMOJI}`, `\\sum_{${SCRIPT_A}}^{${EMOJI}}`, [SCRIPT_A, EMOJI]],
  [`\\lim_${SCRIPT_A}`, `\\lim_{${SCRIPT_A}}`, ['lim', SCRIPT_A]],
  // what follows the argument stays outside the script
  [`x^${EMOJI}y`, `x^{${EMOJI}}y`, ['x', EMOJI, 'y']],
]

describe('latexToOmml with characters outside the BMP', () => {
  it.each(SHAPES)('reads %s as one argument, like %s', (bare, braced, tokens) => {
    const omml = latexToOmml(bare)
    expect(LONE_SURROGATE.test(omml)).toBe(false)
    expect(mathTokensOf(wrap(omml))).toEqual(tokens)
    expect(omml).toBe(latexToOmml(braced))
  })

  it.each(SHAPES)('round-trips %s through ommlToLatex with the character intact', (bare) => {
    const omml = latexToOmml(bare)
    const latex = ommlToLatex(wrap(omml))
    expect(latex).toBeTruthy()
    expect(LONE_SURROGATE.test(latex!)).toBe(false)
    expect(latexToOmml(latex!)).toBe(omml)
  })

  it('renders the argument as one MathML token', () => {
    const mathml = ommlToMathML(wrap(latexToOmml(`x_${SCRIPT_A}`)))
    expect(LONE_SURROGATE.test(mathml)).toBe(false)
    expect(mathml).toContain(`<mi>${SCRIPT_A}</mi>`)
  })

  it('takes one code point, not a combining sequence', () => {
    // BMP: the base letter is the argument, the combining mark follows it
    expect(latexToOmml('x^e\u0301')).toBe(latexToOmml('x^{e}\u0301'))
    expect(mathTokensOf(wrap(latexToOmml('x^e\u0301')))).toEqual(['x', 'e', '\u0301'])
    // outside the BMP: the same rule, the variation selector is not part of the argument
    expect(latexToOmml(`x^${EMOJI}\uFE0F`)).toBe(latexToOmml(`x^{${EMOJI}}\uFE0F`))
    expect(mathTokensOf(wrap(latexToOmml(`x^${EMOJI}\uFE0F`)))).toEqual(['x', EMOJI, '\uFE0F'])
  })

  it('binds a script to the last character of a text run, a whole one', () => {
    const omml = latexToOmml(`a${EMOJI}^2`)
    expect(LONE_SURROGATE.test(omml)).toBe(false)
    expect(omml).toBe(latexToOmml(`a{${EMOJI}}^2`))
    expect(mathTokensOf(wrap(omml))).toEqual(['a', EMOJI, '2'])
  })

  it('names the whole character when it rejects one', () => {
    for (const latex of [`\\${EMOJI}`, `\\left${EMOJI} x \\right)`, `\\left( x \\right${EMOJI}`]) {
      const message = errorMessageOf(latex)
      expect(LONE_SURROGATE.test(message), latex).toBe(false)
      expect(message, latex).toContain(EMOJI)
    }
  })

  it('reads BMP arguments without braces as before', () => {
    expect(latexToOmml('x^2y')).toBe(latexToOmml('x^{2}y'))
    expect(latexToOmml('\\frac12')).toBe(latexToOmml('\\frac{1}{2}'))
    expect(latexToOmml('\\hat\u00e9')).toBe(latexToOmml('\\hat{\u00e9}'))
    expect(latexToOmml('x_\u4e2d')).toBe(latexToOmml('x_{\u4e2d}'))
  })
})
