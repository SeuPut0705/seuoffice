/**
 * Words for a document job's state that every job kind shares: why a job
 * stopped when the connection is the cause (worded once for every editor by
 * `aiRunErrorText`, with the reset time of a rate limit), and the percentage
 * of the resume offer.
 */
import type { AiProviderId, AiRunErrorKind } from '@genoffice/ai-provider/browser'
import type { Lang } from '@genoffice/i18n'
import { aiRunErrorText } from '@genoffice/ui'
import type { JobSummary } from '../../../../../packages/pdf-structure/src/jobs'
import type { JobProgress } from '../../../../../packages/pdf-structure/src/store/store'
import type { TFunc } from '../i18n/locale'

/**
 * The connection-side reason a job stopped ('rate-limit' with its reset time,
 * 'signed-out', …), or null when the reason is the job's own ('cancelled',
 * 'failures', 'store-write-failed', …) and the caller words it.
 */
export function jobStopConnectionText(
  lang: Lang,
  t: TFunc,
  summary: Pick<JobSummary<unknown>, 'stopReason' | 'resetsAt'>,
  provider: string,
): string | null {
  const kind = summary.stopReason
  if (!kind) return null
  if (kind === 'credits') return t('aiCreditsExhausted')
  return (
    aiRunErrorText(lang, {
      kind: kind as AiRunErrorKind,
      provider: provider as AiProviderId,
      ...(summary.resetsAt !== undefined ? { resetsAt: summary.resetsAt } : {}),
    }) ?? null
  )
}

/** whole percent done, 0 when nothing is known */
export function jobPercent(progress: JobProgress | undefined): number {
  if (!progress || progress.total <= 0) return 0
  return Math.max(0, Math.min(100, Math.floor((progress.done / progress.total) * 100)))
}

/** "3, 7, 9" from page numbers */
export const pageList = (pages: Iterable<number>): string =>
  [...new Set(pages)].sort((a, b) => a - b).join(', ')
