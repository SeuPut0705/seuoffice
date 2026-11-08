import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JSONContent } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { closeDocument, openDocumentFile } from '../src/formats/docx'
import { OdtEditGuard } from '../src/formats/odt'
import { run, tempDir } from './helpers'
import { lockedBlanksOdt, writeFormOdt, zipEntries } from './odt-fixtures'

const target = { blockIndexes: [1] }

describe('ODT protection after accepted structural operations', () => {
  for (const axis of ['row', 'col'] as const) {
    const insert =
      axis === 'row'
        ? { op: 'insertTableRow', target, row: 0, position: 'before' }
        : { op: 'insertTableColumn', target, col: 0, position: 'before' }
    for (const dryRun of [false, true]) {
      for (const mode of ['atomic', 'best-effort', 'stop-on-error']) {
        it(`${axis} insertion, ${mode}, ${dryRun ? 'dry run' : 'save'}: keeps the moved cell protected`, async () => {
          const dir = tempDir()
          const path = await writeFormOdt(dir)
          const before = readFileSync(path)
          const ops = join(dir, 'ops.json')
          writeFileSync(
            ops,
            JSON.stringify([
              insert,
              {
                op: 'setTableCellFormat',
                target,
                range: { row: axis === 'row' ? 1 : 0, col: axis === 'col' ? 1 : 0 },
                fill: '#FF0000',
              },
            ]),
          )
          const result = await run([
            'docs',
            'apply',
            path,
            '--ops',
            ops,
            ...(mode === 'atomic' ? [] : [`--${mode}`]),
            ...(dryRun ? ['--dry-run'] : []),
            '--json',
          ])
          expect(result.code, result.stdout).toBe(mode === 'atomic' ? 1 : 0)
          const reply = result.json()
          expect(reply.detail.failures[0]).toMatchObject({ index: 1, reason: 'op_rejected' })
          expect(reply.detail.batch).toEqual({
            total: 2,
            applied: mode === 'atomic' ? 0 : 1,
            failed: 1,
            skipped: mode === 'atomic' ? 1 : 0,
          })
          if (mode === 'atomic' || dryRun) expect(readFileSync(path)).toEqual(before)
          else {
            const xml = (await zipEntries(readFileSync(path))).get('content.xml')!.toString('utf8')
            expect(xml).not.toContain('#FF0000')
            expect(xml.match(/table:protected="true"/g)).toHaveLength(2)
          }
        })
      }
    }
    it(`${axis} insertion leaves the newly inserted cell editable`, async () => {
      const dir = tempDir()
      const path = await writeFormOdt(dir)
      const ops = join(dir, 'ops.json')
      writeFileSync(
        ops,
        JSON.stringify([
          insert,
          { op: 'setTableCellFormat', target, range: { row: 0, col: 0 }, fill: '#00FF00' },
        ]),
      )
      const result = await run(['docs', 'apply', path, '--ops', ops, '--json'])
      expect(result.code, result.stdout).toBe(0)
      const parts = await zipEntries(readFileSync(path))
      const xml = parts.get('content.xml')!.toString('utf8')
      expect(
        [...parts]
          .filter(([name]) => name.endsWith('.xml'))
          .map(([, part]) => part.toString('utf8'))
          .join('\n')
          .toLowerCase(),
      ).toContain('#00ff00')
      expect(xml.match(/table:protected="true"/g)).toHaveLength(2)
    })
  }

  for (const dryRun of [false, true]) {
    for (const mode of ['atomic', 'best-effort', 'stop-on-error']) {
      it(`both axes, ${mode}, ${dryRun ? 'dry run' : 'save'}: rejects a moved lock and continues only as requested`, async () => {
        const dir = tempDir()
        const path = await writeFormOdt(dir)
        const before = readFileSync(path)
        const ops = join(dir, 'ops.json')
        writeFileSync(
          ops,
          JSON.stringify([
            { op: 'insertTableRow', target, row: 0, position: 'before' },
            { op: 'insertTableColumn', target, col: 0, position: 'before' },
            { op: 'setTableCellFormat', target, range: { row: 2, col: 1 }, fill: '#FF0000' },
            { op: 'setTableCellFormat', target, range: { row: 0, col: 0 }, fill: '#00FF00' },
          ]),
        )
        const result = await run([
          'docs',
          'apply',
          path,
          '--ops',
          ops,
          ...(mode === 'atomic' ? [] : [`--${mode}`]),
          ...(dryRun ? ['--dry-run'] : []),
          '--json',
        ])
        expect(result.code, result.stdout).toBe(mode === 'atomic' ? 1 : 0)
        const reply = result.json()
        expect(reply.detail.failures[0]).toMatchObject({ index: 2, reason: 'op_rejected' })
        expect(reply.detail.batch).toEqual({
          total: 4,
          applied: mode === 'atomic' ? 0 : mode === 'best-effort' ? 3 : 2,
          failed: 1,
          skipped: mode === 'atomic' ? 3 : mode === 'best-effort' ? 0 : 1,
        })
        if (mode === 'atomic' || dryRun) expect(readFileSync(path)).toEqual(before)
        else {
          const after = await zipEntries(readFileSync(path))
          const original = await zipEntries(before)
          for (const [name, bytes] of original) {
            if (name !== 'content.xml' && name !== 'styles.xml')
              expect(after.get(name), name).toEqual(bytes)
          }
          const xml = [...after]
            .filter(([name]) => name.endsWith('.xml'))
            .map(([, bytes]) => bytes.toString('utf8'))
            .join('\n')
            .toLowerCase()
          expect(xml).not.toContain('#ff0000')
          expect(xml.includes('#00ff00'), `saved output: ${path}`).toBe(mode === 'best-effort')
          expect(
            after
              .get('content.xml')!
              .toString('utf8')
              .match(/table:protected="true"/g),
          ).toHaveLength(2)
        }
      })
    }
  }

  it('keeps coordinates after a rejected deletion, then follows a further accepted insertion', async () => {
    const dir = tempDir()
    const path = await writeFormOdt(dir)
    const ops = join(dir, 'ops.json')
    writeFileSync(
      ops,
      JSON.stringify([
        { op: 'insertTableColumn', target, col: 0, position: 'before' },
        { op: 'deleteTableColumn', target, col: 1 },
        { op: 'insertTableRow', target, row: 0, position: 'before' },
        { op: 'setTableCellFormat', target, range: { row: 1, col: 1 }, fill: '#FF0000' },
        { op: 'setTableCellFormat', target, range: { row: 0, col: 0 }, fill: '#00FF00' },
      ]),
    )
    const result = await run(['docs', 'apply', path, '--ops', ops, '--best-effort', '--json'])
    expect(result.code, result.stdout).toBe(0)
    expect(
      result.json().detail.failures.map((failure: { index: number }) => failure.index),
    ).toEqual([1, 3])
    expect(result.json().detail.batch).toEqual({ total: 5, applied: 3, failed: 2, skipped: 0 })
  })

  for (const editLocked of [false, true]) {
    it(`tracks a two-axis rebuild before editing a ${editLocked ? 'locked' : 'new'} cell`, async () => {
      const dir = tempDir()
      const path = await writeFormOdt(dir)
      const doc = await openDocumentFile(path)
      try {
        const guard = new OdtEditGuard(doc.odt!.bridge, doc.editor.state.doc)
        const before = guard.snapshot(doc.editor.state.doc)
        const json = doc.editor.getJSON() as JSONContent
        const table = json.content![1]!
        const empty = structuredClone(table.content![0]!.content![1]!)
        empty.content = [{ ...structuredClone(empty.content![0]!), content: [] }]
        for (const row of table.content!) row.content!.unshift(structuredClone(empty))
        const row = structuredClone(table.content![0]!)
        row.content = Array.from({ length: 4 }, () => structuredClone(empty))
        table.content!.unshift(row)
        const rebuilt = doc.editor.schema.nodeFromJSON(json)
        expect(guard.violation(before, rebuilt)).toBeNull()
        guard.accept(before, rebuilt)
        const accepted = guard.snapshot(rebuilt)
        const changed = rebuilt.toJSON()
        const cell =
          changed.content![1]!.content![editLocked ? 2 : 0]!.content![editLocked ? 1 : 0]!
        cell.attrs = { ...cell.attrs, fill: '#FF0000' }
        expect(guard.violation(accepted, doc.editor.schema.nodeFromJSON(changed)) !== null).toBe(
          editLocked,
        )
      } finally {
        closeDocument(doc)
      }
    })
  }

  it('distinguishes moved locked blanks from identical unlocked and newly inserted blanks', async () => {
    const dir = tempDir()
    const path = join(dir, 'blanks.odt')
    writeFileSync(path, await lockedBlanksOdt())
    const ops = join(dir, 'ops.json')
    writeFileSync(
      ops,
      JSON.stringify([
        { op: 'insertTableRow', target, row: 0, position: 'before' },
        { op: 'insertTableColumn', target, col: 0, position: 'before' },
        { op: 'setTableCellFormat', target, range: { row: 1, col: 1 }, fill: '#FF0000' },
        { op: 'setTableCellFormat', target, range: { row: 2, col: 1 }, fill: '#00FF00' },
        { op: 'setTableCellFormat', target, range: { row: 0, col: 0 }, fill: '#00FF00' },
      ]),
    )
    const result = await run(['docs', 'apply', path, '--ops', ops, '--best-effort', '--json'])
    expect(result.code, result.stdout).toBe(0)
    expect(result.json().detail.failures).toEqual([
      expect.objectContaining({ index: 2, reason: 'op_rejected' }),
    ])
    expect(result.json().detail.batch).toEqual({ total: 5, applied: 4, failed: 1, skipped: 0 })
  })
})
