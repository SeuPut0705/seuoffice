/** The server's default limit on one text frame, so on one submitted change with its ops */
export const MAX_CHANGE_BYTES = 256 * 1024

/**
 * The engine sends local ops in submits of at most this many encoded bytes, so one
 * batch the adapter emitted may become several changes. Well below `MAX_CHANGE_BYTES`.
 */
export const SUBMIT_CHUNK_BYTES = 64 * 1024

/** Room a submit frame needs around its ops */
export const SUBMIT_FRAME_BYTES = 128
