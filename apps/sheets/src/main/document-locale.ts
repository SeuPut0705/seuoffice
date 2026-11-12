import { documentLocale } from '@seuoffice/i18n'
import { legacyCsvCharsetFor } from '@seuoffice/xlsx-gateway/shared/document-locale'

/** which legacy code page an unmarked CSV was most likely written in on this install */
export function legacyCsvCharset(): string | undefined {
  return legacyCsvCharsetFor(documentLocale())
}
