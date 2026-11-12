/// Declarative defined-names save: rewrites workbook.xml's `<definedNames>`
/// from the editor's model. Entries the editor never models — `_xlnm.*`
/// built-ins, hidden names, and names it failed to install (`preserveNames`)
/// — stay byte-verbatim.

import { withFutureFunctionMarkers } from './future-functions'
import { prefixOf, rootNamespaceElements } from './xlsx-xml-scan'

export class DefinedNameError extends Error {}

export interface DefinedNameEntry {
  readonly name: string
  readonly formula: string
  /// localSheetId (position in workbook sheet order) for sheet-scoped names.
  readonly sheetIndex?: number | undefined
}

export interface DefinedNamesState {
  readonly names: readonly DefinedNameEntry[]
  readonly preserveNames: readonly string[]
}

/// Excel name rules (simplified): starts with a letter, `_`, or `\`;
/// continues with letters, digits, `_`, `.`, or `\`; must not look like an
/// A1 or R1C1 cell reference. Letters are Unicode — Excel accepts CJK names,
/// and Create from Selection builds them from localized headers, so this
/// must accept everything definedNameFromLabel produces.
const NAME_PATTERN = /^[\p{L}_\\][\p{L}\p{N}_.\\]*$/u
const CELL_REF_PATTERN = /^(?:[A-Za-z]{1,3}[0-9]+|[Rr][0-9]*[Cc][0-9]*)$/

export function applyDefinedNamesState(workbookXml: string, state: DefinedNamesState): string {
  const preserved = new Set(state.preserveNames)
  const preservedKeys = new Set<string>()
  for (const element of rootNamespaceElements(workbookXml, 'definedName')) {
    const name = element.attributes.get('name')
    if (name === undefined || !preserved.has(name)) continue
    const scope = element.attributes.get('localSheetId')
    preservedKeys.add(`${name}\u0000${scope === undefined ? -1 : Number(scope)}`)
  }
  const seen = new Set<string>()
  for (const entry of state.names) {
    validateName(entry.name)
    const key = `${entry.name}\u0000${entry.sheetIndex ?? -1}`
    if (preservedKeys.has(key)) {
      throw new DefinedNameError(
        `The name "${entry.name}" also exists in a form the editor cannot model — ` +
          'saving would duplicate it.',
      )
    }
    if (seen.has(key)) {
      throw new DefinedNameError(`The name "${entry.name}" is defined twice.`)
    }
    seen.add(key)
  }

  // Drop every modeled entry from the existing section, keeping built-ins,
  // hidden names, and preserve-listed ones in place.
  let xml = workbookXml
  for (const element of rootNamespaceElements(workbookXml, 'definedName').reverse()) {
    const name = element.attributes.get('name') ?? ''
    const hidden = element.attributes.get('hidden')
    const keep =
      name.startsWith('_xlnm') || hidden === '1' || hidden === 'true' || preserved.has(name)
    if (!keep) xml = xml.slice(0, element.start) + xml.slice(element.end)
  }

  const additions = state.names
    .map(
      (entry) =>
        `<definedName name="${escapeXmlAttribute(entry.name)}"` +
        (entry.sheetIndex === undefined ? '' : ` localSheetId="${entry.sheetIndex}"`) +
        `>${escapeXmlText(withFutureFunctionMarkers(entry.formula.replace(/^=/, '')))}</definedName>`,
    )
    .join('')

  return appendDefinedNames(xml, additions)
}

/**
 * Append entries to the workbook's `<definedNames>` section, creating the
 * section where there is none.
 *
 * Shared with the redaction mirror (`applyRedactionNameMirror`), which writes
 * into the same section with a different idea of what an entry means. The
 * schema order is the fiddly part — `<definedNames>` follows `<sheets>`, but
 * only after `<functionGroups>` and `<externalReferences>` when those are
 * present — so it is done once here rather than twice.
 */
export function appendDefinedNames(workbookXml: string, additions: string): string {
  const section = rootNamespaceElements(workbookXml, 'definedNames')[0]
  if (section) {
    const prefixed = withPrefix(additions, prefixOf(section.name))
    if (section.closeStart === section.end) {
      // written self-closed: open it to hold the entries, or drop it when there are none
      if (additions === '') return workbookXml
      const name = section.name
      const open = workbookXml.slice(section.start, section.openEnd).replace(/\s*\/>$/, '>')
      return (
        workbookXml.slice(0, section.start) +
        `${open}${prefixed}</${name}>` +
        workbookXml.slice(section.end)
      )
    }
    const inner = workbookXml.slice(section.openEnd, section.closeStart) + prefixed
    if (inner === '') {
      return workbookXml.slice(0, section.start) + workbookXml.slice(section.end)
    }
    return workbookXml.slice(0, section.openEnd) + inner + workbookXml.slice(section.closeStart)
  }
  if (additions === '') return workbookXml
  // Schema order: definedNames follows sheets (and functionGroups/externalReferences).
  const anchor = rootNamespaceElements(workbookXml, 'sheets')[0]
  if (!anchor) throw new DefinedNameError('workbook.xml has no sheets element.')
  const groups = rootNamespaceElements(workbookXml, 'functionGroups')[0]
  const externals = rootNamespaceElements(workbookXml, 'externalReferences')[0]
  let at = externals ? externals.end : anchor.end
  // functionGroups only counts when externalReferences is absent: the later
  // element is the one the section must follow
  if (!externals && groups) at = groups.end
  const prefix = prefixOf(anchor.name)
  const name = prefix === '' ? 'definedNames' : `${prefix}:definedNames`
  return `${workbookXml.slice(0, at)}<${name}>${withPrefix(additions, prefix)}</${name}>${workbookXml.slice(at)}`
}

/// The entries are written for the default namespace; a part that binds the
/// namespace to a prefix needs them in it.
function withPrefix(entries: string, prefix: string): string {
  return prefix === ''
    ? entries
    : entries.replace(/<(\/?)definedName(?=[\s>/])/g, `<$1${prefix}:definedName`)
}

/** Shared by table names, which follow the same rules (minus the `_xlnm` reservation). */
export function isValidDefinedName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    NAME_PATTERN.test(name) &&
    !CELL_REF_PATTERN.test(name) &&
    name.toLowerCase() !== 'true' &&
    name.toLowerCase() !== 'false'
  )
}

function validateName(name: string): void {
  if (!isValidDefinedName(name)) {
    throw new DefinedNameError(`"${name}" is not a valid defined name.`)
  }
  if (name.startsWith('_xlnm')) {
    throw new DefinedNameError('Names starting with "_xlnm" are reserved by Excel.')
  }
}

export function escapeXmlText(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeXmlAttribute(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
