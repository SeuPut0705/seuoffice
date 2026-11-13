/**
 * Typed failures of opening an ODT. Callers (save dialogs, CLI, MCP) map
 * `code` to their own messages; the English `message` is for logs only.
 */

export type OdtOpenErrorCode =
  /** the manifest marks parts encrypted: a password-protected ODT */
  | 'encrypted'
  /** the package is not an OpenDocument text document (e.g. a spreadsheet or template) */
  | 'not-odt-text'
  /** the zip failed the size / inflation gate shared with the docx engine */
  | 'zip-rejected'
  /** not a readable zip, or a required part (content.xml, office:text) is missing */
  | 'corrupt'

export class OdtOpenError extends Error {
  readonly code: OdtOpenErrorCode

  constructor(code: OdtOpenErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OdtOpenError'
    this.code = code
  }
}

/** A password-protected ODT. It is never opened. */
export class OdtEncryptedError extends OdtOpenError {
  constructor(message = 'odt: the document is password-protected (encrypted parts)') {
    super('encrypted', message)
    this.name = 'OdtEncryptedError'
  }
}

/** The package's media type is not `application/vnd.oasis.opendocument.text`. */
export class OdtNotTextError extends OdtOpenError {
  readonly mediaType: string | null

  constructor(mediaType: string | null) {
    super(
      'not-odt-text',
      `odt: not an OpenDocument text document (media type ${mediaType === null ? 'missing' : JSON.stringify(mediaType)})`,
    )
    this.name = 'OdtNotTextError'
    this.mediaType = mediaType
  }
}

export function isOdtOpenError(err: unknown, code?: OdtOpenErrorCode): err is OdtOpenError {
  return err instanceof OdtOpenError && (code === undefined || err.code === code)
}
