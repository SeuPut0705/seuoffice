// Writes crates/jscompat/tests/json_errors.rs: each input that JSON.parse
// refuses, with the message Node gives. Run from the repository root:
//   PATH=/opt/homebrew/opt/node@22/bin:$PATH node crates/jscompat/tests/gen_json_errors.mjs
import { writeFileSync } from 'node:fs'

const hand = [
  '',
  ' ',
  ' \t\r\n ',
  '\n\n',
  'x',
  'undefined',
  'NaN',
  'Infinity',
  '[object Object]',
  '[object Object]x',
  '{',
  '{ ',
  '{"a"',
  '{"a":',
  '{"a":1',
  '{"a":1,',
  '{"a":1,}',
  '{,}',
  '{1:2}',
  "{'a':1}",
  '{"a" 1}',
  '{"a":1 "b":2}',
  '{"a":1}}',
  '[',
  '[1',
  '[1,',
  '[1,]',
  '[,]',
  '[1 2]',
  '[1}',
  ']',
  '}',
  ':',
  ',',
  '1 2',
  '{} x',
  'true false',
  'null,',
  '[tru',
  'tru',
  'trux',
  'nul',
  'nulx',
  'fals',
  'falsy',
  't',
  'f',
  'n',
  'tr"',
  'nu1',
  'true1',
  '[nan]',
  '"abc',
  '"',
  '"\\',
  '"\\x"',
  '"\\u12',
  '"\\u12G4"',
  '"\\u"',
  '"\\é"',
  '"\\€"',
  '"\\😀"',
  '"\\\n"',
  '"a\tb"',
  '"a\nb"',
  '"\u0001"',
  '"\u007f"',
  '"é\\q"',
  '{"a":"b\nc"}',
  '{"k\\x":1}',
  '{"1\\u00zz":1}',
  '{"abc',
  '-',
  '-a',
  '--1',
  '01',
  '-01',
  '00',
  '1.',
  '1.e5',
  '1e',
  '1e+',
  '1e-x',
  '1E',
  '.5',
  '+1',
  '1.5.5',
  '[1.]',
  '{"a":1.}',
  '{"a":-}',
  '0x10',
  '1e5e5',
  '-0.',
  '[01]',
  '[-]',
  '[1e]',
  '[\n1,\n2,\n}',
  '{\n  "a": 1,\n  "b": ,\n}',
  '[\r\n1,\r\n]',
  '[\r\n\r\n]]',
  '[\r]]',
  '\r\n\r\nx',
  '[1,\r\n',
  '{"a":\r',
  '😀😀x',
  '["😀","😀",x]',
  '😀',
  '["😀',
  '{"😀":}',
  '[1,\n"😀",\n?]',
  '\u{10FFFF}\u{10FFFF}',
  'é',
  'あいう',
  '[あ]',
  '{"a":あ}',
  '[1, \u00a0]',
  '\ufeff1',
  '\u2028',
  '[1,\u2028]',
  '𝒳',
  '[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,x]',
  '{"a":[1,2,{"b":tru}]}',
  '[[[[1,]]]]',
  '[{"a":1},]',
  '{"a":{"b":1,}}',
  '{"a":[1,}',
  'x'.repeat(20),
  'x'.repeat(21),
  '[' + ' '.repeat(18) + 'x',
  '[' + ' '.repeat(19) + 'x',
  '[' + ' '.repeat(9) + 'x' + ' '.repeat(11),
  '[' + ' '.repeat(10) + 'x' + ' '.repeat(10),
  '[' + ' '.repeat(9) + 'x' + ' '.repeat(10),
  '[' + ' '.repeat(10) + 'x' + ' '.repeat(9),
  '[' + ' '.repeat(10) + 'x' + ' '.repeat(11),
  '[' + ' '.repeat(10) + 'x' + ' '.repeat(20),
  '[' + ' '.repeat(30) + 'x' + ' '.repeat(30),
  '[' + ' '.repeat(30) + 'x',
  'x' + ' '.repeat(30),
  '[1,' + '2,'.repeat(30) + ']',
  '{"a":1' + ',"b":2'.repeat(10) + ',}',
  '['.repeat(15) + '😀' + ']'.repeat(15),
  '😀'.repeat(7) + 'x' + '😀'.repeat(7),
  '[😀' + '1,'.repeat(9) + ']',
  '"' + 'a'.repeat(40) + '\\q"',
  '"' + 'a'.repeat(40) + '\n',
  '[' + '"é",'.repeat(12) + 'é]',
  '1'.repeat(40) + 'z',
  '[' + '1,'.repeat(20) + 'ä' + ',1'.repeat(20) + ']',
]

