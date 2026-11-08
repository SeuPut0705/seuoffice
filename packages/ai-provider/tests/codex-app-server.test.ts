import { describe, expect, it } from 'vitest'
import type { AgentToolDef } from '@genoffice/agent-core'
import { PRODUCT_NAME, UPSTREAM_PRODUCT_NAME } from '@genoffice/i18n'
import { MAX_STREAM_TOOL_CALLS, MAX_TOOL_JSON_CHARS } from '../src/protocols/shared'
import {
  activePermissionProfileId,
  buildCodexAppServerPrompt,
  codexAppServerLaunchArgs,
  codexAppServerOutputSchema,
  codexThreadStartParams,
  parseCodexAppServerTurn,
  waitForTurn,
  type CodexTurnTransport,
  type RpcMessage,
} from '../src/codex-app-server'

function fakeTransport(script: RpcMessage[]): CodexTurnTransport {
  let listener: ((message: RpcMessage) => void) | undefined
  return {
    request: async (method) => {
      if (method === 'turn/start') {
        queueMicrotask(() => script.forEach((message) => listener?.(message)))
        return { turn: { id: 't1' } }
      }
      return {}
    },
    onNotification: (next) => {
      listener = next
      return () => {
        listener = undefined
      }
    },
  }
}

const noopCallbacks = {
  signal: new AbortController().signal,
  onDelta: () => undefined,
  onToolCall: () => undefined,
}

const tools: AgentToolDef[] = [
  {
    name: 'replace_text',
    description: 'Replace document text',
    inputSchema: {
      type: 'object',
      properties: { before: { type: 'string' }, after: { type: 'string' } },
      required: ['before', 'after'],
    },
  },
]

