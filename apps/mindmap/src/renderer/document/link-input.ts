/**
 * What the user typed into the link field of a topic.
 *
 * Every address is kept and shown as text, as one from a file is. Only a web
 * or mail address is ever opened, and only by the main process; this module
 * tells the user beforehand which kind an address is. It decides nothing about
 * opening.
 */
import { isInternalLink } from '@genoffice/xmind-engine'
import { openableLink } from '../../shared/links'

/**
 * - `empty`: nothing typed; storing it removes the link.
 * - `opens`: an address the main process opens when it is pressed.
 * - `kept`: stored and shown as text, never opened.
 * - `internal`: in the form of a reference into the map file (a link to
 *   another topic or to an attachment). Not taken: the editor does not show
 *   such links, so a typed one would vanish from the screen.
 */
export type LinkInputKind = 'empty' | 'opens' | 'kept' | 'internal'

/** The address to store for what was typed: trimmed, and with `https://` put before one that names no scheme. Null for nothing. */
export function linkFromInput(typed: string): string | null {
  const address = typed.trim()
  if (address === '') return null
  return /^[a-z][a-z0-9+.-]*:/i.test(address) ? address : `https://${address}`
}

export function linkInputKind(typed: string): LinkInputKind {
  const address = linkFromInput(typed)
  if (address === null) return 'empty'
  if (isInternalLink(address)) return 'internal'
  return openableLink(address) === null ? 'kept' : 'opens'
}
