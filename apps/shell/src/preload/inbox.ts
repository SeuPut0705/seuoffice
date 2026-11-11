/**
 * A message the main process pushes to the page, kept until the page listens.
 * The preload runs before the page's code, so a push that arrives while the
 * page is still starting (a skill file dropped right after launch asks for
 * Settings) would find no listener and be lost. The newest such push waits
 * here and goes to the first subscriber.
 */
export interface Inbox<T> {
  push(value: T): void
  subscribe(handler: (value: T) => void): () => void
}

export function createInbox<T>(): Inbox<T> {
  const handlers = new Set<(value: T) => void>()
  let waiting: { value: T } | undefined
  return {
    push(value) {
      if (handlers.size === 0) {
        waiting = { value }
        return
      }
      for (const handler of [...handlers]) handler(value)
    },
    subscribe(handler) {
      handlers.add(handler)
      if (waiting) {
        const { value } = waiting
        waiting = undefined
        handler(value)
      }
      return () => {
        handlers.delete(handler)
      }
    },
  }
}
