// Comparison (e): the package layer, over the corpus, built containers and
// seeded mutations.
import { isDeepStrictEqual } from 'node:util'
import type JSZip from 'jszip'
import {
  compareModels,
  compareNormalized,
  comparePackage,
  driftedCopies,
  openOnce,
  rustParts,
  typescriptParts,
  writePathReport,
} from './compare-package'
import { mutateProps } from './compare-props'
import { mutate } from './compare-xml'
import { atFloor, Comparison, failGate, option } from './harness'
import {
  hostileContainers,
  mutateContainer,
  oddContainers,
  richSeeds,
  STRICT_PARTS,
  strictified,
} from './package-zips'

const CONTAINER_FUZZ_CASES = option('--container-fuzz', 3_000)
const PART_FUZZ_CASES = option('--part-fuzz', 1_500)
/** What the zip gate says of an archive JSZip would read as ZIP64. */
const ZIP64_REFUSAL = { refused: 'zip: zip64 archives are not supported' }

const opened = new Comparison('(e) packages opened, corpus documents', 'packagesOpened')
const values = new Comparison('(e) package values, corpus, checks', 'packageValueChecks')
const normalized = new Comparison('(e) normalizeOoxmlXml, corpus parts', 'normalizedParts')
const strict = new Comparison(
  '(e) normalizeOoxmlXml, strict and odd parts',
  'normalizedStrictParts',
)
const built = new Comparison('(e) built containers: refusals and oddities', 'builtContainers')
const builtValues = new Comparison(
  '(e) package values, built containers, checks',
  'builtValueChecks',
)
const containers = new Comparison('(e+) mutated containers', CONTAINER_FUZZ_CASES)
const containerValues = new Comparison(
  '(e+) package values, mutated containers, checks',
  'mutatedContainerValueChecks',
)
const parts = new Comparison('(e+) package values, mutated parts, checks', 'mutatedPartValueChecks')
const normalizedMutations = new Comparison(
  '(e+) normalizeOoxmlXml, mutated parts',
  'normalizedMutatedParts',
)

/** The text parts of a corpus document: the seeds of the part mutations. */
interface PackageSeed {
  where: string
  parts: Array<[name: string, text: string]>
}
const seeds: PackageSeed[] = []
/** Small corpus documents: the seeds of the container mutations. */
const smallContainers: Array<{ where: string; docx: Uint8Array }> = []
const normalizeSeeds = new Set<string>()
/** What the TypeScript loader refused among the built containers, by message. */
const refusals = new Map<string, number>()
let mutatedContainersRefused = 0

/** The parts the mutations aim at. */
const isTarget = (name: string): boolean =>
  /(^|\/)(styles|numbering|theme\d*|settings|fontTable|comments)\.xml$|\.rels$|^\[Content_Types\]\.xml$/.test(
    name,
  )

export async function packageOnDocument(
  where: string,
  docx: Uint8Array,
  zip: JSZip,
): Promise<void> {
  await comparePackage(opened, values, where, docx)
  if (docx.length < 40_000) smallContainers.push({ where, docx })

  const texts: Array<[string, string]> = []
  const batch: string[] = []
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir || !/\.(xml|rels)$/i.test(name)) continue
    const text = await file.async('string')
    batch.push(text)
    // the body is not read by the package readers: a stub keeps the part present
    if (isTarget(name) && text.length < 400_000) {
      texts.push([name, text])
      if (text.length < 20_000) normalizeSeeds.add(text)
    } else if (name === 'word/document.xml') texts.push([name, '<w:document/>'])
  }
  compareNormalized(normalized, where, batch)
  compareNormalized(
    strict,
    `${where}, as strict`,
    batch.filter((text) => text.length < 200_000).map(strictified),
  )
  seeds.push({ where, parts: texts })
}

export async function packageAfterCorpus(random: () => number): Promise<void> {
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]!

  compareNormalized(strict, 'synthetic strict parts', STRICT_PARTS)
  for (const [name, docx] of oddContainers()) {
    const typescript = await comparePackage(built, builtValues, `built "${name}"`, docx)
    if ('refused' in typescript) {
      const kind = typescript.refused.replace(/\d+/g, 'N').replace(/part .*? /, 'part X ')
      refusals.set(kind, (refusals.get(kind) ?? 0) + 1)
    }
  }
  // JSZip never returned from these, so each loader opens them in a process of
  // its own. Both have to refuse at the gate: comparing the two with each
  // other would also pass two loaders that hang alike.
  for (const [name, docx] of Object.entries(hostileContainers())) {
    const typescript = openOnce('typescript', docx)
    const rust = openOnce('rust', docx)
    built.record(
      isDeepStrictEqual(typescript, ZIP64_REFUSAL) && isDeepStrictEqual(rust, ZIP64_REFUSAL)
        ? null
        : `built "${name}": both must refuse with "${ZIP64_REFUSAL.refused}"; ` +
            `typescript ${JSON.stringify(typescript)}; rust ${JSON.stringify(rust)}`,
    )
  }

  // one mutation in three starts from a built package: the tracked documents
  // hold no embedded font, comment reply, protection or picture bullet
  const rich = richSeeds()
  for (let index = 0; index < CONTAINER_FUZZ_CASES; index++) {
    const seed = index % 3 === 2 ? pick(rich) : pick(smallContainers)
    const docx = mutateContainer(seed.docx, random)
    const typescript = await comparePackage(
      containers,
      containerValues,
      `container mutation ${index} of ${seed.where}`,
      docx,
    )
    if ('refused' in typescript) mutatedContainersRefused += 1
  }

  for (let index = 0; index < PART_FUZZ_CASES; index++) {
    const seed = index % 3 === 2 ? pick(rich) : pick(seeds)
    const targets = seed.parts.filter(([name]) => name !== 'word/document.xml')
    if (targets.length === 0) continue
    const [target] = pick(targets)
    const mutated = seed.parts.map(([name, text]): [string, string] => [
      name,
      name !== target ? text : index % 2 === 0 ? mutate(text, random) : mutateProps(text, random),
    ])
    compareModels(
      parts,
      `part mutation ${index} of ${seed.where}: ${target}`,
      await typescriptParts(mutated),
      rustParts(mutated),
    )
  }

  const normalizeTexts = [...normalizeSeeds]
  for (let done = 0; done < PART_FUZZ_CASES; done += 100) {
    const batch = Array.from({ length: 100 }, (_, index) => {
      const text = pick(normalizeTexts)
      const edited = index % 2 === 0 ? mutate(text, random) : mutateProps(text, random)
      return index % 4 < 2 ? edited : strictified(edited)
    })
    compareNormalized(normalizedMutations, `normalize mutations from ${done}`, batch)
  }
}

export function reportPackage(): void {
  const drifted = driftedCopies()
  console.log(
    `(e) readers copied from parse.ts because it does not export them: 4; ` +
      `no longer the text parse.ts holds: ${drifted}`,
  )
  if (drifted > 0) failGate()
  writePathReport()
  console.log(
    `(e) distinct refusals of the TypeScript loader among the built containers: ${refusals.size} ` +
      `(${atFloor(refusals.size, 'refusalKinds')})`,
  )
  if (process.argv.includes('--refusals')) {
    for (const [kind, count] of refusals) console.log(`    ${String(count).padStart(4)}  ${kind}`)
  }
  console.log(
    `(e+) mutated containers the TypeScript loader refused: ${mutatedContainersRefused} of ${CONTAINER_FUZZ_CASES} ` +
      `(${atFloor(mutatedContainersRefused, 'mutatedContainersRefused')})`,
  )
}
