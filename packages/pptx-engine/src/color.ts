/**
 * Color node resolution (srgbClr/schemeClr/sysClr/prstClr + lumMod/lumOff/tint/shade/alpha modifiers).
 * Extracted from parse.ts into a shared module: used by both parse (run/fill colors) and
 * placeholder (lstStyle defRPr default colors) to avoid a circular dependency.
 */
import { type Theme } from './theme'
import { type XmlNode } from './xml-utils'
import { call } from './engine'

/**
 * Resolve a color node + modifiers: srgbClr/schemeClr/sysClr, supporting alpha
 * (→#RRGGBBAA) and lumMod/lumOff (tint/shade, common for theme colors).
 */
export function resolveColorNode(
  node: unknown,
  theme: Theme | undefined,
  phClr?: string,
): string | undefined {
  return call('resolveColorNode', [node, theme, phClr], { undef: true }) as never
}
/** Apply lumMod/lumOff/tint/shade/satMod/alpha modifiers (ST_Percentage: 1/1000 % or "50%"). */
export function applyColorMods(hex: string, mods: XmlNode | undefined): string {
  return call('applyColorMods', [hex, mods]) as never
}