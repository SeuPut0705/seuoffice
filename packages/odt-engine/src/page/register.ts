/**
 * What the page layer registers:
 *
 * - a decorator of the text layer's block converter (same id `text`, so the
 *   map and every `blockById('text')` lookup are unchanged). It converts
 *   exactly what the text converter would, and on save points the first
 *   paragraph of a page run at another master page (a cloned one, or the
 *   previous run's when a section break was removed) by giving it a derived
 *   style with the new `style:master-page-name` / `style:page-number`. It
 *   only takes nodes the text converter would get: converters registered
 *   before it (tables, objects) keep theirs.
 * - an inline converter for page number / page count fields in headers and
 *   footers (they show as Word PAGE / NUMPAGES fields), and the run writer
 *   that writes them back.
 */
import type {
  AlignedItem,
  BlockConverter,
  BridgeBlock,
  ConversionRegistry,
  FlowEnv,
  InlineConverter,
  OoxmlToOdfContext,
} from '../core/convert'
import { PAGE_MARK, TOTAL_PAGES_MARK } from '@genoffice/docx-engine'
import { decodeXmlEntities } from '../core/xml'
import { editStyleXml, newStyleXml, patchStartTag } from '../text/style-xml'
import { pageFieldRunWriter } from './hf'
import { PAGE_OWNER } from './model'

/** A page-run start the decorator writes on save. */
export interface StartChange {
  /** bridge paragraph record of the paragraph that starts the run */
  paragraph: number
  /** new `style:master-page-name` (null: none); undefined keeps it */
  master?: string | null
  /** new `style:page-number` (null: none); undefined keeps it */
  pageNumber?: string | null
}

export interface PagePlan {
  /** bridge block id → start change */
  starts: Map<number, StartChange>
  /** edited item index → its XML before it was marked to reach the decorator */
  forced: Map<number, string>
}

const plans = new WeakMap<OoxmlToOdfContext, PagePlan>()

export function planOf(rctx: OoxmlToOdfContext): PagePlan {
  let plan = plans.get(rctx)
  if (!plan) plans.set(rctx, (plan = { starts: new Map(), forced: new Map() }))
  return plan
}

/** Appended to an unchanged item's XML so the flow hands its block to the decorator. */
export const FORCE_MARK = '<!--odt-page-->'

/**
 * The automatic style a page-run start paragraph gets: a copy of `current`
 * (the style the paragraph is written with) with the new master page and
 * page number. Shared between paragraphs with the same change.
 */
export function startStyle(
  rctx: OoxmlToOdfContext,
  current: string | null,
  change: Pick<StartChange, 'master' | 'pageNumber'>,
): string {
  const info = rctx.part('content.xml')
  const attrs: Record<string, string | null> = { 'style:display-name': null }
  if (change.master !== undefined) attrs['style:master-page-name'] = change.master
  const props =
    change.pageNumber !== undefined
      ? { 'style:paragraph-properties': { 'style:page-number': change.pageNumber } }
      : undefined
  const key = JSON.stringify(['page-start', current, change.master, change.pageNumber])
  return rctx.derivedStyle('content.xml', key, current ?? 'P', (name) => {
    const existing = current !== null ? rctx.doc.styles.find(current, 'paragraph', 'content') : null
    let base: string
    if (existing?.automatic && existing.part === 'content.xml')
      base = info.xml.slice(existing.start, existing.end)
    else {
      const queued =
        current !== null
          ? rctx
              .newAutomaticStyles('content.xml')
              .find((x) =>
                new RegExp(`^<[^>]*\\sstyle:name="${escapeRegExp(escapeAttr(current))}"`).test(x),
              )
          : undefined
      base =
        queued ??
        newStyleXml(name, 'paragraph', current ?? rctx.map.styles.baseParagraphStyle ?? null)
    }
    return editStyleXml(base, info.prefixes, { name, attrs, props })
  })
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Re-styles the first paragraph start tag of `odf` with the run start change. */
function restyleFirstParagraph(rctx: OoxmlToOdfContext, odf: string, change: StartChange): string {
  const m = /<(text:p|text:h)(?=[\s/>])[^>]*>/.exec(odf)
  if (!m) return odf
  const prefixes = rctx.part('content.xml').prefixes
  const raw = /\stext:style-name="([^"]*)"/.exec(m[0])?.[1]
  const current = raw === undefined ? null : decodeXmlEntities(raw)
  const name = startStyle(rctx, current, change)
  const tag = patchStartTag(m[0], prefixes, { 'text:style-name': name })
  return odf.slice(0, m.index) + tag + odf.slice(m.index + m[0].length)
}

