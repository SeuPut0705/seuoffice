// Group math: math.ts in both directions (OMML to LaTeX and to MathML, LaTeX
// to OMML) and the round trips through them. The corpus holds a handful of
// formulas, so nearly everything here is built: LaTeX from a seeded grammar
// over every table entry of math.ts, OMML from a seeded generator over every
// element and property the converters read.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  latexToOmml,
  mathParagraphXml,
  mathTokensOf,
  ommlEndsWithBreak,
  ommlFragmentsOf,
  ommlToLatex,
  ommlToMathML,
} from './reference/math'
import { escapeXmlText } from './reference/xml-utils'
import type { CallSpec, Input } from './calls-spec'
import { elementFragments } from './fragments'
import { mulberry32 } from './synthetic'

const MATH_SOURCE = readFileSync(
  fileURLToPath(new URL('./reference/math.ts', import.meta.url)),
  'utf8',
)

/** The value of the body of a JavaScript string literal. */
const unquote = (body: string): string =>
  body.replace(
    /\\u([0-9A-Fa-f]{4})|\\(.)/g,
    (_, hex: string | undefined, ch: string | undefined) =>
      hex === undefined ? ch! : String.fromCharCode(parseInt(hex, 16)),
  )

/** The source of `const name` in math.ts, up to the line that closes it. */
function declaration(name: string): string {
  const start = MATH_SOURCE.indexOf(`const ${name}`)
  const end = MATH_SOURCE.slice(start).search(/\n[}\]]/)
  if (start === -1 || end === -1) throw new Error(`calls-math: math.ts has no table ${name}`)
  return MATH_SOURCE.slice(start, start + end)
}

/** Every match of `pattern` in `text`, as its groups unquoted. */
function table(text: string, pattern: RegExp): string[][] {
  const rows = [...text.matchAll(pattern)].map((m) => m.slice(1).map((g) => unquote(g ?? '')))
  if (rows.length === 0) throw new Error(`calls-math: nothing matches ${pattern}`)
  return rows
}

