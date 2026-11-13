import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { LABEL, PLACEHOLDER, SECRET } from '../../docx-engine/tests/helpers/hidden-stories'
import { run, tempDir } from './helpers'

/**
 * Markdown and HTML pages with text a person hid from AI, as the markdown and HTML apps write
 * it. A Word copy of a Markdown file carries the hiding; a copy that cannot (an ODT, a printed
 * PDF) is refused, and so is any copy of a page whose hiding has no run to sit on (HTML). The
 * refusals are made before the SeuOffice app starts: the app is pointed at a program that does
 * not exist, so a route that gets past the check fails with "app not found" instead.
 */

const NO_APP = { env: { ...process.env, SEUOFFICE_APP_BIN: '/nonexistent/seuoffice' } }
const REFUSAL = 'hidden from AI'

const span = (attrs: string, words = SECRET) => `<span ${attrs}>${words}</span>`

/** how the markdown app writes the mark, and other spellings of the same span */
const MD_SPANS: Array<[string, string]> = [
  ['as the app writes it', span(`class="redact-span" data-redaction="" data-label="${LABEL}"`)],
  ['single quotes', span(`data-redaction data-label='${LABEL}'`)],
  ['no label', span('data-redaction')],
  ['upper case', span(`DATA-REDACTION="" DATA-LABEL="${LABEL}"`)],
  [
    'words that read like the placeholder',
    span(`data-redaction="" data-label="${LABEL}"`, PLACEHOLDER),
  ],
]

const mdWith = (marked: string) => `# Title\n\nCall ${marked} now.\n\nEdit me please.\n`

