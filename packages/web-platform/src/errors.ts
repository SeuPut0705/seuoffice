/** A desktop capability the web build does not have */
export class WebUnsupportedError extends Error {
  readonly feature: string

  constructor(feature: string) {
    super(`seuoffice web: ${feature} is not available on the web`)
    this.name = 'WebUnsupportedError'
    this.feature = feature
  }
}

/** Bridge method that rejects with WebUnsupportedError */
export const unsupported =
  (feature: string) =>
  (..._args: unknown[]): Promise<never> =>
    Promise.reject(new WebUnsupportedError(feature))
