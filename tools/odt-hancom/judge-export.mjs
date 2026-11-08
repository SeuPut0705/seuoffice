// Judges the docx->ODT exports in Hangul against the spec, criterion by criterion:
//   text, tables, pictures, footnotes  nothing missing (Hangul reading our ODT vs the docx)
//   paper, margins                     equal to the docx sections
//   font, size, lineSpacing            first body paragraph, Hangul reading our ODT vs Hangul
//                                      reading the docx itself
//   pages                              within 10% of the editor's page count
//   validator                          no ODF validator error
//
//   node tools/odt-hancom/judge-export.mjs [--corpus DIR] [--run DIR] [--editor-pages FILE]
//
// The editor's page count comes from the docs pagination-parity report (`npx vitest run
// tests/pagination-parity.test.ts` in apps/docs writes <repo>/.task/pagination-parity-report.md,
// column "Our pages"): the editor's own page layout. The app's PDF export page count
// (export.mjs) is shown beside it. Needs <run>/export/export.json, <run>/export/look and
// <run>/docx-look. Writes <run>/export/judge.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  REPO_ROOT,
  corpusDir,
  firstBodyShape,
  parseArgs,
  parseHwpml,
  readZip,
  runDir,
  squeeze,
} from './lib.mjs'

const opts = parseArgs()
corpusDir(opts)
const run = runDir(opts)
const exp = JSON.parse(readFileSync(join(run, 'export', 'export.json'), 'utf8'))
const lookDir = join(run, 'export', 'look')
const docxDir = join(run, 'docx-look')
const looks = JSON.parse(readFileSync(join(lookDir, 'look.json'), 'utf8'))
const docxLooks = existsSync(join(docxDir, 'look.json'))
  ? JSON.parse(readFileSync(join(docxDir, 'look.json'), 'utf8'))
  : {}
const validation = existsSync(join(run, 'validate.json'))
  ? JSON.parse(readFileSync(join(run, 'validate.json'), 'utf8'))
  : null
const editorPages = parityPages(
  String(opts['editor-pages'] || join(REPO_ROOT, '.task', 'pagination-parity-report.md')),
)

export const CRITERIA = [
  'text',
  'tables',
  'pictures',
  'footnotes',
  'paper',
  'margins',
  'font',
  'size',
  'lineSpacing',
  'pages',
  'validator',
]

/** "Our pages" per document from the pagination-parity report's table against LibreOffice. */
function parityPages(file) {
  if (!existsSync(file)) return {}
  const out = {}
  const md = readFileSync(file, 'utf8')
  const from = md.indexOf('## Per-document details (vs LO)')
  if (from < 0) return out
  const to = md.indexOf('\n## ', from + 1)
  const part = md.slice(from, to < 0 ? undefined : to)
  for (const m of part.matchAll(/^\| ([\w.-]+) \| (\d+) \| (\d+) \|/gm)) out[m[1]] = Number(m[3])
  return out
}

const read = (dir, name) => {
  const f = join(dir, 'hwpml', `${name}.xml`)
  return existsSync(f) ? parseHwpml(readFileSync(f, 'utf8')) : null
}

/** Lines of a (squeezed) not found in b, searched in order, then anywhere. */
function missingLines(a, b) {
  const hay = squeeze(b)
  let pos = 0
  const missing = []
  for (const line of a.split(/\r?\n/).map(squeeze).filter(Boolean)) {
    let at = hay.indexOf(line, pos)
    if (at < 0) at = hay.indexOf(line)
    if (at < 0) missing.push(line)
    else pos = at + line.length
  }
  return missing
}

/** fo:line-height of the first body paragraph's style chain in our ODT (what we wrote). */
function writtenLineHeight(odtFile) {
  const zip = readZip(readFileSync(odtFile))
  const content = zip.get('content.xml')?.toString('utf8') ?? ''
  const styles = zip.get('styles.xml')?.toString('utf8') ?? ''
  const body = content.slice(content.indexOf('<office:text'))
  const p = /<text:(?:p|h) text:style-name="([^"]+)"[^>]*>(?!<\/text:)/.exec(body)
  if (!p) return null
  const all = content + styles
  let name = p[1]
  for (let i = 0; i < 8 && name; i++) {
    const at = all.indexOf(`style:name="${name}"`)
    if (at < 0) return null
    const end = all.indexOf('</style:style>', at)
    const chunk = all.slice(at, end)
    const lh = /fo:line-height="([^"]+)"/.exec(chunk)
    if (lh) return lh[1]
    name = /style:parent-style-name="([^"]+)"/.exec(all.slice(at, all.indexOf('>', at)))?.[1]
  }
  return null
}