// seeded mutations of valid documents
let seed = 12345
const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n
const bases = [
  '{"a":[1,2.5,-3e2,true,false,null],"b":{"c":"d\\n\\u00e9","e":[]}}',
  '[{"k":"v"},[1,[2,[3]]],"é😀",0.5e-3]',
  '{\n  "name": "x",\n  "list": [1, 2, 3],\n  "nested": {"t": true}\n}',
]
const bits = [
  '',
  ' ',
  '\n',
  '\r\n',
  ',',
  ':',
  '{',
  '}',
  '[',
  ']',
  '"',
  '\\',
  '-',
  '.',
  'e',
  '0',
  '1',
  'x',
  'é',
  '😀',
  'あ',
  '\t',
  '\u0001',
  'tru',
  'nul',
]
const mutated = []
while (mutated.length < 360) {
  let text = bases[rnd(bases.length)]
  const edits = 1 + rnd(3)
  for (let i = 0; i < edits; i++) {
    const units = [...text]
    const at = rnd(units.length + 1)
    const op = rnd(3)
    if (op === 0) units.splice(at, 0, bits[rnd(bits.length)])
    else if (op === 1) units.splice(at, 1 + rnd(3))
    else units.splice(at, 1, bits[rnd(bits.length)])
    text = units.join('')
  }
  if (rnd(4) === 0) text = text.slice(0, rnd(text.length + 1))
  if (text.isWellFormed()) mutated.push(text)
}

const seen = new Set()
const rows = []
for (const text of [...hand, ...mutated]) {
  if (seen.has(text)) continue
  seen.add(text)
  if (!text.isWellFormed()) throw new Error(`lone surrogate input ${JSON.stringify(text)}`)
  let message
  try {
    JSON.parse(text)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    message = error.message.toWellFormed()
  }
  if (message === undefined) continue
  rows.push([text, message])
}

const literal = (text) => {
  let out = '"'
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (cp >= 0x20 && cp < 0x7f) out += ch
    else out += `\\u{${cp.toString(16)}}`
  }
  return out + '"'
}

const body = rows
  .map(([text, message]) => `    (${literal(text)}, ${literal(message)}),`)
  .join('\n')
const source = `//! \`JSON.parse\` refusals worded as Node 22 (V8 12.4) words them: ${rows.length} inputs, each with
//! \`error.message\`. A lone surrogate in a message (the token, or an excerpt cut
//! inside a pair) is U+FFFD.
//!
//! Generated, do not edit; to regenerate, from the repository root:
//!   PATH=/opt/homebrew/opt/node@22/bin:$PATH node crates/jscompat/tests/gen_json_errors.mjs

use jscompat::json_parse;

const CASES: &[(&str, &str)] = &[
${body}
];

#[test]
fn messages_are_nodes() {
    let mut wrong = Vec::new();
    for &(text, expected) in CASES {
        match json_parse(text) {
            Ok(_) => wrong.push(format!("{text:?}: parsed, Node says {expected:?}")),
            Err(error) => {
                if error.message() != expected {
                    wrong.push(format!("{text:?}\\n   got  {:?}\\n   node {expected:?}", error.message()));
                } else {
                    assert_eq!(error.to_string(), format!("SyntaxError: {expected}"));
                }
            }
        }
    }
    assert!(wrong.is_empty(), "{} of {} differ:\\n{}", wrong.len(), CASES.len(), wrong.join("\\n"));
}
`
writeFileSync(new URL('./json_errors.rs', import.meta.url), source)
console.log(`${rows.length} cases`)
