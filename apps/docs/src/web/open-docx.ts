import { reportError, type WebDocument } from '@seuoffice/web-platform'
import { createHash } from '@seuoffice/web-platform/shims/crypto'
import type { OpenDocxResult } from '../shared/ipc'

// OLE2/CFB header: a password-protected OOXML file is wrapped in one
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

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
 * Hands a web document to the renderer the way the desktop main process does:
 * `dataUrl` is fetched once by the renderer, here a blob URL over the whole
 * file (the lazy per-image media scheme is a desktop-only path).
 */
export async function openDocxFromBytes(doc: WebDocument): Promise<OpenDocxResult> {
  if (CFB_MAGIC.every((b, i) => doc.bytes[i] === b)) {
    reportError('open_failed', 'encrypted documents are not supported on the web yet')
    return null
  }
  return {
    path: doc.virtualPath,
    name: doc.fileName,
    dataUrl: URL.createObjectURL(new Blob([doc.bytes as BlobPart])),
    hash: await sha256Hex(doc.bytes),
    encrypted: false,
    recovered: false,
  }
}
