// Real model values for the specs whose arguments are docx model types: the
// Rust model is strict (a Block needs its `id`, `docxIndex` ... ), so a partial
// literal is refused where it would be accepted by the TypeScript. These are
// the blocks and tables of the docx fixtures of the odt tests, parsed once.
import { parseDocx, type Block, type TableModel } from '@seuoffice/docx-engine'
import { withClock } from './clock'
import { builtDocxSpecs } from './corpus'
import * as ts from './ts'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const parsed = await (async () => {
  const specs = await builtDocxSpecs()
  const out: Block[] = []
  for (const name of ['kitchen-sink', 'row-heights', 'headings-outline']) {
    const spec = specs.find(([n]) => n === name)![1]
    const doc = await parseDocx(await withClock(() => ts.helpersBuildDocx.buildDocx(spec)))
    out.push(...clone(doc.blocks))
  }
  return out
})()

/** Blocks of the fixtures, copies. */
export const REAL_BLOCKS: Block[] = parsed

/** The first block of a type (or the first block). */
export const firstOf = (type: string): Block =>
  clone(REAL_BLOCKS.find((b) => b.type === type) ?? REAL_BLOCKS[0]!)

/** A copy of a real block with some fields set. */
export const withFields = (block: Block, fields: Partial<Block>): Block =>
  ({ ...clone(block), ...fields }) as Block

/** The tables of the fixtures with the `w:tbl` they were read from. */
export const REAL_TABLES: Array<{ model: TableModel; xml: string }> = REAL_BLOCKS.filter(
  (b) => b.type === 'table' && b.table && b.originalXml,
).map((b) => ({ model: clone(b.table!), xml: b.originalXml as string }))
