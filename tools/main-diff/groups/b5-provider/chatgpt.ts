/**
 * Group `b5-provider`, part `chatgpt` (Rust: crates/main-core/src/calls/b5_provider/chatgpt.rs):
 * packages/ai-provider/src/chatgpt/{oauth,credentials,connection,responses,status}.ts.
 * Names are `chatgpt/<file>.<export>`.
 *
 * An async function runs in the scripted world of world.ts (its first
 * argument; `null` where the function needs none). The loopback sign-in is the
 * world's `requests` (the browser coming back) and `calls` (`openBrowser`).
 *
 * - `connection` scenarios (`createChatGptConnection`, `setChatGptConnection`,
 *   `chatGptConnection`, `detectChatGptConnection` and the bridge cases of
 *   responses.ts) take a `spec`: `record` (the stored record; absent: a fresh
 *   host), `flaky` (`failRead`/`failWrite`: the store throws), `now` (the
 *   `deps.now` clock), `rescue` (the fetch module's rescue fetch), `agentName`,
 *   `verdicts` and the `ops` the scenario runs one after the other. An op is
 *   `{state}`, `{signIn: {timeoutMs}}`, `{signOut}`, `{accessToken:
 *   {signal: 'aborted'}}`, `{dropSession}`, `{onChange: name}`, `{offChange:
 *   name}`, `{parallel: [op...]}`, `{set: {failRead, failWrite}}`, `{current:
 *   'set' | 'clear' | 'is'}` and `{detect: 'argument' | 'null' | 'module'}`;
 *   its answer (or `{threw}`) is one entry of the result, whose `record` is
 *   the record in the store at the end.
 * - Rust has no crypto for ID token signatures (`JwtSignatureVerifier` is a
 *   seam). The TypeScript verifies for real; Rust is told the verdict of each
 *   check (`verdicts`: true, false, or 'throw' for a key that does not load),
 *   in the order the checks run. The TypeScript side fails when its own
 *   checks answer anything else, so the verdicts are proven, not assumed.
 * - A fake secret codec (`codec`): 'rev' seals by reversing (and cannot open a
 *   value ending in `!bad`), 'throw' throws, 'null' answers null, anything
 *   else registers none.
 */
import '../../electron-fake.ts'
import crypto from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import type { Case, Group, TsContext } from '../../types.ts'
import type { AiSecretCodec } from '../../../../packages/ai-provider/src/settings-secrets.ts'
import type { ChatGptConnection } from '../../../../packages/ai-provider/src/chatgpt/connection.ts'
import { V } from './chatgpt-vectors.ts'
import { errorLine, inWorld, type World, type WorldRun } from './world.ts'

// loaded after electron-fake.ts has registered its hooks, as every group
// loads the modules under test: a static import would resolve before them
const oauth = await import('../../../../packages/ai-provider/src/chatgpt/oauth.ts')
const creds = await import('../../../../packages/ai-provider/src/chatgpt/credentials.ts')
const conn = await import('../../../../packages/ai-provider/src/chatgpt/connection.ts')
const resp = await import('../../../../packages/ai-provider/src/chatgpt/responses.ts')
const status = await import('../../../../packages/ai-provider/src/chatgpt/status.ts')
const fetchMod = await import('../../../../packages/ai-provider/src/fetch.ts')
const secrets = await import('../../../../packages/ai-provider/src/settings-secrets.ts')

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any
type Verdict = boolean | 'throw'

const NOW = 1_700_000_000_000
const PLAN = 'chatgpt.tokens.use.direct'
const HOST = 'urn:uuid:11111111-2222-4333-8444-555555555555'
const PAGES = {
  done: { lang: 'en', title: 'Connected', body: 'Go back' },
  failed: { lang: 'en', title: 'Not connected', body: 'Try again' },
}
const T = V.tokens

// ---------------------------------------------------------------------------
// the world
// ---------------------------------------------------------------------------

const w = (fetches: unknown[] = [], more: Partial<World> & Record<string, unknown> = {}): World =>
  ({ fetches, ...more }) as World
const jsonRes = (
  body: unknown,
  status = 200,
  headers: [string, string][] = [['content-type', 'application/json']],
) => ({ status, headers, body: [JSON.stringify(body)] })
const textRes = (text: string, status = 200, headers: [string, string][] = []) => ({
  status,
  headers,
  body: [text],
})
const tokenBody = (over: Record<string, unknown> = {}) => ({
  access_token: 'at-new',
  refresh_token: 'rt-new',
  expires_in: 3600,
  scope: `openid ${PLAN}`,
  ...over,
})
const tokenOk = (over: Record<string, unknown> = {}) => jsonRes(tokenBody(over))
const jwks = (keys: unknown[] = [V.pubA]) => jsonRes({ keys })
const html403 = textRes('<html>blocked</html>', 403, [['content-type', 'text/html']])
/** the browser coming back after the first `openBrowser` */
const back = (query: string, extra: Record<string, unknown> = {}) => ({
  afterCall: 0,
  url: `/auth/callback?state=$state&${query}`,
  ...extra,
})
const signInWorld = (fetches: unknown[], more: Record<string, unknown> = {}): World =>
  w(fetches, {
    calls: [true],
    requests: [back('code=the-code&client_id=cid')],
    ...more,
  })

// ---------------------------------------------------------------------------
// what the TypeScript side does around a call
// ---------------------------------------------------------------------------

function prep(run: WorldRun, rescue?: boolean): void {
  fetchMod.setRescueFetch(rescue ? run.fetch('net') : null)
  fetchMod.setAiFetch(null)
  fetchMod.setAiUserAgent('')
  fetchMod.setAiTransientRetryDelays(null)
}

function codecOf(mode: string | null | undefined): AiSecretCodec | null {
  if (mode === 'rev') {
    return {
      seal: (plain) => `sealed:v1:${[...plain].reverse().join('')}`,
      open: (sealed) => (sealed.endsWith('!bad') ? null : [...sealed.slice(10)].reverse().join('')),
    }
  }
  if (mode === 'throw') {
    return {
      seal: () => {
        throw new Error('seal')
      },
      open: () => {
        throw new Error('open')
      },
    }
  }
  if (mode === 'null') return { seal: () => null, open: () => null }
  return null
}

/** A thrown value as the answer writes it */
function thrown(e: unknown): { threw: unknown } {
  const out = errorLine(e) as Record<string, unknown>
  // the legacy numeric `code` of a DOMException is not part of what is compared
  if (e instanceof DOMException) delete out.code
  const detail = e as { kind?: unknown; provider?: unknown }
  if (detail?.kind !== undefined) out.kind = detail.kind
  if (detail?.provider !== undefined) out.provider = detail.provider
  return { threw: out }
}

