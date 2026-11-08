import type { AgentMemoRemovalRefusal } from '../../../studio-plugin/agent-plugin.mjs'

/**
 * One question the panel asks while a run waits: an edit would remove these
 * memos. The answer belongs to that one call; nothing outlives it.
 */
export class MemoApprovalGate {
  private pending: {
    request: AgentMemoRemovalRefusal
    resolve: (approved: boolean) => void
  } | null = null
  private readonly listeners = new Set<(request: AgentMemoRemovalRefusal | null) => void>()

  /** Ask the panel to show the dialog; resolves false when the run is stopped first. */
  ask = (refusal: AgentMemoRemovalRefusal): Promise<boolean> => {
    // a second question cannot be on screen: the previous one is answered "keep"
    this.settle(false)
    return new Promise<boolean>((resolve) => {
      this.pending = { request: refusal, resolve }
      this.emit(refusal)
    })
  }

  /** The user pressed one of the dialog's buttons. */
  answer = (approved: boolean): void => {
    this.settle(approved)
  }

  /** The run was stopped or the panel closed: the waiting call gets a no. */
  cancel = (): void => {
    this.settle(false)
  }

  /** Called with the question to show, or null when there is none. */
  subscribe = (listener: (request: AgentMemoRemovalRefusal | null) => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private settle(approved: boolean): void {
    const pending = this.pending
    if (!pending) return
    // clear first: a listener that asks again in answer to this call starts clean
    this.pending = null
    this.emit(null)
    pending.resolve(approved)
  }

  private emit(request: AgentMemoRemovalRefusal | null): void {
    for (const listener of [...this.listeners]) listener(request)
  }
}

/** The words the dialog shows for one memo, on one line. */
export function memoApprovalPreview(memo: { text?: string | null }): string {
  return (memo.text ?? '').replace(/\s+/g, ' ').trim()
}
