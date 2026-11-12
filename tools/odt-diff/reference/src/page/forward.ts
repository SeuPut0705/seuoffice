/**
 * ODF → OOXML for pages: page runs (master pages) and `text:section`s become
 * docx sections, master page regions become header/footer parts.
 *
 * Section boundaries: a page run starts at every paragraph (or table) whose
 * style names a master page (`style:master-page-name`); a docx section also
 * starts and ends at each `text:section` (continuous, with the section's
 * columns). Every non-final docx section ends with a `w:sectPr` injected into
 * its last paragraph; the final one is `ctx.docx.sectPr`.
 *
 * Headers: every page run gets its own copies of its master page's parts, so
 * an edit of one run's header is visible as such on save (a master page that
 * several runs share is then cloned for the edited run only). Slots ODF fills
 * implicitly get explicit parts: a first page without `style:header-first`
 * shows the plain header (`fallback`), and a run without a header after runs
 * with one gets a blank part (`empty`) so Word does not inherit the previous
 * section's header.
 */
import type { BridgeElement, OdfToOoxmlContext } from '../core/convert'
import { BRIDGE_DOCUMENT_NAMESPACES } from '../core/docx-package'
import type { OdtMasterPage, OdtStyleTable } from '../core/styles'
import { escapeXmlAttr } from '../core/xml'
import { numFmtFromOdf } from '../text/lists'
import { paragraphToOoxml } from '../text/paragraph-ooxml'
import { type PageGeometry, columnsOf, layoutGeometry } from './geometry'
import {
  type DocxSection,
  type HfRegion,
  PAGE_OWNER,
  type PageExt,
  type PageHfPart,
  type PageRun,
  writePageExt,
} from './model'
import { childElements, evenOddOf, masterOf, pageNumberOf, startTagAt, titlePgOf } from './odf'
import { buildSectPr, injectParagraphSectPr } from './sectpr'

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CT_BASE = 'application/vnd.openxmlformats-officedocument.wordprocessingml'

/** The master page used where no paragraph names one (as the core's default `sectPr`). */
export function defaultMasterPage(styles: OdtStyleTable): OdtMasterPage | undefined {
  return styles.masterPage('Standard') ?? styles.masterPages[0]
}

interface RunStart {
  master: string
  paragraph: number | null
  block: number | null
  style: string
  family: 'paragraph' | 'table'
}

/**
 * Converts page runs, sections and headers/footers. Call after
 * `convertOdtBody` (it reads the bridge elements) and before `buildBridgeDocx`.
 */
