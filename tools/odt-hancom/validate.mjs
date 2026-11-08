// Runs the ODF validator (odfvalidator 0.13, Java 17) over the received ODT files, every edited
// copy and the docx->ODT exports, and checks that our outputs add no errors.
//
//   node tools/odt-hancom/validate.mjs [--corpus DIR] [--run DIR] [--jar PATH]
//
// --jar defaults to <corpus>/scripts/odfvalidator.jar. Writes <run>/validate.json:
//   received: { file: { errors, messages } }, edits: { kind: { file: {...} } }, export: { file: {...} }
// and prints, per kind, how many copies have more errors than the received file or an error
// message the received file does not have (positions ignored).
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { corpusDir, parseArgs, runDir } from './lib.mjs'

const opts = parseArgs()
const corpus = corpusDir(opts)
const run = runDir(opts)
const jar = resolve(opts.jar || join(corpus, 'scripts', 'odfvalidator.jar'))
if (!existsSync(jar)) throw new Error(`${jar} is missing (pass --jar)`)

const odts = (dir) =>
  existsSync(dir) && statSync(dir).isDirectory()
    ? readdirSync(dir)
        .filter((n) => /\.odt$/i.test(n))
        .map((n) => join(dir, n))
    : []

/** Validator findings per file: error count and the messages without their positions. */
function validate(files) {
  const out = {}
  for (let i = 0; i < files.length; i += 40) {
    const batch = files.slice(i, i + 40)
    const r = spawnSync('java', ['-jar', jar, ...batch], { encoding: 'utf8', maxBuffer: 1 << 28 })
    const lines = `${r.stdout}\n${r.stderr}`.split(/\r?\n/)
    for (const f of batch) {
      const mine = lines.filter(
        (l) => l.startsWith(f) && /\bError:/.test(l) && !/For more information/.test(l),
      )
      out[basename(f)] = {
        errors: mine.length,
        // the kind of each error: positions, the package path and quoted values left out
        messages: [
          ...new Set(
            mine.map((l) =>
              l
                .slice(f.length)
                .replace(/\[\d+,\d+\]/, '')
                .replace(/'file:[^']*'/g, "'<package>'")
                .replace(/"[^"]*"/g, '"…"')
                .trim(),
            ),
          ),
        ],
      }
    }
  }
  return out
}

const received = validate(['hancom', 'gov'].flatMap((s) => odts(join(corpus, s))))
const edits = {}
const editsDir = join(run, 'edits')
for (const kind of existsSync(editsDir) ? readdirSync(editsDir) : []) {
  const files = odts(join(editsDir, kind))
  if (files.length) edits[kind] = validate(files)
}
const exported = validate(odts(join(run, 'export', 'odt')))
writeFileSync(
  join(run, 'validate.json'),
  JSON.stringify({ jar, received, edits, export: exported }, null, 1),
)

for (const [kind, files] of Object.entries(edits)) {
  let more = 0
  let newMsg = 0
  for (const [name, v] of Object.entries(files)) {
    const base = received[name]
    if (!base) continue
    if (v.errors > base.errors) more++
    if (v.messages.some((m) => !base.messages.includes(m))) newMsg++
  }
  console.log(
    `${kind.padEnd(9)} ${Object.keys(files).length} files, more errors ${more}, new messages ${newMsg}`,
  )
}
const exportErrors = Object.values(exported).filter((v) => v.errors > 0).length
console.log(`export    ${Object.keys(exported).length} files, with errors ${exportErrors}`)
const total = Object.values(received).reduce((n, v) => n + v.errors, 0)
console.log(`received  ${Object.keys(received).length} files, ${total} errors`)
