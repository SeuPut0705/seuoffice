export interface NamedFontSize {
  readonly name: string
  readonly pt: number
}

export const FONT_SIZE_MIN_PT = 1
export const FONT_SIZE_MAX_PT = 1638

/** Word's size list (en-US and ko-KR offer the same one) */
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72]

/** Every row of the size box */
export function fontSizeOptions(): readonly NamedFontSize[] {
  return SIZES.map((pt) => ({ name: String(pt), pt }))
}

export function clampFontSize(pt: number): number {
  return Math.min(FONT_SIZE_MAX_PT, Math.max(FONT_SIZE_MIN_PT, Math.round(pt * 2) / 2))
}

/** Typed text \u2192 points: a number rounded to half points; null when unusable */
export function parseFontSize(text: string): number | null {
  const raw = text.trim().normalize('NFKC')
  if (!raw) return null
  const n = Number(raw.replace(/\s*(pt|\u78c5)$/i, ''))
  return Number.isFinite(n) && n > 0 ? clampFontSize(n) : null
}

/**
 * Increase / Decrease Font Size: walk the list; above its top go 80, 90, 100,
 * ... by tens up to 1638; below its bottom move one point at a time down to 1.
 */
export function stepFontSize(base: number, dir: 1 | -1): number {
  const list = SIZES
  const min = list[0]
  const max = list[list.length - 1]
  if (dir === 1) {
    if (base >= max)
      return Math.min(FONT_SIZE_MAX_PT, base < 80 ? 80 : Math.floor(base / 10) * 10 + 10)
    if (base < min) return Math.min(min, Math.floor(base) + 1)
    return list.find((s) => s > base) ?? max
  }
  if (base > max) return base > 80 ? Math.ceil(base / 10) * 10 - 10 : max
  if (base <= min) return Math.max(FONT_SIZE_MIN_PT, Math.ceil(base) - 1)
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i] < base) return list[i]
  return min
}
