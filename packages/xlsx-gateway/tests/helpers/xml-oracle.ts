/**
 * A strict XML reader for the tests that check what a save wrote: a part that
 * is not well-formed throws, and what it holds is read as an XML parser reads
 * it (comments dropped, CDATA as text, entities decoded, a prefix ignored).
 * It shares nothing with the patterns the gateway reads and edits parts with.
 */

export interface XmlNode {
  /** the element's name without its prefix */
  readonly name: string
  /** the attributes by name without their prefix, values decoded */
  readonly attributes: Record<string, string>
  readonly children: XmlNode[]
  /** the text directly inside the element */
  text: string
}

const NAME = '[A-Za-z_][\\w.-]*(?::[A-Za-z_][\\w.-]*)?'
const ATTRIBUTE = new RegExp(`\\s+(${NAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, 'y')
const START = new RegExp(`<(${NAME})`, 'y')
const END = new RegExp(`</(${NAME})\\s*>`, 'y')
const COMMENT = /<!--(?:(?!--)[\s\S])*-->/y
const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/y
const INSTRUCTION = /<\?[\s\S]*?\?>/y
const TEXT = /[^<]+/y
const ENTITY = /&(?:#([0-9]+)|#x([0-9A-Fa-f]+)|(amp|lt|gt|quot|apos));/g
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

const local = (name: string): string => name.slice(name.indexOf(':') + 1)

function decode(text: string, where: string): string {
  if (/&(?!(?:#[0-9]+|#x[0-9A-Fa-f]+|amp|lt|gt|quot|apos);)/.test(text)) {
    throw new Error(`bad entity in ${where}`)
  }
  return text.replace(ENTITY, (_all, dec?: string, hex?: string, named?: string) =>
    named === undefined
      ? String.fromCodePoint(dec === undefined ? Number.parseInt(hex!, 16) : Number(dec))
      : NAMED[named]!,
  )
}

function match(pattern: RegExp, xml: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at
  return pattern.exec(xml)
}

/** the root element; throws when the text is not well-formed XML */
export function parseXml(xml: string): XmlNode {
  let at = match(/<\?xml[\s\S]*?\?>\s*/y, xml, 0)?.[0].length ?? 0
  const stack: { node: XmlNode; qname: string }[] = []
  let root: XmlNode | undefined
  while (at < xml.length) {
    if (xml[at] !== '<') {
      const text = match(TEXT, xml, at)![0]
      if (text.includes(']]>')) throw new Error(`stray ]]> at ${at}`)
      const top = stack.at(-1)
      if (top === undefined) {
        if (text.trim() !== '') throw new Error(`text outside the root at ${at}`)
      } else top.node.text += decode(text, `text at ${at}`)
      at += text.length
      continue
    }
    const skipped = match(COMMENT, xml, at) ?? match(INSTRUCTION, xml, at)
    if (skipped !== null) {
      at += skipped[0].length
      continue
    }
    const cdata = match(CDATA, xml, at)
    if (cdata !== null) {
      const top = stack.at(-1)
      if (top === undefined) throw new Error(`CDATA outside the root at ${at}`)
      top.node.text += cdata[1]
      at += cdata[0].length
      continue
    }
    const end = match(END, xml, at)
    if (end !== null) {
      const top = stack.pop()
      if (top === undefined || top.qname !== end[1])
        throw new Error(`unmatched </${end[1]}> at ${at}`)
      at += end[0].length
      continue
    }
    const start = match(START, xml, at)
    if (start === null) throw new Error(`bad markup at ${at}: ${xml.slice(at, at + 40)}`)
    at += start[0].length
    const attributes: Record<string, string> = {}
    for (
      let attribute = match(ATTRIBUTE, xml, at);
      attribute;
      attribute = match(ATTRIBUTE, xml, at)
    ) {
      const name = local(attribute[1]!)
      if (name in attributes) throw new Error(`duplicate attribute ${name} at ${at}`)
      attributes[name] = decode(attribute[2] ?? attribute[3] ?? '', `attribute ${name}`)
      at += attribute[0].length
    }
    const close = match(/\s*(\/?)>/y, xml, at)
    if (close === null) throw new Error(`bad start tag at ${at}`)
    at += close[0].length
    const node: XmlNode = { name: local(start[1]!), attributes, children: [], text: '' }
    const parent = stack.at(-1)
    if (parent === undefined) {
      if (root !== undefined) throw new Error('more than one root element')
      root = node
    } else parent.node.children.push(node)
    if (close[1] !== '/') stack.push({ node, qname: start[1]! })
  }
  if (stack.length > 0) throw new Error(`<${stack.at(-1)!.qname}> is never closed`)
  if (root === undefined) throw new Error('no root element')
  return root
}

/** the child elements of `node` named `name` */
export const childrenNamed = (node: XmlNode | undefined, name: string): XmlNode[] =>
  node?.children.filter((child) => child.name === name) ?? []

/** the first child element of `node` named `name` */
export const childNamed = (node: XmlNode | undefined, name: string): XmlNode | undefined =>
  childrenNamed(node, name)[0]
