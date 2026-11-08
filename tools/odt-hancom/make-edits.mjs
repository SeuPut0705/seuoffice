// Makes the edited copies of every received ODT through this checkout's CLI (`docs apply`, the
// real path), one edit kind per output file, and records what each copy should show in Hangul.
//
//   node tools/odt-hancom/make-edits.mjs [--corpus DIR] [--run DIR] [--sets hancom,gov]
//        [--kinds none,text,...] [--only REGEX] [--jobs 3] [--src FOLDER]
//
// Output: <run>/edits/<kind>/<file>.odt, <run>/read/<stem>.json (the CLI's reading of the
// received file) and <run>/edits/manifest.json: per kind and file the ops, marks and expected
// changes, or the reason it was skipped. Kinds:
//   none      an unedited save: open and save, nothing changed (engine API: save-unedited.mts)
//   noop      the CLI path with an edit that changes nothing (a text replaced with itself)
//   text      text appended to part of a paragraph, then bold + red on that part
//   para      a new paragraph, centered, bold, 14pt
//   cell      text appended to an unlocked table cell (engine API, no CLI op: cell-edit.mts)
//   rowadd    a table row added (records whether the table sits in a Hancom frame)
//   rowdel    a table row deleted
//   merge     two side-by-side cells merged
//   picins    a picture inserted
//   picrep    a picture replaced (engine API, no CLI op: replace-picture.mts)
//   header    header (or footer) text edited
//   footnote  footnote text edited
//   margin    left/right margins of every section +1cm
//   paper     paper size changed (A4 <-> B5)
//   orient    orientation flipped
//   field     typed text inside a click-here form field (NormalField bookmark) replaced
//   secmargin left margin of the second section only (shared master page cloning)
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import {
  REPO_ROOT,
  TOOL_DIR,
  corpusDir,
  lastJsonLine,
  parseArgs,
  pool,
  readZip,
  requireCli,
  runCli,
  runDir,
} from './lib.mjs'
import { MARK_TEXT, PARA_TEXT } from './marks.mjs'

const MARK = MARK_TEXT
export const KINDS = [
  'none',
  'noop',
  'text',
  'para',
  'cell',
  'rowadd',
  'rowdel',
  'merge',
  'picins',
  'picrep',
  'header',
  'footnote',
  'margin',
  'paper',
  'orient',
  'field',
  'secmargin',
]
const ONE_CM = 567 // twips

const opts = parseArgs()
const corpus = corpusDir(opts)
const run = runDir(opts)
const sets = String(opts.sets || 'hancom,gov').split(',')
const kinds = opts.kinds ? String(opts.kinds).split(',') : KINDS
const only = opts.only ? new RegExp(String(opts.only), 'i') : null
const jobs = Number(opts.jobs || 3)
requireCli()

mkdirSync(join(run, 'read'), { recursive: true })
for (const k of kinds) mkdirSync(join(run, 'edits', k), { recursive: true })
const picture = join(run, 'edits', 'picture.png')
writeFileSync(picture, makePng(96, 48))

const manifestFile = join(run, 'edits', 'manifest.json')
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {}
// --src <folder> takes the ODTs of one folder instead of the corpus sets (e.g. ODTs from
// other programs, or this checkout's own docx->ODT exports)
const sources = opts.src ? [resolve(String(opts.src))] : sets.map((set) => join(corpus, set))
const files = sources.flatMap((dir) =>
  readdir(dir)
    .filter((n) => /\.odt$/i.test(n) && (!only || only.test(n)))
    .map((n) => join(dir, n)),
)

const began = Date.now()
await pool(files, jobs, async (file) => {
  const name = basename(file)
  const read = await readDoc(file)
  for (const kind of kinds) {
    const entry = await makeKind(kind, file, read)
    ;(manifest[kind] ??= {})[name] = entry
    console.log(kind.padEnd(9), name.padEnd(32), entry.status, entry.reason ?? '', entry.ms ?? '')
  }
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 1))
})
writeFileSync(manifestFile, JSON.stringify(manifest, null, 1))
console.log(`done in ${((Date.now() - began) / 1000).toFixed(0)}s`)

