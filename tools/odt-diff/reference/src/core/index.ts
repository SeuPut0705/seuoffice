// Core layer of the ODT bridge: lenient package reading, the position map over
// content.xml's original string, and the style table. Later layers (text,
// tables, objects, pages, assembly) build on these exports.
export {
  OdtEncryptedError,
  OdtNotTextError,
  OdtOpenError,
  isOdtOpenError,
  type OdtOpenErrorCode,
} from './errors'
export {
  ODT_TEXT_MEDIA_TYPE,
  ODT_ZIP_LIMITS,
  readOdtPackage,
  type OdtEntry,
  type OdtPackage,
  type ReadOdtPackageOptions,
} from './package'
export { readManifest, type OdtManifest, type OdtManifestEntry } from './manifest'
export { classifyGenerator, detectGenerator, type OdtGenerator, type OdtProducer } from './meta'
export {
  ODT_NODE_KINDS,
  OdtNode,
  anchorType,
  bookmarkName,
  cellSpan,
  nodesOfKind,
  pairAnnotations,
  pairBookmarks,
  scanOdtBody,
  sliceNode,
  walkNodes,
  type AnnotationPair,
  type BookmarkPair,
  type OdtBody,
  type OdtNodeKind,
} from './body'
export {
  OdtStyleTable,
  readOdtStyles,
  type OdtListLevel,
  type OdtMasterPage,
  type OdtMasterPageRegion,
  type OdtMasterPageRegionName,
  type OdtPropertyBag,
  type OdtResolvedStyle,
  type OdtStyle,
  type OdtStyleContainers,
  type OdtStyleKind,
  type OdtStylePart,
  type OdtStyleScope,
} from './styles'
export { openOdt, type OdtDocument, type OpenOdtOptions } from './open'
export {
  ODF_NAMESPACES,
  PrefixMap,
  XmlScanner,
  attributeMap,
  decodeXmlEntities,
  escapeXmlAttr,
  escapeXmlText,
  readAttributes,
  readRoot,
  walkElements,
  type ElementFrame,
  type ElementRange,
  type ElementVisitor,
  type XmlAttribute,
  type XmlRoot,
  type XmlTokenKind,
} from './xml'
export * from './convert'
export {
  alignItems,
  blockElements,
  blockSource,
  convertContainer,
  convertFlow,
  convertNode,
  convertOdtBody,
  editedItems,
  flowChildren,
  paragraphBlockOf,
  rebuildContainer,
  rebuildFlow,
  rebuildOdtBody,
} from './flow'
export {
  BRIDGE_DOCUMENT_NAMESPACES,
  bridgeDocumentXml,
  buildBridgeDocx,
  defaultSectPr,
  readDocxPart,
} from './docx-package'
