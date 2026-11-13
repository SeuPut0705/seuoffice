#!/usr/bin/env node
/**
 * Renames the names inherited from IeumOffice and GenOffice to seuoffice names,
 * driven by mapping.mjs (decision 0024). Run from the repository root:
 *
 *   node tools/rename-internal/codemod.mjs --check  [--report <dir>]   print what would change, write nothing
 *   node tools/rename-internal/codemod.mjs --apply  [--report <dir>]   rewrite files and `git mv` renamed paths
 *   node tools/rename-internal/codemod.mjs --audit  [--base <rev>]     fail if a deny-listed path differs from <rev>
 *
 * A branch that was open when main took the rename runs --apply after
 * `git merge origin/main`, then `npm install` and `npm run format`.
 * Idempotent: a second --apply changes nothing, and --check then reports zero
 * changes. Node 22, no dependency but the checkout's own `typescript`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import {
  FILE_RULE_LIMITS,
  KEEP_LINES,
  KEEP_TOKENS,
  OLD_NAME,
  RULES,
  SWAP_CALL,
  TEST_ABSENCE,
  UPSTREAM_CONTEXT,
} from './mapping.mjs'
import { classOf, matcher } from './paths.mjs'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : fallback
}
const mode = ['--check', '--apply', '--audit'].find(flag)
if (!mode) {
  console.error(
    'usage: node tools/rename-internal/codemod.mjs <--check|--apply|--audit> [--repo dir] [--report dir] [--base rev]',
  )
  process.exit(2)
}
const repo = resolve(option('--repo', process.cwd()))
const reportDir = option('--report', null)

const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: repo, maxBuffer: 1 << 30, ...opts })

const limits = FILE_RULE_LIMITS.map((l) => ({ ...l, matches: matcher(l.files) }))
const keepLines = KEEP_LINES.map((k) => ({ ...k, matches: matcher(k.files) }))
const rules = RULES.map((r) => ({ ...r, inFiles: r.files ? matcher(r.files) : () => true }))

// ── keep spans ──────────────────────────────────────────────────────────────

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0)
}

const tracked = git(['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean)

// a keep with `files` holds only there; without it, everywhere
const keepTokens = KEEP_TOKENS.map((k) => ({
  ...k,
  inFiles: k.files ? matcher(k.files) : () => true,
}))

/** [start, end, id] spans of `text` that no rule may touch */
function keepSpans(path, text) {
  const spans = []
  for (const keep of keepTokens) {
    if (!keep.inFiles(path)) continue
    keep.re.lastIndex = 0
    for (const m of text.matchAll(keep.re)) spans.push([m.index, m.index + m[0].length, keep.id])
  }
  const lineKeeps = keepLines.filter((k) => k.matches(path))
  if (lineKeeps.length > 0) {
    let offset = 0
    for (const line of text.split('\n')) {
      const hit = lineKeeps.find((k) => k.line.test(line))
      if (hit) spans.push([offset, offset + line.length, `keep-line: ${hit.why}`])
      offset += line.length + 1
    }
  }
  // a line that says "upstream" names the original product: its name stays there
  if (UPSTREAM_CONTEXT.line.test(text)) {
    let offset = 0
    for (const line of text.split('\n')) {
      if (UPSTREAM_CONTEXT.line.test(line)) {
        for (const m of line.matchAll(UPSTREAM_CONTEXT.token)) {
          spans.push([offset + m.index, offset + m.index + m[0].length, UPSTREAM_CONTEXT.id])
        }
      }
      offset += line.length + 1
    }
  }
  // a test that asserts the upstream name is absent keeps that name
  if (classOf(path) === 'test' && TEST_ABSENCE.token.test(text)) {
    TEST_ABSENCE.token.lastIndex = 0
    const lines = text.split('\n')
    let offset = 0
    lines.forEach((line, i) => {
      // the nearest statement start above decides: a negating one carries over,
      // any other `expect(` ends the negation it may follow
      let continuesNegation = false
      if (!TEST_ABSENCE.newStatement.test(line)) {
        for (let j = i - 1; j >= Math.max(0, i - TEST_ABSENCE.lookback); j--) {
          if (TEST_ABSENCE.opener.test(lines[j])) {
            continuesNegation = true
            break
          }
          if (TEST_ABSENCE.newStatement.test(lines[j])) break
        }
      }
      if (TEST_ABSENCE.line.test(line) || continuesNegation) {
        for (const m of line.matchAll(TEST_ABSENCE.token)) {
          spans.push([offset + m.index, offset + m.index + m[0].length, TEST_ABSENCE.id])
        }
      }
      offset += line.length + 1
    })
  }
  return spans.sort((a, b) => a[0] - b[0])
}
const spanAt = (spans, start, end) => spans.find((s) => start < s[1] && end > s[0])

