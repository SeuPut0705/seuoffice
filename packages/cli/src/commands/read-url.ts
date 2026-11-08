import { readUrlTool, type ReadUrlFailure } from '@genoffice/ai-search'
import { PRODUCT_NAME } from '@genoffice/i18n'
import type { ParsedArgs } from '../args'
import { aiSettingsPath, prepareCloud } from '../cloud'
import type { CommandDef } from '../registry'
import { CliError, EXIT } from '../result'

/** Download cap of the tool; a page over it is a download to attach. */
const MAX_BYTES = 10 * 1024 * 1024

/**
 * Read one http(s) page as text, on the automatic-call path like the search
 * command but with no provider: the tool fetches the address itself and the
 * only settings it reads are the read-only GitHub token. Long pages continue
 * with --offset.
 */
export const readUrlCommand: CommandDef = {
  name: 'read-url',
  summary:
    'Read the text of a web page: an article, a document, or a skill document on GitHub; long pages continue with --offset.',
  usage: 'read-url <url> [--offset <n>]',
  options: [
    {
      name: 'offset',
      value: 'n',
      description: 'start character (default 0; continue a long page)',
    },
  ],
  async run(args, ctx) {
    const url = args.positionals[0]?.trim() ?? ''
    if (!url) {
      throw new CliError(EXIT.usage, 'missing <url>', undefined, { reason: 'missing_argument' })
    }
    const offset = offsetOf(args)
    await prepareCloud(ctx.env)
    const settings = aiSettingsPath(ctx.env)
    const result = await readUrlTool(settings, url, offset)
    if (!result.ok) throw readUrlError(result)
    const end = result.offset + result.text.length
    const next = result.truncated ? ` (continue with --offset ${result.nextOffset})` : ' (end)'
    return {
      summary: `${hostOf(result.url)}: characters ${result.offset}..${end} of ${result.totalChars}${next}`,
      detail: {
        url: result.url,
        ...(result.title !== undefined ? { title: result.title } : {}),
        text: result.text,
        offset: result.offset,
        totalChars: result.totalChars,
        truncated: result.truncated,
        ...(result.nextOffset !== undefined ? { nextOffset: result.nextOffset } : {}),
      },
    }
  },
}

function offsetOf(args: ParsedArgs): number {
  const raw = args.flags.offset
  if (raw === undefined) return 0
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw))) {
    throw new CliError(
      EXIT.usage,
      `--offset must be a non-negative integer (got ${raw === true ? 'nothing' : raw})`,
      undefined,
      { reason: 'invalid_argument' },
    )
  }
  return Number(raw)
}

/** The host of the final address, as the human summary names the page. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Every failure of the tool as the envelope this command line promises: the
 * tool's own English sentence as the message, and a reason a program branches
 * on. A page that cannot be read as text is a usage failure (unsupported); a
 * fetch that failed, hit a limit or needs a token is exit 4, with the cause in
 * `detail.errorCode` like the other cloud commands.
 */
function readUrlError(failure: ReadUrlFailure): CliError {
  const code: string = failure.errorCode
  switch (code) {
    case 'invalid_url':
      return new CliError(EXIT.usage, failure.error, undefined, {
        reason: 'invalid_argument',
        suggestion: 'pass an http or https address',
      })
    case 'blocked':
      return new CliError(
        EXIT.usage,
        failure.error,
        { reason: 'blocked' },
        {
          reason: 'unsupported',
        },
      )
    case 'unsupported_type': {
      // today's tool does not report the type; its sentence already says to attach the file
      const extra = failure as ReadUrlFailure & {
        content_type?: unknown
        contentType?: unknown
      }
      const contentType =
        typeof extra.content_type === 'string'
          ? extra.content_type
          : typeof extra.contentType === 'string'
            ? extra.contentType
            : undefined
      return new CliError(
        EXIT.usage,
        failure.error,
        contentType !== undefined ? { content_type: contentType } : {},
        { reason: 'unsupported' },
      )
    }
    case 'empty':
      return new CliError(
        EXIT.usage,
        failure.error,
        { reason: 'no_text' },
        {
          reason: 'unsupported',
        },
      )
    case 'too_large':
      return new CliError(
        EXIT.app,
        failure.error,
        { max_bytes: MAX_BYTES },
        {
          reason: 'resource_limit',
        },
      )
    case 'network':
      return new CliError(
        EXIT.app,
        failure.error,
        { errorCode: 'network' },
        {
          reason: 'app_unavailable',
          suggestion: 'check the network connection (HTTPS_PROXY is honoured), then retry once',
        },
      )
    case 'timeout':
      return new CliError(
        EXIT.app,
        failure.error,
        { errorCode: 'timeout' },
        {
          reason: 'app_unavailable',
          suggestion: 'retry once; if it times out again, continue without it',
        },
      )
    case 'http_error': {
      const status = (failure as ReadUrlFailure & { status?: unknown }).status
      return new CliError(
        EXIT.app,
        failure.error,
        { errorCode: 'http_error', ...(typeof status === 'number' ? { status } : {}) },
        { reason: 'app_unavailable' },
      )
    }
    case 'auth':
      return new CliError(
        EXIT.app,
        failure.error,
        { errorCode: 'auth' },
        {
          reason: 'app_unavailable',
          suggestion: `check the GitHub token under Settings > AI in ${PRODUCT_NAME}, or use a public address`,
        },
      )
    default:
      return new CliError(
        EXIT.app,
        failure.error,
        { errorCode: code },
        {
          reason: 'app_unavailable',
        },
      )
  }
}
