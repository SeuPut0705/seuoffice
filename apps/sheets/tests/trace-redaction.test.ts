import { describe, expect, it } from 'vitest'
import { executeWorkbookTool, type SheetsSkillDeps } from '../src/renderer/ai/tools'
import type { ActiveSheetInfo } from '../src/renderer/ai/tools'
import { traceWorkbookDependents, traceWorkbookPrecedents } from '../src/renderer/ai/formula-audit'
import { buildRedactionIndex, type RedactionIndex } from '../src/renderer/ai/redact'
import type { WorkbookReadContext } from '../src/renderer/ai/workbook-readers'

/**
 * The trace tools print cell values, and a cell the reader withheld keeps its
 * real value on the sheet — that is the point of the feature, not a side
 * effect. So every value they print has to go through the redaction index, and
 * `trace_dependents` has the harder half: a `=B2` beside a withheld B2 shows
 * B2's value without the trace ever naming B2.
 */

const SECRET = '13800138000'

const info: ActiveSheetInfo = {
  mode: 'demo',
  sheetId: 'sheet-1',
  sheetName: 'Sheet1',
  revision: 0,
  knownAddresses: ['B2', 'C2'],
  sheets: [
    { id: 'sheet-1', name: 'Sheet1' },
    { id: 'sheet-2', name: 'Summary' },
  ],
  selection: 'B2:C2',
}

const deps = (overrides: Partial<SheetsSkillDeps> = {}): SheetsSkillDeps =>
  ({
    getActiveSheetInfo: () => info,
    readCells: () => ({}),
    readFormats: () => ({}),
    readSheetFeatures: () => '',
    findCells: () => ({ matches: [], truncated: false, incompleteSheets: [] }),
    ...overrides,
  }) as unknown as SheetsSkillDeps

/** B2 withheld — the phone number */
const indexWithB2 = buildRedactionIndex(
  [
    {
      sheetName: 'Sheet1',
      marks: [{ startRow: 1, endRow: 1, startColumn: 1, endColumn: 1, label: 'client phone' }],
    },
  ],
  info.sheets,
)

const call = (name: string, input: Record<string, unknown>) => ({ id: 't1', name, input }) as never

const run = (d: SheetsSkillDeps, name: string, input: Record<string, unknown>) => {
  const out = executeWorkbookTool(call(name, input), d)
  if (out instanceof Promise) throw new Error('expected a sync tool')
  return out
}

describe('trace_precedents with a withheld cell', () => {
  const tracing = deps({
    redactions: () => indexWithB2,
    tracePrecedents: () => ({
      formula: '=B2*2',
      value: 24690,
      refs: [
        {
          label: 'B2',
          sheetId: 'sheet-1',
          cellCount: 1,
          hasError: false,
          samples: [{ address: 'B2', value: SECRET }],
        },
      ],
      usesNames: false,
    }),
  })

  it('prints the marker where a withheld precedent would be', () => {
    const out = run(tracing, 'trace_precedents', { address: 'C2' })
    expect(out.output).not.toContain(SECRET)
    expect(out.output).toContain('{{client phone}}')
  })

  it('withholds the traced cell’s own value, which is its precedents’ value', () => {
    // `C2 = 24690` when `B2` is the withheld number says as much as printing
    // B2 would
    const out = run(tracing, 'trace_precedents', { address: 'C2' })
    expect(out.output).not.toContain('24690')
    expect(out.output).toContain('withheld from the model')
  })

  it('leaves an untraced cell alone when nothing on the way is withheld', () => {
    const plain = deps({
      tracePrecedents: () => ({
        formula: '=B2*2',
        value: 24690,
        refs: [
          {
            label: 'B2',
            sheetId: 'sheet-1',
            cellCount: 1,
            hasError: false,
            samples: [{ address: 'B2', value: 12345 }],
          },
        ],
        usesNames: false,
      }),
    })
    const out = run(plain, 'trace_precedents', { address: 'C2' })
    expect(out.output).toContain('24690')
    expect(out.output).toContain('12345')
  })

  it('says the value of a plain cell being traced is withheld, not its value', () => {
    const plainCell = deps({
      redactions: () => indexWithB2,
      tracePrecedents: () => ({ value: SECRET, refs: [], usesNames: false }),
    })
    const out = run(plainCell, 'trace_precedents', { address: 'B2' })
    expect(out.output).not.toContain(SECRET)
    expect(out.output).toContain('{{client phone}}')
  })
})

describe('trace_dependents with a withheld cell', () => {
  it('withholds a dependent whose value came from the traced cell', () => {
    const out = run(
      deps({
        redactions: () => indexWithB2,
        traceDependents: () => ({
          dependents: [
            {
              sheetName: 'Sheet1',
              address: 'C2',
              formula: '=B2',
              value: SECRET,
            },
          ],
          truncated: false,
          incompleteSheets: [],
        }),
      }),
      'trace_dependents',
      { address: 'B2' },
    )
    expect(out.output).not.toContain(SECRET)
    expect(out.output).toContain('withheld from the model')
  })

  it('prints a dependent that reads nothing withheld as usual', () => {
    const out = run(
      deps({
        traceDependents: () => ({
          dependents: [{ sheetName: 'Sheet1', address: 'C2', formula: '=A2', value: 42 }],
          truncated: false,
          incompleteSheets: [],
        }),
      }),
      'trace_dependents',
      { address: 'B2' },
    )
    expect(out.output).toContain('42')
  })
})

/**
 * The real tracers over a two-sheet workbook: Sheet1!B2 is the hidden phone
 * number, and Summary reads it from the other sheet.
 */
