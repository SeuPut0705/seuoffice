/**
 * The contract of a group of the comparison. A group is a table from the
 * function's name, `<module>.<function>` with the module named as its
 * TypeScript file without `.ts`, to the TypeScript call and the inputs.
 */

/** A file or folder a case puts into its folder before the call. */
export type FileSpec =
  /** a file with this UTF-8 text */
  | string
  | {
      /** UTF-8 text, or `hex` for raw bytes */
      text?: string
      hex?: string
      /** a folder instead of a file */
      dir?: true
      /** the file's modification time, so both sides stat the same */
      mtimeMs?: number
      /** permission bits, e.g. 0o444 for a read-only file */
      mode?: number
      /** a hard link to this earlier entry of the case, instead of a new file */
      link?: string
    }

export interface Case {
  /**
   * The arguments, as JSON. Every `$DIR` in a string is replaced by the
   * case's folder, a fresh one per side.
   */
  args: unknown[]
  /** paths relative to the case's folder */
  files?: Record<string, FileSpec>
  /** why the case is there, for the report */
  note?: string
}

export interface TsContext {
  /** the clock of the call (ms since the epoch); the same on both sides */
  now: number
  /** the logger handed to a function that takes one; each call is one log line */
  log: (...args: unknown[]) => void
  /** the case's folder */
  dir: string
}

export interface FnSpec {
  /**
   * Calls the TypeScript with the arguments as given (`$DIR` replaced).
   * Turn JSON into what the function takes (a `Date` from `cx.now`, a `Set`
   * from an array, `cx.log` for a logger) here; Rust gets the plain JSON and
   * `now`. A thrown error is compared by `code` and `message`.
   */
  ts: (args: unknown[], cx: TsContext) => unknown
  cases: Case[]
  /** why one answer is all there is (a constant); the floor of two is waived */
  single?: string
}

export type Group = Record<string, FnSpec>
