import { inlineRunsXml } from './reference/generate'
import type { ParsedDoc, Run } from './reference/types'
import type { CallSpec, Input } from './calls-spec'

export function runModelInputs(doc: ParsedDoc): Input[] {
  const inputs: Input[] = []
  const take = (runs: Run[] | undefined): void => {
    if (runs && runs.length < 300) inputs.push({ args: { runs } })
  }
  for (const block of doc.blocks) {
    take(block.runs)
    take(block.strayRuns)
    for (const row of block.table?.rows ?? [])
      for (const cell of row) {
        for (const para of cell.richParas ?? []) take(para.runs)
      }
    for (const box of block.textboxes ?? []) for (const para of box.paras) take(para.runs)
  }
  for (const part of [
    doc.headerParas,
    doc.footerParas,
    ...Object.values(doc.hfParts ?? {}).map((part) => part.paras),
  ]) {
    for (const para of part ?? []) take(para.runs)
  }
  return inputs
}

const revisions = [
  { author: 'A', id: '7', date: '2026-01-01T00:00:00Z' },
  { author: 'B', move: 'm', dateUtc: '2026-01-01T00:00:00Z' },
]
const built: Run[][] = [
  [],
  [{ text: '' }],
  [{ text: 'text\tline\npage\fcolumn\vclear\u001e\u2011\u00ad<&"\u{1f600}' }],
  [
    { text: 'a', bold: true, color: 'ff0000' },
    { text: 'b', italic: true, underline: true },
  ],
  [{ text: 'x', link: { href: '#anchor', tooltip: '"tip' } }],
  [{ text: 'x', link: { href: 'https://example.test/a' } }],
  [
    { text: 'a', link: { href: 'https://example.test', rId: 'r1' } },
    { text: 'b', link: { href: 'https://example.test', rId: 'r2' } },
  ],
  [
    { text: 'a', commentIds: ['10', '2'] },
    { text: 'b', commentIds: ['2', '3'] },
  ],
  ...revisions.map((ins) => [
    { text: 'a', ins },
    { text: 'b', ins },
    { text: 'c', del: ins },
    { text: 'd', ins, del: ins },
    { text: 'end' },
  ]),
  [{ text: 'first', ins: revisions[0] }, { text: 'middle' }, { text: 'last', ins: revisions[0] }],
  ...(['ins', 'del'] as const).flatMap((side) => {
    const base = {
      author: 'A',
      id: '7',
      date: '2026-01-01T00:00:00Z',
      dateUtc: '2026-01-01T00:00:00Z',
    }
    return [
      [
        { text: 'plain', [side]: base },
        { text: 'moved', [side]: { ...base, move: 'm1' } },
        { text: 'end' },
      ],
      [
        { text: 'one', [side]: { ...base, move: 'm1' } },
        { text: 'two', [side]: { ...base, move: 'm2' } },
      ],
      [
        { text: 'moved', [side]: { ...base, move: 'm1' } },
        { text: 'plain', [side]: base },
      ],
    ] as Run[][]
  }),
  [{ text: '', math: { omml: '<m:oMath/>', display: true } }],
  [{ text: '', ruby: { rt: 'r', xml: '<w:ruby/>' } }],
  [{ text: '', sym: { font: 'Wingdings', char: 'F0FE' } }],
  [
    { text: '', noteRef: { kind: 'footnote', id: '3' } },
    { text: '', noteRef: { kind: 'endnote', id: '5' }, rawRPr: '' },
  ],
  [{ text: 'shown', refField: 'a"b', refInstr: ' REF "a" \\h ', fldDirty: true }],
  [{ text: 'A', xeTerm: 'a"b' }],
  [
    {
      text: '\u2610\u2612x',
      instrField: ' FORMCHECKBOX ',
      fldBeginXml:
        '<w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:checkBox/></w:ffData></w:fldChar></w:r>',
    },
  ],
  [{ text: '\u2610\u2612x', sdtCheckboxXml: '<w:sdtPr><w14:checkbox/></w:sdtPr>' }],
  [{ text: 'A', instrField: 'DATE', fldDirty: true }],
  ['begin', 'inside', 'end', 'single'].map((part) => ({
    text: part,
    instrField: 'ADDIN ZOTERO_ITEM CSL_CITATION',
    zoteroFieldId: 1,
    zoteroFieldPart: part as Run['zoteroFieldPart'],
  })),
  [{ text: 'image', image: { dataUrl: '', xml: '<w:drawing/>' } }],
]

export const GEN_RUNS: CallSpec[] = [
  {
    fn: 'genRuns.inlineRunsXml',
    argMutation: true,
    call: (_text, args) => inlineRunsXml(args.runs as Run[]),
    fromModel: runModelInputs,
    built: built.map((runs) => ({ args: { runs } })),
    mutation: 'none',
  },
]
