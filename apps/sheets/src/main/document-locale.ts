import { getRequestedLocale } from '@genoffice/i18n'
import {
  documentLocaleFor,
  legacyCsvCharsetFor,
} from '@genoffice/xlsx-gateway/shared/document-locale'

/**
 * The language documents are read and drawn for: the engine's code for the
 * date formats a file leaves to its viewer, the locale of number formats, the
 * legacy code page guess. It follows the language the install asks for (a
 * Japanese system, a stored choice) and not the UI language, which names fewer
 * languages.
 */
export function documentLocale(): string {
  return documentLocaleFor(getRequestedLocale())
}

/** which legacy code page an unmarked CSV was most likely written in on this install */
export function legacyCsvCharset(): string | undefined {
  return legacyCsvCharsetFor(documentLocale())
}
