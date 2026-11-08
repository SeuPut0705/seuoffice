/**
 * OOXML → ODF for pages: page setup, headers/footers and section breaks of
 * the edited docx written back into `styles.xml` (page layouts, master pages)
 * and into the styles of the paragraphs that start page runs.
 *
 * 1. Normalise: the `w:sectPr` the bridge put into paragraphs is stripped from
 *    the bridge elements and from the edited elements, so the text layer sees
 *    paragraphs, not section breaks.
 * 2. Map the edited sections onto the bridge's: an edited section continues a
 *    bridge section when it starts with that section's first surviving
 *    element; otherwise its break was added in the editor. A bridge page run
 *    no edited section continues had its break removed.
 * 3. Each edited page run wants a state of its master page: page layout
 *    attributes that changed, header/footer regions that changed. Runs that
 *    share a master page and want the same state share it; a run that wants
 *    a different state than the others gets a clone (`<name>_io<n>`), and so
 *    does a run whose break was added. A page layout is edited in place only
 *    when every master page using it wants the same change, else cloned.
 * 4. A run moved to a clone (or a removed break, or a changed page number
 *    start) changes the style of the paragraph that starts it: in place when
 *    that automatic style belongs to that paragraph alone and the paragraph
 *    is otherwise untouched, else through the decorator (`register.ts`).
 *
 * Columns are never written. Everything not named keeps its bytes.
 */
import {
  type Block,
  type HfParagraph,
  type SectionInfo,
  type SectionSettings,
  readSections,
  sectionFromSectPr,
  sectionSettingsFromXml,
} from '@genoffice/docx-engine'
import type { AlignedItem, EditedItem, OdtPartInfo, OoxmlToOdfContext } from '../core/convert'
import { alignItems, editedItems, paragraphBlockOf } from '../core/flow'
import type { OdtMasterPage, OdtStyle, OdtStyleTable } from '../core/styles'
import { numFmtToOdf } from '../text/lists'
import { editStyleXml } from '../text/style-xml'
import { isEmptyOverrides, layoutOverrides, type LayoutOverrides } from './geometry'
import {
  type EditedPart,
  baselineParagraphs,
  readEditedParts,
  regionInner,
  regionInnerXml,
} from './hf'
import { HF_REGIONS, type HfRegion, type PageExt, readPageExt } from './model'
import { editLayoutXml, editMasterXml } from './odf'
import { FORCE_MARK, type PagePlan, type StartChange, hasPageDecorator, planOf } from './register'
import { paragraphSectPr, stripParagraphSectPr, stripPPrSectPr } from './sectpr'

type RegionPlan = string | null // new inner XML, or null = remove

interface EditedRun {
  /** edited section indexes (a page run plus its continuous `text:section` parts) */
  sections: number[]
  /** bridge run it continues, or null for a run whose break was added in the editor */
  continues: number | null
  /** bridge run its content comes from */
  baseRun: number
  /** bridge docx section to compare its first section with */
  baseSection: number
  /** first edited element mapped onto the bridge (where a new break starts) */
  carrier: AlignedItem | null
}

interface RunState {
  layout: LayoutOverrides
  regions: Partial<Record<HfRegion, RegionPlan>>
  key: string
  pageNumber?: string | null
}

/**
 * Prepares the page write-back and returns the edited body items to rebuild
 * with (`rebuildOdtBody(rctx, items)`). Queues every styles.xml patch for
 * page layouts and master pages. Call before `rebuildOdtBody`.
 */
export async function preparePageWriteBack(rctx: OoxmlToOdfContext): Promise<EditedItem[]> {
  const items = editedItems(rctx.edited)
  const ext = readPageExt(rctx.map)
  if (!ext) return items
  const breaks = normalise(rctx, ext, items)
  const aligned = alignItems(rctx, items)
  const edited = readSections(rctx.edited)
  const writer = new PageWriter(rctx, ext, aligned, edited)
  await writer.run()
  // a section break the editor inserted is an empty paragraph of its own: ODF needs none
  const dropped = new Set(
    aligned
      .filter((a) => !a.element && breaks.has(a.item) && !a.item.blocks.some((b) => b.runs?.length))
      .map((a) => a.item),
  )
  return dropped.size ? items.filter((item) => !dropped.has(item)) : items
}

