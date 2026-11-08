import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'

const MODES = [
  { name: 'atomic', flags: [], applied: 0, skipped: 2 },
  { name: 'best effort', flags: ['--best-effort'], applied: 2, skipped: 0 },
  { name: 'stop on error', flags: ['--stop-on-error'], applied: 1, skipped: 1 },
] as const

async function fixture() {
  const dir = tempDir()
  const markdown = join(dir, 'source.md')
  const file = join(dir, 'source.docx')
  writeFileSync(markdown, '# Start\n\nBody.\n\nTail.\n')
  expect((await run(['create', '--type', 'docx', '--from', markdown, '--out', file])).code).toBe(0)
  return { dir, file, before: readFileSync(file) }
}

const INSERT = { op: 'insert_content', afterBlockIndex: 0, html: '<p>Inserted.</p>' }
const REPLACE = { op: 'findReplace', find: 'Body.', replace: 'Updated.' }

describe('malformed entries in mixed document batches', () => {
  for (const wrapped of [false, true]) {
    for (const dryRun of [false, true]) {
      for (const mode of MODES) {
        it(`${mode.name}, ${wrapped ? 'ops wrapper' : 'array'}, ${dryRun ? 'dry run' : 'save'}`, async () => {
          const { dir, file, before } = await fixture()
          const ops = join(dir, 'ops.json')
          const entries = [INSERT, null, REPLACE]
          writeFileSync(ops, JSON.stringify(wrapped ? { ops: entries } : entries))
          const result = await run([
            'docs',
            'apply',
            file,
            '--ops',
            ops,
            ...mode.flags,
            ...(dryRun ? ['--dry-run'] : []),
            '--json',
          ])
          const reply = result.json()
          expect(result.code).toBe(mode.name === 'atomic' ? 1 : 0)
          expect(reply.detail.batch).toEqual({
            total: 3,
            applied: mode.applied,
            failed: 1,
            skipped: mode.skipped,
          })
          expect(reply.detail.failures[0]).toMatchObject({ index: 1, reason: 'invalid_argument' })
          expect(reply.status).toBe(mode.name === 'atomic' ? 'error' : 'partial')
          const after = readFileSync(file)
          if (dryRun || mode.name === 'atomic') {
            expect(after.equals(before)).toBe(true)
            expect(reply.output_path).toBeUndefined()
          } else {
            const beforeZip = await JSZip.loadAsync(before)
            const afterZip = await JSZip.loadAsync(after)
            const xml = await afterZip.file('word/document.xml')!.async('string')
            expect(xml).toContain('Inserted.')
            expect(xml).toContain(mode.name === 'best effort' ? 'Updated.' : 'Body.')
            expect(xml).toContain('Tail.')
            expect(await afterZip.file('word/styles.xml')!.async('string')).toBe(
              await beforeZip.file('word/styles.xml')!.async('string'),
            )
            expect(reply.detail.results.map((r: { index: number }) => r.index)).toEqual(
              mode.name === 'best effort' ? [0, 2] : [0],
            )
          }
        })
      }
    }
  }

  it.each([
    { name: 'null', invalid: null },
    { name: 'number', invalid: 42 },
    { name: 'boolean', invalid: true },
    { name: 'string', invalid: 'findReplace' },
    { name: 'array', invalid: [] },
  ])('rejects non-object entry $name without writing', async ({ invalid }) => {
    const { dir, file, before } = await fixture()
    const ops = join(dir, 'ops.json')
    writeFileSync(ops, JSON.stringify([invalid]))
    const result = await run(['docs', 'apply', file, '--ops', ops, '--best-effort', '--json'])
    expect(result.code).toBe(1)
    expect(result.json().error).toBe('invalid_argument')
    expect(result.json().detail.failures[0]).toMatchObject({ index: 0, reason: 'invalid_argument' })
    expect(readFileSync(file).equals(before)).toBe(true)
  })

  for (const mode of MODES) {
    for (const shape of ['first', 'last', 'consecutive'] as const) {
      it(`${mode.name}: handles invalid entries ${shape}`, async () => {
        const { dir, file, before } = await fixture()
        const entries =
          shape === 'first'
            ? [null, INSERT, REPLACE]
            : shape === 'last'
              ? [INSERT, REPLACE, null]
              : [INSERT, null, null, REPLACE]
        const failedIndex = shape === 'first' ? 0 : shape === 'last' ? 2 : 1
        const applied = mode.name === 'atomic' ? 0 : mode.name === 'best effort' ? 2 : failedIndex
        const failed = mode.name === 'best effort' && shape === 'consecutive' ? 2 : 1
        const ops = join(dir, 'ops.json')
        writeFileSync(ops, JSON.stringify(entries))
        const result = await run(['docs', 'apply', file, '--ops', ops, ...mode.flags, '--json'])
        const reply = result.json()
        expect(result.code).toBe(applied ? 0 : 1)
        expect(reply.detail.batch).toEqual({
          total: entries.length,
          applied,
          failed,
          skipped: entries.length - applied - failed,
        })
        expect(reply.detail.failures[0]).toMatchObject({
          index: failedIndex,
          reason: 'invalid_argument',
        })
        if (!applied) expect(readFileSync(file).equals(before)).toBe(true)
        else {
          const zip = await JSZip.loadAsync(readFileSync(file))
          const xml = await zip.file('word/document.xml')!.async('string')
          expect(xml).toContain('Inserted.')
          expect(xml).toContain(applied === 2 ? 'Updated.' : 'Body.')
        }
      })
    }
  }
})
