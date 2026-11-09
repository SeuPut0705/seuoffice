import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiStreamChunk, AiStreamRequest } from '../../ai-provider/src/types'
import type * as RelayModule from '../src/ai-relay'
import type * as ChannelModule from '../src/embed-channel'

const HOST = location.origin

let host: Window
let sent: Record<string, unknown>[]
let relay: typeof RelayModule

function fromHost(data: Record<string, unknown>, origin = HOST): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: host,
      origin,
      data: { source: 'seuoffice', version: 1, ...data },
    }),
  )
}

/** Load a fresh page whose host opened a document, offering AI or not */
async function openPage(ai: boolean): Promise<void> {
  // the channel keeps one host per page load, so each test loads fresh copies
  vi.resetModules()
  const channel: typeof ChannelModule = await import('../src/embed-channel')
  relay = await import('../src/ai-relay')
  const opening = channel.receiveOpen()
  fromHost({ type: 'open', fileName: 'memo.docx', bytes: new ArrayBuffer(1), ai })
  await opening
  sent = []
}

const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`

/** A gateway-complete stream: two text deltas, one tool call in two pieces, usage, [DONE] */
const GATEWAY_SSE =
  sse({ choices: [{ index: 0, delta: { content: 'Hel' } }] }) +
  sse({ choices: [{ index: 0, delta: { content: 'lo' } }] }) +
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
  }) +
  sse({
    choices: [
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'hi</p>"}' } }] } },
    ],
  }) +
  sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
  sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } }) +
  'data: [DONE]\n\n'

async function turn(): Promise<{
  chunks: AiStreamChunk[]
  done: Promise<void>
  bridge: RelayModule.AiStreamBridge
}> {
  const bridge = relay.createAiStreamBridge()
  const chunks: AiStreamChunk[] = []
  bridge.onAiStream((chunk) => chunks.push(chunk))
  const request: AiStreamRequest = {
    requestId: 't1',
    settings: await relay.webAiSettings(),
    system: 'You edit documents.',
    messages: [{ role: 'user', text: 'Write hi' }],
    tools: [
      { name: 'insert_content', description: 'Insert HTML', inputSchema: { type: 'object' } },
    ],
  }
  return { chunks, done: bridge.aiStream(request), bridge }
}

async function aiRequest(): Promise<{ requestId: string; body: Record<string, unknown> }> {
  await vi.waitFor(() => expect(sent.some((m) => m.type === 'ai_request')).toBe(true))
  return sent.find((m) => m.type === 'ai_request') as {
    requestId: string
    body: Record<string, unknown>
  }
}

beforeEach(() => {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  host = frame.contentWindow!
  sent = []
  vi.spyOn(host, 'postMessage').mockImplementation((message: unknown) => {
    sent.push(message as Record<string, unknown>)
  })
  Object.defineProperty(window, 'parent', { value: host, configurable: true })
})

afterEach(() => {
  Object.defineProperty(window, 'parent', { value: window, configurable: true })
  document.body.replaceChildren()
})

describe('AI through the embed host', () => {
  it('reports the gateway as the configured provider only when the host offers AI', async () => {
    await openPage(true)
    const offered = await relay.webAiSettings()
    expect(offered.provider).toBe('gateway')
    expect(offered.providers.gateway.baseUrl).toBe(relay.HOST_AI_BASE_URL)
    await openPage(false)
    expect((await relay.webAiSettings()).provider).not.toBe('gateway')
  })

  it('sends the gateway-complete body and parses the relayed bytes into deltas and a tool call', async () => {
    await openPage(true)
    const { chunks, done } = await turn()
    const { requestId, body } = await aiRequest()
    expect(body).toMatchObject({
      model: '',
      stream: true,
      messages: [
        { role: 'system', content: 'You edit documents.' },
        { role: 'user', content: 'Write hi' },
      ],
      tools: [{ type: 'function', function: { name: 'insert_content' } }],
    })
    // the host relays raw bytes; split them where they fall, mid-line included
    const bytes = new TextEncoder().encode(GATEWAY_SSE)
    for (let at = 0; at < bytes.length; at += 37) {
      fromHost({ type: 'ai_chunk', requestId, data: bytes.slice(at, at + 37) })
    }
    fromHost({ type: 'ai_end', requestId })
    await done
    expect(chunks.filter((c) => c.type === 'delta').map((c) => c.text)).toEqual(['Hel', 'lo'])
    expect(chunks.filter((c) => c.type === 'tool-call').map((c) => c.toolCall)).toEqual([
      { id: 'call_1', name: 'insert_content', input: { html: '<p>hi</p>' } },
    ])
    expect(chunks.at(-1)).toEqual(expect.objectContaining({ requestId: 't1', type: 'done' }))
  })

  it('turns a gateway refusal relayed with its status into an error chunk', async () => {
    await openPage(true)
    const { chunks, done } = await turn()
    const { requestId } = await aiRequest()
    fromHost({
      type: 'ai_error',
      requestId,
      status: 401,
      message: '{"error":{"message":"token rejected"}}',
    })
    await done
    const last = chunks.at(-1)!
    expect(last.type).toBe('error')
    expect(last.error).toContain('401')
  })

  it('ignores answers from another origin', async () => {
    await openPage(true)
    const { chunks } = await turn()
    const { requestId } = await aiRequest()
    fromHost({ type: 'ai_end', requestId }, 'https://evil.example')
    fromHost({ type: 'ai_error', requestId, message: 'x' }, 'https://evil.example')
    await Promise.resolve()
    expect(chunks).toEqual([])
  })

  it('cancels: the host hears ai_cancel and the turn ends as done', async () => {
    await openPage(true)
    const { chunks, done, bridge } = await turn()
    const { requestId } = await aiRequest()
    fromHost({
      type: 'ai_chunk',
      requestId,
      data: new TextEncoder().encode(GATEWAY_SSE.slice(0, 60)),
    })
    await bridge.aiStreamCancel('t1')
    await done
    expect(sent).toContainEqual(expect.objectContaining({ type: 'ai_cancel', requestId }))
    expect(chunks.at(-1)).toEqual({ requestId: 't1', type: 'done' })
    // a late answer for the cancelled request changes nothing
    fromHost({ type: 'ai_end', requestId })
    expect(chunks.at(-1)).toEqual({ requestId: 't1', type: 'done' })
  })

  it('sends nothing when the host offers no AI', async () => {
    await openPage(false)
    const { chunks, done } = await turn()
    await done
    expect(sent.some((m) => m.type === 'ai_request')).toBe(false)
    expect(chunks).toEqual([expect.objectContaining({ type: 'error', errorCode: 'not-connected' })])
  })

  it('refuses requests to any other address', async () => {
    await openPage(true)
    await expect(
      relay.hostAiFetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow(TypeError)
    expect(sent).toEqual([])
  })
})