// ── the text rules ──────────────────────────────────────────────────────────

function rulesFor(path, cls) {
  const limit = limits.find((l) => l.matches(path))
  return rules.filter(
    (r) => r.applies.includes(cls) && r.inFiles(path) && (!limit || limit.only.includes(r.id)),
  )
}

/** Apply the rules to one string; `counts` gets a hit count per rule id */
function applyRules(path, cls, text, counts) {
  let out = text
  for (const rule of rulesFor(path, cls)) {
    const spans = keepSpans(path, out)
    rule.re.lastIndex = 0
    out = out.replace(rule.re, (match, ...rest) => {
      const offset = rest[rest.length - 2]
      if (spanAt(spans, offset, offset + match.length)) return match
      counts[rule.id] = (counts[rule.id] ?? 0) + 1
      return typeof rule.to === 'function'
        ? rule.to(match, ...rest)
        : rule.to.replace(/\$(\d)/g, (_, n) => rest[Number(n) - 1] ?? '')
    })
  }
  return out
}

// ── the structural step: unwrap the product-name swap ───────────────────────

const requireFromRepo = createRequire(join(repo, 'package.json'))
let ts = null
function typescript() {
  ts ??= requireFromRepo('typescript')
  return ts
}

function unwrapSwap(path, text, counts) {
  if (!/\.(?:[cm]?ts|tsx)$/.test(path) || !SWAP_CALL.names.some((n) => text.includes(n)))
    return text
  if (SWAP_CALL.skipFiles.includes(path)) return text
  const t = typescript()
  const source = t.createSourceFile(
    path,
    text,
    t.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? t.ScriptKind.TSX : t.ScriptKind.TS,
  )
  const edits = []
  const visit = (node) => {
    if (
      t.isCallExpression(node) &&
      t.isIdentifier(node.expression) &&
      SWAP_CALL.names.includes(node.expression.text) &&
      node.arguments.length >= 1
    ) {
      const arg = node.arguments[0]
      edits.push([
        node.getStart(source),
        node.getEnd(),
        text.slice(arg.getStart(source), arg.getEnd()),
      ])
      counts['swap-call'] = (counts['swap-call'] ?? 0) + 1
      // a swap inside the first argument is unwrapped by the next run of this function
      return
    }
    if (
      t.isImportDeclaration(node) &&
      node.importClause?.namedBindings &&
      t.isNamedImports(node.importClause.namedBindings)
    ) {
      const elements = node.importClause.namedBindings.elements
      const at = elements.findIndex((e) => SWAP_CALL.names.includes(e.name.text))
      if (at >= 0) {
        counts['swap-import'] = (counts['swap-import'] ?? 0) + 1
        if (elements.length === 1 && !node.importClause.name) {
          let end = node.getEnd()
          if (text[end] === '\r') end++
          if (text[end] === '\n') end++
          edits.push([node.getStart(source), end, ''])
        } else {
          const el = elements[at]
          const next = elements[at + 1]
          const prev = elements[at - 1]
          if (next) edits.push([el.getStart(source), next.getStart(source), ''])
          else edits.push([prev.getEnd(), el.getEnd(), ''])
        }
      }
    }
    t.forEachChild(node, visit)
  }
  visit(source)
  if (edits.length === 0) return text
  let out = text
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + replacement + out.slice(end)
  }
  // nested swaps: run again until none is left
  return SWAP_CALL.names.some((n) => out.includes(`${n}(`)) && out !== text
    ? unwrapSwap(path, out, counts)
    : out
}

// ── audit ───────────────────────────────────────────────────────────────────

