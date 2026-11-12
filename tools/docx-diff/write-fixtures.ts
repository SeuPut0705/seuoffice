// Writes crates/fixtures/package-layer.json: inputs of the package layer with
// the answers of the TypeScript engine, which the Rust tests assert against.
// Run again whenever the TypeScript engine or package-zips.ts changes:
//   npm --prefix tools/docx-diff run fixtures
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  dedupeStyleRefs,
  hasDuplicateStyleRefs,
  needsOoxmlNormalization,
  normalizeOoxmlXml,
} from './reference/ooxml-normalize'
import { resolveRelationshipTargetPath } from './reference/parse-package'
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

/** Repeated style refs of one property set, and the neighbours that are not. */
const STYLE_REFS = [
  '<w:pPr><w:pStyle w:val="Heading1"/><w:pStyle w:val="MdHeading1"/></w:pPr>',
  '<w:pPr><w:pStyle w:val="A"/>\n  <w:pStyle w:val="B"/>\t<w:pStyle w:val="C"/><w:jc w:val="left"/></w:pPr>',
  '<w:rPr><w:rStyle w:val="A"/><w:rStyle w:val="B"/></w:rPr>',
  '<w:pPr><w:pStyle w:val="A"/><w:rStyle w:val="B"/></w:pPr>',
  '<w:pPr><w:pStyle w:val="A"/><w:jc w:val="left"/><w:pStyle w:val="B"/></w:pPr>',
  '<w:pPr><w:pStyle w:val="A"></w:pStyle><w:pStyle w:val="B"/></w:pPr>',
  '<w:pPr><w:pStyle w:val="a/"/><w:pStyle w:val="b"/></w:pPr>',
  '<w:pPr><w:pStyleX w:val="A"/><w:pStyle w:val="B"/></w:pPr>',
  '<w:p><w:pPr><w:pStyle w:val="A"/></w:pPr></w:p><w:p><w:pPr><w:pStyle w:val="B"/></w:pPr></w:p>',
  '<w:pPr><w:pStyle w:val="A"/><w:pStyle w:val="B"/></w:pPr><w:pPr><w:rStyle w:val="A"/><w:rStyle w:val="B"/><w:rStyle w:val="C"/></w:pPr>',
  '<w:pStyle/><w:pStyle/>',
  '',
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
  styleRefs: STYLE_REFS.map((xml) => ({
    xml,
    duplicated: hasDuplicateStyleRefs(xml),
    deduped: dedupeStyleRefs(xml),
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
