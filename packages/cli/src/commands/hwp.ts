import { copyFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { flagBool } from '../args'
import { BATCH_OPTIONS, batchCounts, batchMode, batchResult, failedBatch } from '../batch'
import { HWP_PREVIEW_CHARS, hwpText } from '../formats/hwp'
import type { HwpEditSession } from '../formats/hwp-edit'
import { extension, readInput, resolveInput, resolveOutput, writeOutput } from '../fs'
import { readOpsInput } from '../ops-input'
import { cutIndex, previewChars } from '../preview'
import type { CommandContext, CommandDef } from '../registry'
import { CliError, EXIT, type CommandResult } from '../result'

export const hwpCommand: CommandDef = {
  name: 'hwp',
  summary:
    'Read or edit a Hangul (HWP / HWPX) document with the ops the in-app AI uses, without any app process (written back in its own format).',
  usage:
    'hwp read <file.hwp|file.hwpx> [--offset n] [--full | --max-chars n] | hwp apply <file.hwp|file.hwpx> --ops <file|-> [--out path] [--force]',
  options: [
    {
      name: 'offset',
      value: 'n',
      description: 'read: start character (default 0)',
    },
    {
      name: 'full',
      description: 'read: the whole text, unclipped',
    },
    {
      name: 'max-chars',
      value: 'n',
      description: `read: characters to return (default ${HWP_PREVIEW_CHARS})`,
    },
    {
      name: 'ops',
      value: 'file',
      description:
        'apply: JSON array of ops, each { "op": "<name>", ...fields } (replace_text, insert_paragraphs, insert_table, fill_cells, format_text, fill_field, insert_note ...); "-" reads stdin. See `ieumoffice guide hwp`.',
    },
    {
      name: 'dry-run',
      description: 'apply: run the batch in memory and report each step without writing',
    },
    ...BATCH_OPTIONS,
    {
      name: 'out',
      value: 'path',
      description:
        'apply: write here instead of in place (.hwp or .hwpx; the extension picks the format)',
    },
    {
      name: 'force',
      description:
        'apply: overwrite an existing --out file, or write while GenOffice has the file open',
    },
  ],
  async run(args, ctx) {
    const [verb, file] = args.positionals
    if (verb === 'read') return read(file, args, ctx)
    if (verb === 'apply') return apply(file, args, ctx)
    throw new CliError(
      EXIT.usage,
      'expected "hwp read <file.hwp|file.hwpx>" or "hwp apply <file.hwp|file.hwpx> --ops <file|->"',
      undefined,
      {
        reason: verb === undefined ? 'missing_argument' : 'invalid_argument',
        suggestion: 'run `ieumoffice help hwp`',
      },
    )
  },
}

type Args = Parameters<CommandDef['run']>[0]

function hwpInput(
  file: string | undefined,
  ctx: CommandContext,
): { path: string; ext: 'hwp' | 'hwpx' } {
  const path = resolveInput(file, ctx)
  const ext = extension(path)
  if (ext !== 'hwp' && ext !== 'hwpx') {
    throw new CliError(EXIT.usage, `not an HWP or HWPX document: ${path}`, undefined, {
      reason: 'unsupported',
      suggestion: 'use docs read, sheet read, slides read or pdf read for other formats',
    })
  }
  return { path, ext }
}

async function read(
  file: string | undefined,
  args: Args,
  ctx: CommandContext,
): Promise<CommandResult> {
  const { path, ext } = hwpInput(file, ctx)
  const offset = parseOffset(args.flags.offset)
  const max = previewChars(args, HWP_PREVIEW_CHARS)
  let text: string
  try {
    text = await hwpText(readInput(path))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new CliError(EXIT.file, message, undefined, { reason: 'unsupported' })
  }
  if (offset > text.length) {
    throw new CliError(
      EXIT.usage,
      `--offset ${offset} is past the end of the text (${text.length} characters)`,
      { valid_range: [0, text.length] },
      { reason: 'out_of_range' },
    )
  }
  const high = text.charCodeAt(offset - 1)
  const low = text.charCodeAt(offset)
  if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
    throw new CliError(EXIT.usage, `--offset ${offset} splits a Unicode character`, undefined, {
      reason: 'invalid_argument',
      suggestion: `use --offset ${offset - 1} or --offset ${offset + 1}`,
    })
  }
  const end = Math.min(text.length, cutIndex(text, offset, offset + max))
  const detail: Record<string, unknown> = {
    format: ext,
    chars: text.length,
    offset,
    text: text.slice(offset, end),
  }
  if (end < text.length) {
    detail.truncated = `characters ${end}-${text.length} not read; pass --offset ${end} for the next part, or --full for everything`
    detail.next_offset = end
  }
  const part = offset > 0 || end < text.length ? `, read ${offset}-${end}` : ''
  return { summary: `${basename(path)}: ${text.length} characters${part}`, detail }
}

function parseOffset(raw: string | true | undefined): number {
  if (raw === undefined) return 0
  const n = typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isInteger(n) || n < 0) {
    throw new CliError(
      EXIT.usage,
      `--offset must be a non-negative integer (got ${raw})`,
      undefined,
      {
        reason: 'invalid_argument',
      },
    )
  }
  return n
}

