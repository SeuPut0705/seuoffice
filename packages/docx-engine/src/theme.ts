import type { ThemeColors, ThemeFonts } from './types'
import { invoke } from './engine'

/** read the latin/ea/cs major+minor typefaces from theme1.xml */
export function readThemeFonts(themeXml: string): ThemeFonts | null {
  return invoke('readThemeFonts', [themeXml]) as never
}
export function readThemeColors(themeXml: string): ThemeColors | null {
  return invoke('readThemeColors', [themeXml]) as never
}
