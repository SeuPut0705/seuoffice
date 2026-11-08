// Shared helpers for the Hancom acceptance scripts: where the corpus, the run folder and this
// checkout's CLI bundle are, a CLI runner, a small zip reader, text comparison and an HWPML
// (Hangul's own XML, written by hancom.py) reader.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

export const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(TOOL_DIR, '..', '..')
export const CLI_BUNDLE = join(REPO_ROOT, 'packages', 'cli', 'dist', 'genoffice.cjs')
export const DEFAULT_CORPUS = 'E:\\github\\odt-corpus'

/** `--name value` options and positional arguments. */
export function parseArgs(argv = process.argv.slice(2)) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) opts[key] = true
      else {
        opts[key] = next
        i++
      }
    } else opts._.push(a)
  }
  return opts
}

/** The corpus folder: --corpus, then ODT_CORPUS, then the default. */
export function corpusDir(opts) {
  return resolve(opts.corpus || process.env.ODT_CORPUS || DEFAULT_CORPUS)
}

/** The run folder (outputs): --run, else <corpus>/run-<yyyy-mm-dd>. */
export function runDir(opts) {
  const day = new Date().toISOString().slice(0, 10)
  const dir = resolve(opts.run || join(corpusDir(opts), `run-${day}`))
  mkdirSync(dir, { recursive: true })
  return dir
}

export function requireCli() {
  if (!existsSync(CLI_BUNDLE)) {
    throw new Error(`${CLI_BUNDLE} is missing: run \`npm run build -w @genoffice/cli\` first`)
  }
  return CLI_BUNDLE
}

/** Runs this checkout's CLI bundle; resolves with the exit code, the JSON envelope and the time. */
export function runCli(args, { env = {}, timeoutMs = 600_000 } = {}) {
  requireCli()
  return new Promise((done) => {
    const began = Date.now()
    const child = spawn(process.execPath, [CLI_BUNDLE, ...args], {
      env: { ...process.env, ...env },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, json: lastJsonLine(stdout), stdout, stderr, ms: Date.now() - began })
    })
  })
}

/** The JSON object on the last line of a program's output, or null. */
export function lastJsonLine(stdout) {
  try {
    return JSON.parse(stdout.trim().split(/\r?\n/).pop() || 'null')
  } catch {
    return null
  }
}

/** Runs async work over items with a fixed number of workers. */
export async function pool(items, jobs, work) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await work(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker))
  return out
}

// ---- zip ----

/** Entry name → uncompressed bytes (stored and deflate entries; enough for ODT packages). */
export function readZip(buf) {
  const files = new Map()
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(dataAt, dataAt + size)
    files.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw))
    p += 46 + nameLen + extraLen + commentLen
  }
  return files
}

// ---- text ----

export const squeeze = (s) => (s || '').replace(/\s+/g, '')

/** Share of a's characters kept, in order, in b (line-level LCS on whitespace-squeezed lines). */
export function kept(a, b) {
  const la = (a || '').split(/\r?\n/).map(squeeze).filter(Boolean)
  const lb = (b || '').split(/\r?\n/).map(squeeze).filter(Boolean)
  if (!la.length) return 1
  const prev = new Array(lb.length + 1).fill(0)
  for (let i = 1; i <= la.length; i++) {
    let diag = 0
    for (let j = 1; j <= lb.length; j++) {
      const up = prev[j]
      prev[j] = la[i - 1] === lb[j - 1] ? diag + la[i - 1].length : Math.max(prev[j], prev[j - 1])
      diag = up
    }
  }
  return prev[lb.length] / la.reduce((n, l) => n + l.length, 0)
}

/** Characters of a (squeezed) not found in b, by character-level LCS on short texts. */
export function lostChars(a, b) {
  const x = squeeze(a)
  const y = squeeze(b)
  // common prefix and suffix first; the middle is usually small
  let s = 0
  while (s < x.length && s < y.length && x[s] === y[s]) s++
  let e = 0
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++
  const mx = x.slice(s, x.length - e)
  const my = y.slice(s, y.length - e)
  if (mx.length * my.length > 4e6) return { lost: mx, added: my, approx: true }
  const prev = new Array(my.length + 1).fill(0)
  const rows = [prev.slice()]
  for (let i = 1; i <= mx.length; i++) {
    const row = new Array(my.length + 1).fill(0)
    for (let j = 1; j <= my.length; j++) {
      row[j] =
        mx[i - 1] === my[j - 1] ? rows[i - 1][j - 1] + 1 : Math.max(rows[i - 1][j], row[j - 1])
    }
    rows.push(row)
  }
  let i = mx.length
  let j = my.length
  let lost = ''
  let added = ''
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && mx[i - 1] === my[j - 1]) {
      i--
      j--
    } else if (j > 0 && (i === 0 || rows[i][j - 1] >= rows[i - 1][j])) added = my[--j] + added
    else lost = mx[--i] + lost
  }
  return { lost, added, approx: false }
}

