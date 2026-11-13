/**
 * Asset licence gate: every tracked file that ships and is not npm or Rust
 * code (fonts, images, icons, blank documents, the built-in skills, vendored
 * trees) must match an entry of tools/asset-licenses.json, which names its
 * licence and the file that records where it came from. The npm and Rust
 * gates (check-licenses.mjs, deny.toml) cover dependencies; this covers what
 * is checked in. Entries are tried in order and the first match wins, so a
 * specific entry goes above the glob that would also match it.
 *
 * Fails on: a shipped asset no entry matches, an entry that matches nothing
 * (a renamed or deleted file), and a record file that is not tracked.
 *
 *   node tools/check-asset-licenses.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const ASSET =
  /\.(ttf|otf|ttc|woff2?|png|jpe?g|gif|webp|bmp|svg|ico|icns|mp3|wav|ogg|mp4|webm|wasm|docx|dotx|xlsx|xltx|xls|pptx|potx|hwp|hwpx|odt|ods|odp|epub|pdf)$/i
// every file of these trees ships, whatever its type
const SHIPPED_TREE = /^(apps\/shell\/resources|vendor|skills)\//
// tests, fixtures, the docs and the tooling never reach a package
const NOT_SHIPPED = /(^|\/)(tests?|__tests__|e2e|fixtures)\/|^(docs|tools|formal|\.github)\//

/** `**` spans folders, `*` stays inside one */
function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      re += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (ch === '*') {
      re += '[^/]*'
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
const trackedSet = new Set(tracked)
const shipped = tracked.filter(
  (path) => !NOT_SHIPPED.test(path) && (ASSET.test(path) || SHIPPED_TREE.test(path)),
)

const entries = JSON.parse(readFileSync(join(ROOT, 'tools', 'asset-licenses.json'), 'utf8'))
const problems = []
const matched = entries.map(() => 0)
const patterns = entries.map((entry, i) => {
  if (!entry.files || !entry.licence || !entry.record || !entry.source) {
    problems.push(`entry ${i + 1}: needs files, licence, record and source`)
  } else if (!trackedSet.has(entry.record)) {
    problems.push(`${entry.files}: record ${entry.record} is not a tracked file`)
  }
  return globToRegExp(entry.files ?? '')
})

const unlisted = []
for (const path of shipped) {
  const i = patterns.findIndex((re) => re.test(path))
  if (i === -1) unlisted.push(path)
  else matched[i]++
}
for (const path of unlisted) {
  problems.push(`${path}: no entry in tools/asset-licenses.json`)
}
entries.forEach((entry, i) => {
  if (matched[i] === 0) problems.push(`${entry.files}: matches no shipped file`)
})

if (problems.length > 0) {
  console.error('Asset licence records are incomplete:\n')
  for (const p of problems) console.error(`  ${p}`)
  console.error(
    '\nName each shipped asset in tools/asset-licenses.json with its licence and the file that records its source.',
  )
  process.exit(1)
}

console.log(
  `All ${shipped.length} shipped assets have a licence record (${entries.length} entries).`,
)
