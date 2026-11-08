/** LaTeX → MathML through KaTeX (spec §5); failures keep the LaTeX as code. */
import katex from 'katex'
import { escapeAttr, escapeText, xmlClean } from './xml'

const KATEX_WRAPPER = /^<span class="katex">(<math[\s\S]*<\/math>)<\/span>$/

/**
 * MathML for a formula, or null when KaTeX cannot parse it. `trust` stays
 * off (no \href / \includegraphics / \html*), so the output is plain MathML.
 * The LaTeX source rides along as `alttext` for reading systems without MathML.
 */
export function latexToMathMl(latex: string, display: boolean): string | null {
  try {
    const html = katex.renderToString(xmlClean(latex), {
      output: 'mathml',
      throwOnError: true,
      displayMode: display,
      strict: 'ignore',
    })
    const math = KATEX_WRAPPER.exec(html)?.[1] ?? html
    return math.replace(/^<math /, `<math alttext="${escapeAttr(latex)}" `)
  } catch {
    return null
  }
}

/** inline formula: MathML, else the source as `<code>` */
export function inlineMath(latex: string): { xml: string; mathml: boolean } {
  const mathml = latexToMathMl(latex, false)
  return mathml
    ? { xml: mathml, mathml: true }
    : { xml: `<code class="math-tex">${escapeText(latex)}</code>`, mathml: false }
}

/** display formula: MathML in a block, else the source as a code block */
export function blockMath(latex: string): { xml: string; mathml: boolean } {
  const mathml = latexToMathMl(latex, true)
  return mathml
    ? { xml: `<div class="math">${mathml}</div>\n`, mathml: true }
    : { xml: `<pre class="math-tex"><code>${escapeText(latex)}</code></pre>\n`, mathml: false }
}
