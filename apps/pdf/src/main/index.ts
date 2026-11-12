// first: variables set under the old prefix are taken over before anything reads its own
import '@seuoffice/i18n/old-names-env'
import { startPdfStandalone } from './pdf-main'

startPdfStandalone()
