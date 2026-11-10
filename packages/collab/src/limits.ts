/**
 * The server's default limit on one text frame, so on one submitted change with its ops. One
 * real edit can be this large: a pasted picture travels inside a single editor step.
 */
export const MAX_CHANGE_BYTES = 8 * 1024 * 1024

/**
 * Small ops are batched into one submit up to this many encoded bytes, so one batch the
 * adapter emitted may become several changes. An op larger than this goes out alone.
 */
export const SUBMIT_CHUNK_BYTES = 64 * 1024

/** Room a submit frame needs around its ops */
export const SUBMIT_FRAME_BYTES = 128
