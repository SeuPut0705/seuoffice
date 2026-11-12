import type { Block } from './types'
import { invoke } from './engine'

/**
 * Mail merge, engine half — the data source and the substitution walk.
 *
 * The MERGEFIELD itself already survives a round-trip (the parse whitelist
 * keeps it an instrField run), so what is missing is everything that gives the
 * field a value. This module reads a recipient list, substitutes the fields
 * with one record's data and honours Word's control fields (NEXT / SKIPIF / IF).
 * genoffice#1984.
 *
 * Deliberately no UI here: the panel, the recipient list, the preview and the
 * batch export are all built on top of these two functions, and none of them
 * can be tested without a DOM.
 */

/** one recipient row; keys are the column headers */
export type MergeRecord = Record<string, string>
export interface MergeData {
  /** column headers, in file order */
  readonly fields: readonly string[]
  readonly records: readonly MergeRecord[]
}
/**
 * Split a field instruction into its keyword and the rest: `MERGEFIELD "Postal
 * Address" \* MERGEFORMAT` -> `['MERGEFIELD', '"Postal Address" \\* MERGEFORMAT']`.
 */
export function splitInstruction(instr: string): [keyword: string, rest: string] {
  return invoke('splitInstruction', [instr]) as never
}
/**
 * The column name a MERGEFIELD asks for. Quoted so a header with a space
 * survives; a bare name stops at the first whitespace, which keeps the
 * `\* MERGEFORMAT`-style switches out of the name.
 */
export function mergeFieldName(instr: string): string | null {
  return invoke('mergeFieldName', [instr]) as never
}
/** "Ada" from `\* MERGEFORMAT` instructions is not the field name — this is the raw form */
export function placeholderText(name: string): string {
  return invoke('placeholderText', [name]) as never
}
/**
 * The field code a merge field carries in a template.
 *
 * The name is quoted so a header with a space survives, and the MERGEFORMAT
 * switch is the one Word writes: a template built here is then the same field
 * a template built in Word carries, and both read back through mergeFieldName.
 * genoffice#2097.
 */
export function mergeFieldInstruction(name: string): string {
  return invoke('mergeFieldInstruction', [name]) as never
}
/** the name a merged record is written under, derived from the record itself.
 *
 * `pattern` names a column of the data source; an empty pattern takes the
 * first one. A pattern that is no column is a literal, and `{Column}` inside
 * it is filled from the record. The result is reduced to what a file name can
 * carry, so a value like "A/B" cannot escape the folder it is written into.
 */
export function mergeOutputFileName(
  pattern: string,
  record: MergeRecord,
  fields: readonly string[],
): string {
  return invoke('mergeOutputFileName', [pattern, record, fields]) as never
}
export interface MergeFieldSwitches {
  /** `\b "…"`: text placed before the value, only when the value is non-empty */
  before: string
  /** `\f "…"`: text placed after the value, only when the value is non-empty */
  after: string
  /** `\* Upper | Lower | FirstCap | Caps` */
  caseFormat: string | null
}
/**
 * Word's Address Block and Greeting Line write `\f " "` on every name part, so
 * dropping the switches runs the parts together ("AdaLovelace").
 */
export function mergeFieldSwitches(instr: string): MergeFieldSwitches {
  return invoke('mergeFieldSwitches', [instr]) as never
}
/** the text a MERGEFIELD run shows for one record, switches applied */
export function mergeFieldText(instr: string, record: MergeRecord): string {
  return invoke('mergeFieldText', [instr, record]) as never
}
/** the value a record holds for `name`, or '' when the column is absent */
export function valueOf(record: MergeRecord, name: string): string {
  return invoke('valueOf', [record, name]) as never
}
/**
 * Evaluate an IF / SKIPIF comparison. Word writes `«Field» = "literal"` or
 * `«Field» = «Other»`; both sides are resolved against the record first, so a
 * MERGEFIELD wrapper around a name is invisible here.
 */
export function compareOperands(
  left: string,
  op: string,
  right: string,
  record: MergeRecord,
): boolean {
  return invoke('compareOperands', [left, op, right, record]) as never
}
/** true when an IF/SKIPIF condition holds for this record */
export function conditionHolds(instr: string, record: MergeRecord): boolean {
  return invoke('conditionHolds', [instr, record]) as never
}
/**
 * The branch an IF instruction selects, unwrapped from its quotes.
 *
 * Word writes `IF «Field» = "yes" "hidden" "shown"` — the condition comes
 * first, so the branches are whatever follows the comparison, not the first two
 * tokens. An IF with no comparison (`IF «Field» "yes" "no"`) uses the field as
 * the test and takes the two operands as the branches.
 */
export function ifBranch(instr: string, record: MergeRecord): string {
  return invoke('ifBranch', [instr, record]) as never
}
/** what a control field does to the run that carries it */
export type ControlEffect =
  | { readonly kind: 'next' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'skipNoop' }
  | { readonly kind: 'if'; readonly text: string }
export function controlEffect(instr: string, record: MergeRecord): ControlEffect | null {
  return invoke('controlEffect', [instr, record]) as never
}
/** the run-position cursor a single template pass walks with */
export interface MergeCursorState {
  /** index into data.records; NEXT moves it forward */
  index: number
  /** a NEXT fired during this pass */
  next: boolean
  /** a SKIPIF tested true during this pass */
  skipped: boolean
}
/**
 * Walk the template once, substituting fields from `data` as the cursor moves.
 *
 * The tree is walked structurally rather than through a serializer, so a field
 * inside a table cell is substituted exactly like one in the body. Floating
 * textboxes are display-only (the save keeps their original bytes), so a field
 * inside one stays as it was — for the same reason as the nested tables below.
 */
export function mergeRecords(
  blocks: readonly Block[],
  data: MergeData,
  startIndex = 0,
): { blocks: Block[]; cursor: MergeCursorState } {
  const [merged, cursor] = invoke('mergeRecords', [blocks, data, startIndex]) as [
    Block[],
    MergeCursorState,
  ]
  return { blocks: merged, cursor }
}
/**
 * Merge every record into its own copy of the block tree.
 *
 * A template with no NEXT yields one set per record — the letter-per-recipient
 * case. A NEXT hands the remainder of the template to the next record, which is
 * what a directory or a label sheet does. A SKIPIF removes the whole record.
 *
 * The first set is the template itself with its fields filled in. Every later
 * set is one more copy of the same paragraphs, so it goes without the content
 * controls whose ids belong to the first (runCopiedElsewhere).
 */
export function mergeBlockTree(blocks: readonly Block[], data: MergeData): Block[][] {
  return invoke('mergeBlockTree', [blocks, data]) as never
}
/**
 * Build a recipient list from already-parsed spreadsheet rows.
 *
 * Takes `string[][]` rather than CSV text on purpose: the CSV text→rows step
 * belongs to xlsx-gateway, which already owns `parseCsv` (RFC 4180 quotes, the
 * BOM, CRLF, the `sep=` declaration) and is what Sheets uses on open. The app
 * layer wires them together, so a list that opens correctly in Sheets opens
 * correctly here, and this package keeps no CSV parser of its own.
 *
 * The first row names the columns; the rest are records.
 */
export function mergeDataFromRows(rows: readonly (readonly string[])[]): MergeData {
  return invoke('mergeDataFromRows', [rows]) as never
}
