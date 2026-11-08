import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'
describe('text metadata recognizes all conventional newline sequences', () => {
  it.each([
    { ext: 'txt', text: 'first\nsecond', lines: 2 },
    { ext: 'txt', text: 'first\rsecond', lines: 2 },
    { ext: 'txt', text: 'first\r\nsecond', lines: 2 },
    { ext: 'txt', text: 'one\rtwo\r\nthree\nfour', lines: 4 },
    { ext: 'md', text: '# First\rbody\r## Second', lines: 3, headings: 2 },
    { ext: 'markdown', text: '# First\r\nbody\r\n## Second', lines: 3, headings: 2 },
    { ext: 'html', text: 'one\rtwo', lines: 2 },
    { ext: 'htm', text: 'one\rtwo', lines: 2 },
    { ext: 'txt', text: '', lines: 1 },
    { ext: 'txt', text: 'one\r', lines: 2 },
    { ext: 'txt', text: '\r\r', lines: 3 },
    { ext: 'txt', text: '가😀\r나', lines: 2 },
  ])('reports $ext metadata for $text', async ({ ext, text, lines, headings }) => {
    const dir = tempDir()
    const file = join(dir, `input.${ext}`)
    writeFileSync(file, text)
    const before = readFileSync(file)
    const result = await run(['info', file, '--json'])
    expect(result.code).toBe(0)
    expect(result.json().detail.lines).toBe(lines)
    expect(result.json().detail.characters).toBe(text.length)
    if (headings !== undefined) expect(result.json().detail.headings).toBe(headings)
    expect(readFileSync(file)).toEqual(before)
  })
})
