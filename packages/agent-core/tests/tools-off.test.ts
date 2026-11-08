/**
 * Tools off: a model whose profile says it cannot call tools gets no tool
 * definitions and a system paragraph telling it to answer in text only. The
 * run id keeps one tool loop under one context-gate question.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AgentLoop,
  COMPLETED_VIA_TOOLS_TEXT,
  TOOLS_UNAVAILABLE_NOTE,
  type AgentStreamCallbacks,
  type AgentStreamRequest,
  type AgentSkill,
  type AgentToolCall,
  type AgentTransport,
  type ToolExecution,
} from '../src'

/** A transport that replays one scripted turn per request and records what it was asked */
function recordingTransport(
  script: Array<(cb: AgentStreamCallbacks) => void>,
): AgentTransport & { requests: AgentStreamRequest[] } {
  let turn = 0
  const transport = {
    requests: [] as AgentStreamRequest[],
    stream(request: AgentStreamRequest, cb: AgentStreamCallbacks) {
      transport.requests.push(request)
      const step = script[turn++]
      if (step) queueMicrotask(() => step(cb))
      return {
        cancel: () => {
          queueMicrotask(() => cb.onDone())
        },
      }
    },
  }
  return transport
}

function makeSkill(execute?: (call: AgentToolCall) => ToolExecution): AgentSkill {
  return {
    id: 'test',
    systemPrompt: 'system',
    tools: [
      { name: 'edit_text', description: 'Edits the document', inputSchema: { type: 'object' } },
    ],
    buildContext: () => 'CTX',
    executeTool: execute ?? (() => ({ output: 'ok', summary: 'edited', mutated: true })),
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('AgentLoop tools off', () => {
  it('sends no tools and the fixed paragraph when toolsAllowed is false', async () => {
    const transport = recordingTransport([(cb) => cb.onDone()])
    const loop = new AgentLoop({ transport, skill: makeSkill(), toolsAllowed: () => false })
    loop.run('q')
    await flush()
    expect(transport.requests[0]!.tools).toEqual([])
    expect(transport.requests[0]!.system).toContain(TOOLS_UNAVAILABLE_NOTE)
    expect(transport.requests[0]!.system).toContain('Answer in text only')
    expect(transport.requests[0]!.system).toContain('Do not claim to edit the document')
  })

  it('keeps the skill tools when toolsAllowed is true', async () => {
    const transport = recordingTransport([(cb) => cb.onDone()])
    const loop = new AgentLoop({ transport, skill: makeSkill(), toolsAllowed: () => true })
    loop.run('q')
    await flush()
    expect(transport.requests[0]!.tools.map((tool) => tool.name)).toEqual(['edit_text'])
    expect(transport.requests[0]!.system).not.toContain(TOOLS_UNAVAILABLE_NOTE)
  })

  it('keeps the skill tools when toolsAllowed is absent', async () => {
    const transport = recordingTransport([(cb) => cb.onDone()])
    const loop = new AgentLoop({ transport, skill: makeSkill() })
    loop.run('q')
    await flush()
    expect(transport.requests[0]!.tools.map((tool) => tool.name)).toEqual(['edit_text'])
    expect(transport.requests[0]!.system).not.toContain(TOOLS_UNAVAILABLE_NOTE)
  })

  it('never executes a tool call the model emits while tools are off', async () => {
    const transport = recordingTransport([
      (cb) => {
        cb.onDelta('Suggested title: A better name.')
        cb.onToolCall({ id: 'c1', name: 'edit_text', input: {} })
        cb.onDone()
      },
    ])
    const execute = vi.fn(() => ({ output: 'ok', summary: 'edited', mutated: true }))
    const done = vi.fn()
    const loop = new AgentLoop({
      transport,
      skill: makeSkill(execute),
      toolsAllowed: () => false,
      events: { onDone: done },
    })
    loop.run('q')
    await flush()
    await flush()
    expect(execute).not.toHaveBeenCalled()
    // no follow-up request: nothing went back to the model as a tool result
    expect(transport.requests).toHaveLength(1)
    expect(loop.messages.some((message) => message.role === 'tool')).toBe(false)
    expect(done).toHaveBeenCalledTimes(1)
    expect(done.mock.calls[0]![0]).toMatchObject({
      text: 'Suggested title: A better name.',
      cancelled: false,
    })
  })

  it('handles an empty tools-off turn that only carried a tool call', async () => {
    const transport = recordingTransport([
      (cb) => {
        cb.onToolCall({ id: 'c1', name: 'edit_text', input: {} })
        cb.onDone()
      },
    ])
    const execute = vi.fn(() => ({ output: 'ok', summary: 'edited', mutated: true }))
    const done = vi.fn()
    const loop = new AgentLoop({
      transport,
      skill: makeSkill(execute),
      toolsAllowed: () => false,
      events: { onDone: done },
    })
    loop.run('q')
    await flush()
    expect(execute).not.toHaveBeenCalled()
    expect(transport.requests).toHaveLength(1)
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ text: '', cancelled: false }))
    expect(loop.messages.at(-1)).toEqual({
      role: 'assistant',
      text: COMPLETED_VIA_TOOLS_TEXT,
    })
  })

  it('still executes a tool call when toolsAllowed is true', async () => {
    const transport = recordingTransport([
      (cb) => {
        cb.onToolCall({ id: 'c1', name: 'edit_text', input: {} })
        cb.onDone()
      },
      (cb) => {
        cb.onDelta('done')
        cb.onDone()
      },
    ])
    const execute = vi.fn(() => ({ output: 'ok', summary: 'edited', mutated: true }))
    const loop = new AgentLoop({ transport, skill: makeSkill(execute), toolsAllowed: () => true })
    loop.run('q')
    await flush()
    await flush()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(transport.requests).toHaveLength(2)
    expect(loop.messages.some((message) => message.role === 'tool')).toBe(true)
  })

  it('does not replay a turn whose only delivery was an ignored tool call', async () => {
    vi.useFakeTimers()
    try {
      const transport = recordingTransport([
        (cb) => {
          cb.onToolCall({ id: 'c1', name: 'edit_text', input: {} })
          cb.onError('upstream closed (empty stream)')
        },
        (cb) => {
          cb.onDelta('retried')
          cb.onDone()
        },
      ])
      const execute = vi.fn(() => ({ output: 'ok', summary: 'edited', mutated: true }))
      const errors: string[] = []
      const loop = new AgentLoop({
        transport,
        skill: makeSkill(execute),
        toolsAllowed: () => false,
        events: { onError: (error) => errors.push(error) },
      })
      loop.run('q')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(transport.requests).toHaveLength(1)
      expect(execute).not.toHaveBeenCalled()
      expect(errors).toEqual(['upstream closed (empty stream)'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps tools off on a corrective turn', async () => {
    const transport = recordingTransport([
      (cb) => {
        cb.onDelta('I edited the title.')
        cb.onDone()
      },
      (cb) => {
        cb.onDelta('I cannot edit the document; here is suggested text.')
        cb.onDone()
      },
    ])
    const skill: AgentSkill = {
      ...makeSkill(),
      verifyResponse: () => 'You cannot edit the document. Answer in text only.',
    }
    const loop = new AgentLoop({ transport, skill, toolsAllowed: () => false })
    loop.run('q')
    await flush()
    await flush()
    expect(transport.requests).toHaveLength(2)
    for (const request of transport.requests) {
      expect(request.tools).toEqual([])
      expect(request.system).toContain(TOOLS_UNAVAILABLE_NOTE)
    }
  })
})

describe('AgentLoop run id', () => {
  it('uses one run id for every turn of a run and a fresh one for the next run', async () => {
    const transport = recordingTransport([
      (cb) => {
        cb.onToolCall({ id: 'c1', name: 'edit_text', input: {} })
        cb.onDone()
      },
      (cb) => {
        cb.onDelta('done')
        cb.onDone()
      },
      (cb) => cb.onDone(),
    ])
    const loop = new AgentLoop({ transport, skill: makeSkill() })
    loop.run('first')
    await flush()
    await flush()
    loop.run('second')
    await flush()
    expect(transport.requests).toHaveLength(3)
    const [first, second, third] = transport.requests
    expect(first!.runId).toBeTruthy()
    expect(second!.runId).toBe(first!.runId)
    expect(third!.runId).toBeTruthy()
    expect(third!.runId).not.toBe(first!.runId)
  })

  it('marks the internal compaction summary as skipping the context gate', async () => {
    const transport = recordingTransport([
      (cb) => {
        cb.onDelta('first answer')
        cb.onDone()
      },
      (cb) => {
        cb.onDelta('second answer')
        cb.onDone()
      },
      (cb) => {
        cb.onDelta('a summary')
        cb.onDone()
      },
      (cb) => {
        cb.onDelta('third answer')
        cb.onDone()
      },
    ])
    const loop = new AgentLoop({
      transport,
      skill: makeSkill(),
      compaction: { maxBytes: 20, keepRecentBytes: 1 },
    })
    loop.run('x'.repeat(30))
    await flush()
    loop.run('y'.repeat(30))
    await flush()
    loop.run('z'.repeat(30))
    await flush()
    await flush()
    const summary = transport.requests.find((request) => request.tools.length === 0)
    expect(summary).toBeDefined()
    expect(summary!.skipContextGate).toBe(true)
    expect(summary!.runId).toBeUndefined()
    // the run's own turns carry the run id, so the gate asks once per run
    const turns = transport.requests.filter((request) => request !== summary)
    expect(turns.length).toBeGreaterThan(0)
    for (const request of turns) expect(request.runId).toBeTruthy()
  })
})
