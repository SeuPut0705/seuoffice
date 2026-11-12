import { keyedFetch } from '@genoffice/ai-provider'
import type { FetchLike } from '@genoffice/google-drive'

/**
 * The fetch of every Drive call and Google sign-in request, over the app's
 * network call. Each carries a credential (the access token in
 * `Authorization`; the refresh token, the client secret and the sign-in code
 * in a body), so none follows a redirect: Electron's `net.fetch`, which the
 * app passes in, repeats `Authorization` and the body at whatever address a
 * redirect names. Drive answers these calls directly; an upload's session
 * address arrives in a 200 and is checked by the Drive client.
 */
export function driveFetchOver(base: FetchLike): FetchLike {
  return (url, init) => keyedFetch(url, init ?? {}, undefined, base)
}
