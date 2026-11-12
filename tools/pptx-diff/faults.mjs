// One Rust fault at a time, through the same comparisons as the parity gate.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

if (Number(process.versions.node.split('.')[0]) !== 22)
  throw new Error('fault probes require Node 22')
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const leaf = 'crates/pptx-engine/src/'
const faults = [
  [
    'scan-shape-set',
    'pptxLeaves.scan.scanSlide',
    leaf + 'scan.rs',
    'SHAPE_TAGS.contains(&name)',
    'name == "p:sp"',
  ],
  [
    'node-array-is-object',
    'pptxLeaves.xml-utils.asXmlNode',
    leaf + 'xml_utils.rs',
    'Some(node @ (Value::Object(_) | Value::Array(_))) => node,',
    'Some(node @ Value::Object(_)) => node,',
  ],
  [
    'array-zero-truthy',
    'pptxLeaves.xml-utils.xmlArray',
    leaf + 'xml_utils.rs',
    'Some(v) if value_truthy(Some(v)) =>',
    'Some(v) =>',
  ],
  [
    'numeric-hex-radix',
    'pptxLeaves.xml-utils.decodeNumericCharRefs',
    leaf + 'xml_utils.rs',
    'Some(hex) => parse_int(hex, Radix::Sixteen)',
    'Some(hex) => parse_int(hex, Radix::Ten)',
  ],
  [
    'text-control-sanitizer',
    'pptxLeaves.xml-utils.escapeXmlText',
    leaf + 'xml_utils.rs',
    'sanitize_xml_chars(text)\n',
    'Cow::Borrowed(text)\n',
  ],
  [
    'attribute-quote-escape',
    'pptxLeaves.xml-utils.escapeXmlAttr',
    leaf + 'xml_utils.rs',
    '.replace(\'"\', "&quot;")',
    '.replace(\'"\', "&apos;")',
  ],
  [
    'relationship-maximum',
    'pptxLeaves.xml-utils.maxRelationshipIdNumber',
    leaf + 'xml_utils.rs',
    'if n > max {',
    'if n < max {',
  ],
  [
    'override-leading-slash',
    'pptxLeaves.xml-utils.hasContentTypeOverride',
    leaf + 'xml_utils.rs',
    'format!("/{part_path}")',
    'format!("{part_path}")',
  ],
  [
    'creation-uppercase',
    'pptxLeaves.xml-utils.creationIdExtXml',
    leaf + 'xml_utils.rs',
    'uuid.to_uppercase()',
    'uuid.to_lowercase()',
  ],
  [
    'creation-extlst-wrapper',
    'pptxLeaves.xml-utils.creationIdXml',
    leaf + 'xml_utils.rs',
    '"<a:extLst>{}</a:extLst>"',
    '"{}"',
  ],
  [
    'default-any-not-all',
    'pptxLeaves.xml-utils.hasDefaultFor',
    leaf + 'xml_utils.rs',
    '.any(|tag| re.test(tag.as_str()))',
    '.all(|tag| re.test(tag.as_str()))',
  ],
  [
    'slide-ceiling-boundary',
    'pptxLeaves.slide-ids.nextSlideId',
    leaf + 'slide_ids.rs',
    'if id > SLIDE_ID_MAX {',
    'if id >= SLIDE_ID_MAX {',
    2,
  ],
  [
    'named-action-equality',
    'pptxLeaves.named-action.namedActionOf',
    leaf + 'named_action.rs',
    '*named == name',
    '*named != name',
  ],
  [
    'named-action-prefix',
    'pptxLeaves.named-action.namedActionAttr',
    leaf + 'named_action.rs',
    'format!("{SHOWJUMP_ACTION}{action}")',
    'action.to_owned()',
  ],
  [
    'grid-merged-followers',
    'pptxLeaves.table-grid.tableRowGridCols',
    leaf + 'table_grid.rs',
    'f.merged == Some(true)',
    'f.merged == Some(false)',
  ],
  [
    'crc-initial-value',
    'pptxLeaves.crc32.crc32',
    leaf + 'crc32.rs',
    'let mut c = u32::MAX;',
    'let mut c = 0;',
  ],
  [
    'package-hash-case',
    'pptxPackage.open',
    leaf + 'zip.rs',
    'format!("{:x}", Sha256::digest(bytes))',
    'format!("{:X}", Sha256::digest(bytes))',
  ],
  [
    'package-empty-exists',
    'pptxPackage.has',
    leaf + 'zip.rs',
    'self.entries.has(path)',
    'self.entries.get(path).is_some_and(|bytes| !bytes.is_empty())',
  ],
  [
    'package-empty-text',
    'pptxPackage.readText',
    leaf + 'zip.rs',
    'self.entries.get(path).map(|bytes| decode_text(bytes))',
    'self.entries.get(path).filter(|bytes| !bytes.is_empty()).map(|bytes| decode_text(bytes))',
  ],
  [
    'package-empty-bytes',
    'pptxPackage.readBytes',
    leaf + 'zip.rs',
    'self.entries.get(path).map(Vec::as_slice)',
    'self.entries.get(path).filter(|bytes| !bytes.is_empty()).map(Vec::as_slice)',
  ],
  [
    'relationship-type-value',
    'pptxPackage.readRels',
    leaf + 'zip.rs',
    'r#type: text("@_Type")',
    'r#type: text("@_Target")',
  ],
  [
    'presentation-width-fallback',
    'pptxPackage.readPresentation',
    leaf + 'zip.rs',
    'emu_or(sz.get("@_cx"), 9_144_000.0)',
    'emu_or(sz.get("@_cx"), 1.0)',
  ],
  [
    'chain-theme-target',
    'pptxPackage.resolveSlideChain',
    leaf + 'zip.rs',
    'self.first_target(master, "/theme")?',
    'self.first_target(master, "/slideMaster")?',
  ],
  [
    'rels-filename-suffix',
    'pptxPackage.relsPathFor',
    leaf + 'zip.rs',
    'format!("{prefix}_rels/{file}.rels")',
    'format!("{prefix}_rels/{file}.xml")',
  ],
  [
    'target-root-anchor',
    'pptxPackage.resolveTarget',
    leaf + 'zip.rs',
    "normalized.starts_with('/')",
    "normalized.starts_with('!')",
  ],
  [
    'declared-count-boundary',
    'pptxPackage.assertZipWithinLimits',
    leaf + 'zip.rs',
    'files.len() > limits.max_parts',
    'files.len() >= limits.max_parts',
  ],
  [
    'xml-integer-key-order',
    'pptxXml.parseObject',
    'crates/ooxml-xml/src/object.rs',
    'in_property_order(object)',
    'object',
  ],
  [
    'independent-scan-byte-offset',
    'pptxLeaves.scan.scanSlide',
    'crates/office-wasm/src/calls/pptx_leaves.rs',
    'end: map.to_utf16(element.end as usize)',
    'end: element.end as u32',
  ],
  [
    'independent-target-decoding',
    'pptxPackage.resolveTarget',
    leaf + 'zip.rs',
    'let normalized = decoded.replace(\'\\\\\', "/");',
    'let normalized = target.replace(\'\\\\\', "/");',
  ],
  [
    'independent-xml-repeat-order',
    'pptxXml.parseObject',
    'crates/ooxml-xml/src/object.rs',
    'items.push(value);',
    'items.insert(0, value);',
  ],
]