/** the three marks of the HTML app, and spellings of them */
const HTML_MARKS: Array<[string, string]> = [
  ['an element', `<p data-gx-redact="${LABEL}">${SECRET}</p>`],
  ['an element, upper case', `<p DATA-GX-REDACT='${LABEL}'>${SECRET}</p>`],
  ['an attribute', `<a href="x" data-gx-redact-href="${LABEL}" title="${SECRET}">link</a>`],
  ['a script literal', `<script>var phone = /*gx:redact:${LABEL}*/ "${SECRET}"</script>`],
]
const htmlWith = (marked: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><h1>Title</h1>${marked}<p>Edit me please</p></body></html>`

const messageOf = (stdout: string): string => {
  try {
    return JSON.parse(stdout).message ?? ''
  } catch {
    return ''
  }
}
const refused = (r: { code: number; stdout: string }) =>
  r.code !== 0 && messageOf(r.stdout).includes(REFUSAL)

function source(name: string, text: string | Buffer): string {
  const file = join(tempDir(), name)
  writeFileSync(file, text)
  return file
}

async function convert(file: string, to: string) {
  const out = join(tempDir(), `out.${to}`)
  const r = await run(['convert', file, '--to', to, '--out', out, '--json'], NO_APP)
  expect(r.stdout + r.stderr, `${to}: the answer`).not.toContain(SECRET)
  return { ...r, out }
}

async function expectRefused(file: string, to: string) {
  const r = await convert(file, to)
  expect(refused(r), `${to}: ${r.stdout}`).toBe(true)
  expect(existsSync(r.out)).toBe(false)
}

/** every part of a docx, as text */
async function docxParts(file: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(file))
  const parts = Object.keys(zip.files).filter((p) => /^word\/[^/]+\.xml$/.test(p))
  return (await Promise.all(parts.map((p) => zip.file(p)!.async('string')))).join('\n')
}

describe.each(MD_SPANS)('markdown with a span hidden from AI: %s', (name, marked) => {
  const words = name === 'words that read like the placeholder' ? PLACEHOLDER : SECRET

  it('md to docx carries the hiding: the words stay, every reader withholds them', async () => {
    const r = await convert(source('page.md', mdWith(marked)), 'docx')
    expect(r.code, r.stdout).toBe(0)
    const parts = await docxParts(r.out)
    expect(parts).toContain(words)
    expect(parts).toMatch(/redact/)
    const read = await run(['docs', 'read', r.out, '--full', '--html', '--json'])
    expect(read.stdout).not.toContain(SECRET)
    expect(read.stdout).toContain(name === 'no label' ? '{{private}}' : PLACEHOLDER)
    // the label survives when the page gave one
    if (name !== 'no label' && words === SECRET) expect(parts).toContain(LABEL)
  })

  it('create docx --from the page carries the hiding as well', async () => {
    const out = join(tempDir(), 'created.docx')
    const r = await run(
      [
        'create',
        '--type',
        'docx',
        '--from',
        source('page.md', mdWith(marked)),
        '--out',
        out,
        '--json',
      ],
      NO_APP,
    )
    expect(r.code, r.stdout).toBe(0)
    expect(await docxParts(out)).toMatch(/redact/)
  })

  it('md to html writes the hiding the HTML app reads', async () => {
    const r = await convert(source('page.md', mdWith(marked)), 'html')
    expect(r.code, r.stdout).toBe(0)
    const html = readFileSync(r.out, 'utf-8')
    expect(html).toMatch(/data-gx-redact=/)
    expect(html).not.toContain('data-redaction')
  })

  it.each(['odt', 'pdf'])('md to %s is refused', async (to) => {
    await expectRefused(source('page.md', mdWith(marked)), to)
  })

  it('create pdf --from the page is refused', async () => {
    const out = join(tempDir(), 'created.pdf')
    const r = await run(
      [
        'create',
        '--type',
        'pdf',
        '--from',
        source('page.md', mdWith(marked)),
        '--out',
        out,
        '--json',
      ],
      NO_APP,
    )
    expect(refused(r), r.stdout).toBe(true)
    expect(existsSync(out)).toBe(false)
  })

  it('render is refused', async () => {
    const r = await run(
      ['render', source('page.md', mdWith(marked)), '--out', join(tempDir(), 'png'), '--json'],
      NO_APP,
    )
    expect(refused(r), r.stdout).toBe(true)
  })
})

describe.each(HTML_MARKS)('an HTML page with %s hidden from AI', (_name, marked) => {
  it.each(['pdf', 'docx', 'odt'])('html to %s is refused', async (to) => {
    await expectRefused(source('page.html', htmlWith(marked)), to)
  })

  it('create docx --from the page is refused', async () => {
    const out = join(tempDir(), 'created.docx')
    const r = await run(
      [
        'create',
        '--type',
        'docx',
        '--from',
        source('page.html', htmlWith(marked)),
        '--out',
        out,
        '--json',
      ],
      NO_APP,
    )
    expect(refused(r), r.stdout).toBe(true)
    expect(existsSync(out)).toBe(false)
  })

  it('create pdf --from the page and render are refused', async () => {
    const file = source('page.html', htmlWith(marked))
    const created = await run(
      ['create', '--type', 'pdf', '--from', file, '--out', join(tempDir(), 'c.pdf'), '--json'],
      NO_APP,
    )
    expect(refused(created), created.stdout).toBe(true)
    const rendered = await run(['render', file, '--out', join(tempDir(), 'png'), '--json'], NO_APP)
    expect(refused(rendered), rendered.stdout).toBe(true)
  })

  it('is refused whatever the page declares for its encoding', async () => {
    const text = htmlWith(marked).replace('<meta charset="utf-8">', '')
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    await expectRefused(source('page16.html', utf16), 'docx')
  })
})

describe('pages that hold nothing hidden', () => {
  it('md to odt and to docx work as ever', async () => {
    const file = source('plain.md', '# Title\n\nHello\n')
    expect((await convert(file, 'odt')).code).toBe(0)
    expect((await convert(file, 'docx')).code).toBe(0)
  })

  it('html to pdf reaches the app', async () => {
    const r = await convert(source('plain.html', htmlWith('<p>Hello</p>')), 'pdf')
    expect(refused(r)).toBe(false)
    expect(r.code).not.toBe(0)
  })

  it('a page that talks about the attribute in plain words is not marked', async () => {
    const r = await convert(source('talk.html', htmlWith('<p>the data attribute</p>')), 'pdf')
    expect(refused(r)).toBe(false)
  })
})
