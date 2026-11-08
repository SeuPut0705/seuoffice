#!/usr/bin/env node
/**
 * Keep the removed vendor out of the tree: `npm run check:no-genspark`
 *
 * This product is a fork of GenOffice with everything tied to Genspark taken
 * out. Upstream fixes keep being merged, and each merge can bring a login
 * call, a pricing link or a `gsk` helper back in. This check fails on the
 * change that does so.
 *
 * Every tracked text file is scanned, the lockfile included, and so is the
 * path of every tracked file, binary or not: a file or a folder named after
 * the vendor fails like a line that names it. What may still
 * name the vendor is listed in ALLOW below, each entry with its reason: the
 * licence and attribution texts, identifiers stored inside saved documents,
 * and this tool. Keep that list short. The summary prints how many hits it
 * let through, so a growing allowlist shows up in review.
 *
 * Usage: node tools/check-no-genspark.mjs [--allowed]
 *   --allowed   also print the allowlisted hit count of each entry
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * What counts as naming the vendor. The four words are matched in any case,
 * anywhere. `mainfunc` skips the ordinary identifier `mainFunction`.
 *
 * `gsk` (the vendor's command line) is too short for that: it is matched only
 * as an identifier fragment, in the three spellings an identifier can carry.
 *   gsk   not glued to a preceding letter or a following lowercase letter:
 *         `gsk`, `gskApiKey`, `_gsk`, `gsk-key`, but not `markeringskleur`
 *   Gsk   a camel-case segment: `hasGskAuth`, `GskAuthError`, `useGsk`
 *   GSK   an upper-case segment: `GSK_API_KEY`, `MAX_GSK_RESULTS`,
 *         `useGSKBackend`, but not `LOGSKIP`
 * A spelling split across two segments (`intgSkillVersion`) is not a match.
 */
const PATTERNS = [
  { name: 'genspark', regex: /genspark/gi },
  { name: 'mainfunc', regex: /mainfunc(?!tion)/gi },
  { name: 'genoffice.ai', regex: /genoffice\.ai/gi },
  { name: 'genteam', regex: /genteam/gi },
  {
    name: 'gsk',
    regex: /(?<![A-Za-z])gsk(?![a-z])|Gsk(?![a-z])|(?<![A-Z])GSK(?![a-z])(?![A-Z](?![a-z]))/g,
  },
]

/**
 * Random base64 is not text: a hash or an inlined font can spell the three
 * letters by chance. Blanked before matching, so the same file keeps passing
 * when a dependency bump changes a hash.
 */
const OPAQUE = [/\bsha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}/g, /;base64,[A-Za-z0-9+/]+={0,2}/g]

/**
 * What may still name the vendor. An entry applies to `path` (a string, a
 * RegExp, or every file when left out) and allows:
 *   - `span`     a hit inside text matching this RegExp
 *   - `line`     a hit on a line matching this RegExp
 *   - `section`  a hit in the Markdown section whose heading matches
 *   - `patterns` a hit of one of these pattern names
 *   - none of the above: every hit in the file
 * The path of a file is checked as one more line of that file (under no
 * heading), so the same entries decide about it.
 */
const ALLOW = [
  {
    path: 'LICENSE',
    reason: 'the licence of the original work, with its copyright notice',
  },
  {
    path: 'NOTICE',
    reason: 'the attribution notice the licence requires us to keep',
  },
  {
    line: /\bcopyright\b.*\b(?:mainfunc|genspark)\b/i,
    reason: 'a copyright notice inside a file stays as it was written',
  },
  {
    path: /^README(?:\.en)?\.md$/,
    span: /github\.com\/genspark-ai\/genoffice/g,
    reason: 'the link to the original project this product is based on',
  },
  {
    path: /^README(?:\.en)?\.md$/,
    section: /^## (?:License and acknowledgement|라이선스와 출처)$/,
    reason: 'the acknowledgement and trademark paragraphs',
  },
  {
    path: 'packages/agent-core/src/redact-range.ts',
    span: /https:\/\/genspark\.ai\/genoffice\/redaction\/2026/g,
    reason:
      'XML namespace written into saved documents: changing it would stop reading redactions made with the original',
  },
  {
    path: /^apps\/sheets\/native\/xlsx-engine\/src\/(?:lib|tests)\.rs$/,
    span: /genspark-ai-excel-/g,
    reason:
      'temp folder name inside the spreadsheet sidecar, never shown; renaming it means rebuilding the document engine',
  },
  {
    path: 'packages/ai-provider/tests/legacy-settings.test.ts',
    patterns: ['genspark', 'gsk'],
    reason: 'fixture of a settings file written by the original, with the ids it stored',
  },
  {
    span: /check[:-]no-genspark/g,
    reason: 'the name of this check, where it is registered and documented',
  },
  {
    path: 'tools/check-no-genspark.mjs',
    reason: 'this tool: the patterns and the allowlist name what they look for',
  },
  {
    path: 'packages/cli/tests/check-no-genspark.test.ts',
    reason: 'the tests of this tool feed it the text it must find',
  },
]