const QUOTED = String.raw`'((?:[^'\\]|\\.)*)'`
const SYMBOLS = table(
  declaration('LATEX_SYMBOLS'),
  new RegExp(String.raw`^\s+(\w+): ${QUOTED}`, 'gm'),
)
const FUNCTIONS = table(declaration('LATEX_FUNCTIONS'), /'(\w+)'/g).map(([name]) => name!)
const NARY = table(
  declaration('NARY_OPS'),
  new RegExp(String.raw`^\s+(\w+): \{ chr: ${QUOTED}`, 'gm'),
)
const ACCENTS = table(
  declaration('ACCENT_CHARS'),
  new RegExp(String.raw`^\s+(\w+): ${QUOTED}`, 'gm'),
)
const ENVIRONMENTS = table(declaration('MATRIX_DELIMS'), /^\s+(\w+):/gm).map(([name]) => name!)
const DELIMITERS = table(
  declaration('LEFT_RIGHT_CHARS'),
  new RegExp(String.raw`^\s+${QUOTED}: ${QUOTED}`, 'gm'),
)
const ESCAPED = table(declaration('CHAR_ESCAPES'), /^\s+(?:'(.)'|([_$])):/gm).map((g) => g.join(''))
const OPERATORS = [...table(MATH_SOURCE, /const OPERATOR_CHARS = new Set\('([^']*)'\)/g)[0]![0]!]
/** The names `parseControl` switches on. */
const CONTROLS = table(
  MATH_SOURCE.slice(MATH_SOURCE.indexOf('function parseControl')),
  new RegExp(String.raw`case ${QUOTED}:`, 'g'),
).map(([name]) => name!)
/** Every OMML element a converter switches on. */
const ELEMENTS = [...new Set(table(MATH_SOURCE, /case '(m:\w+)':/g).map(([name]) => name!))]

const random = mulberry32(20261112)
const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!
const chance = (p: number): boolean => random() < p
const times = (n: number, make: (index: number) => string): string[] =>
  Array.from({ length: n }, (_, index) => make(index))

// ---- LaTeX ----

/** Hangul, CJK and accented letters, and characters outside the BMP after a letter. */
const RUNS = [
  'x',
  'y',
  'ab',
  'n',
  '2',
  '10',
  '3.14',
  'x+1',
  'a-b',
  'f(x)',
  'a=b',
  'p<q',
  'r>s',
  '|x|',
  '[a]',
  'x,y',
  "x'",
  '100%',
  '\u00e9t\u00e9',
  '\ud55c\uae00',
  '\u901f\u5ea6',
  'a\u{1D465}b',
  'z\u{1F600}',
  '\u00a0x',
  'x\ny',
  OPERATORS.filter((ch) => !'{}&'.includes(ch)).join(''),
]
/** What an argument may be without braces: one unit of UTF-16. */
const TOKENS = [
  'x',
  'y',
  '2',
  'a',
  'Z',
  '0',
  '.',
  '+',
  '-',
  '=',
  '<',
  '(',
  ']',
  '|',
  ',',
  '\u00e9',
  '\u03b1',
]
const SCRIPTS = ['^A', '_A', '^A_B', '_A^B', '^A^B', '_A_B']
/** Where JavaScript's `\s` and Rust's white space part: U+FEFF is a space, U+0085 is not. */
const GAPS = [' ', ' ', ' ', '', '  ', '\t', '\n', '\u00a0', '\ufeff', '\u0085', '\u3000']
const MAX_DEPTH = 6

function leaf(): string {
  const k = random()
  if (k < 0.45) return pick(RUNS)
  if (k < 0.75) return `\\${pick(SYMBOLS)[0]}`
  if (k < 0.85) return `\\${pick(FUNCTIONS)}`
  return pick([
    '\\{',
    '\\}',
    '\\%',
    '\\&',
    '\\$',
    '\\#',
    '\\_',
    '\\^',
    '\\,',
    '\\;',
    '\\ ',
    '\\quad',
    '\\qquad',
  ])
}

function arg(depth: number): string {
  const k = random()
  if (k < 0.6 || depth >= MAX_DEPTH) return `{${expr(depth + 1)}}`
  if (k < 0.85) {
    const token = pick(TOKENS)
    // a letter right after a control word would extend its name
    return /^[A-Za-z]/.test(token) ? ` ${token}` : token
  }
  if (k < 0.92) return ` ${pick(TOKENS)}`
  if (k < 0.999) return `\\${pick(SYMBOLS)[0]}`
  // the parser takes one UTF-16 unit here, so the result holds half of the
  // pair, which the runner compares as U+FFFD
  return '\u{1D465}'
}

function matrix(env: string, depth: number): string {
  const rows = times(1 + Math.floor(random() * 3), () =>
    times(1 + Math.floor(random() * 3), () => (chance(0.15) ? '' : expr(depth + 1))).join(' & '),
  )
  return `\\begin{${env}} ${rows.join(' \\\\ ')}${chance(0.2) ? ' \\\\' : ''} \\end{${env}}`
}

function atom(depth: number): string {
  if (depth >= MAX_DEPTH) return leaf()
  switch (Math.floor(random() * 16)) {
    case 0:
    case 1:
      return leaf()
    case 2: {
      const [name] = pick(NARY)
      const limits = pick([
        '',
        `_${arg(depth)}`,
        `^${arg(depth)}`,
        `_${arg(depth)}^${arg(depth)}`,
        `^${arg(depth)}_${arg(depth)}`,
      ])
      return `\\${name}${limits}${chance(0.7) ? ` {${expr(depth + 1)}}` : ''}`
    }
    case 3:
      return `\\${pick(ACCENTS)[0]}${arg(depth)}`
    case 4:
      return `\\${pick(['frac', 'dfrac', 'tfrac', 'binom'])}${arg(depth)}${arg(depth)}`
    case 5:
      return `\\sqrt${chance(0.5) ? `[${chance(0.7) ? pick(['3', 'n', '2k', '\\alpha', '']) : expr(depth + 1)}]` : ''}${arg(depth)}`
    case 6:
      return `\\${pick(['overline', 'underline', 'underbrace', 'overbrace'])}${arg(depth)}`
    case 7:
      return `\\${pick(['text', 'mathrm', 'operatorname'])}{${pick(['speed', 'a b', ' x ', 'sin', 'lim', '', 'a{b}c', '\u901f\u5ea6', 'a\u{1F600}b'])}}`
    case 8:
      return chance(0.6) ? `\\lim_${arg(depth)} ${expr(depth + 1)}` : '\\lim'
    case 9:
      return `\\left${pick(DELIMITERS)[0]} ${expr(depth + 1)} \\right${pick(DELIMITERS)[0]}`
    case 10:
      return matrix(pick(ENVIRONMENTS), depth)
    case 11:
      return `{${expr(depth + 1)}}`
    case 12:
    case 13: {
      const base = chance(0.6) ? leaf() : `{${expr(depth + 1)}}`
      return base + pick(SCRIPTS).replace(/[AB]/g, () => arg(depth))
    }
    case 14:
      return `\\${pick(FUNCTIONS)} ${arg(depth)}`
    default:
      return pick(RUNS)
  }
}

function expr(depth: number): string {
  const count = depth >= MAX_DEPTH ? 1 : 1 + Math.floor(random() * 3)
  return times(count, () => atom(depth)).reduce((out, next) => {
    const gap = pick(GAPS)
    return (
      out + (gap === '' && /\\[A-Za-z]+$/.test(out) && /^[A-Za-z]/.test(next) ? ' ' : gap) + next
    )
  })
}

/** One edit that takes a formula out of the subset, or to its edges. */
function corrupt(latex: string): string {
  const points = Array.from(latex)
  const at = Math.floor(random() * (points.length + 1))
  const insert = (text: string): string =>
    [...points.slice(0, at), text, ...points.slice(at)].join('')
  switch (Math.floor(random() * 12)) {
    case 0:
      return latex.replace(/\}(?=[^}]*$)/, '')
    case 1:
      return insert('{')
    case 2:
      return insert('\\unknowncommand ')
    case 3:
      return `${latex}\\`
    case 4:
      return insert('{}')
    case 5:
      return `${latex}^`
    case 6:
      return insert(' & ')
    case 7:
      return insert(' \\\\ ')
    case 8:
      return `\\left( ${latex}`
    case 9:
      return `${latex} \\right)`
    case 10:
      return insert('}')
    default:
      return insert(
        pick([
          '\\begin{nope} x \\end{nope}',
          '\\sqrt[3 x',
          '\\left\\foo x \\right)',
          '\\end{matrix}',
          '_',
        ]),
      )
  }
}

