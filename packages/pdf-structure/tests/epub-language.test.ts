/** dc:language guess from the body text's script (spec §5, a tunable heuristic). */
import { describe, expect, it } from 'vitest'
import { guessLanguageFromText } from '../src/epub'

describe('script-based language guess', () => {
  const cases: [string, string][] = [
    ['ko', '이 문서는 한국어로 쓰였습니다. 본문 글자로 언어를 추정합니다.'],
    ['ja', 'この文書は日本語で書かれています。本文の文字から言語を推定します。'],
    ['zh', '本文件以中文撰写。我们根据正文字符推断文档语言。'],
    ['en', 'This document is written in English and has enough letters to decide.'],
    ['ru', 'Этот документ написан на русском языке и содержит достаточно букв.'],
    ['ar', 'هذه الوثيقة مكتوبة باللغة العربية وفيها حروف كافية للتقدير.'],
    ['he', 'המסמך הזה כתוב בעברית ויש בו מספיק אותיות כדי להחליט.'],
    ['hi', 'यह दस्तावेज़ हिंदी में लिखा गया है और इसमें पर्याप्त अक्षर हैं।'],
    ['th', 'เอกสารนี้เขียนเป็นภาษาไทยและมีตัวอักษรเพียงพอสำหรับการตัดสินใจ'],
    ['el', 'Αυτό το έγγραφο είναι γραμμένο στα ελληνικά με αρκετά γράμματα.'],
  ]
  for (const [lang, text] of cases) {
    it(`reads ${lang}`, () => {
      expect(guessLanguageFromText(text)).toBe(lang)
    })
  }

  it('lets Hangul win over embedded English terms and Hanja', () => {
    expect(
      guessLanguageFromText(
        '이번 장에서는 Transformer 모델과 attention 구조를 설명한다. 漢字 병기.',
      ),
    ).toBe('ko')
  })

  it('reads Kanji-heavy Japanese with some kana as ja', () => {
    expect(guessLanguageFromText('東京都千代田区の国立国会図書館所蔵資料を参照した。')).toBe('ja')
  })

  it('returns undefined when there are too few letters', () => {
    expect(guessLanguageFromText('12 34 — 56')).toBeUndefined()
    expect(guessLanguageFromText('ok')).toBeUndefined()
    expect(guessLanguageFromText('')).toBeUndefined()
  })
})