const decorators = new WeakSet<BlockConverter>()

/** The registry carries the page layer's decorator of the text converter. */
export const hasPageDecorator = (registry: ConversionRegistry): boolean =>
  registry.blocks.some((b) => decorators.has(b))

function decorate(inner: BlockConverter, registry: ConversionRegistry): BlockConverter {
  const decorator: BlockConverter = {
    id: inner.id,
    match(node, ctx) {
      const own = registry.blocks.indexOf(decorator)
      for (let i = own - 1; i >= 0; i--) {
        if (registry.blocks[i].match(node, ctx)) return registry.blocks[i] === inner
      }
      return false
    },
    toOoxml: (ctx, node, env) => inner.toOoxml(ctx, node, env),
    toOdf(rctx, block, items, env) {
      const plan = plans.get(rctx)
      const restored = plan ? items.map((a) => restore(plan, a)) : items
      const change = plan?.starts.get(block.id)
      if (!change) return inner.toOdf(rctx, block, restored, env)
      return writeStart(rctx, inner, block, restored, env, change)
    },
    ...(inner.absorbs
      ? { absorbs: (rctx, block, item) => inner.absorbs?.(rctx, block, item) ?? false }
      : {}),
    ...(inner.identify
      ? { identify: (rctx, item, candidates) => inner.identify?.(rctx, item, candidates) ?? null }
      : {}),
  }
  decorators.add(decorator)
  return decorator
}

/** An item marked only to reach the decorator, back to what it really is. */
function restore(plan: PagePlan, a: AlignedItem): AlignedItem {
  const xml = plan.forced.get(a.item.index)
  if (xml === undefined) return a
  return {
    item: { ...a.item, xml },
    element: a.element,
    unchanged: a.element !== null && a.element.xml === xml,
  }
}

function writeStart(
  rctx: OoxmlToOdfContext,
  inner: BlockConverter,
  block: BridgeBlock,
  items: AlignedItem[],
  env: FlowEnv,
  change: StartChange,
): string {
  const k = items.findIndex((a) => a.element?.paragraph === change.paragraph)
  if (k < 0) {
    rctx.warn('a page start paragraph was not found; its page style was kept')
    return inner.toOdf(rctx, block, items, env)
  }
  const before = items.slice(0, k)
  const out = before.length ? inner.toOdf(rctx, block, before, env) : ''
  const start = items[k]
  if (start.unchanged) {
    const record = rctx.map.paragraphs[change.paragraph]
    const source = rctx.part('content.xml').xml.slice(record.start, record.end)
    const rest = items.slice(k + 1)
    const after = rest.length
      ? inner.toOdf(rctx, block, rest, {
          ...env,
          neighbours: { before: start.element, after: env.neighbours?.after ?? null },
        })
      : ''
    return out + restyleFirstParagraph(rctx, source, change) + after
  }
  return out + restyleFirstParagraph(rctx, inner.toOdf(rctx, block, items.slice(k), env), change)
}

/** Header/footer page fields shown as Word fields. */
const pageFieldConverter: InlineConverter = {
  id: PAGE_OWNER,
  names: ['text:page-number', 'text:page-count'],
  toOoxml(_ctx, el) {
    if (el.part !== 'styles.xml') return null
    const page = el.name === 'text:page-number'
    return {
      kind: 'xml',
      xml: `<w:fldSimple w:instr=" ${page ? 'PAGE' : 'NUMPAGES'} "><w:r><w:t>1</w:t></w:r></w:fldSimple>`,
      text: page ? PAGE_MARK : TOTAL_PAGES_MARK,
    }
  },
}

/**
 * Registers the page layer. Call after `registerTextConverters` (it decorates
 * the text converter registered at that time); converters registered later
 * are unaffected.
 */
export function registerPageConverters(registry: ConversionRegistry): ConversionRegistry {
  const text = registry.blockById('text')
  if (text) registry.addBlock(decorate(text, registry))
  registry.addInline(pageFieldConverter)
  registry.addRunWriter(pageFieldRunWriter)
  return registry
}
