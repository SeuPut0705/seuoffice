import { describe, expect, it } from 'vitest'
import { colorLightness, contrastRatio, isHexColor, mixColors } from '../src/theme-color'
import {
  DEFAULT_THEME_ID,
  parseThemeId,
  THEME_BAND_IDS,
  THEME_BANDS,
  THEME_IDS,
  THEME_PILL_RADIUS,
  THEME_RULES,
  THEME_SKELETONS,
  THEME_VARIANT_IDS,
  themeId,
  type ThemeBandColors,
  type ThemeId,
} from '../src/theme-data'
import {
  buildThemeLook,
  themeLook,
  themeVariantColors,
  type ThemeLook,
  type ThemeTopicColors,
} from '../src/theme-look'

/** WCAG AA for running text: what every text keeps with the surface under it. */
const READABLE = 4.5
/** What a branch colour keeps with the ground, as a line, per variant. */
const MIN_LINE_CONTRAST = { light: 3, dark: 4, tint: 2.5 } as const

const looks = THEME_IDS.map((id) => [id, themeLook(id)] as const)

/** Every text of a look with the surface it is read on. */
function textPairs(look: ThemeLook): [name: string, text: string, surface: string][] {
  const on = (colors: ThemeTopicColors): string => colors.fill ?? look.ground
  return [
    ['running text', look.text, look.ground],
    ['strong text', look.strongText, look.ground],
    ['central', look.central.text, on(look.central)],
    ...look.branches.flatMap((branch, index): [string, string, string][] => [
      [`main ${index}`, branch.main.text, on(branch.main)],
      [`sub ${index}`, branch.sub.text, on(branch.sub)],
      [`label ${index}`, branch.label.text, branch.label.fill],
    ]),
  ]
}

/** Every colour value a look hands to the editor. */
function colorsOf(look: ThemeLook): (string | null)[] {
  const topic = (colors: ThemeTopicColors): (string | null)[] => [
    colors.fill,
    colors.text,
    colors.border,
  ]
  return [
    ...look.bandColors,
    look.ground,
    look.text,
    look.strongText,
    ...topic(look.central),
    ...look.branches.flatMap((branch) => [
      branch.color,
      ...topic(branch.main),
      ...topic(branch.sub),
      branch.label.fill,
      branch.label.text,
    ]),
  ]
}