/** Runs `fn` and checks that the signature checks it made answered `expected`, in order */
async function tracked<T>(expected: Verdict[] | undefined, fn: () => Promise<T>): Promise<T> {
  const seen: Verdict[] = []
  const real = { createPublicKey: crypto.createPublicKey, verify: crypto.verify }
  ;(crypto as Any).createPublicKey = (...args: Any[]) => {
    try {
      const key = (real.createPublicKey as Any)(...args)
      seen.push(false)
      return key
    } catch (error) {
      seen.push('throw')
      throw error
    }
  }
  ;(crypto as Any).verify = (...args: Any[]) => {
    const ok = (real.verify as Any)(...args)
    seen[seen.length - 1] = ok
    return ok
  }
  syncBuiltinESMExports()
  try {
    const out = await fn()
    if (JSON.stringify(seen) !== JSON.stringify(expected ?? [])) {
      throw new Error(
        `the case's verdicts ${JSON.stringify(expected ?? [])} are not the real ones ${JSON.stringify(seen)}`,
      )
    }
    return out
  } finally {
    ;(crypto as Any).createPublicKey = real.createPublicKey
    ;(crypto as Any).verify = real.verify
    syncBuiltinESMExports()
  }
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

const sess = (over: Record<string, unknown> = {}) => ({
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: NOW + 3_600_000,
  scopes: [PLAN, 'openid'],
  ...over,
})
const STALE = NOW + 30_000
const EXPIRED = NOW - 1_000
interface RecOpts {
  clientId?: string
  callbackPath?: string
  subject?: string
  session?: Record<string, unknown>
}
const rec = (o: RecOpts = {}) => ({
  hostId: HOST,
  ...(o.clientId !== undefined ? { clientId: o.clientId } : {}),
  ...(o.callbackPath !== undefined ? { callbackPath: o.callbackPath } : {}),
  ...(o.subject !== undefined ? { subject: o.subject } : {}),
  ...(o.session !== undefined ? { session: o.session } : {}),
})
const signedIn = (over: Record<string, unknown> = {}, extra: RecOpts = {}) =>
  rec({
    clientId: 'cid',
    callbackPath: '/auth/callback',
    subject: 'acct-1',
    session: sess(over),
    ...extra,
  })

// ---------------------------------------------------------------------------
// oauth.ts
// ---------------------------------------------------------------------------

const c = (...args: unknown[]): Case => ({ args })

const oauthGroup: Group = {
  'chatgpt/oauth.chatGptPkcePair': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async () => {
        const skip = (o as { skip?: number }).skip ?? 0
        if (skip) crypto.randomBytes(skip)
        return oauth.chatGptPkcePair()
      }),
    cases: [c(null, {}), c(null, { skip: 7 }), c(null, { skip: 300 })],
  },
  'chatgpt/oauth.chatGptAttemptValues': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async () => {
        const skip = (o as { skip?: number }).skip ?? 0
        if (skip) crypto.randomBytes(skip)
        return oauth.chatGptAttemptValues()
      }),
    cases: [c(null, {}), c(null, { skip: 1 }), c(null, { skip: 64 })],
  },
  'chatgpt/oauth.chatGptRedirectUri': {
    ts: ([port, path]) =>
      path === undefined
        ? oauth.chatGptRedirectUri(port as number)
        : oauth.chatGptRedirectUri(port as number, path as string),
    cases: [
      c(40001),
      c(40001, '/callback'),
      c(0, '/auth/callback'),
      c(65535, ''),
      c(1.5, '/x'),
      c(1e21),
    ],
  },
  'chatgpt/oauth.chatGptAuthorizeUrl': {
    ts: ([params]) => oauth.chatGptAuthorizeUrl(params as Any),
    cases: [
      c({
        port: 40001,
        challenge: 'ch',
        state: 'st',
        nonce: 'no',
        hostId: HOST,
        agentName: 'SeuOffice',
      }),
      c({
        port: 40001,
        challenge: 'ch',
        state: 'st',
        nonce: 'no',
        hostId: HOST,
        clientId: 'cid-9',
        callbackPath: '/callback',
        agentName: 'SeuOffice',
      }),
      c({
        port: 5,
        challenge: 'a+b/c=',
        state: 'a b&c=d',
        nonce: "ü~*!'()",
        hostId: HOST,
        clientId: '',
        agentName: 'Seu Office & 한글',
      }),
      c({
        port: 1,
        challenge: 'ch',
        state: 'st',
        nonce: 'no',
        hostId: HOST,
        clientId: 'x',
        callbackPath: '/a/b',
        agentName: 'ignored',
      }),
    ],
  },
  'chatgpt/oauth.waitForChatGptCallback': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (run, signal) => {
        const opts = o as Any
        return oauth.waitForChatGptCallback({
          authorizeUrl: (port) => `https://auth.example/authorize?port=${port}&state=${opts.state}`,
          state: opts.state,
          ...(opts.callbackPath !== undefined ? { callbackPath: opts.callbackPath } : {}),
          ...(opts.clientId !== undefined ? { clientId: opts.clientId } : {}),
          openBrowser: run.call('openBrowser') as Any,
          pages: PAGES,
          signal,
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        })
      }),
    cases: [
      c(signInWorld([]), { state: 's1' }),
      c(
        w([], {
          calls: [true],
          requests: [{ afterCall: 0, url: '/callback?state=$state&code=c1&client_id=old' }],
        }),
        { state: 's2', callbackPath: '/callback' },
      ),
      c(w([], { calls: [true], requests: [back('code=c&client_id=other')] }), {
        state: 's3',
        clientId: 'mine',
      }),
      c(w([], { calls: [true], requests: [back('code=c')] }), { state: 's4', clientId: 'mine' }),
      c(w([], { calls: [true], requests: [back('code=c')] }), { state: 's5' }),
      c(w([], { calls: [true], requests: [back('client_id=cid')] }), { state: 's6' }),
      c(w([], { calls: [true], requests: [back('code=c&client_id=cid&error=access_denied')] }), {
        state: 's7',
      }),
      c(w([], { calls: [true], requests: [back('error=Bad%20Error!&client_id=cid')] }), {
        state: 's8',
      }),
      c(
        w([], {
          calls: [true],
          requests: [
            { afterCall: 0, url: '/auth/callback?state=wrong&code=c&client_id=cid' },
            {
              afterCall: 0,
              method: 'POST',
              url: '/auth/callback?state=$state&code=c&client_id=cid',
            },
            { afterCall: 0, url: '/elsewhere?state=$state&code=c&client_id=cid' },
            { afterCall: 0, url: '/auth/callback?code=c&client_id=cid' },
            back('code=c&client_id=cid'),
            back('code=again&client_id=cid'),
          ],
        }),
        { state: 's9' },
      ),
      c(w([], { calls: [true], requests: [back('state=dup&code=c&client_id=cid')] }), {
        state: 's10',
      }),
      c(w([], { calls: [true] }), { state: 's11', timeoutMs: 5000 }),
      c(w([], { calls: [true] }), { state: 's12' }),
      c(w([], { calls: [false] }), { state: 's13' }),
      c(w([], { calls: [{ reject: 'no browser' }] }), { state: 's14' }),
      c(w([], {}), { state: 's15' }),
      c(w([], { listenError: { message: 'address in use', code: 'EADDRINUSE' } }), {
        state: 's16',
      }),
      c(w([], { calls: [true], abortAt: 100 }), { state: 's17' }),
      c(w([], { calls: [0] }), { state: 's18' }),
      c(w([], { calls: [''] }), { state: 's19' }),
      c(w([], { calls: [{}], requests: [back('code=c&client_id=cid')] }), { state: 's20' }),
      c(
        w([], {
          calls: [true],
          requests: [back('code=a%2Bb%20c&client_id=c%2Fid')],
        }),
        { state: 's21' },
      ),
      c(
        w([], {
          calls: [true],
          requests: [back('code=&client_id=cid')],
        }),
        { state: 's22' },
      ),
      c(
        w([], {
          calls: [true],
          requests: [back('code=c&client_id=&error=')],
        }),
        { state: 's23', clientId: 'mine' },
      ),
    ],
  },
  'chatgpt/oauth.exchangeChatGptCode': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (run, signal) => {
        const opts = o as Any
        prep(run, opts.rescue)
        return oauth.exchangeChatGptCode(
          opts.request,
          undefined,
          signal,
          opts.now !== undefined ? () => opts.now : undefined,
        )
      }),
    cases: [
      c(w([tokenOk({ id_token: 'idt', extra: 1 })]), { request: req() }),
      c(w([tokenOk({ scope: undefined })]), { request: req({ callbackPath: '/callback' }) }),
      c(w([tokenOk({ expires_in: 0 })]), { request: req(), now: 5 }),
      c(w([tokenOk({ expires_in: '60' })]), { request: req(), now: 5 }),
      c(w([tokenOk({ expires_in: 120.5 })]), { request: req(), now: 1000 }),
      c(w([tokenOk({ scope: '  a   b\tc ' })]), { request: req() }),
      c(w([tokenOk({ scope: '' })]), { request: req() }),
      c(w([tokenOk({ id_token: '' })]), { request: req() }),
      c(w([tokenOk({ refresh_token: '' })]), { request: req() }),
      c(w([tokenOk({ access_token: 5 })]), { request: req() }),
      c(w([textRes('not json')]), { request: req() }),
      c(w([textRes('null')]), { request: req() }),
      c(w([textRes('"x"')]), { request: req() }),
      c(w([jsonRes({ error: 'invalid_grant' }, 400)]), { request: req() }),
      c(w([jsonRes({ error: 'access_denied' }, 401)]), { request: req() }),
      c(w([jsonRes({ error: 'Not An Id' }, 403)]), { request: req() }),
      c(w([jsonRes({ error: 7 }, 400)]), { request: req() }),
      c(w([textRes('<html>', 400)]), { request: req() }),
      c(w([jsonRes({ error: 'server_error' }, 500)]), { request: req() }),
      c(w([jsonRes({}, 404)]), { request: req() }),
      c(w([{ reject: { message: 'offline' } }]), { request: req() }),
      c(w([{ hang: true }], { abortAt: 100 }), { request: req() }),
      c(w([{ hang: true }]), { request: req() }),
      c(w([{ status: 302, headers: [['location', 'https://evil.example/x']], body: [''] }]), {
        request: req(),
      }),
      c(w([textRes('busy', 503), jsonRes({ error: 'invalid_grant' }, 400)]), { request: req() }),
      c(w([textRes('busy', 503), tokenOk({ id_token: 'idt' })]), { request: req() }),
      c(w([textRes('busy', 503), jsonRes({ error: 'invalid_request' }, 400)]), {
        request: req(),
      }),
      c(w([{ reject: { message: 'reset' } }, jsonRes({ error: 'invalid_grant' }, 400)]), {
        request: req(),
        rescue: true,
      }),
      c(w([html403, jsonRes({ error: 'invalid_grant' }, 400)]), { request: req(), rescue: true }),
      c(w([html403, textRes('<html>blocked</html>', 403, [['content-type', 'text/html']])]), {
        request: req(),
        rescue: true,
      }),
    ],
  },
  'chatgpt/oauth.refreshChatGptTokens': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (run, signal) => {
        const opts = o as Any
        prep(run, opts.rescue)
        return oauth.refreshChatGptTokens(
          { clientId: opts.clientId, refreshToken: opts.refreshToken },
          undefined,
          signal,
          opts.now !== undefined ? () => opts.now : undefined,
        )
      }),
    cases: [
      c(w([tokenOk({ id_token: 'idt' })]), refreshOpts()),
      c(w([tokenOk({ scope: undefined })]), refreshOpts({ now: 7 })),
      c(w([tokenOk({ expires_in: -5 })]), refreshOpts({ now: 7 })),
      c(w([textRes('{"access_token":"a"}')]), refreshOpts()),
      c(w([textRes('null')]), refreshOpts()),
      c(w([textRes('nope')]), refreshOpts()),
      ...[
        'invalid_grant',
        'invalid_refresh_token',
        'token_expired',
        'refresh_token_expired',
        'refresh_token_invalidated',
        'refresh_token_reused',
      ].map((error) => c(w([jsonRes({ error }, 400)]), refreshOpts())),
      c(w([jsonRes({ error: 'invalid_request' }, 400)]), refreshOpts()),
      c(w([jsonRes({ error: 'x' }, 401)]), refreshOpts()),
      c(w([textRes('', 401)]), refreshOpts()),
      c(w([textRes('null', 401)]), refreshOpts()),
      c(w([textRes('null', 400)]), refreshOpts()),
      c(w([textRes('<html>', 403)]), refreshOpts()),
      c(w([jsonRes({ error: 'invalid_grant' }, 429)]), refreshOpts()),
      c(w([jsonRes({ error: 'invalid_grant' }, 500)]), refreshOpts()),
      c(w([{ reject: { message: 'offline' } }]), refreshOpts()),
      c(w([{ hang: true }]), refreshOpts()),
      c(w([textRes('busy', 503), tokenOk()]), refreshOpts()),
    ],
  },
  'chatgpt/oauth.revokeChatGptSession': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (run, signal) => {
        const opts = o as Any
        prep(run)
        return oauth.revokeChatGptSession(
          { clientId: opts.clientId, refreshToken: opts.refreshToken },
          undefined,
          signal,
        )
      }),
    cases: [
      c(w([oidc(), textRes('{}')]), refreshOpts()),
      c(w([oidc(), textRes('', 500)]), refreshOpts()),
      c(w([oidc(), { reject: { message: 'offline' } }]), refreshOpts()),
      c(w([textRes('', 500)]), refreshOpts()),
      c(w([{ reject: { message: 'offline' } }]), refreshOpts()),
      c(w([jsonRes({})]), refreshOpts()),
      c(w([jsonRes({ revocation_endpoint: 5 })]), refreshOpts()),
      c(w([textRes('null')]), refreshOpts()),
      c(w([textRes('nope')]), refreshOpts()),
      c(w([oidc('https://evil.example/revoke')]), refreshOpts()),
      c(w([oidc('https://auth.openai.com.evil.example/revoke')]), refreshOpts()),
      c(w([oidc('http://auth.openai.com/revoke')]), refreshOpts()),
      c(w([oidc('https://auth.openai.com:8443/revoke')]), refreshOpts()),
      c(w([oidc('https://auth.openai.com:443/oauth/revoke'), textRes('{}')]), refreshOpts()),
      c(w([oidc('/relative/revoke')]), refreshOpts()),
      c(w([oidc('not a url')]), refreshOpts()),
      c(
        w([oidc(), { status: 302, headers: [['location', 'https://evil.example']], body: [''] }]),
        refreshOpts(),
      ),
      c(w([oidc(), { hang: true }], { abortAt: 500 }), refreshOpts()),
    ],
  },
  'chatgpt/oauth.fetchChatGptSigningKeys': {
    ts: ([world], cx) =>
      inWorld(world as World, cx, async (run, signal) => {
        prep(run)
        return oauth.fetchChatGptSigningKeys(undefined, signal)
      }),
    cases: [
      c(w([jwks([V.pubA, V.pubC])])),
      c(w([jsonRes({ keys: [V.pubA, 5, null, 'x', [1], { kid: 'z' }] })])),
      c(w([jsonRes({ keys: 'no' })])),
      c(w([jsonRes({})])),
      c(w([jsonRes([])])),
      c(w([textRes('null')])),
      c(w([textRes('nope')])),
      c(w([textRes('', 500)])),
      c(w([textRes('', 404)])),
      c(w([{ reject: { message: 'offline' } }])),
      c(w([{ hang: true }])),
      c(w([{ hang: true }], { abortAt: 1000 })),
    ],
  },
  'chatgpt/oauth.verifyChatGptIdToken': {
    ts: ([idToken, expected, keys, nowSeconds, verdicts]) =>
      tracked(verdicts as Verdict[], async () =>
        oauth.verifyChatGptIdToken(
          idToken as string,
          expected as Any,
          keys as Any,
          nowSeconds as number,
        ),
      ),
    cases: verifyCases(),
  },
}

