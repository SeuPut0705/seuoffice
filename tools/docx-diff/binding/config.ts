// What differs between the engines the binding generator serves: the docx
// engine (B4) and the pptx engine (C2). manifest.ts, gen.ts and rust-table.ts
// read the active `EngineConfig`; `--engine pptx` selects the pptx one, no flag
// selects docx. A config holds paths and the hand decisions of its engine
// (overrides) and nothing that runs.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pptx } from '../../pptx-diff/binding/config'
import { docx } from './docx-config'
import type { ExportInfo } from './manifest'
import type { Override } from './overrides'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** What rust-table.ts lends a config's row: reading a plain Rust parameter and naming a type. */
export interface RowTools {
  readParam(
    e: ExportInfo,
    index: number,
    raw: string,
    notes: string[],
  ): { lines: string[]; arg: string } | null
  qualify(type: string, file: string): { text: string; missing: string | null }
  firstArgument(text: string): string
}

export interface EngineConfig {
  name: 'docx' | 'pptx'
  /** repo-relative directory of the package, e.g. packages/docx-engine */
  packageDir: string
  /** e.g. @seuoffice/docx-engine */
  packageName: string
  /** repo-relative directory of the frozen TypeScript engine */
  reference: string
  /** repo-relative directory of the engine's binding tools (the generator ignores it when it looks for importers) */
  bindingDir: string
  /** repo-relative manifest the generator writes */
  manifest: string
  /** the generated table of office-wasm: repo-relative file, its module name and the module of the hand routes */
  table: { file: string; module: string; routes: string }
  /** the Rust crates searched for the port of an export: repo-relative source dir and crate name */
  crates: Array<{ dir: string; crate: string }>
  /** TypeScript modules of the package that are binding plumbing (the generator reads, never writes them) */
  plumbing: string[]
  /** `engine-shapes.ts`, the table of reply shapes, is written */
  shapesModule: boolean
  /**
   * Exported types whose shape `engine-type-shapes.ts` holds: the model values
   * the engine answers for the binding to write back into the caller's objects.
   */
  typeShapes?: readonly string[]
  /** a module of the package.json exports that is no engine module */
  pluginModule(module: string): boolean
  overrideOf(name: string): Override | undefined
  isHandRoute(name: string): boolean
  /** routes the table answers that are no export (a class method): name on the wire, to the Rust function of the hand routes module */
  handRoutes: Readonly<Record<string, string>>
  hostModules: Readonly<Record<string, true>>
  /** reference modules nothing reaches any more: neither copied nor rewritten, by module with the reason */
  unusedModules?: Readonly<Record<string, string>>
  /** text appended to a module */
  append: Readonly<Record<string, string>>
  /**
   * Hand-written text of a whole piece (a class) of a module, by module and
   * piece name: the generator keeps the piece's place and exports.
   */
  replace: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** the Rust name of an export where it is not the snake case of the export's name */
  rustName?(name: string): string | undefined
  /** the Rust file that is a TypeScript module's own, to pick among Rust functions of one name */
  rustModule?(module: string): string | undefined
  /** the names of `export { a } from './m'` are no use of an import (the generated module drops an import only those named) */
  dropReexportRefs: boolean
  /** an export nothing outside the package uses is noted, and its module drops it unless something kept names it */
  dropUnused: boolean
  /** the override writes the row (or part of it) itself: the manifest does not check the Rust signature for a generated row */
  ownRow?(override: Override | undefined): boolean
  /** a Rust parameter type a row can read, the name of the parameter stripped */
  decodable(type: string): boolean
  /** the Rust parameters that a wire argument stands for (the others are filled by the row) */
  wireParams(params: string[]): string[]
  /** the TypeScript wrapper of a routed export; undefined: the docx default of gen.ts */
  wrapperBody?(info: ExportInfo, names: string[], override: Override | undefined): string | null
  /** the import lines a module's wrappers need, from the text of the wrappers; undefined: the docx default of gen.ts */
  coreImports?(wrappers: string): string[]
  /** the Rust row of an export; undefined: rust-table.ts's one (docx) */
  row?(e: ExportInfo, notes: string[], fn: string, tools: RowTools): { code: string } | null
  /** the head of the generated Rust table: its doc comment and `use` lines */
  rustHead: string
  /** statements at the top of the table's `invoke`, before it matches the name (each line indented, newline-terminated) */
  invokePrelude: string
  /** the table carries the docx-only helpers (spin counts, XNode arguments, package snapshots) */
  rustDocxHelpers: boolean
}

const flag = process.argv.indexOf('--engine')
const which = flag === -1 ? 'docx' : process.argv[flag + 1]
const configs: Record<string, EngineConfig> = { docx, pptx }
const picked = which ? configs[which] : undefined
if (!picked)
  throw new Error(`--engine ${which}: expected one of ${Object.keys(configs).join(', ')}`)
export const config: EngineConfig = picked
