/**
 * Open-password prompts for encrypted workbooks and decks, on the shared
 * password window (pdf-password-dialog). That window serves one prompt at a
 * time, so prompts from different tabs take turns: a second encrypted file
 * opened while the first still asks waits instead of cancelling the first.
 */
export interface DocumentPasswordPrompt {
  /** one attempt: the typed password, or null when the user cancels */
  ask: (retry: boolean) => Promise<string | null>
  /** ends this prompt (idempotent); the next waiting prompt may start */
  close: () => void
}

export interface DocumentPasswordWindow {
  prompt: (fileName: string, retry: boolean) => Promise<string | null>
  close: () => void
}

let queue: Promise<void> = Promise.resolve()

export function createDocumentPasswordPrompt(
  window: DocumentPasswordWindow,
  fileName: string,
): DocumentPasswordPrompt {
  const turn = queue
  let release!: () => void
  queue = new Promise<void>((resolve) => {
    release = resolve
  })
  let shown = false
  let closed = false
  return {
    ask: async (retry) => {
      await turn
      if (closed) return null
      shown = true
      return window.prompt(fileName, retry)
    },
    close: () => {
      if (closed) return
      closed = true
      // a prompt that never showed must not close another caller's window
      if (shown) window.close()
      release()
    },
  }
}
