// The likely-subtags tables of crates/docx-engine/src/blank/locale.rs: what
// `new Intl.Locale(tag).maximize().region` answers in this Node, kept only
// where the answer is one of the regions where Word starts on Letter.
//
// The committed table was produced by Node 22.22.3 (ICU 78.3, CLDR 48.0).
// It is not part of the gate. From the repository root:
//
//   node tools/docx-diff/blank-locale-table.mjs           compare with the committed table
//   node tools/docx-diff/blank-locale-table.mjs --write   replace it
//
// It asks Intl about every two- and three-letter language, every language
// that Intl knows with every script und-<script> answers for, and every
// region code (two letters, three digits), with probes of several languages
// so that a region whose answer depends on the language shows. About 30 s.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TARGET = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../crates/docx-engine/src/blank/locale.rs',
)
const LETTER = new Set([
  'US',
  'CA',
  'MX',
  'PH',
  'LR',
  'MM',
  'PR',
  'CL',
  'CO',
  'VE',
  'GT',
  'CR',
  'PA',
  'DO',
])
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'

function letterOf(tag) {
  try {
    const region = new Intl.Locale(tag).maximize().region
    return LETTER.has(region) ? region : null
  } catch {
    return 'THROW'
  }
}

function maximizes(tag) {
  try {
    return new Intl.Locale(tag).maximize().toString() !== tag
  } catch {
    return false
  }
}

// every two- and three-letter code, und among them
const languages = []
for (const a of ALPHABET)
  for (const b of ALPHABET) {
    languages.push(a + b)
    for (const c of ALPHABET) languages.push(a + b + c)
  }
const known = languages.filter(maximizes)

const languageRegions = []
for (const language of known) {
  const region = letterOf(language)
  if (region) languageRegions.push([language, region])
}

const scripts = new Set(['Latn', 'Zzzz', 'Zyyy', 'Qaaa'])
for (const a of ALPHABET.toUpperCase())
  for (const b of ALPHABET)
    for (const c of ALPHABET)
      for (const d of ALPHABET) {
        const script = a + b + c + d
        const tag = `und-${script}`
        const notEnglish = maximizes(tag) && new Intl.Locale(tag).maximize().language !== 'en'
        if (notEnglish || letterOf(tag) !== 'US') scripts.add(script)
      }

const scriptRegions = []
for (const language of known) {
  const own = letterOf(language)
  for (const script of scripts) {
    const region = letterOf(`${language}-${script}`)
    if (region !== own) scriptRegions.push([language, script.toLowerCase(), region])
  }
}

const regions = []
for (const a of ALPHABET) for (const b of ALPHABET) regions.push((a + b).toUpperCase())
for (let n = 0; n < 1000; n++) regions.push(String(n).padStart(3, '0'))
const PROBES = [
  'en',
  'es',
  'und',
  'zzz',
  'my',
  'fil',
  'en-Latn',
  'und-Latn',
  'zzz-Cyrl',
  'ru',
  'hy',
  'sr',
  'nl',
  'abcde',
]
const regionRegions = []
for (const region of regions) {
  const answers = new Set(PROBES.map((probe) => letterOf(`${probe}-${region}`)))
  // ZZ and 999 depend on the language: locale.rs handles them in code
  if (answers.size > 1 && region !== 'ZZ' && region !== '999') {
    console.error(`region ${region} answers differently per language: locale.rs needs a rule`)
    process.exitCode = 1
  }
  const [answer] = answers
  if (answers.size === 1 && answer) regionRegions.push([region, answer])
}

const byKey = (a, b) => (a.join('-') < b.join('-') ? -1 : 1)
const quoted = (value) => (value === null ? 'None' : `"${value}"`)
const table =
  '/// Languages (as written, before alias replacement) whose likely region is a\n' +
  '/// Letter region.\n' +
  `static LANGUAGE_REGIONS: [(&str, &str); ${languageRegions.length}] = [\n` +
  languageRegions
    .sort(byKey)
    .map(([l, r]) => `    ("${l}", "${r}"),\n`)
    .join('') +
  '];\n\n' +
  "/// Language and script pairs whose likely region is not the language's own.\n" +
  `static SCRIPT_REGIONS: [(&str, &str, Option<&str>); ${scriptRegions.length}] = [\n` +
  scriptRegions
    .sort(byKey)
    .map(([l, s, r]) => `    ("${l}", "${s}", ${r === null ? 'None' : `Some(${quoted(r)})`}),\n`)
    .join('') +
  '];\n\n' +
  '/// Region codes, aliases included, that stand for a Letter region.\n' +
  `static REGIONS: [(&str, &str); ${regionRegions.length}] = [\n` +
  regionRegions
    .sort(byKey)
    .map(([c, r]) => `    ("${c}", "${r}"),\n`)
    .join('') +
  '];\n'

const source = readFileSync(TARGET, 'utf8')
const at = source.indexOf('/// Languages (as written')
if (at < 0) throw new Error(`no table in ${TARGET}`)
const { node, icu, cldr } = process.versions
if (process.argv.includes('--write')) {
  writeFileSync(TARGET, source.slice(0, at) + table)
  console.log(`locale.rs: table written from Node ${node} (ICU ${icu}, CLDR ${cldr})`)
} else if (source.slice(at) === table) {
  console.log(`locale.rs: table matches Node ${node} (ICU ${icu}, CLDR ${cldr})`)
} else {
  console.log(
    `locale.rs: table differs from Node ${node} (ICU ${icu}, CLDR ${cldr}); --write replaces it`,
  )
  process.exitCode = 1
}