const rows = {}
const tally = Object.fromEntries(CRITERIA.map((c) => [c, { pass: 0, fail: 0 }]))
let allPass = 0
for (const [name, row] of Object.entries(exp)) {
  const stem = basename(name, '.docx')
  const odtName = `${stem}.odt`
  const look = looks[odtName]
  const fails = {}
  const fail = (c, why) => (fails[c] ??= []).push(why)
  const facts = {}
  if (row.odt.status !== 'ok') CRITERIA.forEach((c) => fail(c, `convert failed: ${row.odt.error}`))
  else if (!look?.opened) CRITERIA.forEach((c) => fail(c, 'Hancom does not open the ODT'))
  else {
    const h = read(lookDir, odtName)
    const hd = read(docxDir, name)
    const d = row.docx
    const miss = missingLines(d.text, look.text)
    if (miss.length) fail('text', `${miss.length} lines missing, e.g. "${miss[0].slice(0, 40)}"`)
    const tables = h ? h.tables.filter((t) => !t.zone).length : look.tables
    facts.tables = [d.tables, tables]
    if (tables !== d.tables) fail('tables', `tables ${d.tables} -> ${tables}`)
    const pictures = h?.pictures.length ?? 0
    facts.pictures = [d.pictures, pictures]
    if (pictures < d.pictures) fail('pictures', `pictures ${d.pictures} -> ${pictures}`)
    const notes = d.notes.filter((n) => n.kind === 'footnote')
    facts.footnotes = [notes.length, h?.footnotes.length ?? 0]
    if (h && h.footnotes.length !== notes.length)
      fail('footnotes', `footnotes ${notes.length} -> ${h.footnotes.length}`)
    if (h) {
      const all = squeeze(h.footnotes.join('\n'))
      const lost = notes.find((n) => !all.includes(squeeze(n.text.replace(/^\d+\s*/, ''))))
      if (lost) fail('footnotes', `footnote text missing: "${lost.text.slice(0, 40)}"`)
      facts.sections = [d.sections.length, h.sections.length]
      if (h.sections.length !== d.sections.length)
        fail('paper', `sections ${d.sections.length} -> ${h.sections.length}`)
      d.sections.forEach((s, i) => {
        const p = h.sections[i]
        if (!p) return
        const near = (x, y) => Math.abs(x - y) <= 15
        const sorted = (a, b) => [Math.min(a, b), Math.max(a, b)]
        const [pw, ph] = sorted(p.width, p.height)
        const [sw, sh] = sorted(s.width * 5, s.height * 5)
        if (!near(pw, sw) || !near(ph, sh))
          fail(
            'paper',
            `section ${i} paper ${p.width}x${p.height}, docx ${s.width * 5}x${s.height * 5}`,
          )
        const m = p.margin
        const want = {
          left: (s.margins.left + s.margins.gutter) * 5,
          right: s.margins.right * 5,
          top: s.margins.top * 5,
          bottom: s.margins.bottom * 5,
        }
        const got = {
          left: m.Left + m.Gutter,
          right: m.Right,
          top: m.Top + m.Header,
          bottom: m.Bottom + m.Footer,
        }
        for (const k of Object.keys(want))
          if (!near(got[k], want[k]))
            fail('margins', `section ${i} ${k} ${got[k]}, docx ${want[k]}`)
      })
    }
    const ours = h ? firstBodyShape(h) : null
    const ref = hd ? firstBodyShape(hd) : null
    facts.first = {
      ours,
      docxInHancom: ref,
      written: writtenLineHeight(join(run, 'export', 'odt', odtName)),
    }
    if (!ours || !ref)
      ['font', 'size', 'lineSpacing'].forEach((c) => fail(c, 'first body paragraph not found'))
    else {
      if (ours.fontHangul !== ref.fontHangul || ours.fontLatin !== ref.fontLatin)
        fail('font', `${ref.fontHangul}/${ref.fontLatin} -> ${ours.fontHangul}/${ours.fontLatin}`)
      if (ours.height !== ref.height) fail('size', `${ref.height} -> ${ours.height}`)
      if (ours.lineSpacing !== ref.lineSpacing || ours.lineSpacingType !== ref.lineSpacingType)
        fail(
          'lineSpacing',
          `${ref.lineSpacing}${ref.lineSpacingType} -> ${ours.lineSpacing}${ours.lineSpacingType} (written ${facts.first.written})`,
        )
    }
    const editor = editorPages[stem]
    facts.pages = {
      editor,
      hancom: look.pages,
      appPdf: row.pdf?.pages ?? null,
      docxInHancom: docxLooks[name]?.pages ?? null,
    }
    if (!editor) fail('pages', 'no editor page count')
    else if (Math.abs(look.pages - editor) / editor > 0.1)
      fail('pages', `Hancom ${look.pages}, editor ${editor}`)
  }
  const v = validation?.export?.[odtName]
  facts.validator = v?.errors ?? null
  if (!v) fail('validator', 'not validated')
  else if (v.errors > 0)
    fail('validator', `${v.errors} errors (${v.messages.slice(0, 2).join(' | ')})`)
  for (const c of CRITERIA) tally[c][fails[c] ? 'fail' : 'pass']++
  if (!Object.keys(fails).length) allPass++
  rows[name] = {
    verdict: Object.keys(fails).length ? 'fail' : 'pass',
    fails,
    facts,
    convertMs: row.odt.ms,
    report: row.odt.report,
  }
}
writeFileSync(join(run, 'export', 'judge.json'), JSON.stringify({ tally, allPass, rows }, null, 1))
for (const [name, r] of Object.entries(rows))
  console.log(
    `${r.verdict.padEnd(4)} ${name.padEnd(30)} ${JSON.stringify(r.facts.pages ?? {})} ${Object.entries(
      r.fails,
    )
      .map(([c, w]) => `${c}: ${w.join(', ')}`)
      .join('; ')}`,
  )
console.log(
  Object.entries(tally)
    .map(([c, t]) => `${c} ${t.pass}/${t.pass + t.fail}`)
    .join(' | '),
)
console.log(`export: ${allPass}/${Object.keys(rows).length} pass every criterion`)
