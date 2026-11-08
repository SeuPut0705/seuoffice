import katex from 'katex'

/** The editor model is independent of the host document and its persistence format. */
export interface MathValue {
  latex: string
  display: boolean
}

export const MAX_LATEX_LENGTH = 10000

/** Adapted from Meditor's formula editor: keep source even when typesetting fails. */
export function renderMath(value: MathValue): { html: string; error: boolean } {
  try {
    if (value.latex.length > MAX_LATEX_LENGTH) throw new Error('Formula too long')
    return {
      html: katex.renderToString(value.latex, {
        displayMode: value.display,
        output: 'mathml',
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        maxExpand: 1000,
        maxSize: 20,
      }),
      error: false,
    }
  } catch {
    return { html: `<code>${escapeMathText(value.latex)}</code>`, error: true }
  }
}

export function escapeMathText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export const MATH_TEMPLATES = [
  ['mathFraction', String.raw`\frac{a}{b}`],
  ['mathRoot', String.raw`\sqrt{x}`],
  ['mathNthRoot', String.raw`\sqrt[n]{x}`],
  ['mathPower', String.raw`x^{n}`],
  ['mathSubscript', String.raw`a_{n}`],
  ['mathSum', String.raw`\sum_{k=1}^{n}k`],
  ['mathProduct', String.raw`\prod_{k=1}^{n}k`],
  ['mathIntegral', String.raw`\int_{0}^{1}x^2\,dx`],
  ['mathLimit', String.raw`\lim_{x\to 0}\frac{\sin x}{x}`],
  ['mathMatrix', String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`],
  ['mathVector', String.raw`\vec{v}`],
  ['mathCases', String.raw`\begin{cases}x+y=1\\x-y=2\end{cases}`],
  ['mathPiecewise', String.raw`f(x)=\begin{cases}x^2&x\ge 0\\-x&x<0\end{cases}`],
  ['mathBinomial', String.raw`\binom{n}{r}`],
] as const
