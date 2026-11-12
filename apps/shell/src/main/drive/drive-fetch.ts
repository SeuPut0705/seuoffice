import { fetchSeeingRedirects, keyedDownload, keyedFetch } from '@genoffice/ai-provider'
import type { FetchLike } from '@genoffice/google-drive'

/**
 * The two fetches of the Drive connection, over the app's network calls:
 * Electron's `net.fetch` (the system proxy applies) and Node's fetch. Every
 * request carries a credential (the access token in `Authorization`; the
 * refresh token, the client secret and the sign-in code in a body), and
 * `net.fetch` repeats all of it at whatever address a redirect it follows
 * names. So neither fetch lets it follow one.
 *
 * `fetch`, for the token exchange and every Drive call but a file's bytes,
 * ends at a redirect (`keyedFetch`). Drive answers those calls directly; an
 * upload's session address arrives in a 200 and is checked by the Drive
 * client.
 *
 * `download`, for a file's bytes, follows a redirect by hand and leaves the
 * token behind when the next address is another origin (`keyedDownload`).
 * `net.fetch` cannot say where a redirect points (told not to follow, it
 * throws), so a hop it refuses is asked again over Node's fetch, which hands
 * the 3xx back. That hop is a GET and safe to repeat; a download Drive
 * answers with the bytes goes over `net.fetch` alone, as before.
 */
export function driveFetches(
  netFetch: FetchLike,
  nodeFetch: FetchLike,
): { fetch: FetchLike; download: FetchLike } {
  const hop = fetchSeeingRedirects(netFetch, nodeFetch)
  return {
    fetch: (url, init) => keyedFetch(url, init ?? {}, undefined, netFetch),
    download: (url, init) => keyedDownload(url, init ?? {}, { base: hop }),
  }
}