function req(over: Record<string, unknown> = {}) {
  return { code: 'the-code', clientId: 'cid', verifier: 'ver', port: 40001, ...over }
}
function refreshOpts(over: Record<string, unknown> = {}) {
  return { clientId: 'cid', refreshToken: 'rt-1', ...over }
}
function oidc(endpoint = 'https://auth.openai.com/oauth/revoke') {
  return jsonRes({ revocation_endpoint: endpoint, issuer: 'https://auth.openai.com' })
}

function verifyCases(): Case[] {
  const exp = { clientId: 'cid', nonce: V.nonce1 }
  const now = 1_700_000_000
  const keys = [V.pubA]
  const v = (token: string, e: unknown, k: unknown, verdicts: Verdict[], at = now): Case =>
    c(token, e, k, at, verdicts)
  return [
    v(T.rsOk, exp, keys, [true]),
    v(T.rsOk, { clientId: 'cid' }, keys, [true]),
    v(T.esOk, exp, [V.pubC], [true]),
    v(T.esAsRs, exp, [V.pubC], [true]),
    v(T.rsNoNonce, { clientId: 'cid' }, keys, [true]),
    v(T.rsNoNonce, exp, keys, [true]),
    v(T.rsBadNonce, exp, keys, [true]),
    v(T.rsNoKid, exp, [V.pubB, V.pubA], [false, true]),
    v(T.rsNoKid, exp, [V.pubA, V.pubB], [true]),
    v(T.rsNoKid, exp, [V.pubB], [false]),
    v(T.rsEmptyKid, exp, [V.pubB, V.pubA], [false, true]),
    v(T.rsOk, exp, [V.pubB, V.pubA], [true]),
    v(T.rsSignedByB, exp, [V.pubA, V.pubB], [false]),
    v(T.rsNoKidSignedByB, exp, [V.pubA, V.pubB], [false, true]),
    v(T.rsOtherKid, exp, keys, []),
    v(T.rsOk, exp, [], []),
    v(T.rsOk, exp, [{ kty: 'RSA', kid: 'key-a' }], ['throw']),
    v(T.rsNoKid, exp, [{ kty: 'oct', k: 'AAAA' }, V.pubA], ['throw']),
    v(T.hs, exp, keys, [false]),
    v(T.noAlg, exp, keys, [false]),
    v(T.noneAlg, exp, keys, [false]),
    v(T.rsTampered, exp, keys, [false]),
    v(T.rsEmailNum, exp, keys, [true]),
    v(T.rsNoEmail, exp, keys, [true]),
    v(T.rsAudArr, exp, keys, [true]),
    v(T.rsAudOther, exp, keys, [true]),
    v(T.rsAudMissing, exp, keys, [true]),
    v(T.rsIss, exp, keys, [true]),
    v(T.rsExpired, exp, keys, [true]),
    v(T.rsSkew, exp, keys, [true]),
    v(T.rsSkew, exp, keys, [true], 1_700_000_100),
    v(T.rsExpStr, exp, keys, [true]),
    v(T.rsNoExp, exp, keys, [true]),
    v(T.rsNoSub, exp, keys, [true]),
    v(T.rsEmptySub, exp, keys, [true]),
    v(T.arrayPayload, exp, keys, []),
    v(T.badJsonHeader, exp, keys, []),
    v(T.twoParts, exp, keys, []),
    v(T.fourParts, exp, keys, []),
    v('', exp, keys, []),
    v(T.rsOk, exp, [V.pubA, null as never], []),
  ]
}

// ---------------------------------------------------------------------------
// credentials.ts
// ---------------------------------------------------------------------------

const opaque = (tail: string) => `sealed:v1:${[...tail].reverse().join('')}`