// ---------------------------------------------------------------------------
// 1. normalise

/** Strips the bridge's and the edited section breaks; returns the items that carried one. */
function normalise(rctx: OoxmlToOdfContext, ext: PageExt, items: EditedItem[]): Set<EditedItem> {
  const breaks = new Set<EditedItem>()
  for (const s of ext.sections) {
    if (s.carrier === null) continue
    const el = rctx.map.elements[s.carrier]
    if (el) el.xml = stripParagraphSectPr(el.xml)
  }
  for (const item of items) {
    if (paragraphSectPr(item.xml) === null) continue
    item.xml = stripParagraphSectPr(item.xml)
    item.blocks = item.blocks.map((b) => paragraphBlock(b, item.xml))
    breaks.add(item)
  }
  return breaks
}

/** An edited block without its section break (a text-less one parses as a passthrough "section break"). */
function paragraphBlock(b: Block, xml: string): Block {
  if (b.type === 'passthrough') {
    const pPr = /^<w:p(?:\s[^>]*)?>(<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>)/.exec(xml)?.[1]
    const styleId = pPr ? /<w:pStyle w:val="([^"]*)"/.exec(pPr)?.[1] : undefined
    const hidden = [...xml.matchAll(/<w:bookmarkStart\b[^>]*\bw:name="(_[^"]*)"/g)].map((m) => m[1])
    return {
      ...b,
      type: 'paragraph',
      runs: [],
      ...(styleId ? { styleId } : {}),
      ...(pPr ? { rawPPr: pPr } : {}),
      hiddenBookmarks: hidden,
    }
  }
  return b.rawPPr?.includes('<w:sectPr') ? { ...b, rawPPr: stripPPrSectPr(b.rawPPr) } : b
}

// ---------------------------------------------------------------------------

const GEOMETRY_KEYS = [
  'pageWidth',
  'pageHeight',
  'orientation',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'headerDist',
  'footerDist',
] as const

const sameGeometry = (a: SectionSettings, b: SectionSettings) =>
  GEOMETRY_KEYS.every((k) => a[k] === b[k])

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  )

class PageWriter {
  private readonly styles: OdtStyleTable
  private readonly info: OdtPartInfo
  private readonly content: OdtPartInfo
  private readonly plan: PagePlan
  private readonly decorated: boolean
  private body: string | null = null
  private readonly itemByElement = new Map<number, AlignedItem>()
  private readonly elementByParagraph = new Map<number, number>()
  private parts = new Map<string, EditedPart>()
  private baselines = new Map<string, HfParagraph[]>()
  private readonly patchedStyles = new Set<string>()
  /** paragraphs whose page-run start was already written */
  private readonly started = new Set<number>()

  constructor(
    private readonly rctx: OoxmlToOdfContext,
    private readonly ext: PageExt,
    private readonly aligned: AlignedItem[],
    private readonly edited: SectionInfo[],
  ) {
    this.styles = rctx.doc.styles
    this.info = rctx.part('styles.xml')
    this.content = rctx.part('content.xml')
    this.plan = planOf(rctx)
    this.decorated = hasPageDecorator(rctx.registry)
    for (const a of aligned) if (a.element) this.itemByElement.set(a.element.id, a)
    for (const e of rctx.map.elements)
      if (e.paragraph !== null) this.elementByParagraph.set(e.paragraph, e.id)
  }

  async run(): Promise<void> {
    const runs = this.editedRuns()
    // header/footer parts of every edited run
    const rIds = new Set<string>()
    for (const r of runs) {
      const i = r.sections[0]
      for (const kind of ['header', 'footer'] as const)
        for (const variant of ['default', 'first', 'even'] as const) {
          const rId = this.effectiveRef(i, kind, variant)
          if (rId) rIds.add(rId)
        }
    }
    this.parts = await readEditedParts(this.rctx, this.ext, rIds)
    const changedBridgeParts = [...this.parts.values()]
      .filter((p) => !p.unchanged && this.ext.parts[p.rId])
      .map((p) => this.ext.parts[p.rId])
    this.baselines = await baselineParagraphs(changedBridgeParts, this.rctx.options.editedStylesXml)
    this.write(runs)
  }

  // ---- 2. edited sections → edited page runs

