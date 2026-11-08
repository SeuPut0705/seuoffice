/** A value that tolerates any call or property read: what a stubbed installer hands back. */
export const inert: unknown = new Proxy(function () {}, {
  get: (_target, key) => (key === 'then' || typeof key === 'symbol' ? undefined : inert),
  apply: () => inert,
})

/** The module with every installer replaced by one that installs nothing. */
export function stubInstallers<T extends object>(original: T): T {
  return Object.fromEntries(
    Object.entries(original).map(([name, value]) => [
      name,
      typeof value === 'function' && /^install/.test(name) ? () => inert : value,
    ]),
  ) as T
}