export function convertOdtPage(ctx: OdfToOoxmlContext): void {
  const styles = ctx.doc.styles
  const content = ctx.part('content.xml')
  const map = ctx.map

  // ---- where page runs start
  const blockStart = (blockId: number): RunStart | null => {
    const block = map.blocks[blockId]
    if (block.part !== 'content.xml') return null
    const tag = startTagAt(content.xml, block.start, content.prefixes)
    if (!tag) return null
    const family =
      tag.name === 'text:p' || tag.name === 'text:h'
        ? 'paragraph'
        : tag.name === 'table:table'
          ? 'table'
          : null
    if (!family) return null
    const style = tag.attrs[family === 'paragraph' ? 'text:style-name' : 'table:style-name']
    if (style === undefined) return null
    const master = masterOf(styles.find(style, family, 'content'))
    return master ? { master, paragraph: null, block: blockId, style, family } : null
  }
  const elementStart = (el: BridgeElement, firstOfBlock: boolean): RunStart | null => {
    if (el.paragraph !== null) {
      const rec = map.paragraphs[el.paragraph]
      if (rec && rec.part === 'content.xml' && rec.styleName !== null) {
        const master = masterOf(styles.find(rec.styleName, 'paragraph', 'content'))
        if (master)
          return {
            master,
            paragraph: rec.id,
            block: rec.block,
            style: rec.styleName,
            family: 'paragraph',
          }
      }
      return null
    }
    return firstOfBlock ? blockStart(el.block) : null
  }
  // blocks without any element (kept verbatim) can still switch the master page:
  // the switch shows from the next element on
  const subtreeHasElements = (id: number): boolean => {
    const b = map.blocks[id]
    return b.elements.length > 0 || b.children.some(subtreeHasElements)
  }
  const pendingBefore = new Map<number, RunStart>()
  {
    let pending: RunStart | null = null
    let nextElement = 0
    for (const block of map.blocks) {
      while (nextElement < map.elements.length && map.elements[nextElement].block < block.id) {
        if (pending) pendingBefore.set(nextElement, pending)
        pending = null
        nextElement++
      }
      if (!subtreeHasElements(block.id)) {
        const s = blockStart(block.id)
        if (s) pending = s
      }
    }
    if (pending && nextElement < map.elements.length) pendingBefore.set(nextElement, pending)
  }
  const regionOf = (blockId: number): number | null => {
    let b = map.blocks[blockId]
    while (b) {
      if (b.name === 'text:section') return b.id
      if (b.parent === null) return null
      b = map.blocks[b.parent]
    }
    return null
  }

  // ---- page runs and docx sections
  const defaultMaster = defaultMasterPage(styles)
  const run = (start: RunStart | null): PageRun => {
    const name = start ? start.master : (defaultMaster?.name ?? null)
    return {
      master: name,
      layout: (name !== null ? styles.masterPage(name)?.pageLayoutName : null) ?? null,
      startParagraph: start?.paragraph ?? null,
      startBlock: start?.block ?? null,
      startStyle: start?.style ?? null,
      startFamily: start?.family ?? null,
      hidden: false,
      slots: {},
    }
  }
  const runs: PageRun[] = [run(null)]
  const runPageNumber: Array<number | null> = [null]
  interface Draft {
    run: number
    region: number | null
    continuous: boolean
    elements: number[]
  }
  const drafts: Draft[] = []
  const seenBlocks = new Set<number>()
  map.elements.forEach((el, index) => {
    const firstOfBlock = !seenBlocks.has(el.block)
    seenBlocks.add(el.block)
    const start = elementStart(el, firstOfBlock) ?? pendingBefore.get(index) ?? null
    const region = regionOf(el.block)
    const current = drafts[drafts.length - 1]
    if (start) {
      const r = run(start)
      const number = pageNumberOf(styles, start.style, start.family)
      if (index === 0) {
        runs[0] = r
        runPageNumber[0] = number
      } else {
        runs.push(r)
        runPageNumber.push(number)
      }
      if (current) {
        drafts.push({ run: runs.length - 1, region, continuous: false, elements: [el.id] })
        return
      }
    } else if (current && current.region !== region) {
      drafts.push({ run: current.run, region, continuous: true, elements: [el.id] })
      return
    }
    if (!current) {
      drafts.push({ run: runs.length - 1, region, continuous: false, elements: [el.id] })
      return
    }
    current.elements.push(el.id)
  })
  if (!drafts.length) drafts.push({ run: 0, region: null, continuous: false, elements: [] })

  // a section needs a paragraph to carry its break: one without any joins the next
  const isParagraph = (id: number) => /^<w:p[\s>/]/.test(map.elements[id].xml)
  for (let i = drafts.length - 2; i >= 0; i--) {
    if (drafts[i].elements.some(isParagraph)) continue
    const next = drafts[i + 1]
    next.elements = [...drafts[i].elements, ...next.elements]
    next.continuous = drafts[i].continuous
    drafts.splice(i, 1)
  }
  const shown = new Set(drafts.map((d) => d.run))
  runs.forEach((r, i) => (r.hidden = !shown.has(i)))

  // ---- header / footer parts
  const evenAndOdd = runs.some((r) => !r.hidden && evenOddOf(masterPage(styles, r.master)))
  const parts: Record<string, PageHfPart> = {}
  const counters = { header: 0, footer: 0 }
  const emitted = new Set<HfRegion>()
  for (const r of runs) {
    if (r.hidden) continue
    const master = masterPage(styles, r.master)
    const has = (region: HfRegion) => !!master?.regions[region]
    for (const kind of ['header', 'footer'] as const) {
      const slots: Array<[HfRegion, boolean]> = [
        [kind, true],
        [`${kind}-first`, titlePgOf(master)],
        [`${kind}-left`, evenAndOdd],
      ]
      for (const [slot, active] of slots) {
        if (!active) continue
        let source: HfRegion | null = null
        let fill: PageHfPart['fill'] = 'content'
        if (has(slot)) source = slot
        else if (slot !== kind && has(kind)) {
          source = kind
          fill = 'fallback'
        } else if (emitted.has(slot)) fill = 'empty'
        else continue
        const part = makePart(ctx, kind, ++counters[kind], master, source, fill)
        parts[part.rId] = part
        r.slots[slot] = part.rId
        emitted.add(slot)
      }
    }
  }
  if (evenAndOdd) addSettings(ctx)

  // ---- sectPr per docx section
  const sections: DocxSection[] = []
  const firstOfRun = new Set<number>()
  drafts.forEach((d, i) => {
    const r = runs[d.run]
    const master = masterPage(styles, r.master)
    const layout = r.layout !== null ? styles.pageLayout(r.layout) : undefined
    const geometry: PageGeometry = layoutGeometry(layout)
    const isFirstOfRun = !firstOfRun.has(d.run)
    firstOfRun.add(d.run)
    const references: string[] = []
    for (const slot of [
      'header',
      'header-first',
      'header-left',
      'footer',
      'footer-first',
      'footer-left',
    ] as const) {
      const rId = r.slots[slot]
      if (!rId) continue
      const kind = slot.startsWith('header') ? 'header' : 'footer'
      const type = slot.endsWith('-first') ? 'first' : slot.endsWith('-left') ? 'even' : 'default'
      references.push(`<w:${kind}Reference w:type="${type}" r:id="${escapeXmlAttr(rId)}"/>`)
    }
    const start = isFirstOfRun ? runPageNumber[d.run] : null
    const sectPr = buildSectPr({
      references,
      continuous: d.continuous,
      geometry,
      columns: d.region !== null ? sectionColumns(ctx, d.region) : undefined,
      pageNumber: {
        ...(geometry.numFormat !== null ? { fmt: numFmtFromOdf(geometry.numFormat) } : {}),
        ...(start !== null ? { start } : {}),
      },
      titlePg: isFirstOfRun && titlePgOf(master),
    })
    const last = i === drafts.length - 1
    let carrier: number | null = null
    if (!last) {
      carrier = [...d.elements].reverse().find(isParagraph) ?? null
      if (carrier !== null) {
        const el = map.elements[carrier]
        el.xml = injectParagraphSectPr(el.xml, sectPr)
        // elements after the break paragraph (a table ending the run) show in the
        // next docx section: record them there, as the edited docx will have them
        const trailing = d.elements.splice(d.elements.indexOf(carrier) + 1)
        if (trailing.length) drafts[i + 1].elements.unshift(...trailing)
      }
    } else ctx.docx.sectPr = sectPr
    sections.push({
      run: d.run,
      region: d.region,
      continuous: d.continuous,
      first: d.elements[0] ?? null,
      last: d.elements[d.elements.length - 1] ?? null,
      carrier,
      sectPr,
    })
  })

  const ext: PageExt = {
    version: 1,
    defaultMaster: defaultMaster?.name ?? null,
    evenAndOdd,
    runs,
    sections,
    parts,
  }
  writePageExt(map, ext)
}

