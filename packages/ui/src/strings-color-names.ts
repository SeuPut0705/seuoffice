import type { Lang } from '@genoffice/i18n'
import type { ColorSwatch } from './color-picker'

// Tooltip names of the shared picker's named swatches, keyed by hex, in every UI language.
// Hex keys because one English name (Light Green) covers two different swatches.
// Same wording as the Word editor's ribbonColor* strings.
export const COLOR_SWATCH_NAMES: Record<Lang, Readonly<Record<string, string>>> = {
  en: {
    FFFFFF: 'White',
    '000000': 'Black',
    E7E6E6: 'Light Gray',
    '0E2841': 'Dark Blue-Gray',
    '156082': 'Blue',
    E97132: 'Orange',
    '196B24': 'Green',
    '0F9ED5': 'Sky Blue',
    A02B93: 'Purple',
    '4EA72E': 'Light Green',
    C00000: 'Dark Red',
    FF0000: 'Red',
    FFC000: 'Orange',
    FFFF00: 'Yellow',
    '92D050': 'Light Green',
    '00B050': 'Green',
    '00B0F0': 'Light Blue',
    '0070C0': 'Blue',
    '002060': 'Dark Blue',
    '7030A0': 'Purple',
  },
  ko: {
    FFFFFF: '흰색',
    '000000': '검정',
    E7E6E6: '밝은 회색',
    '0E2841': '진한 청회색',
    '156082': '파랑',
    E97132: '주황',
    '196B24': '녹색',
    '0F9ED5': '하늘색',
    A02B93: '보라',
    '4EA72E': '연두색',
    C00000: '진한 빨강',
    FF0000: '빨강',
    FFC000: '주황',
    FFFF00: '노랑',
    '92D050': '연한 녹색',
    '00B050': '녹색',
    '00B0F0': '연한 파랑',
    '0070C0': '파랑',
    '002060': '진한 파랑',
    '7030A0': '보라',
  },
}

/** The swatch's name in `lang`; the English name when the table has no entry for its hex. */
export function colorSwatchName(lang: Lang, swatch: ColorSwatch): string {
  return COLOR_SWATCH_NAMES[lang]?.[swatch.hex.toUpperCase()] ?? swatch.name
}
