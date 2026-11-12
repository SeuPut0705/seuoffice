import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocx, saveDocx, type SaveBlock } from '@seuoffice/docx-engine'
import JSZip from 'jszip'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { docxToText } from '../../file-parse/src/docx'
import { parseFileToText } from '../../file-parse/src/parse'
import { RedactionMarkError } from '../../file-parse/src/redaction-error'
import {
  hiddenPictureBase64,
  hiddenStoriesDocx,
  mutatedStoriesDocx,
  OWN_REDACT_NS,
  PICTURE_STORIES,
  PLACEHOLDER,
  PLAIN_PICTURE_ALT,
  PLAIN_PICTURE_BASE64,
  SECRET,
  TAG_MUTATION_NAMES,
  type StoriesOptions,
  type TagMutation,
} from '../../docx-engine/tests/helpers/hidden-stories'
import { defaultRegistry } from '../src/cli'
import { createContext, disposeContext, type McpContext } from '../src/mcp/run'
import { createMcpServer } from '../src/mcp/server'
import { run, tempDir } from './helpers'

/**
 * Pictures inside runs a person marked "hidden from AI": the picture, its
 * description, title and name are part of the run, so no reader hands over the
 * bytes or any of those words. A picture no mark covers reads as it did.
 */

const READ_FLAGS = [
  '--full',
  '--html',
  '--header-footer',
  '--comments',
  '--notes',
  '--fields',
  '--json',
]

/** every way a hidden picture could reach a reader's output */
function expectNothingOfHiddenPictures(output: string) {
  expect(output).not.toContain(SECRET)
  for (const story of PICTURE_STORIES) {
    // the bytes, whole and in part: a data URL, a base64 field or a re-encoded slice
    expect(output).not.toContain(hiddenPictureBase64(story).slice(30, 70))
  }
}

type Variant = { name: string; options: StoriesOptions }
const VARIANTS: Variant[] = [
  { name: 'words hidden', options: { pictures: true } },
  { name: 'words that read like their placeholder', options: { pictures: true, literal: true } },
]

async function fixture(dir: string, mutation: TagMutation | 'none', options: StoriesOptions) {
  return mutation === 'none'
    ? hiddenStoriesDocx(dir, OWN_REDACT_NS, 'pictures.docx', 'go', options)
    : mutatedStoriesDocx(dir, mutation, options)
}

async function attachmentText(file: string): Promise<string> {
  const text = await docxToText(new Uint8Array(readFileSync(file))).catch((err: unknown) => {
    // refusing the file is a safe answer; anything else is a failure
    if (err instanceof RedactionMarkError) return ''
    throw err
  })
  const parsed = await parseFileToText(file).catch((err: unknown) => {
    if (err instanceof RedactionMarkError) return { text: '' }
    throw err
  })
  return `${text}\n${'text' in parsed ? (parsed.text ?? '') : ''}`
}

describe.each(VARIANTS)('pictures in hidden runs ($name)', ({ options }) => {
  describe.each(['none', ...TAG_MUTATION_NAMES] as const)('tags: %s', (mutation) => {
    it('docs read hands over no hidden picture', async () => {
      const file = await fixture(tempDir(), mutation, options)
      const read = await run(['docs', 'read', file, ...READ_FLAGS])
      expect(read.code).toBe(0)
      expectNothingOfHiddenPictures(read.stdout)
      expectNothingOfHiddenPictures(read.stderr)
      // and the stories still list their placeholder
      if (mutation === 'none' && !options.literal) {
        const detail = read.json().detail
        expect(detail.comments.find((c: { id: string }) => c.id === '1').text).toBe(
          `Note: ${PLACEHOLDER}`,
        )
        expect(detail.notes[0].text).toBe(`See ${PLACEHOLDER}`)
        expect(detail.headerFooter.header).toContain(PLACEHOLDER)
        expect(detail.headerFooter.footer).toContain(PLACEHOLDER)
        // a block that is only a hidden picture lists as the placeholder, not as nothing
        const blocks = detail.items as Array<{ kind?: string; text: string }>
        expect(blocks.filter((b) => b.kind !== undefined).map((b) => b.text)).toEqual([
          PLACEHOLDER,
          PLACEHOLDER,
          '',
        ])
      }
    })

    it('an attachment read hands over no hidden picture', async () => {
      const file = await fixture(tempDir(), mutation, options)
      expectNothingOfHiddenPictures(await attachmentText(file))
    })
  })

  it('a comment that holds a hidden picture lists no picture, and a plain one still does', async () => {
    const file = await hiddenStoriesDocx(tempDir(), OWN_REDACT_NS, 'pictures.docx', 'go', options)
    const read = await run(['docs', 'read', file, '--comments', '--json'])
    const comments = read.json().detail.comments as Array<{
      id: string
      text: string
      image?: { base64: string }
    }>
    expect(comments.find((c) => c.id === '1')!.image).toBeUndefined()
    expect(comments.find((c) => c.id === '2')!.image?.base64).toBe(PLAIN_PICTURE_BASE64)
  })
})

