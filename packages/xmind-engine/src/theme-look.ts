/**
 * What a theme looks like: every value the editor needs to draw one, worked
 * out from the theme table by rule. Nothing here is hand-painted per theme, so
 * the three ground variants of a band come from its six colours alone.
 *
 * All colours are plain `#rrggbb` values and belong to the document. They do
 * not follow the app's light or dark setting.
 */

import { contrastRatio, mixColors, raiseColor, stepToward } from './theme-color'
import {
  parseThemeId,
  THEME_BANDS,
  THEME_DEEP_LEVELS,
  THEME_LINES,
  THEME_RULES,
  THEME_SKELETONS,
  THEME_SPACING,
  themeId,
  type ThemeBandColors,
  type ThemeBandId,
  type ThemeBranchShape,
  type ThemeId,
  type ThemeParts,
  type ThemeSkeleton,
  type ThemeSkeletonId,
  type ThemeTopicShape,
  type ThemeVariantId,
} from './theme-data'

/** The colours of one topic. `null` means that part is not drawn. */
export interface ThemeTopicColors {
  fill: string | null
  text: string
  border: string | null
}

/** One main branch and everything below it: a single colour of the band and its soft forms. */
export interface ThemeBranchLook {
  /** the branch colour: its lines, and the base of the colours below */
  color: string
  main: ThemeTopicColors
  sub: ThemeTopicColors
  label: { fill: string; text: string }
}

export interface ThemeLook {
  id: ThemeId
  skeleton: ThemeSkeletonId
  band: ThemeBandId
  variant: ThemeVariantId
  /** the band as it is in the table: light, four accents, dark */
  bandColors: ThemeBandColors
  /** the map's background */
  ground: string
  /** running text on the ground */
  text: string
  /** the strongest text colour on the ground: the band's far end */
  strongText: string
  /** sizes, padding, corners and outline of the three levels (CSS pixels) */
  shapes: { central: ThemeTopicShape; main: ThemeTopicShape; sub: ThemeTopicShape }
  /**
   * The font sizes of the levels below the third, from the fourth level down
   * (index 0 is the fourth), each a little smaller than the one above it and
   * none below the floor. Drawn only: the file has three levels.
   */
  deepSizes: readonly number[]
  central: ThemeTopicColors
  /** one entry per accent; main branch `n` uses `branches[n % branches.length]` */
  branches: readonly ThemeBranchLook[]
  lines: {
    /** from the centre to a main topic */
    main: { width: number; shape: ThemeBranchShape }
    /** from a main topic downwards */
    sub: { width: number; opacity: number; shape: ThemeBranchShape }
    /** how far an elbow's corner is rounded */
    cornerRadius: number
  }
  /** gaps between main branches and between the topics below them (CSS pixels) */
  spacing: { mainGapX: number; mainGapY: number; subGapX: number; subGapY: number }
}

/** What a ground variant makes of a band, before any skeleton is applied. */
export interface ThemeVariantColors {
  ground: string
  strongText: string
  text: string
  /** the four accents as they are used on this ground */
  branchColors: readonly string[]
}

/**
 * The three grounds of a band. `light` and `dark` lay the band's own two ends
 * under the map; `tint` mixes a little of the band's first accent into the
 * light one. On a dark ground every accent is raised by the same step, which
 * keeps the four in their order from dark to light.
 *
 * Only `mixColors` and `raiseColor` are used: these colours are written to the
 * file, and must come out the same in every release.
 */
export function themeVariantColors(
  band: ThemeBandColors,
  variant: ThemeVariantId,
): ThemeVariantColors {
  const light = band[0]
  const dark = band[5]
  const accents = band.slice(1, 5)
  const onDark = variant === 'dark'
  const ground =
    variant === 'light' ? light : onDark ? dark : mixColors(light, band[1], THEME_RULES.tintGround)
  const strongText = onDark ? light : dark
  return {
    ground,
    strongText,
    text: mixColors(strongText, ground, THEME_RULES.bodyTextSoftening),
    branchColors: accents.map((accent) =>
      onDark ? raiseColor(accent, THEME_RULES.darkGroundRaise) : accent,
    ),
  }
}