  private sectionOf(element: number): number {
    return this.ext.sections.findIndex(
      (s) => s.first !== null && s.last !== null && s.first <= element && element <= s.last,
    )
  }

  private editedRuns(): EditedRun[] {
    const claimed = new Set<number>()
    const out: EditedRun[] = []
    this.edited.forEach((E, i) => {
      const first =
        this.aligned.find(
          (a) => a.element && a.item.index >= E.firstBlockIndex && a.item.index <= E.lastBlockIndex,
        ) ?? null
      let cont: number | null = null
      let base: number | null = null
      if (first?.element) {
        const k = this.sectionOf(first.element.id)
        if (k >= 0) {
          base = k
          let ok = !claimed.has(k)
          for (let e = this.ext.sections[k].first ?? 0; ok && e < first.element.id; e++)
            if (this.rctx.matched.has(e)) ok = false
          if (ok) {
            claimed.add(k)
            cont = k
          }
        }
      }
      const prev = out[out.length - 1]
      if (prev && cont !== null && this.ext.sections[cont].continuous) {
        prev.sections.push(i)
        return
      }
      const baseSection = cont ?? base ?? prev?.baseSection ?? 0
      const bridgeRun = this.ext.sections[baseSection]?.run ?? 0
      const continues = cont !== null || i === 0 ? bridgeRun : null
      if (continues === null) {
        if (!first?.element) {
          this.rctx.warn('a section break before new content only was not written')
          prev?.sections.push(i)
          return
        }
        if (E.startType === 'continuous')
          this.rctx.warn('a continuous section break was written as a page break')
      }
      out.push({ sections: [i], continues, baseRun: bridgeRun, baseSection, carrier: first })
    })
    return out
  }

  /** The header/footer part a section shows for a slot (its own or inherited, as Word does). */
  private effectiveRef(
    section: number,
    kind: 'header' | 'footer',
    variant: 'default' | 'first' | 'even',
  ): string | undefined {
    for (let j = section; j >= 0; j--) {
      const refs = kind === 'header' ? this.edited[j].headerRefs : this.edited[j].footerRefs
      if (refs[variant]) return refs[variant]
    }
    return undefined
  }

  // ---- 3. wanted states

  private masterOfRun(run: number): OdtMasterPage | undefined {
    const name = this.ext.runs[run]?.master
    return name ? this.styles.masterPage(name) : undefined
  }

  private layoutOf(master: OdtMasterPage | undefined): OdtStyle | undefined {
    return master?.pageLayoutName ? this.styles.pageLayout(master.pageLayoutName) : undefined
  }

  /**
   * The bridge section an edited section's `w:sectPr` comes from: the one whose
   * break paragraph (or trailing sectPr) it still carries. A break the editor
   * inserted copies the sectPr of the section it was inserted in. When a break
   * was removed, the merged section carries the later section's sectPr; its
   * edits are measured against that one, so the merged pages simply follow
   * the earlier run's master page.
   */
  private sourceSection(i: number, fallback: number): number {
    const E = this.edited[i]
    if (i === this.edited.length - 1) return this.ext.sections.length - 1
    const carrier = this.aligned.find((a) => a.item.index === E.lastBlockIndex)
    if (carrier?.element) {
      const j = this.ext.sections.findIndex((s) => s.carrier === carrier.element?.id)
      if (j >= 0) return j
    }
    for (let k = this.aligned.length - 1; k >= 0; k--) {
      const a = this.aligned[k]
      if (!a.element || a.item.index < E.firstBlockIndex || a.item.index > E.lastBlockIndex)
        continue
      const j = this.sectionOf(a.element.id)
      if (j >= 0) return j
    }
    return fallback
  }

