/**
 * The rules behind the shared `ai:read-url` handler that docs-main.ts
 * registers for the Docs, PDF, Markdown and HTML editors: what a request must
 * look like before the read-url tool runs, and what an exception that escaped
 * the tool answers. Nothing here imports Electron, so the rules are covered by
 * unit tests.
 */
import type { ReadUrlFailure } from '@genoffice/ai-search'

/** The answer to an exception the tool promised never to throw. */
export function unexpectedReadUrlFailure(): ReadUrlFailure {
  return { ok: false, error: 'The read failed.', errorCode: 'network' }
}

/**
 * A request with a usable address, or the refusal to answer with. The address
 * only has to be a non-blank string here: trimming and the http(s) check
 * belong to the tool, whose refusal carries its own sentence and code.
 */
export type ReadUrlRequest = { ok: true; url: string; offset: number } | ReadUrlFailure

export function normalizeReadUrlRequest(url: unknown, offset: unknown): ReadUrlRequest {
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, error: 'url must be a string', errorCode: 'invalid_url' }
  }
  return { ok: true, url, offset: typeof offset === 'number' ? offset : 0 }
}
