import { aiStrings } from './strings-ai'
import { appStrings } from './strings-app'

export const strings = {
  en: { ...appStrings.en, ...aiStrings.en },
  ko: { ...appStrings.ko, ...aiStrings.ko },
}
