/**
 * CJK font-family spellings per script — the locale dictionary behind the
 * suite-wide font pickers (@genoffice/ui/src/font-list.ts consumes it).
 *
 * The localized spellings (Han, Kana, Hangul) are functional data, not UI copy:
 * they are the family names the OS font enumeration reports on CJK-locale
 * systems and the names CJK documents expect in their font slots. They live in
 * this i18n package — the one place the repo keeps locale strings — while the
 * picker logic that consumes them stays in @genoffice/ui.
 */

// GB/T 9704 official-document fonts included so government documents can be
// authored from scratch (values are free-typed either way; the pickers accept any name)
export const SIMPLIFIED_CJK_FAMILIES: readonly string[] = [
  '等线',
  '等线 Light',
  '宋体',
  '黑体',
  '微软雅黑',
  '楷体',
  '仿宋',
  'PingFang SC',
  'Songti SC',
  'Kaiti SC',
  '仿宋_GB2312',
  '楷体_GB2312',
  '方正小标宋简体',
  'Noto Sans SC',
  'Noto Serif SC',
]

export const JAPANESE_FAMILIES: readonly string[] = [
  'Yu Gothic',
  'Yu Mincho',
  'Meiryo',
  'Hiragino Sans',
  'Hiragino Mincho',
  'MS Gothic',
  'MS Mincho',
  'Noto Sans JP',
  'Noto Serif JP',
]

export const KOREAN_FAMILIES: readonly string[] = [
  'Malgun Gothic',
  'Apple SD Gothic Neo',
  'Batang',
  'Gulim',
  'Dotum',
  'Noto Sans KR',
  'Noto Serif KR',
  // bundled with the design templates (@genoffice/ui/template-fonts)
  'Pretendard',
  'Black Han Sans',
  'Do Hyeon',
  'Gowun Dodum',
  'Gowun Batang',
]

export const TRADITIONAL_CJK_FAMILIES: readonly string[] = [
  'Microsoft JhengHei',
  'PMingLiU',
  'PingFang TC',
  'Noto Sans TC',
  'Noto Serif TC',
]

/**
 * Localized ⇄ English spellings of the same CJK family, one entry per family.
 *
 * Chromium reports family names in the system's language: a Windows outside the
 * CJK locales enumerates `SimSun`, not the localized spelling, while a
 * Japanese-locale Windows enumerates the kana spelling of Yu Gothic, not
 * `Yu Gothic`. Matching the literal candidate spelling alone would hide a font
 * the machine really has, so presence checks every spelling in the family's
 * entry, in either direction. Extend the table rather than adding copy-pasted
 * spellings to the lists above.
 */
export const CJK_FAMILY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  // Simplified CJK (zh spellings)
  宋体: ['SimSun'],
  黑体: ['SimHei'],
  微软雅黑: ['Microsoft YaHei'],
  楷体: ['KaiTi'],
  仿宋: ['FangSong'],
  仿宋_GB2312: ['FangSong_GB2312'],
  楷体_GB2312: ['KaiTi_GB2312'],
  等线: ['DengXian'],
  '等线 Light': ['DengXian Light'],
  // Traditional CJK (zh-TW spellings)
  微软正黑体: ['Microsoft JhengHei', '微軟正黑體'],
  新細明體: ['PMingLiU'],
  標楷體: ['DFKai-SB'],
  // Japanese
  メイリオ: ['Meiryo'],
  游ゴシック: ['Yu Gothic'],
  游明朝: ['Yu Mincho'],
  'ＭＳ ゴシック': ['MS Gothic'],
  'ＭＳ 明朝': ['MS Mincho'],
  'Hiragino Mincho ProN': ['Hiragino Mincho', 'ヒラギノ明朝 ProN'],
  // Korean
  '맑은 고딕': ['Malgun Gothic'],
  바탕: ['Batang'],
  돋움: ['Dotum'],
  굴림: ['Gulim'],
}

/**
 * Korean readings of families whose font files carry no Korean name, so typing
 * the name in Hangul still finds them. Search-only: never shown as the label
 * (a font's own Korean name comes from its name table at runtime). A key also
 * covers the families it prefixes (`Pretendard Variable`, `Gmarket Sans TTF`).
 */
export const KOREAN_FAMILY_READINGS: Readonly<Record<string, readonly string[]>> = {
  Pretendard: ['프리텐다드'],
  'Noto Sans KR': ['노토 산스', '본고딕'],
  'Noto Serif KR': ['노토 세리프', '본명조'],
  'Gmarket Sans': ['G마켓 산스', '지마켓 산스'],
  'Spoqa Han Sans': ['스포카 한 산스'],
  'Wanted Sans': ['원티드 산스'],
  SUIT: ['수트'],
  'Apple SD Gothic Neo': ['애플 SD 산돌고딕 Neo'],
  // its file has a Korean name, but the bundled copy is not among the scanned installed fonts
  'Black Han Sans': ['검은고딕'],
  'Do Hyeon': ['도현', '배달의민족 도현'],
  'Gowun Dodum': ['고운돋움'],
  'Gowun Batang': ['고운바탕'],
}
