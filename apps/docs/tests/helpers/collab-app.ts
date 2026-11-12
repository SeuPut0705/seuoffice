import { EMPTY_PENDING_NUMBERING } from '../../src/renderer/doc-state'
import type { FileActionContext } from '../../src/renderer/file-actions'

export interface FakeApp {
  context: { readonly current: FileActionContext }
  /** the App's setters, as its own code calls them */
  set(field: keyof FileActionContext, next: unknown): void
  /** apply the queued updates, as React's next render does */
  render(): void
}

/**
 * The App's FileActionContext as the co-editing side store sees it: fields
 * and their React setters. A setter's update shows only after `render`, as a
 * React state update does; `current` is what the App rendered last.
 */
export function fakeApp(fields: Partial<Record<keyof FileActionContext, unknown>> = {}): FakeApp {
  let shown: Record<string, unknown> = {
    comments: [],
    footnotes: [],
    endnotes: [],
    inkAnnotations: [],
    styleUpserts: {},
    sectionHfEdits: {},
    hfLinks: {},
    pendingNumbering: EMPTY_PENDING_NUMBERING,
    sections: [],
    sectionsDirty: [],
    pgNumDirtySections: [],
    trailingStartType: null,
    doc: { parsed: { numbering: new Map() } },
    ...fields,
  }
  const queued: Array<(state: Record<string, unknown>) => Record<string, unknown>> = []
  const setter =
    (field: string) =>
    (next: unknown): void => {
      queued.push((state) => ({
        ...state,
        [field]:
          typeof next === 'function' ? (next as (prev: unknown) => unknown)(state[field]) : next,
      }))
    }
  const current = new Proxy({} as FileActionContext, {
    get: (_target, prop) => {
      if (typeof prop !== 'string') return undefined
      if (/^set[A-Z]/.test(prop)) return setter(prop[3].toLowerCase() + prop.slice(4))
      return shown[prop]
    },
    // a spread copies the fields, as it does the App's own context (the save a session makes)
    ownKeys: () => Object.keys(shown),
    getOwnPropertyDescriptor: (_target, prop) =>
      typeof prop === 'string' && prop in shown
        ? { value: shown[prop], enumerable: true, configurable: true, writable: true }
        : undefined,
  })
  return {
    context: { current },
    set: (field, next) => setter(field)(next),
    render() {
      for (const update of queued.splice(0)) shown = update(shown)
    },
  }
}
