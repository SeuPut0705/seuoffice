import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import { isOdtOpenError, OdtNotTextError } from '@seuoffice/odt-engine'
import { repoRoot } from '../docx-diff/harness'
import { odtToText } from './reference/odt'
import { parseFileToText } from './reference/parse'
import { pdfToText } from './reference/pdf'
import { xmindToText } from './reference/xmind'
import type { Input, Spec } from './spec'

/** The readers that await in the TypeScript run on the host before the call (crates/file-parse/src/parse.rs). */
const HOSTED: Record<string, (bytes: Uint8Array) => Promise<string>> = {
  pdf: pdfToText,
  xmind: xmindToText,
  odt: odtToText,
}

async function hostedRead(name: string, bytes: Uint8Array): Promise<unknown> {
  const reader = HOSTED[extname(name).slice(1).toLowerCase()]
  if (!reader) return undefined
  try {
    return { text: await reader(bytes) }
  } catch (error) {
    const thrown = error instanceof Error ? error : new Error(String(error))
    const code =
      isOdtOpenError(error) && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined
    const mediaType = error instanceof OdtNotTextError ? error.mediaType : undefined
    return {
      error: {
        name: thrown.name,
        message: thrown.message,
        ...(code ? { code } : {}),
        ...(mediaType ? { mediaType } : {}),
      },
    }
  }
}

/** Tracked files of each extension, at most `per` of each, smallest first. */
function trackedFiles(exts: readonly string[], per: number): string[] {
  // -z: a path outside ASCII comes out as it is, not quoted and escaped
  const listed = execFileSync('git', ['ls-files', '-z', ...exts.map((ext) => `*.${ext}`)], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const byExt = new Map<string, string[]>()
  for (const path of listed.split('\0').filter(Boolean)) {
    const ext = extname(path).slice(1).toLowerCase()
    byExt.set(ext, [...(byExt.get(ext) ?? []), path])
  }
  return [...byExt.values()].flatMap((paths) => paths.slice(0, per))
}

const utf16le = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf16le'))
const utf16be = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf16le').swap16())

async function zipOf(entries: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(entries)) zip.file(name, content)
  return zip.generateAsync({ type: 'uint8array' })
}

async function built(): Promise<Input[]> {
  const files: Array<[string, Uint8Array, Record<string, unknown>?]> = []
  for (const path of trackedFiles(
    [
      'docx',
      'doc',
      'pptx',
      'ppt',
      'xlsx',
      'xlsm',
      'hwp',
      'hwpx',
      'odt',
      'pdf',
      'xmind',
      'epub',
      'md',
      'txt',
      'csv',
      'json',
      'html',
      'drawio',
      'png',
      'svg',
    ],
    12,
  )) {
    files.push([basename(path), new Uint8Array(readFileSync(resolve(repoRoot, path)))])
  }
  const docx = files.find(([name]) => name.endsWith('.docx'))?.[1] ?? new Uint8Array()
  const pdf =
    files.find(([name]) => name.endsWith('.pdf'))?.[1] ?? new TextEncoder().encode('%PDF-1.4\n')
  const ole2 = Uint8Array.from([
    0xd0,
    0xcf,
    0x11,
    0xe0,
    0xa1,
    0xb1,
    0x1a,
    0xe1,
    ...utf16le('EncryptedPackage'),
  ])
  files.push(
    ['report.docx', pdf],
    ['report.pdf', docx],
    ['locked.xlsx', ole2],
    ['locked.pptx', Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0)],
    ['saved-as.doc', docx],
    ['old.ppt', docx],
    ['book.epub', pdf],
    ['map.xmind', pdf],
    ['text.odt', pdf],
    ['hangul.hwp', new TextEncoder().encode('HWP Document File V3.00')],
    ['hangul.hwpx', pdf],
    ['junk.hwp', pdf],
    ['junk-before.pdf', new TextEncoder().encode(`${'x'.repeat(1000)}%PDF-1.7`)],
    ['too-late.pdf', new TextEncoder().encode(`${'x'.repeat(1020)}%PDF-1.7`)],
    ['utf32be.txt', Uint8Array.of(0, 0, 0xfe, 0xff, 0, 0, 0, 0x61)],
    ['utf32le.csv', Uint8Array.of(0xff, 0xfe, 0, 0, 0x61, 0, 0, 0)],
    ['utf16le.txt', Uint8Array.from([0xff, 0xfe, ...utf16le('한국어 text')])],
    ['utf16le-odd.log', Uint8Array.from([0xff, 0xfe, ...utf16le('ab'), 0x63])],
    ['utf16be.md', Uint8Array.from([0xfe, 0xff, ...utf16be('# 제목\n본문')])],
    ['utf16be-twice.xml', Uint8Array.from([0xfe, 0xff, 0xfe, 0xff, ...utf16be('<a/>')])],
    ['bom-twice.py', Uint8Array.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x70])],
    ['latin1.txt', Uint8Array.of(0x63, 0x61, 0x66, 0xe9)],
    [
      'marked.md',
      new TextEncoder().encode('# Title\n\n<!-- gx:redact:Name -->Kim<!-- /gx:redact -->\n'),
    ],
    ['marked.html', new TextEncoder().encode('<p data-gx-redact="Name">Kim</p>')],
    ['marked.htm', new TextEncoder().encode('<p data-gx-redact>Kim</p>')],
    ['photo.PNG', Uint8Array.of(0x89, 0x50)],
    ['photo.jpeg', new Uint8Array()],
    ['anim.gif', new Uint8Array()],
    ['pic.webp', new Uint8Array()],
    ['archive.zip', docx],
    ['noext', docx],
    ['.hidden', docx],
    ['trailing.', docx],
    ['UPPER.DOCX', docx],
    ['dir/nested.Txt', new TextEncoder().encode('nested')],
    ['picture.drawio.png', Uint8Array.of(0x89, 0x50, 0x4e, 0x47)],
    ['picture.drawio.svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['broken.drawio', new TextEncoder().encode('<mxfile><diagram>not</mxfile>')],
    ['not-text.odt', await zipOf({ mimetype: 'application/vnd.oasis.opendocument.spreadsheet' })],
    ['no-mime.odt', await zipOf({ 'content.xml': '<x/>' })],
  )
  // a large zip read for its text parts only, and a small one read whole
  files.push(
    ['large.docx', docx, { wholeZipMaxBytes: 1024 }],
    ['budget.docx', docx, { maxChars: 40 }],
  )
  const inputs: Input[] = []
  for (const [name, bytes, options] of files) {
    const hosted = await hostedRead(name, bytes)
    const args = { ...(options ?? {}), ...(hosted === undefined ? {} : { hosted }) }
    inputs.push({ label: name, text: name, bytes, args, isolate: true })
  }
  return inputs
}

let scratch: string | undefined
let written = 0

export const SPECS: Spec[] = [
  {
    fn: 'parseFileToText',
    extensions: [],
    mutation: 'none',
    built,
    // the TypeScript reads a file: the bytes are written under the same base name
    call: async ({ text = '', bytes = new Uint8Array(), args = {} }) => {
      scratch ??= mkdtempSync(join(tmpdir(), 'parse-cases-'))
      const directory = join(scratch, String(written++))
      mkdirSync(directory)
      const path = join(directory, basename(text.replaceAll('\\', '/')))
      writeFileSync(path, bytes)
      const { maxChars, wholeZipMaxBytes } = args
      return parseFileToText(path, {
        ...(typeof maxChars === 'number' ? { maxChars } : {}),
        ...(typeof wholeZipMaxBytes === 'number' ? { wholeZipMaxBytes } : {}),
      })
    },
  },
]
