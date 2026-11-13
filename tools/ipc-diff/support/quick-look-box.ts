/** What the quick-look group's stand-ins share with the case being loaded (one case at a time) */
export interface ParseSpec {
  ok?: boolean
  text?: string
  error?: string
  throws?: string
}

export interface ScriptOp {
  op: 'space' | 'navigate' | 'escape' | 'notify'
  path?: string
}

export interface QuickLookBox {
  log: unknown[]
  parse: Record<string, ParseSpec>
  script: ScriptOp[]
  /** `notifyQuickLookLangOrThemeChanged` of the module under test */
  notify: () => void
  /** the Explorer hook's report, once it is enabled */
  played?: Promise<void>
  started: boolean
}

const KEY = Symbol.for('ipc-diff.quick-look')

export function setQuickLookBox(box: QuickLookBox): void {
  ;(globalThis as Record<symbol, unknown>)[KEY] = box
}

export function quickLookBox(): QuickLookBox {
  return (globalThis as Record<symbol, unknown>)[KEY] as QuickLookBox
}
