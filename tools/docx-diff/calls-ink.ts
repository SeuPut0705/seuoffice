// Group `ink` of comparison (f): ink.ts, the freehand annotations saved as
// anchored pictures whose wp:docPr name starts with `aidocs-ink`.
import {
  anchoredInkRunXml,
  findInkRuns,
  INK_MEDIA_PATH_RE,
  INK_MEDIA_PREFIX,
  INK_NAME_PREFIX,
  INK_REL_RE,
  injectInkRunsIntoParagraph,
  stripInkRuns,
} from './reference/ink'
import type { NewInkImage } from './reference/types'
import type { CallSpec, Input } from './calls-spec'
import { elementFragments } from './fragments'

const CONSTANTS: Record<string, unknown> = { INK_NAME_PREFIX, INK_MEDIA_PREFIX }

const texts = (list: readonly string[]): Input[] => list.map((text) => ({ text }))

/** Every `name` element of the .xml parts of a document. */
const fragmentsOf = (parts: ReadonlyMap<string, string>, name: string): string[] =>
  [...parts]
    .filter(([path]) => path.endsWith('.xml'))
    .flatMap(([, text]) => elementFragments(text, name))

const ink = (
  widthPx: number | null,
  heightPx: number | null,
  offsetXPx: number | null,
  offsetYPx: number | null,
  payload?: string,
): Record<string, unknown> => ({
  blockIndex: 0,
  base64: '',
  widthPx,
  heightPx,
  offsetXPx,
  offsetYPx,
  ...(payload === undefined ? {} : { payload }),
})

/** Measurements: rounding ties both signs, -0, NaN, zero and sub-pixel, the max(1, ...) bound, exponent notation. */
const INKS: Array<Record<string, unknown>> = [
  ink(120, 40, 10, 20, '{"strokes":[]}'),
  ink(1.5, -1.5, -1.5, 1.5),
  ink(0, -0, -0, 0, ''),
  ink(null, null, null, null, 'a"b<c>&d\'e'),
  ink(0.00001, 1 / 9525, 0.5 / 9525, -0.5 / 9525, '\u00e9\u4e2d\u{1F58A}'),
  ink(-1, 2 / 9525, 1e20, -1e20, '\u0001x\u001f\ty\nz'),
  ink(3.000052493, 0.999, 2.5, -2.5, '&amp;lt;'),
]

const DOC_PR_IDS: unknown[] = [1, 0, 2.5, -251658240, null, 1e21]

const R_IDS = ['rId7', '', 'rId"&<']

const run = (inner: string): string =>
  `<w:r><w:drawing><wp:anchor>${inner}</wp:anchor></w:drawing></w:r>`

// the runs the TypeScript writes for the seeds it accepts (it refuses a
// measurement it cannot write)
const BUILT_RUNS: string[] = INKS.flatMap((value, i) => {
  try {
    return [anchoredInkRunXml(value as unknown as NewInkImage, R_IDS[i % R_IDS.length], i + 1)]
  } catch {
    return []
  }
})

/** Paragraph slices: generated runs, hand-made ink runs, foreign anchors and near misses. */
const PARAGRAPHS: string[] = [
  `<w:p><w:r><w:t>x</w:t></w:r>${BUILT_RUNS[0]}</w:p>`,
  `<w:p>${BUILT_RUNS.join('')}</w:p>`,
  ...BUILT_RUNS,
  run('<wp:extent cy="9525" cx="19050"/><wp:docPr id="1" name="aidocs-ink 1"/>'),
  run(
    '<wp:extent dcx="5" cx="9525" xcy="7" cy="28575"></wp:extent><wp:docPr id="1" name="aidocs-ink"/>',
  ),
  run(
    '<wp:positionH relativeFrom="column"><wp:posOffset>-0</wp:posOffset></wp:positionH>' +
      '<wp:positionV relativeFrom="paragraph"><wp:posOffset>-19050</wp:posOffset></wp:positionV>' +
      '<wp:docPr id="2" name="aidocs-ink 2" descr=""/><a:blip r:embed=""/>',
  ),
  run(
    '<wp:positionH><wp:posOffset>99999999999999999999999</wp:posOffset></wp:positionH>' +
      '<wp:positionV><wp:posOffset>12abc</wp:posOffset></wp:positionV>' +
      '<wp:docPr id="3" name="aidocs-ink 3" descr="&lt;s&gt; &quot;q&quot; &apos;a&apos; &amp;amp; \u{1F58A}"/>' +
      '<a:blip r:embed="rId9"/><a:blip r:embed="rId10"/>',
  ),
  run('<wp:docPr id="4" name="Picture 4"/>') + run('<wp:docPr name="aidocs-ink 5" descr="p"/>'),
  // an escaped entity: decoded once it reads &lt;, decoded twice it reads <
  run('<wp:docPr id="8" name="aidocs-ink 8" descr="&amp;lt;b&amp;gt; &amp;quot;"/>'),
  `<w:p>${run('<wp:docPr id="6" name="Picture aidocs-ink"/>')}</w:p>`,
  '<w:p><w:r><w:drawing><wp:anchor><wp:docPr name="aidocs-ink 7"/></wp:anchor></w:drawing></w:p>',
  '<w:p><w:r><w:t>aidocs-ink</w:t></w:r></w:p>',
  '<w:p><w:r><w:t>\u00e9\u{1F58A}</w:t></w:r></w:p>',
  '',
]

