// New-document ODT export: converts every docx of <corpus>/docx to ODT with this checkout's CLI
// (`convert --to odt`) and to PDF through this checkout's app (`convert --to pdf`, the editor's
// own pagination), and records what the docx holds for the judge.
//
//   node tools/odt-hancom/export.mjs [--corpus DIR] [--run DIR] [--only REGEX] [--no-pdf]
//
// The PDF export starts the app: with a checkout the CLI runs <repo>/node_modules/electron on
// apps/shell (build it first: `npm run build -w @genoffice/docs` and `-w @genoffice/shell`), or
// the binary GENOFFICE_APP_BIN names. Output under <run>/export: odt/, pdf/, export.json.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { corpusDir, parseArgs, readZip, runCli, runDir } from './lib.mjs'

const opts = parseArgs()
const corpus = corpusDir(opts)
const run = runDir(opts)
const only = opts.only ? new RegExp(String(opts.only), 'i') : null
const out = join(run, 'export')
for (const d of ['odt', 'pdf']) mkdirSync(join(out, d), { recursive: true })
const resultFile = join(out, 'export.json')
const results = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : {}

const docxDir = join(corpus, 'docx')
const files = readdirSync(docxDir).filter((n) => /\.docx$/i.test(n) && (!only || only.test(n)))
for (const name of files) {
  const src = join(docxDir, name)
  const stem = basename(name, '.docx')
  const row = { name }
  const odt = await runCli([
    'convert',
    src,
    '--to',
    'odt',
    '--out',
    join(out, 'odt', `${stem}.odt`),
    '--force',
    '--json',
  ])
  row.odt = {
    status: odt.json?.status ?? `exit ${odt.code}`,
    ms: odt.ms,
    warnings: odt.json?.warnings ?? [],
    report: odt.json?.detail?.odt_report ?? null,
    error: odt.json?.status === 'ok' ? undefined : (odt.json?.message ?? odt.stderr).slice(0, 300),
  }
  if (!opts['no-pdf']) {
    const pdfPath = join(out, 'pdf', `${stem}.pdf`)
    const pdf = await runCli(['convert', src, '--to', 'pdf', '--out', pdfPath, '--force', '--json'])
    row.pdf = { status: pdf.json?.status ?? `exit ${pdf.code}`, ms: pdf.ms }
    if (pdf.json?.status === 'ok') {
      const info = await runCli(['pdf', 'read', pdfPath, '--json', '--range', '1-1'])
      row.pdf.pages = info.json?.detail?.pages ?? null
    } else row.pdf.error = (pdf.json?.message ?? pdf.stderr).slice(0, 300)
  }
  row.docx = await docxFacts(src)
  results[name] = row
  writeFileSync(resultFile, JSON.stringify(results, null, 1))
  console.log(name.padEnd(30), row.odt.status, row.odt.ms, row.pdf?.pages ?? '', row.pdf?.ms ?? '')
}

/** What the docx holds: the editor's text, tables, pictures, notes and page setup. */
async function docxFacts(src) {
  const read = await runCli(['docs', 'read', src, '--json', '--full', '--notes', '--sections'])
  const d = read.json?.detail ?? {}
  const zip = readZip(readFileSync(src))
  const body = zip.get('word/document.xml')?.toString('utf8') ?? ''
  const count = (rx) => (body.match(rx) ?? []).length
  return {
    text: (d.items ?? []).map((b) => b.text ?? '').join('\n'),
    blocks: d.items?.length ?? 0,
    tables: count(/<w:tbl>/g),
    pictures: count(/<pic:pic\b/g) + count(/<v:imagedata\b/g),
    notes: (d.notes ?? []).map((n) => ({ kind: n.kind, text: n.text })),
    sections: d.sections ?? [],
  }
}
