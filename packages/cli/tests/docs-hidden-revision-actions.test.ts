import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { revisionsDocx } from '../../docx-engine/tests/helpers/hidden-revisions'
import { SECRET, TAG_MUTATION_NAMES } from '../../docx-engine/tests/helpers/hidden-stories'
import { run, tempDir } from './helpers'

/**
 * `docs apply` with accept_changes / reject_changes acts for a caller that
 * cannot see the words a hidden change covers: it leaves pending what would
 * remove them (a hidden deletion accepted, a hidden insertion rejected, in the
 * body and in the parts the editor never loads), and a formatting change
 * rejected keeps the mark.
 */

const opsFile = (dir: string, ops: unknown[]) => {
  const path = join(dir, 'ops.json')
  writeFileSync(path, JSON.stringify(ops))
  return path
}

const partsOf = async (file: string) => {
  const zip = await JSZip.loadAsync(readFileSync(file))
  const parts: Record<string, string> = {}
  for (const path of Object.keys(zip.files)) {
    if (/^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(path))
      parts[path] = await zip.file(path)!.async('string')
  }
  return parts
}

const marked = (xml: string) => /<(?:[\w.-]+:)?redact[\s/>]/.test(xml)
const hiddenWordsIn = (xml: string) => xml.split(SECRET).length - 1

describe.each(['reject_changes', 'accept_changes'])('docs apply %s all', (op) => {
  it.each(['none', ...TAG_MUTATION_NAMES] as const)(
    'echoes no hidden word, loses no hidden word and no mark (tags: %s)',
    async (mutation) => {
      const dir = tempDir()
      const file = await revisionsDocx(dir, mutation)
      const before = await partsOf(file)
      const applied = await run([
        'docs',
        'apply',
        file,
        '--ops',
        opsFile(dir, [{ op, all: true }]),
        '--json',
      ])
      expect(applied.stdout).not.toContain(SECRET)
      expect(applied.stderr).not.toContain(SECRET)
      const after = await partsOf(file)
      for (const [part, xml] of Object.entries(after)) {
        // a hidden word is only ever removed by a hidden change nobody judged; the
        // marks that were there are there
        expect(marked(xml), part).toBe(marked(before[part]!))
      }
      // reject keeps the hidden insertions' words; accept keeps the hidden deletions'
      const left = Object.values(after).reduce((n, xml) => n + hiddenWordsIn(xml), 0)
      expect(left).toBeGreaterThan(0)
      // the change that would have taken them away is still pending, in the header as in the body
      if (mutation === 'none') {
        const pending = op === 'reject_changes' ? '<w:ins ' : '<w:del '
        for (const part of ['word/document.xml', 'word/header1.xml', 'word/footer1.xml']) {
          const hiddenPending =
            after[part]!.match(
              new RegExp(`${pending}[^>]*>(?:(?!</w:(?:ins|del)>)[\\s\\S])*${SECRET}`, 'g'),
            ) ?? []
          expect(hiddenPending.length, part).toBeGreaterThan(0)
        }
      }
    },
  )
})

describe('docs apply reject_changes: the formatting changes', () => {
  it('rejects them and keeps every hidden run hidden, in every part', async () => {
    const dir = tempDir()
    const file = await revisionsDocx(dir, 'none')
    const before = await partsOf(file)
    const applied = await run([
      'docs',
      'apply',
      file,
      '--ops',
      opsFile(dir, [{ op: 'reject_changes', type: 'formatting' }]),
      '--json',
    ])
    expect(applied.code).toBe(0)
    const after = await partsOf(file)
    for (const part of Object.keys(before)) {
      expect(marked(after[part]!), part).toBe(marked(before[part]!))
      expect(hiddenWordsIn(after[part]!), part).toBe(hiddenWordsIn(before[part]!))
    }
    // the formatting changes really are gone from the header
    expect(after['word/header1.xml']).not.toContain('<w:rPrChange')
  })
})
