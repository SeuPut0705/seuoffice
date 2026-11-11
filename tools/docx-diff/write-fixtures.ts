// Writes crates/fixtures/package-layer.json: inputs of the package layer with
// the answers of the TypeScript engine, which the Rust tests assert against.
// Run again whenever the TypeScript engine or package-zips.ts changes:
//   npm --prefix tools/docx-diff run fixtures
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  needsOoxmlNormalization,
  normalizeOoxmlXml,
} from '../../packages/docx-engine/src/ooxml-normalize'
import { resolveRelationshipTargetPath } from '../../packages/docx-engine/src/parse-package'
import { typescriptOpen } from './compare-package'
import { repoRoot } from './harness'
import { oddContainers, STRICT_PARTS } from './package-zips'

/** Containers past this size stay in the gate only. */
const LARGEST_CONTAINER = 20_000

const SOURCES = ['', 'word/document.xml', 'word/sub/part.xml', 'top.xml']
const TARGETS = [
  'styles.xml',
  'media/image1.png',
  '../customXml/item1.xml',
  '../../outside.xml',
  '/word/rooted.xml',
  '/../x',
  '\\rooted\\by\\backslash.xml',
  '..\\up.xml',
  'a/./b/../c.xml',
  'a//b.xml',
  './',
  '',
  '#fragment',
  'part.xml#fragment',
  'http://example.com/x',
  'mailto:a@b',
  'C:\\x',
  'file:///c:/x',
  'trial%20run.xml',
  '%ED%95%9C%EA%B8%80.xml',
  '%2e%2e/x',
  'a%2Fb',
  '%zz',
  '%E0%A4%A',
  '%C0%AF',
  '1:colon-after-a-digit',
]

const containers = []
for (const [name, docx] of oddContainers()) {
  if (docx.length > LARGEST_CONTAINER) continue
  containers.push({
    name,
    docx: Buffer.from(docx).toString('hex'),
    typescript: await typescriptOpen(docx),
  })
}

const fixtures = {
  source:
    'tools/docx-diff/write-fixtures.ts: every answer is what the TypeScript engine of this checkout gave',
  containers,
  normalized: STRICT_PARTS.map((xml) => ({
    xml,
    needed: needsOoxmlNormalization(xml),
    normalized: normalizeOoxmlXml(xml),
  })),
  targets: SOURCES.flatMap((source) =>
    TARGETS.map((target) => ({
      source,
      target,
      resolved: resolveRelationshipTargetPath(source, target),
    })),
  ),
}
const path = resolve(repoRoot, 'crates/fixtures/package-layer.json')
writeFileSync(path, `${JSON.stringify(fixtures, null, 1)}\n`)
console.log(
  `${path}: ${containers.length} containers, ${fixtures.normalized.length} parts, ${fixtures.targets.length} targets`,
)
