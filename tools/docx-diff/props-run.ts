// Comparison (d): the property readers, over the corpus, synthetic texts,
// broken elements, model values and seeded mutations.
import { fieldInstructions } from './reference/parse-props'
import { DEFAULT_THEME_COLORS } from './reference/theme'
import type { Run } from './reference/types'
import {
  brokenAtTheRoot,
  byFunction,
  compareModelDomains,
  compareModelValues,
  compareReaders,
  flush,
  type Group,
  inputsOf,
  inputsOfWhole,
  modelValuesOf,
  mutateProps,
  ODD_FONT_THEMES,
  ODD_VALUES,
  READER_ELEMENTS,
} from './compare-props'
import { mutate } from './compare-xml'
import { atFloor, Comparison, failGate, option } from './harness'
import { READERS, type Themes } from './props-registry'
import { numberTexts, PROPS_INSTRUCTIONS, PROPS_RUN_LISTS, PROPS_TEXTS } from './props-synthetic'

const PROPS_FUZZ_CASES = option('--props-fuzz', 4_000)
const NUMBER_TEXTS = option('--numbers', 20_000)

const readers: Record<Group, Comparison> = {
  pPr: new Comparison('(d) w:pPr readers, checks', 'propsPPrChecks'),
  rPr: new Comparison('(d) w:rPr readers, checks', 'propsRPrChecks'),
  paragraph: new Comparison('(d) paragraph and run readers, checks', 'propsParagraphChecks'),
  table: new Comparison('(d) table readers, checks', 'propsTableChecks'),
  values: new Comparison('(d) helpers on attribute values, checks', 'propsValueChecks'),
}
const synthetic = new Comparison('(d) readers on synthetic texts, checks', 'propsSyntheticChecks')
const broken = new Comparison('(d) readers on elements broken at the root', 'propsBrokenChecks')
const model = new Comparison('(d) model functions, checks', 'propsModelChecks')
const mutated = new Comparison('(d+) readers on mutated fragments, checks', 'propsMutatedChecks')

/** Fragments of each element the readers were called on, and what feeds the mutations. */
const fragmentCounts = new Map<string, number>()
const distinctFragments = new Map<string, Set<string>>()
const themesSeen: Themes[] = []
const runLists: Run[][] = []

/** Every reader group recorded under one comparison. */
const allGroups = (comparison: Comparison): Record<Group, Comparison> =>
  Object.fromEntries(Object.keys(readers).map((group) => [group, comparison])) as Record<
    Group,
    Comparison
  >
const noteFragments = (elements: Map<string, string[]>): void => {
  for (const [element, list] of elements) {
    const distinct = distinctFragments.get(element) ?? new Set()
    for (const fragment of list) distinct.add(fragment)
    distinctFragments.set(element, distinct)
  }
}
const oddThemes = (index: number): Themes => ({
  colors: index % 3 === 0 ? { dk1: ' 1f2e3d ', accent1: 'abcdef', lt1: '' } : DEFAULT_THEME_COLORS,
  fonts: ODD_FONT_THEMES[index % ODD_FONT_THEMES.length],
})

/** What a corpus document gives the model comparisons: its theme and the runs of its blocks. */
export function propsOnDocument(themes: Themes, runs: Run[][]): void {
  themesSeen.push(themes)
  runLists.push(...runs)
}

/** The readers over one XML part of a corpus document. */
export function propsOnPart(where: string, partXml: string, themes: Themes): void {
  const inputs = inputsOf(partXml)
  for (const [element, list] of inputs.elements) {
    fragmentCounts.set(element, (fragmentCounts.get(element) ?? 0) + list.length)
  }
  noteFragments(inputs.elements)
  const instructions = new Set((inputs.elements.get('w:p') ?? []).flatMap(fieldInstructions))
  compareReaders(readers, where, inputs, themes, partXml, instructions)
}

