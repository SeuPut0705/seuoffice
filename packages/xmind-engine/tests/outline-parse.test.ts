import { afterEach, describe, expect, it } from 'vitest'
import { setDefaultSheetTheme } from '../src/create'
import { openXmind } from '../src/open'
import { sheetsToOutline, sheetToOutline } from '../src/outline'
import { createXmindDocumentFromOutline, outlineToSheets } from '../src/outline-parse'
import { checkContentStructure, MAX_TOPIC_DEPTH } from '../src/structure-check'
import type { XmindSheet, XmindTopic } from '../src/types'
import { sheetToView, type ViewTopic } from '../src/view'
import { tripSheets } from './outline-fixtures'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const UNTITLED = 'Untitled'

afterEach(() => setDefaultSheetTheme(null))

/** What the specification says comes back: title, labels, link, note, and the branches in order. */
interface Shape {
  title: string
  labels?: string[]
  link?: string
  note?: string
  children?: Shape[]
}

function shapeOf(topic: ViewTopic): Shape {
  const shape: Shape = { title: topic.title }
  if (topic.labels.length > 0) shape.labels = topic.labels
  if (topic.link !== null) shape.link = topic.link
  if (topic.note !== null) shape.note = topic.note
  if (topic.children.length > 0) shape.children = topic.children.map(shapeOf)
  return shape
}

function shapesOf(sheets: readonly XmindSheet[]): { sheet: string; root: Shape }[] {
  return sheets.map((sheet, index) => {
    const view = sheetToView(sheet, index)
    return { sheet: view.title, root: shapeOf(view.root) }
  })
}

const read = (text: string): { sheet: string; root: Shape }[] =>
  shapesOf(outlineToSheets(text, { untitled: UNTITLED }))

const lines = (...all: string[]): string => all.join('\n')

/** A sheet `S` whose central topic `R` has these branches. */
function branches(topics: Record<string, unknown>[]): XmindSheet {
  return {
    title: 'S',
    rootTopic: {
      id: 'r',
      title: 'R',
      children: { attached: topics.map((topic, index) => ({ id: `t${index}`, ...topic })) },
    },
  }
}

/** The branches as they come back after being written as an outline and read again. */
function roundTrip(topics: Record<string, unknown>[]): Shape[] {
  const back = read(sheetToOutline(branches(topics)))
  expect(back).toHaveLength(1)
  expect(back[0]).toMatchObject({ sheet: 'S', root: { title: 'R' } })
  return back[0]!.root.children ?? []
}

