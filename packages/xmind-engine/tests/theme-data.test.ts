import { describe, expect, it } from 'vitest'
import {
  colorLightness,
  contrastRatio,
  isHexColor,
  mixColors,
  raiseColor,
  relativeLuminance,
  stepToward,
} from '../src/theme-color'
import {
  DEFAULT_THEME_ID,
  isThemeId,
  parseThemeId,
  THEME_BAND_IDS,
  THEME_BANDS,
  THEME_DEEP_LEVELS,
  THEME_IDS,
  THEME_LINES,
  THEME_SKELETON_IDS,
  THEME_SKELETONS,
  THEME_SPACING,
  THEME_VARIANT_IDS,
  themeId,
} from '../src/theme-data'
import { buildThemeLook } from '../src/theme-look'

/** The lightness steps the four accents of a band must keep between them (CIE L*). */
const MIN_ACCENT_LIGHTNESS_GAP = 7
/** The angle on the colour wheel any two accents of a band must keep between them. */
const MIN_ACCENT_HUE_GAP = 20
/** The contrast every accent must keep with its band's light ground, as a line. */
const MIN_ACCENT_ON_LIGHT = 3

/** Hue angle (0-360) of a `#rrggbb` colour, as in HSL. */
function hueOf(color: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(color.slice(at, at + 2), 16) / 255) as [
    number,
    number,
    number,
  ]
  const max = Math.max(r, g, b)
  const span = max - Math.min(r, g, b)
  if (span === 0) return 0
  const sixth =
    max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4
  return (sixth * 60 + 360) % 360
}

function pairs<T>(items: readonly T[]): [T, T][] {
  return items.flatMap((first, index) =>
    items.slice(index + 1).map((second): [T, T] => [first, second]),
  )
}