function readdir(dir) {
  return existsSync(dir) ? readdirSync(dir) : []
}

// ---- reading the received file ----

async function readDoc(file) {
  const stem = basename(file, '.odt')
  const cache = join(run, 'read', `${stem}.json`)
  let detail
  if (existsSync(cache)) detail = JSON.parse(readFileSync(cache, 'utf8'))
  else {
    const r = await runCli([
      'docs',
      'read',
      file,
      '--json',
      '--full',
      '--html',
      '--header-footer',
      '--notes',
      '--sections',
    ])
    if (r.json?.status !== 'ok') throw new Error(`docs read ${file}: ${r.stdout || r.stderr}`)
    detail = r.json.detail
    writeFileSync(cache, JSON.stringify(detail))
  }
  const items = detail.items
  const all = items.map((b) => b.text ?? '').join('\u0001')
  const count = (s) => all.split(s).length - 1
  const zip = readZip(readFileSync(file))
  const content = zip.get('content.xml')?.toString('utf8') ?? ''
  const styles = zip.get('styles.xml')?.toString('utf8') ?? ''
  return { detail, items, all, count, cells: tableCells(detail.html ?? ''), content, styles }
}

/** Cell texts of every table in the restricted HTML the CLI reads out. */
function tableCells(html) {
  const out = []
  for (const m of html.matchAll(/<t[dh]>([\s\S]*?)<\/t[dh]>/g)) {
    const text = m[1]
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
    out.push(text)
  }
  return out
}

/**
 * Tails of a paragraph's last line to anchor a find-and-replace on, longest first: each occurs
 * once in that paragraph (findReplace is scoped to the block and matches inside one run, so
 * short tails are tried too).
 */
function tails(text) {
  const line =
    (text ?? '')
      .split('\n')
      .filter((l) => l.trim())
      .pop()
      ?.trimEnd() ?? ''
  const once = (s) => line.split(s).length === 2
  const out = []
  for (const n of [12, 8, 6, 4, 3, 2, 1]) {
    if (line.length < n) continue
    const s = line.slice(-n)
    if (/^\s/.test(s) || /\t/.test(s)) continue
    if (once(s) && !out.includes(s)) out.push(s)
  }
  return out
}

// ---- one kind ----

async function makeKind(kind, file, doc) {
  const name = basename(file)
  const out = join(run, 'edits', kind, name)
  if (kind === 'none') return engineEdit('save-unedited.mts', [file, out], {})
  if (kind === 'picrep')
    return engineEdit('replace-picture.mts', [file, out, picture], { pictures: 0, replaced: true })
  if (kind === 'cell') {
    if (!doc.items.some((b) => b.type === 'table')) return { status: 'skip', reason: 'no table' }
    return engineEdit('cell-edit.mts', [file, out, '--append', MARK.cell], {
      marks: [MARK.cell],
      added: MARK.cell,
    })
  }
  const plan = planKind(kind, doc)
  if (!plan.candidates.length) return { status: 'skip', reason: plan.skip ?? 'no candidate' }
  const tries = []
  for (const c of plan.candidates.slice(0, 8)) {
    const opsFile = join(run, 'edits', kind, `${name}.ops.json`)
    writeFileSync(opsFile, JSON.stringify(c.ops))
    const r = await runCli([
      'docs',
      'apply',
      file,
      '--ops',
      opsFile,
      '--out',
      out,
      '--force',
      '--json',
    ])
    if (r.json?.status === 'ok') {
      const entry = {
        status: 'made',
        ops: c.ops,
        expect: c.expect ?? {},
        ms: r.ms,
        tries: tries.length,
      }
      if (kind === 'noop')
        entry.sameBytes = Buffer.compare(readFileSync(file), readFileSync(out)) === 0
      if (kind === 'rowadd') entry.framed = framedEdit(doc.content, out)
      if (kind === 'paper' || kind === 'orient' || kind === 'margin' || kind === 'secmargin') {
        const after = await runCli(['docs', 'read', out, '--json', '--sections', '--range', '0-0'])
        entry.sectionsAfter = after.json?.detail?.sections ?? null
      }
      return entry
    }
    tries.push({
      ops: c.ops,
      error: r.json?.error ?? `exit ${r.code}`,
      message: (r.json?.message ?? r.stderr).slice(0, 300),
    })
  }
  if (kind === 'field') {
    // the field sits in a table cell: type there the way the editor saves a cell edit
    for (const c of plan.candidates) {
      const r = await engineEdit(
        'cell-edit.mts',
        [file, out, '--replace', c.expect.replaced, MARK.field],
        c.expect,
      )
      if (r.status === 'made') return { ...r, ops: c.ops, cliTries: tries.length }
    }
  }
  // refusing to touch cells the author locked is the intended answer, not a failure
  if (
    tries.length &&
    tries.every((t) => t.error === 'op_rejected' && /protected cell/.test(t.message))
  )
    return { status: 'skip', reason: 'every candidate touches a locked cell (op_rejected)', tries }
  return { status: 'fail', reason: 'every candidate rejected', tries }
}

