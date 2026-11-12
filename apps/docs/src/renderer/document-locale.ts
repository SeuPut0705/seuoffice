/**
 * The language documents are read and drawn for in this window (a
 * documentLocaleFor code, also a BCP-47 tag): the text of date and time fields,
 * the order of a generated index. The main process works it out from the
 * language the install asks for and hands it over at boot; a language chosen in
 * Settings afterwards is the request from then on. It names more languages than
 * the UI has, so it is kept apart from the UI language.
 */
let documentLocale = 'en'

export const getDocumentLocale = (): string => documentLocale

export const setDocumentLocale = (locale: string): void => {
  documentLocale = locale
}