describe('an outline read back', () => {
  it('gives the same sheets, titles, order, labels, links and notes', () => {
    expect(read(sheetsToOutline(tripSheets()))).toEqual([
      {
        sheet: 'Trip',
        root: {
          title: 'Summer trip',
          children: [
            {
              title: 'Places',
              labels: ['must see', 'coast'],
              link: 'https://example.com/places?x=1&y=2',
              note: 'Book early.\n\nAsk <b>Mina</b> & co.',
              children: [
                { title: 'Old town walls' },
                { title: 'Harbour', children: [{ title: 'Ferry times' }] },
                // What was written with a kind mark is an ordinary topic now.
                { title: 'Museum', children: [{ title: 'costs -> Budget' }] },
                { title: 'Two days', children: [{ title: 'Split evenly' }] },
                { title: 'Closed on Mondays' },
                { title: 'Indoors' },
              ],
            },
            { title: 'Budget' },
            { title: 'Packing', note: 'Light\nRain coat' },
            { title: 'Ideas', labels: ['later'], children: [{ title: 'Kayak' }] },
          ],
        },
      },
      { sheet: '둘째 시트', root: { title: '중심' } },
    ])
  })

  it('writes the same outline again for a map of ordinary branches', () => {
    const sheets: XmindSheet[] = [
      {
        title: 'One [draft] #',
        rootTopic: {
          id: 'r',
          title: '- Centre',
          labels: ['root, label'],
          notes: { plain: { content: '> quoted\n\n- listed' } },
          children: {
            attached: [
              {
                id: 'a',
                title: '<img src=x onerror=alert(1)>',
                href: 'https://example.com/a',
                children: {
                  attached: [
                    { id: 'a1', title: '' },
                    { id: 'a2', title: '# deep' },
                  ],
                },
              },
              { id: 'b', title: '[a] <b>', labels: ['[x]', 'y'] },
            ],
          },
        },
      },
      { title: 'Two', rootTopic: { id: 'r', title: 'Two' } },
    ]
    const outline = sheetsToOutline(sheets)
    const back = outlineToSheets(outline, { untitled: UNTITLED })
    expect(sheetsToOutline(back)).toBe(outline)
    expect(shapesOf(back)).toEqual(shapesOf(sheets))
  })

  it('brings hostile titles back to the letter', () => {
    const titles = [
      '<img src=x onerror=alert(1)>',
      '</script><!-- x --><?php',
      '[a] <b>',
      'x [label] <https://example.com>',
      'x <https://example.com>',
      '<https://example.com>',
      '[only, labels]',
      '[click](javascript:alert(1))',
      '# heading',
      '###### six',
      '####### seven',
      '#',
      '- item',
      '* item',
      '+ item',
      '-',
      '> quote',
      '>',
      '1. one',
      '12) twelve',
      '1.',
      '```js',
      '~~~',
      '---',
      '* * *',
      '___',
      // with the item's own marker in front, these would make a line that is a rule
      '--',
      '-- -',
      '- - -',
      '-  -',
      '***',
      '_ _ _',
      '=',
      '===',
      '(summary) fake',
      '(floating)',
      '(relationship) a -> b',
      '(+3 more)',
      'back\\slash\\',
      '\\[already escaped\\]',
      '\\',
      'a < b -> c <- d, 1.5 #tag -x (note) *bold* 2026.',
      'two  spaces\tand a tab',
      'ends with a bracket]',
      'ends with an angle <',
      '{#not-an-id}',
      '| a | b |',
      '한글 제목 \u{1F600}',
    ]
    expect(roundTrip(titles.map((title) => ({ title }))).map((shape) => shape.title)).toEqual(
      titles,
    )
    // The same titles in front of labels and a link.
    expect(
      roundTrip(titles.map((title) => ({ title, labels: ['l'], href: 'https://example.com/x' }))),
    ).toEqual(titles.map((title) => ({ title, labels: ['l'], link: 'https://example.com/x' })))
  })

  it('brings labels and links back to the letter', () => {
    const labels = ['a, b', '[x]', '<i>', 'c\\', ']', '[', ',', 'x]y[z', '- #', 'https://e.com']
    const links = [
      'https://example.com/a\\b]',
      'mailto:someone@example.com',
      'HTTPS://EXAMPLE.COM/(x)_[y]?q=1,2#frag',
      'http://example.com/\\',
    ]
    expect(
      roundTrip([
        { title: 't', labels },
        { title: '', labels },
        ...links.map((href) => ({ title: 't', href })),
        ...links.map((href) => ({ title: '', labels: ['l]'], href })),
      ]),
    ).toEqual([
      { title: 't', labels },
      { title: '', labels },
      ...links.map((link) => ({ title: 't', link })),
      ...links.map((link) => ({ title: '', labels: ['l]'], link })),
    ])
  })

  it('brings notes back to the letter, whatever they look like', () => {
    const notes = [
      'one line',
      'two\nlines',
      '\n\nstarts with blank lines',
      '  keeps   its spaces  \n\ttabs\t\nand the end',
      '# not a sheet\n## not a topic\n- nor this\n  1. nor this',
      '> already quoted\n> > twice',
      '```\ncode\n```',
      '| a | b |\n|---|---|',
      '[label] <https://example.com>\n(summary) x\n\\[escaped\\] \\\\',
      '<img src=x onerror=alert(1)>',
    ]
    expect(
      roundTrip(notes.map((note) => ({ title: 't', notes: { plain: { content: note } } }))),
    ).toEqual(notes.map((note) => ({ title: 't', note })))
  })

  it('changes only what the outline cannot hold', () => {
    expect(
      roundTrip([
        // the blank lines at the end of a note, which the format itself adds
        { title: 'note', notes: { plain: { content: 'one\r\ntwo\n\n' } } },
        // a title or label of several lines, and blanks around either
        { title: '  several\n lines  ', labels: [' padded ', 'two\nlines', ''] },
        // blanks and angle brackets in a link
        { title: 'link', href: 'https://example.com/a b<c>' },
        // a link that is not a web link
        { title: 'topic link', href: 'xmind:#t0' },
      ]),
    ).toEqual([
      { title: 'note', note: 'one\ntwo' },
      { title: 'several lines', labels: ['padded', 'two lines'] },
      { title: 'link', link: 'https://example.com/a%20b%3Cc%3E' },
      { title: 'topic link' },
    ])
  })

  it('survives random hostile maps', () => {
    const random = generator(20261014)
    const pick = <T>(from: readonly T[]): T => from[Math.floor(random() * from.length)]!
    const pieces = [
      ...['[', ']', '<', '>', '\\', '#', '-', ' ', '  ', ',', '(summary)', '(other) ', 'a', 'B'],
      ...['https://x.y/z', 'mailto:', '*', '`', '```', '~~~', '1.', '2)', '+', '_', '한글', '<b>'],
      ...['</i>', '(', ')', '{#', '}', '|', '=', '!', '&amp;', ':', '"', "'", '\t', '---', '> '],
      ...['--', '- -', '==='],
    ]
    const words = (most: number): string =>
      Array.from({ length: Math.floor(random() * most) }, () => pick(pieces)).join('')
    const linkPieces = ['a', '/', '?', '=', '&', '[', ']', '\\', '(', ')', '#', '%20', ',', '.']
    let made = 0
    const grow = (level: number): XmindTopic => {
      const topic: XmindTopic = { id: `id${made++}`, title: words(6).trim() }
      if (random() < 0.4) {
        topic.labels = Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
          words(4).trim(),
        ).filter((label) => label !== '')
      }
      if (random() < 0.3) {
        topic.href = `https://e.com/${Array.from({ length: 5 }, () => pick(linkPieces)).join('')}`
      }
      if (random() < 0.4) {
        const noteLines = Array.from({ length: 1 + Math.floor(random() * 4) }, () => words(5))
        topic.notes = { plain: { content: [...noteLines, `${words(3)}x`].join('\n') } }
      }
      if (level < 5 && random() < 0.7) {
        topic.children = {
          attached: Array.from({ length: 1 + Math.floor(random() * 4) }, () => grow(level + 1)),
        }
      }
      return topic
    }
    for (let round = 0; round < 40; round++) {
      const sheets: XmindSheet[] = [{ title: words(4).trim() || 'S', rootTopic: grow(0) }]
      const outline = sheetsToOutline(sheets)
      const back = outlineToSheets(outline, { untitled: UNTITLED })
      expect(shapesOf(back), outline).toEqual(shapesOf(sheets))
      expect(sheetsToOutline(back)).toBe(outline)
    }
    expect(made).toBeGreaterThan(300)
  })

  it('turns the items with a kind mark into ordinary topics', () => {
    const outline = lines(
      '- Root',
      '  - (summary) Sum',
      '    - below',
      '  - (floating)   Float [x]',
      '  - (callout) Call <https://example.com>',
      '  - (boundary) Bound',
      '  - (relationship) leads to -> Sum',
      '  - (other) Other',
      '  - (summary)',
      '  - \\(summary) not a mark',
      '  - (summary)glued',
      '  - (+3 more)',
      '',
      '## (summary) headings carry no mark',
    )
    expect(read(outline)[0]!.root.children![0]).toEqual({
      title: 'Root',
      children: [
        { title: 'Sum', children: [{ title: 'below' }] },
        { title: 'Float', labels: ['x'] },
        { title: 'Call', link: 'https://example.com' },
        { title: 'Bound' },
        { title: 'leads to -> Sum' },
        { title: 'Other' },
        { title: '' },
        { title: '(summary) not a mark' },
        { title: '(summary)glued' },
        { title: '(+3 more)' },
      ],
    })
    expect(read(outline)[0]!.root.children![1]).toEqual({
      title: '(summary) headings carry no mark',
    })
  })
})

