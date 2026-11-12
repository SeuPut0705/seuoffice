import type { Lang, Params } from '@genoffice/i18n'
import type { RecentPage } from '../../shared/home-api'
import type { StringKey } from './locale'

/** Sidebar counts use the same filtered total as the visible list. */
export function visiblePageCount(page: Pick<RecentPage, 'total'>): number {
  return page.total
}

const rulesCache = new Map<Lang, Intl.PluralRules>()

export function fileCountLabel(
  count: number,
  lang: Lang,
  t: (key: StringKey, params?: Params) => string,
): string {
  let rules = rulesCache.get(lang)
  if (!rules) {
    rules = new Intl.PluralRules(lang)
    rulesCache.set(lang, rules)
  }
  // English and Korean have no plural category beyond one and other
  return t(rules.select(count) === 'one' ? 'fileCountOne' : 'fileCount', { n: count })
}
