import { describe, expect, it, vi } from 'vitest'
import { createAgentBridge, type AgentBridgeEditor } from '../src/renderer/ai/agent-bridge'
import { AGENT_PLUGIN_ID } from '../studio-plugin/agent-plugin.mjs'

function fakeEditor(load: () => Promise<unknown> = async () => ({})) {
  const plugins = {
    load: vi.fn(load),
    invoke: vi.fn(async (_id: string, method: string) => `${method}-result`),
  }
  return { editor: { plugins } as unknown as AgentBridgeEditor, plugins }
}

describe('the bridge to the plugin inside the editor', () => {
  it('loads the plugin once and forwards calls by method name', async () => {
    const { editor, plugins } = fakeEditor()
    const bridge = createAgentBridge(() => editor)
    await bridge.findText('가')
    await bridge.replaceText('가', '나', 2)
    expect(plugins.load).toHaveBeenCalledTimes(1)
    expect(plugins.load).toHaveBeenCalledWith(AGENT_PLUGIN_ID)
    expect(plugins.invoke.mock.calls).toEqual([
      [AGENT_PLUGIN_ID, 'findText', ['가']],
      [AGENT_PLUGIN_ID, 'replaceText', ['가', '나', 2]],
    ])
  })

  it('fails the call while there is no editor', async () => {
    const bridge = createAgentBridge(() => null)
    await expect(bridge.readText()).rejects.toThrow(/not ready/)
  })

  it('tries the load again after it failed', async () => {
    let attempts = 0
    const { editor, plugins } = fakeEditor(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('not allowed')
      return {}
    })
    const bridge = createAgentBridge(() => editor)
    await expect(bridge.readText()).rejects.toThrow('not allowed')
    await expect(bridge.readText()).resolves.toBe('readText-result')
    expect(plugins.load).toHaveBeenCalledTimes(2)
  })

  it('loads the plugin again for a new editor', async () => {
    const first = fakeEditor()
    const second = fakeEditor()
    let current = first.editor
    const bridge = createAgentBridge(() => current)
    await bridge.readText()
    current = second.editor
    await bridge.readText()
    expect(first.plugins.load).toHaveBeenCalledTimes(1)
    expect(second.plugins.load).toHaveBeenCalledTimes(1)
  })
})
