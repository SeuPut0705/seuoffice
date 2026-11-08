/** The provider router hands the `claude-code-cli` protocol to the Claude Code bridge. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'

const bridge = vi.hoisted(() => ({
  streamClaudeCodeCli: vi.fn(async () => undefined),
  chatClaudeCodeCli: vi.fn(async () => ({ ok: true as const, content: 'pong' })),
}))

vi.mock('../src/claude-code-cli', () => bridge)

import { chatForProvider } from '../src/chat'
import { streamForProvider } from '../src/stream'

describe('claude-code-cli routing', () => {
  beforeEach(() => {
    bridge.streamClaudeCodeCli.mockClear()
    bridge.chatClaudeCodeCli.mockClear()
  })

  it('streams a claude-code turn through the bridge', async () => {
    const messages: AgentMessage[] = [{ role: 'user', text: 'hi' }]
    const tools: AgentToolDef[] = [{ name: 't', description: 'd', inputSchema: { type: 'object' } }]
    const config = { apiKey: '', model: 'sonnet' }
    const cb = {
      signal: new AbortController().signal,
      onDelta: () => undefined,
      onToolCall: () => undefined,
    }
    await streamForProvider('claude-code', config, 'system', messages, tools, 2048, cb)
    expect(bridge.streamClaudeCodeCli).toHaveBeenCalledTimes(1)
    expect(bridge.streamClaudeCodeCli).toHaveBeenCalledWith(
      config,
      'system',
      messages,
      tools,
      2048,
      cb,
    )
  })

  it('answers a one-shot claude-code chat through the bridge, under the chat watchdog', async () => {
    const config = { apiKey: '', model: '' }
    await expect(chatForProvider('claude-code', config, 'system', 'ping')).resolves.toEqual({
      ok: true,
      content: 'pong',
    })
    expect(bridge.chatClaudeCodeCli).toHaveBeenCalledTimes(1)
    const [wd, passedConfig, system, user] = bridge.chatClaudeCodeCli.mock.calls[0] as unknown[]
    expect(typeof (wd as { touch: unknown }).touch).toBe('function')
    expect((wd as { signal: unknown }).signal).toBeInstanceOf(AbortSignal)
    expect(passedConfig).toEqual(config)
    expect(system).toBe('system')
    expect(user).toBe('ping')
  })
})
