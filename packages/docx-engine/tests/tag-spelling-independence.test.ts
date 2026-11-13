import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDocx, saveDocx, type SaveBlock } from '../src'
import { revisionsDocx } from './helpers/hidden-revisions'
import { FIXTURES, SPELLINGS, docxFiles, modelOf, respelled } from './helpers/tag-spellings'

/**
 * XML has many spellings of the same document: quotes, white space around `=`,
 * a `>` inside a value, white space before the `>` of an end tag, comments.
 * The engine finds most of what it reads and writes by pattern, so a document
 * written another way must read, and save, as the same document. Every probe
 * document of the repository is rewritten each way and read again.
 */

const files = docxFiles(FIXTURES)

describe.each(Object.keys(SPELLINGS))('a document spelled with %s', (spelling) => {
  it('reads as the same document, in every probe document', async () => {
    const differing: string[] = []
    for (const file of files) {
      const bytes = new Uint8Array(readFileSync(file))
      const base = JSON.stringify(modelOf(await parseDocx(bytes)))
      const other = JSON.stringify(modelOf(await parseDocx(await respelled(bytes, spelling))))
      if (other !== base) differing.push(file.replace(`${FIXTURES}/`, ''))
    }
    expect(differing).toEqual([])
  }, 120_000)

  it('saves as the same document, a paragraph added', async () => {
    const differing: string[] = []
    for (const file of files.filter((_, i) => i % 6 === 0)) {
      const bytes = new Uint8Array(readFileSync(file))
      const saveAdded = async (input: Uint8Array) => {
        const parsed = await parseDocx(input)
        const kept = parsed.blocks.filter((b) => !b.hidden)
        const saved = await saveDocx(parsed, [
          ...kept.map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex! })),
          {
            kind: 'generated' as const,
            block: { type: 'paragraph' as const, runs: [{ text: 'added' }] },
          },
        ])
        return JSON.stringify(modelOf(await parseDocx(saved)))
      }
      if ((await saveAdded(await respelled(bytes, spelling))) !== (await saveAdded(bytes))) {
        differing.push(file.replace(`${FIXTURES}/`, ''))
      }
    }
    expect(differing).toEqual([])
  }, 120_000)
})

describe.each(Object.keys(SPELLINGS))(
  'a document spelled with %s, rebuilt from its model',
  (spelling) => {
    it('saves as the same document, every paragraph written again', async () => {
      const differing: string[] = []
      for (const file of files.filter((_, i) => i % 3 === 0)) {
        const bytes = new Uint8Array(readFileSync(file))
        const saveRebuilt = async (input: Uint8Array) => {
          const parsed = await parseDocx(input)
          const saved = await saveDocx(
            parsed,
            parsed.blocks
              .filter((b) => !b.hidden)
              .map((b) =>
                b.type === 'paragraph'
                  ? {
                      kind: 'generated' as const,
                      docxIndex: b.docxIndex!,
                      block: b as Extract<SaveBlock, { kind: 'generated' }>['block'],
                    }
                  : { kind: 'original' as const, docxIndex: b.docxIndex! },
              ),
          )
          return JSON.stringify(modelOf(await parseDocx(saved)))
        }
        if ((await saveRebuilt(await respelled(bytes, spelling))) !== (await saveRebuilt(bytes))) {
          differing.push(file.replace(`${FIXTURES}/`, ''))
        }
      }
      expect(differing).toEqual([])
    }, 120_000)
  },
)

describe.each(Object.keys(SPELLINGS))(
  'a document with its stories (header, footer, notes, text box, comment) spelled with %s',
  (spelling) => {
    it('reads as the same document', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'spelling-'))
      const bytes = new Uint8Array(readFileSync(await revisionsDocx(dir, 'none')))
      expect(modelOf(await parseDocx(await respelled(bytes, spelling)))).toEqual(
        modelOf(await parseDocx(bytes)),
      )
    })
  },
)
