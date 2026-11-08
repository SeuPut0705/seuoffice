/**
 * The generate window's adjustable values, in one place. Changing a number
 * here changes the window's behaviour and nothing else: how an editor trims
 * material for its model (the existing upper bound) is that editor's own and
 * is not touched by these.
 */

/** 8.7 "long material": text length of all materials together, above which slides/html warn */
export const LONG_MATERIAL_NOTICE_CHARS = 8_000

/**
 * 8.7 "usage": the starting value is defined on the materials' total text
 * length (not their size on disk), above which the window warns that the run
 * will use a lot of the plan's limit.
 */
export const USAGE_NOTICE_CHARS = 100_000

/** materials one request can carry */
export const MAX_MATERIALS = 20

/** one material's size cap: the editors' existing attachment cap */
export const MAX_MATERIAL_BYTES = 50 * 1024 * 1024

/**
 * A picture is handed to the target editor as an image attachment, and every
 * receiving editor refuses images above this size; a bigger one would be
 * dropped there, so it is left out here with the reason shown.
 */
export const MAX_IMAGE_MATERIAL_BYTES = 5 * 1024 * 1024

/** input guard on the request text crossing IPC; not a product rule */
export const MAX_REQUEST_TEXT_CHARS = 32_000