  private stateOf(r: EditedRun, master: OdtMasterPage): RunState {
    const layout = this.layoutOf(master)
    let overrides: LayoutOverrides = { page: {}, header: {}, footer: {} }
    for (const i of r.sections) {
      const source = this.sourceSection(i, r.baseSection)
      const before = sectionSettingsFromXml(this.ext.sections[source].sectPr)
      const after = this.edited[i].settings
      if (sameGeometry(before, after)) continue
      overrides = layoutOverrides(layout, before, after)
      break
    }
    const first = this.edited[r.sections[0]]
    const source = this.sourceSection(r.sections[0], r.baseSection)
    const bridgeFirst = sectionFromSectPr(this.ext.sections[source].sectPr, 0, 0)
    if ((first.pageNumberFmt ?? null) !== (bridgeFirst.pageNumberFmt ?? null)) {
      overrides.page['style:num-format'] =
        first.pageNumberFmt !== undefined ? numFmtToOdf(first.pageNumberFmt) : null
    }
    const pageNumber =
      first.pageNumberStart !== bridgeFirst.pageNumberStart
        ? first.pageNumberStart !== undefined
          ? String(first.pageNumberStart)
          : null
        : undefined
    const regions = this.regionPlans(r, master, source, bridgeFirst.titlePg)
    const key = canonical({ layout: overrides, regions })
    return {
      layout: overrides,
      regions,
      key,
      ...(pageNumber !== undefined ? { pageNumber } : {}),
    }
  }

  private regionPlans(
    r: EditedRun,
    master: OdtMasterPage,
    source: number,
    sourceTitlePg: boolean,
  ): Partial<Record<HfRegion, RegionPlan>> {
    const out: Partial<Record<HfRegion, RegionPlan>> = {}
    const i = r.sections[0]
    const E = this.edited[i]
    const evenOdd = !!this.rctx.edited.evenAndOddHeaders
    const sourceSlots = this.ext.runs[this.ext.sections[source]?.run ?? r.baseRun]?.slots ?? {}
    for (const region of HF_REGIONS) {
      const kind = region.startsWith('header') ? 'header' : 'footer'
      const variant = region.endsWith('-first')
        ? 'first'
        : region.endsWith('-left')
          ? 'even'
          : 'default'
      const on = variant === 'default' || (variant === 'first' ? E.titlePg : evenOdd)
      const wasOn =
        variant === 'default' || (variant === 'first' ? sourceTitlePg : this.ext.evenAndOdd)
      const has = master.regions[region]
      const hasPlain = !!master.regions[kind]
      if (!on) {
        if (wasOn && has) out[region] = null
        continue
      }
      const rId = this.effectiveRef(i, kind, variant)
      if (!rId) {
        // a first / left page newly switched on that shows nothing in the editor
        if (!wasOn && !has && hasPlain) out[region] = ''
        continue
      }
      const part = this.ext.parts[rId]
      const state = this.parts.get(rId)
      if (part && state?.unchanged) {
        if (sourceSlots[region] === rId) continue
        if (part.master === master.name && part.region === region && part.fill === 'content')
          continue
        if (part.fill === 'fallback' && part.master === master.name && part.region === kind && !has)
          continue
        if (part.fill === 'empty') {
          if (!has && !(variant !== 'default' && hasPlain)) continue
          out[region] = ''
          continue
        }
        // content of another master page's region (Link to Previous)
        const sourceMaster = this.styles.masterPage(part.master)
        const from = part.region ? sourceMaster?.regions[part.region] : undefined
        const inner = from ? regionInner(this.rctx, from) : ''
        if (has && regionInner(this.rctx, has) === inner) continue
        if (!has && variant !== 'default' && part.region === kind && part.master === master.name)
          continue
        out[region] = inner
        continue
      }
      // changed or new part
      const sourceMaster = part ? this.styles.masterPage(part.master) : undefined
      const from = part?.region ? (sourceMaster?.regions[part.region] ?? null) : null
      const records = (part?.paragraphs ?? []).map((id) => this.rctx.map.paragraphs[id])
      const inner = regionInnerXml(
        this.rctx,
        from,
        records,
        part ? this.baselines.get(part.rId) : undefined,
        state?.paragraphs ?? [],
      )
      if (has && regionInner(this.rctx, has) === inner) continue
      out[region] = inner
    }
    return out
  }

  // ---- 4. writing

