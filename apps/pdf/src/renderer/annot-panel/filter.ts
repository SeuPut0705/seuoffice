/**
 * Filtering and sorting the annotation panel's items (reading-assist spec
 * 4.3): kind, color, page range, text search, and any extra dimension a later
 * feature adds as an `AnnotFacet`; page order (default) or creation order.
 * Pure.
 */
import type { TFunc } from '../i18n/locale'
import { KIND_ORDER, kindFilterLabel, type AnnotItem, type Rgb } from './items'

/**
 * An extra filter dimension (e.g. the category of accepted AI highlights):
 * the panel shows a choice of the values its items have.
 */
export interface AnnotFacet {
  id: string
  /** the choice's label in the UI language */
  label: string
  /** the item's value in this dimension; null = not part of it */
  valueOf: (item: AnnotItem) => string | null
  /** a value as shown; the value itself when absent */
  valueLabel?: (value: string) => string
}

export interface AnnotFilter {
  /** null = every kind */
  kind: string | null
  /** '#rrggbb'; null = every color */
  color: string | null
  /** 1-based shown page numbers, inclusive; null = open end */
  pageFrom: number | null
  pageTo: number | null
  query: string
  /** facet id → chosen value; a missing or '' value = all */
  facets: Readonly<Record<string, string>>
}

export type AnnotSort = 'page' | 'created'

export const EMPTY_FILTER: AnnotFilter = {
  kind: null,
  color: null,
  pageFrom: null,
  pageTo: null,
  query: '',
  facets: {},
}

const hex2 = (v: number) =>
  Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, '0')

/** an annotation color as '#rrggbb' */
export const colorKey = (c: Rgb): string => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`

const searchable = (i: AnnotItem): string =>
  [i.text, i.detail, i.memo, i.body, i.kindLabel, i.category, ...(i.replyTexts ?? [])]
    .filter(Boolean)
    .join('\n')
    .toLocaleLowerCase()

export function filterAnnotItems(
  items: readonly AnnotItem[],
  f: AnnotFilter,
  facets: readonly AnnotFacet[] = [],
): AnnotItem[] {
  const q = f.query.trim().toLocaleLowerCase()
  const rangeOn = f.pageFrom !== null || f.pageTo !== null
  return items.filter((i) => {
    if (f.kind !== null && i.kind !== f.kind) return false
    if (f.color !== null && (!i.color || colorKey(i.color) !== f.color)) return false
    if (rangeOn) {
      if (i.pageNo === null) return false
      if (f.pageFrom !== null && i.pageNo < f.pageFrom) return false
      if (f.pageTo !== null && i.pageNo > f.pageTo) return false
    }
    for (const facet of facets) {
      const want = f.facets[facet.id]
      if (want && facet.valueOf(i) !== want) return false
    }
    return q === '' || searchable(i).includes(q)
  })
}

const byPage = (a: AnnotItem, b: AnnotItem): number =>
  (a.pageNo ?? Infinity) - (b.pageNo ?? Infinity) ||
  a.pos[0] - b.pos[0] ||
  a.pos[1] - b.pos[1] ||
  a.seq - b.seq

/** unknown times: in the file first (older than anything made now), unsaved last */
const createdKey = (i: AnnotItem): number =>
  i.createdMs ?? (i.origin === 'unsaved' ? Infinity : -Infinity)

const byCreated = (a: AnnotItem, b: AnnotItem): number => {
  const ka = createdKey(a)
  const kb = createdKey(b)
  if (ka !== kb) return ka < kb ? -1 : 1
  return a.seq - b.seq
}

export function sortAnnotItems(items: readonly AnnotItem[], sort: AnnotSort): AnnotItem[] {
  return [...items].sort(sort === 'created' ? byCreated : byPage)
}

/** the kinds present, in the filter's order */
export function kindOptions(
  items: readonly AnnotItem[],
  t: TFunc,
): { kind: string; label: string }[] {
  const seen = new Map<string, string>()
  for (const i of items) if (!seen.has(i.kind)) seen.set(i.kind, i.kindLabel)
  const rank = (k: string) => {
    const r = KIND_ORDER.indexOf(k)
    return r < 0 ? KIND_ORDER.length : r
  }
  return [...seen.keys()]
    .map((kind, order) => ({ kind, order }))
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.order - b.order)
    .map(({ kind }) => ({ kind, label: kindFilterLabel(kind, t, seen.get(kind) ?? kind) }))
}

/** the annotation colors present, in first-seen order */
export function colorOptions(items: readonly AnnotItem[]): { hex: string; color: Rgb }[] {
  const seen = new Map<string, Rgb>()
  for (const i of items)
    if (i.color && !seen.has(colorKey(i.color))) seen.set(colorKey(i.color), i.color)
  return [...seen].map(([hex, color]) => ({ hex, color }))
}

/** the values a facet's items have, in first-seen order */
export function facetOptions(items: readonly AnnotItem[], facet: AnnotFacet): string[] {
  const seen = new Set<string>()
  for (const i of items) {
    const v = facet.valueOf(i)
    if (v) seen.add(v)
  }
  return [...seen]
}
