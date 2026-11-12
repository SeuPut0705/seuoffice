import { aiStrings } from './strings-ai'
import { appStrings } from './strings-app'
import { editStrings } from './strings-edit'
import { translateStrings } from './strings-translate'

/**
 * Every dictionary of the editor, merged per language: reading (`app/`),
 * editing (`edit/`), the AI panel (`ai/`) and book translation
 * (`translate/`). The per-language shards are never merged into one object.
 */
export const strings = {
  en: {
    ...appStrings.en,
    ...editStrings.en,
    ...aiStrings.en,
    ...translateStrings.en,
  },
  ko: {
    ...appStrings.ko,
    ...editStrings.ko,
    ...aiStrings.ko,
    ...translateStrings.ko,
  },
}
