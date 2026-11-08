/**
 * What the conversion screens say about a structure job's answer: one
 * localized line per failure code, and the conversion warnings grouped by kind
 * (the job's own `message` is English for logs and never shown alone).
 */
import type { PdfStructureConvertResult, PdfStructureFailure } from '../../shared/ipc'
import type { TFunc } from '../i18n/locale'

export type ConvertWarning = PdfStructureConvertResult['warnings'][number]

/** The text for a failed job; 'password-required' and 'cancelled' are handled by the caller */
export function structureFailureText(failure: PdfStructureFailure, t: TFunc): string {
  switch (failure.error) {
    case 'page-range':
      return failure.validRange ? t('cvPagesOutOfRange', failure.validRange) : t('cvPagesSyntax')
    case 'asset-conflict':
      return t('cvErrAssetConflict')
    case 'corrupt':
      return t('cvErrCorrupt')
    case 'unsupported':
      return t('cvErrUnsupported')
    case 'busy':
      return t('cvErrBusy')
    case 'not-available':
      return t('cvErrNotAvailable')
    case 'process-exited':
      return t('cvErrProcessExited')
    case 'store-write-failed':
      return t('cvErrStoreWrite')
    case 'not-granted':
    case 'invalid-target':
      return t('cvErrTarget')
    case 'cancelled':
      return t('cvCancelled')
    case 'password-required':
      return t('pwWrong')
    default:
      return t('cvErrFailed')
  }
}

/** pages listed once each, ascending */
const pageList = (pages: number[]): string => [...new Set(pages)].sort((a, b) => a - b).join(', ')

/** One line per warning kind, in a fixed order; the scanned-page hint follows the page list */
export function conversionWarningLines(warnings: readonly ConvertWarning[], t: TFunc): string[] {
  const pagesOf = (kind: ConvertWarning['kind']): number[] =>
    warnings.flatMap((w) => (w.kind === kind && 'page' in w ? [w.page] : []))
  const lines: string[] = []
  const allAsImages = warnings.some((w) => w.kind === 'allPagesAsImages')
  if (allAsImages) {
    lines.push(t('cvWarnAllPagesAsImages'))
  } else {
    const asImage = pagesOf('pageAsImage')
    if (asImage.length > 0) {
      lines.push(t('cvWarnPageAsImage', { pages: pageList(asImage) }))
      const scanned = warnings.some((w) => w.kind === 'pageAsImage' && w.reason === 'scanned')
      if (scanned) lines.push(t('cvWarnScannedHint'))
    }
  }
  const byKind = [
    ['figureWithoutImage', 'cvWarnFigureWithoutImage'],
    ['formulaAsCode', 'cvWarnFormulaAsCode'],
    ['footnoteMissing', 'cvWarnFootnoteMissing'],
    ['footnoteUnreferenced', 'cvWarnFootnoteUnreferenced'],
    ['footnoteLinkFailed', 'cvWarnFootnoteLinkFailed'],
  ] as const
  for (const [kind, key] of byKind) {
    const pages = pagesOf(kind)
    if (pages.length > 0) lines.push(t(key, { pages: pageList(pages) }))
  }
  return lines
}