const credentialsGroup: Group = {
  'chatgpt/credentials.newChatGptHostId': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async () => {
        const skip = (o as { skip?: number }).skip ?? 0
        for (let n = 0; n < skip; n++) crypto.randomUUID()
        return creds.newChatGptHostId()
      }),
    cases: [c(null, {}), c(null, { skip: 3 }), c(null, { skip: 12 })],
  },
  'chatgpt/credentials.chatGptConnectionOf': {
    ts: ([world, value, codec], cx) =>
      inWorld(world as World, cx, async () => {
        secrets.setAiSecretCodec(codecOf(codec as string | null))
        try {
          return creds.chatGptConnectionOf(value)
        } finally {
          secrets.setAiSecretCodec(null)
        }
      }),
    cases: [
      c(null, null, null),
      c(null, 'text', null),
      c(null, [1], null),
      c(null, 5, null),
      c(null, {}, null),
      c(null, { hostId: HOST }, null),
      c(null, { hostId: HOST.toUpperCase().replace('URN:UUID:', 'urn:uuid:') }, null),
      c(null, { hostId: 'urn:uuid:short' }, null),
      c(null, { hostId: 5 }, null),
      c(null, { hostId: '' }, null),
      c(null, { hostId: `${HOST}0` }, null),
      c(
        null,
        {
          hostId: HOST,
          clientId: 'cid',
          callbackPath: '/callback',
          subject: 'acct',
          session: sess(),
        },
        null,
      ),
      c(null, { hostId: HOST, clientId: 'bad id!', callbackPath: '/callback' }, null),
      c(null, { hostId: HOST, clientId: 'x'.repeat(256), callbackPath: '/a' }, null),
      c(null, { hostId: HOST, clientId: 'x'.repeat(257), callbackPath: '/a' }, null),
      c(null, { hostId: HOST, clientId: '', callbackPath: '/a' }, null),
      c(null, { hostId: HOST, callbackPath: '/callback' }, null),
      c(null, { hostId: HOST, clientId: 'cid', callbackPath: 'callback' }, null),
      c(null, { hostId: HOST, clientId: 'cid', callbackPath: '/a/b/c/d' }, null),
      c(null, { hostId: HOST, clientId: 'cid', callbackPath: '/a/b/c/d/e' }, null),
      c(null, { hostId: HOST, clientId: 'cid', callbackPath: `/${'a'.repeat(33)}` }, null),
      c(null, { hostId: HOST, clientId: 'cid', callbackPath: '/a b' }, null),
      c(null, { hostId: HOST, clientId: 'cid', callbackPath: '/a/' }, null),
      c(null, { hostId: HOST, subject: 'x'.repeat(256) }, null),
      c(null, { hostId: HOST, subject: 'x'.repeat(257) }, null),
      c(null, { hostId: HOST, subject: '😀'.repeat(129) }, null),
      c(null, { hostId: HOST, subject: '' }, null),
      c(null, { hostId: HOST, subject: 5 }, null),
      c(null, { hostId: HOST, session: 'no' }, null),
      c(null, { hostId: HOST, session: [] }, null),
      c(null, { hostId: HOST, session: sess({ refreshToken: '' }) }, null),
      c(null, { hostId: HOST, session: sess({ accessToken: 5 }) }, null),
      c(null, { hostId: HOST, session: sess({ idToken: 'idt' }) }, null),
      c(null, { hostId: HOST, session: sess({ idToken: 5 }) }, null),
      c(null, { hostId: HOST, session: sess({ expiresAt: '5' }) }, null),
      c(null, { hostId: HOST, session: sess({ expiresAt: 1.5 }) }, null),
      c(null, { hostId: HOST, session: sess({ scopes: ['a', 5, null, 'b', {}] }) }, null),
      c(null, { hostId: HOST, session: sess({ scopes: 'a b' }) }, null),
      c(null, { hostId: HOST, session: { accessToken: 'a', refreshToken: 'r' } }, null),
      c(
        null,
        {
          hostId: HOST,
          session: sess({
            accessToken: opaque('open-at'),
            refreshToken: opaque('open-rt'),
            idToken: opaque('open-id'),
          }),
        },
        'rev',
      ),
      c(
        null,
        { hostId: HOST, session: sess({ accessToken: opaque('open-at'), refreshToken: 'plain' }) },
        'rev',
      ),
      c(
        null,
        { hostId: HOST, session: sess({ accessToken: `${opaque('x')}!bad`, refreshToken: 'r' }) },
        'rev',
      ),
      c(
        null,
        { hostId: HOST, session: sess({ refreshToken: `${opaque('x')}!bad`, idToken: 'idt' }) },
        'rev',
      ),
      c(null, { hostId: HOST, session: sess({ idToken: `${opaque('x')}!bad` }) }, 'rev'),
      c(null, { hostId: HOST, session: sess({ accessToken: opaque('open-at') }) }, null),
      c(null, { hostId: HOST, session: sess({ accessToken: opaque('open-at') }) }, 'throw'),
      c(null, { hostId: HOST, session: sess({ accessToken: opaque('open-at') }) }, 'null'),
      c(null, { hostId: HOST, session: sess() }, 'throw'),
    ],
  },
  'chatgpt/credentials.storedChatGptConnection': {
    ts: ([world, record, codec], cx) =>
      inWorld(world as World, cx, async () => {
        secrets.setAiSecretCodec(codecOf(codec as string | null))
        try {
          return creds.storedChatGptConnection(record as Any)
        } finally {
          secrets.setAiSecretCodec(null)
        }
      }),
    cases: [
      c(null, rec(), null),
      c(null, signedIn(), null),
      c(null, signedIn(), 'rev'),
      c(null, signedIn({ idToken: 'idt' }), 'rev'),
      c(null, signedIn({ idToken: 'idt' }), 'null'),
      c(null, signedIn({ idToken: 'idt' }), 'throw'),
      c(null, signedIn({ idToken: '' }), 'rev'),
      c(null, signedIn({ accessToken: opaque('already') }), 'rev'),
      c(null, signedIn({ accessToken: '' }), 'rev'),
      c(null, rec({ callbackPath: '/callback', subject: 'acct' }), null),
      c(null, rec({ clientId: 'cid', subject: '' }), null),
      c(null, rec({ clientId: '', callbackPath: '/callback' }), null),
      c(null, rec({ clientId: 'cid', callbackPath: '' }), null),
      c(null, rec({ clientId: 'cid', session: sess({ scopes: [] }) }), 'rev'),
    ],
  },
  'chatgpt/credentials.createChatGptConnectionFileStore': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async () => {
        const opts = o as Any
        secrets.setAiSecretCodec(codecOf(opts.codec))
        try {
          const store = creds.createChatGptConnectionFileStore(opts.dataDir)
          const results: unknown[] = []
          for (const op of opts.ops as Any[]) {
            if ('read' in op) results.push({ read: await store.read() })
            else {
              try {
                await store.write(op.write)
                results.push({ write: 'ok' })
              } catch (error) {
                results.push({ write: { error: (error as { code?: string }).code ?? null } })
              }
            }
          }
          const dir = await readdir(opts.dataDir).catch(() => null)
          const file = await readFile(
            join(opts.dataDir, creds.CHATGPT_CONNECTION_FILE),
            'utf8',
          ).catch(() => null)
          return { results, dir: dir ? dir.sort() : null, file }
        } finally {
          secrets.setAiSecretCodec(null)
        }
      }),
    cases: [
      c(null, { dataDir: '$DIR/data', ops: [{ read: 1 }, { read: 1 }] }),
      c(null, { dataDir: '$DIR/data', ops: [{ read: 1 }, { write: signedIn() }, { read: 1 }] }),
      c(null, {
        dataDir: '$DIR/data',
        codec: 'rev',
        ops: [{ write: signedIn({ idToken: 'idt' }) }, { read: 1 }],
      }),
      c(null, {
        dataDir: '$DIR/data',
        codec: 'null',
        ops: [{ write: signedIn({ idToken: 'idt' }) }, { read: 1 }],
      }),
      c(null, {
        dataDir: '$DIR/data',
        ops: [{ read: 1 }, { write: rec() }, { write: signedIn() }, { read: 1 }, { read: 1 }],
      }),
      c(null, {
        dataDir: '$DIR/data',
        ops: [{ write: rec({ clientId: 'cid', callbackPath: '/callback' }) }],
      }),
      withFiles(
        { 'data/chatgpt-connection.json': 'not json at all' },
        { dataDir: '$DIR/data', ops: [{ read: 1 }, { read: 1 }, { write: rec() }, { read: 1 }] },
      ),
      withFiles(
        { 'data/chatgpt-connection.json': 'null' },
        { dataDir: '$DIR/data', ops: [{ read: 1 }, { read: 1 }] },
      ),
      withFiles(
        { 'data/chatgpt-connection.json': JSON.stringify(signedIn()) },
        { dataDir: '$DIR/data', ops: [{ read: 1 }] },
      ),
      withFiles(
        { 'data/chatgpt-connection.json': JSON.stringify({ hostId: 'bad', subject: 5 }) },
        { dataDir: '$DIR/data', ops: [{ read: 1 }] },
      ),
      withFiles(
        { 'data/chatgpt-connection.json': { hex: 'efbbbf7b7d' } },
        { dataDir: '$DIR/data', ops: [{ read: 1 }] },
      ),
      withFiles(
        {
          'data/chatgpt-connection.json': JSON.stringify({
            hostId: HOST,
            session: sess({ accessToken: opaque('a'), refreshToken: opaque('r') }),
          }),
        },
        { dataDir: '$DIR/data', codec: 'rev', ops: [{ read: 1 }] },
      ),
      withFiles(
        { 'data/chatgpt-connection.json': { dir: true } },
        { dataDir: '$DIR/data', ops: [{ read: 1 }, { write: rec() }, { read: 1 }] },
      ),
      withFiles(
        { data: 'a file where the folder goes' },
        { dataDir: '$DIR/data', ops: [{ read: 1 }, { write: rec() }] },
      ),
      withFiles(
        { 'data/chatgpt-connection.json': JSON.stringify(rec()) },
        {
          dataDir: '$DIR/data',
          ops: [{ write: signedIn() }, { write: rec({ clientId: 'second' }) }],
        },
      ),
    ],
  },
  'chatgpt/credentials.createChatGptConnectionMemoryStore': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async () => {
        const opts = o as Any
        const store = creds.createChatGptConnectionMemoryStore(opts.initial)
        const results: unknown[] = []
        for (const op of opts.ops as Any[]) {
          if ('read' in op) results.push({ read: await store.read() })
          else if ('current' in op) results.push({ current: store.current() })
          else {
            await store.write(op.write)
            results.push({ write: 'ok' })
          }
        }
        return results
      }),
    cases: [
      c(null, { ops: [{ read: 1 }, { current: 1 }] }),
      c(null, { initial: signedIn(), ops: [{ read: 1 }, { current: 1 }] }),
      c(null, { ops: [{ write: signedIn() }, { read: 1 }, { write: rec() }, { current: 1 }] }),
      c(null, { initial: rec(), ops: [{ write: rec({ clientId: 'a' }) }, { read: 1 }] }),
    ],
  },
}

function withFiles(files: Case['files'], args: unknown): Case {
  return { args: [null, args], files }
}

// ---------------------------------------------------------------------------
// the connection scenarios
// ---------------------------------------------------------------------------

interface Spec {
  record?: Any
  flaky?: { failRead?: boolean; failWrite?: boolean }
  now?: number
  rescue?: boolean
  agentName?: string
  verdicts?: Verdict[]
  ops?: Any[]
}

function memoryStoreOf(spec: Spec) {
  const memory = creds.createChatGptConnectionMemoryStore(spec.record)
  const flaky = {
    failRead: spec.flaky?.failRead === true,
    failWrite: spec.flaky?.failWrite === true,
  }
  const store = {
    read: async () => {
      if (flaky.failRead) throw new Error('disk read')
      return memory.read()
    },
    write: async (next: Any) => {
      if (flaky.failWrite) throw new Error('disk full')
      return memory.write(next)
    },
  }
  return { memory, flaky, store }
}

interface Made {
  memory: { current(): unknown }
  flaky: { failRead: boolean; failWrite: boolean }
  connection: ChatGptConnection
}

function connectionOf(run: WorldRun, spec: Spec): Made {
  prep(run, spec.rescue)
  const made = memoryStoreOf(spec)
  const connection = conn.createChatGptConnection({
    store: made.store,
    agentName: spec.agentName ?? 'SeuOffice',
    ...(spec.now !== undefined ? { now: () => spec.now as number } : {}),
  })
  return { memory: made.memory, flaky: made.flaky, connection }
}