function planKind(kind, doc) {
  const { items } = doc
  const paragraphs = items.filter((b) => b.type === 'paragraph' && (b.text ?? '').trim())
  // every text block outside tables (findReplace reaches paragraphs, list items and headings)
  const texts = items.filter((b) => b.type !== 'table' && (b.text ?? '').trim())
  const tables = items.filter((b) => b.type === 'table')
  const target = (i) => ({ blockIndexes: [i] })
  switch (kind) {
    case 'noop': {
      // findReplace of a text with itself: the batch applies, nothing changes
      return {
        candidates: texts.slice(0, 8).map((b) => {
          const s = [...b.text.trim()].slice(0, 2).join('')
          return { ops: [{ op: 'findReplace', find: s, replace: s, target: target(b.index) }] }
        }),
        skip: 'no paragraph text outside tables',
      }
    }
    case 'text': {
      const anchors = [...texts.flatMap((b) => tails(b.text).map((s) => ({ s, i: b.index })))]
      return {
        candidates: anchors.map(({ s, i }) => ({
          ops: [
            { op: 'findReplace', find: s, replace: s + MARK.text, target: target(i) },
            { op: 'setMatchedFont', text: MARK.text, bold: true, color: '#C00000' },
          ],
          expect: { marks: [MARK.text], added: MARK.text, shape: { bold: 1, color: 0x0000c0 } },
        })),
      }
    }
    case 'para': {
      const text = PARA_TEXT
      const make = (after) => {
        const at = after === undefined ? items.length : after + 1
        return {
          ops: [
            {
              op: 'insert_content',
              html: `<p>${text}</p>`,
              ...(after === undefined ? {} : { afterBlockIndex: after }),
            },
            { op: 'setParagraphFormat', target: target(at), align: 'center' },
            { op: 'setFont', target: target(at), bold: true, fontSize: 14 },
          ],
          expect: { marks: [MARK.para], added: text, shape: { bold: 1, height: 1400, align: 3 } },
        }
      }
      return {
        candidates: [...(paragraphs.length ? [make(paragraphs[0].index)] : []), make(undefined)],
      }
    }
    case 'rowadd':
      return {
        candidates: rankTables(tables).map((t) => ({
          ops: [
            {
              op: 'insertTableRow',
              target: target(t.index),
              row: t.table.rows - 1,
              position: 'after',
            },
          ],
          expect: { rows: +1, tableBlock: t.index },
        })),
        skip: 'no table',
      }
    case 'rowdel':
      return {
        candidates: rankTables(tables.filter((t) => t.table.rows >= 2)).flatMap((t) =>
          freeRows(t.table).map((row) => ({
            ops: [{ op: 'deleteTableRow', target: target(t.index), row }],
            expect: { rows: -1, tableBlock: t.index, row },
          })),
        ),
        skip: tables.length ? 'no table with two rows' : 'no table',
      }
    case 'merge':
      return {
        candidates: rankTables(tables.filter((t) => t.table.cols >= 2)).flatMap((t) =>
          freePairs(t.table).map(([row, col]) => ({
            ops: [
              {
                op: 'mergeTableCells',
                target: target(t.index),
                range: { row, col, colEnd: col + 1 },
              },
            ],
            expect: { cells: -1, tableBlock: t.index },
          })),
        ),
        skip: tables.length ? 'no two unmerged side-by-side cells' : 'no table',
      }
    case 'picins': {
      const make = (after) => ({
        ops: [
          {
            op: 'insert_image',
            url: picture,
            ...(after === undefined ? {} : { afterBlockIndex: after }),
          },
        ],
        expect: { pictures: +1 },
      })
      return {
        candidates: [...(paragraphs.length ? [make(paragraphs[0].index)] : []), make(undefined)],
      }
    }
    case 'header': {
      const hf = doc.detail.headerFooter ?? {}
      const has = (k) => new RegExp(`<style:${k}[ >]`).test(doc.styles) || (hf[k] ?? '').trim()
      const kindHf = has('header') ? 'header' : has('footer') ? 'footer' : null
      if (!kindHf) return { candidates: [], skip: 'no header or footer' }
      const text = `${(hf[kindHf] ?? '').trim()} ${MARK.header}`.trim()
      return {
        candidates: [
          {
            ops: [{ op: 'set_header_footer', kind: kindHf, text }],
            expect: { hfMark: MARK.header, region: kindHf },
          },
        ],
      }
    }
    case 'footnote': {
      const notes = doc.detail.notes ?? []
      if (!notes.length) return { candidates: [], skip: 'no footnote' }
      const out = []
      // edit_note replaces inside that one note: the anchor only has to be unique in it
      for (const n of notes) {
        for (const s of tails(n.text).slice(0, 2))
          out.push({
            ops: [{ op: 'edit_note', kind: n.kind, id: n.id, find: s, replace: s + MARK.footnote }],
            expect: { noteMark: MARK.footnote },
          })
        if (out.length >= 8) break
      }
      return { candidates: out, skip: 'no editable footnote text' }
    }
    case 'margin': {
      const s = doc.detail.sections?.[0]
      if (!s) return { candidates: [], skip: 'no section' }
      return {
        candidates: [
          {
            ops: [
              {
                op: 'set_page_setup',
                margins: { left: s.margins.left + ONE_CM, right: s.margins.right + ONE_CM },
              },
            ],
            expect: { margin: { left: s.margins.left + ONE_CM, right: s.margins.right + ONE_CM } },
          },
        ],
      }
    }
    case 'paper': {
      const s = doc.detail.sections?.[0]
      if (!s) return { candidates: [], skip: 'no section' }
      const paper = s.paper === 'A4' ? 'B5' : 'A4'
      return { candidates: [{ ops: [{ op: 'set_page_setup', paper }], expect: { paper } }] }
    }
    case 'orient': {
      const s = doc.detail.sections?.[0]
      if (!s) return { candidates: [], skip: 'no section' }
      const orientation = s.orientation === 'landscape' ? 'portrait' : 'landscape'
      return {
        candidates: [{ ops: [{ op: 'set_page_setup', orientation }], expect: { orientation } }],
      }
    }
    case 'field': {
      const fields = formFields(doc.content)
      if (!fields.length) return { candidates: [], skip: 'no form field' }
      const out = []
      for (const f of fields) {
        const t = f.text
        if (t.trim().length < 2 || /\n/.test(t) || doc.count(t) !== 1) continue
        out.push({
          ops: [{ op: 'findReplace', find: t, replace: MARK.field }],
          expect: { field: f.name, fieldText: MARK.field, replaced: t },
        })
      }
      return { candidates: out, skip: 'no form field with unique typed text' }
    }
    case 'secmargin': {
      const secs = doc.detail.sections ?? []
      if (secs.length < 2) return { candidates: [], skip: 'one section' }
      const s = secs[1]
      return {
        candidates: [
          {
            ops: [{ op: 'set_page_setup', section: 1, margins: { left: s.margins.left + ONE_CM } }],
            expect: { section: 1, left: s.margins.left + ONE_CM, sections: secs.length },
          },
        ],
      }
    }
  }
  return { candidates: [] }
}