describe('a picture no mark covers', () => {
  it('stays in the readers hands', async () => {
    const file = await hiddenStoriesDocx(tempDir(), OWN_REDACT_NS, 'pictures.docx', 'go', {
      pictures: true,
    })
    const read = await run(['docs', 'read', file, '--full', '--html', '--comments', '--json'])
    expect(read.stdout).toContain(PLAIN_PICTURE_BASE64)
    // the plain picture's paragraph is still a block of its own
    expect(read.json().detail.items.some((i: { kind?: string }) => i.kind === 'image')).toBe(true)
    expect(PLAIN_PICTURE_ALT).toBe('Company logo')
  })
})

describe('mcp: docs_read hands over no hidden picture', () => {
  let ctx: McpContext
  let client: Client
  let dir: string

  beforeAll(async () => {
    dir = tempDir()
    ctx = createContext({
      cwd: dir,
      env: { ...process.env, SEUOFFICE_AUDIT_LOG: 'off' },
      log: () => {},
    })
    const server = await createMcpServer(ctx, { registry: defaultRegistry() })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
  })

  afterAll(async () => {
    await client.close()
    disposeContext(ctx)
  })

  it.each(
    VARIANTS.flatMap((v) => (['none', ...TAG_MUTATION_NAMES] as const).map((m) => [v, m] as const)),
  )('%# docs_read', async (variant, mutation) => {
    const file = await fixture(dir, mutation, variant.options)
    const r = await client.callTool({
      name: 'docs_read',
      arguments: {
        file,
        full: true,
        html: true,
        comments: true,
        notes: true,
        'header-footer': true,
        fields: true,
      },
    })
    const content = r.content as Array<{ type: string; text?: string; data?: string }>
    const everything = content.map((c) => c.text ?? c.data ?? '').join('\n')
    expectNothingOfHiddenPictures(everything)
    expect(content.every((c) => c.type === 'text')).toBe(true)
  })
})

/**
 * A hidden run whose words are the placeholder itself reads, to a model, the
 * same as it says: nothing in what a reader hands over tells it apart from a
 * plain run. What a reader withholds, refuses or keeps must follow the mark.
 */