describe('sheets and the central topic', () => {
  it('makes one sheet from text without a level 1 heading', () => {
    expect(read(lines('- Root', '  - a', '  - b'))).toEqual([
      { sheet: UNTITLED, root: { title: 'Root', children: [{ title: 'a' }, { title: 'b' }] } },
    ])
    expect(read(lines('## Root', '### a', '### b'))).toEqual([
      { sheet: UNTITLED, root: { title: 'Root', children: [{ title: 'a' }, { title: 'b' }] } },
    ])
  })

  it('puts several outermost items under a central topic named after the sheet', () => {
    expect(read(lines('- a', '- b', '  - b1'))).toEqual([
      {
        sheet: UNTITLED,
        root: {
          title: UNTITLED,
          children: [{ title: 'a' }, { title: 'b', children: [{ title: 'b1' }] }],
        },
      },
    ])
    expect(read(lines('# Plan', '', '- a', '- b'))).toEqual([
      { sheet: 'Plan', root: { title: 'Plan', children: [{ title: 'a' }, { title: 'b' }] } },
    ])
    expect(outlineToSheets('- a\n- b', { untitled: '제목 없음' })[0]).toMatchObject({
      title: '제목 없음',
      rootTopic: { title: '제목 없음' },
    })
  })

  it('takes the only outermost item as the central topic', () => {
    expect(read(lines('# Plan', '', '- Goal', '  - a'))).toEqual([
      { sheet: 'Plan', root: { title: 'Goal', children: [{ title: 'a' }] } },
    ])
    expect(read(lines('# Plan', '## Goal', '- a'))).toEqual([
      { sheet: 'Plan', root: { title: 'Goal', children: [{ title: 'a' }] } },
    ])
  })

  it('makes a sheet per level 1 heading, and always at least one', () => {
    expect(read(lines('# One', '- a', '# Two', '- b', '- c', '# Three'))).toEqual([
      { sheet: 'One', root: { title: 'a' } },
      { sheet: 'Two', root: { title: 'Two', children: [{ title: 'b' }, { title: 'c' }] } },
      { sheet: 'Three', root: { title: 'Three' } },
    ])
    for (const empty of ['', '\n\n', '   \n\t\n', '\uFEFF']) {
      expect(read(empty), JSON.stringify(empty)).toEqual([
        { sheet: UNTITLED, root: { title: UNTITLED } },
      ])
    }
    expect(read('#')).toEqual([{ sheet: UNTITLED, root: { title: UNTITLED } }])
    expect(read('#\n- x')).toEqual([{ sheet: UNTITLED, root: { title: 'x' } }])
  })

  it('keeps what stands before the first heading', () => {
    // Topics before it are a sheet of their own.
    expect(read(lines('- loose', '# One', '- a'))).toEqual([
      { sheet: UNTITLED, root: { title: 'loose' } },
      { sheet: 'One', root: { title: 'a' } },
    ])
    // Text alone goes to the central topic of the sheet that follows.
    expect(read(lines('---', 'title: x', '---', '', '# One', 'Intro.', '- a', '- b'))).toEqual([
      {
        sheet: 'One',
        root: {
          title: 'One',
          note: '---\ntitle: x\n---\n\nIntro.',
          children: [{ title: 'a' }, { title: 'b' }],
        },
      },
    ])
    // Text and nothing else is still a sheet, so it is not lost.
    expect(read('Just a sentence.\n\nAnd another.')).toEqual([
      { sheet: UNTITLED, root: { title: UNTITLED, note: 'Just a sentence.\n\nAnd another.' } },
    ])
  })

  it('gives text under the sheet heading to the central topic', () => {
    expect(
      read(lines('# Plan', '', 'Why we do this.', '', '- Goal', '  > own note', '  more')),
    ).toEqual([
      { sheet: 'Plan', root: { title: 'Goal', note: 'Why we do this.\n\nown note\n\nmore' } },
    ])
    // text after the list comes after the topic's own note, in the order it was written
    expect(
      read(lines('# Plan', 'Before.', '', '- Goal', '  > own note', '  - a', '', 'After.')),
    ).toEqual([
      {
        sheet: 'Plan',
        root: { title: 'Goal', note: 'Before.\n\nown note\n\nAfter.', children: [{ title: 'a' }] },
      },
    ])
    // the same with text before the first heading in front of it all
    expect(read(lines('Lead.', '# Plan', '- Goal', '  > own note', '', 'After.'))).toEqual([
      { sheet: 'Plan', root: { title: 'Goal', note: 'Lead.\n\nown note\n\nAfter.' } },
    ])
  })
})

