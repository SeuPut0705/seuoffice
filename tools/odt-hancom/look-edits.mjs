// Runs hancom.py look over the received files (<run>/base), each kind of edited copies
// (<run>/edits/<kind>/_hancom), the docx->ODT exports (<run>/export/look) and the docx sources
// (<run>/docx-look), one Hangul process at a time.
//
//   node tools/odt-hancom/look-edits.mjs [--corpus DIR] [--run DIR] [--what base,edits,export,docx]
//        [--kinds a,b] [--python python] [--fresh] [--new]
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LOOK_MARKS } from './marks.mjs'
import { TOOL_DIR, corpusDir, parseArgs, runDir } from './lib.mjs'

const opts = parseArgs()
const corpus = corpusDir(opts)
const run = runDir(opts)
const what = String(opts.what || 'base,edits,export,docx').split(',')
const python = String(opts.python || 'python')
const driver = join(TOOL_DIR, 'hancom.py')

function look(out, items, extra = []) {
  const args = [
    driver,
    'look',
    '--out',
    out,
    ...items,
    ...extra,
    ...(opts.fresh ? ['--fresh'] : []),
    ...(opts.new ? ['--new'] : []),
  ]
  console.log(`> ${python} ${args.join(' ')}`)
  const r = spawnSync(python, args, { stdio: 'inherit' })
  if (r.status !== 0) console.error(`hancom.py exited with ${r.status}`)
}

if (what.includes('base'))
  look(join(run, 'base'), [join(corpus, 'hancom'), join(corpus, 'gov')], ['--match', '\\.odt$'])
if (what.includes('edits')) {
  const dir = join(run, 'edits')
  const kinds = opts.kinds ? String(opts.kinds).split(',') : existsSync(dir) ? readdirSync(dir) : []
  for (const kind of kinds) {
    const folder = join(dir, kind)
    if (!existsSync(folder) || !statSync(folder).isDirectory()) continue
    if (!readdirSync(folder).some((n) => n.endsWith('.odt'))) continue
    const marks = LOOK_MARKS[kind] ? ['--marks', LOOK_MARKS[kind].join(',')] : []
    look(join(folder, '_hancom'), [folder], ['--match', '\\.odt$', ...marks])
  }
}
if (what.includes('export'))
  look(join(run, 'export', 'look'), [join(run, 'export', 'odt')], ['--match', '\\.odt$'])
if (what.includes('docx'))
  look(join(run, 'docx-look'), [join(corpus, 'docx')], ['--match', '\\.docx$'])
