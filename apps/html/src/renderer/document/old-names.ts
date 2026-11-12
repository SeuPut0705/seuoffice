/**
 * Names the HTML editor wrote into users' pages before this product took its
 * own names (decision 0024). No other source file spells an old name.
 */

/** `<meta name>` of the pinned generation brief (`BRIEF_META_NAME`) */
export const OLD_BRIEF_META_NAMES: readonly string[] = ['genoffice:brief']

/**
 * The name a NEW pin is written under. Still the old one: 0.12.37 reads only
 * that name. Switch this to BRIEF_META_NAME only when a version that reads
 * both has been the stable release for at least 14 days.
 */
export const BRIEF_META_NAME_WRITTEN = 'genoffice:brief'
