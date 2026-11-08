/**
 * Add or remove a PDF's password with qpdf compiled to WebAssembly (the PDF
 * tools window, decision 0030). Runs in the shell's PDF job process; every
 * call starts a fresh qpdf instance, so one file's run never leaves state
 * behind for the next. The files live only in qpdf's in-memory file system.
 *
 * Passwords stay in this process: they are not written to disk, logged, or
 * put in an error message. qpdf cannot find out a password it is not given.
 *
 * This WebAssembly build cannot catch C++ exceptions, so qpdf's own recovery
 * of damaged files does not run; repair.ts uses PDFium for that.
 */
import { randomUUID } from 'node:crypto'
import createQpdf from '@neslinesli93/qpdf-wasm'

/** qpdf could not open the file with the password it was given */
export class WrongPasswordError extends Error {
  // the job process reports errors by name: this one reads as a password error
  override readonly name = 'PdfLoadError'
  readonly code = 'password-required'
  constructor() {
    super('the password does not open this PDF')
  }
}

export class QpdfFailedError extends Error {
  constructor() {
    super('qpdf could not write the file')
  }
}

const IN = '/in.pdf'
const OUT = '/out.pdf'

interface QpdfInstance {
  callMain(args: string[]): number
  FS: {
    writeFile(path: string, data: Uint8Array): void
    readFile(path: string): Uint8Array
  }
}

type CreateQpdf = (options: Record<string, unknown>) => Promise<QpdfInstance>

/** Run qpdf on `input` with `args` (IN and OUT stand for the files); its exit code and output */
async function run(
  wasmPath: string,
  input: Uint8Array,
  args: (pathOf: { in: string; out: string }) => string[],
): Promise<{ code: number; output: Uint8Array | null }> {
  const qpdf = await (createQpdf as unknown as CreateQpdf)({
    // this build takes no wasmBinary: it reads the file locateFile names, else
    // one beside its own script (not there once the job process is bundled)
    locateFile: () => wasmPath,
    noInitialRun: true,
    // emscripten writes argv[0] through an ASCII-only path
    thisProgram: 'qpdf',
    // this build prints to the console whatever these say; nothing it prints carries a password
    print: () => {},
    printErr: () => {},
  })
  qpdf.FS.writeFile(IN, input)
  let code: number
  try {
    code = qpdf.callMain(args({ in: IN, out: OUT }))
  } catch {
    code = 2
  }
  // 0: done; 3: done with warnings
  let output: Uint8Array | null = null
  if (code === 0 || code === 3) {
    try {
      output = Uint8Array.from(qpdf.FS.readFile(OUT))
    } catch {
      // qpdf said it was done but wrote nothing
      output = null
    }
  }
  return { code, output }
}

export interface EncryptOptions {
  /** asked for when the file is opened */
  userPassword: string
  /** printing, copying and changes are refused without this one; absent: no restrictions */
  ownerPassword?: string
}

/** `bytes` locked with AES-256 */
export async function encryptPdfBytes(
  wasmPath: string,
  bytes: Uint8Array,
  options: EncryptOptions,
): Promise<Uint8Array> {
  const restrict = options.ownerPassword !== undefined
  // with no restrictions, nobody needs the owner password: a random one
  const owner = options.ownerPassword ?? randomUUID()
  const result = await run(wasmPath, bytes, (p) => [
    '--encrypt',
    `--user-password=${options.userPassword}`,
    `--owner-password=${owner}`,
    '--bits=256',
    ...(restrict ? ['--print=none', '--modify=none', '--extract=n', '--annotate=n'] : []),
    '--',
    p.in,
    p.out,
  ])
  if (!result.output) throw new QpdfFailedError()
  return result.output
}

/** `bytes` without its password, opened with `password` */
export async function decryptPdfBytes(
  wasmPath: string,
  bytes: Uint8Array,
  password: string,
  /**
   * Whether the password opens the file (PDFium, repair.ts pdfiumOpens). This
   * build of qpdf prints its messages straight to the console, so a wrong
   * password is told apart from other failures this way, before qpdf runs.
   */
  opens: (bytes: Uint8Array, password: string) => 'ok' | 'wrong-password' | 'unreadable',
): Promise<Uint8Array> {
  if (opens(bytes, password) === 'wrong-password') throw new WrongPasswordError()
  const result = await run(wasmPath, bytes, (p) => [
    `--password=${password}`,
    '--decrypt',
    p.in,
    p.out,
  ])
  if (result.output) return result.output
  throw new QpdfFailedError()
}
