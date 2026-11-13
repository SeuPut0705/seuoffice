import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anchorsDocx, anchorsFor } from '../../docx-engine/tests/helpers/hidden-anchors'
import { SECRET } from '../../docx-engine/tests/helpers/hidden-stories'
import { defaultRegistry } from '../src/cli'
import { createContext, disposeContext, type McpContext } from '../src/mcp/run'
import { createMcpServer } from '../src/mcp/server'
import { run, tempDir } from './helpers'

/**
 * `docs apply` (and the MCP tool behind it) run the same ops as the app's AI.
 * A phrase an op looks for must not tell the caller anything about the words a
 * person hid from AI: an error never quotes them, and a guess that is right
 * is answered as a phrase that is not there, with the document left as it was.
 */

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** every quote of the anchor the caller sent (not the block's text in parentheses) taken out */
function withoutAnchor(text: string, anchor: string, jsonEscaped: boolean): string {
  const quote = jsonEscaped ? '\\\\"' : '"'
  const words = jsonEscaped ? JSON.stringify(anchor).slice(1, -1) : anchor
  return text.replace(
    new RegExp(`${quote}${escapeRegExp(words)}${quote}(?!\\))`, 'g'),
    `${quote}<anchor>${quote}`,
  )
}

const OPS: Record<string, (anchor: string) => unknown> = {
  'insertField afterText': (afterText) => ({
    op: 'insertField',
    target: { blockIndexes: [0] },
    type: 'PAGE',
    afterText,
  }),
  'insert_footnote afterText': (afterText) => ({
    op: 'insert_footnote',
    blockIndex: 0,
    afterText,
    text: 'note',
  }),
  'add_comment text': (text) => ({ op: 'add_comment', blockIndex: 0, text, comment: 'c' }),
  findReplace: (find) => ({ op: 'findReplace', find, replace: 'X' }),
  'setMatchedFont text': (text) => ({ op: 'setMatchedFont', text, bold: true }),
  'a target by text': (containsText) => ({
    op: 'setFont',
    target: { containsText },
    bold: true,
  }),
}

async function file(literal: boolean, dir = tempDir()): Promise<string> {
  const path = join(dir, 'anchors.docx')
  writeFileSync(path, await anchorsDocx(literal))
  return path
}

interface Answer {
  code: number
  output: string
  untouched: boolean
}

async function apply(literal: boolean, op: unknown, anchor: string): Promise<Answer> {
  const dir = tempDir()
  const path = await file(literal, dir)
  const before = readFileSync(path)
  const opsPath = join(dir, 'ops.json')
  writeFileSync(opsPath, JSON.stringify([op]))
  const r = await run(['docs', 'apply', path, '--ops', opsPath, '--json'])
  // the whole answer, anchor quoted by the caller taken out
  const output = withoutAnchor(`${r.stdout}\n${r.stderr}`, anchor, true)
  return { code: r.code, output, untouched: readFileSync(path).equals(before) }
}

describe.each([false, true])('docs apply, hidden words literal: %s', (literal) => {
  const anchors = anchorsFor(literal)
  const miss = anchors['a phrase that is not there']!

  describe.each(Object.keys(OPS))('%s', (opName) => {
    // a target by text reads what the model reads, so the placeholder itself selects its block
    it.skipIf(literal && opName === 'a target by text').each(Object.entries(anchors))(
      'answers an anchor on %s as a phrase that is not there',
      async (_what, anchor) => {
        const answer = await apply(literal, OPS[opName]!(anchor), anchor)
        const reference = await apply(literal, OPS[opName]!(miss), miss)
        // the answer carries the file's own path, which differs per run
        const strip = (text: string) => text.replace(/[^"\\ ]*anchors\.docx/g, '<file>')
        expect(strip(answer.output)).toBe(strip(reference.output))
        expect(answer.code).toBe(reference.code)
        expect(answer.untouched).toBe(reference.untouched)
      },
    )

    it('never quotes the hidden words', async () => {
      for (const anchor of Object.values(anchors)) {
        const { output } = await apply(literal, OPS[opName]!(anchor), anchor)
        expect(output).not.toContain(SECRET)
        expect(output).not.toContain(SECRET.slice(0, 5))
        expect(output).not.toContain(SECRET.slice(-5))
      }
    })
  })

  it('leaves a document with a hidden heading without a table of contents, and says why without the words', async () => {
    const answer = await apply(literal, { op: 'insertToc', afterBlockIndex: -1 }, 'zzzz')
    expect(answer.code).not.toBe(0)
    expect(answer.untouched).toBe(true)
    expect(answer.output).not.toContain(SECRET)
  })

  it('refuses a cross-reference to a hidden paragraph', async () => {
    const answer = await apply(
      literal,
      { op: 'insertField', target: { blockIndexes: [4] }, type: 'REF', args: 'Secret \\h' },
      'zzzz',
    )
    expect(answer.code).not.toBe(0)
    expect(answer.untouched).toBe(true)
    expect(answer.output).not.toContain(SECRET)
  })
})

describe('docs apply: the plain words beside a hidden run are still anchors', () => {
  it.each([
    ['insertField afterText', 'Call '],
    ['insert_footnote afterText', 'Call '],
    ['add_comment text', 'Call'],
    ['findReplace', 'now'],
  ])('%s', async (name, anchor) => {
    const answer = await apply(false, OPS[name]!(anchor), anchor)
    expect(answer.code).toBe(0)
    expect(answer.untouched).toBe(false)
  })
})

describe('mcp: docs_apply answers an anchor on hidden words as a missing phrase', () => {
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

  const call = async (literal: boolean, op: unknown, anchor: string) => {
    const path = await file(literal, dir)
    const r = await client.callTool({ name: 'docs_apply', arguments: { file: path, ops: [op] } })
    const text = (r.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('\n')
    return {
      isError: r.isError === true,
      text: withoutAnchor(text.replace(path, '<file>'), anchor, true),
    }
  }

  it.each([false, true])('for every op and anchor (literal: %s)', async (literal) => {
    const anchors = anchorsFor(literal)
    const miss = anchors['a phrase that is not there']!
    for (const [opName, build] of Object.entries(OPS)) {
      if (literal && opName === 'a target by text') continue
      const reference = await call(literal, build(miss), miss)
      for (const [what, anchor] of Object.entries(anchors)) {
        const answer = await call(literal, build(anchor), anchor)
        expect(answer, `${opName} on ${what}`).toEqual(reference)
        expect(answer.text).not.toContain(SECRET)
      }
    }
  })
})