describe('headings and lists', () => {
  it('nests headings by level and lists by indentation', () => {
    const outline = lines(
      '# Guide',
      '',
      'Intro paragraph.',
      '',
      '## Install',
      '',
      'Run the installer.',
      '',
      '### Windows',
      '',
      '1. Download',
      '2. Run',
      '   - as admin',
      '',
      '### Linux',
      '',
      '## Use',
      '',
      '#### Skipped a level',
      '###### Six',
      '## Last',
    )
    expect(read(outline)).toEqual([
      {
        sheet: 'Guide',
        root: {
          title: 'Guide',
          note: 'Intro paragraph.',
          children: [
            {
              title: 'Install',
              note: 'Run the installer.',
              children: [
                {
                  title: 'Windows',
                  children: [
                    { title: 'Download' },
                    { title: 'Run', children: [{ title: 'as admin' }] },
                  ],
                },
                { title: 'Linux' },
              ],
            },
            {
              title: 'Use',
              children: [{ title: 'Skipped a level', children: [{ title: 'Six' }] }],
            },
            { title: 'Last' },
          ],
        },
      },
    ])
  })

  it('reads numbered lists, every bullet and tab indentation', () => {
    const outline = lines(
      '1. one',
      '2. two',
      '\t* deep',
      '\t\t+ deeper',
      '\t* deep again',
      '3) three',
      '10. ten',
      '    - under ten',
      ' - one space is deeper too',
      '- back out',
    )
    expect(read(outline)[0]!.root.children).toEqual([
      { title: 'one' },
      {
        title: 'two',
        children: [{ title: 'deep', children: [{ title: 'deeper' }] }, { title: 'deep again' }],
      },
      { title: 'three' },
      {
        title: 'ten',
        children: [{ title: 'under ten' }, { title: 'one space is deeper too' }],
      },
      { title: 'back out' },
    ])
  })

  it('reads an indented code block outside a list as text, markers and all', () => {
    const outline = lines(
      '## Steps',
      '',
      '    steps:',
      '      - run: npm test',
      '    # a comment',
      '    > not a quote',
      '    ```',
      '\t1. tabbed',
      '',
      '- a topic again',
      '    - four columns under an item is a branch',
    )
    expect(read(outline)).toEqual([
      {
        sheet: UNTITLED,
        root: {
          title: 'Steps',
          note: outline.split('\n').slice(2, 8).join('\n'),
          children: [
            {
              title: 'a topic again',
              children: [{ title: 'four columns under an item is a branch' }],
            },
          ],
        },
      },
    ])
  })

  it('does not take everything that starts like a marker for a topic', () => {
    const outline = lines(
      '## T',
      '-not an item',
      '1.5 is a number',
      '*emphasis*',
      '#tag',
      '####### seven hashes',
      '    # indented four columns',
      '2026.10.14',
      '* * *',
      '- - -',
      '___',
    )
    expect(read(outline)).toEqual([
      { sheet: UNTITLED, root: { title: 'T', note: outline.split('\n').slice(1).join('\n') } },
    ])
  })

  it('reads heading text the way markdown does', () => {
    const outline = lines(
      '\uFEFF# Sheet \\[1\\] ##\r',
      '## Closed ##\r',
      '## C#\r',
      '## a \\#\r',
      '##\r',
      '   ## up to three spaces   ',
    )
    expect(read(outline)).toEqual([
      {
        sheet: 'Sheet [1]',
        root: {
          title: 'Sheet [1]',
          children: [
            { title: 'Closed' },
            { title: 'C#' },
            { title: 'a #' },
            { title: '' },
            { title: 'up to three spaces' },
          ],
        },
      },
    ])
  })
})

