import JSZip from 'jszip'
import { invoke } from './engine'
import { zipCall } from './engine-hand'

/** docProps/core.xml — the core properties part. */
export const CORE_PROPERTIES_PATH = 'docProps/core.xml'
/** docProps/app.xml — the extended properties part. */
export const APP_PROPERTIES_PATH = 'docProps/app.xml'
/** friendly key -> the element of docProps/core.xml that holds it */
const CORE_PROPERTIES: Record<string, { prefix: string; local: string }> = {
  title: { prefix: 'dc', local: 'title' },
  subject: { prefix: 'dc', local: 'subject' },
  creator: { prefix: 'dc', local: 'creator' },
  keywords: { prefix: 'cp', local: 'keywords' },
  description: { prefix: 'dc', local: 'description' },
  lastModifiedBy: { prefix: 'cp', local: 'lastModifiedBy' },
  revision: { prefix: 'cp', local: 'revision' },
  created: { prefix: 'dcterms', local: 'created' },
  modified: { prefix: 'dcterms', local: 'modified' },
  category: { prefix: 'cp', local: 'category' },
  contentStatus: { prefix: 'cp', local: 'contentStatus' },
  identifier: { prefix: 'dc', local: 'identifier' },
  language: { prefix: 'dc', local: 'language' },
  version: { prefix: 'cp', local: 'version' },
}
/** friendly key -> the element of docProps/app.xml that holds it */
const APP_PROPERTIES: Record<string, string> = {
  template: 'Template',
  totalTime: 'TotalTime',
  pages: 'Pages',
  words: 'Words',
  characters: 'Characters',
  application: 'Application',
  docSecurity: 'DocSecurity',
  lines: 'Lines',
  paragraphs: 'Paragraphs',
  scaleCrop: 'ScaleCrop',
  company: 'Company',
  linksUpToDate: 'LinksUpToDate',
  charactersWithSpaces: 'CharactersWithSpaces',
  sharedDoc: 'SharedDoc',
  hyperlinksChanged: 'HyperlinksChanged',
  appVersion: 'AppVersion',
  manager: 'Manager',
}
/** the core property keys, in the order the part lists them */
export const CORE_PROPERTY_KEYS = Object.keys(CORE_PROPERTIES)
/** the extended (app) property keys */
export const APP_PROPERTY_KEYS = Object.keys(APP_PROPERTIES)
/** a custom-property value of a set_properties op: text, or a typed number/boolean */
export type PropertyValue = string | number | boolean
/** the document properties of a .docx, read from its three docProps parts */
export interface DocumentProperties {
  /** docProps/core.xml by friendly key (title, creator, lastModifiedBy, …) */
  core: Record<string, string>
  /** docProps/app.xml by friendly key (company, template, application, …) */
  app: Record<string, string>
  /** docProps/custom.xml by property name (a typed value is its vt text: "42", "true", …) */
  custom: Record<string, string>
  /**
   * docProps/custom.xml by property name: the vt type the value is stored as
   * (lpwstr, i4, i8, r8, bool, filetime, date, …). A set_properties op that
   * updates such a property keeps its type while the new value fits it.
   */
  customTypes: Record<string, string>
}
/** what a set_properties op asks for: a value per key, or null to remove it */
export interface PropertyChanges {
  core?: Record<string, string | null>
  app?: Record<string, string | null>
  /** custom values: text stays lpwstr, a number/boolean takes a typed vt value */
  custom?: Record<string, PropertyValue | null>
  /** remove every property of all three parts (a full metadata scrub) */
  clear?: 'all'
}
/** the core properties of a core.xml part */
export function parseCorePropertiesXml(xml: string): Record<string, string> {
  return invoke('parseCorePropertiesXml', [xml]) as never
}
/** the extended properties of an app.xml part */
export function parseAppPropertiesXml(xml: string): Record<string, string> {
  return invoke('parseAppPropertiesXml', [xml]) as never
}
/** the custom properties of a custom.xml part, by property name */
export function parseCustomPropertiesXml(xml: string): Record<string, string> {
  return invoke('parseCustomPropertiesXml', [xml]) as never
}
/** the vt types of a custom.xml part's properties, by property name */
export function parseCustomPropertyTypesXml(xml: string): Record<string, string> {
  return invoke('parseCustomPropertyTypesXml', [xml]) as never
}
/** the three docProps parts of a package, empty when the part is missing */
export async function readDocumentProperties(zip: JSZip): Promise<DocumentProperties> {
  return zipCall('readDocumentProperties', zip, [], false) as never
}
/** the properties of a package that carries no docProps part at all */
export function emptyDocumentProperties(): DocumentProperties {
  return { core: {}, app: {}, custom: {}, customTypes: {} }
}
/** Application a new SeuOffice document records in docProps/app.xml */
export const NEW_DOCUMENT_APPLICATION = 'SeuOffice'
/** Template a new SeuOffice document records (Word's own default) */
export const NEW_DOCUMENT_TEMPLATE = 'Normal.dotm'
/**
 * AppVersion of a new document. The docx-engine package version at release
 * time; a blank-template test pins it to package.json so a version bump fails
 * loudly instead of shipping a stale stamp.
 */
