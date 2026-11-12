import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hiddenPptx, PLACEHOLDER, SECRET } from './hidden-text-fixtures'
import { run, tempDir } from './helpers'

describe('slides read: a run hidden from AI', () => {
  it('reads as its placeholder in the slide text and the speaker notes', async () => {
    const file = await hiddenPptx(tempDir())
    for (const flags of [[], ['--full'], ['--full', '--comments', '--layouts']]) {
      const read = await run(['slides', 'read', file, ...flags, '--json'])
      expect(read.code).toBe(0)
      expect(read.stdout).not.toContain(SECRET)
    }
    const read = await run(['slides', 'read', file, '--full', '--json'])
    const page = read.json().detail.pages[0]
    expect(page.elements[0].text).toBe(`Call ${PLACEHOLDER} now`)
    expect(page.notes).toBe(PLACEHOLDER)
  })

  it('an unmarked deck reads exactly as before', async () => {
    const dir = tempDir()
    const spec = join(dir, 'deck.json')
    writeFileSync(
      spec,
      JSON.stringify({
        pages: [
          {
            elements: [
              {
                type: 'text',
                x: 80,
                y: 80,
                w: 600,
                h: 80,
                paragraphs: [{ runs: [{ text: 'Call ' }, { text: 'everyone' }] }],
              },
            ],
          },
        ],
      }),
    )
    const file = join(dir, 'plain.pptx')
    expect(
      (await run(['create', '--type', 'pptx', '--spec', spec, '--out', file, '--json'])).code,
    ).toBe(0)
    const read = await run(['slides', 'read', file, '--full', '--json'])
    expect(read.json().detail.pages[0].elements[0].text).toBe('Call everyone')
    expect(read.json().detail.pages[0].notes).toBeUndefined()
  })
})
