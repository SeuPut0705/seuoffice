import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { odtToText } from '@genoffice/odt-engine'
import { describe, expect, it } from 'vitest'
import { closeDocument, openDocumentFile } from '../src/formats/docx'
import { OdtEditGuard, odtDisabledFeature } from '../src/formats/odt'
import { run, tempDir } from './helpers'
import { encryptedOdt, lockedBlanksOdt, writeFormOdt, zipEntries } from './odt-fixtures'

function opsFile(dir: string, ops: unknown[]): string {
  const path = join(dir, `ops-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(path, JSON.stringify(ops))
  return path
}

describe('docs read / apply on a received .odt', () => {
  it('reads the blocks of an .odt like a .docx', async () => {
    const dir = tempDir()
    const odt = await writeFormOdt(dir)
    const r = await run(['docs', 'read', odt, '--json'])
    expect(r.code).toBe(0)
    const detail = r.json().detail
    expect(detail.blocks).toBe(4)
    expect(detail.items[0]).toMatchObject({ index: 0, type: 'paragraph', text: 'Title' })
    expect(detail.items[1]).toMatchObject({ type: 'table', table: { rows: 2, cols: 3 } })
    expect(detail.items[3].text).toBe('The end')
  })

  it('applies ops in place and writes an .odt whose untouched entries keep their bytes', async () => {
    const dir = tempDir()
    const odt = await writeFormOdt(dir)
    const original = readFileSync(odt)
    const ops = opsFile(dir, [
      {
        op: 'findReplace',
        find: 'The end',
        replace: 'The very end',
        target: { blockIndexes: [3] },
      },
    ])
    const r = await run(['docs', 'apply', odt, '--ops', ops, '--json'])
    expect(r.code).toBe(0)
    expect(r.json()).toMatchObject({ status: 'ok', output_path: odt })
    const saved = readFileSync(odt)
    expect(saved.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004')
    expect(await odtToText(saved)).toContain('The very end')

    const before = await zipEntries(original)
    const after = await zipEntries(saved)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    const changed = [...before.keys()].filter((name) => !before.get(name)!.equals(after.get(name)!))
    expect(changed).toEqual(['content.xml'])
    const xml = after.get('content.xml')!.toString('utf8')
    expect(xml).toContain('table:protected="true"')
    expect(xml).toContain('Name')
  })

  it('writes --out as .odt and refuses another extension (that is convert)', async () => {
    const dir = tempDir()
    const odt = await writeFormOdt(dir)
    const ops = opsFile(dir, [
      { op: 'findReplace', find: 'Title', replace: 'Heading', target: { blockIndexes: [0] } },
    ])
    const wrong = await run([
      'docs',
      'apply',
      odt,
      '--ops',
      ops,
      '--out',
      join(dir, 'x.docx'),
      '--json',
    ])
    expect(wrong.code).toBe(1)
    expect(wrong.json()).toMatchObject({ error: 'invalid_argument' })
    expect(wrong.json().suggestion).toContain('convert')

    const out = join(dir, 'copy.odt')
    const ok = await run(['docs', 'apply', odt, '--ops', ops, '--out', out, '--json'])
    expect(ok.code).toBe(0)
    expect(await odtToText(readFileSync(out))).toContain('Heading')
    expect(await odtToText(readFileSync(odt))).toContain('Title')
  })

  it('refuses a .docx written as .odt through --out', async () => {
    const dir = tempDir()
    const md = join(dir, 'a.md')
    writeFileSync(md, '# Hi\n\ntext\n')
    const docx = join(dir, 'a.docx')
    expect((await run(['create', '--type', 'docx', '--from', md, '--out', docx])).code).toBe(0)
    const ops = opsFile(dir, [{ op: 'setFont', target: { blockIndexes: [0] }, bold: true }])
    const r = await run([
      'docs',
      'apply',
      docx,
      '--ops',
      ops,
      '--out',
      join(dir, 'a.odt'),
      '--json',
    ])
    expect(r.code).toBe(1)
    expect(r.json().error).toBe('invalid_argument')
  })

  it.each([
    [{ op: 'add_comment', blockIndex: 0, comment: 'note' }],
    [{ op: 'reply_comment', parentId: '0', text: 'x' }],
    [{ op: 'resolve_comment', id: '0' }],
    [{ op: 'delete_comment', id: '0' }],
    [{ op: 'accept_changes', all: true }],
    [{ op: 'reject_changes', all: true }],
    [{ op: 'insertToc', afterBlockIndex: -1 }],
    [{ op: 'insert_chart', kind: 'bar', categories: ['a'], series: [{ values: [1] }] }],
    [{ op: 'edit_chart', blockIndex: 0, title: 't' }],
    [{ op: 'insert_text_box', text: 't', width: '2cm', height: '1cm', x: 0, y: 0 }],
    [{ op: 'set_watermark', text: 'DRAFT' }],
    [{ op: 'set_page_setup', columns: { count: 2 } }],
    [{ op: 'insert_content', html: '<p>x <formula>E=mc^2</formula></p>' }],
    [{ op: 'insertField', target: { blockIndexes: [0] }, type: 'SEQ', args: 'Figure' }],
  ])('rejects %o as unsupported on an .odt', async (op) => {
    const dir = tempDir()
    const odt = await writeFormOdt(dir)
    const original = readFileSync(odt)
    const r = await run(['docs', 'apply', odt, '--ops', opsFile(dir, [op]), '--json'])
    expect(r.code).toBe(1)
    expect(r.json()).toMatchObject({ status: 'error', error: 'unsupported' })
    expect(r.json().detail.failures[0]).toMatchObject({ index: 0, reason: 'unsupported' })
    expect(r.json().suggestion).toContain('convert')
    expect(readFileSync(odt).equals(original)).toBe(true)
  })

  it('keeps ODT-safe ops of the same tools available', () => {
    expect(odtDisabledFeature({ op: 'set_page_setup', margins: { top: '2cm' } })).toBeNull()
    expect(odtDisabledFeature({ op: 'insert_content', html: '<p>plain</p>' })).toBeNull()
    expect(odtDisabledFeature({ op: 'insertField', type: 'DATE' })).toBeNull()
    expect(odtDisabledFeature({ op: 'insert_footnote', blockIndex: 0, text: 'n' })).toBeNull()
  })

  it('refuses --track on an .odt as unsupported', async () => {
    const dir = tempDir()
    const odt = await writeFormOdt(dir)
    const ops = opsFile(dir, [
      { op: 'findReplace', find: 'Title', replace: 'T', target: { blockIndexes: [0] } },
    ])
    const r = await run(['docs', 'apply', odt, '--ops', ops, '--track', '--json'])
    expect(r.code).toBe(1)
    expect(r.json()).toMatchObject({ error: 'unsupported' })
  })

  it('rejects ops that change a protected cell as op_rejected; other cells stay editable', async () => {
    const dir = tempDir()
    const odt = await writeFormOdt(dir)
    const original = readFileSync(odt)
    const locked = [
      {
        op: 'setTableCellFormat',
        target: { blockIndexes: [1] },
        range: { row: 0, col: 0 },
        fill: '#FF0000',
      },
      { op: 'deleteTableRow', target: { blockIndexes: [1] }, row: 1 },
      {
        op: 'replace_blocks',
        startBlockIndex: 1,
        endBlockIndex: 1,
        html: '<table><tr><th>Nom</th><th>alpha</th><th>beta</th></tr><tr><td>Age</td><td>gamma</td><td>delta</td></tr></table>',
      },
    ]
    for (const op of locked) {
      const r = await run(['docs', 'apply', odt, '--ops', opsFile(dir, [op]), '--json'])
      expect(r.code, JSON.stringify(op)).toBe(1)
      expect(r.json()).toMatchObject({ error: 'op_rejected' })
      expect(r.json().message).toContain('protected cell')
    }
    expect(readFileSync(odt).equals(original)).toBe(true)

    const free = [
      {
        op: 'setTableCellFormat',
        target: { blockIndexes: [1] },
        range: { row: 0, col: 1 },
        fill: '#FFFF00',
      },
      { op: 'insertTableRow', target: { blockIndexes: [1] }, row: 0, position: 'before' },
      {
        op: 'replace_blocks',
        startBlockIndex: 1,
        endBlockIndex: 1,
        html: '<table><tr><th></th><th></th><th></th></tr><tr><th>Name</th><th>ALPHA</th><th>beta</th></tr><tr><td>Age</td><td>gamma</td><td>delta</td></tr></table>',
      },
    ]
    const r = await run(['docs', 'apply', odt, '--ops', opsFile(dir, free), '--json'])
    expect(r.code, r.stdout).toBe(0)
    const xml = (await zipEntries(readFileSync(odt))).get('content.xml')!.toString('utf8')
    expect(xml).toContain('ALPHA')
    expect(xml.match(/table:protected="true"/g)).toHaveLength(2)
  })

  it('follows locked cells through row and cell edits elsewhere, even when other cells look the same', async () => {
    const dir = tempDir()
    const odt = join(dir, 'blanks.odt')
    writeFileSync(odt, await lockedBlanksOdt())
    const original = readFileSync(odt)
    const apply = (op: unknown) =>
      run([
        'docs',
        'apply',
        odt,
        '--ops',
        opsFile(dir, [op]),
        '--out',
        join(dir, 'out.odt'),
        '--force',
        '--json',
      ])
    const table = { blockIndexes: [1] }
    // the locked row itself, or a merge with a locked cell: refused
    for (const op of [
      { op: 'deleteTableRow', target: table, row: 0 },
      { op: 'mergeTableCells', target: table, range: { row: 0, col: 1, colEnd: 2 } },
    ]) {
      const r = await apply(op)
      expect(r.json(), JSON.stringify(op)).toMatchObject({ error: 'op_rejected' })
    }
    // rows and cells that are not locked: allowed although they print like the locked blanks
    for (const op of [
      { op: 'deleteTableRow', target: table, row: 2 },
      { op: 'deleteTableRow', target: table, row: 1 },
      { op: 'mergeTableCells', target: table, range: { row: 1, col: 0, colEnd: 1 } },
      { op: 'insertTableRow', target: table, row: 0, position: 'before' },
      { op: 'deleteTableColumn', target: table, col: 2 },
    ]) {
      const r = await apply(op)
      expect(r.code, `${JSON.stringify(op)} ${r.stdout}`).toBe(0)
      const xml = (await zipEntries(readFileSync(join(dir, 'out.odt')))).get('content.xml')!
      expect(xml.toString('utf8').match(/table:protected="true"/g)).toHaveLength(2)
    }
    // a column holding a locked cell: refused
    const r = await apply({ op: 'deleteTableColumn', target: table, col: 0 })
    expect(r.json()).toMatchObject({ error: 'op_rejected' })
    expect(readFileSync(odt).equals(original)).toBe(true)
  })

  it('a batch with rejected ops writes the rest and answers partial', async () => {
    const dir = tempDir()
    const odt = await writeFormOdt(dir)
    const ops = opsFile(dir, [
      { op: 'findReplace', find: 'Title', replace: 'Report', target: { blockIndexes: [0] } },
      { op: 'deleteTableRow', target: { blockIndexes: [1] }, row: 0 },
      { op: 'add_comment', blockIndex: 0, comment: 'hi' },
      { op: 'findReplace', find: 'The end', replace: 'Fin', target: { blockIndexes: [3] } },
    ])
    const r = await run(['docs', 'apply', odt, '--ops', ops, '--best-effort', '--json'])
    expect(r.code).toBe(0)
    const out = r.json()
    expect(out.status).toBe('partial')
    expect(out.detail.batch).toEqual({ total: 4, applied: 2, failed: 2, skipped: 0 })
    expect(
      out.detail.failures.map((f: { index: number; reason: string }) => [f.index, f.reason]),
    ).toEqual([
      [1, 'op_rejected'],
      [2, 'unsupported'],
    ])
    const text = await odtToText(readFileSync(odt))
    expect(text).toContain('Report')
    expect(text).toContain('Fin')
    expect(text).toContain('Name')
  })

  it('allows deleting a locked object stand-in but not changing it', async () => {
    const dir = tempDir()
    const odt = await writeFormOdt(dir)
    const doc = await openDocumentFile(odt)
    try {
      const guard = new OdtEditGuard(doc.odt!.bridge, doc.editor.state.doc)
      expect(guard.active).toBe(true)
      let at = -1
      doc.editor.state.doc.descendants((node, pos) => {
        if (typeof node.attrs.xml === 'string' && node.attrs.xml.includes('odt-keep:')) at = pos
        return at < 0
      })
      expect(at).toBeGreaterThan(0)
      const start = doc.editor.state
      const snap = guard.snapshot(start.doc)
      const node = start.doc.nodeAt(at)!
      doc.editor.view.dispatch(
        start.tr.setNodeMarkup(at, undefined, { ...node.attrs, widthPx: 999 }),
      )
      expect(guard.violation(snap, doc.editor.state.doc)).toMatch(/locked equation/)
      doc.editor.view.updateState(start)
      doc.editor.view.dispatch(start.tr.delete(at, at + node.nodeSize))
      expect(guard.violation(snap, doc.editor.state.doc)).toBeNull()
    } finally {
      closeDocument(doc)
    }
    const del = await run([
      'docs',
      'apply',
      odt,
      '--ops',
      opsFile(dir, [{ op: 'deleteBlocks', target: { blockIndexes: [2] } }]),
      '--json',
    ])
    expect(del.code).toBe(0)
    const entries = await zipEntries(readFileSync(odt))
    expect(entries.get('content.xml')!.toString('utf8')).not.toContain('draw:object')
  })

  it('refuses a password-protected .odt with exit 2, unsupported and a suggestion', async () => {
    const dir = tempDir()
    const odt = join(dir, 'secret.odt')
    writeFileSync(odt, await encryptedOdt())
    for (const argv of [
      ['docs', 'read', odt],
      ['info', odt],
      ['convert', odt, '--to', 'docx'],
    ]) {
      const r = await run([...argv, '--json'])
      expect(r.code, argv.join(' ')).toBe(2)
      expect(r.json()).toMatchObject({ status: 'error', error: 'unsupported' })
      expect(r.json().suggestion).toMatch(/password/)
    }
  })

  it('info describes an .odt', async () => {
    const dir = tempDir()
    const odt = await writeFormOdt(dir)
    const r = await run(['info', odt, '--json'])
    expect(r.code).toBe(0)
    expect(r.json().detail).toMatchObject({ format: 'odt', protected: true })
    expect(r.json().detail.headings).toEqual([])
    expect(r.json().detail.block_types.table).toBe(1)
  })
})
