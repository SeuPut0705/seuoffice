import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { flagString, parseArgs } from '../src/args'
import { resolveOutput, writeOutput } from '../src/fs'
import { EXIT } from '../src/result'

describe('resolveOutput', () => {
  it('refuses an empty --out rather than falling back onto the input file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genoffice-out-'))
    const input = join(dir, 'deck.pptx')
    writeFileSync(input, 'source')
    const ctx = { cwd: dir, env: { ...process.env, GENOFFICE_ALLOWED_ROOTS: '' } }
    // `--out=` is an empty value, not an absent flag
    const args = parseArgs(['slides', 'apply', 'deck.pptx', '--ops', 'ops.json', '--out='])
    const out = flagString(args, 'out')
    expect(out).toBe('')
    // the fallback is the input file, so accepting '' would overwrite the source
    let err: unknown
    try {
      resolveOutput(out, ctx, { fallback: input })
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ code: EXIT.usage, reason: 'missing_argument' })
    expect((err as Error).message).toMatch(/missing --out <path>/)
    // an absent --out still edits in place, and a real one still redirects
    expect(resolveOutput(undefined, ctx, { fallback: input })).toBe(input)
    expect(resolveOutput('out.pptx', ctx, { fallback: input })).toBe(join(dir, 'out.pptx'))
  })
})

describe('writeOutput', () => {
  it('replaces a file whose name is near the 255-byte file-name limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genoffice-out-'))
    // 78 Hangul letters + ".docx" is 239 bytes; the temp name must not grow past 255
    const file = join(dir, `${'가'.repeat(78)}.docx`)
    writeFileSync(file, 'old')
    writeOutput(file, 'new')
    expect(readFileSync(file, 'utf-8')).toBe('new')
    // the temp file is renamed away, nothing is left beside the file
    expect(readdirSync(dir)).toEqual([`${'가'.repeat(78)}.docx`])
  })
})