/** Tables with several rows first (a row edit then has neighbours), in document order. */
function rankTables(tables) {
  return [
    ...tables.filter((t) => t.table.rows >= 2),
    ...tables.filter((t) => t.table.rows < 2),
  ].slice(0, 6)
}

function covered(table, row, col) {
  return (table.merged ?? []).some(
    (m) => row >= m.row && row < m.row + m.rowSpan && col >= m.col && col < m.col + m.colSpan,
  )
}

/** Rows no vertical merge crosses, last first. */
function freeRows(table) {
  const out = []
  for (let r = table.rows - 1; r >= 0 && out.length < 3; r--) {
    const crossed = (table.merged ?? []).some(
      (m) => m.rowSpan > 1 && r >= m.row && r < m.row + m.rowSpan,
    )
    if (!crossed) out.push(r)
  }
  return out
}

/** Side-by-side cells outside every merge. */
function freePairs(table) {
  const out = []
  for (let r = 0; r < table.rows && out.length < 3; r++) {
    for (let c = 0; c + 1 < table.cols; c++) {
      if (!covered(table, r, c) && !covered(table, r, c + 1)) {
        out.push([r, c])
        break
      }
    }
  }
  return out
}

/** Click-here form fields: NormalField bookmark pairs and the text between them. */
function formFields(content) {
  const out = []
  const rx =
    /<text:bookmark-start text:name="(NormalField[^"]*)"\s*\/>([\s\S]*?)<text:bookmark-end text:name="\1"\s*\/>/g
  for (const m of content.matchAll(rx)) {
    const text = m[2]
      .replace(/<text:s(?: text:c="(\d+)")?\s*\/>/g, (_, n) => ' '.repeat(Number(n || 1)))
      .replace(/<text:tab\s*\/>/g, '\t')
      .replace(/<\/text:p>\s*<text:p[^>]*>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
    out.push({ name: m[1], text })
  }
  return out
}