export const masterPage = (
  styles: OdtStyleTable,
  name: string | null,
): OdtMasterPage | undefined => (name !== null ? styles.masterPage(name) : undefined)

/** Column count and gap of a `text:section` (its section style), in twips. */
function sectionColumns(
  ctx: OdfToOoxmlContext,
  blockId: number,
): { count: number; gap: number } | undefined {
  const content = ctx.part('content.xml')
  const block = ctx.map.blocks[blockId]
  const name = startTagAt(content.xml, block.start, content.prefixes)?.attrs['text:style-name']
  if (name === undefined) return undefined
  const resolved = ctx.doc.styles.resolve(name, 'section', 'content')
  const cols = resolved?.properties['style:section-properties/style:columns']
  return cols ? columnsOf(cols) : undefined
}

/** Converts one master page region into a header/footer part and registers it. */
function makePart(
  ctx: OdfToOoxmlContext,
  kind: 'header' | 'footer',
  n: number,
  master: OdtMasterPage | undefined,
  region: HfRegion | null,
  fill: PageHfPart['fill'],
): PageHfPart {
  const info = ctx.part('styles.xml')
  const paragraphs: number[] = []
  let body = ''
  const range = region !== null ? master?.regions[region] : undefined
  if (range && !range.selfClosing) {
    for (const child of childElements(info.xml, info.prefixes, range.openEnd, range.closeStart)) {
      if (child.name !== 'text:p' && child.name !== 'text:h') continue
      const { xml, paragraph } = paragraphToOoxml(ctx, child, {
        part: 'styles.xml',
        owner: PAGE_OWNER,
      })
      paragraphs.push(paragraph.id)
      body += xml
    }
  }
  if (!body) body = '<w:p/>'
  const file = `${kind}${n}.xml`
  const root = kind === 'header' ? 'w:hdr' : 'w:ftr'
  const ns = [...BRIDGE_DOCUMENT_NAMESPACES, ...ctx.docx.namespaces].join(' ')
  const xml = `${XML_DECL}<${root} ${ns}>${body}</${root}>`
  const rId = ctx.addRelationship(`${REL_BASE}/${kind}`, file)
  ctx.docx.parts.push({ path: `word/${file}`, data: xml, contentType: `${CT_BASE}.${kind}+xml` })
  // relationships the part's content uses (links, pictures) must be its own
  const used = new Set<string>()
  for (const m of body.matchAll(/\br:(?:id|embed|link)="([^"]+)"/g)) used.add(m[1])
  const rels = ctx.docx.relationships.filter((r) => used.has(r.id))
  if (rels.length) {
    ctx.docx.parts.push({
      path: `word/_rels/${file}.rels`,
      data:
        `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        rels
          .map(
            (r) =>
              `<Relationship Id="${escapeXmlAttr(r.id)}" Type="${escapeXmlAttr(r.type)}" Target="${escapeXmlAttr(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`,
          )
          .join('') +
        '</Relationships>',
    })
  }
  return {
    rId,
    path: `word/${file}`,
    kind,
    master: master?.name ?? '',
    region,
    fill,
    paragraphs,
    xml,
  }
}

/** settings.xml with `w:evenAndOddHeaders` (the bridge docx has no settings part otherwise). */
function addSettings(ctx: OdfToOoxmlContext): void {
  ctx.addRelationship(`${REL_BASE}/settings`, 'settings.xml')
  ctx.docx.parts.push({
    path: 'word/settings.xml',
    data:
      `${XML_DECL}<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      '<w:evenAndOddHeaders/></w:settings>',
    contentType: `${CT_BASE}.settings+xml`,
  })
}