  private write(runs: EditedRun[]): void {
    const rctx = this.rctx
    // states, grouped by master page
    interface Member {
      run: EditedRun
      state: RunState
      /** how its start can be re-pointed, null when it cannot */
      mode: 'a' | 'b' | null
    }
    const byMaster = new Map<string, Member[]>()
    for (const r of runs) {
      const master = this.masterOfRun(r.continues ?? r.baseRun)
      if (!master) {
        if (r.continues === null)
          rctx.warn('a section break in a document without master pages was not written')
        continue
      }
      const state = this.stateOf(r, master)
      const list = byMaster.get(master.name) ?? []
      list.push({ run: r, state, mode: this.startMode(r) })
      byMaster.set(master.name, list)
    }

    interface Target {
      master: OdtMasterPage
      /** null: the master page itself (edited in place) */
      clone: string | null
      state: RunState
      members: Member[]
      layoutName: string | null
    }
    const targets: Target[] = []
    for (const [name, members] of byMaster) {
      const master = this.styles.masterPage(name) as OdtMasterPage
      const groups = new Map<string, Member[]>()
      for (const m of members) {
        const g = groups.get(m.state.key) ?? []
        g.push(m)
        groups.set(m.state.key, g)
      }
      const continuing = (g: Member[]) => g.filter((m) => m.run.continues !== null)
      const entries = [...groups.entries()].filter(([, g]) => continuing(g).length)
      // the master page stays with the runs that cannot move, else the unchanged ones, else the first
      const stuck = entries.filter(([, g]) => continuing(g).some((m) => m.mode === null))
      if (stuck.length > 1)
        rctx.warn(
          `page style "${name}": a section's change could not be kept apart from the others`,
        )
      const emptyKey = canonical({ layout: { page: {}, header: {}, footer: {} }, regions: {} })
      const keeper =
        stuck[0]?.[0] ?? entries.find(([k]) => k === emptyKey)?.[0] ?? entries[0]?.[0] ?? null
      for (const [key, g] of groups) {
        const stay = key === keeper ? continuing(g) : []
        const move = g.filter((m) => !stay.includes(m))
        if (stay.length)
          targets.push({ master, clone: null, state: g[0].state, members: stay, layoutName: null })
        if (move.length) {
          const movable = move.filter((m) => m.mode !== null || m.run.continues === null)
          const blocked = move.filter((m) => !movable.includes(m))
          if (blocked.length && key !== keeper) {
            rctx.warn(`page style "${name}": a section's change could not be written`)
          }
          if (movable.length)
            targets.push({
              master,
              clone: rctx.allocateStyleName(name),
              state: g[0].state,
              members: movable,
              layoutName: null,
            })
        }
      }
    }

    // page layouts: in place when every master page using it wants the same change
    const layoutUsers = new Map<string, Array<{ target: Target | null; key: string }>>()
    const layoutKey = (s: RunState) => (isEmptyOverrides(s.layout) ? '' : canonical(s.layout))
    for (const m of this.styles.masterPages) {
      if (!m.pageLayoutName) continue
      const own = targets.find((t) => t.master === m && t.clone === null)
      const list = layoutUsers.get(m.pageLayoutName) ?? []
      list.push({ target: own ?? null, key: own ? layoutKey(own.state) : '' })
      layoutUsers.set(m.pageLayoutName, list)
    }
    for (const t of targets) {
      if (t.clone === null || !t.master.pageLayoutName) continue
      layoutUsers.get(t.master.pageLayoutName)?.push({ target: t, key: layoutKey(t.state) })
    }
    for (const [name, users] of layoutUsers) {
      const layout = this.styles.pageLayout(name)
      if (!layout) continue
      const keys = new Set(users.map((u) => u.key))
      const source = this.info.xml.slice(layout.start, layout.end)
      // nobody keeps the layout as it is: one change takes it in place (the
      // master page edited in place first), the other changes get clones
      const inPlace = keys.has('')
        ? null
        : ((users.find((u) => u.target?.clone === null) ?? users[0]).key ?? null)
      const clones = new Map<string, string>()
      for (const u of users) {
        if (!u.key || !u.target) continue
        if (u.key === inPlace) {
          if (!clones.has(u.key)) {
            clones.set(u.key, name)
            rctx.patch(
              'styles.xml',
              layout.start,
              layout.end,
              editLayoutXml(source, this.info.prefixes, u.target.state.layout),
            )
          }
          continue
        }
        let clone = clones.get(u.key)
        if (!clone) {
          clone = rctx.allocateStyleName(name)
          clones.set(u.key, clone)
          rctx.addAutomaticStyle(
            'styles.xml',
            editLayoutXml(source, this.info.prefixes, { name: clone, ...u.target.state.layout }),
          )
        }
        u.target.layoutName = clone
      }
    }

    // master pages
    const styleTag = (m: OdtMasterPage) =>
      m.tag.slice(0, Math.max(0, m.tag.indexOf(':'))) || 'style'
    for (const t of targets) {
      const regions = t.state.regions
      const source = this.info.xml.slice(t.master.start, t.master.end)
      const edit = {
        ...(t.clone !== null ? { name: t.clone } : {}),
        ...(t.layoutName !== null ? { layout: t.layoutName } : {}),
        ...(Object.keys(regions).length ? { regions } : {}),
      }
      if (t.clone === null) {
        if (!Object.keys(edit).length) continue
        rctx.patch(
          'styles.xml',
          t.master.start,
          t.master.end,
          editMasterXml(source, this.info.prefixes, styleTag(t.master), edit),
        )
      } else {
        rctx.patch(
          'styles.xml',
          t.master.end,
          t.master.end,
          editMasterXml(source, this.info.prefixes, styleTag(t.master), edit),
        )
      }
    }

    // run starts
    for (const t of targets) {
      const masterName = t.clone ?? t.master.name
      for (const m of t.members) this.pointRun(m.run, masterName, m.state.pageNumber, m.mode)
    }
    // removed breaks: the run follows the previous one
    const continued = new Set(runs.map((r) => r.continues).filter((x) => x !== null))
    this.ext.runs.forEach((run, index) => {
      if (index === 0 || run.hidden || continued.has(index)) return
      if (run.startParagraph !== null) {
        const element = this.elementByParagraph.get(run.startParagraph)
        if (element === undefined || !rctx.matched.has(element)) return
        if (this.started.has(run.startParagraph)) return
        const change: StartChange = { paragraph: run.startParagraph, master: null }
        if (this.hasPageNumber(run.startStyle)) change.pageNumber = null
        this.applyStart(change, this.paragraphMode(run.startParagraph, true))
      } else if (run.startStyle !== null && run.startFamily !== null) {
        if (!this.patchStyleInPlace(run.startStyle, run.startFamily, { master: null }))
          rctx.warn(`the page style switch of style "${run.startStyle}" could not be removed`)
      }
    })
  }

