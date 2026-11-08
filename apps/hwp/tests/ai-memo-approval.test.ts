import { describe, expect, it } from 'vitest'
import type { AgentMemoRemovalRefusal } from '../studio-plugin/agent-plugin.mjs'
import { MemoApprovalGate, memoApprovalPreview } from '../src/renderer/ai/memo-approval'

function refusal(count = 1): AgentMemoRemovalRefusal {
  return {
    ok: false,
    reason: 'memo_removal_requires_approval',
    count,
    memos: [
      {
        id: 1,
        index: 0,
        author: '김 교사',
        text: '확인 부탁드립니다',
        place: 'body',
        page: 2,
      },
    ],
  }
}

describe('the panel memo-removal question', () => {
  it('resolves true only when the user chooses to remove', async () => {
    const gate = new MemoApprovalGate()
    const answer = gate.ask(refusal())
    gate.answer(true)
    await expect(answer).resolves.toBe(true)
  })

  it('resolves false when the user keeps the memos', async () => {
    const gate = new MemoApprovalGate()
    const answer = gate.ask(refusal())
    gate.answer(false)
    await expect(answer).resolves.toBe(false)
  })

  it('resolves false when the run is stopped while it waits', async () => {
    const gate = new MemoApprovalGate()
    const answer = gate.ask(refusal())
    gate.cancel()
    await expect(answer).resolves.toBe(false)
  })

  it('answers an older question "keep" when a new one arrives', async () => {
    const gate = new MemoApprovalGate()
    const first = gate.ask(refusal(1))
    const second = gate.ask(refusal(2))
    await expect(first).resolves.toBe(false)
    gate.answer(true)
    await expect(second).resolves.toBe(true)
  })

  it('shows the question and takes it down before the promise settles', async () => {
    const gate = new MemoApprovalGate()
    const seen: (AgentMemoRemovalRefusal | null)[] = []
    const stop = gate.subscribe((request) => seen.push(request))
    const answer = gate.ask(refusal())
    expect(seen).toHaveLength(1)
    expect(seen[0]?.count).toBe(1)
    gate.answer(true)
    // the panel is told to hide it before the waiting call is let go
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBeNull()
    await expect(answer).resolves.toBe(true)
    stop()
    gate.ask(refusal())
    // the removed listener no longer hears the new question
    expect(seen).toHaveLength(2)
  })

  it('ignores an answer when nothing is being asked', async () => {
    const gate = new MemoApprovalGate()
    expect(() => gate.answer(true)).not.toThrow()
    expect(() => gate.cancel()).not.toThrow()
    const answer = gate.ask(refusal())
    gate.answer(false)
    await expect(answer).resolves.toBe(false)
  })

  it('shows one memo preview on one line', () => {
    expect(memoApprovalPreview({ text: '  첫 줄\n둘째   줄  ' })).toBe('첫 줄 둘째 줄')
    expect(memoApprovalPreview({ text: null })).toBe('')
  })
})
