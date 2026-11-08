/**
 * Password-protected Office files for the editors that keep their document in
 * the main process (sheets, slides). The single integration point for the
 * third-party crypto implementation (officecrypto-tool), like the docs app's
 * docx-encryption module.
 *
 * An encrypted .xlsx/.xlsm/.pptx is not a zip: it is a CFB (OLE2) container
 * holding an EncryptionInfo stream and an EncryptedPackage stream (the real
 * zip, encrypted). A legacy .xls with an open password is a CFB whose Workbook
 * stream starts with a FILEPASS record; officecrypto-tool decrypts those too
 * (RC4 / RC4 CryptoAPI) and hands back a plain .xls.
 */
import officeCrypto from 'officecrypto-tool'

const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ENCRYPTED_STREAM_UTF16 = Buffer.from('EncryptedPackage', 'utf16le')

/**
 * Excel encrypts a workbook that only has a "password to modify" (or is
 * marked write-reserved) with this fixed password and opens it without asking.
 * Trying it first lets those files open like they do in Excel.
 */
const EXCEL_DEFAULT_PASSWORD = 'VelvetSweatshop'

export function isCfbHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && Buffer.from(bytes.buffer, bytes.byteOffset, 8).equals(CFB_MAGIC)
}

/** ECMA-376 encrypted OOXML: CFB magic + an EncryptedPackage stream in the directory. */
export function isEncryptedOoxml(bytes: Buffer): boolean {
  return isCfbHeader(bytes) && bytes.includes(ENCRYPTED_STREAM_UTF16)
}

/** Encrypted OOXML, or a legacy .xls/.doc/.ppt that carries an open password. */
export function isEncryptedOfficeFile(bytes: Buffer): boolean {
  if (!isCfbHeader(bytes)) return false
  if (bytes.includes(ENCRYPTED_STREAM_UTF16)) return true
  try {
    return officeCrypto.isEncrypted(bytes)
  } catch {
    // a CFB the library cannot walk is not something we can decrypt either
    return false
  }
}

export type OfficeDecryptFailReason = 'wrong-password' | 'unsupported'

export class OfficeDecryptError extends Error {
  readonly reason: OfficeDecryptFailReason
  constructor(reason: OfficeDecryptFailReason, message: string) {
    super(message)
    this.reason = reason
  }
}

/**
 * Decrypt to the plain file bytes. Throws OfficeDecryptError with reason
 * 'wrong-password' (verifier mismatch — ask again) or 'unsupported' (a scheme
 * the library cannot read, e.g. XOR obfuscation or Extensible encryption).
 */
export async function decryptOfficeFile(bytes: Buffer, password: string): Promise<Buffer> {
  try {
    return await officeCrypto.decrypt(bytes, { password })
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    if (message.includes('password is incorrect')) {
      throw new OfficeDecryptError('wrong-password', message)
    }
    throw new OfficeDecryptError('unsupported', message)
  }
}

/** Encrypt plain OOXML zip bytes with ECMA-376 Agile (the Office 2013+ default). */
export function encryptOoxml(bytes: Buffer, password: string): Buffer {
  return officeCrypto.encrypt(bytes, { password })
}

/** One prompt attempt: the typed password, or null when the user cancels. */
export type OfficePasswordAsk = (retry: boolean) => Promise<string | null>

export interface UnlockedOfficeFile {
  readonly bytes: Buffer
  /** the password that opened the file — re-encrypting with it keeps the saved
   *  file opening the way the original did */
  readonly password: string
  /** false when Excel's built-in default opened it: the user set no open password */
  readonly asked: boolean
}

/**
 * Open an encrypted Office file: try Excel's default password first, then ask
 * until the password is right. Resolves null when the user cancels; throws
 * OfficeDecryptError('unsupported') when no password can open it.
 */
export async function unlockOfficeFile(
  bytes: Buffer,
  ask: OfficePasswordAsk,
): Promise<UnlockedOfficeFile | null> {
  try {
    return {
      bytes: await decryptOfficeFile(bytes, EXCEL_DEFAULT_PASSWORD),
      password: EXCEL_DEFAULT_PASSWORD,
      asked: false,
    }
  } catch (err) {
    if (!(err instanceof OfficeDecryptError) || err.reason !== 'wrong-password') throw err
  }
  let retry = false
  for (;;) {
    const password = await ask(retry)
    if (password === null) return null
    // the library rejects an empty password as a usage error, not a mismatch
    if (password === '') {
      retry = true
      continue
    }
    try {
      return { bytes: await decryptOfficeFile(bytes, password), password, asked: true }
    } catch (err) {
      if (!(err instanceof OfficeDecryptError) || err.reason !== 'wrong-password') throw err
      retry = true
    }
  }
}