/** Each entry of each table once, then the grammar. */
const LATEX_EXAMPLES = [
  ...SYMBOLS.map(([name]) => `\\${name} + x`),
  ...FUNCTIONS.map((name) => `\\${name} x`),
  ...NARY.map(([name]) => `\\${name}_{k=0}^{n} {a_k}`),
  ...ACCENTS.map(([name]) => `\\${name}{x}`),
  ...ENVIRONMENTS.map((env) => `\\begin{${env}} a & b \\\\ c & d \\end{${env}}`),
  ...DELIMITERS.map(([token]) => `\\left${token} x \\right${token}`),
  ...DELIMITERS.map(
    ([token], index) =>
      `\\left${token} x \\right${DELIMITERS[(index + 5) % DELIMITERS.length]![0]}`,
  ),
  ...CONTROLS.map((name) => {
    if (['text', 'mathrm', 'operatorname'].includes(name)) return `\\${name}{a b}`
    if (name === 'left') return '\\left( x \\right)'
    if (name === 'begin') return '\\begin{matrix} 1 \\end{matrix}'
    if (name === 'lim') return '\\lim_{n \\to \\infty} x_n'
    if (name === 'sqrt') return '\\sqrt[3]{x}'
    return /^[A-Za-z]+$/.test(name) ? `\\${name}{a}{b}` : `x \\${name} y`
  }),
]

const GENERATED_LATEX = times(3200, () => {
  const latex = expr(0)
  return chance(0.15) ? corrupt(latex) : latex
})

