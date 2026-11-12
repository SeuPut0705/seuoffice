// What a group of ported modules gives comparison (f): one spec per exported
// function, in calls-<group>.ts. The Rust side answers to the same name in
// crates/office-wasm/src/calls/<group>.rs.
import JSZip from 'jszip'
import type { ParsedDoc } from '../../packages/docx-engine/src/types'

/** One call: the text argument (or the text the Rust side parses), and the rest. */
export interface Input {
  text?: string
  /** Crosses the wire as JSON: what does not survive it is not an argument. */
  args?: Record<string, unknown>
}

export interface CallSpec {
  /** `<group>.<TypeScript name>`. */
  fn: string
  /**
   * The TypeScript side. Whatever it returns is compared once it has crossed
   * JSON (a Map as its entries, a Set as its values); what it throws is
   * compared by presence.
   */
  call(text: string, args: Record<string, unknown>): unknown
  /**
   * The inputs a corpus document gives. `parts` holds the text of every .xml
   * and .rels entry by name.
   */
  fromDocument?(parts: ReadonlyMap<string, string>): Input[]
  /** Inputs from the actual parser model, before Maps and bytes cross the wire. */
  fromModel?(doc: ParsedDoc): Input[]
  /** Inputs written for what the corpus lacks, and the seeds of the mutations. */
  built: Input[]
  /** `none` where the text is not what the function reads, so mutating it compares nothing. */
  mutation?: 'none'
  /**
   * The arguments are a model value: compare mutations of them as well
   * (calls-arg-mutation.ts), each inside the types the seeds showed.
   */
  argMutation?: true
}

/** The package a function over a zip reads, from `args.parts`: `[name, text]` pairs. */
export function zipOf(parts: unknown): JSZip {
  const zip = new JSZip()
  for (const [name, text] of parts as Array<[string, string]>) zip.file(name, text)
  return zip
}
