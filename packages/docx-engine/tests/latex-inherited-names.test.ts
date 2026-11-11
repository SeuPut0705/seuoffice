import { describe, expect, it } from 'vitest'
import { latexToOmml } from '../src/index'

// The LaTeX reader's tables are plain objects. A command, an environment or a
// delimiter named like a member every object inherits must be refused the way
// any other unknown name is, not found as that member (which surfaced as a
// TypeError from deep inside the reader).
describe('LaTeX names that every object inherits', () => {
  const INHERITED = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']
  const refusal = (latex: string): unknown => {
    try {
      latexToOmml(latex)
    } catch (error) {
      return error
    }
    return null
  }
  // how the reader refuses a name it does not know
  const Unknown = (refusal('\\unknowncmd') as Error).constructor

  it.each(INHERITED)('refuses \\%s as an unknown command', (name) => {
    expect(refusal(`\\${name}`)).toBeInstanceOf(Unknown)
  })

  it.each(INHERITED)('refuses \\begin{%s} as an unknown environment', (name) => {
    expect(refusal(`\\begin{${name}}a\\end{${name}}`)).toBeInstanceOf(Unknown)
  })

  it.each(INHERITED)('refuses \\left\\%s as an unknown delimiter', (name) => {
    expect(refusal(`\\left\\${name} x \\right)`)).toBeInstanceOf(Unknown)
  })
})