/**
 * The look of a theme built from the given band and skeleton rather than the
 * ones in the table. `themeLook` is this with the table's own values; passing
 * others shows what a changed table would draw and write.
 */
export function buildThemeLook(
  parts: ThemeParts,
  band: ThemeBandColors = THEME_BANDS[parts.band],
  skeleton: ThemeSkeleton = THEME_SKELETONS[parts.skeleton],
): ThemeLook {
  const colors = themeVariantColors(band, parts.variant)
  const { ground, strongText, text } = colors
  const { readableContrast, softFill, softFillText } = THEME_RULES
  /** the band's own end that reads best on a fill, pushed to pure white or black if it must be */
  const readableOn = (fill: string): string => {
    const [light, dark] = [band[0], band[5]]
    const useLight = contrastRatio(light, fill) >= contrastRatio(dark, fill)
    return stepToward(
      useLight ? light : dark,
      useLight ? '#ffffff' : '#000000',
      fill,
      readableContrast,
    )
  }
  const readable = (wanted: string, on: string): string =>
    stepToward(wanted, strongText, on, readableContrast)

  const branches = colors.branchColors.map((color): ThemeBranchLook => {
    const main = skeleton.main
    const mainFill =
      main.fill === 'solid'
        ? color
        : main.fill === 'soft'
          ? mixColors(ground, color, softFill.main)
          : null
    // A filled box takes the text that reads on it; a soft or outlined one
    // carries its branch colour in the text; bare text on a line stays strong.
    const mainText =
      main.fill === 'solid'
        ? readableOn(color)
        : main.fill === 'soft'
          ? readable(mixColors(color, strongText, softFillText), mainFill!)
          : main.border === 'outline'
            ? readable(color, ground)
            : strongText
    const subFill =
      skeleton.sub.fill === 'solid'
        ? color
        : skeleton.sub.fill === 'soft'
          ? mixColors(ground, color, softFill.sub)
          : null
    const labelFill = mixColors(ground, color, softFill.label)
    return {
      color,
      main: { fill: mainFill, text: mainText, border: main.border === 'none' ? null : color },
      sub: {
        fill: subFill,
        text: skeleton.sub.fill === 'solid' ? readableOn(color) : readable(text, subFill ?? ground),
        border: skeleton.sub.border === 'none' ? null : color,
      },
      label: { fill: labelFill, text: readable(color, labelFill) },
    }
  })

  const centralFilled = skeleton.central.fill !== 'none'
  const deepSizes = Array.from({ length: THEME_DEEP_LEVELS.last - 3 }, (_, at) =>
    Math.max(THEME_DEEP_LEVELS.floor, skeleton.sub.fontSize - THEME_DEEP_LEVELS.step * (at + 1)),
  )
  return {
    id: themeId(parts),
    ...parts,
    bandColors: band,
    ground,
    text,
    strongText,
    shapes: { central: skeleton.central, main: skeleton.main, sub: skeleton.sub },
    deepSizes,
    central: {
      fill: centralFilled ? strongText : null,
      text: centralFilled ? readableOn(strongText) : strongText,
      border: skeleton.central.border === 'none' ? null : strongText,
    },
    branches,
    lines: {
      main: { width: THEME_LINES.main, shape: 'curve' },
      sub: { width: THEME_LINES.sub, opacity: THEME_LINES.subOpacity, shape: skeleton.subBranch },
      cornerRadius: THEME_LINES.cornerRadius,
    },
    spacing: THEME_SPACING,
  }
}

const looks = new Map<ThemeId, ThemeLook>()

/** The look of one of the 96 themes. The same object every time: treat it as read-only. */
export function themeLook(id: ThemeId): ThemeLook {
  let look = looks.get(id)
  if (!look) {
    const parts = parseThemeId(id)
    if (!parts) throw new Error(`xmind: there is no theme ${String(id)}`)
    look = buildThemeLook(parts)
    looks.set(id, look)
  }
  return look
}