const out = resolve(here, 'out/faults')
const target = resolve(root, 'crates/target/fault-probes')
const env = {
  ...process.env,
  CARGO_BUILD_JOBS: '4',
  CARGO_TARGET_DIR: target,
  SEUOFFICE_WASM: resolve(target, 'wasm32-wasip1/debug/office_wasm.wasm'),
}
if (process.argv.includes('--inventory')) {
  for (const [id, , file, before, , occurrences = 1] of faults) {
    const count = readFileSync(resolve(root, file), 'utf8').split(before).length - 1
    console.log(`${count === occurrences ? 'OK' : 'STALE'} ${id}: ${count}/${occurrences}`)
  }
  process.exit(0)
}
const onlyAt = process.argv.indexOf('--only')
const only = onlyAt === -1 ? null : new Set(process.argv[onlyAt + 1].split(','))
const selected = faults.filter(([id]) => only === null || only.has(id))
if (only !== null && selected.length !== only.size) throw new Error('--only names an unknown fault')
// A scratch copy: an interrupted probe leaves no fault in the working tree.
const workspace = mkdtempSync(join(tmpdir(), 'pptx-faults-'))
cpSync(resolve(root, 'crates'), resolve(workspace, 'crates'), {
  recursive: true,
  filter: (source) => {
    const path = relative(resolve(root, 'crates'), source)
    return path !== 'target' && !path.startsWith(`target${sep}`)
  },
})
const args = [
  'build',
  '--locked',
  '--target',
  'wasm32-wasip1',
  '--manifest-path',
  resolve(workspace, 'crates/Cargo.toml'),
  '-p',
  'office-wasm',
  '-j4',
]
mkdirSync(out, { recursive: true })
const run = (program, args, extraEnv = {}) =>
  spawnSync(program, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...env, ...extraEnv },
  })
const compareArgs = [
  resolve(root, 'node_modules/tsx/dist/cli.mjs'),
  resolve(here, 'main.ts'),
  '--calls-only',
  '--by-function',
]
const baselineBuild = run('cargo', args)
if (baselineBuild.status !== 0) throw new Error(baselineBuild.stderr || String(baselineBuild.error))
const baseline = run(process.execPath, compareArgs, { PPTX_DIFF_OUT: resolve(out, 'baseline') })
writeFileSync(resolve(out, 'baseline.log'), (baseline.stdout ?? '') + (baseline.stderr ?? ''))
if (baseline.status !== 0) throw new Error('fault baseline failed: out/faults/baseline.log')
const results = []
for (const [id, fn, file, before, after, occurrences = 1] of selected) {
  const path = resolve(workspace, file)
  const original = readFileSync(path, 'utf8')
  const count = original.split(before).length - 1
  if (count !== occurrences)
    throw new Error(`${id}: source anchor occurs ${count}, expected ${occurrences}`)
  let result
  try {
    writeFileSync(path, original.replace(before, after))
    const build = run('cargo', args)
    if (build.status !== 0) throw new Error(build.stderr || String(build.error))
    const compared = run(process.execPath, compareArgs, { PPTX_DIFF_OUT: resolve(out, id) })
    writeFileSync(resolve(out, `${id}.log`), (compared.stdout ?? '') + (compared.stderr ?? ''))
    const tally = (compared.stdout ?? '')
      .split('\n')
      .find((line) => line.trim().startsWith(fn + ' '))
    const differences = Number(/differences\s+(\d+)/.exec(tally ?? '')?.[1] ?? 0)
    result = { id, fn, file, before, after, differences, caught: differences > 0 }
  } finally {
    writeFileSync(path, original)
  }
  results.push(result)
  console.log(
    `${result.caught ? 'CAUGHT' : 'MISSED'} ${id}: ${fn}, ${result.differences} differences`,
  )
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(results, null, 2) + '\n')
}
rmSync(workspace, { recursive: true, force: true })
process.exit(results.every((result) => result.caught) ? 0 : 1)
