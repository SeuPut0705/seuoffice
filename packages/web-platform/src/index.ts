export { WebUnsupportedError, unsupported } from './errors'
export { createWebBridge, installWebBridge } from './bridge'
export {
  documentByPath,
  editMode,
  viewMode,
  waitForDocument,
  webLanguage,
  type WebDocument,
} from './document-store'
export {
  onHostSaveRequest,
  reportDirty,
  reportError,
  reportOpened,
  saveToHost,
  type EmbedOpenErrorCode,
} from './embed-channel'
