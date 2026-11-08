/**
 * Which of a topic's links are opened.
 *
 * A map shows every link it holds as text, whatever the address is. Showing
 * is not opening: an address is handed to the system only when it passes
 * `safeExternalUrl` with the protocols below. The main process applies this
 * before it opens anything; the renderer uses the same function only to tell
 * the user beforehand that an address will not be opened.
 */
import { safeExternalUrl } from '@genoffice/electron-utils/safe-external-url'

/**
 * `file:`, `javascript:` and app schemes are refused by `safeExternalUrl` whatever is listed here.
 * `mailto:` stays openable on purpose: the engine treats it as a web link and the system hands it to the mail program.
 */
export const LINK_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:']

/** The address to open, or null when this one is never opened. */
export function openableLink(url: unknown): string | null {
  return safeExternalUrl(url, { allowedProtocols: LINK_PROTOCOLS })
}
