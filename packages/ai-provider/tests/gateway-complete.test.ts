import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentToolCall } from '@seuoffice/agent-core'
import {
  AiRunError,
  GATEWAY_TOKEN_ENV,
  chatForProvider,
  normalizeAiSettings,
  sanitizeAiSettings,
  sealAiSecrets,
  selectAiProvider,
  setGatewayTokenProvider,
  streamForProvider,
  type AiProviderConfig,
  type AiTokenUsage,
} from '../src'
import { setAiTransientRetryDelays } from '../src/fetch'

/**
 * A local gateway speaking `gateway-complete` (seuoffice decision 0009): it
 * records what arrived and answers with chat-completions SSE, or a JSON body
 * when the request is not streamed.
 */
interface Seen {
  url: string
  authorization: string | undefined
  body: Record<string, unknown>
}

let server: Server
let gatewayUrl = ''
const seen: Seen[] = []
let reply: 'ok' | 'unauthorized' = 'ok'

async function readBody(req: IncomingMessage): Promise<string> {
  let text = ''
  for await (const chunk of req) text += (chunk as Buffer).toString('utf8')
  return text
}

const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`

beforeAll(async () => {
  setAiTransientRetryDelays([])
  server = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>
    seen.push({ url: req.url ?? '', authorization: req.headers.authorization, body })
    if (reply === 'unauthorized') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ error: { message: 'token rejected', type: 'auth', code: 'bad_token' } }),
      )
      return
    }
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse({ choices: [{ index: 0, delta: { content: 'Hel' } }] }))
    res.write(sse({ choices: [{ index: 0, delta: { content: 'lo' } }] }))
    res.write(
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'insert_content', arguments: '{"html":"<p>' },
                },
              ],
            },
          },
        ],
      }),
    )
    res.write(
      sse({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'hi</p>"}' } }] } },
        ],
      }),
    )
    res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
    res.write(sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } }))
    res.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(async () => {
  setAiTransientRetryDelays(null)
  server.close()
  await once(server, 'close')
})

let dir = ''

afterEach(() => {
  seen.length = 0
  reply = 'ok'
  setGatewayTokenProvider(null)
  delete process.env[GATEWAY_TOKEN_ENV]
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

/**
 * Saves gateway settings the way the app does (renderer payload through the
 * IPC guard, sealed, written as JSON) and reads them back the way it does.
 * The renderer payload carries a key on purpose: a gateway must not keep one.
 */
function saveAndLoadSettings(plantedKey: string) {
  dir = mkdtempSync(join(tmpdir(), 'gateway-settings-'))
  const file = join(dir, 'ai-settings.json')
  const sent = sanitizeAiSettings({
    provider: 'gateway',
    providers: { gateway: { apiKey: plantedKey, model: '', baseUrl: gatewayUrl } },
  })
  if (!sent) throw new Error('settings were refused')
  writeFileSync(file, JSON.stringify(sealAiSecrets(sent)))
  const settings = normalizeAiSettings(JSON.parse(readFileSync(file, 'utf8')))
  return { file, settings }
}

async function streamTurn(config: AiProviderConfig) {
  const deltas: string[] = []
  const calls: AgentToolCall[] = []
  const usage: AiTokenUsage[] = []
  await streamForProvider(
    'gateway',
    config,
    'You edit documents.',
    [{ role: 'user', text: 'Say hello and insert a paragraph' }],
    [
      {
        name: 'insert_content',
        description: 'Insert HTML',
        inputSchema: { type: 'object', properties: { html: { type: 'string' } } },
      },
    ],
    1000,
    {
      signal: new AbortController().signal,
      onDelta: (text) => deltas.push(text),
      onToolCall: (call) => calls.push(call),
      onUsage: (u) => usage.push(u),
    },
  )
  return { text: deltas.join(''), calls, usage }
}

describe('gateway-complete', () => {
  it('streams text and a tool call with the request token as a bearer header, never stored', async () => {
    const { file, settings } = saveAndLoadSettings('planted-key')
    const choice = selectAiProvider(settings, {})
    expect(choice).toEqual({ connected: true, provider: 'gateway', metered: false })
    const tokens = ['tok-first', 'tok-second']
    let asked = 0
    setGatewayTokenProvider(() => tokens[asked++]!)

    const first = await streamTurn(settings.providers.gateway)
    await streamTurn(settings.providers.gateway)

    expect(first.text).toBe('Hello')
    expect(first.calls).toHaveLength(1)
    expect(first.calls[0]).toMatchObject({ name: 'insert_content', input: { html: '<p>hi</p>' } })
    expect(first.usage[0]).toMatchObject({ inputTokens: 12, outputTokens: 5 })
    // asked once per request, and each request carries its own token
    expect(seen.map((s) => s.authorization)).toEqual(['Bearer tok-first', 'Bearer tok-second'])
    expect(seen[0]!.url).toBe('/v1/chat/completions')
    expect(seen[0]!.body).toMatchObject({
      model: '',
      stream: true,
      messages: [
        { role: 'system', content: 'You edit documents.' },
        { role: 'user', content: 'Say hello and insert a paragraph' },
      ],
      tools: [{ type: 'function', function: { name: 'insert_content' } }],
    })
    const stored = readFileSync(file, 'utf8')
    for (const secret of ['tok-first', 'tok-second', 'planted-key']) {
      expect(stored).not.toContain(secret)
    }
    expect(JSON.parse(stored).providers.gateway).toMatchObject({ apiKey: '', baseUrl: gatewayUrl })
  })

  it('a key written into the settings file by hand is neither loaded nor sent', async () => {
    const settings = normalizeAiSettings({
      provider: 'gateway',
      providers: { gateway: { apiKey: 'hand-written', model: 'any', baseUrl: gatewayUrl } },
    })
    expect(settings.providers.gateway.apiKey).toBe('')
    setGatewayTokenProvider(async () => 'tok-request')
    await streamTurn({ ...settings.providers.gateway, apiKey: 'hand-written' })
    expect(seen[0]!.authorization).toBe('Bearer tok-request')
  })

  it('without a token the turn stops as not-connected before anything is sent', async () => {
    const { settings } = saveAndLoadSettings('')
    setGatewayTokenProvider(() => '  ')
    const run = streamTurn(settings.providers.gateway)
    await expect(run).rejects.toBeInstanceOf(AiRunError)
    await expect(run).rejects.toMatchObject({ kind: 'not-connected' })
    expect(seen).toHaveLength(0)
  })

  it('reads the environment variable per request when no provider is registered', async () => {
    const { settings } = saveAndLoadSettings('')
    process.env[GATEWAY_TOKEN_ENV] = 'tok-env'
    await streamTurn(settings.providers.gateway)
    expect(seen[0]!.authorization).toBe('Bearer tok-env')
  })

  it('a rejected token fails the turn with the gateway status, without echoing the token', async () => {
    const { settings } = saveAndLoadSettings('')
    reply = 'unauthorized'
    setGatewayTokenProvider(() => 'tok-secret')
    const failure = await streamTurn(settings.providers.gateway).then(
      () => null,
      (e: unknown) => e,
    )
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/^HTTP 401/)
    expect((failure as Error).message).not.toContain('tok-secret')
  })

  it('answers a one-shot chat through the same token path', async () => {
    const { settings } = saveAndLoadSettings('')
    setGatewayTokenProvider(() => 'tok-chat')
    const result = await chatForProvider('gateway', settings.providers.gateway, 'sys', 'ping')
    expect(result).toEqual({ ok: true, content: 'pong' })
    expect(seen[0]!.authorization).toBe('Bearer tok-chat')
    expect(seen[0]!.body.stream).toBeUndefined()
  })

  it('a gateway with no URL is not configured and a one-shot call fails without a request', async () => {
    const settings = normalizeAiSettings({ provider: 'gateway', providers: { gateway: {} } })
    expect(selectAiProvider(settings, {})).toMatchObject({
      connected: false,
      reason: 'not-configured',
    })
    setGatewayTokenProvider(() => 'tok')
    const result = await chatForProvider('gateway', settings.providers.gateway, 'sys', 'ping')
    expect(result.ok).toBe(false)
    expect(seen).toHaveLength(0)
  })
})
