// Judges the edited copies against what Hangul read from the received files.
//
//   node tools/odt-hancom/judge.mjs [--corpus DIR] [--run DIR] [--base DIR]
//
// Needs <run>/base (hancom.py look of the received files), <run>/edits/manifest.json
// (make-edits.mjs) and <run>/edits/<kind>/_hancom (hancom.py look of each kind's copies, with
// --marks for the text and para kinds). Writes <run>/judge.json and prints per kind: made,
// skipped, passed, failed, and every failure with its reasons.
//
// Unedited save: pages, controls, tables and text exactly as received. Edited saves: the
// intended edit is visible (marks, shapes, table rows/cells, pictures, page setup, fields), the
// table and control counts are as intended, no received text is lost, and a page count that
// moved by 2 or more is flagged for a written cause (`pages` note, not a failure by itself).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MARK_TEXT } from './marks.mjs'
import { corpusDir, lostChars, parseArgs, parseHwpml, runDir, squeeze } from './lib.mjs'

const opts = parseArgs()
corpusDir(opts)
const run = runDir(opts)
const manifest = JSON.parse(readFileSync(join(run, 'edits', 'manifest.json'), 'utf8'))
// --base <folder>: Hangul's reading of the files the copies were made from (default <run>/base)
const baseDir = opts.base ? String(opts.base) : join(run, 'base')
const base = JSON.parse(readFileSync(join(baseDir, 'look.json'), 'utf8'))
const validation = existsSync(join(run, 'validate.json'))
  ? JSON.parse(readFileSync(join(run, 'validate.json'), 'utf8'))
  : null

