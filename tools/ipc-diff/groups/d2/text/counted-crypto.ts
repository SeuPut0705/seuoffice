/**
 * `node:crypto` as the Markdown page image exports and Docs conversions
 * import it: `randomUUID` counts per case, as the Rust fake's
 * `MarkdownShell::random_uuid` does.
 */
export * from 'node:crypto'
export { countedUuid as randomUUID } from './fakes.ts'