/** Everything that does not come from a corpus part: run once the corpus has been read. */
export function propsAfterCorpus(random: () => number): void {
  const syntheticTexts = Object.entries(PROPS_TEXTS).flatMap(([group, texts]) =>
    texts.map((text, index) => ({ where: `synthetic "${group}" ${index}`, text })),
  )
  syntheticTexts.forEach(({ where, text }, index) => {
    const inputs = inputsOf(text)
    noteFragments(inputs.elements)
    const instructions = new Set((inputs.elements.get('w:p') ?? []).flatMap(fieldInstructions))
    if (index === 0) {
      for (const instruction of PROPS_INSTRUCTIONS) instructions.add(instruction)
      for (const value of ODD_VALUES) inputs.attributeValues.add(value)
      for (const value of numberTexts(random, NUMBER_TEXTS)) inputs.attributeValues.add(value)
    }
    for (const themes of [{}, oddThemes(index)]) {
      compareReaders(allGroups(synthetic), where, inputs, themes, text, instructions)
    }
  })

  const seeds = [
    ...syntheticTexts.map(({ text }) => text),
    ...['w:pPr', 'w:rPr', 'w:tblPr', 'w:tcPr'].flatMap((name) => [
      ...(distinctFragments.get(name) ?? []),
    ]),
    ...[...(distinctFragments.get('w:p') ?? [])].filter((fragment) => fragment.length < 3000),
  ]

  // inputsOf yields balanced elements only, so the texts the parser refuses are passed as they are
  for (const name of [...READER_ELEMENTS, 'w:p']) {
    const fragments = [...(distinctFragments.get(name) ?? [])]
    const shape = fragments.find((fragment) => fragment.includes('<wps:wsp'))
    for (const fragment of [...fragments.slice(0, 3), ...(shape ? [shape] : [])]) {
      brokenAtTheRoot(fragment).forEach((text, index) => {
        compareReaders(
          allGroups(broken),
          `${name} broken at the root, way ${index}`,
          inputsOfWhole(text),
          oddThemes(index),
          text,
          [],
        )
      })
    }
  }

  for (let index = 0; index < PROPS_FUZZ_CASES; index++) {
    // half of the mutations start from a synthetic text: the tracked documents hold few constructs
    const seed =
      index % 2 === 0
        ? syntheticTexts[Math.floor(random() * syntheticTexts.length)]!.text
        : seeds[Math.floor(random() * seeds.length)]!
    // one in ten is broken as XML too, and goes to the readers whole as well
    const edited = mutateProps(seed, random)
    const brokenAsXml = index % 10 === 9
    const fragment = brokenAsXml ? mutate(edited, random) : edited
    const inputs = inputsOf(fragment)
    noteFragments(inputs.elements)
    const instructions = new Set((inputs.elements.get('w:p') ?? []).flatMap(fieldInstructions))
    compareReaders(
      allGroups(mutated),
      `mutation ${index}`,
      inputs,
      oddThemes(index),
      fragment,
      instructions,
    )
    if (brokenAsXml) {
      compareReaders(
        allGroups(mutated),
        `mutation ${index}, whole`,
        inputsOfWhole(fragment),
        oddThemes(index),
        fragment,
        [],
      )
    }
  }

  const modelValues = modelValuesOf(
    distinctFragments.get('w:pPr') ?? [],
    distinctFragments.get('w:ind') ?? [],
  )
  compareModelDomains(model, themesSeen)
  compareModelValues(model, { ...modelValues, runs: [...PROPS_RUN_LISTS, ...runLists] }, random)
  flush()
}

/** The populations and the coverage of (d), after the comparison lines. */
export function reportProps(): void {
  for (const [element, key] of [
    ['w:pPr', 'pPrFragments'],
    ['w:rPr', 'rPrFragments'],
  ] as const) {
    const count = fragmentCounts.get(element) ?? 0
    console.log(
      `(d) ${element} fragments the readers were called on: ${count} (${atFloor(count, key)})`,
    )
  }
  console.log(
    `(d+) mutated fragments: ${PROPS_FUZZ_CASES} (${atFloor(PROPS_FUZZ_CASES, 'propsMutatedFragments')})`,
  )
  // a name with a dot is a function of comparison (f)
  const readers = [...byFunction].filter(([fn]) => !fn.includes('.'))
  const oneResult = readers.filter(([, tally]) => tally.outcomes.size < 2).map(([fn]) => fn)
  console.log(
    `(d) functions compared: ${readers.length} (${atFloor(readers.length, 'propsFunctions')}); ` +
      `with a single distinct result, so not really compared: ` +
      `${oneResult.length}${oneResult.length > 0 ? ` (${oneResult.join(', ')})` : ''}`,
  )
  if (oneResult.length > 0) failGate()
  const overAnElement = new Set(
    READERS.filter((reader) => reader.on.some((on) => typeof on === 'object')).map(({ fn }) => fn),
  )
  const neverRefused = [...overAnElement].filter((fn) => (byFunction.get(fn)?.threw ?? 0) === 0)
  console.log(
    `(d) readers over a parsed element: ${overAnElement.size}; never called on a text the TypeScript ` +
      `parser refuses: ${neverRefused.length}${neverRefused.length > 0 ? ` (${neverRefused.join(', ')})` : ''}`,
  )
  if (neverRefused.length > 0) failGate()
  if (process.argv.includes('--by-function')) {
    for (const [fn, { checks, differences, threw, outcomes }] of readers.sort(
      (a, b) => b[1].differences - a[1].differences || a[0].localeCompare(b[0]),
    )) {
      console.log(
        `    ${fn.padEnd(26)} checks ${String(checks).padStart(8)}  differences ${String(differences).padStart(7)}  ` +
          `equal ${(100 * (1 - differences / checks)).toFixed(3)}%  distinct results ${outcomes.size}  ` +
          `TypeScript threw ${threw}`,
      )
    }
  }
}
