import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'

/**
 * The update record (`update-log.txt` in the data folder): what the updater
 * did, line by line, so a report of "the update did not install" can come with
 * something to read. The installer runs after the app has quit and reports
 * nothing back, so the record is the only trace of what was started and how.
 *
 * electron-updater's own messages land here too (it is handed the logger).
 * They carry versions, release download addresses and the paths of the
 * downloaded installer and of the app; never document content. The file stays
 * on this PC and is kept under UPDATE_LOG_MAX_BYTES by dropping its older half.
 */

export const UPDATE_LOG_FILE = 'update-log.txt'
export const UPDATE_LOG_MAX_BYTES = 256 * 1024
/** a longer entry (a deep stack) is cut, so trimming never empties the file */
const LINE_MAX_CHARS = 4096

/** the shape electron-updater's `logger` takes */
export interface UpdateLogger {
  info(message?: unknown): void
  warn(message?: unknown): void
  error(message?: unknown): void
  debug(message: string): void
}

function text(message: unknown): string {
  if (message instanceof Error) return message.stack ?? message.message
  if (typeof message === 'string') return message
  try {
    return JSON.stringify(message) ?? String(message)
  } catch {
    return String(message)
  }
}

function trim(file: string, maxBytes: number): void {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return
  }
  if (size <= maxBytes) return
  const content = readFileSync(file, 'utf8')
  const keepFrom = content.length - Math.floor(content.length / 2)
  const lineStart = content.indexOf('\n', keepFrom)
  writeFileSync(file, lineStart === -1 ? '' : content.slice(lineStart + 1))
}

export function createUpdateLog(
  file: string,
  maxBytes: number = UPDATE_LOG_MAX_BYTES,
  now: () => Date = () => new Date(),
): UpdateLogger {
  const write = (level: string, message: unknown): void => {
    try {
      // one entry per line: a multi-line stack stays one entry
      const line = text(message).replace(/\r?\n/g, ' | ').slice(0, LINE_MAX_CHARS)
      appendFileSync(file, `${now().toISOString()} ${level} ${line}\n`)
      trim(file, maxBytes)
    } catch {
      /* a record that cannot be written never gets in the way of updating */
    }
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    debug: (message) => write('debug', message),
  }
}

/**
 * The steps of one update, from the check to the app's first start on the new
 * version. Each is written as its own `phase <step>` line, so the time between
 * any two steps reads off the timestamps and the slow one stands out. What the
 * installer does after the app has quit leaves no line of the app's; the next
 * start's `app-started` line carries the time since the installer or the Mac
 * swap was started (update-attempt.ts keeps that moment). The Mac swap script
 * writes its own `phase swap-start` and `phase relaunch` (mac-update.ts).
 */
export type UpdateStep =
  | 'check-start'
  | 'check-end'
  | 'download-start'
  | 'download-end'
  | 'unpack-start'
  | 'unpack-end'
  | 'verify-start'
  | 'verify-end'
  | 'quit-requested'
  | 'will-quit'
  | 'installer-start'
  | 'swap-scheduled'
  | 'app-started'

export type UpdateStepFields = Record<string, string | number | null | undefined>

/**
 * Writes update steps through `write`. An `*-end` step also gets `ms=`, the
 * milliseconds since its `*-start` (none when that start was not seen in this
 * process). Field values are single words: whitespace becomes `_`, and an
 * absent value is left out.
 */
export function createUpdateSteps(
  write: (line: string) => void,
  now: () => number = () => performance.now(),
): (step: UpdateStep, fields?: UpdateStepFields) => void {
  const startedAt = new Map<string, number>()
  return (step, fields = {}) => {
    const at = now()
    const span = step.replace(/-(start|end)$/, '')
    const parts = [`phase ${step}`]
    if (step.endsWith('-start')) startedAt.set(span, at)
    if (step.endsWith('-end')) {
      const start = startedAt.get(span)
      startedAt.delete(span)
      if (start !== undefined) parts.push(`ms=${Math.round(at - start)}`)
    }
    for (const [key, value] of Object.entries(fields)) {
      if (value === null || value === undefined) continue
      parts.push(`${key}=${String(value).replace(/\s+/g, '_')}`)
    }
    write(parts.join(' '))
  }
}