/** Whether a row edit resized a Hancom frame: the output has more graphic styles. */
function framedEdit(originalContent, outFile) {
  const after = readZip(readFileSync(outFile)).get('content.xml')?.toString('utf8') ?? ''
  const graphic = (s) => (s.match(/style:family="graphic"/g) ?? []).length
  return graphic(after) > graphic(originalContent)
}

/** Runs one of the engine-API edit scripts (for edits the CLI has no op for) under tsx. */
function engineEdit(script, args, expect) {
  return new Promise((done) => {
    const began = Date.now()
    const tsx = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const child = spawn(process.execPath, [tsx, join(TOOL_DIR, script), ...args], {
      cwd: REPO_ROOT,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => {
      const json = lastJsonLine(stdout)
      const ms = Date.now() - began
      if (code === 0 && json?.status === 'ok')
        done({ status: 'made', via: `engine API (${script})`, edit: json, expect, ms })
      else if (json?.status === 'skip') done({ status: 'skip', reason: json.reason })
      else done({ status: 'fail', reason: (stderr || stdout).slice(0, 400), ms })
    })
  })
}

/** A small RGB PNG with a gradient (different bytes from any picture in the corpus). */
function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const p = y * (w * 3 + 1) + 1 + x * 3
      raw[p] = (40 + (x * 200) / w) | 0
      raw[p + 1] = 120
      raw[p + 2] = (220 - (y * 160) / h) | 0
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
