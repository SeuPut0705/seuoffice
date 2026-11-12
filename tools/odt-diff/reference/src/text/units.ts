/**
 * ODF length strings ↔ OOXML twips / half-points.
 */

const TWIPS_PER_UNIT: Record<string, number> = {
  cm: 1440 / 2.54,
  mm: 1440 / 25.4,
  in: 1440,
  inch: 1440,
  pt: 20,
  pc: 240,
  px: 15,
}

/** An ODF length (`0.529cm`, `12pt`) in twips (unrounded); undefined when not a length. */
export function lengthToTwips(value: string | undefined | null): number | undefined {
  if (value === undefined || value === null) return undefined
  const m = /^\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*(cm|mm|inch|in|pt|pc|px)\s*$/.exec(value)
  if (!m) return undefined
  const n = parseFloat(m[1])
  return Number.isFinite(n) ? n * TWIPS_PER_UNIT[m[2]] : undefined
}

/** Rounded twips of an ODF length. */
export function twips(value: string | undefined | null): number | undefined {
  const t = lengthToTwips(value)
  return t === undefined ? undefined : Math.round(t)
}

/** A percentage (`160%`) as a fraction (1.6); undefined otherwise. */
export function percent(value: string | undefined | null): number | undefined {
  if (!value) return undefined
  const m = /^\s*([-+]?\d*\.?\d+)\s*%\s*$/.exec(value)
  return m ? parseFloat(m[1]) / 100 : undefined
}

const trim = (n: number, digits: number) => {
  const s = n.toFixed(digits)
  return s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s
}

/** Twips as an ODF length in centimetres with three decimals (`0.529cm`), as Hancom writes. */
export function twipsToCm(value: number): string {
  return `${trim((value * 2.54) / 1440, 3)}cm`
}

/** Twips as points with two decimals (`-0.60pt`). */
export function twipsToPt(value: number): string {
  return `${trim(value / 20, 2)}pt`
}

/** Half-points as points with two decimals (`10.50pt`). */
export function halfPointsToPt(value: number): string {
  return `${trim(value / 2, 2)}pt`
}
