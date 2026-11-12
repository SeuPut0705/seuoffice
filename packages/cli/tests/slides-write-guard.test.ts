import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  ALL_STORIES,
  ECHO_TAG,
  mutatedHiddenDeck,
  PLACEHOLDER,
  SECRET,
  type StoryTag,
  type TagMutation,
} from '../../pptx-engine/tests/helpers/hidden-deck'
import { run, tempDir } from './helpers'

/**
 * An agent reads text a person hid from AI as its `{{label}}`, never the words. What it asks
 * of `slides apply` must not tell it the words are there (a search that counts them) and
 * must not destroy them (a rewrite or a delete of what it was never shown).
 */

const WITH_ECHO: StoryTag[] = [...ALL_STORIES, ECHO_TAG]
const VARIANTS: TagMutation[] = [
  'none',
  'single quotes',
  'indented tags',
  'foreign extension beside the mark',
]

async function apply(file: string, ops: unknown[]) {
  const path = join(tempDir(), 'ops.json')
  writeFileSync(path, JSON.stringify(ops))
  return run(['slides', 'apply', file, '--ops', path, '--json'])
}

/** the message of a refused op, without the words of the search that was refused */
const reason = (stdout: string, find?: string): string => {
  const message = JSON.parse(stdout).message as string
  return find ? message.split(find).join('<find>') : message
}

describe.each(VARIANTS)('slides apply, tags rewritten: %s', (mutation) => {
  const deck = () => mutatedHiddenDeck(tempDir(), mutation, 'guard.pptx', WITH_ECHO)

  it('a search is blind to hidden words: the answer is the one for no match', async () => {
    const file = await deck()
    const before = readFileSync(file)
    const nothing = await apply(file, [{ op: 'findReplace', find: 'zzzz', replace: 'x' }])
    expect(nothing.code).not.toBe(0)
    const asked = [
      // inside a hidden run, across the edge of one, and the words of a hidden run that are the placeholder's own
      ['1380', 'x'],
      ['Call 1380', 'x'],
      ['38000B', 'x'],
      ['{{client', 'x'],
      [PLACEHOLDER, 'x'],
    ] as const
    for (const [find, replace] of asked) {
      const r = await apply(file, [{ op: 'findReplace', find, replace }])
      expect(r.code, find).toBe(nothing.code)
      expect(r.stdout).not.toContain(SECRET)
      expect(reason(r.stdout, find), find).toBe(reason(nothing.stdout, 'zzzz'))
    }
    expect(readFileSync(file).equals(before)).toBe(true)
  })

  it('a search still finds and replaces the words nobody hid', async () => {
    const file = await deck()
    const r = await apply(file, [{ op: 'findReplace', find: 'Edit me', replace: 'Edited' }])
    expect(r.code).toBe(0)
    const read = await run(['slides', 'read', file, '--full', '--json'])
    expect(read.stdout).toContain('Edited please')
    expect(read.stdout).not.toContain(SECRET)
  })

  const REFUSED: Array<[string, unknown]> = [
    [
      'rewrite the text box',
      {
        op: 'setText',
        target: { slide: 0, el: 'e_2' },
        paragraphs: [{ runs: [{ text: `Call ${PLACEHOLDER} now` }] }],
      },
    ],
    ['delete the text box', { op: 'deleteElement', target: { slide: 0, el: 'e_2' } }],
    ['delete the table', { op: 'deleteElement', target: { slide: 0, el: 'e_4' } }],
    ['delete the group', { op: 'deleteElement', target: { slide: 0, el: 'e_5' } }],
    ['ungroup the group', { op: 'ungroupElement', target: { slide: 0, el: 'e_5' } }],
    ['delete the field', { op: 'deleteElement', target: { slide: 0, el: 'e_7' } }],
    ['delete the echo', { op: 'deleteElement', target: { slide: 0, el: 'e_8' } }],
    ['delete the hidden picture', { op: 'deleteElement', target: { slide: 0, el: 'e_9' } }],
    [
      'rewrite the hidden cell',
      {
        op: 'setTableCell',
        target: { slide: 0, el: 'e_4' },
        row: 0,
        col: 1,
        paragraphs: [{ runs: [{ text: PLACEHOLDER }] }],
      },
    ],
    [
      'rewrite the shape in the group',
      {
        op: 'setText',
        target: { slide: 0, el: 'e_6' },
        group: 'e_5',
        paragraphs: [{ runs: [{ text: 'New words' }] }],
      },
    ],
    ['replace the speaker notes', { op: 'setNotes', target: { slide: 0 }, text: 'See you' }],
    ['delete the page', { op: 'deleteSlide', target: { slide: 0 } }],
  ]

  it.each(REFUSED)('%s: refused, and the deck is as it was', async (_what, op) => {
    const file = await deck()
    const before = readFileSync(file)
    const r = await apply(file, [op])
    expect(r.code).not.toBe(0)
    expect(r.stdout).not.toContain(SECRET)
    expect(r.stdout).toContain('withheld from AI')
    expect(readFileSync(file).equals(before)).toBe(true)
  })

  it('the shapes nobody hid are edited and deleted as ever', async () => {
    const file = await deck()
    const r = await apply(file, [
      { op: 'deleteElement', target: { slide: 0, el: 'e_3' } },
      { op: 'deleteElement', target: { slide: 0, el: 'e_10' } },
    ])
    expect(r.code).toBe(0)
    const read = await run(['slides', 'read', file, '--full', '--json'])
    expect(read.stdout).not.toContain('Edit me please')
    expect(read.stdout).not.toContain('Plain photo')
    expect(read.stdout).not.toContain(SECRET)
  })
})