/** Runs the ops of a scenario; one entry per op */
async function runOps(
  run: WorldRun,
  signal: AbortSignal,
  cx: TsContext,
  made: Made,
  ops: Any[],
): Promise<unknown[]> {
  const { connection, flaky } = made
  // `onChange` answers its unsubscribe function: kept by the listener's name
  const offs = new Map<string, () => boolean>()
  const one = async (op: Any): Promise<unknown> => {
    try {
      if ('state' in op) return { state: await connection.state() }
      if ('signIn' in op) {
        const given = op.signIn ?? {}
        return {
          signIn: await connection.signIn({
            openBrowser: run.call('openBrowser') as Any,
            pages: PAGES,
            signal,
            ...(given.timeoutMs !== undefined ? { timeoutMs: given.timeoutMs } : {}),
          }),
        }
      }
      if ('signOut' in op) {
        await connection.signOut()
        return { signOut: null }
      }
      if ('accessToken' in op) {
        const given = op.accessToken ?? {}
        if (given.signal === 'aborted') {
          const controller = new AbortController()
          controller.abort()
          return { accessToken: await connection.accessToken(controller.signal) }
        }
        if (given.signal === 'world') return { accessToken: await connection.accessToken(signal) }
        return { accessToken: await connection.accessToken() }
      }
      if ('dropSession' in op) {
        await connection.dropSession()
        return { dropSession: null }
      }
      if ('onChange' in op) {
        const name = op.onChange as string
        offs.set(name, connection.onChange(() => cx.log('change', name)) as () => boolean)
        return { onChange: null }
      }
      if ('offChange' in op) return { offChange: offs.get(op.offChange as string)?.() ?? null }
      if ('parallel' in op) return { parallel: await Promise.all((op.parallel as Any[]).map(one)) }
      if ('set' in op) {
        if (op.set.failRead !== undefined) flaky.failRead = op.set.failRead
        if (op.set.failWrite !== undefined) flaky.failWrite = op.set.failWrite
        return { set: null }
      }
      if ('current' in op) {
        if (op.current === 'set') conn.setChatGptConnection(connection)
        else if (op.current === 'clear') conn.setChatGptConnection(null)
        else return { current: conn.chatGptConnection() === connection }
        return { current: null }
      }
      if ('detect' in op) {
        if (op.detect === 'null') return { detect: await status.detectChatGptConnection(null) }
        if (op.detect === 'module') return { detect: await status.detectChatGptConnection() }
        return { detect: await status.detectChatGptConnection(connection) }
      }
      throw new Error(`unknown op ${JSON.stringify(op)}`)
    } catch (error) {
      return thrown(error)
    }
  }
  const results: unknown[] = []
  for (const op of ops) {
    results.push(await one(op))
    // a real file system call lets the work the op left running (an account read after a
    // refresh) go on before the next op reads: the Rust spec does the same
    for (let turn = 0; turn < 12; turn++) await stat('/nonexistent-settle').catch(() => undefined)
  }
  return results
}

function scenario(run: WorldRun, signal: AbortSignal, cx: TsContext, spec: Spec) {
  conn.setChatGptConnection(null)
  const made = connectionOf(run, spec)
  return tracked(spec.verdicts, async () => {
    try {
      const results = await runOps(run, signal, cx, made, spec.ops ?? [])
      // work the ops left running (an account read after a refresh) ends here
      for (let turn = 0; turn < 2; turn++) await new Promise((r) => setImmediate(r))
      return { results, record: made.memory.current() }
    } finally {
      conn.setChatGptConnection(null)
    }
  })
}

const scenarioTs =
  () =>
  ([world, spec]: unknown[], cx: TsContext) =>
    inWorld(world as World, cx, (run, signal) => scenario(run, signal, cx, spec as Spec))

/** a world for a successful sign-in with the first token of the vectors */
const signIn = (tokenId: string = T.rsOk, scope: string | undefined = undefined) =>
  signInWorld([tokenOk({ id_token: tokenId, ...(scope !== undefined ? { scope } : {}) }), jwks()])
const refreshed = (over: Record<string, unknown> = {}) => tokenOk({ id_token: T.refresh, ...over })

const connectionCases: Case[] = [
  // state
  c(w(), { ops: [{ state: 1 }] }),
  c(w(), { record: signedIn(), ops: [{ state: 1 }] }),
  c(w(), { record: signedIn(), flaky: { failRead: true }, ops: [{ state: 1 }] }),
  // sign-in
  c(signIn(), { verdicts: [true], ops: [{ signIn: {} }, { state: 1 }] }),
  c(signIn(), { verdicts: [true], record: rec(), ops: [{ signIn: {} }] }),
  c(signIn(T.rsOk, 'openid profile'), { verdicts: [true], ops: [{ signIn: {} }] }),
  c(signIn(T.rsOk, ''), { verdicts: [true], ops: [{ signIn: {} }] }),
  c(signInWorld([jsonRes(tokenBody({ id_token: T.rsOk, scope: undefined })), jwks()]), {
    verdicts: [true],
    ops: [{ signIn: {} }],
  }),
  c(signIn(T.rsNoEmail), { verdicts: [true], ops: [{ signIn: {} }, { state: 1 }] }),
  c(signInWorld([tokenOk({ id_token: T.rsOk }), jwks()]), {
    verdicts: [true],
    record: signedIn({}, { subject: 'old', clientId: 'cid' }),
    ops: [{ signIn: {} }],
  }),
  c(
    w([tokenOk({ id_token: T.rsOk }), jwks()], {
      calls: [true],
      requests: [{ afterCall: 0, url: '/callback?state=$state&code=the-code' }],
    }),
    {
      verdicts: [true],
      record: rec({ clientId: 'cid', subject: 'old', session: sess() }),
      ops: [{ signIn: {} }],
    },
  ),
  c(
    w([tokenOk({ id_token: T.rsOk }), jwks()], {
      calls: [true],
      requests: [{ afterCall: 0, url: '/custom/cb?state=$state&code=the-code' }],
    }),
    {
      verdicts: [true],
      record: rec({ clientId: 'cid', callbackPath: '/custom/cb' }),
      ops: [{ signIn: {} }],
    },
  ),
  c(w([], { calls: [true], requests: [back('code=c&client_id=other')] }), {
    record: rec({ clientId: 'cid' }),
    ops: [{ signIn: {} }],
  }),
  c(w([], { calls: [true], requests: [back('error=access_denied')] }), { ops: [{ signIn: {} }] }),
  c(w([], { calls: [true] }), { ops: [{ signIn: { timeoutMs: 1000 } }] }),
  c(w([], { calls: [false] }), { ops: [{ signIn: {} }] }),
  c(w([], { calls: [true], abortAt: 50 }), { ops: [{ signIn: {} }] }),
  c(w([], { listenError: { message: 'in use', code: 'EADDRINUSE' } }), { ops: [{ signIn: {} }] }),
  c(signInWorld([jsonRes({ error: 'invalid_grant' }, 400)]), { ops: [{ signIn: {} }] }),
  c(signInWorld([{ reject: { message: 'offline' } }]), { ops: [{ signIn: {} }] }),
  c(signInWorld([tokenOk({})]), { ops: [{ signIn: {} }] }),
  c(signInWorld([tokenOk({ id_token: T.rsOk }), textRes('', 500)]), { ops: [{ signIn: {} }] }),
  c(signInWorld([tokenOk({ id_token: T.rsOk }), { hang: true }], { abortAt: 5000 }), {
    ops: [{ signIn: {} }],
  }),
  c(signInWorld([tokenOk({ id_token: T.rsNoKid }), jwks([V.pubB])]), {
    verdicts: [false],
    ops: [{ signIn: {} }],
  }),
  c(signInWorld([tokenOk({ id_token: T.rsBadNonce }), jwks()]), {
    verdicts: [true],
    ops: [{ signIn: {} }],
  }),
  c(signInWorld([tokenOk({ id_token: T.refreshBadAud }), jwks()]), {
    verdicts: [true],
    ops: [{ signIn: {} }],
  }),
  c(signInWorld([tokenOk({ id_token: T.rsNoKid }), jwks([V.pubB])]), {
    verdicts: [false],
    record: signedIn(),
    ops: [{ signIn: {} }, { state: 1 }],
  }),
  c(signInWorld([tokenOk({ id_token: T.rsOk }), jwks()]), {
    verdicts: [true],
    flaky: { failWrite: true },
    ops: [{ signIn: {} }],
  }),
  c(signInWorld([tokenOk({ id_token: T.rsOk }), jwks()]), {
    verdicts: [],
    flaky: { failRead: true },
    ops: [{ signIn: {} }],
  }),
  c(
    w([tokenOk({ id_token: T.rsOk }), jwks(), tokenOk({ id_token: T.rsOk2 }), jwks()], {
      calls: [true, true],
      requests: [
        back('code=the-code&client_id=cid'),
        { afterCall: 1, url: '/auth/callback?state=$state&code=c2&client_id=cid' },
      ],
    }),
    {
      verdicts: [true, true],
      ops: [{ onChange: 'a' }, { signIn: {} }, { signIn: {} }, { state: 1 }],
    },
  ),
  // access token
  c(w(), { record: signedIn(), ops: [{ accessToken: {} }] }),
  c(w(), { ops: [{ accessToken: {} }] }),
  c(w(), { record: rec({ session: sess() }), ops: [{ accessToken: {} }] }),
  c(w(), { record: signedIn(), ops: [{ accessToken: { signal: 'aborted' } }] }),
  c(w(), { record: signedIn(), ops: [{ accessToken: { signal: 'world' } }] }),
  c(w(), { record: signedIn(), flaky: { failRead: true }, ops: [{ accessToken: {} }] }),
  c(w([refreshed(), jwks()]), {
    verdicts: [true],
    record: signedIn({ expiresAt: STALE, idToken: 'old-id' }),
    ops: [{ accessToken: {} }, { state: 1 }, { accessToken: {} }],
  }),
  c(w([tokenOk()]), {
    record: signedIn({ expiresAt: STALE, idToken: 'old-id' }),
    ops: [{ accessToken: {} }],
  }),
  c(w([refreshed({ id_token: undefined })]), {
    record: signedIn({ expiresAt: EXPIRED }),
    ops: [{ accessToken: {} }],
  }),
  c(w([refreshed(), jwks()]), {
    verdicts: [true],
    record: signedIn({ expiresAt: STALE }),
    ops: [
      { parallel: [{ accessToken: {} }, { accessToken: {} }, { accessToken: {} }] },
      { state: 1 },
    ],
  }),
  c(w([refreshed(), jwks()]), {
    verdicts: [true],
    record: signedIn({ expiresAt: STALE }),
    ops: [{ accessToken: {} }, { set: { failWrite: false } }, { accessToken: {} }],
  }),
  c(w([refreshed(), jwks()]), {
    verdicts: [true],
    now: NOW + 100_000,
    record: signedIn({ expiresAt: NOW + 120_000 }),
    ops: [{ accessToken: {} }],
  }),
  c(w([tokenOk({ id_token: T.rsNoKid }), jwks([V.pubB])]), {
    verdicts: [false],
    record: signedIn({ expiresAt: STALE }),
    ops: [{ accessToken: {} }, { state: 1 }],
  }),
  c(w([tokenOk({ id_token: T.refreshNoEmail }), jwks()]), {
    verdicts: [true],
    record: signedIn({ expiresAt: STALE }),
    ops: [{ accessToken: {} }, { state: 1 }],
  }),
  c(w([tokenOk({ id_token: T.refresh }), textRes('', 500)]), {
    record: signedIn({ expiresAt: STALE }),
    ops: [{ accessToken: {} }, { state: 1 }],
  }),
  c(w([jsonRes({ error: 'invalid_grant' }, 400)]), {
    record: signedIn({ expiresAt: STALE }),
    ops: [{ onChange: 'x' }, { accessToken: {} }, { state: 1 }],
  }),
  c(w([jsonRes({ error: 'invalid_grant' }, 400)]), {
    record: signedIn({ expiresAt: STALE }),
    flaky: { failWrite: true },
    ops: [{ accessToken: {} }],
  }),
  c(w([textRes('', 500)]), {
    record: signedIn({ expiresAt: STALE }),
    ops: [{ accessToken: {} }, { state: 1 }],
  }),
  c(w([textRes('', 500)]), {
    record: signedIn({ expiresAt: EXPIRED }),
    ops: [{ accessToken: {} }],
  }),
  c(w([{ reject: { message: 'offline' } }]), {
    record: signedIn({ expiresAt: STALE }),
    ops: [{ accessToken: {} }],
  }),
  c(w([{ reject: { message: 'offline' } }]), {
    record: signedIn({ expiresAt: EXPIRED }),
    ops: [{ accessToken: {} }],
  }),
  c(w([refreshed()]), {
    record: signedIn({ expiresAt: STALE }),
    flaky: { failWrite: true },
    ops: [{ accessToken: {} }],
  }),
  c(w([tokenOk()]), {
    record: rec({ clientId: 'cid', session: sess({ expiresAt: STALE }) }),
    ops: [{ accessToken: {} }],
  }),
  c(w(), { record: rec({ session: sess({ expiresAt: STALE }) }), ops: [{ accessToken: {} }] }),
  // sign-out and drop
  c(w([oidc(), textRes('{}')]), {
    record: signedIn({ idToken: 'idt' }),
    ops: [{ onChange: 'a' }, { onChange: 'b' }, { offChange: 'b' }, { signOut: 1 }, { state: 1 }],
  }),
  c(w(), { record: rec({ clientId: 'cid' }), ops: [{ signOut: 1 }] }),
  c(w(), { ops: [{ signOut: 1 }] }),
  c(w([textRes('', 500)]), { record: signedIn(), ops: [{ signOut: 1 }] }),
  c(w([{ reject: { message: 'offline' } }]), { record: signedIn(), ops: [{ signOut: 1 }] }),
  c(w([oidc(), textRes('{}')]), {
    record: signedIn(),
    flaky: { failWrite: true },
    ops: [{ onChange: 'a' }, { signOut: 1 }, { state: 1 }],
  }),
  c(w(), {
    record: signedIn(),
    ops: [{ onChange: 'a' }, { dropSession: 1 }, { dropSession: 1 }, { state: 1 }],
  }),
  c(w(), { ops: [{ onChange: 'a' }, { dropSession: 1 }] }),
  c(w(), { record: signedIn(), flaky: { failWrite: true }, ops: [{ dropSession: 1 }] }),
  c(w(), { record: signedIn(), flaky: { failRead: true }, ops: [{ dropSession: 1 }] }),
  c(w(), {
    record: signedIn(),
    ops: [{ onChange: 'a' }, { dropSession: 1 }, { offChange: 'a' }, { offChange: 'a' }],
  }),
]