describe('text that is not a topic', () => {
  it('becomes the note of the heading above, as written', () => {
    const outline = lines(
      '## Topic',
      '',
      'First paragraph',
      'goes on here.',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '```js',
      'const x = [1, 2]',
      '',
      '  - not a topic',
      '# not a sheet',
      '```',
      '',
      '> a quote',
      '> second line',
      '',
      '---',
      '',
      '<div>html stays text</div>',
      '    indented code',
      '',
      '',
    )
    expect(read(outline)).toEqual([
      {
        sheet: UNTITLED,
        root: { title: 'Topic', note: outline.split('\n').slice(2, -2).join('\n') },
      },
    ])
  })

  it('becomes the note of the list item it stands under', () => {
    const outline = lines(
      '- item',
      '  Under the item.',
      '',
      '  ```',
      '  code in item',
      '    deeper',
      '  ```',
      '',
      '  - child',
      '',
      '    Child text.',
      '',
      '  Back to item.',
      '',
      'After the list.',
      '- second',
      'lazy line',
    )
    expect(read(outline)).toEqual([
      {
        sheet: UNTITLED,
        root: {
          title: UNTITLED,
          note: 'After the list.',
          children: [
            {
              title: 'item',
              note: 'Under the item.\n\n```\ncode in item\n  deeper\n```\n\nBack to item.',
              children: [{ title: 'child', note: 'Child text.' }],
            },
            { title: 'second', note: 'lazy line' },
          ],
        },
      },
    ])
  })

  it('keeps only the marker line as the title: a wrapped line goes to the note', () => {
    expect(read(lines('- Root', '  - A long item that', '    wraps onto the next line'))).toEqual([
      {
        sheet: UNTITLED,
        root: {
          title: 'Root',
          children: [{ title: 'A long item that', note: 'wraps onto the next line' }],
        },
      },
    ])
  })

  it('takes the quote lines directly under an item as its note, and any other quote as written', () => {
    const outline = lines(
      '- a',
      '  > note of a',
      '  >',
      '  >   keeps its spaces',
      '  >no space after the marker',
      '- b',
      '',
      '  > quoted later',
      '- c',
      '  text first',
      '  > then a quote',
      '- d',
      '> not indented',
      '',
      '## Heading',
      '> under a heading',
    )
    expect(read(outline)[0]!.root).toEqual({
      title: UNTITLED,
      note: '> not indented',
      children: [
        { title: 'a', note: 'note of a\n\n  keeps its spaces\nno space after the marker' },
        { title: 'b', note: '> quoted later' },
        { title: 'c', note: 'text first\n> then a quote' },
        { title: 'd' },
        { title: 'Heading', note: '> under a heading' },
      ],
    })
  })

  it('does not look for topics inside a code block', () => {
    expect(read(lines('- a', '```', '# not a sheet', '- not a topic'))).toEqual([
      { sheet: UNTITLED, root: { title: 'a', note: '```\n# not a sheet\n- not a topic' } },
    ])
    // A longer fence closes it; a fence of another kind does not.
    expect(read(lines('- a', '~~~~ text', '```', '- inside', '~~~', '~~~~~', '- b'))).toEqual([
      {
        sheet: UNTITLED,
        root: {
          title: UNTITLED,
          note: '~~~~ text\n```\n- inside\n~~~\n~~~~~',
          children: [{ title: 'a' }, { title: 'b' }],
        },
      },
    ])
    // A block inside an item ends where the item ends.
    expect(read(lines('- a', '  ```', '  code', '- b'))[0]!.root.children).toEqual([
      { title: 'a', note: '```\ncode' },
      { title: 'b' },
    ])
    // Inline code is not a fence.
    expect(read(lines('## T', '```not a fence```', '- topic'))).toEqual([
      {
        sheet: UNTITLED,
        root: { title: 'T', note: '```not a fence```', children: [{ title: 'topic' }] },
      },
    ])
  })
})

