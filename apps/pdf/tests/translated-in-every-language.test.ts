import { describe, expect, it } from 'vitest'
import { strings } from '../src/renderer/i18n/strings'

// Strings that were once left in English in every language but a few.
const CHECKED = (key: string): boolean =>
  /^(ribbonTabFillForm|ribbonTabFormDesign|form|insertText|editInsertedText|deleteInsertedText|insertedTextDeleted|textInsert|cert|sig[A-Z])/.test(
    key,
  )

describe('translations', () => {
  it('leave none of the checked strings in English', () => {
    const all: Record<string, Record<string, string>> = strings
    const en = all.en!
    const english = Object.keys(all)
      .filter((lang) => lang !== 'en')
      .flatMap((lang) =>
        Object.keys(en)
          .filter(CHECKED)
          .filter(
            (key) =>
              all[lang]![key] === en[key] && /[A-Za-z]{3,}/.test(en[key]!.replace(/\{\w+\}/g, '')),
          )
          .map((key) => `${lang}:${key}`),
      )
    expect(english).toEqual([])
  })
})
