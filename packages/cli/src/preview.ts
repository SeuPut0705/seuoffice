import { flagBool, type ParsedArgs } from './args'
import { CliError, EXIT } from './result'

/**
 * Where a cut at `end` (a UTF-16 index) can actually fall: never between the two halves of a
 * surrogate pair (an emoji, a rare Hanja), which would leave a lone surrogate in the output.
 * Backs off one unit, or steps over the pair when the window is a single unit wide.
 */
export function cutIndex(text: string, start: number, end: number): number {
  if (end <= 0 || end >= text.length) return end
  const high = text.charCodeAt(end - 1)
  const low = text.charCodeAt(end)
  if (high < 0xd800 || high > 0xdbff || low < 0xdc00 || low > 0xdfff) return end
  return end - 1 > start ? end - 1 : end + 1
}

/** Clip to `max` characters; the marker names how much is missing so a reader can decide whether to fetch it. */
export function clipText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  const end = cutIndex(text, 0, max)
  return { text: `${text.slice(0, end)}…(+${text.length - end} chars)`, truncated: true }
}

/** `--full` lifts the cap, `--max-chars n` moves it. */
export function previewChars(args: ParsedArgs, fallback: number): number {
  if (flagBool(args, 'full')) return Infinity
  const raw = args.flags['max-chars']
  if (raw === undefined) return fallback
  const n = typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isInteger(n) || n < 1 || n > MAX_PREVIEW_CHARS)
    throw new CliError(
      EXIT.usage,
      `--max-chars must be a positive integer up to ${MAX_PREVIEW_CHARS} (got ${raw}); use --full for uncapped output`,
      undefined,
      {
        reason: 'invalid_argument',
      },
    )
  return n
}

/**
 * Upper bound for --max-chars: the flag exists to keep previews small, and an
 * unbounded value defeats it (agents dumping whole documents into context).
 * --full remains the escape hatch for legitimately uncapped output.
 */
export const MAX_PREVIEW_CHARS = 1_000_000
