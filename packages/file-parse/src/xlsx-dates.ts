import { callEngine } from './engine'

/** Which calendar parts a number format renders; null when it is not a date/time format. */
export interface DateFormatParts {
  date: boolean
  time: boolean
  seconds: boolean
  /** [h] / [mm] / [ss] elapsed-duration tokens, not clock time */
  elapsed: boolean
  /** which elapsed token leads the format; only meaningful when elapsed is true */
  elapsedUnit?: 'h' | 'm' | 's'
  /** false when a leading [h] has no minute token (bare [h] renders whole hours) */
  elapsedMinutes?: boolean
}

/**
 * The date/time parts of a built-in number format id (ECMA-376 §18.8.30 plus
 * the CJK 27-36 / 50-58 ranges Excel reserves); null for the numeric and text ones.
 */
export function builtinDateFormat(numFmtId: number): DateFormatParts | null {
  return callEngine<DateFormatParts | null>('builtinDateFormat', [numFmtId])
}

/** The date/time parts a custom format code renders; null when it is not a date/time format. */
export function classifyFormatCode(code: string): DateFormatParts | null {
  return callEngine<DateFormatParts | null>('classifyFormatCode', [code])
}

/**
 * Render an Excel serial in ISO-like text. 1900 system: serial 60 is the phantom
 * 1900-02-29 (Lotus compatibility) and 1–59 sit one day before the linear rule.
 * Returns null when the value cannot be a calendar value under this format.
 */
export function formatSerial(
  serial: number,
  parts: DateFormatParts,
  date1904: boolean,
): string | null {
  return callEngine<string | null>('formatSerial', [serial, parts, date1904])
}