describe('a hidden run whose words are the placeholder', () => {
  const literal: StoriesOptions = { pictures: true, literal: true }
  const opsFile = (dir: string, ops: unknown[]) => {
    const path = join(dir, `ops-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(path, JSON.stringify(ops))
    return path
  }
  const wordParts = async (file: string) => {
    const zip = await JSZip.loadAsync(readFileSync(file))
    return Promise.all(
      Object.keys(zip.files)
        .filter((path) => /^word\/[^/]+\.xml$/.test(path))
        .map(async (path) => [path, await zip.file(path)!.async('string')] as const),
    )
  }
  /** every run of the file holding a hidden picture is still marked, and every marked picture is still there */
  const expectPicturesStillMarked = async (file: string) => {
    const parts = await wordParts(file)
    const drawings = parts.flatMap(([part, xml]) =>
      (xml.match(/<w:r>(?:(?!<\/w:r>)[\s\S])*<\/w:r>/g) ?? [])
        .filter((run) => run.includes(`${SECRET}P`))
        .map((run) => [part, run] as const),
    )
    expect(drawings.map(([part]) => part).sort()).toEqual(
      [
        'word/comments.xml',
        ...Array<string>(4).fill('word/document.xml'),
        'word/footer1.xml',
        'word/footnotes.xml',
        'word/header1.xml',
      ].sort(),
    )
    for (const [, run] of drawings) expect(run).toMatch(/<(?:\w+:)?redact[\s/>]/)
  }
  const marks = async (file: string) =>
    Object.fromEntries(
      (await wordParts(file)).map(([part, xml]) => [
        part,
        (xml.match(/<(?:[\w.-]+:)?redact[\s/>]/g) ?? []).length,
      ]),
    )

  it('edit_note is refused whatever it looks for, and writes nothing', async () => {
    const dir = tempDir()
    const file = await hiddenStoriesDocx(dir, OWN_REDACT_NS, 'literal.docx', 'go', literal)
    const before = readFileSync(file)
    const messages: string[] = []
    for (const find of ['See', 'client', 'absent']) {
      const r = await run([
        'docs',
        'apply',
        file,
        '--ops',
        opsFile(dir, [{ op: 'edit_note', kind: 'footnote', id: '1', find, replace: 'x' }]),
        '--json',
      ])
      expect(r.code).not.toBe(0)
      messages.push(r.json().message)
    }
    expect(new Set(messages).size).toBe(1)
    expect(messages[0]).toContain('hid from AI')
    expect(readFileSync(file)).toEqual(before)
  })

  it('a header edit that drops the placeholder is refused, and one that keeps it saves the mark', async () => {
    const dir = tempDir()
    const file = await hiddenStoriesDocx(dir, OWN_REDACT_NS, 'literal.docx', 'go', literal)
    const before = readFileSync(file)
    const refused = await run([
      'docs',
      'apply',
      file,
      '--ops',
      opsFile(dir, [{ op: 'set_header_footer', kind: 'header', text: 'Report' }]),
      '--json',
    ])
    expect(refused.code).not.toBe(0)
    expect(readFileSync(file)).toEqual(before)
    await expectPicturesStillMarked(file)
    const saved = await run([
      'docs',
      'apply',
      file,
      '--ops',
      opsFile(dir, [
        { op: 'set_header_footer', kind: 'header', text: `Report ${PLACEHOLDER}` },
        { op: 'insert_content', html: '<p>Appended.</p>' },
      ]),
      '--json',
    ])
    expect(saved.code).toBe(0)
    await expectPicturesStillMarked(file)
    // the words are still written under a mark, whatever the runs were cut into
    const header = (await wordParts(file)).find(([part]) => part === 'word/header1.xml')![1]
    expect(header).toMatch(/redact[^]*?<w:t[^>]*>\{\{client phone\}\}<\/w:t>/)
    const read = await run(['docs', 'read', file, '--header-footer', '--json'])
    expect(read.json().detail.headerFooter.header).toBe(`Report ${PLACEHOLDER}`)
    expectNothingOfHiddenPictures(read.stdout)
  })

  it('the save of a change elsewhere keeps every mark and the picture stays withheld', async () => {
    const dir = tempDir()
    const file = await hiddenStoriesDocx(dir, OWN_REDACT_NS, 'literal.docx', 'go', literal)
    const marksBefore = await marks(file)
    await expectPicturesStillMarked(file)
    for (const op of [
      { op: 'insert_footnote', blockIndex: 0, text: 'Extra note.' },
      { op: 'add_comment', blockIndex: 0, comment: 'Extra comment.' },
      { op: 'insert_content', html: '<p>Appended.</p>' },
    ]) {
      const applied = await run(['docs', 'apply', file, '--ops', opsFile(dir, [op]), '--json'])
      expect(applied.code).toBe(0)
    }
    const after = await marks(file)
    for (const [part, count] of Object.entries(marksBefore))
      expect(after[part]).toBeGreaterThanOrEqual(count)
    await expectPicturesStillMarked(file)
    const read = await run(['docs', 'read', file, ...READ_FLAGS])
    expectNothingOfHiddenPictures(read.stdout)
  })
})

describe('a comment with a hidden run and a hidden picture, edited across the boundary and saved', () => {
  it('lists no picture and hands over no hidden word after the reopen', async () => {
    const dir = tempDir()
    const file = await hiddenStoriesDocx(dir, OWN_REDACT_NS, 'edited.docx', 'go', {
      pictures: true,
    })
    const doc = await parseDocx(new Uint8Array(readFileSync(file)))
    const blocks = doc.blocks
      .filter((block) => !block.hidden)
      .map((block): SaveBlock => ({ kind: 'original', docxIndex: block.docxIndex! }))
    // a paragraph added: the comment cannot be patched around its hidden runs and is written anew
    const saved = await saveDocx(doc, blocks, {
      comments: doc.comments.map((c) => (c.id === '1' ? { ...c, text: `${c.text}\nmore` } : c)),
    })
    writeFileSync(file, saved)
    const read = await run(['docs', 'read', file, ...READ_FLAGS])
    expect(read.code).toBe(0)
    expectNothingOfHiddenPictures(read.stdout)
    const comments = read.json().detail.comments as Array<{ id: string; image?: unknown }>
    expect(comments.find((c) => c.id === '1')!.image).toBeUndefined()
    expect(comments.find((c) => c.id === '2')!.image).toBeDefined()
  })
})