const RELS: string[] = [
  '<Relationships><Relationship Id="rId4" Type="image" Target="media/aidocsink1.png"/>' +
    '<Relationship Id="rId5" Target="media/aidocsink22.png" TargetMode="x" />' +
    '<Relationship Id="rId6" Target="media/aidocs3.png"/></Relationships>',
  '<Relationship Id="rId4" Target="media/aidocsink.png"/>',
  '<Relationship Id="rId4" Target="media/aidocsink1.PNG"/>',
  '<Relationship Id="rId4" Target="media/aidocsink1.png">',
  '<Relationship\tId="rId4" Target="media/aidocsink1.png"/>',
  '<Relationship Target="media/aidocsink\u0661.png"/><Relationship Target="media/aidocsink9.png"/>',
  '',
]

const MEDIA_PATHS = [
  'word/media/aidocsink1.png',
  'word/media/aidocsink123.png',
  'word/media/aidocsink.png',
  'word/media/aidocsink1.PNG',
  'xword/media/aidocsink1.png',
  'word/media/aidocsink1.png\n',
  'word/media/aidocsink1xpng',
  'word/media/aidocsink\u0661.png',
  'word/media/aidocs1.png',
  '',
]

const RUNS_XML = ['<w:r><w:t>i</w:t></w:r>', '', '$&\u{1F58A}']

const TARGETS = [
  '<w:p/>',
  '<w:p w:rsidR="1"/>',
  '<w:p\t/>',
  '<w:p><w:r><w:t>a</w:t></w:r></w:p>',
  '<w:p>a</w:p>b</w:p>',
  '<w:p></w:p><x/>',
  '<w:p>\u{1F58A}',
  '<w:pPr/>',
  ' <w:p/>',
  '<w:tbl></w:tbl>',
  '',
]

export const INK: CallSpec[] = [
  {
    fn: 'ink.constants',
    call: (_text, args) => {
      const name = String(args.name)
      if (!Object.hasOwn(CONSTANTS, name)) throw new Error(`no constant ${name}`)
      return CONSTANTS[name]
    },
    built: [...Object.keys(CONSTANTS), 'nothing'].map((name) => ({ args: { name } })),
    mutation: 'none',
  },
  {
    fn: 'ink.INK_REL_RE',
    call: (text) => text.match(INK_REL_RE),
    fromDocument: (parts) =>
      [...parts].filter(([path]) => path.endsWith('.rels')).map(([, text]) => ({ text })),
    built: texts(RELS),
  },
  {
    fn: 'ink.INK_MEDIA_PATH_RE',
    call: (text) => INK_MEDIA_PATH_RE.test(text),
    fromDocument: (parts) => texts([...parts.keys()]),
    built: texts(MEDIA_PATHS),
  },
  {
    fn: 'ink.anchoredInkRunXml',
    // null crosses the wire for a number that is not finite; the Rust reads it as NaN
    call: (_text, args) =>
      anchoredInkRunXml(
        args.ink as NewInkImage,
        String(args.rId),
        args.docPrId === null ? NaN : (args.docPrId as number),
      ),
    built: INKS.flatMap((value, i) =>
      DOC_PR_IDS.map((docPrId, j) => ({
        args: { ink: value, rId: R_IDS[(i + j) % R_IDS.length], docPrId },
      })),
    ),
    argMutation: true,
    mutation: 'none',
  },
  {
    fn: 'ink.stripInkRuns',
    call: (text) => stripInkRuns(text),
    fromDocument: (parts) => texts(fragmentsOf(parts, 'w:p')),
    built: texts(PARAGRAPHS),
  },
  {
    fn: 'ink.findInkRuns',
    call: (text) => findInkRuns(text),
    fromDocument: (parts) => texts(fragmentsOf(parts, 'w:p')),
    built: texts(PARAGRAPHS),
  },
  {
    fn: 'ink.injectInkRunsIntoParagraph',
    call: (text, args) => injectInkRunsIntoParagraph(text, String(args.runsXml)),
    fromDocument: (parts) =>
      fragmentsOf(parts, 'w:p').map((text) => ({ text, args: { runsXml: BUILT_RUNS[0] } })),
    built: TARGETS.flatMap((text) => RUNS_XML.map((runsXml) => ({ text, args: { runsXml } }))),
  },
]
