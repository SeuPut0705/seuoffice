/**
 * Names this engine wrote before this product took its own names (decision
 * 0024). No other source file spells an old name.
 */

/**
 * Header of a lazy-media placeholder (`MAGIC` in lazy-media.ts). A crash-recovery
 * copy whose pictures could not be put back is kept with its placeholders, so
 * one an earlier version wrote can still be opened. Same length as the current
 * header: the placeholder size checks in parse.ts and zip-splice.ts rely on it.
 */
export const OLD_LAZY_MEDIA_MAGICS: readonly string[] = ['GENOFFICE-LAZY-MEDIA\n']