export const NEW_DOCUMENT_APP_VERSION = '0.1.0'
/** the W3CDTF stamp Word writes into core properties (seconds, Z) */
export function w3cdtfStamp(date: Date): string {
  return invoke('w3cdtfStamp', [date]) as never
}
/**
 * Word-like core part of a freshly created document: no creator or other
 * people data, just the creation/modification stamp and revision 0 — the
 * template has not been saved anywhere yet, and the first save bumps the
 * revision to 1 the way Word's first Ctrl+S does (genoffice#2554).
 */
export function newDocumentCorePropertiesXml(created: Date = new Date()): string {
  return invoke('newDocumentCorePropertiesXml', [created]) as never
}
/** Word-like extended part of a freshly created document (no company/manager).
 *  `omitGeneratorFields` drops Application and AppVersion — the fields that name
 *  the generating tool — while the harmless Word-default Template stays
 *  (genoffice#2554: consumers that must not look machine-generated then skip a
 *  set_properties pass). */
export function newDocumentAppPropertiesXml(
  opts: {
    application?: string
    appVersion?: string
    template?: string
    omitGeneratorFields?: boolean
  } = {},
): string {
  return invoke('newDocumentAppPropertiesXml', [opts]) as never
}
/** set or remove the core properties of a core.xml part */
export function patchCorePropertiesXml(
  xml: string,
  changes: Record<string, string | null>,
): string {
  return invoke('patchCorePropertiesXml', [xml, changes]) as never
}
/** set or remove the extended properties of an app.xml part */
export function patchAppPropertiesXml(xml: string, changes: Record<string, string | null>): string {
  return invoke('patchAppPropertiesXml', [xml, changes]) as never
}
/** set or remove the custom properties of a custom.xml part, keeping stored vt types */
export function patchCustomPropertiesXml(
  xml: string,
  changes: Record<string, PropertyValue | null>,
): string {
  return invoke('patchCustomPropertiesXml', [xml, changes]) as never
}
/**
 * Write the requested property changes into the package: a string sets a
 * property, null removes it, clear: "all" empties all three parts. A part that
 * is not there yet is created, so a document without docProps can still take
 * properties.
 */
export async function applyPropertyChanges(zip: JSZip, changes: PropertyChanges): Promise<void> {
  return zipCall('applyPropertyChanges', zip, [changes], true, { undef: true }) as never
}
/**
 * The set_properties op: core / app / custom hold the values to set (null
 * removes), clear: "all" empties every part. Custom values may be strings,
 * numbers or booleans (a typed value keeps an existing property's vt type);
 * core/app stay strings. Throws on anything else.
 */
export function parsePropertyChanges(input: Record<string, unknown>): PropertyChanges {
  return invoke('parsePropertyChanges', [input]) as never
}