describe('Codex app-server bridge', () => {
  it('starts the official stdio app-server instead of assuming an HTTP endpoint', () => {
    const args = codexAppServerLaunchArgs()
    expect(args[0]).toBe('app-server')
    expect(args.slice(-2)).toEqual(['--listen', 'stdio://'])
    // everything in between is a config override: `-c key=value` pairs
    const between = args.slice(1, -2)
    expect(between.length % 2).toBe(0)
    between.forEach((arg, index) => {
      if (index % 2 === 0) expect(arg).toBe('-c')
      else expect(arg).toMatch(/^[a-z_.]+=/)
    })
  })

  it('confines Codex tool reads to the temp dir through a permission profile', () => {
    const config = { apiKey: '', model: 'gpt-5.6-terra' }
    const params = codexThreadStartParams(config, '/tmp/genoffice-codex-x', 'profile')
    expect(params).not.toHaveProperty('sandbox')
    expect(params.approvalPolicy).toBe('never')
    expect(params.config).toEqual({
      default_permissions: 'genoffice',
      permissions: {
        genoffice: {
          filesystem: { ':minimal': 'read', '/tmp/genoffice-codex-x': 'read' },
        },
      },
    })
    expect(codexThreadStartParams(config, '/tmp/genoffice-codex-x', 'read-only')).toMatchObject({
      sandbox: 'read-only',
    })
    expect(activePermissionProfileId({ activePermissionProfile: { id: 'genoffice' } })).toBe(
      'genoffice',
    )
    expect(activePermissionProfileId({ activePermissionProfile: null })).toBeUndefined()
  })

  it('builds a strict one-turn output schema with only known tool names', () => {
    const schema = codexAppServerOutputSchema(tools) as {
      properties: { toolCalls: { items: { properties: { name: { enum: string[] } } } } }
    }
    expect(schema.properties.toolCalls.items.properties.name.enum).toEqual(['replace_text'])
    expect(codexAppServerOutputSchema([])).toMatchObject({
      properties: { toolCalls: { maxItems: 0 } },
    })
  })

  it('serializes new conversation events, tool results and schemas', () => {
    const prompt = buildCodexAppServerPrompt(
      'Edit only when requested.',
      [
        { role: 'user', text: 'Change A to B.' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'call-1', name: 'replace_text', input: { before: 'A', after: 'B' } }],
        },
        { role: 'tool', results: [{ id: 'call-1', name: 'replace_text', output: 'done' }] },
      ],
      tools,
      8192,
    )
    expect(prompt).toContain('Edit only when requested.')
    expect(prompt).toContain('replace_text')
    expect(prompt).toContain('"output":"done"')
    expect(prompt).toContain('8192 output tokens')
  })

  // What Codex forwards to OpenAI names this product, never the project it is based on
  it('names the product as the service and in the base instructions of a thread', () => {
    const config = { apiKey: '', model: 'gpt-5.6-terra' }
    for (const mode of ['profile', 'read-only'] as const) {
      const params = codexThreadStartParams(config, '/tmp/codex-x', mode)
      expect(params.serviceName).toBe(PRODUCT_NAME.toLowerCase())
      expect(params.serviceName).toMatch(/^[a-z0-9]+$/)
      const instructions = String(params.baseInstructions)
      expect(instructions).toContain(`embedded in ${PRODUCT_NAME}.`)
      expect(instructions).toContain(`${PRODUCT_NAME} itself executes document tools`)
      for (const sent of [String(params.serviceName), instructions]) {
        expect(sent.toLowerCase()).not.toContain(UPSTREAM_PRODUCT_NAME.toLowerCase())
      }
    }
  })

  it('names the product in the turn prompt and wraps the payload in its own tag', () => {
    const prompt = buildCodexAppServerPrompt(
      'Edit only when requested.',
      [{ role: 'user', text: 'Change A to B.' }],
      tools,
      8192,
    )
    expect(prompt).toContain(`the new ${PRODUCT_NAME} conversation events`)
    expect(prompt).toContain(`${PRODUCT_NAME} will execute only the tool calls`)
    expect(prompt).toContain(`requested ${PRODUCT_NAME} tool calls`)
    const tag = `${PRODUCT_NAME.toLowerCase()}_payload`
    const lines = prompt.split('\n')
    expect(lines.at(-3)).toBe(`<${tag}>`)
    expect(JSON.parse(lines.at(-2)!)).toMatchObject({ system: 'Edit only when requested.' })
    expect(lines.at(-1)).toBe(`</${tag}>`)
    expect(prompt.toLowerCase()).not.toContain(UPSTREAM_PRODUCT_NAME.toLowerCase())
  })

  it('parses text and JSON-encoded GenOffice tool arguments', () => {
    expect(
      parseCodexAppServerTurn(
        JSON.stringify({
          text: 'I will make that change.',
          toolCalls: [
            {
              id: 'call-1',
              name: 'replace_text',
              inputJson: JSON.stringify({ before: 'A', after: 'B' }),
            },
          ],
        }),
        tools,
      ),
    ).toEqual({
      text: 'I will make that change.',
      toolCalls: [{ id: 'call-1', name: 'replace_text', input: { before: 'A', after: 'B' } }],
    })
  })

  it('rejects unknown tools and empty final turns', () => {
    expect(() =>
      parseCodexAppServerTurn(
        JSON.stringify({ text: '', toolCalls: [{ id: 'x', name: 'shell', inputJson: '{}' }] }),
        tools,
      ),
    ).toThrow('unknown tool')
    expect(() =>
      parseCodexAppServerTurn(JSON.stringify({ text: '', toolCalls: [] }), tools),
    ).toThrow('no content')
  })

  it('rejects a turn over the per-turn tool call and argument budgets', () => {
    const call = (i: number) => ({ id: `c${i}`, name: 'replace_text', inputJson: '{"a":1}' })
    expect(() =>
      parseCodexAppServerTurn(
        JSON.stringify({
          text: 'working on it',
          toolCalls: Array.from({ length: MAX_STREAM_TOOL_CALLS + 1 }, (_, i) => call(i)),
        }),
        tools,
      ),
    ).toThrow(/Too many streamed tool calls/)
    expect(() =>
      parseCodexAppServerTurn(
        JSON.stringify({
          text: 'working on it',
          toolCalls: [
            {
              id: 'c1',
              name: 'replace_text',
              inputJson: `"${'a'.repeat(MAX_TOOL_JSON_CHARS + 1)}"`,
            },
          ],
        }),
        tools,
      ),
    ).toThrow(/Tool call arguments exceeded the codex-app-server buffer limit/)
  })

  it('keeps waiting through transient stream errors Codex retries itself', async () => {
    const transport = fakeTransport([
      {
        method: 'error',
        params: {
          threadId: 'th',
          turnId: 't1',
          willRetry: true,
          error: { message: 'Reconnecting... 2/5' },
        },
      },
      {
        method: 'item/completed',
        params: { threadId: 'th', turnId: 't1', item: { type: 'agentMessage', text: 'done' } },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'th', turnId: 't1', turn: { id: 't1', status: 'completed' } },
      },
    ])
    await expect(
      waitForTurn(
        transport,
        'th',
        () => transport.request('turn/start', {}),
        noopCallbacks.signal,
        noopCallbacks,
      ),
    ).resolves.toBe('done')
  })

  it('interrupts the server turn when the abort lands before the turn id is known (genoffice#1110)', async () => {
    const calls: { method: string; params: unknown }[] = []
    let releaseStart: (() => void) | undefined
    const transport: CodexTurnTransport = {
      request: async (method, params) => {
        calls.push({ method, params })
        if (method === 'turn/start') {
          await new Promise<void>((r) => (releaseStart = r))
          return { turn: { id: 't1' } }
        }
        return {}
      },
      onNotification: () => () => undefined,
    }
    const controller = new AbortController()
    const pending = waitForTurn(
      transport,
      'th',
      () => transport.request('turn/start', {}),
      controller.signal,
      { ...noopCallbacks, signal: controller.signal },
    )
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(calls.map((c) => c.method)).toEqual(['turn/start'])
    releaseStart?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.map((c) => c.method)).toEqual(['turn/start', 'turn/interrupt'])
    expect(calls[1]!.params).toEqual({ threadId: 'th', turnId: 't1' })
  })

  it('fails the turn that ends failed after a non-retried error notification', async () => {
    const transport = fakeTransport([
      {
        method: 'error',
        params: { threadId: 'th', turnId: 't1', willRetry: false, error: { message: 'boom' } },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'th',
          turnId: 't1',
          turn: { id: 't1', status: 'failed', error: { message: 'boom' } },
        },
      },
    ])
    await expect(
      waitForTurn(
        transport,
        'th',
        () => transport.request('turn/start', {}),
        noopCallbacks.signal,
        noopCallbacks,
      ),
    ).rejects.toThrow('boom')
  })
})
