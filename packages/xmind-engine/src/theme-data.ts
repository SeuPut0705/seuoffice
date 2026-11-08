/**
 * The theme table: every value a map theme is made of, in one place.
 *
 * A theme is a skeleton (the shapes), a colour band (six colours) and a ground
 * variant: 4 x 8 x 3 = 96 themes. Nothing is drawn or written from this file
 * directly: `theme-look.ts` turns a theme into drawing values, and
 * `theme-table.ts` into the properties the file format holds.
 *
 * The colours are document content. They are plain values on purpose and never
 * point at the colour tokens of the window around the map: a map looks the same
 * under the app's light and dark setting, on screen, in print and in an
 * exported picture.
 *
 * The bands, their names and the skeletons are this project's own. The ids
 * below are what the editor keys its translated names on.
 *
 * Changing a value here changes what the app writes for every theme that uses
 * it. Once a release has shipped, read the note on `SHIPPED_THEME_TABLES` in
 * `theme-table.ts` before doing that.
 */

export const THEME_SKELETON_IDS = ['pill', 'capsule', 'line', 'block'] as const
export type ThemeSkeletonId = (typeof THEME_SKELETON_IDS)[number]

export const THEME_BAND_IDS = [
  'paper',
  'slate',
  'moss',
  'harbor',
  'clay',
  'plum',
  'signal',
  'poppy',
] as const
export type ThemeBandId = (typeof THEME_BAND_IDS)[number]

export const THEME_VARIANT_IDS = ['light', 'dark', 'tint'] as const
export type ThemeVariantId = (typeof THEME_VARIANT_IDS)[number]

/** `<skeleton>/<band>/<variant>`, e.g. `pill/paper/light`. Stable: files are recognised by it. */
export type ThemeId = `${ThemeSkeletonId}/${ThemeBandId}/${ThemeVariantId}`

export interface ThemeParts {
  skeleton: ThemeSkeletonId
  band: ThemeBandId
  variant: ThemeVariantId
}

/**
 * A colour band: a light ground, four accents, a dark ink, as `#rrggbb`.
 * The first accent is the band's own colour: it leads the branches and tints
 * the ground of the `tint` variant.
 */
export type ThemeBandColors = readonly [
  light: string,
  accent1: string,
  accent2: string,
  accent3: string,
  accent4: string,
  dark: string,
]

/**
 * The eight bands. This is the one place to adjust a colour.
 *
 * How they were chosen, and what `tests/theme-data.test.ts` holds them to:
 * the four accents of a band differ in hue and sit at four different levels of
 * lightness, so two branches stay apart for a reader who cannot tell the hues
 * apart. Three accents are dark enough for the band's light colour to be read
 * on them and the lightest is light enough for the dark one, and every accent
 * still stands off the light ground as a line.
 */
export const THEME_BANDS: Readonly<Record<ThemeBandId, ThemeBandColors>> = {
  // warm off-white and ink: brick, pine, ochre, slate blue
  paper: ['#faf8f3', '#bb4a36', '#106758', '#b48427', '#264684', '#1f2328'],
  // cool grey: cobalt, teal, burnt orange, violet
  slate: ['#f4f6f8', '#015ab0', '#007b80', '#d57241', '#5d3484', '#1b2430'],
  // soft green: forest, olive, terracotta, deep teal
  moss: ['#f5f7f0', '#1b6734', '#978f29', '#b4502b', '#004e6e', '#18241d'],
  // pale blue and navy: azure, indigo, sea green, amber
  harbor: ['#f2f7fa', '#0975ab', '#2e4195', '#0a684e', '#c07f20', '#12263a'],
  // warm earth: rust, leaf, gold, maroon
  clay: ['#fbf5ef', '#ac5622', '#4a6327', '#ac8823', '#7f293a', '#2b1d18'],
  // lilac and aubergine: purple, pink, teal, indigo
  plum: ['#f9f5fa', '#7a419e', '#d96792', '#047c79', '#313e9b', '#251a2e'],
  // pure white and near-black, full strength: blue, red, green, violet
  signal: ['#ffffff', '#0469e2', '#b5151a', '#23a250', '#6020ab', '#14171c'],
  // blush: red, leaf green, marigold, mulberry
  poppy: ['#fdf5f3', '#c9384b', '#34662f', '#bf7f1d', '#752b68', '#2e1a1f'],
}

/** How a ground variant and the softer colours are worked out from a band. */
export const THEME_RULES = {
  /** share of the band's first accent mixed into the light colour for a `tint` ground */
  tintGround: 0.1,
  /** channel step (0-255) every accent is raised by on a `dark` ground */
  darkGroundRaise: 62,
  /** share of the ground mixed into the strongest text colour for running text */
  bodyTextSoftening: 0.15,
  /** share of the branch colour in a softly filled main topic, sub-topic and label */
  softFill: { main: 0.16, sub: 0.11, label: 0.14 },
  /** share of the strongest text colour in the text of a softly filled main topic */
  softFillText: 0.45,
  /** the contrast every text keeps with what it sits on (WCAG AA for running text) */
  readableContrast: 4.5,
} as const

/** How a topic's box is filled. */
export type ThemeFill = 'none' | 'soft' | 'solid'
/** What is drawn around or under a topic. */
export type ThemeBorder = 'none' | 'outline' | 'underline'
/** How a branch line runs from a topic to the ones below it. */
export type ThemeBranchShape = 'curve' | 'rounded-elbow'

/** A radius large enough to round any topic's ends fully. */
export const THEME_PILL_RADIUS = 999

