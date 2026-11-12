/**
 * The language documents are read and drawn for in this window: the locale of
 * number formats (cells, chart labels, clipboard text) and the legacy code page
 * guess of a CSV import. The main process works it out from the language the
 * install asks for and hands it over at boot; a language chosen in Settings
 * afterwards is the request from then on. It names more languages than the UI
 * has, so it is kept apart from the UI language.
 *
 * A plain module, like i18n/numfmt-locale: its readers must not pull the
 * translation dictionaries into their graph.
 */
let documentLocale = 'en'

export const getDocumentLocale = (): string => documentLocale

export const setDocumentLocale = (locale: string): void => {
  documentLocale = locale
}
