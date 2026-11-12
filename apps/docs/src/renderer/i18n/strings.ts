import { aiStrings } from './strings-ai'
import { appStrings } from './strings-app'
import { editorStrings } from './strings-editor'
import { ribbonStrings } from './strings-ribbon'
import { tableStrings } from './strings-table'
import { zoteroStrings } from './strings-zotero'

export const strings = {
  en: {
    ...appStrings.en,
    ...ribbonStrings.en,
    ...tableStrings.en,
    ...editorStrings.en,
    ...aiStrings.en,
    ...zoteroStrings.en,
  },
  ko: {
    ...appStrings.ko,
    ...ribbonStrings.ko,
    ...tableStrings.ko,
    ...editorStrings.ko,
    ...aiStrings.ko,
    ...zoteroStrings.ko,
  },
}
