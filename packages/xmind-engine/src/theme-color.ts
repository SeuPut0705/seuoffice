/**
 * Colour arithmetic for the theme table. Colours go in and come out as
 * lower-case `#rrggbb` strings, the form the theme table holds them in.
 *
 * `mixColors` and `raiseColor` are whole-number steps on the three channels,
 * so they give the same colour on every engine and in every release. Whatever
 * reaches a saved file is made with those two alone. The functions that
 * measure a colour (luminance, lightness, contrast) use powers and roots; they
 * only choose among colours for the screen and never feed the file.
 */

const HEX_COLOR = /^#[0-9a-f]{6}$/

type Channels = readonly [red: number, green: number, blue: number]

/** Whether a value is a colour in the form the theme table uses. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value)
}

function channelsOf(color: string): Channels {
  if (!HEX_COLOR.test(color)) throw new Error(`xmind: not a #rrggbb colour: ${color}`)
  const value = Number.parseInt(color.slice(1), 16)
  return [value >> 16, (value >> 8) & 0xff, value & 0xff]
}

function colorOf(channels: readonly number[]): string {
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/** `from` moved towards `to`: 0 gives `from`, 1 gives `to`. Each channel is rounded. */
export function mixColors(from: string, to: string, amount: number): string {
  const target = channelsOf(to)
  return colorOf(
    channelsOf(from).map((channel, index) =>
      Math.round(channel + (target[index]! - channel) * amount),
    ),
  )
}

/**
 * A colour with every channel raised by the same step (0-255), stopping at
 * full. Unlike a mix towards white it moves dark and light colours by the same
 * amount, so a set of colours keeps its order from dark to light.
 */
export function raiseColor(color: string, step: number): string {
  return colorOf(channelsOf(color).map((channel) => Math.min(255, channel + step)))
}

/** Relative luminance as WCAG defines it: 0 for black, 1 for white. */
export function relativeLuminance(color: string): number {
  const [red, green, blue] = channelsOf(color).map((channel) => {
    const share = channel / 255
    return share <= 0.04045 ? share / 12.92 : ((share + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

/** Perceived lightness (CIE L*): 0 for black, 100 for white, even steps look even. */
export function colorLightness(color: string): number {
  const luminance = relativeLuminance(color)
  return luminance <= 216 / 24389 ? (24389 / 27) * luminance : 116 * Math.cbrt(luminance) - 16
}

/** WCAG contrast ratio of two colours: 1 (the same) to 21 (black on white). */
export function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first)
  const b = relativeLuminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const CONTRAST_STEPS = 20

/**
 * `color`, moved towards `toward` in twentieths until it stands at least
 * `minContrast` off `against`. Returns `color` itself when it already does,
 * and `toward` when no step short of it is enough.
 */
export function stepToward(
  color: string,
  toward: string,
  against: string,
  minContrast: number,
): string {
  for (let step = 0; step < CONTRAST_STEPS; step++) {
    const candidate = mixColors(color, toward, step / CONTRAST_STEPS)
    if (contrastRatio(candidate, against) >= minContrast) return candidate
  }
  return toward
}
