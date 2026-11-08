import { reportError, type WebDocument } from '@seuoffice/web-platform'
import { createHash } from '@seuoffice/web-platform/shims/crypto'
import {
  DocxDecryptError,
  decryptDocx,
  isCfbFile,
  isEncryptedDocx,
  rememberDocPassword,
} from '../main/docx-encryption'
import type { DecryptOpenResult, OpenDocxResult, OpenFileResult } from '../shared/ipc'

/** A page holds one renderer: its id in the desktop module's per-renderer password state */
export const WEB_RENDERER = 0

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // crypto.subtle only exists in secure contexts; a plain-http host falls back to the pure-JS hash
  if (globalThis.crypto?.subtle) {
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)))
  }
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The renderer's open result over `plain`, the docx it shows: `dataUrl` is
 * fetched once by the renderer, here a blob URL over the whole file (the lazy
 * per-image media scheme is a desktop-only path). `hash` stays the stored file's.
 */
async function openResult(
  doc: WebDocument,
  plain: Uint8Array,
  encrypted: boolean,
): Promise<OpenFileResult> {
  return {
    path: doc.virtualPath,
    name: doc.fileName,
    dataUrl: URL.createObjectURL(new Blob([plain as BlobPart])),
    hash: await sha256Hex(doc.bytes),
    encrypted,
    recovered: false,
  }
}

/**
 * Hands a web document to the renderer the way the desktop main process does:
 * a password-protected docx comes back as a password request, which the
 * renderer answers through openDocxDecrypt.
 */
export async function openDocxFromBytes(doc: WebDocument): Promise<OpenDocxResult> {
  const bytes = Buffer.from(doc.bytes)
  if (isEncryptedDocx(bytes)) {
    return { needsPassword: true, path: doc.virtualPath, name: doc.fileName }
  }
  if (isCfbFile(bytes)) {
    reportError('open_failed', 'not a docx: an OLE2 file without an encrypted package')
    return null
  }
  rememberDocPassword(WEB_RENDERER, doc.virtualPath, null)
  return openResult(doc, doc.bytes, false)
}

/** The desktop decrypt-and-open over the page's bytes; a wrong password keeps the prompt open */
export async function openDecryptedDocx(
  doc: WebDocument,
  password: string,
): Promise<DecryptOpenResult> {
  const bytes = Buffer.from(doc.bytes)
  if (!isEncryptedDocx(bytes)) return { ok: false, reason: 'error', error: 'not encrypted' }
  try {
    const plain = await decryptDocx(bytes, password)
    rememberDocPassword(WEB_RENDERER, doc.virtualPath, password)
    return { ok: true, result: await openResult(doc, plain, true) }
  } catch (err) {
    if (err instanceof DocxDecryptError)
      return { ok: false, reason: err.reason, error: err.message }
    return { ok: false, reason: 'error', error: String(err) }
  }
}
