import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pptxToText } from '../../file-parse/src/pptx'
import { RedactionMarkError } from '../../file-parse/src/redaction-error'
import {
  ALL_STORIES,
  mutatedHiddenDeck,
  SECRET_RUNS,
  PLACEHOLDER,
  SECRET,
  TAG_MUTATION_NAMES,
  type TagMutation,
} from '../../pptx-engine/tests/helpers/hidden-deck'
import { runTxn, type Op } from '@seuoffice/pptx-ops'
import { defaultRegistry } from '../src/cli'
import { openDeck, saveDeck } from '../src/formats/pptx'
import { createContext, disposeContext, type McpContext } from '../src/mcp/run'
import { createMcpServer } from '../src/mcp/server'
import { run, tempDir } from './helpers'

/**
 * The hidden-deck fixture (body, table cell, grouped shape, field, speaker
 * notes, modern comment, each with a run hidden from AI) with its tags written
 * another valid way. Whatever a reader makes of the tags, no hidden word may
 * reach what it hands over; a reader that refuses the file is a safe answer.
 */

const VARIANTS: TagMutation[] = ['none', ...TAG_MUTATION_NAMES]

interface ReadElement {
  type: string
  text?: string
  children?: ReadElement[]
}

/** every text a `slides read --full` reports on the first slide, in document order */
function readTexts(detail: {
  pages: Array<{ elements: ReadElement[]; notes?: string }>
}): string[] {
  const walk = (els: ReadElement[]): string[] =>
    els.flatMap((el) => [...(el.text ? [el.text] : []), ...walk(el.children ?? [])])
  const page = detail.pages[0]!
  return [...walk(page.elements), ...(page.notes ? [page.notes] : [])]
}

/**
 * What a reader that handed the deck over has to show: every story listed with
 * its placeholder. A deck whose tags read as no text at all lists nothing, and
 * has nothing to withhold.
 */
function expectStoriesWithheld(texts: string[], listing: string): void {
  if (!texts.some((t) => t.includes('Edit me please'))) return
  // the pictures nobody hid stay listed, and the hidden ones are not named
  expect(listing).toContain('Plain photo')
  expect(listing).toContain('Grouped plain photo')
  const shown = texts.join('\n')
  expect(shown).toMatch(new RegExp(`^(Call|Ring) ${PLACEHOLDER} now$`, 'm'))
  expect(shown).toMatch(new RegExp(`^(Phone|Zed) \\| (Tel|Phone) ${PLACEHOLDER}$`, 'm'))
  expect(texts).toContain(`Group ${PLACEHOLDER}`)
  expect(texts).toContain(`Today ${PLACEHOLDER}`)
  expect(texts).toContain(`See ${PLACEHOLDER}`)
}

async function attachmentText(file: string): Promise<string> {
  return pptxToText(new Uint8Array(readFileSync(file))).catch((err: unknown) => {
    // refusing the file is a safe answer; anything else is a failure
    if (err instanceof RedactionMarkError) return ''
    throw err
  })
}

describe.each(VARIANTS)('slide tags rewritten: %s', (mutation) => {
  it('slides read hands over no hidden word', async () => {
    const file = await mutatedHiddenDeck(tempDir(), mutation)
    const read = await run(['slides', 'read', file, '--full', '--json'])
    expect(read.stdout).not.toContain(SECRET)
    expect(read.stderr).not.toContain(SECRET)
    if (mutation === 'none') expect(read.code).toBe(0)
    if (read.code === 0) expectStoriesWithheld(readTexts(read.json().detail), read.stdout)
  })

  it('an attachment read hands over no hidden word', async () => {
    const file = await mutatedHiddenDeck(tempDir(), mutation)
    const text = await attachmentText(file)
    expect(text).not.toContain(SECRET)
    if (mutation === 'none') {
      // the modern comment is listed too
      expect(text.split(PLACEHOLDER).length - 1).toBe(SECRET_RUNS + 2)
    }
  })
})

