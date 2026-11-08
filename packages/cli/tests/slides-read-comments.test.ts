import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { defaultRegistry } from '../src/cli'
import { resolveTool, toolShape, TOOLS } from '../src/mcp/tools'
import { run, tempDir } from './helpers'

function text(t: string) {
  return {
    type: 'text',
    x: 80,
    y: 80,
    w: 600,
    h: 80,
    paragraphs: [{ runs: [{ text: t }] }],
  }
}

/** Two slides: a comment on each, a speaker note, and slide 1 hidden. */
async function commentedDeck(): Promise<string> {
  const dir = tempDir()
  const spec = join(dir, 'deck.json')
  writeFileSync(
    spec,
    JSON.stringify({ pages: [{ elements: [text('First')] }, { elements: [text('Second')] }] }),
  )
  const file = join(dir, 'deck.pptx')
  expect(
    (await run(['create', '--type', 'pptx', '--spec', spec, '--out', file, '--json'])).code,
  ).toBe(0)
  const ops = join(dir, 'ops.json')
  writeFileSync(
    ops,
    JSON.stringify([
      {
        op: 'addComment',
        target: { slide: 0 },
        text: 'Tighten the title',
        author: 'Ada Lovelace',
      },
      {
        op: 'addComment',
        target: { slide: 1 },
        text: 'Second thought',
        author: 'Grace Hopper',
      },
      { op: 'setNotes', target: { slide: 1 }, text: 'Speaker line' },
      { op: 'setHidden', target: { slide: 1 }, hidden: true },
    ]),
  )
  expect((await run(['slides', 'apply', file, '--ops', ops, '--json'])).code).toBe(0)
  return file
}

async function read(file: string, ...flags: string[]) {
  const r = await run(['slides', 'read', file, ...flags, '--json'])
  expect(r.code).toBe(0)
  return r.json().detail
}

describe('slides read --comments', () => {
  it('adds stored comments and hidden state only when asked', async () => {
    const file = await commentedDeck()
    for (const flags of [[], ['--full']]) {
      const deck = await read(file, ...flags)
      for (const page of deck.pages) {
        expect(page).not.toHaveProperty('comments')
        expect(page).not.toHaveProperty('hidden')
      }
    }

    const deck = await read(file, '--comments')
    expect(deck.pages).toHaveLength(2)
    const first = deck.pages[0].comments as Record<string, unknown>[]
    expect(first).toHaveLength(1)
    expect(Object.keys(first[0]!).sort()).toEqual(['author', 'authorId', 'dt', 'idx', 'text'])
    expect(first[0]).toMatchObject({
      authorId: 0,
      idx: 1,
      author: 'Ada Lovelace',
      text: 'Tighten the title',
    })
    expect(typeof first[0]!.dt).toBe('string')
    expect(first[0]!.dt).not.toBe('')
    expect(deck.pages[0]).not.toHaveProperty('hidden')

    expect(deck.pages[1].hidden).toBe(true)
    expect(deck.pages[1].comments).toEqual([
      expect.objectContaining({ author: 'Grace Hopper', text: 'Second thought' }),
    ])
  })

  it('respects --slide and is independent of --full', async () => {
    const file = await commentedDeck()
    const only = await read(file, '--comments', '--slide', '1')
    expect(only.pages).toHaveLength(1)
    expect(only.pages[0].index).toBe(1)
    expect(only.pages[0].hidden).toBe(true)
    expect(only.pages[0].comments).toHaveLength(1)
    expect(only.pages[0]).not.toHaveProperty('notes')

    const withFull = await read(file, '--comments', '--full', '--slide', '1')
    expect(withFull.pages[0].hidden).toBe(true)
    expect(withFull.pages[0].comments).toHaveLength(1)
    expect(withFull.pages[0].notes).toBe('Speaker line')
  })

  it('reports Unknown author and an empty dt for incomplete comment parts', async () => {
    const file = await commentedDeck()
    const zip = await JSZip.loadAsync(readFileSync(file))
    for (const name of Object.keys(zip.files)) {
      if (!/^ppt\/comments\/comment\d+\.xml$/.test(name)) continue
      const xml = await zip.file(name)!.async('string')
      const patched = xml
        .replace(/(<p:cm\b[^>]*?)\s+authorId="\d+"/g, '$1 authorId="999"')
        .replace(/(<p:cm\b[^>]*?)\s+dt="[^"]*"/g, '$1')
      zip.file(name, patched)
    }
    writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }))

    const deck = await read(file, '--comments')
    expect(deck.pages[0].comments).toEqual([
      expect.objectContaining({ authorId: 999, author: 'Unknown author', dt: '' }),
    ])
  })

  it('exposes comments on the slides_read MCP tool', () => {
    const tool = resolveTool(
      TOOLS.find((t) => t.name === 'slides_read')!,
      defaultRegistry(),
    )
    const shape = toolShape(tool)
    expect(shape.comments!.safeParse(true).success).toBe(true)
    expect(tool.description).toContain('comments')
  })
})