describe('every one of the 96 looks', () => {
  it.each(looks)('%s keeps its text readable on every fill', (_id, look) => {
    for (const [name, text, surface] of textPairs(look)) {
      expect(contrastRatio(text, surface), `${name}: ${text} on ${surface}`).toBeGreaterThanOrEqual(
        READABLE,
      )
    }
  })

  it.each(looks)('%s keeps its branch colours off the ground', (_id, look) => {
    expect(look.branches).toHaveLength(4)
    for (const branch of look.branches) {
      expect(
        contrastRatio(branch.color, look.ground),
        `${branch.color} on ${look.ground}`,
      ).toBeGreaterThanOrEqual(MIN_LINE_CONTRAST[look.variant])
    }
  })

  it.each(looks)('%s is made of plain colours, not of the window around it', (id, look) => {
    for (const color of colorsOf(look)) {
      if (color !== null) expect(isHexColor(color), String(color)).toBe(true)
    }
    // Nothing in a look may lean on the app's own colour tokens.
    expect(JSON.stringify(look)).not.toMatch(/var\(|--/)
    expect(look.id).toBe(id)
    expect(themeId(look)).toBe(id)
  })

  it('gives one object per theme and turns down an unknown id', () => {
    expect(themeLook(DEFAULT_THEME_ID)).toBe(themeLook(DEFAULT_THEME_ID))
    expect(() => themeLook('pill/paper/dusk' as ThemeId)).toThrow(/xmind:/)
  })
})

describe('the three grounds of a band come from its six colours', () => {
  it.each(THEME_BAND_IDS)('%s', (bandId) => {
    const band = THEME_BANDS[bandId]
    const [light, dark] = [band[0], band[5]]
    const onLight = themeVariantColors(band, 'light')
    const onDark = themeVariantColors(band, 'dark')
    const onTint = themeVariantColors(band, 'tint')

    expect(onLight).toMatchObject({ ground: light, strongText: dark })
    expect(onLight.branchColors).toEqual(band.slice(1, 5))
    expect(onDark).toMatchObject({ ground: dark, strongText: light })
    expect(onTint.ground).toBe(mixColors(light, band[1], THEME_RULES.tintGround))
    expect(onTint.ground).not.toBe(light)
    expect(onTint.strongText).toBe(dark)
    expect(onTint.branchColors).toEqual(band.slice(1, 5))

    // On the dark ground the accents are lighter, and still in the same order.
    const order = (colors: readonly string[]): number[] =>
      colors
        .map((_, index) => index)
        .sort((a, b) => colorLightness(colors[a]!) - colorLightness(colors[b]!))
    expect(order(onDark.branchColors)).toEqual(order(onLight.branchColors))
    onDark.branchColors.forEach((color, index) => {
      expect(colorLightness(color)).toBeGreaterThan(colorLightness(onLight.branchColors[index]!))
    })
  })

  it('draws a skeleton with the same shapes on every ground, and a ground the same under every skeleton', () => {
    for (const variant of THEME_VARIANT_IDS) {
      const pill = themeLook(themeId({ skeleton: 'pill', band: 'moss', variant }))
      const block = themeLook(themeId({ skeleton: 'block', band: 'moss', variant }))
      expect(pill.shapes).toEqual(themeLook('pill/moss/light').shapes)
      expect(block.ground).toBe(pill.ground)
      expect(block.branches.map((branch) => branch.color)).toEqual(
        pill.branches.map((branch) => branch.color),
      )
    }
  })

  it('builds from a band it is handed instead of the one in the table', () => {
    const band: ThemeBandColors = ['#f6f6f0', '#8a3c2c', '#2c6a4a', '#9a7a2a', '#2a3c7a', '#202020']
    const look = buildThemeLook(parseThemeId('pill/paper/light')!, band)
    expect(look.id).toBe('pill/paper/light')
    expect(look.ground).toBe('#f6f6f0')
    expect(look.branches.map((branch) => branch.color)).toEqual(band.slice(1, 5))
    expect(look).not.toEqual(themeLook('pill/paper/light'))
  })
})

describe('the four skeletons', () => {
  const on = (skeleton: 'pill' | 'capsule' | 'line' | 'block'): ThemeLook =>
    themeLook(themeId({ skeleton, band: 'harbor', variant: 'light' }))

  it('pill: softly filled pills on the main branches, bare text below, curves', () => {
    const look = on('pill')
    expect(look.shapes.main.radius).toBe(THEME_PILL_RADIUS)
    for (const branch of look.branches) {
      expect(branch.main.fill).toBe(mixColors(look.ground, branch.color, 0.16))
      expect(branch.main.border).toBeNull()
      expect(branch.sub).toEqual({ fill: null, text: look.text, border: null })
    }
    expect(look.central).toMatchObject({ fill: look.strongText, border: null })
    expect(look.lines.sub.shape).toBe('curve')
  })

  it('capsule: outlined capsules in the branch colour, bare text below, curves', () => {
    const look = on('capsule')
    expect(look.shapes.main).toMatchObject({ radius: THEME_PILL_RADIUS, border: 'outline' })
    for (const branch of look.branches) {
      expect(branch.main).toMatchObject({ fill: null, border: branch.color })
      expect(branch.sub).toEqual({ fill: null, text: look.text, border: null })
    }
    expect(look.lines.sub.shape).toBe('curve')
  })

  it('line: no boxes, the text sits on its branch line', () => {
    const look = on('line')
    expect(look.central).toEqual({ fill: null, text: look.strongText, border: look.strongText })
    for (const branch of look.branches) {
      expect(branch.main).toEqual({ fill: null, text: look.strongText, border: branch.color })
      expect(branch.sub).toEqual({ fill: null, text: look.text, border: branch.color })
    }
    expect(look.shapes.main).toMatchObject({ border: 'underline', borderWidth: 2.25, radius: 0 })
    expect(look.shapes.sub).toMatchObject({ border: 'underline', borderWidth: 1.5 })
  })

  it('block: filled boxes on the main branches, soft boxes below, rounded elbows', () => {
    const look = on('block')
    for (const branch of look.branches) {
      expect(branch.main).toMatchObject({ fill: branch.color, border: null })
      expect(branch.sub.fill).toBe(mixColors(look.ground, branch.color, 0.11))
    }
    expect(look.lines.sub.shape).toBe('rounded-elbow')
    expect(look.lines.main.shape).toBe('curve')
  })

  it('keeps three levels apart: lines get thinner and lighter with the text', () => {
    for (const [, look] of looks) {
      expect(look.lines.main.width).toBe(2.25)
      expect(look.lines.sub).toMatchObject({ width: 1.5, opacity: 0.72 })
      expect(look.shapes).toEqual({
        central: THEME_SKELETONS[look.skeleton].central,
        main: THEME_SKELETONS[look.skeleton].main,
        sub: THEME_SKELETONS[look.skeleton].sub,
      })
    }
  })
})

describe('the default look', () => {
  it('is warm paper with an ink centre, soft pills and thin curves', () => {
    const look = themeLook(DEFAULT_THEME_ID)
    expect(look).toMatchObject({ skeleton: 'pill', band: 'paper', variant: 'light' })
    // warm off-white: light, and a little more red than blue
    expect(colorLightness(look.ground)).toBeGreaterThan(95)
    expect(Number.parseInt(look.ground.slice(1, 3), 16)).toBeGreaterThan(
      Number.parseInt(look.ground.slice(5, 7), 16),
    )
    expect(look.central.fill).toBe(look.bandColors[5])
    expect(colorLightness(look.central.fill!)).toBeLessThan(20)
    for (const branch of look.branches) {
      expect(colorLightness(branch.main.fill!)).toBeGreaterThan(85)
    }
    expect(look.lines.main).toEqual({ width: 2.25, shape: 'curve' })
  })
})
