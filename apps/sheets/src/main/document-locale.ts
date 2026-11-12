import { documentLocale } from '@genoffice/i18n'
import { legacyCsvCharsetFor } from '@genoffice/xlsx-gateway/shared/document-locale'

/** which legacy code page an unmarked CSV was most likely written in on this install */
export function legacyCsvCharset(): string | undefined {
  return legacyCsvCharsetFor(documentLocale())
}
