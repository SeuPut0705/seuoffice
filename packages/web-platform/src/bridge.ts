/**
 * A web bridge stands in for a preload `contextBridge` object. Keys the web
 * build implements come from `impl`; any other key reads as undefined, so the
 * renderers' `typeof window.x?.fn === 'function'` feature checks keep working,
 * and logs once so a missing method on the open path shows up in the console.
 */
export function createWebBridge<T extends object>(name: string, impl: Partial<T>): T {
  const warned = new Set<string>()
  return new Proxy(impl, {
    get(target, key, receiver) {
      if (Reflect.has(target, key)) return Reflect.get(target, key, receiver)
      if (typeof key === 'string' && key !== 'then' && !warned.has(key)) {
        warned.add(key)
        console.warn('[web-bridge] missing', `${name}.${key}`)
      }
      return undefined
    },
  }) as T
}

/** Put a bridge on window the way contextBridge.exposeInMainWorld does: fixed once set */
export function installWebBridge(name: string, bridge: object): void {
  Object.defineProperty(window, name, { value: bridge, configurable: false })
}