const connectionGroup: Group = {
  'chatgpt/connection.createChatGptConnection': { ts: scenarioTs(), cases: connectionCases },
  'chatgpt/connection.setChatGptConnection': {
    ts: scenarioTs(),
    cases: [
      c(w(), {
        ops: [{ current: 'set' }, { current: 'is' }, { current: 'clear' }, { current: 'is' }],
      }),
      c(w(), { record: signedIn(), ops: [{ current: 'is' }, { detect: 'module' }] }),
      c(w(), {
        record: signedIn(),
        ops: [{ current: 'set' }, { detect: 'module' }, { detect: 'null' }],
      }),
    ],
  },
  'chatgpt/connection.chatGptConnection': {
    ts: scenarioTs(),
    cases: [
      c(w(), { ops: [{ current: 'is' }] }),
      c(w(), { ops: [{ current: 'set' }, { current: 'is' }] }),
    ],
  },
}

const statusGroup: Group = {
  'chatgpt/status.detectChatGptConnection': {
    ts: scenarioTs(),
    cases: [
      c(w(), { ops: [{ detect: 'argument' }] }),
      c(w(), { record: signedIn(), ops: [{ detect: 'argument' }] }),
      c(w(), { record: signedIn(), ops: [{ detect: 'null' }] }),
      c(w(), { record: signedIn(), flaky: { failRead: true }, ops: [{ detect: 'argument' }] }),
      c(w([refreshed(), jwks()]), {
        verdicts: [true],
        record: signedIn({ expiresAt: STALE }),
        ops: [{ accessToken: {} }, { detect: 'argument' }],
      }),
      c(w([refreshed({ id_token: T.refreshNoEmail }), jwks()]), {
        verdicts: [true],
        record: signedIn({ expiresAt: STALE }),
        ops: [{ accessToken: {} }, { detect: 'argument' }],
      }),
      c(w(), { record: signedIn(), ops: [{ current: 'set' }, { detect: 'module' }] }),
      c(w(), { record: signedIn(), ops: [{ detect: 'module' }] }),
      c(w(), { record: signedIn(), ops: [{ dropSession: 1 }, { detect: 'argument' }] }),
    ],
  },
}

// ---------------------------------------------------------------------------
// responses.ts
// ---------------------------------------------------------------------------

