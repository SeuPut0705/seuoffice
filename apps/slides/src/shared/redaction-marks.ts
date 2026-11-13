/**
 * Whether a model carries a "hidden from the AI" mark anywhere: a run's or an
 * element's non-empty `redact` label, in a table or a group included. A deep
 * walk over the value, so a mark in a place no view lists still counts (fail
 * closed). Works on the engine's deck model and on the renderer's page tree
 * alike, since both name the mark `redact`.
 */
export function holdsRedactionMark(root: unknown): boolean {
  const seen = new WeakSet<object>()
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const value = stack.pop()
    if (!value || typeof value !== 'object') continue
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) continue
    if (seen.has(value)) continue
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item)
      continue
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'redact' && typeof child === 'string' && child !== '') return true
      if (child && typeof child === 'object') stack.push(child)
    }
  }
  return false
}
