export interface Input {
  label: string
  text?: string
  bytes?: Uint8Array
  args?: Record<string, unknown>
  mutate?: boolean
  /** Both readers run in a child process with a timeout: an input a reader may never return from. */
  isolate?: boolean
}

/**
 * How a seed becomes a mutated input. Without one, a text seed is mutated as
 * XML text and a byte seed by editing one XML part of its ZIP.
 * `container` edits the ZIP headers themselves; `none` builds no mutated population.
 */
export type Mutation = 'text' | 'zip-xml' | 'container' | 'none'

export interface Spec {
  fn: string
  /** The engine function called, where `fn` only names the comparison. */
  engineFn?: string
  extensions: readonly string[]
  built(): Input[] | Promise<Input[]>
  call(input: Input): unknown | Promise<unknown>
  /** Corpus files are read as text, not bytes. */
  mutateText?: boolean
  mutation?: Mutation
  /** `false`: corpus files are still compared but seed no mutations. */
  seedCorpus?: boolean
  /** Corpus inputs that reach the code under test; counted against the floor `<fn>.activeCorpus`. */
  isActive?(input: Input): boolean
  /** Every input of this spec, corpus, built and mutated, runs isolated as `Input.isolate` does. */
  isolate?: boolean
  /** The function has one answer whatever it is given: the gate does not ask for two distinct results. */
  constant?: boolean
}
