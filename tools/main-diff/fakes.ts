/**
 * Fakes of the Electron objects the specs describe, shared by the groups and
 * mirrored by crates/main-core/src/calls/fakes.rs. Each call of a fake is one
 * log line.
 */

/** `parent` of a spec: null (none), "live" or "destroyed" */
export function fakeParent(parent: unknown): { isDestroyed: () => boolean } | null {
  return parent === 'live'
    ? { isDestroyed: () => false }
    : parent === 'destroyed'
      ? { isDestroyed: () => true }
      : null
}

/**
 * a `dialog` whose `showMessageBox` answers `response` (a number, or a list
 * taken one per box, NaN once it runs out) and logs each box: `over` with the
 * box for the overload with a parent, `box` for the other
 */
export function fakeDialog(response: unknown, log: (...args: unknown[]) => void) {
  const queue = Array.isArray(response) ? [...(response as number[])] : null
  return {
    showMessageBox: async (...given: unknown[]) => {
      if (given.length === 2) log('over', given[1])
      else log('box', given[0])
      const answer = queue ? (queue.shift() ?? NaN) : response
      return { response: answer } as { response: number }
    },
  }
}
