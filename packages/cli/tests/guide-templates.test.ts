import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PRODUCT_NAME } from '@genoffice/i18n'
import { listSlideTemplates, stylePalette } from '@genoffice/pipelines/slides'
import { defaultRegistry } from '../src/cli'
import { loadCatalog } from '../src/commands/guide'
import { createContext, disposeContext, type McpContext } from '../src/mcp/run'
import { createMcpServer } from '../src/mcp/server'
import { buildArgv, resolveTools } from '../src/mcp/tools'
import { run, tempDir } from './helpers'

const templates = listSlideTemplates()
const registry = defaultRegistry()

function fontNames(t: (typeof templates)[number]): string[] {
  return [t.fonts.title, t.fonts.latinTitle, t.fonts.body].filter((f): f is string => !!f)
}

describe('guide slides templates', () => {
  it('lists every template on one line with id, name, scheme, description and fonts, in order', async () => {
    const r = await run(['guide', 'slides', 'templates'])
    expect(r.code).toBe(0)
    const lines = r.stdout.split('\n')
    let last = -1
    for (const t of templates) {
      const at = lines.findIndex((l) => l.startsWith(`${t.id} `))
      expect(at, `no line for ${t.id}`).toBeGreaterThan(last)
      last = at
      const line = lines[at]!
      for (const field of [t.name, t.scheme, t.description, ...fontNames(t)]) {
        expect(line, `${t.id} line lacks ${field}`).toContain(field)
      }
    }
    expect(lines.filter((l) => templates.some((t) => l.startsWith(`${t.id} `)))).toHaveLength(
      templates.length,
    )
    expect(r.stdout).not.toContain('GenOffice')
  })

  it('returns the list as detail.templates with the documented keys in order', async () => {
    const r = await run(['guide', 'slides', 'templates', '--json'])
    expect(r.code).toBe(0)
    const list = r.json().detail.templates as Record<string, unknown>[]
    expect(list).toEqual(
      templates.map(({ id, name, scheme, description, fonts }) => ({
        id,
        name,
        scheme,
        description,
        fonts,
      })),
    )
    for (const entry of list) {
      expect(Object.keys(entry)).toEqual(['id', 'name', 'scheme', 'description', 'fonts'])
    }
  })

  it('prints one template as a style sheet to save as style.md, plus the fonts line', async () => {
    const t = templates[0]!
    const r = await run(['guide', 'slides', 'templates', t.id])
    expect(r.code).toBe(0)
    expect(r.stdout.startsWith(t.styleSheet)).toBe(true)
    const extra = r.stdout.slice(t.styleSheet.length).trim()
    expect(extra.split('\n')).toHaveLength(1)
    expect(extra).toContain(PRODUCT_NAME)
    for (const font of fontNames(t)) expect(extra).toContain(font)
    expect(r.stdout).not.toContain('GenOffice')
    // saved as is, the file names exactly the template's colors
    expect([...stylePalette(r.stdout)].sort()).toEqual([...stylePalette(t.styleSheet)].sort())

    const byName = await run(['guide', 'slides', 'templates', t.name.toUpperCase()])
    expect(byName.stdout).toBe(r.stdout)

    const json = await run(['guide', 'slides', 'templates', t.id, '--json'])
    const detail = json.json().detail
    expect(Object.keys(detail)).toEqual([
      'id',
      'name',
      'scheme',
      'description',
      'fonts',
      'styleSheet',
    ])
    expect(detail).toEqual({
      id: t.id,
      name: t.name,
      scheme: t.scheme,
      description: t.description,
      fonts: t.fonts,
      styleSheet: t.styleSheet,
    })
  })

  it('refuses an unknown id with the usable ids and a suggestion for a near miss', async () => {
    const t = templates[0]!
    const typo = await run(['guide', 'slides', 'templates', `${t.id}x`, '--json'])
    expect(typo.code).toBe(1)
    const err = typo.json()
    expect(err).toMatchObject({ status: 'error', code: 1, error: 'invalid_argument' })
    expect(err.detail.templates).toEqual(templates.map((x) => x.id))
    expect(err.suggestion).toContain(t.id)
    expect(err.suggestion).toContain('did you mean')

    const far = await run(['guide', 'slides', 'templates', 'qqqqqqqqqqqq', '--json'])
    expect(far.code).toBe(1)
    expect(far.json().error).toBe('invalid_argument')
    expect(far.json().suggestion ?? '').not.toContain('did you mean')
  })

  it('leaves the op catalog fingerprints alone', async () => {
    const all = (await run(['guide', '--fingerprint', '--json'])).json().detail.fingerprints
    for (const d of ['slides', 'docs', 'sheets'] as const) {
      expect(all[d]).toBe((await loadCatalog(d)).fingerprint)
    }
    const slides = await run(['guide', 'slides', 'templates', '--fingerprint'])
    expect(slides.stdout).toBe(`slides ${all.slides}`)
  })

  it('shows the templates form in the guide help', async () => {
    const r = await run(['help', 'guide'])
    expect(r.stdout).toContain('guide slides templates [<id>]')
  })
})

describe('guide slides templates over MCP', () => {
  let ctx: McpContext
  let client: Client

  beforeAll(async () => {
    ctx = createContext({
      cwd: tempDir(),
      env: { ...process.env, GENOFFICE_AUDIT_LOG: 'off' },
      log: () => {},
    })
    const server = await createMcpServer(ctx, { registry, compactSchemas: true })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
  }, 120000)

  afterAll(async () => {
    await client?.close()
    if (ctx) disposeContext(ctx)
  })

  const text = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: 'guide', arguments: args })
    expect(r.isError).not.toBe(true)
    return (r.content as { type: string; text?: string }[]).find((c) => c.type === 'text')!.text!
  }

  it('takes the template id as a third positional', async () => {
    const guide = resolveTools(registry).find((t) => t.name === 'guide')!
    expect(guide.positionals?.map((p) => p.key)).toEqual(['domain', 'topic', 'name'])
    expect(buildArgv(guide, { domain: 'slides', topic: 'templates', name: 'coral' }).argv).toEqual([
      'guide',
      'slides',
      'templates',
      'coral',
    ])
    const { tools } = await client.listTools()
    const props = tools.find((t) => t.name === 'guide')!.inputSchema.properties ?? {}
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['domain', 'topic', 'name']))
  })

  it('returns the list and one template as plain text', async () => {
    const list = await text({ domain: 'slides', topic: 'templates' })
    for (const t of templates) expect(list).toContain(`${t.id} `)
    const t = templates[1]!
    const one = await text({ domain: 'slides', topic: 'templates', name: t.id })
    expect(one.startsWith(t.styleSheet)).toBe(true)
  })

  it('serves the list and every template as resources', async () => {
    const { resources } = await client.listResources()
    const uris = resources.map((r) => r.uri)
    expect(uris).toContain('ieumoffice://guide/slides/templates')
    for (const t of templates) expect(uris).toContain(`ieumoffice://guide/slides/templates/${t.id}`)
    const t = templates[2]!
    const read = await client.readResource({ uri: `ieumoffice://guide/slides/templates/${t.id}` })
    const body = (read.contents[0] as { text: string }).text
    expect(body.startsWith(t.styleSheet)).toBe(true)
    const listed = await client.readResource({ uri: 'ieumoffice://guide/slides/templates' })
    expect((listed.contents[0] as { text: string }).text).toContain(`${t.id} `)
  })
})
