import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packagedResourcesDir, repoRoot } from './resources'
import { CliError, EXIT } from './result'

let installed = false

/**
 * The docs and markdown editors are ProseMirror documents; they need a DOM
 * to exist, not to be seen. jsdom provides one. It is installed once, before
 * any editor module is imported (ProseMirror sniffs the environment at load).
 */
export async function ensureDom(): Promise<void> {
  if (installed) return
  const { JSDOM, VirtualConsole } = await loadJsdom()
  // a listener-less console swallows jsdom's "not implemented" notes (canvas
  // getContext from the editors' layout probes) that would otherwise hit stderr
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  })
  const w = dom.window as unknown as Record<string, unknown>
  const g = globalThis as unknown as Record<string, unknown>
  for (const key of ['window', 'document', 'navigator']) {
    Object.defineProperty(g, key, {
      value: key === 'window' ? w : w[key],
      configurable: true,
      writable: true,
    })
  }
  for (const key of Object.getOwnPropertyNames(w)) {
    if (key in g) continue
    try {
      g[key] = w[key]
    } catch {}
  }
  g.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const noMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })
  g.matchMedia ??= noMedia
  w.matchMedia ??= noMedia
  g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0)
  g.cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
  const range = (w.Range as { prototype: Record<string, unknown> }).prototype
  range.getClientRects ??= () => []
  range.getBoundingClientRect ??= () => ({
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
  })
  const doc = w.document as Record<string, unknown>
  doc.getSelection ??= () => null
  installed = true
}

async function loadJsdom(): Promise<typeof import('jsdom')> {
  const candidates: string[] = []
  const packaged = packagedResourcesDir()
  if (packaged) candidates.push(join(packaged, 'cli', 'node_modules', 'jsdom', 'package.json'))
  const root = repoRoot()
  if (root) candidates.push(join(root, 'package.json'))
  for (const from of candidates) {
    try {
      const entry = createRequire(from).resolve('jsdom')
      return await withInertHeaders(
        async () => (await import(pathToFileURL(entry).href)) as typeof import('jsdom'),
      )
    } catch {}
  }
  throw new CliError(EXIT.conversion, 'jsdom not found (needed for Word and Markdown documents)', {
    hint: 'run from a checkout with node_modules installed',
  })
}

/**
 * Evaluates `load` with an inert `globalThis.Headers`, then puts the real
 * descriptor back before any other code runs.
 *
 * jsdom 28 ships its own undici copy, and that copy's cookie module reads
 * `globalThis.Headers` while it is evaluated. Node defines the global as a lazy
 * accessor over its built-in undici, so the read instantiates the llhttp
 * WebAssembly parser on the spot. A WebAssembly memory reserves a large virtual
 * address range, and on a sandbox that caps virtual memory (`ulimit -v`) that
 * instantiation aborts the process before a single block of the document is
 * read — which is why `docs read` died while `sheet` and `slides` worked. jsdom
 * only brand-checks that global; nothing here ever hands it a real one, so an
 * empty class is enough to keep the parser out of the process.
 *
 * On Node 22 even reading or redefining that lazy property loads the built-in
 * undici; asking whether it exists and deleting it do not. So the real Headers
 * is not kept: afterwards an accessor fetches it through `Response` the first
 * time something reads it, which loads the parser only when it is really used.
 */
export async function withInertHeaders<T>(load: () => Promise<T>): Promise<T> {
  const had = Object.hasOwn(globalThis, 'Headers')
  delete (globalThis as { Headers?: unknown }).Headers
  Object.defineProperty(globalThis, 'Headers', {
    value: class Headers {},
    configurable: true,
    writable: true,
  })
  try {
    return await load()
  } finally {
    if (had) Object.defineProperty(globalThis, 'Headers', lazyBuiltinHeaders())
    else delete (globalThis as { Headers?: unknown }).Headers
  }
}

function lazyBuiltinHeaders(): PropertyDescriptor {
  const settle = (value: unknown): unknown => {
    Object.defineProperty(globalThis, 'Headers', { value, configurable: true, writable: true })
    return value
  }
  return {
    configurable: true,
    get: () => settle(new Response().headers.constructor),
    set: (value: unknown) => void settle(value),
  }
}