const sseLine = (data: unknown) =>
  `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
const delta = (text: string) => ({ type: 'response.output_text.delta', delta: text })
const completed = (usage?: unknown) => ({
  type: 'response.completed',
  response: { usage: usage ?? { input_tokens: 10, output_tokens: 5 } },
})
const sse = (events: unknown[], status = 200) => ({
  status,
  headers: [['content-type', 'text/event-stream']],
  body: events.map(sseLine),
})
/** the JSON answer the model writes, cut into stream deltas */
const turn = (text: string, calls: unknown[] = [], cut = 7): unknown[] => {
  const json = JSON.stringify({ text, toolCalls: calls })
  const parts: string[] = []
  for (let at = 0; at < json.length; at += cut) parts.push(json.slice(at, at + cut))
  return [...parts.map(delta), completed()]
}
const TOOLS = [
  { name: 'read_doc', description: 'Read', inputSchema: { type: 'object', properties: {} } },
  { name: 'write_doc', description: 'Write', inputSchema: { type: 'object', properties: {} } },
]
const MSGS = [{ role: 'user', text: 'Hello' }]
const fresh = () => signedIn()
const bridgeWorld = (fetches: unknown[], more: Record<string, unknown> = {}) => w(fetches, more)

interface BridgeOpts {
  config?: Any
  system?: string
  messages?: Any[]
  tools?: Any[]
  maxTokens?: number
  connection?: 'conn' | 'null' | 'module' | 'absent'
  activity?: boolean
}

function bridgeDeps(made: Made, o: BridgeOpts): Any {
  const mode = o.connection ?? 'conn'
  if (mode === 'null') return { connection: null }
  if (mode === 'module') {
    conn.setChatGptConnection(made.connection)
    return {}
  }
  if (mode === 'absent') return {}
  return { connection: made.connection }
}

function callbacksOf(cx: TsContext, o: BridgeOpts, signal: AbortSignal): Any {
  return {
    signal,
    onDelta: (text: string) => cx.log('delta', text),
    onToolCall: (call: unknown) => cx.log('tool', call),
    onStopReason: (reason: string) => cx.log('stop', reason),
    onUsage: (usage: unknown) => cx.log('usage', usage),
    onInputTruncated: () => cx.log('truncated'),
    ...(o.activity ? { onActivity: () => cx.log('activity') } : {}),
  }
}

const bridgeTs =
  (kind: 'stream' | 'chat') =>
  ([world, spec, o]: unknown[], cx: TsContext) =>
    inWorld(world as World, cx, async (run, signal) => {
      const opts = o as BridgeOpts
      conn.setChatGptConnection(null)
      const made = connectionOf(run, spec as Spec)
      return tracked((spec as Spec).verdicts, async () => {
        try {
          const deps = bridgeDeps(made, opts)
          const config = opts.config ?? { apiKey: '', model: 'gpt-5' }
          let outcome: unknown
          try {
            if (kind === 'stream') {
              await resp.streamChatGpt(
                config,
                opts.system ?? 'You are helpful.',
                (opts.messages ?? MSGS) as Any,
                (opts.tools ?? TOOLS) as Any,
                opts.maxTokens ?? 1000,
                callbacksOf(cx, opts, signal),
                deps,
              )
              outcome = { done: true }
            } else {
              outcome = {
                chat: await resp.chatChatGpt(
                  config,
                  opts.system ?? 'You are helpful.',
                  (opts.messages as Any)?.[0]?.text ?? 'Hello',
                  signal,
                  deps,
                ),
              }
            }
          } catch (error) {
            outcome = thrown(error)
          }
          return { outcome, record: made.memory.current() }
        } finally {
          conn.setChatGptConnection(null)
        }
      })
    })

const stream = (events: unknown[], status = 200) => bridgeWorld([sse(events, status)])
const streamCase = (world: World, o: BridgeOpts = {}, spec: Spec = { record: fresh() }): Case =>
  c(world, spec, o)

const responsesGroup: Group = {
  'chatgpt/responses.chatGptInputParts': {
    ts: ([system, content]) => resp.chatGptInputParts(system as Any, content as Any),
    cases: [
      c([], []),
      c(['sys'], [{ type: 'text', text: 'hi' }]),
      c(['a', '  ', '', '\n\t', 'b'], [{ type: 'text', text: 'x' }]),
      c(
        ['sys'],
        [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: '' },
        ],
      ),
      c(
        [' '],
        [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'Zg==' } }],
      ),
    ],
  },
  'chatgpt/responses.chatGptRequestBody': {
    ts: ([model, parts]) => resp.chatGptRequestBody(model as string, parts as Any),
    cases: [
      c('gpt-5', [{ type: 'input_text', text: 'hi' }]),
      c('m', []),
      c('gpt-5', [
        { type: 'input_text', text: 'quote " and \\ and \n' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      ]),
      c('한글', [{ type: 'input_text', text: '😀' }]),
    ],
  },
  'chatgpt/responses.chatGptModelsOf': {
    ts: ([body]) => resp.chatGptModelsOf(body),
    cases: [
      c({ models: [{ slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list' }] }),
      c({ data: [{ id: 'gpt-5-mini' }, { id: 'o3', display_name: '' }] }),
      c({
        models: [
          { slug: 'hidden', visibility: 'hide' },
          { slug: 'a', visibility: null },
          { slug: 'b', visibility: 'list' },
        ],
      }),
      c({ models: [{ slug: 'a' }], data: [{ id: 'b' }] }),
      c({ models: 'x', data: [{ id: 'b' }] }),
      c({
        models: [
          5,
          null,
          'x',
          [1],
          { slug: 7, id: 'ok' },
          { slug: 'bad slug' },
          { id: '-x' },
          { id: 'x'.repeat(128) },
          { id: 'x'.repeat(129) },
          { slug: '', id: 'fallback' },
        ],
      }),
      c({ models: [{ slug: 'a:b.c_d-e', display_name: 7 }] }),
      c({}),
      c(null),
      c([1]),
      c('x'),
    ],
  },
  'chatgpt/responses.readChatGptModels': {
    ts: ([world, o], cx) =>
      inWorld(world as World, cx, async (run, signal) => {
        prep(run)
        return resp.readChatGptModels(
          (o as Any).token,
          undefined,
          (o as Any).noSignal ? undefined : signal,
        )
      }),
    cases: [
      c(w([jsonRes({ models: [{ slug: 'gpt-5', display_name: 'GPT-5' }] })]), { token: 'tok' }),
      c(w([jsonRes({ data: [{ id: 'a' }, { id: 'b' }] })]), { token: 'tok', noSignal: true }),
      c(w([jsonRes({})]), { token: 'tok' }),
      c(w([textRes('', 401)]), { token: 'tok' }),
      c(w([textRes('', 500)]), { token: 'tok' }),
      c(w([textRes('nope')]), { token: 'tok' }),
      c(w([{ reject: { message: 'offline' } }]), { token: 'tok' }),
      c(w([{ hang: true }]), { token: 'tok' }),
      c(w([{ hang: true }], { abortAt: 100 }), { token: 'tok' }),
      c(w([{ status: 302, headers: [['location', 'https://evil.example']], body: [''] }]), {
        token: 'tok',
      }),
    ],
  },
  'chatgpt/responses.listChatGptModels': {
    ts: ([world, spec, o], cx) =>
      inWorld(world as World, cx, async (run, signal) => {
        const opts = o as BridgeOpts & { noSignal?: boolean }
        conn.setChatGptConnection(null)
        const made = connectionOf(run, spec as Spec)
        try {
          const deps = bridgeDeps(made, opts)
          try {
            return {
              models: await resp.listChatGptModels(deps, opts.noSignal ? undefined : signal),
              record: made.memory.current(),
            }
          } catch (error) {
            return { ...thrown(error), record: made.memory.current() }
          }
        } finally {
          conn.setChatGptConnection(null)
        }
      }),
    cases: [
      c(w([jsonRes({ data: [{ id: 'gpt-5' }] })]), { record: fresh() }, {}),
      c(w(), { record: fresh() }, { connection: 'null' }),
      c(w(), { record: fresh() }, { connection: 'absent' }),
      c(w([jsonRes({ data: [{ id: 'gpt-5' }] })]), { record: fresh() }, { connection: 'module' }),
      c(w(), { record: rec() }, {}),
      c(w([textRes('', 500)]), { record: fresh() }, {}),
      c(
        w([refreshedFor2(), jwks(), jsonRes({ data: [{ id: 'gpt-5' }] })]),
        { verdicts: [true], record: signedIn({ expiresAt: STALE }) },
        {},
      ),
      c(w(), { record: fresh() }, { noSignal: true, connection: 'null' }),
    ],
  },
  'chatgpt/responses.chatGptFailure': {
    ts: ([world, spec, o], cx) =>
      inWorld(world as World, cx, async (run) => {
        const opts = o as { status: number; body?: unknown; connection?: boolean }
        conn.setChatGptConnection(null)
        const made = connectionOf(run, spec as Spec)
        const error = await resp.chatGptFailure(
          opts.status,
          opts.body,
          opts.connection === false ? null : made.connection,
        )
        return { ...thrown(error), record: made.memory.current() }
      }),
    cases: [
      c(
        w(),
        { record: fresh() },
        { status: 500, body: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } },
      ),
      c(w(), { record: fresh() }, { status: 401, body: {} }),
      c(
        w(),
        { record: fresh() },
        { status: 200, body: { error: { code: 'subscription_sharing_invalid_user' } } },
      ),
      c(w(), { record: fresh() }, { status: 401, body: null, connection: false }),
      c(w(), { record: fresh(), flaky: { failWrite: true } }, { status: 401 }),
      c(w(), { record: fresh(), flaky: { failRead: true } }, { status: 401 }),
      c(w(), { record: rec() }, { status: 401 }),
      c(
        w(),
        { record: fresh() },
        { status: 403, body: { error: { code: 'subscription_sharing_user_not_eligible' } } },
      ),
      c(
        w(),
        { record: fresh() },
        {
          status: 400,
          body: {
            error: { code: 'subscription_sharing_unsupported_capability', param: 'input_image' },
          },
        },
      ),
      c(
        w(),
        { record: fresh() },
        { status: 400, body: { error: { code: 'subscription_sharing_unsupported_capability' } } },
      ),
      c(
        w(),
        { record: fresh() },
        {
          status: 400,
          body: { error: { code: 'subscription_sharing_unsupported_capability', param: 5 } },
        },
      ),
      c(w(), { record: fresh() }, { status: 503, body: { error: { message: 'Service busy' } } }),
      c(w(), { record: fresh() }, { status: 500, body: { error: { code: 'some_code' } } }),
      c(w(), { record: fresh() }, { status: 500, body: { detail: 'plain detail' } }),
      c(w(), { record: fresh() }, { status: 500, body: { error: { message: 'm'.repeat(600) } } }),
      c(
        w(),
        { record: fresh() },
        { status: 500, body: { error: { message: '', code: 'c' }, detail: 'd' } },
      ),
      c(w(), { record: fresh() }, { status: 500, body: { error: 'text error' } }),
      c(w(), { record: fresh() }, { status: 500, body: [1] }),
      c(w(), { record: fresh() }, { status: 500 }),
      c(w(), { record: fresh() }, { status: 502, body: 'html' }),
      c(w(), { record: fresh() }, { status: 429, body: { error: { code: 5, message: 7 } } }),
    ],
  },
  'chatgpt/responses.streamChatGpt': { ts: bridgeTs('stream'), cases: streamCases() },
  'chatgpt/responses.chatChatGpt': { ts: bridgeTs('chat'), cases: chatCases() },
}

function streamCases(): Case[] {
  const rich = { activity: true }
  return [
    // a plain answer
    streamCase(stream(turn('Hello there')), rich),
    streamCase(stream(turn('Hello there', [], 3)), {
      ...rich,
      config: { apiKey: '', model: ' gpt-5 ' },
    }),
    streamCase(stream(turn('Multi\nline "quoted" ü 한글 \\ end', [], 5))),
    // tool calls
    streamCase(
      stream(
        turn('Reading', [
          { name: 'read_doc', inputJson: '{"path":"a.docx"}' },
          { name: 'write_doc', inputJson: '{"text":"x"}' },
        ]),
      ),
    ),
    streamCase(stream(turn('Odd', [{ name: 'nope', inputJson: '{}' }]))),
    streamCase(stream(turn('Bad', [{ name: 'read_doc', inputJson: '{' }]))),
    streamCase(stream(turn('Obj', [{ name: 'read_doc', input: { a: 1 } }]))),
    streamCase(stream(turn('None', [{ name: 'read_doc' }]))),
    streamCase(
      stream(
        turn(
          'Many',
          Array.from({ length: 101 }, () => ({ name: 'read_doc', inputJson: '{}' })),
        ),
      ),
    ),
    streamCase(stream(turn('Hi', [{ name: 'read_doc', inputJson: '{}' }])), { tools: [] }),
    // prose and other shapes of answer
    streamCase(stream([delta('Just prose, no JSON'), completed()])),
    streamCase(
      stream([delta('Here you go: {"text":"inside","toolCalls":[]} thanks'), completed()]),
    ),
    streamCase(stream([delta('```json\n{"text":"fenced","toolCalls":[]}\n```'), completed()])),
    streamCase(
      stream([
        delta('{"text":"cut at tools","toolCalls":[{"name":"read_doc","inputJson":"{'),
        completed(),
      ]),
    ),
    streamCase(stream([delta('{"nope":1}'), completed()])),
    streamCase(stream([delta('{"text":"a","toolCalls":5}'), completed()])),
    streamCase(stream([delta('{"text":"a","toolCalls":[{"x":1}]}'), completed()])),
    streamCase(stream([delta('{"text":"partial'), delta(' text"'), delta('}'), completed()])),
    streamCase(stream([delta('{"text":"partial but broken'), completed()])),
    streamCase(stream([delta('{"te'), completed()])),
    streamCase(stream([delta('{ broken'), completed()])),
    streamCase(stream([completed()])),
    // usage and stop reasons
    streamCase(
      stream([...turn('x').slice(0, -1), completed({ input_tokens: '12', output_tokens: 3.5 })]),
    ),
    streamCase(
      stream([...turn('x').slice(0, -1), completed({ input_tokens: -1, output_tokens: 'x' })]),
    ),
    streamCase(stream([...turn('x').slice(0, -1), completed({})])),
    streamCase(stream([...turn('x').slice(0, -1), { type: 'response.completed' }])),
    streamCase(stream([...turn('x').slice(0, -1), { type: 'response.completed', response: [1] }])),
    streamCase(
      stream([...turn('x').slice(0, -1), { type: 'response.completed', response: { usage: 5 } }]),
    ),
    streamCase(
      stream([
        ...turn('{cut').slice(0, 2),
        {
          type: 'response.incomplete',
          response: {
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { output_tokens: 99 },
          },
        },
      ]),
    ),
    streamCase(
      stream([
        ...turn('x').slice(0, -1),
        {
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'content_filter' } },
        },
      ]),
    ),
    streamCase(stream([...turn('x').slice(0, -1), { type: 'response.incomplete' }])),
    streamCase(
      stream([
        ...turn('x').slice(0, -1),
        { type: 'response.incomplete', response: { incomplete_details: 5 } },
      ]),
    ),
    // events the stream carries that mean nothing
    streamCase(
      stream(['[DONE]', 'keep-alive', ...turn('ok'), { type: 'response.created' }, [1], 'text', 5]),
    ),
    streamCase(
      stream([{ type: 'response.output_text.delta', delta: 5 }, { type: 7 }, ...turn('ok')]),
    ),
    // failure events
    streamCase(
      stream([
        {
          type: 'response.failed',
          response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
        },
      ]),
    ),
    streamCase(
      stream([
        delta('{"text":"a'),
        { type: 'response.failed', response: { error: { code: 'x', message: 'boom' } } },
      ]),
    ),
    streamCase(stream([{ type: 'response.failed', response: { error: { message: 'boom' } } }])),
    streamCase(stream([{ type: 'response.failed' }])),
    streamCase(
      stream([{ type: 'error', error: { code: 'subscription_sharing_user_not_eligible' } }]),
    ),
    streamCase(
      stream([
        {
          type: 'error',
          code: 'subscription_sharing_unsupported_capability',
          param: 'image',
          message: 'm',
        },
      ]),
    ),
    streamCase(stream([{ type: 'error', message: 'direct message', code: 'c' }])),
    streamCase(stream([{ type: 'error', error: { code: 'subscription_sharing_invalid_user' } }])),
    streamCase(stream([delta('{"text":"x'), { type: 'error', error: { message: 'late' } }])),
    streamCase(stream([{ type: 'error', error: 'text' }])),
    // the stream ends badly
    streamCase(stream([])),
    streamCase(bridgeWorld([{ status: 200, headers: [], body: null }])),
    streamCase(stream([delta('{"text":"cut')])),
    streamCase(stream([delta('{"text":"cut"'), delta(',"toolCalls":[{"name":"read_doc"')])),
    streamCase(bridgeWorld([{ status: 200, headers: [], body: [{ hex: 'ff' }] }])),
    streamCase(bridgeWorld([{ status: 200, headers: [], body: [{ error: 'stream reset' }] }])),
    // HTTP errors
    streamCase(
      bridgeWorld([jsonRes({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, 429)]),
    ),
    streamCase(bridgeWorld([jsonRes({ error: { message: 'bad key' } }, 401)])),
    streamCase(
      bridgeWorld([
        jsonRes(
          { error: { code: 'subscription_sharing_unsupported_capability', param: 'input_image' } },
          400,
        ),
      ]),
    ),
    streamCase(bridgeWorld([jsonRes({ error: { message: 'oops' } }, 500)])),
    streamCase(bridgeWorld([textRes('<html>gateway</html>', 502)])),
    streamCase(bridgeWorld([textRes('busy', 503), textRes('busy', 503), textRes('busy', 503)])),
    streamCase(bridgeWorld([textRes('busy', 503), sse(turn('after retry'))])),
    streamCase(bridgeWorld([{ reject: { message: 'offline' } }])),
    streamCase(
      bridgeWorld([{ status: 302, headers: [['location', 'https://evil.example']], body: [''] }]),
    ),
    streamCase(bridgeWorld([{ hang: true }])),
    streamCase(bridgeWorld([{ hang: true }], { abortAt: 500 })),
    streamCase(bridgeWorld([{ hang: true }], { abortAt: 100 }), rich),
    streamCase(bridgeWorld([sse([delta('{"text":"slow'), delta(' stream')])]), {}),
    // the connection
    streamCase(bridgeWorld([]), { connection: 'null' }),
    streamCase(bridgeWorld([]), { connection: 'absent' }),
    streamCase(stream(turn('via module')), { connection: 'module' }),
    streamCase(bridgeWorld([]), {}, { record: rec() }),
    streamCase(bridgeWorld([]), {}, { record: fresh(), flaky: { failRead: true } }),
    streamCase(
      bridgeWorld([refreshedFor2(), jwks(), sse(turn('after refresh'))]),
      {},
      {
        verdicts: [true],
        record: signedIn({ expiresAt: STALE }),
      },
    ),
    streamCase(
      bridgeWorld([jsonRes({ error: 'invalid_grant' }, 400)]),
      {},
      {
        record: signedIn({ expiresAt: STALE }),
      },
    ),
    streamCase(bridgeWorld([]), {}, { record: signedIn({ expiresAt: EXPIRED }) }),
    // the model
    streamCase(
      bridgeWorld([
        jsonRes({ data: [{ id: 'listed-1' }, { id: 'listed-2' }] }),
        sse(turn('listed')),
      ]),
      {
        config: { apiKey: '', model: '' },
      },
    ),
    streamCase(
      bridgeWorld([
        jsonRes({ models: [{ slug: 'm-1', visibility: 'list' }] }),
        sse(turn('listed')),
      ]),
      {
        config: { apiKey: '', model: '   ' },
      },
    ),
    streamCase(bridgeWorld([jsonRes({ data: [] })]), { config: { apiKey: '', model: '' } }),
    streamCase(bridgeWorld([textRes('', 500)]), { config: { apiKey: '', model: '' } }),
    streamCase(bridgeWorld([]), { config: { apiKey: '', model: 'bad model!' } }),
    streamCase(bridgeWorld([]), { config: { apiKey: '', model: '-leading' } }),
    streamCase(stream(turn('ok')), { config: { apiKey: '', model: 'o3:high.v2_x' } }),
    // the input
    streamCase(stream(turn('ok')), {
      system: '',
      messages: [
        { role: 'user', text: 'with pic', images: [{ mime: 'image/png', base64: 'AAAA' }] },
        {
          role: 'assistant',
          text: 'saw it',
          toolCalls: [{ id: 't1', name: 'read_doc', input: { a: 1 } }],
        },
        { role: 'tool', results: [{ toolCallId: 't1', content: 'done' }] },
      ],
    }),
    streamCase(stream(turn('ok')), {
      messages: [
        {
          role: 'user',
          text: 'many',
          images: Array.from({ length: 101 }, (_, n) => ({ mime: 'image/png', base64: `AA${n}` })),
        },
      ],
    }),
    streamCase(bridgeWorld([]), {
      tools: [{ name: 'bad name!', description: 'x', inputSchema: {} }],
    }),
    streamCase(stream(turn('ok')), { maxTokens: 64, system: 'Custom system' }),
  ]
}

function refreshedFor2() {
  return jsonRes(tokenBody({ id_token: T.refresh }))
}

function chatCases(): Case[] {
  const plain = (events: unknown[]) => stream(events)
  const q = (user: string): BridgeOpts => ({ messages: [{ role: 'user', text: user }] })
  return [
    streamCase(plain([delta('The answer.'), completed()]), q('Question?')),
    streamCase(plain([delta('Part one, '), delta('part two.'), completed()]), q('Hi')),
    streamCase(plain([completed()]), q('Empty')),
    streamCase(plain([delta(''), completed()]), q('Empty text')),
    streamCase(plain([delta('{"text":"not parsed"}'), completed()]), q('Raw')),
    streamCase(plain([delta('cut off')]), q('Cut')),
    streamCase(plain([]), q('None')),
    streamCase(bridgeWorld([{ status: 200, headers: [], body: null }]), q('No body')),
    streamCase(
      plain([
        {
          type: 'response.failed',
          response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
        },
      ]),
      q('Limit'),
    ),
    streamCase(plain([{ type: 'error', error: { message: 'bad' } }]), q('Err')),
    streamCase(plain([delta('half'), { type: 'error', error: { message: 'bad' } }]), q('Err late')),
    streamCase(bridgeWorld([jsonRes({ error: { message: 'bad key' } }, 401)]), q('Auth')),
    streamCase(bridgeWorld([jsonRes({ error: { message: 'oops' } }, 500)]), q('Server')),
    streamCase(bridgeWorld([{ reject: { message: 'offline' } }]), q('Offline')),
    streamCase(bridgeWorld([{ hang: true }], { abortAt: 200 }), q('Abort')),
    streamCase(bridgeWorld([]), { ...q('x'), connection: 'null' }),
    streamCase(bridgeWorld([]), { ...q('x'), connection: 'absent' }),
    streamCase(plain([delta('via module'), completed()]), { ...q('x'), connection: 'module' }),
    streamCase(bridgeWorld([]), q('x'), { record: rec() }),
    streamCase(
      bridgeWorld([jsonRes({ data: [{ id: 'first' }] }), sse([delta('listed'), completed()])]),
      { ...q('x'), config: { apiKey: '', model: '' } },
    ),
    streamCase(plain([delta('ok'), completed()]), {
      ...q('x'),
      config: { apiKey: '', model: 'bad model!' },
    }),
    streamCase(plain([delta('ok'), completed()]), {
      ...q(''),
      config: { apiKey: '', model: 'gpt-5' },
    }),
    streamCase(bridgeWorld([jsonRes({ error: 'invalid_grant' }, 400)]), q('x'), {
      record: signedIn({ expiresAt: STALE }),
    }),
  ]
}

export const group: Group = {
  ...oauthGroup,
  ...credentialsGroup,
  ...connectionGroup,
  ...statusGroup,
  ...responsesGroup,
}
