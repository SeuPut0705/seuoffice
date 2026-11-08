/**
 * Why taking in a skill (from a folder, a zip file or GitHub), checking a
 * GitHub skill for an update or exporting one did not happen. The screen
 * reads only `kind` and words it itself; the message is an English fallback.
 */

export type SkillImportErrorKind =
  /** the text is not one of the GitHub address forms the app accepts */
  | 'bad-address'
  /** the repository, branch or path does not exist or is not public */
  | 'not-found'
  /** GitHub is refusing requests for a while (rate limit) */
  | 'rate-limited'
  /** no answer, or an answer the app cannot use */
  | 'network'
  /** the archive or a skill folder is over its size limit */
  | 'too-large'
  /** the archive failed a safety check (bomb, unsafe path, link, another host) */
  | 'unsafe'
  /** no skill was found where the person pointed */
  | 'no-skills'
  /** the person cancelled */
  | 'cancelled'
  /** a chosen skill's name is taken and no replace-or-skip choice was given */
  | 'needs-choice'
  /** a chosen skill cannot be installed (no front matter, bad name, ...) */
  | 'not-installable'
  /** the chosen folder is the app's own skills folder or inside it */
  | 'invalid-source'
  /** the skill has no GitHub source record */
  | 'not-github'
  /** a replaced skill could not be moved to the OS trash; it was put back and nothing replaced */
  | 'trash-failed'
  /** writing the files failed; nothing was left half written */
  | 'failed'

export class SkillImportError extends Error {
  readonly kind: SkillImportErrorKind

  constructor(kind: SkillImportErrorKind, message: string) {
    super(message)
    this.name = 'SkillImportError'
    this.kind = kind
  }
}

export function isSkillImportError(error: unknown): error is SkillImportError {
  return error instanceof SkillImportError
}

/** Whether an error is the abort of a fetch or of a stream read */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}
