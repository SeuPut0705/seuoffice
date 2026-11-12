/**
 * The web build asks which cells are hidden from the AI on every open, a
 * view-only page included. That read has to work in a page that never loads
 * the save planner: the planner and the OOXML code behind it are the largest
 * chunk of the web build, and a viewer has no use for them.
 *
 * The planner's modules are made unloadable here, so the read below fails the
 * moment anything on its path imports one of them.
 */
import { describe, expect, it, vi } from 'vitest'
import { File } from '@seuoffice/web-platform/wasi'
import {
  applyRedactionNameMirror,
  serializeRedactionPart,
  type SheetRedactionState,
} from '@seuoffice/xlsx-gateway/gateway/xlsx-redaction'
import { readRedactions } from '../src/web/xlsx-entries'

const planner = vi.hoisted(() => (name: string) => () => {
  throw new Error(`the save planner was loaded on the read path (${name})`)
})
vi.mock('../src/web/xlsx-save', planner('web/xlsx-save'))
vi.mock('@seuoffice/xlsx-gateway/gateway/xlsx-gateway', planner('gateway/xlsx-gateway'))
vi.mock('@seuoffice/xlsx-gateway/gateway/xlsx-package-io', planner('gateway/xlsx-package-io'))

const MARKS: SheetRedactionState[] = [
  {
    sheetName: 'Data',
    marks: [{ startRow: 1, endRow: 1, startColumn: 1, endColumn: 1, label: 'client phone' }],
  },
]
const WORKBOOK_XML =
  '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'

/** the worker's engine over an in-memory package: the two commands a read uses */
function engineOver(parts: Record<string, string>) {
  const scratch = new Map<string, File>()
  const commands: string[] = []
  let extracted = 0
  return {
    commands,
    engine: {
      work: new Map<string, File>(),
      scratch,
      async command(name: string, fields: Record<string, unknown>): Promise<unknown> {
        commands.push(name)
        if (name === 'archive_manifest') {
          return { entries: Object.keys(parts).map((entry) => ({ name: entry })) }
        }
        if (name !== 'read_entries') throw new Error(`unexpected engine command ${name}`)
        const entries = (fields.entries as string[]).map((entry) => {
          const file = `read-${extracted++}`
          scratch.set(file, new File(new TextEncoder().encode(parts[entry] ?? '')))
          return { name: entry, path: `/save/${file}` }
        })
        return { entries }
      },
    },
  }
}

describe('reading the hidden cells in the web build', () => {
  it('reads the marks of a package without the save planner', async () => {
    const { engine, commands } = engineOver({
      'xl/workbook.xml': WORKBOOK_XML,
      'xl/gxRedactions.json': serializeRedactionPart(MARKS),
    })
    expect(await readRedactions(engine, 'book.xlsx')).toEqual({
      status: 'ok',
      states: MARKS,
      source: 'part',
    })
    expect(commands).toEqual(['archive_manifest', 'read_entries'])
    // what the engine extracted for the read is not left behind in /save
    expect(engine.scratch.size).toBe(0)
  })

  it('answers "nothing hidden" for a package with no marks, and "unreadable" for a damaged record', async () => {
    expect(
      await readRedactions(engineOver({ 'xl/workbook.xml': WORKBOOK_XML }).engine, 'book.xlsx'),
    ).toEqual({ status: 'absent' })
    const damaged = engineOver({
      'xl/workbook.xml': WORKBOOK_XML,
      'xl/gxRedactions.json': '{"version":1,',
    })
    expect((await readRedactions(damaged.engine, 'book.xlsx')).status).toBe('unreadable')
  })

  it('falls back to the copy in the defined names when the part is gone', async () => {
    const { engine } = engineOver({
      'xl/workbook.xml': applyRedactionNameMirror(WORKBOOK_XML, MARKS, ['Data']),
    })
    expect(await readRedactions(engine, 'book.xlsx')).toEqual({
      status: 'ok',
      states: MARKS,
      source: 'mirror',
    })
  })
})