  private hasPageNumber(style: string | null): boolean {
    if (style === null) return false
    return (
      this.styles.find(style, 'paragraph', 'content')?.properties['style:paragraph-properties']?.[
        'style:page-number'
      ] !== undefined
    )
  }

  // ---- run starts

  /** How a run's start paragraph can be re-pointed: in place (`a`), via the decorator (`b`), or not. */
  private startMode(r: EditedRun): 'a' | 'b' | null {
    if (r.continues !== null) {
      const run = this.ext.runs[r.continues]
      if (run.startParagraph !== null) {
        const element = this.elementByParagraph.get(run.startParagraph)
        if (element !== undefined && this.rctx.matched.has(element))
          return this.paragraphMode(run.startParagraph, true)
      } else if (run.startStyle !== null && run.startFamily !== null) {
        return this.exclusiveStart(run.startStyle, run.startFamily) ? 'a' : null
      }
    }
    const carrier = r.carrier?.element?.paragraph
    return carrier !== null && carrier !== undefined ? this.paragraphMode(carrier, false) : null
  }

  private paragraphMode(paragraph: number, existingStart: boolean): 'a' | 'b' | null {
    const record = this.rctx.map.paragraphs[paragraph]
    const element = this.elementByParagraph.get(paragraph)
    const item = element !== undefined ? this.itemByElement.get(element) : undefined
    if (!record || !item) return null
    const block = record.block !== null ? this.rctx.map.blocks[record.block] : undefined
    const textOwned =
      !!block &&
      block.owner === 'text' &&
      (block.kind === 'paragraph' || block.kind === 'heading') &&
      record.list === null
    if (
      existingStart &&
      record.styleName !== null &&
      (item.unchanged || block?.owner !== 'text') &&
      this.exclusiveStart(record.styleName, 'paragraph')
    )
      return 'a'
    if (textOwned && this.decorated && paragraphBlockOf(item.item)) return 'b'
    return null
  }

