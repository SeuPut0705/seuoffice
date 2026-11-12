/**
 * CFB (OLE2 compound document) sniffing: legacy .ppt and encrypted OOXML (password-protected pptx) share the same magic number.
 * The latter has an EncryptedPackage stream in its directory (stream name in UTF-16LE), which is used to pick the message shown.
 * A file with that magic number whose container does not hold is neither: it is damaged.
 */
import { isDamagedCompoundFile } from '@genoffice/electron-utils/office-encryption'

const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ENCRYPTED_STREAM_UTF16 = Buffer.from('EncryptedPackage', 'utf16le')

export function isCfbHeader(head: Buffer): boolean {
  return head.length >= 8 && head.subarray(0, 8).equals(CFB_MAGIC)
}

/**
 * What a file with the CFB magic number is; null for any other file, which costs one
 * comparison. `damaged` comes first: a container the shared gate refuses opens with no
 * password, whatever stream names its bytes hold, so it is never reported as encrypted.
 */
export function cfbKind(bytes: Buffer): 'legacy' | 'encrypted' | 'damaged' | null {
  if (!isCfbHeader(bytes)) return null
  if (isDamagedCompoundFile(bytes)) return 'damaged'
  return bytes.includes(ENCRYPTED_STREAM_UTF16) ? 'encrypted' : 'legacy'
}
