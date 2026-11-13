import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import {
  hiddenPictureBase64,
  mutatedStoriesDocx,
  PICTURE_STORIES,
  PLACEHOLDER,
  SECRET,
  TAG_MUTATION_NAMES as DOCX_MUTATIONS,
} from '../../docx-engine/tests/helpers/hidden-stories'
import { mutatedHiddenDeck } from '../../pptx-engine/tests/helpers/hidden-deck'
import { defaultRegistry } from '../src/cli'
import { createContext, disposeContext, type McpContext } from '../src/mcp/run'
import { createMcpServer } from '../src/mcp/server'
import { xlsxSidecarPath } from '../src/resources'
import { hiddenDocx, hiddenXlsx, NAMESPACES } from './hidden-text-fixtures'
import { run, tempDir } from './helpers'

/**
 * Every route that writes a new file from a document holding text a person hid from AI.
 * A text-like target gets the placeholder in place of the words; any other target is
 * refused, and the refusal is made by the command line before the SeuOffice app is
 * started, so none of these tests needs the app. The app is pointed at a program that
 * does not exist: a route that gets past the check fails with "app not found" instead.
 *
 * | source | target             | answer                          |
 * | ------ | ------------------ | ------------------------------- |
 * | docx   | md, html           | placeholders (the AI reader's view) |
 * | docx   | pdf, odt, hwp, hwpx| refused                         |
 * | pptx   | pdf                | refused                         |
 * | xlsx   | csv                | placeholders                    |
 * | xlsx   | ods, pdf           | refused                         |
 * | any    | create --type pdf  | refused                         |
 */

const NO_APP = { env: { ...process.env, SEUOFFICE_APP_BIN: '/nonexistent/seuoffice' } }
const REFUSAL = 'hidden from AI'

const messageOf = (stdout: string): string => {
  try {
    return JSON.parse(stdout).message ?? ''
  } catch {
    return ''
  }
}

const refused = (r: { code: number; stdout: string }) =>
  r.code !== 0 && messageOf(r.stdout).includes(REFUSAL)

async function convert(file: string, to: string) {
  const out = join(tempDir(), `out.${to}`)
  const r = await run(['convert', file, '--to', to, '--out', out, '--json'], NO_APP)
  expect(r.stdout + r.stderr, `${to}: the answer`).not.toContain(SECRET)
  return { ...r, out }
}

/** a refusal leaves no file behind */
async function expectRefused(file: string, to: string) {
  const r = await convert(file, to)
  expect(refused(r), `${to}: ${r.stdout}`).toBe(true)
  expect(existsSync(r.out)).toBe(false)
}

async function textOf(file: string, to: string): Promise<string> {
  const r = await convert(file, to)
  expect(r.code, r.stdout).toBe(0)
  return readFileSync(r.out, 'utf-8')
}

describe.each(['md', 'html'])('docx to %s: placeholders for the hidden words', (to) => {
  it.each(DOCX_MUTATIONS)('tags rewritten: %s', async (mutation) => {
    const file = await mutatedStoriesDocx(tempDir(), mutation, { pictures: true })
    const r = await convert(file, to)
    // a file the readers refuse is a safe answer; the words never come out
    if (r.code !== 0) return
    const text = readFileSync(r.out, 'utf-8')
    expect(text).not.toContain(SECRET)
    for (const story of PICTURE_STORIES) {
      expect(text).not.toContain(hiddenPictureBase64(story).slice(30, 70))
    }
  })

  it.each(NAMESPACES)('a hidden span under %s', async (_name, ns) => {
    const text = await textOf(await hiddenDocx(tempDir(), ns), to)
    expect(text).toContain(PLACEHOLDER)
    expect(text).not.toContain(SECRET)
  })
})

describe('docx to a target no placeholder can stand in for', () => {
  it.each(['pdf', 'odt', 'hwp', 'hwpx'])('%s is refused', async (to) => {
    for (const mutation of ['none', ...DOCX_MUTATIONS] as const) {
      const file =
        mutation === 'none'
          ? await hiddenDocx(tempDir(), NAMESPACES[0]![1])
          : await mutatedStoriesDocx(tempDir(), mutation)
      await expectRefused(file, to)
    }
  })

  it('a document that holds none is converted as ever', async () => {
    const file = join(tempDir(), 'plain.docx')
    writeFileSync(file, await buildDocx({ bodyXml: '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>' }))
    expect((await convert(file, 'odt')).code).toBe(0)
    // the app route is reached (and found missing here)
    const r = await convert(file, 'pdf')
    expect(refused(r)).toBe(false)
    expect(r.code).not.toBe(0)
  })
})

