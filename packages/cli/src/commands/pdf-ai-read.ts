/**
 * `pdf ai-read <file.pdf> --pages <list> [--yes] [--allow-paid] [--password]`
 * (spec §7, §10): the chosen pages' images go to the AI provider, one page
 * per request, and the readings land in the result store the app shares.
 * Pages already read are skipped. Without --yes nothing is sent.
 */
import { basename } from 'node:path'
import {
  createAiReadCallModel,
  planAiReadJob,
  startAiReadJob,
  type AiReadJobUnit,
  type AiReadPageRef,
  type JobSummary,
} from '../../../pdf-structure/src'
import { flagBool, flagString, type ParsedArgs } from '../args'
import {
  AI_READ_RENDER_SCALE,
  documentHash,
  pageFingerprints,
  parsePageList,
  validatePageList,
  pdfFacts,
  renderPdfPage,
  resultStore,
} from '../formats/pdf-structure'
import { readInput } from '../fs'
import { askPdfModel } from '../pdf-ai'
import { trackBackgroundJob } from '../pdf-jobs'
import type { CommandContext } from '../registry'
import { CliError, EXIT, type CommandResult } from '../result'
import {
  assertNoRunningJob,
  assertPaidAllowed,
  estimateOf,
  pdfJobRoute,
  stopOnSignals,
  stoppedError,
} from './pdf-job'

const pagesOfUnits = (units: readonly AiReadJobUnit[]): number[] =>
  units.flatMap((u) => u.pages.map((p) => p.page)).sort((a, b) => a - b)

export async function pdfAiRead(
  path: string,
  args: ParsedArgs,
  ctx: CommandContext,
): Promise<CommandResult> {
  const spec = flagString(args, 'pages')
  if (spec === undefined) {
    throw new CliError(EXIT.usage, 'missing --pages <list>', undefined, {
      reason: 'missing_argument',
      suggestion: 'name the pages to read, for example --pages 1-5,8',
    })
  }
  validatePageList(spec)
  const password = flagString(args, 'password')
  const bytes = readInput(path)
  const facts = await pdfFacts(bytes, password)
  const pages = parsePageList(spec, facts.pages)
  const fingerprints = await pageFingerprints(bytes, password, pages)
  const refs: AiReadPageRef[] = pages.map((page, i) => ({
    page,
    pageFingerprint: fingerprints[i]!,
  }))
  const docHash = documentHash(bytes)
  const store = resultStore(ctx.env)

  // a model that cannot read images is refused here, before anything is sent
  const route = await pdfJobRoute(ctx.env, 'ai-read')
  const model = { provider: route.provider, model: route.model }
  const plan = await planAiReadJob({ docHash, pages: refs, model, store })
  const queued = new Set(pagesOfUnits(plan.units))
  const skipped = pages.filter((p) => !queued.has(p)).sort((a, b) => a - b)
  const estimate = estimateOf(route, plan.estimate.calls, queued.size)
  const name = basename(path)

  if (!flagBool(args, 'yes')) {
    return {
      summary: `${name}: ${estimate.calls} page request(s) to ${route.provider} (${route.route}${route.paid ? ', billed per request' : ''}); nothing sent without --yes`,
      detail: { started: false, estimate, pages_skipped: skipped },
    }
  }
  assertPaidAllowed(route, flagBool(args, 'allow-paid'))
  await assertNoRunningJob(store, docHash)

  const handle = startAiReadJob({
    docHash,
    pages: refs,
    model,
    store,
    callModel: createAiReadCallModel<AiReadPageRef>({
      renderPage: (page) => renderPdfPage(bytes, password, page.page, AI_READ_RENDER_SCALE),
      ask: (request, signal) => askPdfModel(route, request, signal),
    }),
    onProgress: (e) => {
      if (!ctx.background) {
        const at = e.current ? `, page ${e.current.pages[0]?.page}` : ''
        ctx.log(`ai-read ${e.done}/${e.total}${at}`)
      }
    },
  })

  const answer = (summary: JobSummary<AiReadJobUnit>): CommandResult => {
    const read = pagesOfUnits(summary.doneUnits)
    const failed = summary.failedUnits
      .flatMap((f) => f.unit.pages.map((p) => ({ page: p.page, reason: f.reason })))
      .sort((a, b) => a.page - b.page)
    if (summary.state === 'stopped') {
      throw stoppedError('AI page reading', summary, {
        pages_read: read,
        pages_failed: failed,
        done_pages: summary.progress.done,
        total_pages: summary.progress.total,
      })
    }
    if (summary.lostUnits.length) {
      ctx.warn({
        code: 'results_lost',
        message: `the readings of page(s) ${pagesOfUnits(summary.lostUnits).join(', ')} could not be stored`,
        suggestion: 'run the same command again for those pages',
      })
    }
    return {
      summary: `${name}: read ${read.length} page(s), ${skipped.length} already read, ${failed.length} failed`,
      detail: {
        pages_read: read,
        pages_skipped: skipped,
        pages_failed: failed,
        provider: route.provider,
        model: route.model,
      },
    }
  }

  if (ctx.background) {
    trackBackgroundJob({ handle, finished: handle.result })
    return {
      summary: `${name}: AI page reading started (${estimate.calls} request(s)); pdf_status reports its progress`,
      detail: { started: true, estimate, pages_skipped: skipped },
    }
  }
  const release = stopOnSignals(() => handle.cancel('interrupted'))
  try {
    return answer(await handle.result)
  } finally {
    release()
  }
}
