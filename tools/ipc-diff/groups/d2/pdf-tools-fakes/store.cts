/**
 * `packages/pdf-structure/src/store` with `ResultStore` answering from the
 * case (`store.<method>`), as the Rust `PdfToolsEngine::store` fake does.
 * Everything else is the real store module.
 */
import { StoreWriteError } from '../../../../../packages/pdf-structure/src/store'
import { answer, ipc, log } from './state.cts'

export * from '../../../../../packages/pdf-structure/src/store'

/** what a method answers when the case gives nothing (the Rust fake's defaults) */
function neutral(method: string): unknown {
  switch (method) {
    case 'listTranslations':
    case 'unfinishedJobs':
    case 'readPassages':
    case 'listHighlightRuns':
    case 'readHighlightBlocks':
    case 'listJobs':
      return []
    case 'readTranslation':
    case 'readInsights':
      return null
    case 'heartbeatJob':
    case 'setHighlightSuggestionStates':
      return true
    case 'deleteTranslationExceptEdited':
    case 'countEditedTranslationBlocks':
    case 'countPassages':
      return 0
    case 'migrateDocument':
      return { aiReadPages: 0, translationBlocks: 0, languages: [] }
    case 'readJob':
      return { state: 'idle' }
    default:
      return undefined
  }
}

/** the Rust host answers a Map as the array of its values; the store hands out Maps */
function asStore(method: string, value: unknown): unknown {
  const map = (items: unknown) =>
    new Map((Array.isArray(items) ? items : []).map((item, i) => [i, item]))
  if (method === 'readHighlightBlocks' || method === 'readAiReadPages') return map(value)
  if (method === 'readTranslation' && value && typeof value === 'object' && 'blocks' in value) {
    return { ...value, blocks: map(value.blocks) }
  }
  return value
}

function call(method: string, args: unknown[]): unknown {
  log([`ResultStore.${method}`, ...args])
  const got = answer(`store.${method}`)
  if (got === undefined) return asStore(method, neutral(method))
  if (got && typeof got === 'object' && '$error' in got) {
    const message = 'message' in got ? String(got.message) : ''
    if (got.$error === 'type') throw new TypeError(message)
    if (got.$error === 'write') {
      const err = new StoreWriteError('', undefined)
      Object.defineProperty(err, 'message', { value: message })
      throw err
    }
    throw new Error(message)
  }
  return asStore(method, ipc(got))
}

export class ResultStore {
  constructor(_userDataDir: string) {
    return new Proxy(this, {
      get: (target, key) =>
        typeof key === 'string' && key !== 'then'
          ? async (...args: unknown[]) => call(key, args)
          : Reflect.get(target, key),
    })
  }
}
