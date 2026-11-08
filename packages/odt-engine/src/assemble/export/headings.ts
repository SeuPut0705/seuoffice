/**
 * Headings of an exported ODT as Hancom writes its own outline paragraphs: a
 * `text:p` under a paragraph style with `style:default-outline-level`.
 *
 * Hancom numbers every `text:h` with its default outline numbering ("1.",
 * "1.1.") whatever the document's outline style says, so a docx heading would
 * gain a number it never had. LibreOffice takes the outline level from the
 * paragraph style, so the heading stays a heading there.
 */
const HEADING_ATTRS =
  /\s+text:(?:outline-level|is-list-header|restart-numbering|start-value)="[^"]*"/g

/**
 * One part's XML with its `text:h` turned into `text:p` (style names stay as
 * they are written, attribute-escaped). `commonLevels` holds
 * the outline level of each common paragraph style that has one; a heading
 * whose style does not carry its level gets an automatic style that does.
 */
export function headingsAsParagraphs(xml: string, commonLevels: Map<string, number>): string {
  if (!/<text:h[\s/>]/.test(xml)) return xml
  const autos = automaticParagraphStyles(xml)
  // automatic styles plain paragraphs use too cannot take a level themselves
  const shared = new Set<string>()
  for (const m of xml.matchAll(/<text:p(?=[\s/>])[^>]*?\stext:style-name="([^"]*)"/g))
    shared.add(m[1])
  // style name + level → the style the paragraph uses
  const chosen = new Map<string, string>()
  const added: string[] = []
  const taken = new Set(autos.keys())
  const styleFor = (style: string | null, level: number): string => {
    const key = `${style ?? ''}\u0000${level}`
    const known = chosen.get(key)
    if (known) return known
    let name: string
    const auto = style !== null ? autos.get(style) : undefined
    if (auto && !shared.has(style as string) && (auto.level === null || auto.level === level)) {
      // the automatic style takes the level (once; another level gets a copy)
      auto.level = level
      name = style as string
    } else if (!auto && style !== null && commonLevels.get(style) === level) {
      name = style
    } else {
      let n = 1
      do name = `${style ?? 'Heading'}_L${level}${n > 1 ? `_${n}` : ''}`
      while (taken.has(name) && n++)
      taken.add(name)
      const body = auto ? auto.body : ''
      const parent = auto ? auto.parent : style
      added.push(
        `<style:style style:name="${name}" style:family="paragraph"` +
          (parent !== null ? ` style:parent-style-name="${parent}"` : '') +
          ` style:default-outline-level="${level}">${body}</style:style>`,
      )
    }
    chosen.set(key, name)
    return name
  }

  let out = xml.replace(/<text:h(?=[\s/>])([^>]*?)(\/?)>/g, (_m, attrs: string, empty: string) => {
    const style = /\stext:style-name="([^"]*)"/.exec(attrs)?.[1] ?? null
    const level = Math.max(
      1,
      Math.min(10, parseInt(/\stext:outline-level="(\d+)"/.exec(attrs)?.[1] ?? '1', 10) || 1),
    )
    const name = styleFor(style, level)
    const rest = attrs.replace(HEADING_ATTRS, '').replace(/\stext:style-name="[^"]*"/, '')
    return `<text:p text:style-name="${name}"${rest}${empty}>`
  })
  out = out.replace(/<\/text:h>/g, '</text:p>')

  // the automatic styles that took a level carry it
  for (const [name, auto] of autos) {
    if (auto.level === null) continue
    const open = new RegExp(
      `<style:style(?=[^>]*\\sstyle:name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}")([^>]*?)(/?)>`,
    )
    out = out.replace(open, (m: string, attrs: string, empty: string) =>
      /\sstyle:default-outline-level=/.test(attrs)
        ? m
        : `<style:style${attrs} style:default-outline-level="${auto.level}"${empty}>`,
    )
  }
  if (added.length) {
    out = /<office:automatic-styles\/>/.test(out)
      ? out.replace(
          '<office:automatic-styles/>',
          `<office:automatic-styles>${added.join('')}</office:automatic-styles>`,
        )
      : out.replace('</office:automatic-styles>', `${added.join('')}</office:automatic-styles>`)
  }
  return out
}

interface AutoStyle {
  parent: string | null
  /** the element's children */
  body: string
  /** the outline level it takes (null: none yet) */
  level: number | null
}

/** The automatic paragraph styles of a part, by name. */
function automaticParagraphStyles(xml: string): Map<string, AutoStyle> {
  const out = new Map<string, AutoStyle>()
  const start = xml.indexOf('<office:automatic-styles>')
  if (start < 0) return out
  const end = xml.indexOf('</office:automatic-styles>', start)
  const region = xml.slice(start, end)
  const re = /<style:style(?=[\s>])([^>]*?)(\/?)>/g
  for (let m = re.exec(region); m; m = re.exec(region)) {
    const attrs = m[1]
    if (!/\sstyle:family="paragraph"/.test(attrs)) continue
    const name = /\sstyle:name="([^"]*)"/.exec(attrs)?.[1]
    if (!name) continue
    let body = ''
    if (!m[2]) {
      const close = region.indexOf('</style:style>', re.lastIndex)
      body = region.slice(re.lastIndex, close)
    }
    const own = /\sstyle:default-outline-level="(\d+)"/.exec(attrs)?.[1]
    out.set(name, {
      parent: /\sstyle:parent-style-name="([^"]*)"/.exec(attrs)?.[1] ?? null,
      body,
      level: own ? parseInt(own, 10) : null,
    })
  }
  return out
}