// ---- HWPML ----

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#'
      ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1))
      : (ENT[e] ?? m),
  )

function attrs(tag) {
  const out = {}
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]] = decode(m[2])
  return out
}

/**
 * What the judge needs from Hangul's XML: page setup per section, every table (document order,
 * nested tables included) with its rows, cells and row texts, header/footer/footnote texts,
 * click-here fields with the text between their begin and end, picture items, and paragraphs
 * with their char/para shape runs (to read the shape at a mark).
 */
export function parseHwpml(xml) {
  const doc = {
    sections: [],
    tables: [],
    headers: [],
    footers: [],
    footnotes: [],
    endnotes: [],
    fields: [],
    pictures: [],
    binItems: [],
    charShapes: new Map(),
    paraShapes: new Map(),
    paragraphs: [],
    fonts: {},
  }
  const stack = []
  const tables = []
  const zones = []
  const openFields = []
  let para = null
  let charShape = null
  let shape = null
  let fontLang = null
  const addText = (t) => {
    if (para) {
      para.text += t
      para.runs.push({ text: t, charShape })
    }
    for (const z of zones) z.text += t
    // a row's text includes the tables nested in it
    for (const tb of tables) {
      if (!tb.cell) continue
      tb.cell.text += t
      tb.row.text += t
    }
    for (const f of openFields) f.text += t
  }
  const rx = /<(\/?)([A-Z0-9]+)([^>]*?)(\/?)>|([^<]+)/g
  let m
  let inChar = false
  while ((m = rx.exec(xml))) {
    if (m[5] !== undefined) {
      if (inChar) addText(decode(m[5]))
      continue
    }
    const [, close, name, rest, self] = m
    if (close) {
      if (name === 'CHAR') inChar = false
      else if (name === 'P') {
        if (para) doc.paragraphs.push(para)
        para = stack.pop() ?? null
      } else if (name === 'TABLE') doc.tables.push(finishTable(tables.pop()))
      else if (name === 'CELL') tables[tables.length - 1].cell = null
      else if (['HEADER', 'FOOTER', 'FOOTNOTE', 'ENDNOTE'].includes(name)) {
        const z = zones.pop()
        doc[
          { HEADER: 'headers', FOOTER: 'footers', FOOTNOTE: 'footnotes', ENDNOTE: 'endnotes' }[name]
        ].push(z.text)
      } else if (name === 'CHARSHAPE' || name === 'PARASHAPE') shape = null
      continue
    }
    const a = attrs(rest)
    switch (name) {
      case 'CHAR':
        if (!self) inChar = true
        break
      case 'P':
        stack.push(para)
        para = {
          paraShape: a.ParaShape,
          text: '',
          runs: [],
          zone: zones.length > 0,
          inTable: tables.length > 0,
        }
        if (self) {
          doc.paragraphs.push(para)
          para = stack.pop() ?? null
        }
        break
      case 'TEXT':
        charShape = a.CharShape
        break
      case 'TAB':
        addText('\t')
        break
      case 'TABLE':
        // a table inside a row: the rows holding it (every level up) count it
        for (const t of tables) if (t.row) t.row.nested++
        tables.push({
          rows: +a.RowCount,
          cols: +a.ColCount,
          rowList: [],
          cells: 0,
          row: null,
          cell: null,
          zone: zones.length > 0,
        })
        break
      case 'ROW': {
        const tb = tables[tables.length - 1]
        tb.row = { text: '', cells: 0, heights: [], nested: 0 }
        tb.rowList.push(tb.row)
        break
      }
      case 'CELL': {
        const tb = tables[tables.length - 1]
        tb.cells++
        tb.row.cells++
        tb.row.heights.push(+a.Height || 0)
        tb.cell = { text: '' }
        if (self) tb.cell = null
        break
      }
      case 'HEADER':
      case 'FOOTER':
      case 'FOOTNOTE':
      case 'ENDNOTE':
        zones.push({ text: '' })
        break
      case 'PAGEDEF':
        doc.sections.push({ width: +a.Width, height: +a.Height, landscape: +a.Landscape })
        break
      case 'PAGEMARGIN': {
        const s = doc.sections[doc.sections.length - 1]
        if (s) s.margin = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, +v]))
        break
      }
      case 'FIELDBEGIN': {
        const f = { type: a.Type, name: a.Name ?? '', id: a.FieldId, text: '' }
        doc.fields.push(f)
        openFields.push(f)
        break
      }
      case 'FIELDEND': {
        const i = openFields.findIndex((f) => f.id === a.FieldId)
        if (i >= 0) openFields.splice(i, 1)
        break
      }
      case 'PICTURE':
        doc.pictures.push({})
        break
      case 'IMAGE':
        if (doc.pictures.length) doc.pictures[doc.pictures.length - 1].binItem = a.BinItem
        break
      case 'BINITEM':
        doc.binItems.push({ id: a.BinData, format: a.Format })
        break
      case 'CHARSHAPE':
        shape = { kind: 'char', height: +a.Height, color: +a.TextColor, bold: 0 }
        doc.charShapes.set(a.Id, shape)
        break
      case 'BOLD':
        if (shape && shape.kind === 'char') shape.bold = 1
        break
      case 'PARASHAPE':
        shape = { kind: 'para', align: a.Align }
        doc.paraShapes.set(a.Id, shape)
        break
      case 'PARAMARGIN':
        if (shape && shape.kind === 'para') {
          shape.lineSpacing = +a.LineSpacing
          shape.lineSpacingType = a.LineSpacingType
        }
        break
      case 'FONTFACE':
        fontLang = a.Lang
        doc.fonts[fontLang] ??= {}
        break
      case 'FONT':
        if (fontLang && a.Id !== undefined && a.Name !== undefined && !doc.fonts[fontLang][a.Id])
          doc.fonts[fontLang][a.Id] = a.Name
        break
      case 'FONTID':
        if (shape && shape.kind === 'char') {
          shape.fontHangul = a.Hangul
          shape.fontLatin = a.Latin
        }
        break
    }
  }
  return doc
}