describe('mcp: slide tags rewritten', () => {
  let ctx: McpContext
  let client: Client
  const dir = tempDir()

  beforeAll(async () => {
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

  it.each(VARIANTS)('%s: slides_read hands over no hidden word', async (mutation) => {
    const file = await mutatedHiddenDeck(dir, mutation, `mcp-${VARIANTS.indexOf(mutation)}.pptx`)
    const result = await client.callTool({ name: 'slides_read', arguments: { file, full: true } })
    const text = (result.content as { type: string; text?: string }[])
      .map((c) => c.text ?? '')
      .join('\n')
    expect(text).not.toContain(SECRET)
    if (mutation === 'none') expect(result.isError).not.toBe(true)
    if (!result.isError && text.includes('Edit me please')) {
      expect(text).toContain('Plain photo')
      // four placeholders in the shapes, the notes' one besides
      expect(text.split(PLACEHOLDER).length - 1).toBeGreaterThanOrEqual(5)
    }
  })
})

/**
 * A change elsewhere in the deck, saved: whatever the tags looked like, every
 * hidden run keeps its words and its mark, and no reader of the saved file
 * hands a hidden word over.
 */
/**
 * Changes only the editor makes: it shows the person their own words, so it can send a hidden
 * run back or edit around one. An agent's `slides apply` refuses them (slides-write-guard.test.ts),
 * so these go through the executor as the editor calls it, with no guard.
 */
const EDITOR_CHANGES = new Set([
  'retype the words around a hidden run',
  'type inside a hidden run',
  'ungroup the group holding a hidden run',
  'edit a plain table cell beside a hidden one',
])

/** the command line's `slides apply`, or the editor's save of the same ops */
async function applyChange(
  file: string,
  change: string,
  ops: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!EDITOR_CHANGES.has(change)) return run(['slides', 'apply', file, '--ops', ops, '--json'])
  try {
    const opened = await openDeck(new Uint8Array(readFileSync(file)))
    const result = runTxn(opened, { ops: CHANGES[change] as Op[] })
    if (!result.applied)
      return { code: 1, stdout: (result.failures ?? []).map((f) => f.error).join('\n'), stderr: '' }
    writeFileSync(file, await saveDeck(opened))
    return { code: 0, stdout: '', stderr: '' }
  } catch (err) {
    return { code: 3, stdout: String(err), stderr: '' }
  }
}

const CHANGES: Record<string, unknown[]> = {
  'edit another text box': [{ op: 'findReplace', find: 'Edit me', replace: 'Edited' }],
  'edit the words around a hidden run': [{ op: 'findReplace', find: 'Call ', replace: 'Ring ' }],
  // the editor's own save of a text box: the hidden run is sent back with its words, traced to its source run
  'retype the words around a hidden run': [
    {
      op: 'setText',
      target: { slide: 0, el: 'e_2' },
      paragraphs: [
        {
          srcPara: 0,
          runs: [
            { text: 'Ring ', srcRun: 0 },
            { text: `${SECRET}B`, srcRun: 1 },
            { text: ' now', srcRun: 2 },
          ],
        },
      ],
    },
  ],
  // someone typing inside the hidden words: they stay hidden
  'type inside a hidden run': [
    {
      op: 'setText',
      target: { slide: 0, el: 'e_2' },
      paragraphs: [
        {
          srcPara: 0,
          runs: [
            { text: 'Call ', srcRun: 0 },
            { text: `${SECRET}B!`, srcRun: 1 },
            { text: ' now', srcRun: 2 },
          ],
        },
      ],
    },
    {
      op: 'setTableCell',
      target: { slide: 0, el: 'e_4' },
      row: 0,
      col: 1,
      paragraphs: [
        {
          srcPara: 0,
          runs: [
            { text: 'Tel ', srcRun: 0 },
            { text: `${SECRET}T!`, srcRun: 1 },
          ],
        },
      ],
    },
  ],
  'restyle the shapes holding a hidden run': [
    { op: 'setFont', target: { slide: 0, el: 'e_2' }, font: { bold: true } },
    { op: 'setFont', target: { slide: 0, el: 'e_4' }, font: { fontSizePt: 30 } },
    { op: 'setFont', target: { slide: 0, el: 'e_7' }, font: { italic: true } },
    { op: 'setFont', target: { slide: 0, el: 'e_6' }, group: 'e_5', font: { bold: true } },
    { op: 'setParagraphFormat', target: { slide: 0, el: 'e_2' }, format: { align: 'ctr' } },
  ],
  'move a shape holding a hidden run': [
    {
      op: 'setTransform',
      target: { slide: 0, el: 'e_2' },
      box: { x: 123456, y: 500000, cx: 4000000, cy: 600000 },
    },
  ],
  'ungroup the group holding a hidden run': [
    { op: 'ungroupElement', target: { slide: 0, el: 'e_5' } },
  ],
  'edit a plain table cell beside a hidden one': [
    {
      op: 'setTableCell',
      target: { slide: 0, el: 'e_4' },
      row: 0,
      col: 0,
      paragraphs: [{ srcPara: 0, runs: [{ text: 'Zed', srcRun: 0 }] }],
    },
  ],
  'edit the words around a hidden table run': [
    { op: 'findReplace', find: 'Tel ', replace: 'Phone ' },
  ],
}

/** the edits a deck must take whatever its tags look like (the engine cannot read the other spellings at all) */
const MUST_APPLY = new Set([
  'edit another text box',
  'edit the words around a hidden run',
  'retype the words around a hidden run',
])
const UNREADABLE = new Set<TagMutation>(['namespace prefix a', 'namespace prefix p'])

describe.each(VARIANTS)('slide tags rewritten: %s, then saved', (mutation) => {
  for (const change of Object.keys(CHANGES)) {
    it(`${change} keeps every hidden run hidden`, async () => {
      const dir = tempDir()
      const file = await mutatedHiddenDeck(dir, mutation)
      const before = readFileSync(file)
      const readBefore = await run(['slides', 'read', file, '--full', '--json'])
      const ops = join(dir, 'ops.json')
      writeFileSync(ops, JSON.stringify(CHANGES[change]))
      const applied = await applyChange(file, change, ops)
      expect(applied.stdout).not.toContain(SECRET)
      expect(applied.stderr).not.toContain(SECRET)
      if (MUST_APPLY.has(change) && !UNREADABLE.has(mutation)) expect(applied.code).toBe(0)
      if (applied.code !== 0) {
        // a deck the editor refuses is left as it was
        expect(readFileSync(file).equals(before)).toBe(true)
        return
      }

      // the words are kept in the file
      const zip = await JSZip.loadAsync(readFileSync(file))
      const parts = await Promise.all(
        Object.keys(zip.files)
          .filter((path) => /^ppt\/.*\.xml$/.test(path))
          .map((path) => zip.file(path)!.async('string')),
      )
      for (const tag of ALL_STORIES) {
        expect(
          parts.some((xml) => xml.includes(`${SECRET}${tag}`)),
          `${SECRET}${tag} is kept`,
        ).toBe(true)
      }

      // and still withheld from every reader
      const read = await run(['slides', 'read', file, '--full', '--json'])
      expect(read.stdout).not.toContain(SECRET)
      // a saved deck reads as well as it did
      expect(read.code).toBe(readBefore.code)
      if (read.code === 0) {
        const texts = readTexts(read.json().detail)
        expectStoriesWithheld(texts, read.stdout)
        if (change === 'edit another text box') expect(texts).toContain('Edited please')
      }
      expect(await attachmentText(file)).not.toContain(SECRET)
    })
  }
})
