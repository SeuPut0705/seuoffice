/**
 * The generation brief: core hook + style + sections, agreed with the user
 * before the page is generated and then pinned into the document head so later edits
 * (and re-opens) stay anchored to it. Stored as JSON in a meta tag; the page
 * itself is expected to expose the palette/typography as --brief-* variables.
 */
import { BRIEF_META_NAME_WRITTEN, OLD_BRIEF_META_NAMES } from './old-names'

export interface BriefStyle {
  /** short direction name shown on the style tile, e.g. "Editorial serif" */
  name?: string
  tone: string
  palette: { primary?: string; accent?: string; bg?: string; surface?: string; text?: string }
  typography: { heading?: string; body?: string; scale?: string }
  /** CSS values for the shared design tokens: corner radius, base spacing unit, card shadow */
  tokens?: { radius?: string; spacing?: string; shadow?: string }
  layout?: string
  density?: 'compact' | 'regular' | 'airy' | string
  docx_friendly?: boolean
}

export interface BriefSection {
  title: string
  type?: string
  brief: string
  layout?: string
  image_queries?: string[]
}

export interface Brief {
  core_hook: string
  style: BriefStyle
  /** other directions the model offered; the card lets the user swap one into `style`, never pinned */
  alternatives?: BriefStyle[]
  sections: BriefSection[]
  meta?: { title?: string; language?: string; audience?: string; length?: string }
  /** fields the user changed on the brief card, echoed to the model as [user edited] */
  user_edited?: string[]
  version: 1
}

export const BRIEF_META_NAME = 'seuoffice:brief'

/**
 * The pinned brief under either name: a page saved before the rename keeps the
 * old one until its brief is next pinned, which rewrites that tag in place.
 */
const META_RE = new RegExp(
  `<meta\\s+[^>]*name\\s*=\\s*["'](?:${[BRIEF_META_NAME, ...OLD_BRIEF_META_NAMES].join('|')})["'][^>]*>`,
  'i',
)

function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function encodeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function parseBrief(html: string): Brief | null {
  const tag = META_RE.exec(html)?.[0]
  if (!tag) return null
  const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
  const raw = content?.[1] ?? content?.[2]
  if (!raw) return null
  try {
    const parsed = JSON.parse(decodeAttr(raw)) as Partial<Brief>
    if (
      !parsed ||
      typeof parsed.core_hook !== 'string' ||
      !parsed.style ||
      !Array.isArray(parsed.sections)
    )
      return null
    return { ...(parsed as Brief), version: 1 }
  } catch {
    return null
  }
}

/** `name` is the tag's own name when it is re-pinned; a new pin is written under the name 0.12.37 reads. */
export function briefMetaTag(brief: Brief, name: string = BRIEF_META_NAME_WRITTEN): string {
  const json = JSON.stringify({ ...brief, alternatives: undefined, user_edited: undefined })
  return `<meta name="${name}" content='${encodeAttr(json)}'>`
}

/**
 * The single replacement that pins (or refreshes) the brief meta in the head:
 * the existing meta, or an anchor tag that gets the meta appended. null when the
 * meta is already current or nothing in the document can anchor it.
 */
export function briefPinEdit(html: string, brief: Brief): { old: string; new: string } | null {
  const existing = META_RE.exec(html)?.[0]
  if (existing) {
    const name = /name\s*=\s*["']([^"']*)["']/i.exec(existing)?.[1]
    const kept = briefMetaTag(brief, name)
    return existing === kept ? null : { old: existing, new: kept }
  }
  const tag = briefMetaTag(brief)
  for (const re of [/<meta\s+charset[^>]*>/i, /<head(?:\s[^>]*)?>/i]) {
    const anchor = re.exec(html)?.[0]
    if (anchor) return { old: anchor, new: `${anchor}\n${tag}` }
  }
  const htmlTag = /<html(?:\s[^>]*)?>/i.exec(html)?.[0]
  return htmlTag ? { old: htmlTag, new: `${htmlTag}\n<head>${tag}</head>` } : null
}

/** Pin (or refresh) the brief meta in the head; the rest of the document is untouched. */
export function injectBrief(html: string, brief: Brief): string {
  const edit = briefPinEdit(html, brief)
  if (!edit) return META_RE.test(html) ? html : `${briefMetaTag(brief)}\n${html}`
  return html.replace(edit.old, () => edit.new)
}

/** compact rendering for the per-turn AI context */
export function briefSummary(brief: Brief, maxChars = 700): string {
  const s = brief.style
  const kv = (obj: Record<string, string | undefined> | undefined) =>
    Object.entries(obj ?? {})
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
  const palette = kv(s.palette)
  const tokens = kv(s.tokens)
  const typo = [s.typography?.heading, s.typography?.body].filter(Boolean).join(' / ')
  const lines = [
    `core hook: ${brief.core_hook}`,
    `style: ${s.name ? `${s.name} — ` : ''}${s.tone}${s.layout ? `, ${s.layout}` : ''}${s.density ? `, ${s.density}` : ''}${s.docx_friendly ? ', docx-friendly' : ''}`,
    palette ? `palette: ${palette}` : '',
    typo ? `type: ${typo}` : '',
    tokens ? `tokens: ${tokens}` : '',
    `sections: ${brief.sections.map((x) => x.title).join(' · ')}`,
    brief.meta?.audience ? `audience: ${brief.meta.audience}` : '',
  ].filter(Boolean)
  const out = lines.join('\n')
  return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out
}