function finishTable(tb) {
  return {
    rows: tb.rows,
    cols: tb.cols,
    zone: tb.zone,
    cells: tb.cells,
    rowTexts: tb.rowList.map((r) => r.text),
    rowCells: tb.rowList.map((r) => r.cells),
    rowHeights: tb.rowList.map((r) => Math.max(0, ...r.heights)),
    rowNested: tb.rowList.map((r) => r.nested),
  }
}

/** Hangul's AlignType numbers (ParaShape.AlignType) for the HWPML Align names. */
export const ALIGN = { Justify: 0, Left: 1, Right: 2, Center: 3, Distribute: 4, DistributeSpace: 5 }

/** Char/para shape of the first paragraph run holding the mark (HWPML view). */
export function shapeAtMark(doc, mark) {
  for (const p of doc.paragraphs) {
    const at = p.text.indexOf(mark)
    if (at < 0) continue
    let pos = 0
    for (const r of p.runs) {
      if (pos + r.text.length > at) {
        const cs = doc.charShapes.get(r.charShape) ?? {}
        const ps = doc.paraShapes.get(p.paraShape) ?? {}
        return {
          bold: cs.bold ?? null,
          height: cs.height ?? null,
          color: cs.color ?? null,
          align: ALIGN[ps.align] ?? ps.align,
        }
      }
      pos += r.text.length
    }
  }
  return null
}

/** The whole visible text Hangul holds (body, tables, headers, notes) for mark searches. */
export function allText(doc) {
  return [
    ...doc.paragraphs.map((p) => p.text),
    ...doc.headers,
    ...doc.footers,
    ...doc.footnotes,
    ...doc.endnotes,
  ].join('\n')
}

/** Font, size and line spacing of the first body paragraph with text (not in a table or note). */
export function firstBodyShape(doc) {
  const p = doc.paragraphs.find((x) => !x.zone && !x.inTable && x.text.trim())
  if (!p) return null
  const run = p.runs.find((r) => r.text.trim()) ?? p.runs[0]
  const cs = doc.charShapes.get(run?.charShape) ?? {}
  const ps = doc.paraShapes.get(p.paraShape) ?? {}
  return {
    text: p.text.trim().slice(0, 30),
    fontHangul: doc.fonts.Hangul?.[cs.fontHangul] ?? null,
    fontLatin: doc.fonts.Latin?.[cs.fontLatin] ?? null,
    height: cs.height ?? null,
    lineSpacing: ps.lineSpacing ?? null,
    lineSpacingType: ps.lineSpacingType ?? null,
  }
}
