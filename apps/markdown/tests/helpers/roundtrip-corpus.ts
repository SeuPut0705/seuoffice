import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { useRoundTripEditor } from './roundtrip-editor'

// Exercise the actual loading path and validate the resulting editor schema.
const root = resolve(import.meta.dirname, '../../../..')
const corpus = execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)

/**
 * One slice of the tracked Markdown corpus. The corpus is split over several
 * test files so vitest runs the slices on separate workers instead of one
 * file working through every Markdown file in the repository.
 */
export function describeCorpusShard(shard: number, shards: number): void {
  const open = useRoundTripEditor()
  describe(`tracked repository Markdown corpus (${shard}/${shards})`, () => {
    if (shard === 1) {
      it('includes README variants and a nonempty corpus', () => {
        expect(corpus.length).toBeGreaterThan(50)
        expect(corpus.some((path) => /README.*\.md$/.test(path))).toBe(true)
      })
    }
    const slice = corpus.filter((_, index) => index % shards === shard - 1)
    it.each(slice)('opens and preserves every byte of %s', (path) => {
      const raw = readFileSync(resolve(root, path))
      const { editor, save, body } = open(raw.toString('utf8'))
      expect(() => editor.state.doc.check()).not.toThrow()
      expect(Buffer.from(save(), 'utf8')).toEqual(raw)
      expect(body).not.toHaveBeenCalled()
    })
  })
}
