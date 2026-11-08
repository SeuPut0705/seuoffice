import { htmlLang, type Lang } from '@genoffice/i18n'

/** a file size in the UI language: KB under 1 MB, MB above */
export function formatBytes(bytes: number, lang: Lang): string {
  const locale = htmlLang(lang)
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'megabyte',
      maximumFractionDigits: 1,
    }).format(mb)
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'kilobyte',
    maximumFractionDigits: bytes < 10 * 1024 ? 1 : 0,
  }).format(Math.max(bytes / 1024, bytes > 0 ? 0.1 : 0))
}
