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
  registerCollabCapable,
  reportDirty,
  reportError,
  reportOpened,
  saveToHost,
  type EmbedOpenErrorCode,
} from './embed-channel'
export {
  collabLink,
  reportCollabStatus,
  type CollabLink,
  type CollabLinkEvent,
  type CollabStatus,
} from './collab-link'
export { createAiStreamBridge, hostOffersAi, webAiSettings, type AiStreamBridge } from './ai-relay'
