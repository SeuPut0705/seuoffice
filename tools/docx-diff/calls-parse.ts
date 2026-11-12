// Group `parse`: the internal functions of parse.ts, ported leaf first
// (crates/docx-engine/src/parse/). Their corpus inputs are the arguments
// parseDocx calls them with (fromParse, parse-internals.ts).
import type { CallSpec } from './calls-spec'
import { parseInternals } from './parse-internals'

const internals = await parseInternals()

const attrsOf = (value: unknown): Record<string, string> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) &&
  Object.values(value).every((v) => typeof v === 'string')
    ? (value as Record<string, string>)
    : undefined

export const PARSE: CallSpec[] = [
  {
    fn: 'parse.breakCharOf',
    call: (_text, args) => internals.breakCharOf!(args.attrs),
    fromParse: {
      fn: 'breakCharOf',
      input: ([attrs]) => {
        const own = attrsOf(attrs)
        return own ? { args: { attrs: own } } : undefined
      },
    },
    built: [
      {},
      { 'w:type': 'page' },
      { 'w:type': 'column' },
      { 'w:type': 'textWrapping' },
      { 'w:type': 'page', 'w:clear': 'all' },
      { 'w:clear': '' },
      { 'w:clear': 'none' },
      { 'w:type': 'constructor' },
      { 'w:type': '__proto__' },
      { 'w:type': 'Page' },
    ].map((attrs) => ({ args: { attrs } })),
    mutation: 'none',
    argMutation: true,
  },
  {
    fn: 'parse.wtText',
    call: (text, args) => internals.wtText!(text, args.preserve),
    fromParse: {
      fn: 'wtText',
      input: ([raw, preserve]) =>
        typeof raw === 'string' && typeof preserve === 'boolean' ? { text: raw, args: { preserve } } : undefined,
    },
    built: ['', ' a ', '\ta\tb\t', 'a\r\nb', 'a\rb', 'a\n\rb', ' \r\n ', '\u00a0x\u00a0', '\u3000y', 'a\u2028b'].flatMap(
      (text) => [true, false].map((preserve) => ({ text, args: { preserve } })),
    ),
  },
]