describe('colour arithmetic', () => {
  it('mixes channel by channel, rounding each', () => {
    expect(mixColors('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixColors('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mixColors('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixColors('#102030', '#302010', 0.25)).toBe('#182028')
  })

  it('raises every channel by one step and stops at full', () => {
    expect(raiseColor('#102030', 16)).toBe('#203040')
    expect(raiseColor('#f0800a', 32)).toBe('#ffa02a')
  })

  it('measures luminance, lightness and contrast the standard way', () => {
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10)
    expect(colorLightness('#000000')).toBe(0)
    expect(colorLightness('#ffffff')).toBeCloseTo(100, 6)
    expect(colorLightness('#777777')).toBeCloseTo(50.03, 1)
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6)
    expect(contrastRatio('#336699', '#336699')).toBe(1)
    expect(contrastRatio('#ffffff', '#767676')).toBeCloseTo(4.54, 2)
  })

  it('moves a colour only as far as the contrast asks', () => {
    expect(stepToward('#000000', '#ffffff', '#ffffff', 4.5)).toBe('#000000')
    const moved = stepToward('#cccccc', '#000000', '#ffffff', 4.5)
    expect(contrastRatio(moved, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    const steps = Array.from({ length: 20 }, (_, step) =>
      mixColors('#cccccc', '#000000', step / 20),
    )
    expect(steps.indexOf(moved)).toBeGreaterThan(0)
    expect(contrastRatio(steps[steps.indexOf(moved) - 1]!, '#ffffff')).toBeLessThan(4.5)
    expect(stepToward('#cccccc', '#bbbbbb', '#ffffff', 4.5)).toBe('#bbbbbb')
  })

  it('takes lower-case #rrggbb and nothing else', () => {
    expect(isHexColor('#0a1b2c')).toBe(true)
    for (const bad of ['#0A1B2C', '#abc', '#0a1b2c80', 'red', 'inherited', '', 7, null]) {
      expect(isHexColor(bad), String(bad)).toBe(false)
    }
    expect(() => mixColors('#abc', '#ffffff', 0.5)).toThrow(/xmind:/)
    expect(() => raiseColor('var(--accent)', 1)).toThrow(/xmind:/)
  })
})

describe('theme ids', () => {
  it('names 4 skeletons x 8 bands x 3 variants = 96 themes, each once', () => {
    expect(THEME_SKELETON_IDS).toEqual(['pill', 'capsule', 'line', 'block'])
    expect(THEME_BAND_IDS).toHaveLength(8)
    expect(THEME_VARIANT_IDS).toEqual(['light', 'dark', 'tint'])
    expect(THEME_IDS).toHaveLength(96)
    expect(new Set(THEME_IDS).size).toBe(96)
    for (const id of THEME_IDS) expect(id).toMatch(/^[a-z]+\/[a-z]+\/[a-z]+$/)
  })

  it('splits an id into its parts and puts it back together', () => {
    expect(parseThemeId('block/harbor/tint')).toEqual({
      skeleton: 'block',
      band: 'harbor',
      variant: 'tint',
    })
    for (const id of THEME_IDS) expect(themeId(parseThemeId(id)!)).toBe(id)
  })

  it('turns down anything that is not one of the 96', () => {
    const bad = ['pill/paper', 'pill/paper/light/x', 'round/paper/light', 'pill/Paper/light']
    for (const value of [...bad, 'pill/paper/dusk', '', 5, null, undefined, {}]) {
      expect(parseThemeId(value), String(value)).toBeNull()
      expect(isThemeId(value)).toBe(false)
    }
  })

  it('starts a new map with soft pills in the paper band on its light ground', () => {
    expect(DEFAULT_THEME_ID).toBe('pill/paper/light')
    expect(THEME_IDS).toContain(DEFAULT_THEME_ID)
  })
})

describe('colour bands', () => {
  const bands = THEME_BAND_IDS.map((id) => [id, THEME_BANDS[id]] as const)

  it('has one band per id, six #rrggbb colours each, none used twice', () => {
    expect(Object.keys(THEME_BANDS)).toEqual([...THEME_BAND_IDS])
    const all = bands.flatMap(([, band]) => band)
    expect(all).toHaveLength(48)
    for (const color of all) expect(isHexColor(color), color).toBe(true)
    expect(new Set(all).size).toBe(48)
  })

  it.each(bands)('%s runs from a light ground to a dark ink', (_id, band) => {
    const [light, , , , , dark] = band
    expect(colorLightness(light)).toBeGreaterThan(95)
    expect(colorLightness(dark)).toBeLessThan(20)
    for (const accent of band.slice(1, 5)) {
      expect(colorLightness(accent)).toBeLessThan(colorLightness(light))
      expect(colorLightness(accent)).toBeGreaterThan(colorLightness(dark))
    }
  })

  it.each(bands)('%s keeps its four accents apart in lightness and in hue', (_id, band) => {
    for (const [first, second] of pairs(band.slice(1, 5))) {
      const lightnessGap = Math.abs(colorLightness(first) - colorLightness(second))
      expect(lightnessGap, `${first} ${second}`).toBeGreaterThanOrEqual(MIN_ACCENT_LIGHTNESS_GAP)
      const turn = Math.abs(hueOf(first) - hueOf(second))
      expect(Math.min(turn, 360 - turn), `${first} ${second}`).toBeGreaterThanOrEqual(
        MIN_ACCENT_HUE_GAP,
      )
    }
  })

  it.each(bands)('%s has accents that stand off its light ground', (_id, band) => {
    for (const accent of band.slice(1, 5)) {
      expect(contrastRatio(accent, band[0]), accent).toBeGreaterThanOrEqual(MIN_ACCENT_ON_LIGHT)
    }
  })
})

describe('skeletons', () => {
  it('has one per id', () => {
    expect(Object.keys(THEME_SKELETONS)).toEqual([...THEME_SKELETON_IDS])
  })

  it.each(THEME_SKELETON_IDS)('%s shrinks from the centre down, all at once', (id) => {
    const { central, main, sub } = THEME_SKELETONS[id]
    for (const [upper, lower] of [
      [central, main],
      [main, sub],
    ] as const) {
      expect(upper.fontSize).toBeGreaterThan(lower.fontSize)
      expect(upper.fontWeight).toBeGreaterThan(lower.fontWeight)
      expect(upper.padding[0]).toBeGreaterThanOrEqual(lower.padding[0])
    }
  })

  it('starts from the sizes the prototype settled on', () => {
    const { central, main, sub } = THEME_SKELETONS.pill
    expect([central.fontSize, main.fontSize, sub.fontSize]).toEqual([18, 14.5, 13.5])
    expect([central.fontWeight, main.fontWeight, sub.fontWeight]).toEqual([700, 650, 400])
    expect([central.padding, main.padding, sub.padding]).toEqual([
      [14, 26],
      [7, 16],
      [5, 10],
    ])
    expect(THEME_LINES).toEqual({ main: 2.25, sub: 1.5, subOpacity: 0.72, cornerRadius: 8 })
    expect(THEME_SPACING).toEqual({ mainGapX: 56, mainGapY: 22, subGapX: 26, subGapY: 6 })
  })

  it('steps the levels below the third down, to a floor that holds for everything deeper', () => {
    const deep = buildThemeLook(parseThemeId('pill/paper/light')!).deepSizes
    expect(THEME_DEEP_LEVELS).toEqual({ step: 0.5, floor: 12, last: 6 })
    expect(deep).toEqual([13, 12.5, 12])
    for (const [upper, lower] of pairs(deep)) expect(upper).toBeGreaterThan(lower)
    // a theme whose third level is already at the floor does not go below it
    const low = buildThemeLook(parseThemeId('pill/paper/light')!, undefined, {
      ...THEME_SKELETONS.pill,
      sub: { ...THEME_SKELETONS.pill.sub, fontSize: THEME_DEEP_LEVELS.floor },
    }).deepSizes
    expect(low.every((size) => size === THEME_DEEP_LEVELS.floor)).toBe(true)
  })
})
