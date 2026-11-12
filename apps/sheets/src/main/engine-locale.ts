import { getRequestedLocale } from '@genoffice/i18n'
import { engineLocaleFor } from '@genoffice/xlsx-gateway/shared/engine-locale'

/**
 * The locale a workbook is opened with. It decides how the engine reads the
 * date formats a file leaves to its viewer, so it follows the language the
 * install asks for (a Japanese system, a stored choice) and not the UI
 * language, which names fewer languages.
 */
export function engineLocale(): string {
  return engineLocaleFor(getRequestedLocale())
}
