import { rawElements, type PartNamespaces, type RawElement } from './inline-opaque'
import { decodeEntities } from './parse-xml-text'

/**
 * One part as the run writer sees it while the part is put together.
 *
 * Namespaces: wrapper bytes carried on runs are written under elements the
 * engine generates, so every prefix they use has to be declared by the part
 * root. The writer asks before it writes a wrapper.
 *
 * Control ids: a content control written from Run.wrap is the only kind that
 * gives way when its w:id is taken. The run writer marks it with a comment
 * directly before its opening tag; `finish` removes the comments and unwraps
 * a marked control whose id an unmarked control holds or an earlier marked
 * one took. Nothing unmarked is ever rewritten: original slices, verbatim
 * fragments, checkbox controls and the block control around a paragraph
 * only take their id.
 */
export class ContentControlPart {
  private readonly marker: string

  /**
   * `source`: every text copied into the part as it is (the marker must not
   * occur in it). `namespaces`: what the part root declares; absent when the
   * root is not known (a fragment written outside a part), and then prefixes
   * are not judged.
   */
  constructor(
    source: string | readonly string[],
    private readonly namespaces?: PartNamespaces,
  ) {
    const sources = typeof source === 'string' ? [source] : source
    let name = 'seuoffice-inline-yields'
    while (sources.some((xml) => xml.includes(name))) name += '_'
    this.marker = `<!--${name}-->`
  }

  /** the part root declares all of `prefixes` (a root that is not known: not judged) */
  takes(prefixes: ReadonlySet<string>): boolean {
    const namespaces = this.namespaces
    if (!namespaces) return true
    for (const prefix of prefixes) if (!namespaces.has(prefix)) return false
    return true
  }

  /** `controlXml` (bytes starting a w:sdt) marked as written from a run: it gives way to a taken id */
  yielding(controlXml: string): string {
    return this.marker + controlXml
  }

  finish(xml: string): string {
    const cuts: Array<[number, number]> = []
    const marked = new Set<number>()
    for (let at = xml.indexOf(this.marker); at >= 0; at = xml.indexOf(this.marker, at + 1)) {
      const end = at + this.marker.length
      cuts.push([at, end])
      marked.add(end)
    }
    if (cuts.length === 0) return xml

    const controls: Array<{ el: RawElement; id: string; yields: boolean }> = []
    const todo = rawElements(xml, true).reverse()
    for (let el = todo.pop(); el; el = todo.pop()) {
      if (el.name === 'w:sdt') {
        const props = el.children.find((c) => c.name === 'w:sdtPr')
        const idTag = props?.children.find((c) => c.name === 'w:id')
        const attr =
          idTag &&
          /\bw:val\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(xml.slice(idTag.start, idTag.openEnd))
        if (attr) {
          let id = decodeEntities(attr[1] ?? attr[2])
          if (/^[+-]?\d+$/.test(id))
            id = id
              .replace(/^\+/, '')
              .replace(/^(-?)0+(?=\d)/, '$1')
              .replace(/^-0$/, '0')
          controls.push({ el, id, yields: marked.has(el.start) })
        }
      }
      for (let i = el.children.length - 1; i >= 0; i--) todo.push(el.children[i])
    }
    const taken = new Set(controls.filter((c) => !c.yields).map((c) => c.id))
    for (const { el, id, yields } of controls) {
      if (!yields) continue
      if (!taken.has(id)) {
        taken.add(id)
        continue
      }
      // unwrap, do not delete: what the control held stays where it was
      cuts.push([el.start, el.openEnd], [el.closeStart, el.end])
      for (const child of el.children) {
        if (child.name === 'w:sdtPr' || child.name === 'w:sdtEndPr')
          cuts.push([child.start, child.end])
        else if (child.name === 'w:sdtContent')
          cuts.push([child.start, child.openEnd], [child.closeStart, child.end])
      }
    }
    cuts.sort((a, b) => a[0] - b[0])
    const parts: string[] = []
    let cursor = 0
    for (const [start, end] of cuts) {
      if (start > cursor) parts.push(xml.slice(cursor, start))
      cursor = Math.max(cursor, end)
    }
    parts.push(xml.slice(cursor))
    return parts.join('')
  }
}
