export { WebUnsupportedError, unsupported } from './errors'
export { createWebBridge, installWebBridge } from './bridge'
export {
  documentByPath,
  viewMode,
  waitForDocument,
  webLanguage,
  type WebDocument,
} from './document-store'
export { reportError, reportOpened, type EmbedOpenErrorCode } from './embed-channel'