describe('labels and links on a topic line', () => {
  it('reads them at the end of an item or a heading, and nowhere else', () => {
    const cases: [line: string, shape: Shape][] = [
      ['- Task [done]', { title: 'Task', labels: ['done'] }],
      ['- Site <https://example.com>', { title: 'Site', link: 'https://example.com' }],
      [
        '- Both [a,  b ,, c] <mailto:x@y.z>',
        { title: 'Both', labels: ['a', 'b', 'c'], link: 'mailto:x@y.z' },
      ],
      [
        '## Heading [tag] <https://example.com/h>',
        { title: 'Heading', labels: ['tag'], link: 'https://example.com/h' },
      ],
      ['- [x] finished', { title: '[x] finished' }],
      ['- todo [ ]', { title: 'todo [ ]' }],
      ['- [link](https://example.com)', { title: '[link](https://example.com)' }],
      ['- see [docs][1]', { title: 'see [docs][1]' }],
      ['- arr[0]', { title: 'arr[0]' }],
      ['- nested [a [b]]', { title: 'nested [a [b]]' }],
      ['- inner [a [b]', { title: 'inner [a', labels: ['b'] }],
      ['- <b>bold</b>', { title: '<b>bold</b>' }],
      ['- a <notalink>', { title: 'a <notalink>' }],
      ['- x <javascript:alert(1)>', { title: 'x <javascript:alert(1)>' }],
      ['- x <https://example.com/a b>', { title: 'x <https://example.com/a b>' }],
      ['- glued<https://example.com>', { title: 'glued<https://example.com>' }],
      [
        '- wrong order <https://example.com> [late]',
        { title: 'wrong order <https://example.com>', labels: ['late'] },
      ],
      ['- esc \\[not a label\\]', { title: 'esc [not a label]' }],
      ['- \\*literal\\* and C:\\Users', { title: '*literal* and C:\\Users' }],
      ['- **bold** stays', { title: '**bold** stays' }],
    ]
    // A line on its own is the only outermost topic, so it is the central one.
    for (const [line, shape] of cases) {
      expect(read(line), line).toEqual([{ sheet: UNTITLED, root: shape }])
    }
  })
})