describe('pptx to pdf', () => {
  it.each(['none', 'single quotes', 'comments', 'character references'] as const)(
    'is refused: tags rewritten %s',
    async (mutation) => {
      await expectRefused(await mutatedHiddenDeck(tempDir(), mutation), 'pdf')
    },
  )

  it('is refused for a hidden picture alone', async () => {
    await expectRefused(await mutatedHiddenDeck(tempDir(), 'none', 'pic.pptx', ['P']), 'pdf')
  })

  it('a deck that holds none is not refused', async () => {
    const file = await mutatedHiddenDeck(tempDir(), 'none', 'plain.pptx', [])
    expect(refused(await convert(file, 'pdf'))).toBe(false)
  })
})

describe.skipIf(!xlsxSidecarPath())('xlsx with a hidden cell', () => {
  it('csv gives the placeholder', async () => {
    const text = await textOf(await hiddenXlsx(tempDir()), 'csv')
    expect(text).toContain(PLACEHOLDER)
  })

  it.each(['ods', 'pdf'])('%s is refused', async (to) => {
    await expectRefused(await hiddenXlsx(tempDir()), to)
  })
})

describe('create --type pdf --from a document with hidden content', () => {
  it('is refused for a docx and a pptx', async () => {
    for (const file of [
      await hiddenDocx(tempDir(), NAMESPACES[0]![1]),
      await mutatedHiddenDeck(tempDir(), 'none'),
    ]) {
      const out = join(tempDir(), 'out.pdf')
      const r = await run(
        ['create', '--type', 'pdf', '--from', file, '--out', out, '--json'],
        NO_APP,
      )
      expect(refused(r), r.stdout).toBe(true)
      expect(existsSync(out)).toBe(false)
      expect(r.stdout + r.stderr).not.toContain(SECRET)
    }
  })

  it.skipIf(!xlsxSidecarPath())('is refused for an xlsx', async () => {
    const out = join(tempDir(), 'out.pdf')
    const r = await run(
      ['create', '--type', 'pdf', '--from', await hiddenXlsx(tempDir()), '--out', out, '--json'],
      NO_APP,
    )
    expect(refused(r), r.stdout).toBe(true)
  })
})

describe('info', () => {
  const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'

  it('names a heading hidden from AI by its placeholder', async () => {
    const file = join(tempDir(), 'heading.docx')
    writeFileSync(
      file,
      await buildDocx({
        docRootExtraAttrs: `xmlns:mc="${MC}" xmlns:go="${NAMESPACES[0]![1]}" mc:Ignorable="go"`,
        bodyXml:
          '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">Phone </w:t></w:r>' +
          `<w:r><w:rPr><go:redact w:label="client phone"/></w:rPr><w:t>${SECRET}</w:t></w:r></w:p>`,
      }),
    )
    const r = await run(['info', file, '--json'])
    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain(SECRET)
    expect(r.json().detail.headings[0].text).toBe(`Phone ${PLACEHOLDER}`)
  })

  it.skipIf(!xlsxSidecarPath())('lists no hidden cell of a workbook', async () => {
    const r = await run(['info', await hiddenXlsx(tempDir()), '--json'])
    expect(r.stdout).not.toContain(SECRET)
  })

  it.each([['info'], ['slides', 'audit']])('%s lists no hidden word of a deck', async (...argv) => {
    const r = await run([...argv, await mutatedHiddenDeck(tempDir(), 'none'), '--json'])
    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain(SECRET)
  })
})

describe('mcp: convert and create_pdf', () => {
  let ctx: McpContext
  let client: Client
  const dir = tempDir()

  beforeAll(async () => {
    ctx = createContext({
      cwd: dir,
      env: { ...NO_APP.env, SEUOFFICE_AUDIT_LOG: 'off' },
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

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args })
    const text = (r.content as { type: string; text?: string }[])
      .map((c) => c.text ?? '')
      .join('\n')
    expect(text).not.toContain(SECRET)
    return { isError: r.isError === true, text }
  }

  it.each(['pdf', 'odt', 'hwpx'])('convert docx to %s is refused', async (to) => {
    const file = await hiddenDocx(dir, NAMESPACES[0]![1], `mcp-${to}.docx`)
    const out = join(dir, `mcp.${to}`)
    const r = await call('convert', { file, to, out })
    expect(r.isError).toBe(true)
    expect(r.text).toContain(REFUSAL)
    expect(existsSync(out)).toBe(false)
  })

  it('convert docx to md gives the placeholder', async () => {
    const file = await hiddenDocx(dir, NAMESPACES[0]![1], 'mcp-md.docx')
    const out = join(dir, 'mcp.md')
    expect((await call('convert', { file, to: 'md', out })).isError).toBe(false)
    expect(readFileSync(out, 'utf-8')).toContain(PLACEHOLDER)
  })

  it('create_pdf from a deck with hidden text is refused', async () => {
    const from = await mutatedHiddenDeck(dir, 'none', 'mcp-create.pptx')
    const out = join(dir, 'mcp-create.pdf')
    const r = await call('create_pdf', { from, out })
    expect(r.isError).toBe(true)
    expect(r.text).toContain(REFUSAL)
  })
})