/** the deck with its label one a merge key can be (`phone`, not `client phone`) */
async function keyedDeck(dir: string): Promise<string> {
  const file = await mutatedHiddenDeck(dir, 'none', 'template.pptx', WITH_ECHO)
  const zip = await JSZip.loadAsync(readFileSync(file))
  for (const path of Object.keys(zip.files).filter((p) => /^ppt\/.*\.xml$/.test(p))) {
    const xml = await zip.file(path)!.async('string')
    zip.file(path, xml.replaceAll('client phone', 'phone'))
  }
  writeFileSync(file, await zip.generateAsync({ type: 'uint8array' }))
  return file
}

describe('merge of a deck holding hidden text', () => {
  it('fills the placeholders of the words nobody hid and writes nothing inside a hidden run', async () => {
    const dir = tempDir()
    const file = await keyedDeck(dir)
    expect(
      (await apply(file, [{ op: 'findReplace', find: 'Edit me please', replace: 'Hi {{name}}' }]))
        .code,
    ).toBe(0)
    const out = join(dir, 'merged.pptx')
    const merged = await run([
      'merge',
      file,
      '--data',
      JSON.stringify({ name: 'Ann', phone: 'LEAKED' }),
      '--out',
      out,
      '--json',
    ])
    expect(merged.code).toBe(0)
    expect(merged.stdout).not.toContain(SECRET)

    const read = async (path: string) => {
      const zip = await JSZip.loadAsync(readFileSync(path))
      const parts = Object.keys(zip.files).filter((p) =>
        /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(p),
      )
      return (await Promise.all(parts.map((p) => zip.file(p)!.async('string')))).join('\n')
    }
    const all = await read(out)
    expect(all).toContain('Hi Ann')
    expect(all).not.toContain('LEAKED')
    // every hidden run keeps its words and its mark, the echo's included
    for (const tag of ['B', 'T', 'G', 'F', 'S', 'N']) expect(all).toContain(`${SECRET}${tag}`)
    expect(all).toContain('<a:t>{{phone}}</a:t>')
    expect(all.match(/<go:redact /g)).toHaveLength((await read(file)).match(/<go:redact /g)!.length)
  })
})

describe('slides replace of a page holding hidden text', () => {
  it('is refused, and the deck is as it was', async () => {
    const dir = tempDir()
    const file = await mutatedHiddenDeck(dir, 'none', 'replace.pptx')
    const before = readFileSync(file)
    const spec = join(dir, 'page.json')
    writeFileSync(
      spec,
      JSON.stringify({
        elements: [
          { type: 'text', x: 80, y: 80, w: 600, h: 80, paragraphs: [{ runs: [{ text: 'New' }] }] },
        ],
      }),
    )
    const r = await run(['slides', 'replace', file, '--slide', '0', '--spec', spec, '--json'])
    expect(r.code).not.toBe(0)
    expect(r.stdout).not.toContain(SECRET)
    expect(r.stdout).toContain('withheld from AI')
    expect(readFileSync(file).equals(before)).toBe(true)
  })
})
