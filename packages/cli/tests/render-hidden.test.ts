import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { redactExtXml } from '../../pptx-engine/src/redaction-xml'
import { buildDocx } from '../../docx-engine/tests/helpers/build-docx'
import {
  mutatedStoriesDocx,
  TAG_MUTATION_NAMES as DOCX_MUTATIONS,
} from '../../docx-engine/tests/helpers/hidden-stories'
import {
  mutatedHiddenDeck,
  SECRET,
  TAG_MUTATION_NAMES as DECK_MUTATIONS,
  type TagMutation,
} from '../../pptx-engine/tests/helpers/hidden-deck'
import { defaultRegistry } from '../src/cli'
import { createContext, disposeContext, type McpContext } from '../src/mcp/run'
import { createMcpServer } from '../src/mcp/server'
import { xlsxSidecarPath } from '../src/resources'
import {
  hiddenDocx,
  hiddenStoriesDocx,
  hiddenXlsx,
  MARK_SPELLINGS,
  NAMESPACES,
} from './hidden-text-fixtures'
import { run, tempDir } from './helpers'

/**
 * What `render` hands the agent is a picture of the page, and the renderer draws the words a
 * person hid from AI. A document that holds any is not rendered; the check runs before the
 * app is started, so no app is needed to see it answer.
 */

/** the app is never reached: a render that gets past the check fails here, and says so */
const NO_APP = { env: { ...process.env, SEUOFFICE_APP_BIN: '/nonexistent/seuoffice' } }

const REFUSAL = 'hidden from AI'

async function render(file: string, ...extra: string[]) {
  const r = await run(['render', file, '--out', join(tempDir(), 'png'), '--json', ...extra], NO_APP)
  expect(r.stdout + r.stderr).not.toContain(SECRET)
  return r
}

const refused = (r: { code: number; stdout: string }) =>
  r.code !== 0 && JSON.parse(r.stdout).message.includes(REFUSAL)

describe('render of a deck holding hidden text, a hidden picture', () => {
  it.each(['none', ...DECK_MUTATIONS] as TagMutation[])(
    'is refused: tags rewritten %s',
    async (mutation) => {
      const file = await mutatedHiddenDeck(tempDir(), mutation)
      expect(refused(await render(file))).toBe(true)
      expect(refused(await render(file, '--page', '1'))).toBe(true)
    },
  )

  it('is refused for a hidden picture alone', async () => {
    const file = await mutatedHiddenDeck(tempDir(), 'none', 'pic.pptx', ['P'])
    expect(refused(await render(file))).toBe(true)
  })

  it.each(['K', 'A'] as const)(
    'is refused for a chart whose %s text run is hidden, nothing else on the slide is',
    async (tag) => {
      const file = await mutatedHiddenDeck(tempDir(), 'none', 'chart.pptx', [tag])
      expect(refused(await render(file))).toBe(true)
      expect(refused(await render(file, '--page', '1'))).toBe(true)
    },
  )

  it.each([
    ['SmartArt data', 'diagramData', 'ppt/diagrams/data1.xml'],
    ['SmartArt drawing', 'diagramDrawing', 'ppt/diagrams/drawing1.xml'],
    ['a chart overlay drawing', 'chartDrawing', 'ppt/drawings/drawing1.xml'],
  ])('is refused for a run hidden in %s', async (_what, kind, part) => {
    const dir = tempDir()
    const file = await mutatedHiddenDeck(dir, 'none', 'related.pptx', [])
    const zip = await JSZip.loadAsync(readFileSync(file))
    const RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    const marked = `<a:r><a:rPr>${redactExtXml('client phone')}</a:rPr><a:t>${SECRET}</a:t></a:r>`
    zip.file(
      part,
      `<root xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p>${marked}</a:p></root>`,
    )
    const relsPath =
      kind === 'chartDrawing'
        ? 'ppt/charts/_rels/chart2.xml.rels'
        : 'ppt/slides/_rels/slide1.xml.rels'
    const rels = zip.file(relsPath)
    const entry = `<Relationship Id="rId99" Type="${RELS}/${kind === 'chartDrawing' ? 'chartUserShapes' : kind}" Target="${kind === 'chartDrawing' ? '../drawings/drawing1.xml' : `../diagrams/${part.split('/').pop()}`}"/>`
    const before = rels
      ? await rels.async('string')
      : '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
    zip.file(relsPath, before.replace('</Relationships>', `${entry}</Relationships>`))
    writeFileSync(file, await zip.generateAsync({ type: 'uint8array' }))
    expect(refused(await render(file))).toBe(true)
  })

  it('is not refused for the plain chart alone', async () => {
    const file = await mutatedHiddenDeck(tempDir(), 'none', 'plain-chart.pptx', [])
    expect(refused(await render(file))).toBe(false)
  })

  it('is not refused for a deck that holds none', async () => {
    const file = await mutatedHiddenDeck(tempDir(), 'none', 'plain.pptx', [])
    expect(refused(await render(file))).toBe(false)
  })

  it('only the slides asked for are looked at', async () => {
    const dir = tempDir()
    const file = await mutatedHiddenDeck(dir, 'none', 'two.pptx')
    const ops = join(dir, 'ops.json')
    writeFileSync(ops, JSON.stringify([{ op: 'addBlankSlide', target: { slide: 0 } }]))
    expect((await run(['slides', 'apply', file, '--ops', ops, '--json'])).code).toBe(0)
    expect(refused(await render(file, '--page', '1'))).toBe(true)
    expect(refused(await render(file, '--page', '2'))).toBe(false)
    expect(refused(await render(file))).toBe(true)
  })

  it('slides render is refused as well', async () => {
    const file = await mutatedHiddenDeck(tempDir(), 'none')
    const r = await run(
      ['slides', 'render', file, '--out', join(tempDir(), 'png'), '--json'],
      NO_APP,
    )
    expect(refused(r)).toBe(true)
  })
})