describe('untrusted text', () => {
  /** How many topics a tree holds and how deep below its root the deepest sits. */
  function measure(root: XmindTopic): { topics: number; depth: number } {
    let topics = 0
    let depth = 0
    const pending: [XmindTopic, number][] = [[root, 0]]
    for (let next = pending.pop(); next; next = pending.pop()) {
      topics++
      depth = Math.max(depth, next[1])
      for (const child of next[0].children?.attached ?? []) pending.push([child, next[1] + 1])
    }
    return { topics, depth }
  }

  const DEEP = 3000
  const nested = Array.from({ length: DEEP }, (_, level) => `${' '.repeat(level)}- t${level}`)

  it('flattens nesting deeper than a file may be, and loses no topic', async () => {
    const [sheet] = outlineToSheets(nested.join('\n'), { untitled: UNTITLED })
    expect(sheet!.rootTopic.title).toBe('t0')
    expect(measure(sheet!.rootTopic)).toEqual({ topics: DEEP, depth: MAX_TOPIC_DEPTH })
    expect(checkContentStructure([sheet]).ok).toBe(true)

    let topic = sheet!.rootTopic
    for (let level = 1; level < MAX_TOPIC_DEPTH; level++) topic = topic.children!.attached![0]!
    expect(topic.title).toBe(`t${MAX_TOPIC_DEPTH - 1}`)
    // Everything deeper stands at the last level, in the order it was read.
    expect(topic.children!.attached!.map((child) => child.title)).toEqual(
      Array.from({ length: DEEP - MAX_TOPIC_DEPTH }, (_, n) => `t${MAX_TOPIC_DEPTH + n}`),
    )

    const document = await createXmindDocumentFromOutline(nested.join('\n'), { untitled: UNTITLED })
    expect((await openXmind(await document.save())).status).toBe('ok')
  })

  it('flattens one level earlier when the central topic is made for the sheet', async () => {
    const outline = ['- first', ...nested].join('\n')
    const [sheet] = outlineToSheets(outline, { untitled: UNTITLED })
    expect(sheet!.rootTopic.title).toBe(UNTITLED)
    expect(measure(sheet!.rootTopic)).toEqual({ topics: DEEP + 2, depth: MAX_TOPIC_DEPTH })
    expect(checkContentStructure([sheet]).ok).toBe(true)

    let topic = sheet!.rootTopic.children!.attached![1]!
    for (let level = 1; level < MAX_TOPIC_DEPTH - 1; level++) topic = topic.children!.attached![0]!
    expect(topic.title).toBe(`t${MAX_TOPIC_DEPTH - 2}`)
    expect(topic.children!.attached!.map((child) => child.title)).toEqual(
      Array.from({ length: DEEP - MAX_TOPIC_DEPTH + 1 }, (_, n) => `t${MAX_TOPIC_DEPTH - 1 + n}`),
    )
    await expect(
      createXmindDocumentFromOutline(outline, { untitled: UNTITLED }),
    ).resolves.toBeDefined()
  })

  it('reads headings nested in lists nested in headings without recursion', () => {
    const outline = Array.from({ length: 20_000 }, (_, n) => `${'#'.repeat(2 + (n % 5))} h${n}`)
    const [sheet] = outlineToSheets(outline.join('\n'), { untitled: UNTITLED })
    expect(measure(sheet!.rootTopic).topics).toBe(20_001)
  })

  it('handles long hostile lines in time that grows with their length', () => {
    const size = 200_000
    const hostile = [
      `- ${'['.repeat(size)}`,
      `- ${'['.repeat(size)}]`,
      `- ${']'.repeat(size)}`,
      `- ${'\\'.repeat(size + 1)}]`,
      `- ${'x '.repeat(size)}[${'a,'.repeat(size)}]`,
      `- ${' <'.repeat(size)}https://example.com>`,
      `- ${'<'.repeat(size)}>`,
      `- ${' '.repeat(size)}x${' '.repeat(size)}`,
      '#'.repeat(size),
      `# ${'#'.repeat(size)}`,
      `# ${' #'.repeat(size)}`,
      `${' '.repeat(size)}- deep`,
      '>'.repeat(size),
      '- '.repeat(size),
      `${'- '.repeat(size)}x`,
      `${'* '.repeat(size)}x`,
      `${'1'.repeat(size)}. x`,
      '`'.repeat(size),
      '~'.repeat(size),
      `- (summary)${' '.repeat(size)}x`,
      ...Array.from({ length: 50_000 }, (_, n) => `- item ${n}`),
      ...Array.from({ length: 50_000 }, () => ''),
      ...Array.from({ length: 50_000 }, () => '  > note'),
    ].join('\n')
    const started = Date.now()
    const sheets = outlineToSheets(hostile, { untitled: UNTITLED })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(checkContentStructure(sheets).ok).toBe(true)
  })
})