const LATEX_EDGES = [
  '',
  ' ',
  '\\',
  'x\\',
  '{',
  '}',
  '{}',
  '{{}}',
  'x^',
  'x_',
  '^2',
  '_2',
  'x^{}',
  'x^2_3',
  'x_3^2',
  'x^2^3',
  'x_2_3',
  'x^_2',
  'ab^2',
  'abc_{i}',
  'a\u{1F600}^2',
  '\u{1F600}^2',
  'x^{\u{1F600}}',
  'x^\u{1F600}',
  '\\frac\u{1F600}b',
  '\\hat\u{1F600}',
  '\\frac12',
  '\\frac{1}{2}',
  '\\frac',
  '\\frac{1}',
  '\\frac{a}{b}{c}',
  '\\sqrt[3]{x}',
  '\\sqrt[]{x}',
  '\\sqrt [n] x',
  '\\sqrt[3{x}',
  '\\sqrt[\\frac{a}{b}]{x}',
  '\\sqrt[a}]{x}',
  '\\sqrt[a]]{x}',
  '\\left( x \\right)',
  '\\left\\{ x \\right.',
  '\\left. x \\right\\|',
  '\\left( x',
  '\\left< x \\right>',
  '\\left\\foo x \\right)',
  '\\left( x \\right\\foo',
  '\\left',
  '\\right)',
  '\\left(\\left[x\\right]\\right)',
  '\\begin{matrix}a&b\\\\c&d\\end{matrix}',
  '\\begin{pmatrix}a\\end{bmatrix}',
  '\\begin{foo}a\\end{foo}',
  '\\begin{matrix}a',
  '\\begin{matrix}a\\endx',
  '\\begin{matrix}\\\\\\end{matrix}',
  '\\begin{matrix}&\\\\&\\end{matrix}',
  '\\begin {matrix} a \\end {matrix}',
  '\\begin{cases} x & x > 0 \\\\ -x & x \\le 0 \\end{cases}',
  '\\begin{matrix}\\begin{matrix}a\\end{matrix}\\end{matrix}',
  '\\begin',
  '\\begin{matrix',
  '\\text{a b}',
  '\\text{a{b}c}',
  '\\text{unclosed',
  '\\text x',
  '\\text{}',
  '\\operatorname{sn} x',
  '\\mathrm{d}x',
  '\\lim',
  '\\lim_{n}',
  '\\lim x',
  '\\lim _ n',
  '\\sum',
  '\\sum_{}_{a}',
  '\\sum^{n}_{k}',
  '\\sum_k^n x',
  '\\sum_k^n_j',
  '\\int_0^1 {x dx}',
  '\\oint x',
  '\\hat x',
  '\\hat{}',
  '\\hat',
  '\\, \\; \\  \\quad \\qquad',
  '\\{ \\} \\% \\& \\$ \\# \\_ \\^',
  '\\\\',
  '&',
  'a & b',
  '\\unknown',
  '\\constructor',
  '\\toString',
  '\\valueOf',
  '\\hasOwnProperty',
  '\\begin{constructor}a\\end{constructor}',
  '\\begin{__proto__}a\\end{__proto__}',
  '\\begin{toString}x\\end{toString}',
  '\\1',
  '\\\u00e9',
  '\\\u{1F600}',
  '\ud55c\uae00',
  '\u901f\u5ea6 = \\frac{s}{t}',
  '\\text{\u901f\u5ea6} = \\frac{s}{t}',
  'x\ny',
  'x\ty',
  '\u00a0x',
  '\ufeffx',
  '\u0085x',
  'x\u2028y',
  'x\u0001y',
  'a<b>c"d',
  'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
  '(x+a)^n = \\sum_{k=0}^{n} \\binom{n}{k} x^k a^{n-k}',
  'f(x) = a_0 + \\sum_{n=1}^{\\infty} \\left( a_n \\cos \\frac{n\\pi x}{L} + b_n \\sin \\frac{n\\pi x}{L} \\right)',
  'e^x = 1 + \\frac{x}{1!} + \\frac{x^2}{2!} + \\cdots',
  `${'x+'.repeat(4000)}x`,
  '\\alpha '.repeat(2000),
  `${'{'.repeat(120)}x${'}'.repeat(120)}`,
  `${'\\hat'.repeat(250)} x`,
  `${'\\frac{'.repeat(120)}x${'}{y}'.repeat(120)}`,
  `${'\\sqrt{'.repeat(120)}x${'}'.repeat(120)}`,
  `${'\\left('.repeat(80)}x${'\\right)'.repeat(80)}`,
]

const LATEX = [...LATEX_EDGES, ...LATEX_EXAMPLES, ...GENERATED_LATEX]

const latexResult = (latex: string): string | undefined => {
  try {
    return latexToOmml(latex)
  } catch {
    return undefined
  }
}
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
/** The OMML of each LaTeX input that converts into a text JSON can carry to Rust. */
const CONVERTED = LATEX.map(latexResult).filter(
  (omml): omml is string => omml !== undefined && !LONE_SURROGATE.test(omml),
)

// ---- OMML ----

const OMML_TEXTS = [
  'x',
  '2',
  '10',
  '3.14',
  'ab',
  'n-k',
  'a+b',
  '(x)',
  '[0,1]',
  '{a}',
  '|x|',
  ' ',
  '  ',
  '',
  'sin',
  ' lim ',
  'sn',
  'f2',
  '\u{1D465}',
  '\u{1D400}x',
  '\u00e9',
  '\u901f',
  '\ud55c',
  'a\\b',
  'line\nbreak',
  '\u00a0',
  '<>&"\'',
  "it's",
  'say "x"',
  '\u0001',
  ...ESCAPED,
  ...SYMBOLS.map(([, ch]) => ch!),
  ...OPERATORS,
]
const FLAGS = ['1', '0', 'true', 'false', 'on', 'off', 'OFF', 'False', null]
const DELIMITER_CHARS = [
  '',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '|',
  '\u2016',
  '\u27e8',
  '\u27e9',
  '\u230a',
  '\u230b',
  '\u2308',
  '\u2309',
  '<',
  'x',
  '"',
]
const MAX_OMML_DEPTH = 4
/** What `ommlToLatex` can express: a tree drawn from these alone mostly converts. */
const SUBSET_ELEMENTS = [
  ...ELEMENTS.filter((name) => !['m:sPre', 'm:limUpp', 'm:eqArr'].includes(name)),
  'm:r',
  'm:r',
  'm:r',
]
const SUBSET_TEXTS = OMML_TEXTS.filter((text) => !/[\\\n{}]/.test(text))
let subsetOnly = false