/** One level of a skeleton. Lengths are CSS pixels. */
export interface ThemeTopicShape {
  fontSize: number
  fontWeight: number
  padding: readonly [vertical: number, horizontal: number]
  radius: number
  /**
   * `solid` is the strongest text colour on the central topic and the branch
   * colour below it; `soft` is the ground with a little of the branch colour.
   */
  fill: ThemeFill
  border: ThemeBorder
  borderWidth: number
}

/** The shapes of one skeleton: the centre, the main branches, everything below. */
export interface ThemeSkeleton {
  central: ThemeTopicShape
  main: ThemeTopicShape
  sub: ThemeTopicShape
  /** the line from a main topic downwards; from the centre it is always a curve */
  subBranch: ThemeBranchShape
}

/** Branch lines: the centre's are heavier than those below, which are also see-through. */
export const THEME_LINES = { main: 2.25, sub: 1.5, subOpacity: 0.72, cornerRadius: 8 } as const

/** Gaps between main branches and between the topics below them. */
export const THEME_SPACING = { mainGapX: 56, mainGapY: 22, subGapX: 26, subGapY: 6 } as const

/**
 * The levels below the third: each one a little smaller than the one above
 * it, down to a floor, so that a deep branch reads as deeper at a glance.
 * `last` is the deepest level with a size of its own; everything below it
 * keeps the floor.
 *
 * The file format has three levels only, so these sizes are drawn and never
 * written. A file opened elsewhere draws every level below the second with
 * its third level's size.
 */
export const THEME_DEEP_LEVELS = { step: 0.5, floor: 12, last: 6 } as const

// Three levels, shrinking together: size, weight and padding.
const CENTRAL = { fontSize: 18, fontWeight: 700, padding: [14, 26] } as const
const MAIN = { fontSize: 14.5, fontWeight: 650, padding: [7, 16] } as const
const SUB = { fontSize: 13.5, fontWeight: 400, padding: [5, 10] } as const
const TEXT_ONLY = { radius: 0, fill: 'none', border: 'none', borderWidth: 0 } as const
const NO_BORDER = { border: 'none', borderWidth: 0 } as const

export const THEME_SKELETONS: Readonly<Record<ThemeSkeletonId, ThemeSkeleton>> = {
  // softly filled pills on the main branches, bare text below, curves
  pill: {
    central: { ...CENTRAL, radius: 16, fill: 'solid', ...NO_BORDER },
    main: { ...MAIN, radius: THEME_PILL_RADIUS, fill: 'soft', ...NO_BORDER },
    sub: { ...SUB, ...TEXT_ONLY },
    subBranch: 'curve',
  },
  // outlined capsules on the main branches, bare text below, curves
  capsule: {
    central: { ...CENTRAL, radius: 18, fill: 'solid', ...NO_BORDER },
    main: {
      ...MAIN,
      radius: THEME_PILL_RADIUS,
      fill: 'none',
      border: 'outline',
      borderWidth: 1.5,
    },
    sub: { ...SUB, ...TEXT_ONLY },
    subBranch: 'curve',
  },
  // no boxes: the text sits on its branch line, curves
  line: {
    central: { ...CENTRAL, radius: 10, fill: 'none', border: 'outline', borderWidth: 2 },
    main: {
      ...MAIN,
      padding: [5, 4],
      radius: 0,
      fill: 'none',
      border: 'underline',
      borderWidth: THEME_LINES.main,
    },
    sub: {
      ...SUB,
      padding: [5, 2],
      radius: 0,
      fill: 'none',
      border: 'underline',
      borderWidth: THEME_LINES.sub,
    },
    subBranch: 'curve',
  },
  // filled boxes on the main branches, soft boxes below, rounded elbows
  block: {
    central: { ...CENTRAL, radius: 12, fill: 'solid', ...NO_BORDER },
    main: { ...MAIN, radius: 10, fill: 'solid', ...NO_BORDER },
    sub: { ...SUB, padding: [5, 11], radius: 8, fill: 'soft', ...NO_BORDER },
    subBranch: 'rounded-elbow',
  },
}

/** The id of the theme made of these three parts. */
export function themeId(parts: ThemeParts): ThemeId {
  return `${parts.skeleton}/${parts.band}/${parts.variant}`
}

/** The three parts of a theme id, or null for anything that is not one. */
export function parseThemeId(value: unknown): ThemeParts | null {
  if (typeof value !== 'string') return null
  const [skeleton, band, variant, ...rest] = value.split('/')
  return rest.length === 0 &&
    includes(THEME_SKELETON_IDS, skeleton) &&
    includes(THEME_BAND_IDS, band) &&
    includes(THEME_VARIANT_IDS, variant)
    ? { skeleton, band, variant }
    : null
}

export function isThemeId(value: unknown): value is ThemeId {
  return parseThemeId(value) !== null
}

function includes<T extends string>(ids: readonly T[], value: string | undefined): value is T {
  return ids.includes(value as T)
}

/** All 96 theme ids: skeleton by skeleton, band by band, variant by variant. */
export const THEME_IDS: readonly ThemeId[] = THEME_SKELETON_IDS.flatMap((skeleton) =>
  THEME_BAND_IDS.flatMap((band) =>
    THEME_VARIANT_IDS.map((variant) => themeId({ skeleton, band, variant })),
  ),
)

/** What a new map starts with: soft pills in the paper band on its light ground. */
export const DEFAULT_THEME_ID: ThemeId = 'pill/paper/light'