describe('createXmindDocumentFromOutline', () => {
  it('makes a file that opens, with fresh ids and the same map', async () => {
    const outline = sheetsToOutline(tripSheets())
    const document = await createXmindDocumentFromOutline(outline, {
      untitled: UNTITLED,
      now: new Date(Date.UTC(2031, 4, 6, 7, 8, 10)),
    })
    expect(document.changed).toBe(false)
    expect(document.sheets).toHaveLength(2)
    expect(document.sheets[0]).toMatchObject({
      id: expect.stringMatching(UUID_V4),
      class: 'sheet',
      title: 'Trip',
      rootTopic: { id: expect.stringMatching(UUID_V4), class: 'topic', title: 'Summer trip' },
    })
    const places = document.sheets[0]!.rootTopic.children!.attached![0]!
    expect(places).toEqual({
      id: expect.stringMatching(UUID_V4),
      title: 'Places',
      labels: ['must see', 'coast'],
      href: 'https://example.com/places?x=1&y=2',
      notes: { plain: { content: 'Book early.\n\nAsk <b>Mina</b> & co.' } },
      children: { attached: expect.any(Array) },
    })

    const reopened = await openXmind(await document.save())
    if (reopened.status !== 'ok') throw new Error(reopened.status)
    expect(shapesOf(reopened.document.sheets)).toEqual(read(outline))
    expect(sheetsToOutline(reopened.document.sheets)).toBe(sheetsToOutline(document.sheets))
  })

  it('dresses every sheet with the default theme, like any new sheet', async () => {
    setDefaultSheetTheme((sheet) => {
      sheet.theme = { marker: 'default theme' }
    })
    const sheets = outlineToSheets('# One\n- a\n# Two\n- b', { untitled: UNTITLED })
    expect(sheets.map((sheet) => sheet.theme)).toEqual([
      { marker: 'default theme' },
      { marker: 'default theme' },
    ])
    const document = await createXmindDocumentFromOutline('- a\n- b', { untitled: UNTITLED })
    expect(document.sheets[0]!.theme).toEqual({ marker: 'default theme' })
  })

  it('gives sheets that can be added to a document that is open', async () => {
    const document = await createXmindDocumentFromOutline('# First\n- a', { untitled: UNTITLED })
    const [added] = outlineToSheets('- New\n  - from text', { untitled: 'Sheet 2' })
    document.sheets.push(added!)
    document.markChanged()
    const reopened = await openXmind(await document.save())
    if (reopened.status !== 'ok') throw new Error(reopened.status)
    expect(shapesOf(reopened.document.sheets)).toEqual([
      { sheet: 'First', root: { title: 'a' } },
      { sheet: 'Sheet 2', root: { title: 'New', children: [{ title: 'from text' }] } },
    ])
  })
})

/** A small seeded generator, so a failure can be run again. */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}