/** `<name m:val="value"/>`; a `null` value is an element without `m:val`. */
const prop = (name: string, value: string | null): string =>
  value === null
    ? `<${name}/>`
    : `<${name} m:val="${escapeXmlText(value).replace(/"/g, '&quot;')}"/>`

/** A property bag holding a random subset of `props`. */
function bag(name: string, props: Array<[string, Array<string | null>]>): string {
  if (chance(0.15)) return ''
  const inner = props
    .filter(() => chance(0.6))
    .map(([child, values]) => prop(child, pick(values)))
    .join('')
  return `<${name}>${inner}${chance(0.2) ? '<m:ctrlPr><w:rPr/></m:ctrlPr>' : ''}</${name}>`
}

function run(text = pick(subsetOnly ? SUBSET_TEXTS : OMML_TEXTS)): string {
  const rPr = pick([
    '',
    '',
    '<m:rPr><m:sty m:val="p"/></m:rPr>',
    '<m:rPr><m:sty m:val="i"/></m:rPr>',
    '<m:rPr><m:nor/></m:rPr>',
    '<m:rPr><m:sty/></m:rPr>',
  ])
  const texts = times(chance(0.15) ? 2 : 1, (i) => (i === 0 ? text : pick(OMML_TEXTS)))
  const space = chance(0.5) ? ' xml:space="preserve"' : ''
  // Word writes quotes as they are; other writers use the entities
  const entities = chance(0.5)
  const body = texts
    .map((t) => escapeXmlText(t))
    .map((t) => (entities ? t.replace(/'/g, '&apos;').replace(/"/g, '&quot;') : t))
    .map((t) => `<m:t${space}>${t}</m:t>`)
    .join('')
  return `<m:r>${rPr}${chance(0.1) ? '<w:rPr><w:b/></w:rPr>' : ''}${body}</m:r>`
}

function slot(name: string, depth: number): string {
  if (chance(0.08)) return ''
  if (chance(0.05)) return `<${name}/>`
  return `<${name}>${chance(0.1) ? '<m:ctrlPr/>' : ''}${nodes(depth + 1)}</${name}>`
}

function node(depth: number): string {
  if (depth >= (subsetOnly ? 2 : MAX_OMML_DEPTH)) return run()
  const s = (name: string): string => slot(name, depth)
  const element = subsetOnly
    ? pick(SUBSET_ELEMENTS)
    : pick([...ELEMENTS, 'm:r', 'm:r', 'm:r', 'm:unknown', 'w:r', 'glue'])
  switch (element) {
    case 'm:f':
      return `<m:f>${bag('m:fPr', [['m:type', ['bar', 'noBar', 'lin', 'skw', 'other', null]]])}${s('m:num')}${s('m:den')}</m:f>`
    case 'm:sSup':
      return `<m:sSup>${bag('m:sSupPr', [])}${s('m:e')}${s('m:sup')}</m:sSup>`
    case 'm:sSub':
      return `<m:sSub>${s('m:e')}${s('m:sub')}</m:sSub>`
    case 'm:sSubSup':
      return `<m:sSubSup>${s('m:e')}${s('m:sub')}${s('m:sup')}</m:sSubSup>`
    case 'm:sPre':
      return `<m:sPre>${s('m:sub')}${s('m:sup')}${s('m:e')}</m:sPre>`
    case 'm:rad':
      return `<m:rad>${bag('m:radPr', [['m:degHide', FLAGS]])}${s('m:deg')}${s('m:e')}</m:rad>`
    case 'm:d': {
      const count = subsetOnly ? 1 : pick([1, 1, 1, 2, 3, 0])
      const slots = times(count, () => slot('m:e', depth)).join('')
      return `<m:d>${bag('m:dPr', [
        ['m:begChr', DELIMITER_CHARS],
        ['m:endChr', DELIMITER_CHARS],
        ['m:sepChr', ['', '|', ',', null]],
      ])}${slots}</m:d>`
    }
    case 'm:nary':
      return `<m:nary>${bag('m:naryPr', [
        ['m:chr', [...NARY.map(([, chr]) => chr!), '\u222b', 'x', '', null]],
        ['m:limLoc', ['undOvr', 'subSup', 'other']],
        ['m:subHide', FLAGS],
        ['m:supHide', FLAGS],
      ])}${s('m:sub')}${s('m:sup')}${s('m:e')}</m:nary>`
    case 'm:func': {
      const name = pick([...FUNCTIONS, 'lim', 'f', 'sn', 'f2', ' sin ', '', '\u00e9'])
      return `<m:func><m:fName>${run(name)}</m:fName>${s('m:e')}</m:func>`
    }
    case 'm:limLow':
      return `<m:limLow><m:e>${run(pick(['lim', ' lim', 'max', 'x']))}</m:e>${s('m:lim')}</m:limLow>`
    case 'm:limUpp':
      return `<m:limUpp>${s('m:e')}${s('m:lim')}</m:limUpp>`
    case 'm:acc':
      return `<m:acc>${bag('m:accPr', [['m:chr', [...ACCENTS.map(([, ch]) => ch!), 'x', '', null]]])}${s('m:e')}</m:acc>`
    case 'm:bar':
      return `<m:bar>${bag('m:barPr', [['m:pos', ['top', 'bot', 'x', null]]])}${s('m:e')}</m:bar>`
    case 'm:groupChr':
      return `<m:groupChr>${bag('m:groupChrPr', [
        ['m:chr', ['\u23df', '\u23de', 'x', '', null]],
        ['m:pos', ['top', 'bot', null]],
      ])}${s('m:e')}</m:groupChr>`
    case 'm:m': {
      const jc = chance(0.5)
        ? `<m:mPr><m:mcs><m:mc><m:mcPr>${prop('m:mcJc', pick(['left', 'right', 'center', '', null]))}</m:mcPr></m:mc></m:mcs></m:mPr>`
        : ''
      const rows = times(
        1 + Math.floor(random() * 3),
        () =>
          `<m:mr>${times(1 + Math.floor(random() * 3), () => slot('m:e', depth)).join('')}</m:mr>`,
      )
      return `<m:m>${jc}${rows.join('')}</m:m>`
    }
    case 'm:eqArr':
      return `<m:eqArr>${times(1 + Math.floor(random() * 3), () => slot('m:e', depth)).join('')}</m:eqArr>`
    case 'm:borderBox':
      return `<m:borderBox>${bag('m:borderBoxPr', [
        ['m:hideTop', FLAGS],
        ['m:hideRight', FLAGS],
        ['m:hideBot', FLAGS],
        ['m:hideLeft', FLAGS],
      ])}${s('m:e')}</m:borderBox>`
    case 'm:box':
    case 'm:phant':
    case 'm:t':
    case 'm:r':
      return pick([
        run(),
        `<m:box>${s('m:e')}</m:box>`,
        `<m:phant>${s('m:e')}</m:phant>`,
        `<m:t>${escapeXmlText(pick(OMML_TEXTS))}</m:t>`,
      ])
    case 'w:r':
      return '<w:r><w:t>w</w:t></w:r>'
    case 'glue':
      return pick([' ', '\n  ', 'text'])
    default:
      return `<m:unknown>${s('m:e')}${run()}</m:unknown>`
  }
}

function nodes(depth: number): string {
  return times(1 + Math.floor(random() * (depth >= MAX_OMML_DEPTH || subsetOnly ? 1 : 3)), () =>
    node(depth),
  ).join('')
}

function ommlFragment(): string {
  const body = nodes(0)
  const zone = (): string => `<m:oMath>${nodes(0)}</m:oMath>`
  switch (Math.floor(random() * 12)) {
    case 0:
      return `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${body}</m:oMath>`
    case 1:
      return `<m:oMathPara><m:oMathParaPr><m:jc m:val="left"/></m:oMathParaPr><m:oMath>${body}</m:oMath></m:oMathPara>`
    case 2:
      return `<m:oMathPara>${zone()}${zone()}</m:oMathPara>`
    case 3:
      return `<m:oMath>${body}<m:r><w:br/></m:r>${pick(['', ' ', '\n'])}</m:oMath>`
    case 4:
      return body
    case 5:
      return `<m:oMath>${body}`
    default:
      return `<m:oMath>${body}</m:oMath>`
  }
}

const GENERATED_OMML = times(1600, ommlFragment)
subsetOnly = true
const SUBSET_OMML = times(1000, () => `<m:oMath>${nodes(0)}</m:oMath>`)
subsetOnly = false

const OMML_EDGES = [
  '',
  'x',
  '<m:oMath/>',
  '<m:oMath></m:oMath>',
  '<m:oMath> </m:oMath>',
  '<m:oMathPara/>',
  '<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath><m:oMath><m:r><m:t>y</m:t></m:r></m:oMath>',
  '<m:oMath><m:r><m:t>x</m:t></m:r>',
  '<m:oMath><m:r><m:t>x</m:t></m:x></m:oMath>',
  '<m:oMath><m:r><m:t>x  y   z</m:t></m:r></m:oMath>',
  '<m:oMath><m:r><m:t>n-k</m:t></m:r></m:oMath>',
  '<m:oMath><m:r><m:t>&quot;&apos;&amp;lt;</m:t></m:r></m:oMath>',
  '<m:oMath><m:r><m:t>a</m:t><m:t>1</m:t><m:t>2</m:t></m:r></m:oMath>',
  '<m:oMath><m:r><w:br/></m:r></m:oMath>',
  '<m:oMath><m:r><w:br w:type="page"/></m:r> </m:oMath> ',
  '<m:oMath><m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr><m:e><m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num><m:r><m:t>n</m:t></m:r></m:num><m:den><m:r><m:t>k</m:t></m:r></m:den></m:f></m:e></m:d></m:oMath>',
  '<m:oMath><m:d><m:e><m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num><m:r><m:t>n</m:t></m:r></m:num></m:f></m:e></m:d></m:oMath>',
  '<m:oMath><m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val=""/></m:dPr><m:e><m:eqArr><m:e><m:r><m:t>a</m:t></m:r></m:e><m:e><m:r><m:t>b</m:t></m:r></m:e></m:eqArr></m:e></m:d></m:oMath>',
  '<m:oMath><m:d><m:dPr><m:begChr m:val="&lt;"/><m:endChr m:val="&gt;"/></m:dPr><m:e><m:m><m:mr><m:e><m:r><m:t>1</m:t></m:r></m:e></m:mr></m:m></m:e></m:d></m:oMath>',
  '<m:oMath><m:rad><m:radPr><m:degHide m:val="0"/></m:radPr><m:deg><m:r><m:t>a]</m:t></m:r></m:deg><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad></m:oMath>',
  '<m:oMath><m:rad><m:deg><m:f><m:num><m:r><m:t>a]</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:deg><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad></m:oMath>',
  '<m:oMath><m:rad><m:deg><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>a]b</m:t></m:r></m:deg><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad></m:oMath>',
  '<m:oMath><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>a{b</m:t></m:r></m:oMath>',
  '<m:oMath><m:r><m:rPr><m:nor/></m:rPr><m:t> lim </m:t></m:r><m:r><m:rPr><m:nor/></m:rPr><m:t>  </m:t></m:r></m:oMath>',
  '<m:oMath><m:func><m:fName><m:r><m:t>sin</m:t></m:r><m:r><m:t>h</m:t></m:r></m:fName><m:e/></m:func></m:oMath>',
  '<m:oMath><m:nary><m:naryPr><m:chr m:val="\u2211"/><m:subHide m:val="1"/><m:supHide m:val="1"/></m:naryPr><m:sub/><m:sup/><m:e><m:r><m:t>k</m:t></m:r></m:e></m:nary></m:oMath>',
  '<m:oMath><m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:mcJc m:val="right"/></m:mcPr></m:mc></m:mcs></m:mPr><m:mr><m:e><m:r><m:t>1</m:t></m:r></m:e><m:e><m:r><m:t>2</m:t></m:r></m:e></m:mr></m:m></m:oMath>',
  '<m:oMath><m:borderBox><m:borderBoxPr><m:hideTop/><m:hideRight/><m:hideBot/><m:hideLeft/></m:borderBoxPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:borderBox></m:oMath>',
  '<m:oMath><m:borderBox/></m:oMath>',
  ...['bar', 'noBar', 'lin', 'skw', ''].map(
    (type) =>
      `<m:oMath><m:f><m:fPr><m:type m:val="${type}"/></m:fPr><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath>`,
  ),
  '<m:oMath><m:func><m:e><m:r><m:t>x</m:t></m:r></m:e></m:func></m:oMath>',
  '<m:oMath><m:limLow><m:lim><m:r><m:t>n</m:t></m:r></m:lim></m:limLow></m:oMath>',
  `<m:oMath>${'<m:sSup><m:e>'.repeat(40)}x${'</m:e></m:sSup>'.repeat(40)}</m:oMath>`,
  `<m:oMath>${'<m:box><m:e>'.repeat(60)}<m:r><m:t>x</m:t></m:r>${'</m:e></m:box>'.repeat(60)}</m:oMath>`,
]

const OMML = [
  ...OMML_EDGES,
  ...GENERATED_OMML,
  ...SUBSET_OMML,
  ...CONVERTED.map((omml) => `<m:oMath>${omml}</m:oMath>`),
]
const PARAGRAPHS = [
  ...OMML.slice(0, 1200).map((omml) => `<w:p><w:r><w:t>see</w:t></w:r>${omml}</w:p>`),
  '<w:p><m:oMathPara><m:oMath><m:r><m:t>a</m:t></m:r></m:oMath></m:oMathPara></w:p>',
  '<w:p><m:oMath\t><m:r><m:t>a</m:t></m:r></m:oMath><m:oMath\n></m:oMath></w:p>',
  '<w:p><m:oMathx><m:r><m:t>a</m:t></m:r></m:oMath></w:p>',
]

// ---- the specs ----

const inputs = (texts: readonly string[]): Input[] => texts.map((text) => ({ text }))

/** Every formula zone a part holds, and every display formula around them. */
function zones(parts: ReadonlyMap<string, string>): Input[] {
  return [...parts.values()]
    .filter((xml) => xml.includes('<m:oMath'))
    .flatMap((xml) => [
      ...elementFragments(xml, 'm:oMath'),
      ...elementFragments(xml, 'm:oMathPara'),
    ])
    .map((text) => ({ text }))
}

/** The paragraphs that hold a formula, and the zones themselves. */
function paragraphs(parts: ReadonlyMap<string, string>): Input[] {
  return [
    ...[...parts.values()]
      .filter((xml) => xml.includes('<m:oMath'))
      .flatMap((xml) => elementFragments(xml, 'w:p').filter((p) => p.includes('<m:oMath')))
      .map((text) => ({ text })),
    ...zones(parts),
  ]
}

const ALIGNS = [undefined, 'left', 'center', 'right', 'justify', '', 'a"b<']

export const MATH: CallSpec[] = [
  {
    fn: 'math.ommlFragmentsOf',
    call: (text) => ommlFragmentsOf(text),
    fromDocument: paragraphs,
    built: inputs([...OMML_EDGES, ...PARAGRAPHS]),
  },
  {
    fn: 'math.ommlEndsWithBreak',
    call: (text) => ommlEndsWithBreak(text),
    fromDocument: paragraphs,
    built: inputs([...OMML_EDGES, ...GENERATED_OMML]),
  },
  {
    fn: 'math.mathTokensOf',
    call: (text) => mathTokensOf(text),
    fromDocument: paragraphs,
    built: inputs([...OMML_EDGES, ...GENERATED_OMML]),
  },
  {
    fn: 'math.ommlToMathML',
    call: (text) => ommlToMathML(text),
    fromDocument: zones,
    built: inputs(OMML),
  },
  {
    fn: 'math.ommlToLatex',
    call: (text) => ommlToLatex(text),
    fromDocument: zones,
    built: inputs(OMML),
  },
  {
    fn: 'math.latexToOmml',
    call: (text) => latexToOmml(text),
    built: inputs(LATEX),
  },
  {
    fn: 'math.mathParagraphXml',
    call: (text, args) =>
      mathParagraphXml(text, args.align as 'left' | 'center' | 'right' | undefined),
    built: CONVERTED.slice(0, 700).map((text, index) => {
      const align = ALIGNS[index % ALIGNS.length]
      return { text, args: align === undefined ? {} : { align } }
    }),
  },
  {
    fn: 'math.roundTripFromOmml',
    call: (text) => {
      const latex = ommlToLatex(text)
      return latex === null ? null : latexToOmml(latex)
    },
    fromDocument: zones,
    built: inputs(OMML),
  },
  {
    fn: 'math.roundTripFromLatex',
    call: (text) => ommlToLatex(`<m:oMath>${latexToOmml(text)}</m:oMath>`),
    built: inputs(LATEX),
  },
  {
    fn: 'math.mathMLFromLatex',
    call: (text) => ommlToMathML(`<m:oMath>${latexToOmml(text)}</m:oMath>`),
    built: inputs(LATEX),
  },
]