const hwpmlCache = new Map()
function hwpml(dir, name) {
  const file = join(dir, 'hwpml', `${name}.xml`)
  if (!existsSync(file)) return null
  if (!hwpmlCache.has(file)) {
    if (hwpmlCache.size > 6) hwpmlCache.delete(hwpmlCache.keys().next().value)
    hwpmlCache.set(file, parseHwpml(readFileSync(file, 'utf8')))
  }
  return hwpmlCache.get(file)
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const ctrlsWithout = (c, ...ids) =>
  Object.fromEntries(Object.entries(c ?? {}).filter(([k]) => !ids.includes(k)))
const bodyTables = (d) => d.tables.filter((t) => !t.zone)
const shape = (t) => t.map((x) => `${x.rows}x${x.cols}/${x.cells}`)

/** Tables whose rows/cols/cells differ, by position (same table count assumed). */
function changedTables(b, e) {
  const tb = bodyTables(b)
  const te = bodyTables(e)
  if (tb.length !== te.length) return null
  return tb
    .map((t, i) => ({ i, before: t, after: te[i] }))
    .filter((x) => shape([x.before])[0] !== shape([x.after])[0])
}

const results = {}
const summary = {}
for (const [kind, files] of Object.entries(manifest)) {
  const lookFile = join(run, 'edits', kind, '_hancom', 'look.json')
  const looks = existsSync(lookFile) ? JSON.parse(readFileSync(lookFile, 'utf8')) : {}
  const sum = (summary[kind] = {
    made: 0,
    skip: 0,
    pass: 0,
    fail: 0,
    pagesNote: 0,
    skips: {},
    seconds: 0,
  })
  results[kind] = {}
  for (const [name, entry] of Object.entries(files)) {
    if (entry.status === 'skip') {
      sum.skip++
      sum.skips[entry.reason] = (sum.skips[entry.reason] ?? 0) + 1
      results[kind][name] = { verdict: 'skip', reason: entry.reason }
      continue
    }
    if (entry.status !== 'made') {
      sum.fail++
      results[kind][name] = {
        verdict: 'fail',
        problems: [`not made: ${entry.reason}`],
        tries: entry.tries,
      }
      continue
    }
    sum.made++
    sum.seconds += (entry.ms ?? 0) / 1000
    const o = base[name]
    const e = looks[name]
    const problems = []
    const notes = []
    if (!o || !o.opened) problems.push('received file has no Hancom baseline')
    else if (!e) problems.push('no Hancom look of the copy')
    else if (!e.opened) problems.push(`does not open in Hancom (${e.error ?? ''})`)
    else judgeOne(kind, name, entry, o, e, problems, notes)
    const v = validation?.edits?.[kind]?.[name]
    const vb = validation?.received?.[name]
    if (v && vb) {
      if (v.errors > vb.errors) problems.push(`ODF validator errors ${vb.errors} -> ${v.errors}`)
      const fresh = v.messages.filter((m) => !vb.messages.includes(m))
      if (fresh.length) problems.push(`new validator messages: ${fresh.slice(0, 3).join(' | ')}`)
    }
    if (e?.opened && o?.opened && Math.abs(e.pages - o.pages) >= 2) {
      notes.push(`pages ${o.pages} -> ${e.pages} (needs a written cause)`)
      sum.pagesNote++
    }
    if (problems.length) sum.fail++
    else sum.pass++
    results[kind][name] = {
      verdict: problems.length ? 'fail' : 'pass',
      problems,
      notes,
      pages: o && e ? [o.pages, e.pages] : null,
      via: entry.via ?? 'cli',
      framed: entry.framed,
      sameBytes: sameBytes(kind, entry),
    }
  }
}

function sameBytes(kind, entry) {
  return kind === 'none' ? entry.edit?.sameBytes : entry.sameBytes
}

function judgeOne(kind, name, entry, o, e, problems, notes) {
  const dirE = join(run, 'edits', kind, '_hancom')
  const hb = hwpml(baseDir, name)
  const he = hwpml(dirE, name)
  const textLoss = () => lostChars(o.text, e.text)
  /** received text, plus `added` somewhere (taken out at its first match), and nothing else */
  const expectText = (added, replaced = '') => {
    const now = squeeze(e.text)
    const want = squeeze(added)
    const at = want ? now.indexOf(want) : 0
    const was = squeeze(o.text)
    const rest = at < 0 ? null : now.slice(0, at) + now.slice(at + want.length)
    const expected = replaced ? was.replace(squeeze(replaced), '') : was
    if (rest === expected) return
    if (rest !== null) {
      // only digits moved: page numbers Hancom computes (cross-references, contents) after reflow
      const d = lostChars(expected, rest)
      if (/^\d*$/.test(d.lost) && /^\d*$/.test(d.added)) {
        notes.push(
          `computed page numbers changed after reflow ("${d.lost.slice(0, 20)}" -> "${d.added.slice(0, 20)}")`,
        )
        return
      }
    }
    const { lost, added: got } = textLoss()
    const before = problems.length
    if (lost && squeeze(lost) !== squeeze(replaced))
      problems.push(`received text lost: "${lost.slice(0, 60)}"`)
    if (squeeze(got) !== squeeze(added))
      problems.push(`text added "${got.slice(0, 60)}", expected "${added}"`)
    if (problems.length === before)
      problems.push(`text is not the received text with "${added}" added`)
  }
  const sameCtrls = (...except) => {
    if (!sameJson(ctrlsWithout(o.ctrls, ...except), ctrlsWithout(e.ctrls, ...except)))
      problems.push(`controls ${JSON.stringify(o.ctrls)} -> ${JSON.stringify(e.ctrls)}`)
  }
  const sameTables = () => {
    if (o.tables !== e.tables) problems.push(`tables ${o.tables} -> ${e.tables}`)
  }
  const ex = entry.expect ?? {}
  switch (kind) {
    case 'none':
    case 'noop': {
      if (o.pages !== e.pages) problems.push(`pages ${o.pages} -> ${e.pages}`)
      sameCtrls()
      sameTables()
      if (o.text !== e.text) problems.push('text differs')
      if (!sameJson(o.page, e.page)) problems.push('page setup differs')
      if (!sameBytes(kind, entry)) notes.push('saved bytes differ from the received file')
      return
    }
    case 'text':
    case 'para': {
      sameCtrls()
      sameTables()
      expectText(ex.added)
      const at = e.marks?.[ex.marks[0]]
      if (!at) problems.push(`mark ${ex.marks[0]} not found by Hancom`)
      else
        for (const [k, v] of Object.entries(ex.shape ?? {}))
          if (at[k] !== v) problems.push(`${k} at mark ${at[k]}, expected ${v}`)
      return
    }
    case 'cell': {
      sameCtrls()
      sameTables()
      expectText(ex.added)
      if (!squeeze(e.text).includes(MARK_TEXT.cell)) problems.push('cell mark not visible')
      return
    }
    case 'rowdel': {
      // the deleted row takes what it held: its text, the tables and fields inside it
      if (!hb || !he) return problems.push('no HWPML')
      const { lost, added } = textLoss()
      if (!/^\d*$/.test(added)) problems.push(`text added "${added.slice(0, 40)}"`)
      const tb = bodyTables(hb)
      const te = bodyTables(he)
      const was = squeeze(o.text)
      const now = squeeze(e.text)
      // the received text with that row's text taken out is what Hancom reads now
      // (page numbers it computes may move with the reflow)
      // (the same text may stand in several rows: any occurrence will do)
      const without = (rowText) => {
        const r = squeeze(rowText)
        if (!r) return was === now
        // Hangul's plain text carries the bullets and numbers it draws (paragraph heads,
        // page numbers of contents entries it computes), its XML the stored ones: the lost text
        // is the row's text up to such marks
        const marks = lostChars(r, lost)
        if (/^\d*$/.test(marks.lost) && /^[-•·○●□■◦▪※*\d.)(]*$/.test(marks.added)) return true
        for (let at = was.indexOf(r); at >= 0; at = was.indexOf(r, at + 1)) {
          const rest = was.slice(0, at) + was.slice(at + r.length)
          if (rest === now) return true
          if (Math.abs(rest.length - now.length) > 64) continue
          const d = lostChars(rest, now)
          if (/^\d*$/.test(d.lost) && /^\d*$/.test(d.added)) return true
        }
        return false
      }
      const fits = tb.some((t) =>
        t.rowTexts.some(
          (rowText, r) =>
            te.length === tb.length - t.rowNested[r] &&
            te.some((x) => x.rows === t.rows - 1 && x.cols === t.cols) &&
            without(rowText),
        ),
      )
      if (!fits)
        problems.push(
          `no table lost exactly one row holding the lost text "${lost.slice(0, 50)}" (tables ${tb.length} -> ${te.length})`,
        )
      for (const [id, n] of Object.entries(e.ctrls ?? {}))
        if (n > (o.ctrls?.[id] ?? 0)) problems.push(`control ${id} ${o.ctrls?.[id] ?? 0} -> ${n}`)
      const gone = Object.entries(o.ctrls ?? {}).filter(([id, n]) => (e.ctrls?.[id] ?? 0) < n)
      if (gone.length)
        notes.push(
          `went with the row: ${gone.map(([id, n]) => `${id || '(unnamed)'} ${n}->${e.ctrls?.[id] ?? 0}`).join(', ')}`,
        )
      return
    }
    case 'rowadd':
    case 'merge': {
      sameCtrls()
      sameTables()
      if (!hb || !he) return problems.push('no HWPML')
      const changed = changedTables(hb, he)
      if (!changed) return problems.push('table count differs in HWPML')
      if (changed.length !== 1)
        return problems.push(
          `${changed.length} tables changed shape: ${JSON.stringify(changed.map((c) => [shape([c.before])[0], shape([c.after])[0]]))}`,
        )
      const [{ before, after }] = changed
      if (kind === 'rowadd') {
        if (after.rows !== before.rows + 1 || after.cols !== before.cols)
          problems.push(`rows ${before.rows} -> ${after.rows}`)
        expectText('')
        const newRow = after.rowHeights[after.rowHeights.length - 1]
        if (!(newRow > 0)) problems.push('new row has no height in Hancom')
        if (entry.framed) notes.push('framed table: frame height grown')
      } else {
        if (
          after.cells !== before.cells - 1 ||
          after.rows !== before.rows ||
          after.cols !== before.cols
        )
          problems.push(`cells ${before.cells} -> ${after.cells}`)
        expectText('')
      }
      return
    }
    case 'picins':
    case 'picrep': {
      sameTables()
      expectText('')
      const want = kind === 'picins' ? 1 : 0
      const gso = (x) => x.ctrls?.gso ?? 0
      if (gso(e) - gso(o) !== want) problems.push(`gso ${gso(o)} -> ${gso(e)}`)
      sameCtrls('gso')
      if (hb && he) {
        if (he.pictures.length - hb.pictures.length !== want)
          problems.push(`pictures ${hb.pictures.length} -> ${he.pictures.length}`)
        if (kind === 'picrep') {
          const formats = (d) =>
            d.binItems
              .map((b) => b.format)
              .sort()
              .join(',')
          if (formats(hb) === formats(he))
            notes.push('picture item formats unchanged (same format replaced)')
          if (!he.binItems.some((b) => /png/i.test(b.format)))
            problems.push('no PNG picture item after replace')
        }
      }
      return
    }
    case 'header': {
      sameTables()
      if (!he) return problems.push('no HWPML')
      const zone = ex.region === 'footer' ? he.footers : he.headers
      if (!zone.some((t) => t.includes(MARK_TEXT.header)))
        problems.push(`${ex.region} mark not in Hancom's ${ex.region}`)
      const { lost } = textLoss()
      if (lost) problems.push(`received body text lost: "${lost.slice(0, 60)}"`)
      return
    }
    case 'footnote': {
      sameCtrls()
      sameTables()
      if (!he) return problems.push('no HWPML')
      if (
        !he.footnotes.some((t) => t.includes(MARK_TEXT.footnote)) &&
        !he.endnotes.some((t) => t.includes(MARK_TEXT.footnote))
      )
        problems.push('note mark not in Hancom notes')
      if (hb && hb.footnotes.length !== he.footnotes.length)
        problems.push(`footnotes ${hb.footnotes.length} -> ${he.footnotes.length}`)
      const { lost } = textLoss()
      if (lost) problems.push(`received text lost: "${lost.slice(0, 60)}"`)
      return
    }
    case 'margin':
    case 'paper':
    case 'orient':
    case 'secmargin': {
      sameCtrls()
      sameTables()
      expectText('')
      if (!hb || !he) return problems.push('no HWPML')
      if (hb.sections.length !== he.sections.length)
        problems.push(`sections ${hb.sections.length} -> ${he.sections.length}`)
      const s0 = he.sections[0]
      const b0 = hb.sections[0]
      const near = (a, b, tol = 15) => Math.abs(a - b) <= tol
      if (kind === 'margin') {
        if (
          !near(s0.margin.Left, ex.margin.left * 5) ||
          !near(s0.margin.Right, ex.margin.right * 5)
        )
          problems.push(
            `margins L/R ${s0.margin.Left}/${s0.margin.Right}, expected ${ex.margin.left * 5}/${ex.margin.right * 5}`,
          )
      } else if (kind === 'paper') {
        const want = entry.sectionsAfter?.[0]
        if (!want) problems.push('no section reading after the edit')
        else {
          const dims = [s0.width, s0.height].sort((a, b) => a - b)
          const wantDims = [want.width * 5, want.height * 5].sort((a, b) => a - b)
          if (!near(dims[0], wantDims[0], 30) || !near(dims[1], wantDims[1], 30))
            problems.push(
              `paper ${s0.width}x${s0.height}, expected ${want.width * 5}x${want.height * 5}`,
            )
        }
      } else if (kind === 'orient') {
        const eff = (s) => ((s.landscape === 1) !== s.width > s.height ? 'landscape' : 'portrait')
        if (eff(s0) !== ex.orientation)
          problems.push(`orientation ${eff(b0)} -> ${eff(s0)}, expected ${ex.orientation}`)
      } else {
        // the editor's section N is not always Hangul's section N: a page run holding no
        // paragraph (only a framed table) has no docx section of its own but is a Hangul section.
        // So: the first section stays, every other section either stays or takes the new left
        // margin (and nothing else), and at least one takes it.
        let edited = 0
        he.sections.forEach((s, i) => {
          const b = hb.sections[i]
          if (!b) return
          const same = sameJson(s.margin, b.margin) && s.width === b.width && s.height === b.height
          if (same) return
          const onlyLeft =
            near(s.margin.Left, ex.left * 5) &&
            sameJson({ ...s.margin, Left: 0 }, { ...b.margin, Left: 0 }) &&
            s.width === b.width &&
            s.height === b.height
          if (i === 0 || !onlyLeft)
            problems.push(
              `section ${i} changed: ${JSON.stringify(b.margin)} -> ${JSON.stringify(s.margin)}`,
            )
          else edited++
        })
        if (!edited) problems.push(`no section took the left margin ${ex.left * 5}`)
        notes.push(
          `sections: ${hb.sections.map((s, i) => (sameJson(s.margin, he.sections[i]?.margin) ? 'same' : 'edited')).join(', ')}`,
        )
      }
      return
    }
    case 'field': {
      sameCtrls()
      sameTables()
      if (!hb || !he) return problems.push('no HWPML')
      const clk = (d) => d.fields.filter((f) => f.type === 'Clickhere')
      if (clk(hb).length !== clk(he).length)
        problems.push(`click-here fields ${clk(hb).length} -> ${clk(he).length}`)
      // Hancom names a field after the second part of the NormalField bookmark name. It may read
      // the fields of one form nested in each other (a field's text then runs on into the
      // fields after it), so: the same fields by name and order, and the edited field begins
      // with the typed text where it began with the replaced one
      const names = (d) => clk(d).map((f) => f.name)
      if (names(hb).join('|') !== names(he).join('|'))
        problems.push('click-here field names or order changed')
      const name = String(ex.field).split('¡')[1] ?? ''
      const mark = squeeze(MARK_TEXT.field)
      const old = squeeze(ex.replaced)
      const hit = clk(hb).some(
        (f, k) =>
          f.name === name &&
          squeeze(f.text).startsWith(old) &&
          squeeze(clk(he)[k]?.text).startsWith(mark),
      )
      if (!hit) problems.push(`typed text is not inside the click-here field "${name}" in Hancom`)
      expectText(MARK_TEXT.field, ex.replaced)
      return
    }
  }
}

writeFileSync(join(run, 'judge.json'), JSON.stringify({ summary, results }, null, 1))
console.log('kind      made skip pass fail pages>=2  cli-s')
for (const [kind, s] of Object.entries(summary))
  console.log(
    `${kind.padEnd(9)} ${String(s.made).padStart(4)} ${String(s.skip).padStart(4)} ${String(s.pass).padStart(4)} ${String(s.fail).padStart(4)} ${String(s.pagesNote).padStart(8)}  ${s.seconds.toFixed(0)}`,
  )
for (const [kind, files] of Object.entries(results))
  for (const [name, r] of Object.entries(files)) {
    if (r.verdict === 'fail') console.log(`FAIL ${kind} ${name}: ${r.problems.join('; ')}`)
    if (r.notes?.length) console.log(`note ${kind} ${name}: ${r.notes.join('; ')}`)
  }
