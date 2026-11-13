/**
 * The label of the mark hiding a whole-unit block (docProtected.redact) as the
 * attribute stores it. The co-editing rules judge the attribute as a token and
 * refuse the characters and patterns that could end a style declaration or
 * open a string, a block or a comment (`;`, `\`, `/*`, `url(` …); a person's
 * label may hold any of them. So the attribute holds an escaped form that is
 * made of letters, digits, spaces, `_`, `.` and `,` only: every other
 * character is `%`, its code in hex and `.`. The escape is reversible and
 * leaves a label of plain words as it is.
 */

const PLAIN = /[\p{L}\p{N} _,.]/u

export function encodeBlockLabel(label: string): string {
  let out = ''
  for (const char of label) {
    out += PLAIN.test(char) ? char : `%${char.codePointAt(0)!.toString(16)}.`
  }
  return out
}

export function decodeBlockLabel(stored: string): string {
  return stored.replace(/%([0-9a-f]+)\./g, (all, hex: string) => {
    const code = parseInt(hex, 16)
    return code <= 0x10ffff ? String.fromCodePoint(code) : all
  })
}