/** The ops of `--ops`: a JSON array, or `{ "ops": [...] }`. */
export function hwpOpsOf(args: Args, ctx: CommandContext): unknown[] {
  const { text, source } = readOpsInput(args, ctx)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new CliError(
      EXIT.usage,
      `${source}: not valid JSON (${(err as Error).message})`,
      undefined,
      { reason: 'invalid_json' },
    )
  }
  const ops = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { ops?: unknown }).ops)
      ? (parsed as { ops: unknown[] }).ops
      : null
  if (!ops?.length) {
    throw new CliError(EXIT.usage, `${source}: expected a non-empty array of ops`, undefined, {
      reason: 'invalid_argument',
      suggestion: 'run `ieumoffice guide hwp` for the ops',
    })
  }
  return ops
}

/** `hwp` or `hwpx` for an output path; anything else is refused before any work. */
export function hwpOutputFormat(path: string): 'hwp' | 'hwpx' {
  const ext = extension(path)
  if (ext !== 'hwp' && ext !== 'hwpx') {
    throw new CliError(EXIT.usage, `--out must end in .hwp or .hwpx: ${path}`, undefined, {
      reason: 'invalid_argument',
      suggestion: 'name the output <name>.hwp or <name>.hwpx',
    })
  }
  return ext
}

/**
 * Run a batch on an open document and write it. A file that is overwritten keeps the bytes
 * it held beside it as `<name>.bak` first, as the app's first save of a file does.
 */
export async function runHwpBatch(
  session: HwpEditSession,
  ops: unknown[],
  args: Args,
  /** `input`: the file the document was opened from (none for a new document) */
  target: { output: string; format: 'hwp' | 'hwpx'; input?: string },
): Promise<CommandResult> {
  const { applyHwpOps, saveHwpSession, hwpBackupPath } = await import('../formats/hwp-edit')
  const mode = batchMode(args)
  let outcome
  try {
    outcome = await applyHwpOps(session, ops, mode)
  } catch (err) {
    throw err instanceof CliError ? failedBatch(err, ops.length) : err
  }
  const { results, failures } = outcome
  const counts = batchCounts(ops.length, results.length, failures.length)
  if (!results.length) {
    const first = failures[0]!
    throw new CliError(
      EXIT.usage,
      `no ops were applied: op ${first.index} (${first.op}) rejected: ${first.error}`,
      { failures, batch: counts },
      { reason: first.reason, suggestion: 'run `ieumoffice guide hwp` for the ops' },
    )
  }
  if (flagBool(args, 'dry-run')) {
    return batchResult(
      {
        summary: `dry run: ${results.length} of ${ops.length} ops validated, nothing written`,
        detail: { results },
      },
      counts,
      failures,
    )
  }
  // a batch of reads (list_tables, read_table ...) leaves an existing file as it was: no
  // rewrite, no .bak. A new document is written all the same.
  const changed = results.some((r) => r.changed)
  if (!changed && target.output === target.input) {
    return batchResult(
      {
        summary: `${results.length} of ${ops.length} ops read the document; nothing changed, nothing written`,
        detail: { results },
      },
      counts,
      failures,
    )
  }
  // A same-format copy of a read-only batch needs no reserialization.
  const original = !changed && target.input ? readInput(target.input) : undefined
  const copy =
    original && session.mods.savePlan.bytesMatchFormat(original, target.format)
      ? original
      : undefined
  const saved = copy
    ? { bytes: copy, tailsLost: false, memosLost: 0 }
    : await saveHwpSession(session, target.format)
  let backupPath: string | undefined
  if (existsSync(target.output)) {
    backupPath = hwpBackupPath(target.output)
    copyFileSync(target.output, backupPath)
  }
  writeOutput(target.output, saved.bytes)
  const warnings: string[] = []
  if (session.trackingDropped && !copy) {
    warnings.push(
      'the document held tracked changes: it was edited and written as it reads now, without them',
    )
  }
  if (saved.tailsLost) {
    warnings.push(
      'master pages or memos of the original could not be carried over; open the file in Hangul to check',
    )
  }
  if (saved.memosLost > 0) {
    warnings.push(`${saved.memosLost} memo(s) of the document were not written`)
  }
  return batchResult(
    {
      summary: `applied ${results.length} of ${ops.length} ops to ${basename(target.output)}`,
      outputPath: target.output,
      detail: {
        format: target.format,
        results,
        ...(backupPath ? { backup_path: backupPath } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
    },
    counts,
    failures,
  )
}

async function apply(
  file: string | undefined,
  args: Args,
  ctx: CommandContext,
): Promise<CommandResult> {
  const { path } = hwpInput(file, ctx)
  const out = args.flags.out
  if (out === true) {
    throw new CliError(EXIT.usage, 'missing --out <path>', undefined, {
      reason: 'missing_argument',
    })
  }
  const ops = hwpOpsOf(args, ctx)
  const output = resolveOutput(out, ctx, {
    fallback: path,
    force: flagBool(args, 'force'),
    // in-place edits overwrite by design; --out onto another existing file needs --force
    fresh: out !== undefined,
  })
  const format = hwpOutputFormat(output)
  const { openHwpForEdit, closeHwpSession } = await import('../formats/hwp-edit')
  const session = await openHwpForEdit(readInput(path))
  try {
    return await runHwpBatch(session, ops, args, { output, format, input: path })
  } finally {
    closeHwpSession(session)
  }
}