/** Never text, whatever the first bytes look like */
const BINARY_EXT =
  /\.(?:png|jpe?g|gif|webp|bmp|ico|icns|tiff?|emf|wmf|ttf|otf|woff2?|eot|zip|gz|tgz|7z|rar|docx?|xlsx?|pptx?|pdf|mp[34]|mov|webm|wav|ogg|wasm|node|exe|dll|dylib|so|bin)$/i

/** A NUL byte near the start marks the rest of the binary files (git's own heuristic) */
function looksBinary(bytes) {
  return bytes.subarray(0, 8000).includes(0)
}

function pathMatches(entry, file) {
  if (entry.path === undefined) return true
  return typeof entry.path === 'string' ? entry.path === file : entry.path.test(file)
}

/** [start, end) ranges of `line` that `regex` matches */
function spansOf(regex, line) {
  return [...line.matchAll(regex)].map((m) => [m.index, m.index + m[0].length])
}

/** The identifier, path or URL around a hit, so the report shows what was written */
function tokenAround(line, start, end) {
  let from = start
  let to = end
  while (from > 0 && /[\w@./:-]/.test(line[from - 1]) && start - from < 40) from--
  while (to < line.length && /[\w@./:-]/.test(line[to]) && to - end < 40) to++
  return line.slice(from, to)
}

/**
 * Index of the ALLOW entry that lets this hit through, or -1.
 * `sectionOf` answers the Markdown heading the current line sits under.
 */
function allowedBy(entries, hit, line, sectionOf) {
  for (const [index, entry] of entries) {
    if (entry.patterns && !entry.patterns.includes(hit.pattern)) continue
    if (entry.line && !entry.line.test(line)) continue
    if (entry.section && !entry.section.test(sectionOf())) continue
    if (
      entry.span &&
      !spansOf(entry.span, line).some(([from, to]) => from <= hit.start && hit.end <= to)
    ) {
      continue
    }
    return index
  }
  return -1
}

function hitsIn(line) {
  let text = line
  for (const opaque of OPAQUE) text = text.replace(opaque, (blob) => ' '.repeat(blob.length))
  const hits = []
  for (const { name, regex } of PATTERNS) {
    for (const m of text.matchAll(regex)) {
      hits.push({ pattern: name, start: m.index, end: m.index + m[0].length })
    }
  }
  return hits.sort((a, b) => a.start - b.start)
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

const git = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
if (git.status !== 0) {
  console.error(git.stderr)
  process.exit(git.status ?? 1)
}
const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim()

const violations = []
const violatingFiles = new Set()
const allowedCounts = ALLOW.map(() => 0)
let scanned = 0

for (const file of git.stdout.split('\0')) {
  if (!file) continue
  const entries = ALLOW.map((entry, index) => [index, entry]).filter(([, entry]) =>
    pathMatches(entry, file),
  )
  for (const hit of hitsIn(file)) {
    const allowed = allowedBy(entries, hit, file, () => '')
    if (allowed >= 0) {
      allowedCounts[allowed]++
      continue
    }
    violatingFiles.add(file)
    violations.push(`  ${file}: path: ${file.slice(hit.start, hit.end)}`)
  }
  if (BINARY_EXT.test(file)) continue
  let bytes
  try {
    bytes = readFileSync(join(root, file))
  } catch {
    continue // tracked but deleted in the working tree
  }
  if (looksBinary(bytes)) continue
  scanned++
  let heading = ''
  bytes
    .toString('utf8')
    .split('\n')
    .forEach((raw, index) => {
      const line = raw.replace(/\r$/, '')
      if (/^#{1,6} /.test(line)) heading = line
      for (const hit of hitsIn(line)) {
        const allowed = allowedBy(entries, hit, line, () => heading)
        if (allowed >= 0) {
          allowedCounts[allowed]++
          continue
        }
        violatingFiles.add(file)
        violations.push(`  ${file}:${index + 1}: ${tokenAround(line, hit.start, hit.end)}`)
      }
    })
}

const allowedTotal = allowedCounts.reduce((sum, count) => sum + count, 0)
const allowedSummary = plural(allowedTotal, 'allowlisted hit')

if (process.argv.includes('--allowed')) {
  ALLOW.forEach((entry, index) => {
    const where = entry.path === undefined ? '(any file)' : String(entry.path)
    console.log(`${String(allowedCounts[index]).padStart(5)}  ${where}: ${entry.reason}`)
  })
}

if (violations.length > 0) {
  console.error(
    `check-no-genspark: ${plural(violations.length, 'hit')} in ${plural(violatingFiles.size, 'file')} ` +
      `outside the allowlist (${allowedSummary})\n${violations.join('\n')}\n` +
      'Nothing tied to Genspark may come back. Remove it, or, if it is one of the things that ' +
      'must stay (licence, attribution, identifiers stored in documents), add an entry with its ' +
      'reason to ALLOW in tools/check-no-genspark.mjs.',
  )
  process.exit(1)
}
console.log(`check-no-genspark: OK (${plural(scanned, 'file')} scanned, ${allowedSummary})`)
