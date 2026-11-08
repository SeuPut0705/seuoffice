/** Markdown writer (spec §3): document tree → Markdown text, pictures and manifest entries. */
export {
  ASSETS_DIR,
  treeToMarkdown,
  type MarkdownAsset,
  type MarkdownConversion,
  type MarkdownWarning,
  type MarkdownWarningKind,
} from './write'
export {
  ASSET_MANIFEST_FILENAME,
  mergeAssetManifest,
  parseAssetManifest,
  type OwnedAssetManifest,
  type OwnedAssetRecord,
} from './manifest'
