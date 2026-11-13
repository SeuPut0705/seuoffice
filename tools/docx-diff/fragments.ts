export interface TagToken {
  start: number
  end: number
  name: string
  closing: boolean
  selfClosing: boolean
}

const OPAQUE: Array<[open: string, close: string]> = [
  ['<!--', '-->'],
  ['<![CDATA[', ']]>'],
  ['<?', '?>'],
  ['<!', '>'],
]

/**
 * The tags of `xml` in order. Comments, CDATA sections, processing
 * instructions and declarations are skipped, and a `>` inside a quoted
 * attribute value does not end a tag: markup in those places is not markup.
 */
export function* tagTokens(xml: string): Generator<TagToken> {
  let cursor = 0
  for (;;) {
    const start = xml.indexOf('<', cursor)
    if (start === -1) return
    const opaque = OPAQUE.find(([open]) => xml.startsWith(open, start))
    if (opaque) {
      const close = xml.indexOf(opaque[1], start + opaque[0].length)
      if (close === -1) return
      cursor = close + opaque[1].length
      continue
    }
    let end = start + 1
    let quote = ''
    for (; end < xml.length; end++) {
      const ch = xml[end]!
      if (quote) {
        if (ch === quote) quote = ''
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') break
    }
    if (end >= xml.length) return
    end += 1
    const closing = xml[start + 1] === '/'
    yield {
      start,
      end,
      name: /^<\/?([^\s/>]*)/.exec(xml.slice(start, end))![1]!,
      closing,
      selfClosing: !closing && xml[end - 2] === '/',
    }
    cursor = end
  }
}

/**
 * Every element called `name` as a source slice, in the order the elements
 * end. A nested element (a `w:rPr` inside `w:rPrChange`) is a fragment of its
 * own and also part of the one around it.
 */
export function elementFragments(xml: string, name: string): string[] {
  const fragments: string[] = []
  const open: number[] = []
  for (const tag of tagTokens(xml)) {
    if (tag.name !== name) continue
    if (tag.selfClosing) fragments.push(xml.slice(tag.start, tag.end))
    else if (!tag.closing) open.push(tag.start)
    else {
      const start = open.pop()
      if (start !== undefined) fragments.push(xml.slice(start, tag.end))
    }
  }
  return fragments
}