describe('render of a document holding hidden text', () => {
  it.each(MARK_SPELLINGS)('is refused: a Word mark spelled %s', async (spelling) => {
    for (const [, ns] of NAMESPACES) {
      const file = await hiddenStoriesDocx(tempDir(), ns, 'stories.docx', spelling)
      expect(refused(await render(file))).toBe(true)
    }
  })

  it.each(NAMESPACES)('is refused: a hidden span under %s', async (_name, ns) => {
    expect(refused(await render(await hiddenDocx(tempDir(), ns)))).toBe(true)
  })

  it.each(DOCX_MUTATIONS)('is refused: tags rewritten %s', async (mutation) => {
    expect(refused(await render(await mutatedStoriesDocx(tempDir(), mutation)))).toBe(true)
  })

  it('is not refused when it holds none', async () => {
    const file = join(tempDir(), 'plain.docx')
    writeFileSync(file, await buildDocx({ bodyXml: '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>' }))
    expect(refused(await render(file))).toBe(false)
  })
})

describe.skipIf(!xlsxSidecarPath())('render of a workbook holding a hidden cell', () => {
  it('is refused', async () => {
    expect(refused(await render(await hiddenXlsx(tempDir())))).toBe(true)
  })
})

describe('mcp: the render tools', () => {
  let ctx: McpContext
  let client: Client
  const dir = tempDir()

  beforeAll(async () => {
    ctx = createContext({
      cwd: dir,
      env: {
        ...process.env,
        SEUOFFICE_AUDIT_LOG: 'off',
        SEUOFFICE_APP_BIN: '/nonexistent/seuoffice',
      },
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

  it.each(['render', 'slides_render'])(
    '%s hands over no picture of a deck with hidden text',
    async (tool) => {
      const file = await mutatedHiddenDeck(dir, 'none', `${tool}.pptx`)
      const result = await client.callTool({
        name: tool,
        arguments: { file, out: join(dir, `out-${tool}`) },
      })
      const content = result.content as { type: string; text?: string }[]
      expect(content.some((c) => c.type === 'image')).toBe(false)
      expect(result.isError).toBe(true)
      const text = content.map((c) => c.text ?? '').join('\n')
      expect(text).toContain(REFUSAL)
      expect(text).not.toContain(SECRET)
    },
  )
})