if (mode === '--audit') {
  const base = option('--base', 'HEAD')
  const changed = [
    ...git(['diff', '--no-renames', '--name-only', '-z', base]).toString('utf8').split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0'),
  ].filter(Boolean)
  // the tool's own folder is deny-listed so it never renames itself; adding it is not a change to guard
  const denied = changed.filter(
    (p) =>
      classOf(p) === 'deny' && p !== 'package-lock.json' && !p.startsWith('tools/rename-internal/'),
  )
  if (denied.length > 0) {
    console.error(`audit: ${denied.length} deny-listed path(s) differ from ${base}:`)
    for (const p of denied) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log(
    `audit: no deny-listed path differs from ${base} (${changed.length} changed paths looked at)`,
  )
  process.exit(0)
}

// ── run ─────────────────────────────────────────────────────────────────────

const perRule = new Map() // id -> { hits, files:Set, samples:[] }
const perClass = new Map() // class -> { files, changedFiles, hits }
const kept = new Map() // reason -> { hits, files:Set, samples:[] }
const collisions = []
const renames = []
const writes = []

const note = (map, key, path, n, sample) => {
  const entry = map.get(key) ?? { hits: 0, files: new Set(), samples: [] }
  entry.hits += n
  entry.files.add(path)
  if (sample && entry.samples.length < 5) entry.samples.push(sample)
  map.set(key, entry)
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length

for (const path of tracked) {
  const cls = classOf(path)
  const stat = perClass.get(cls) ?? { files: 0, changedFiles: 0, hits: 0 }
  stat.files++
  perClass.set(cls, stat)

  const full = join(repo, path)
  if (!existsSync(full)) continue
  const buffer = readFileSync(full)
  const binary = isBinary(buffer)

  // the path itself (file and folder names) follows the same rules
  const pathCounts = {}
  const newPath = cls === 'code' || cls === 'test' ? applyRules(path, cls, path, pathCounts) : path

  let text = null
  let next = null
  const counts = {}
  if (!binary) {
    text = buffer.toString('utf8')
    next = text
    if (cls === 'code' || cls === 'test') next = unwrapSwap(path, next, counts)
    if (cls !== 'deny' && cls !== 'record') next = applyRules(path, cls, next, counts)

    // lines where two different old names became the same new one
    if (next !== text && (cls === 'code' || cls === 'test')) {
      const before = text.split('\n')
      const after = next.split('\n')
      if (before.length === after.length) {
        before.forEach((line, i) => {
          if (line === after[i]) return
          // same spelling case only: `ieumoffice` beside `GenOffice` is a command beside the product name
          for (const pair of [
            /genoffice|ieumoffice/g,
            /GenOffice|IeumOffice/g,
            /GENOFFICE|IEUMOFFICE/g,
          ]) {
            const stems = new Set(line.match(pair) ?? [])
            const left = new Set(after[i].match(pair) ?? [])
            if (stems.size === 2 && left.size === 0) {
              collisions.push(`${path}:${i + 1}: ${line.trim().slice(0, 160)}`)
              break
            }
          }
        })
      }
    }

    // what is left under an old name, and why
    const spans = keepSpans(path, next)
    OLD_NAME.lastIndex = 0
    for (const m of next.matchAll(OLD_NAME)) {
      const span = spanAt(spans, m.index, m.index + m[0].length)
      let reason
      if (cls === 'deny' || cls === 'record') reason = `path class: ${cls}`
      else if (span) reason = span[2]
      else if (limits.some((l) => l.matches(path)))
        reason = 'file limited to the workspace and environment rules'
      else if (/genspark/i.test(m[0]))
        reason = 'no rule: genspark (service names of the original vendor)'
      else if (cls === 'legacy')
        reason = 'path class: legacy (compatibility code that names the old names on purpose)'
      else if (cls === 'prose')
        reason = 'path class: prose (only workspace names and environment variables follow)'
      else if (cls === 'guide')
        reason =
          "path class: guide (technical names follow; product names and the prose are a person's)"
      else if (cls === 'test')
        reason =
          "path class: test (fixture data under the fork's name, which no rule renames in tests)"
      else reason = 'UNMAPPED'
      note(kept, reason, path, 1, `${path}:${lineOf(next, m.index)}: ${m[0]}`)
    }
  } else {
    // a binary file keeps its bytes; its name may still be renamed
  }

  for (const [id, n] of Object.entries({ ...counts })) {
    note(perRule, id, path, n, `${path}`)
    stat.hits += n
  }
  if (newPath !== path) {
    for (const [id, n] of Object.entries(pathCounts))
      note(perRule, `${id} (path)`, path, n, `${path} -> ${newPath}`)
    renames.push([path, newPath])
  }
  const changed = text !== null && next !== text
  if (changed) {
    stat.changedFiles++
    writes.push([path, newPath, next])
  }
}

// invariant: nothing deny-listed is written, moved, or moved onto
const broken = []
for (const [path, newPath] of writes) {
  if (classOf(path) === 'deny') broken.push(`write to deny-listed ${path}`)
  if (classOf(newPath) === 'deny') broken.push(`write into deny-listed ${newPath}`)
}
for (const [from, to] of renames) {
  if (classOf(from) === 'deny' || classOf(to) === 'deny')
    broken.push(`rename touching deny list: ${from} -> ${to}`)
  if (tracked.includes(to)) broken.push(`rename onto an existing path: ${from} -> ${to}`)
}
const targets = renames.map(([, to]) => to)
for (const to of new Set(targets)) {
  if (targets.filter((t) => t === to).length > 1) broken.push(`two paths rename to ${to}`)
}

// workspace package names must stay unique after the scope moves
const names = new Map()
for (const path of tracked) {
  if (!/^(?:apps|packages)\/[^/]+\/package\.json$/.test(path)) continue
  const write = writes.find(([p]) => p === path)
  const json = JSON.parse(write ? write[2] : readFileSync(join(repo, path), 'utf8'))
  if (names.has(json.name))
    broken.push(`package name ${json.name} is used by ${names.get(json.name)} and ${path}`)
  names.set(json.name, path)
}

if (mode === '--apply' && broken.length === 0) {
  for (const [path, , next] of writes) writeFileSync(join(repo, path), next)
  for (const [from, to] of renames) {
    mkdirSync(dirname(join(repo, to)), { recursive: true })
    git(['mv', '--', from, to])
  }
}

// ── report ──────────────────────────────────────────────────────────────────

const ruleById = new Map(RULES.map((r) => [r.id, r]))
const lines = []
const say = (line = '') => lines.push(line)
say(`# rename ${mode === '--apply' ? 'applied' : 'check'}: ${repo}`)
say(
  `head: ${git(['rev-parse', '--short', 'HEAD']).toString().trim()}  tracked files: ${tracked.length}`,
)
say()
say('## path classes')
for (const [cls, s] of [...perClass].sort()) {
  say(
    `- ${cls}: ${s.files} files, ${s.changedFiles} ${mode === '--apply' ? 'changed' : 'would change'}, ${s.hits} replacements`,
  )
}
say()
say('## replacements per rule')
let total = 0
for (const [id, e] of [...perRule].sort((a, b) => b[1].hits - a[1].hits)) {
  const rule = ruleById.get(id.replace(' (path)', ''))
  total += e.hits
  say(
    `- ${id} [class ${rule?.cls ?? 'A'}]: ${e.hits} in ${e.files.size} files${rule?.shim ? `  (compatibility: ${rule.shim})` : ''}`,
  )
  for (const s of e.samples.slice(0, 3)) say(`    e.g. ${s}`)
}
say(
  `total replacements: ${total}; files ${mode === '--apply' ? 'written' : 'to write'}: ${writes.length}; paths ${mode === '--apply' ? 'renamed' : 'to rename'}: ${renames.length}`,
)
say()
say('## path renames')
for (const [from, to] of renames) say(`- ${from} -> ${to}`)
say()
say('## occurrences deliberately left under an old name')
let leftTotal = 0
for (const [reason, e] of [...kept].sort((a, b) => b[1].hits - a[1].hits)) {
  leftTotal += e.hits
  say(`- ${reason}: ${e.hits} in ${e.files.size} files`)
  for (const s of e.samples.slice(0, 3)) say(`    e.g. ${s}`)
}
say(`total left: ${leftTotal}`)
say()
say(`## lines where two old names became one (${collisions.length}): review by hand`)
for (const c of collisions) say(`- ${c}`)
say()
if (broken.length > 0) {
  say('## BROKEN INVARIANTS')
  for (const b of broken) say(`- ${b}`)
}

const stem = mode === '--apply' ? 'report-apply' : 'report-check'
if (reportDir) {
  mkdirSync(resolve(reportDir), { recursive: true })
  writeFileSync(join(resolve(reportDir), `${stem}.md`), `${lines.join('\n')}\n`)
  writeFileSync(
    join(resolve(reportDir), `${stem}.json`),
    JSON.stringify(
      {
        perRule: Object.fromEntries(
          [...perRule].map(([k, v]) => [k, { hits: v.hits, files: [...v.files] }]),
        ),
        kept: Object.fromEntries(
          [...kept].map(([k, v]) => [k, { hits: v.hits, files: [...v.files] }]),
        ),
        renames,
        collisions,
        written: writes.map(([p]) => p),
      },
      null,
      1,
    ),
  )
}

const summary = lines.filter((l) => !l.startsWith('    e.g.')).slice(0, 60)
console.log(summary.join('\n'))
if (reportDir) console.log(`\nfull report: ${join(resolve(reportDir), `${stem}.md`)}`)
else console.log('\nfull report: rerun with --report <dir>')
const unmapped = kept.get('UNMAPPED')
if (unmapped) console.log(`\nUNMAPPED old names: ${unmapped.hits} (see the report)`)
if (broken.length > 0) {
  console.error(`\n${broken.length} broken invariant(s); nothing was written.`)
  process.exit(1)
}