describe('tracing across sheets', () => {
  const snapshot = {
    revision: 0,
    sheets: [
      {
        id: 'sheet-1',
        name: 'Sheet1',
        cells: {
          A2: { value: 'Kim' },
          B2: { value: SECRET },
          C2: { value: `${SECRET}x`, formula: `=B2&"x"` },
        },
      },
      {
        id: 'sheet-2',
        name: 'Summary',
        cells: {
          A1: { value: SECRET, formula: '=Sheet1!B2' },
          A2: { value: `${SECRET}x`, formula: '=Sheet1!C2' },
          A3: { value: 'Kim', formula: '=Sheet1!A2' },
        },
      },
    ],
  }
  const ctx = {
    univerRef: { current: null },
    lazyWorkbookRef: { current: null },
    adapterRef: { current: { getSnapshot: () => snapshot } },
  } as unknown as WorkbookReadContext
  // B2 is marked; C2 on Sheet1 and A1, A2 on Summary compute from it
  const derived: Record<
    string,
    { startRow: number; endRow: number; startColumn: number; endColumn: number }[]
  > = {
    'sheet-1': [{ startRow: 1, endRow: 1, startColumn: 2, endColumn: 2 }],
    'sheet-2': [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 0 }],
  }
  const index: RedactionIndex = {
    ...indexWithB2,
    labelAt: (sheetId, row, column) =>
      indexWithB2.labelAt(sheetId, row, column) ??
      ((derived[sheetId] ?? []).some(
        (area) =>
          row >= area.startRow &&
          row <= area.endRow &&
          column >= area.startColumn &&
          column <= area.endColumn,
      )
        ? 'private'
        : null),
    marksFor: (sheetId) => indexWithB2.marksFor(sheetId),
    labelsFor: (sheetId) => indexWithB2.labelsFor(sheetId),
    derivedFor: (sheetId) => derived[sheetId] ?? [],
  }
  const real = (redactions: RedactionIndex | null = index) =>
    deps({
      ...(redactions ? { redactions: () => redactions } : {}),
      tracePrecedents: (sheetId, address) => traceWorkbookPrecedents(ctx, sheetId, address),
      traceDependents: (sheetId, address) => traceWorkbookDependents(ctx, sheetId, address),
    })
  const trace = async (d: SheetsSkillDeps, name: string, input: Record<string, unknown>) =>
    (await executeWorkbookTool(call(name, input), d)).output

  it('trace_precedents prints a hidden cell on another sheet as its placeholder', async () => {
    const output = await trace(real(), 'trace_precedents', { address: 'A1', sheetId: 'sheet-2' })
    expect(output).not.toContain(SECRET)
    // where the cell is stays visible; what it holds does not
    expect(output).toContain('- Sheet1!B2 (1 cell(s)): B2={{client phone}}')
    // the traced cell computes from it: placeholder, and no formula text
    expect(output).toContain('A1 = {{private}}')
    expect(output).not.toContain('=Sheet1!B2')
  })

  it('trace_precedents prints a precedent that computes from a hidden cell without value or formula', async () => {
    const output = await trace(real(), 'trace_precedents', { address: 'A2', sheetId: 'sheet-2' })
    expect(output).not.toContain(SECRET)
    expect(output).toContain('- Sheet1!C2 (1 cell(s)): C2={{private}}')
    expect(output).not.toContain('=B2&')
  })

  it('trace_precedents still shows a trace that meets nothing hidden', async () => {
    const output = await trace(real(), 'trace_precedents', { address: 'A3', sheetId: 'sheet-2' })
    expect(output).toContain('A3 = Kim (=Sheet1!A2)')
    expect(output).toContain('- Sheet1!A2 (1 cell(s)): A2=Kim')
  })

  it('trace_dependents prints dependents on every sheet without value or formula', async () => {
    const output = await trace(real(), 'trace_dependents', { address: 'B2', sheetId: 'sheet-1' })
    expect(output).not.toContain(SECRET)
    expect(output).toContain('- Sheet1!C2 = {{private}}')
    expect(output).toContain('- Summary!A1 = {{private}}')
    expect(output).not.toContain('=Sheet1!B2')
    expect(output).not.toContain('=B2&')
  })

  it('trace_dependents of an ordinary cell hides a dependent that is itself withheld', async () => {
    // Summary!A2 reads Sheet1!C2; tracing C2's dependents from a model that
    // may not see C2 either
    const output = await trace(real(), 'trace_dependents', { address: 'A2', sheetId: 'sheet-1' })
    expect(output).toContain('- Summary!A3 = Kim (=Sheet1!A2)')
  })

  it('prints everything in a workbook that hides nothing', async () => {
    const output = await trace(real(null), 'trace_precedents', {
      address: 'A1',
      sheetId: 'sheet-2',
    })
    expect(output).toContain(`A1 = ${SECRET} (=Sheet1!B2)`)
    expect(output).toContain(`B2=${SECRET}`)
  })

  it('withholds a reference whose sheet the tracer did not name, when the workbook hides cells', () => {
    const out = run(
      deps({
        redactions: () => index,
        tracePrecedents: () => ({
          formula: '=Other!B9',
          value: 7,
          refs: [
            {
              label: 'Other!B9',
              cellCount: 1,
              hasError: false,
              samples: [{ address: 'B9', value: SECRET }],
            },
          ],
        }),
      }),
      'trace_precedents',
      { address: 'D9' },
    )
    expect(out.output).not.toContain(SECRET)
    expect(out.output).toContain('B9={{private}}')
  })
})