  /** The automatic style switches the master page and is used by one element only. */
  private exclusiveStart(name: string, family: 'paragraph' | 'table'): boolean {
    const style = this.styles.find(name, family, 'content')
    if (!style?.automatic || style.part !== 'content.xml' || !style.masterPageName) return false
    const attr = family === 'paragraph' ? 'text:style-name' : 'table:style-name'
    const raw = style.rawName ?? name
    this.body ??= this.content.xml.slice(
      this.rctx.doc.body.text.openEnd,
      this.rctx.doc.body.text.closeStart,
    )
    const body = this.body
    let count = 0
    for (const m of body.matchAll(new RegExp(`\\s${attr}="${escapeRegExp(raw)}"`, 'g'))) {
      if (m) count++
      if (count > 1) return false
    }
    return count === 1
  }

  private patchStyleInPlace(
    name: string,
    family: 'paragraph' | 'table',
    change: Pick<StartChange, 'master' | 'pageNumber'>,
  ): boolean {
    if (!this.exclusiveStart(name, family)) return false
    const style = this.styles.find(name, family, 'content') as OdtStyle
    const key = `${family}\u0000${name}`
    if (this.patchedStyles.has(key)) return false
    this.patchedStyles.add(key)
    const attrs: Record<string, string | null> = {}
    if (change.master !== undefined) attrs['style:master-page-name'] = change.master
    const path = family === 'paragraph' ? 'style:paragraph-properties' : 'style:table-properties'
    const props =
      change.pageNumber !== undefined
        ? { [path]: { 'style:page-number': change.pageNumber } }
        : undefined
    this.rctx.patch(
      'content.xml',
      style.start,
      style.end,
      editStyleXml(this.content.xml.slice(style.start, style.end), this.content.prefixes, {
        attrs,
        props,
      }),
    )
    return true
  }

  private pointRun(
    r: EditedRun,
    master: string,
    pageNumber: string | null | undefined,
    mode: 'a' | 'b' | null,
  ): void {
    const rctx = this.rctx
    const current = r.continues !== null ? this.ext.runs[r.continues] : null
    const change: Pick<StartChange, 'master' | 'pageNumber'> = {}
    if (pageNumber !== undefined) change.pageNumber = pageNumber
    if (current) {
      const startSurvives =
        current.startParagraph !== null &&
        rctx.matched.has(this.elementByParagraph.get(current.startParagraph) ?? -1)
      if (current.startParagraph !== null && startSurvives) {
        if (master !== current.master) change.master = master
        if (change.master === undefined && change.pageNumber === undefined) return
        this.applyStart({ paragraph: current.startParagraph, ...change }, mode)
        return
      }
      if (current.startParagraph === null && current.startStyle !== null && current.startFamily) {
        if (master !== current.master) change.master = master
        if (change.master === undefined && change.pageNumber === undefined) return
        if (!this.patchStyleInPlace(current.startStyle, current.startFamily, change))
          rctx.warn(`the page style of style "${current.startStyle}" could not be changed`)
        return
      }
      // implicit first run, or its start paragraph was deleted: the first element starts it
      const needed = master !== current.master || current.startParagraph !== null
      if (!needed && change.pageNumber === undefined) return
    }
    change.master = master
    const carrier = r.carrier?.element?.paragraph
    if (carrier === null || carrier === undefined) {
      rctx.warn('a section break before a table or object was not written')
      return
    }
    this.applyStart({ paragraph: carrier, ...change }, mode ?? this.paragraphMode(carrier, false))
  }

  private applyStart(change: StartChange, mode: 'a' | 'b' | null): void {
    const rctx = this.rctx
    this.started.add(change.paragraph)
    const record = rctx.map.paragraphs[change.paragraph]
    if (mode === 'a' && record.styleName !== null) {
      if (this.patchStyleInPlace(record.styleName, 'paragraph', change)) return
      mode = this.paragraphMode(change.paragraph, false)
    }
    if (mode !== 'b' || record.block === null) {
      rctx.warn('a page style switch could not be written for a section')
      return
    }
    const existing = this.plan.starts.get(record.block)
    this.plan.starts.set(record.block, { ...existing, ...change })
    const element = this.elementByParagraph.get(change.paragraph)
    const item = element !== undefined ? this.itemByElement.get(element) : undefined
    if (item && item.unchanged && !this.plan.forced.has(item.item.index)) {
      this.plan.forced.set(item.item.index, item.item.xml)
      item.item.xml += FORCE_MARK
    }
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
