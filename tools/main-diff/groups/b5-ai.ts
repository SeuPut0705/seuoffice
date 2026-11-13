/**
 * Group `b5-ai`: the AI settings layer of `packages/ai-provider/src` (the
 * providers, the selection, the legacy reader, the settings guard, the sealed
 * secrets, the run errors) and the AI modules of the apps' main processes
 * (`docs/ai-run`, `sheets/ai-run`, `ai-keepalive`, `free-ai-strings`,
 * `ai-default-fonts`, `ai-naming-provider`, `ai-naming`, `ai-secrets`) with
 * `ai-run-guard`, `drive-ai-channels` and `slides-ai-fonts` of the packages.
 *
 * Names are `<ts-file>.<export>`; the files of `packages/ai-provider/src` are
 * `ai-provider/<ts-file>.<export>`, and `ai-run` is `docs/ai-run` or
 * `sheets/ai-run`.
 *
 * - The secret codec of `settings-secrets.ts` is a module variable there: a
 *   spec names it as the first argument, `'none'` or `'fake'` (seals `x` as
 *   `sealed:v1:` + `encodeURIComponent(x)`, `!x` stays plain, `?x` throws;
 *   opens by `decodeURIComponent`, `null` opens to nothing, `throw` throws).
 * - A thrown value is a descriptor `{ "$class": "Error" | "AiRunError" |
 *   "AiTimeoutError" | "AiCreditsError", ... }` (`message`, `cause`, `code`,
 *   `kind`, `provider`, `resetsAt`, `ms`), built here into the real class; an
 *   object without `$class` stays a plain object, a string a string.
 * - `Date.now()` is the clock of the call where `aiStreamErrorFields` reads
 *   it; a random endpoint id (`ep-xxxxxxxx`) reads as `ep-<rand>`.
 * - Timers and streams are fakes: the keepalive's `setInterval` logs, and
 *   `process.stdin`/`stdout` of `runRevealEntry` are fed events.
 * - Settings with a key whose value is `undefined`, numbers that JSON
 *   cannot write (NaN, Infinity) and wrong types where the TypeScript would
 *   throw a `TypeError` (`config.baseUrl?.trim` on a number) are not used.
 */
import {
  AI_PROVIDERS,
  AI_SUBSCRIPTION_NOTICE_VERSION,
  clampMaxOutputTokens,
  defaultAiSettings,
  headlessConsentVersionOf,
  headlessSubscriptionOn,
  listedModelsOf,
  maxOutputTokensOf,
  readUrlSettingsOf,
  sanitizeMeteredAccepted,
  sanitizeSubscriptionOff,
  subscriptionNoticeVersionOf,
  withMigratedSubscriptionNoticeVersion,
} from '../../../packages/ai-provider/src/providers.ts'
import {
  isKeyProviderConfigured,
  isSubscriptionProvider,
  providerSelectionOf,
  selectAiProvider,
  subscriptionConnection,
  subscriptionOffIn,
  subscriptionStateOf,
} from '../../../packages/ai-provider/src/provider-selection.ts'
import {
  DEFAULT_AI_ANALYSIS_PROVIDER,
  DEFAULT_AI_IMAGE_PROVIDER,
  DEFAULT_AI_PROVIDER_SELECTION,
  DEFAULT_AI_SEARCH_PROVIDER,
  DEFAULT_AI_VIDEO_ANALYSIS_PROVIDER,
  normalizeAiSettings,
} from '../../../packages/ai-provider/src/legacy-settings.ts'
import {
  sanitizeAiSettings,
  sanitizeCliPath,
  validCliPath,
} from '../../../packages/ai-provider/src/ai-settings-guard.ts'
import {
  SEALED_PREFIX,
  isSealedSecret,
  mapAiSecrets,
  openAiSecrets,
  openSecretValue,
  sealAiSecrets,
  sealSecretValue,
  sealedAiSecretsIn,
  setAiSecretCodec,
  type AiSecretCodec,
} from '../../../packages/ai-provider/src/settings-secrets.ts'
import { AiRunError, aiStreamErrorFields } from '../../../packages/ai-provider/src/run-error.ts'
import { isAiOverloadedError } from '../../../packages/ai-provider/src/overload-error.ts'
import { isAiNetworkError } from '../../../packages/ai-provider/src/network-error.ts'
import {
  freeLimitOf,
  isFreeTierModelRefusal,
  nextPacificMidnight,
} from '../../../packages/ai-provider/src/free-ai.ts'
import {
  AiTimeoutError,
  normalizeWatchdogTimeout,
} from '../../../packages/ai-provider/src/watchdog.ts'
import { AiCreditsError } from '../../../packages/ai-provider/src/protocols/shared.ts'
import { normalizeBaseUrl } from '../../../packages/ai-provider/src/registry.ts'
import {
  aiEffortOf,
  aiEffortsOf,
  aiModelEffortOf,
  aiModelEffortsOf,
} from '../../../packages/ai-provider/src/effort.ts'
import {
  defaultAiSearchSettings,
  resolveAiSearchSettings,
} from '../../../packages/ai-provider/src/search-settings.ts'
import {
  defaultAiMediaSettings,
  resolveAiMediaSettings,
} from '../../../packages/ai-provider/src/media.ts'
import { localEndpointFieldsOf } from '../../../packages/ai-provider/src/local-profile.ts'
import { resolveCustomEndpoints } from '../../../packages/ai-provider/src/custom-endpoints.ts'
import * as docsAiRun from '../../../apps/docs/src/main/ai-run.ts'
import * as sheetsAiRun from '../../../apps/sheets/src/main/ai-run.ts'
import {
  AI_KEEPALIVE_INTERVAL_MS,
  startAiKeepalive,
  startFirstChunkKeepalive,
} from '../../../apps/docs/src/main/ai-keepalive.ts'
import { FREE_AI_PAGE_STRINGS } from '../../../apps/docs/src/main/free-ai-strings.ts'
import {
  TITLE_ROLE_MIN_PT,
  fillMissingRunFonts,
  parseFontRoles,
  readSlidesAiFonts,
} from '../../../apps/slides/src/main/ai-default-fonts.ts'
import {
  SLIDES_AI_FONTS_KEY,
  defaultSlidesAiFonts,
  normalizeSlidesAiFonts,
} from '../../../packages/ui/src/slides-ai-fonts.ts'
import { resolveNamingProvider } from '../../../apps/shell/src/main/ai-naming-provider.ts'
import {
  buildNamingInstruction,
  excerptForNaming,
  sanitizeFileStem,
} from '../../../apps/shell/src/main/ai-naming.ts'
import {
  MAX_REVEAL_VALUES,
  REVEAL_FLAG,
  fileSearchHoldsPlainKeys,
  holdsPlainSecrets,
  linuxKeyringSeals,
  openFileSearchKeys,
  platformSeals,
  revealAnswer,
  revealRequestOf,
  runRevealEntry,
  safeStorageCodec,
  sealFileSearchKeys,
  sealStoredAiSettings,
  sealingKeyOnDisk,
} from '../../../apps/shell/src/main/ai-secrets.ts'
import {
  aiRunRefusal,
  setAiRunGuard,
  type AiRunGuard,
} from '../../../packages/electron-utils/src/ai-run-guard.ts'
import {
  DRIVE_AI_CHANNELS,
  driveAiOn,
  driveConnectedOf,
} from '../../../packages/electron-utils/src/drive-ai-channels.ts'
import { createRequire } from 'node:module'
import type { Case, FileSpec, FnSpec, Group, TsContext } from '../types.ts'

/**
 * The code under apps/* is loaded as CommonJS and reads `@seuoffice/ai-provider`
 * from the CommonJS copy of the package: its own codec variable and its own
 * error classes. The ES imports above are another copy, so what the apps'
 * modules must see (the codec, `instanceof` of the errors) goes through this one.
 */
const aiProviderPackage = createRequire(import.meta.url)(
  '@seuoffice/ai-provider',
) as typeof import('@seuoffice/ai-provider')

type J = any

// ---- helpers ----

const str = (a: unknown[], i: number): string => a[i] as string

/** a case */
function c(args: unknown[], note?: string, files?: Record<string, FileSpec>): Case {
  return { args, ...(note ? { note } : {}), ...(files ? { files } : {}) }
}

/** a constant has one answer: its second case adds a file, so the two differ */
function constant(value: unknown): FnSpec {
  return {
    ts: () => value,
    cases: [c([])],
    single: 'a constant',
  }
}

/** `ep-xxxxxxxx` (a random endpoint id) reads as `ep-<rand>` */
function maskIds(value: unknown): unknown {
  if (typeof value === 'string') return /^ep-[a-z0-9]{8}$/.test(value) ? 'ep-<rand>' : value
  if (Array.isArray(value)) return value.map(maskIds)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskIds(v)]))
  }
  return value
}

/** the codec a spec names */
const fakeCodec: AiSecretCodec = {
  seal(plain) {
    if (plain.startsWith('!')) return null
    if (plain.startsWith('?')) throw new Error('seal failed')
    return SEALED_PREFIX + encodeURIComponent(plain)
  },
  open(sealed) {
    const rest = sealed.slice(SEALED_PREFIX.length)
    if (rest === 'null') return null
    if (rest === 'throw') throw new Error('open failed')
    return decodeURIComponent(rest)
  },
}

/** "no codec registered", for the functions that take a codec as a value */
const noCodec: AiSecretCodec = { seal: () => null, open: () => null }

/**
 * The apps' modules (CommonJS) hold their own copy of the package, with its
 * own codec variable: the codec is set on both copies.
 */
function withCodec<T>(mode: unknown, fn: () => T): T {
  const codec = mode === 'fake' ? fakeCodec : null
  setAiSecretCodec(codec)
  aiProviderPackage.setAiSecretCodec(codec)
  try {
    return fn()
  } finally {
    setAiSecretCodec(null)
    aiProviderPackage.setAiSecretCodec(null)
  }
}

const codecValue = (mode: unknown): AiSecretCodec => (mode === 'fake' ? fakeCodec : noCodec)

/** `Date.now()` reads the clock of the call while `fn` runs */
function withNow<T>(now: number, fn: () => T): T {
  const real = Date.now
  Date.now = () => now
  try {
    return fn()
  } finally {
    Date.now = real
  }
}

/** a descriptor built into the value it describes (see the header) */
function build(value: unknown, fromPackage = false): unknown {
  // the app modules test `instanceof` against the classes of the package entry
  const Run = fromPackage ? aiProviderPackage.AiRunError : AiRunError
  const Timeout = fromPackage ? aiProviderPackage.AiTimeoutError : AiTimeoutError
  const Credits = fromPackage ? aiProviderPackage.AiCreditsError : AiCreditsError
  if (Array.isArray(value)) return value.map((v) => build(v, fromPackage))
  if (!value || typeof value !== 'object') return value
  const d = value as Record<string, J>
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d)) if (k !== '$class') rest[k] = build(v, fromPackage)
  let e: J
  switch (d.$class) {
    case 'Error':
      e = new Error(d.message)
      break
    case 'AiRunError':
      e = new Run(d.kind, d.message, { provider: d.provider, resetsAt: d.resetsAt })
      break
    case 'AiTimeoutError':
      e = new Timeout(d.ms)
      break
    case 'AiCreditsError':
      e = new Credits(d.message)
      break
    default:
      return rest
  }
  if ('cause' in d) e.cause = rest.cause
  if ('code' in d) e.code = rest.code
  return e
}

const err = (message: string, extra: Record<string, unknown> = {}) => ({
  $class: 'Error',
  message,
  ...extra,
})

// ---- fixtures ----

const ready = (provider: string) => ({ provider, state: 'ready', meteredAccepted: false })
const status = (provider: string, state: string, extra: Record<string, unknown> = {}) => ({
  provider,
  state,
  meteredAccepted: false,
  ...extra,
})
const sel = (provider: unknown, extra: Record<string, unknown> = {}) => ({
  provider,
  providers: {},
  meteredAccepted: {},
  ...extra,
})
const keyed = (provider: string, config: Record<string, unknown>) => ({
  provider,
  providers: { [provider]: config },
})

const NOW = 1_794_452_400_000

// ---- ai-provider/providers ----

const providersFns: Group = {
  'ai-provider/providers.AI_PROVIDERS': constant(AI_PROVIDERS),
  'ai-provider/providers.AI_SUBSCRIPTION_NOTICE_VERSION': constant(AI_SUBSCRIPTION_NOTICE_VERSION),
  'ai-provider/providers.withMigratedSubscriptionNoticeVersion': {
    ts: (a) => withMigratedSubscriptionNoticeVersion(a[0]),
    cases: [
      c([{ subscriptionNoticeSeen: true, provider: 'auto' }], 'a bare flag: version 1 is added'),
      c([{ subscriptionNoticeSeen: true, subscriptionNoticeVersion: 2 }], 'a version is there'),
      c([{ subscriptionNoticeSeen: true, subscriptionNoticeVersion: -1 }], 'a negative version'),
      c([{ subscriptionNoticeSeen: true, subscriptionNoticeVersion: 1.5 }], 'a fractional version'),
      c(
        [{ subscriptionNoticeSeen: true, subscriptionNoticeVersion: 1.4 }],
        'a fraction that rounds down',
      ),
      c([{ subscriptionNoticeSeen: true, subscriptionNoticeVersion: '2' }], 'a text version'),
      c([{ subscriptionNoticeSeen: true, subscriptionNoticeVersion: null }], 'a null version'),
      c([{ subscriptionNoticeSeen: true, subscriptionNoticeVersion: 0, x: 1 }], 'version 0'),
      c([{ subscriptionNoticeSeen: false }], 'not seen'),
      c([{ subscriptionNoticeSeen: 'yes' }], 'seen is no boolean'),
      c([{}], 'no flag'),
      c([[{ subscriptionNoticeSeen: true }]], 'an array'),
      c(['text'], 'a string'),
      c([null], 'nothing'),
      c(
        [{ b: 1, '10': 1, a: 2, '2': 1, subscriptionNoticeSeen: true }],
        'integer keys come first, the version last',
      ),
    ],
  },
  'ai-provider/providers.maxOutputTokensOf': {
    ts: (a) => maxOutputTokensOf(a[0] as J),
    cases: [
      c([{}], 'absent: the default'),
      c([{ maxOutputTokens: 100 }], 'below the floor'),
      c([{ maxOutputTokens: 1024 }], 'the floor'),
      c([{ maxOutputTokens: 5000.7 }], 'fractional'),
      c([{ maxOutputTokens: 131072 }], 'the ceiling'),
      c([{ maxOutputTokens: 131073 }], 'above the ceiling'),
      c([{ maxOutputTokens: -5 }], 'negative'),
      c([{ maxOutputTokens: 0 }], 'zero'),
      c([{ maxOutputTokens: '5000' }], 'a text'),
      c([{ maxOutputTokens: null }], 'null'),
      c([{ maxOutputTokens: 1e300 }], 'huge'),
      c([null], 'no settings'),
      c([[1]], 'an array'),
    ],
  },
  'ai-provider/providers.clampMaxOutputTokens': {
    ts: (a) => clampMaxOutputTokens(a[0]),
    cases: [c([5]), c([70000]), c([1e9]), c([2000.9]), c([-1e9]), c(['3']), c([null]), c([true])],
  },
  'ai-provider/providers.defaultAiSettings': {
    ts: (a) => defaultAiSettings(a[0] as J),
    cases: [
      c([null], 'no default keys'),
      c([{ anthropic: 'sk-ant', openai: '', deepseek: null }], 'a preconfigured key'),
      c([{ custom: 'k', gateway: 'g' }], 'keys of providers with a base URL and a token'),
    ],
  },
  'ai-provider/providers.subscriptionNoticeVersionOf': {
    ts: (a) => subscriptionNoticeVersionOf(a[0], a[1]),
    cases: [
      c([1, false]),
      c([2, false]),
      c([7, false], 'above the current'),
      c([0, true], 'zero is a version'),
      c([-1, true], 'negative reads the flag'),
      c([1.5, true]),
      c([1.4, true], 'a fraction that rounds down'),
      c([null, true], 'only the flag'),
      c([null, false]),
      c(['2', true]),
      c([null, 'true']),
    ],
  },
  'ai-provider/providers.headlessConsentVersionOf': {
    ts: (a) => headlessConsentVersionOf(a[0]),
    cases: [c([2]), c([1]), c([0]), c([-3]), c([2.5]), c(['2']), c([null]), c([1e300]), c([2.4])],
  },
  'ai-provider/providers.headlessSubscriptionOn': {
    ts: (a) => headlessSubscriptionOn(a[0] as J),
    cases: [
      c([{ headlessSubscriptionEnabled: true, headlessSubscriptionConsentVersion: 2 }]),
      c([{ headlessSubscriptionEnabled: true, headlessSubscriptionConsentVersion: 1 }]),
      c([{ headlessSubscriptionEnabled: true, headlessSubscriptionConsentVersion: 3 }]),
      c([{ headlessSubscriptionEnabled: true }], 'no consent'),
      c([{ headlessSubscriptionEnabled: 'true', headlessSubscriptionConsentVersion: 2 }]),
      c([{ headlessSubscriptionEnabled: false, headlessSubscriptionConsentVersion: 2 }]),
    ],
  },
  'ai-provider/providers.sanitizeMeteredAccepted': {
    ts: (a) => sanitizeMeteredAccepted(a[0]),
    cases: [
      c([null]),
      c([{ 'claude-code': true, codex: true }]),
      c([{ 'claude-code': 'true', codex: 1, chatgpt: true }]),
      c([{ codex: true }]),
      c([[true]]),
      c(['x']),
    ],
  },
  'ai-provider/providers.sanitizeSubscriptionOff': {
    ts: (a) => sanitizeSubscriptionOff(a[0]),
    cases: [
      c([null]),
      c([{}]),
      c([{ 'claude-code': true }]),
      c([{ codex: true, 'claude-code': true, chatgpt: true }]),
      c([{ codex: 'true', 'claude-code': false }]),
      c([[true]]),
    ],
  },
  'ai-provider/providers.readUrlSettingsOf': {
    ts: (a) => readUrlSettingsOf(a[0]),
    cases: [
      c([{ githubToken: ' ghp_x ' }]),
      c([{ githubToken: '   ' }]),
      c([{ githubToken: '\uFEFF' }], 'a byte order mark is white space'),
      c([{ githubToken: '\u0085' }], 'U+0085 is not'),
      c([{ githubToken: 5 }]),
      c([{}]),
      c([null]),
      c([['ghp']]),
      c(['ghp']),
    ],
  },
  'ai-provider/providers.listedModelsOf': {
    ts: (a) => listedModelsOf(a[0]),
    cases: [
      c([['a', ' b ', 'a', '', '  ', 5, null, 'b']], 'trimmed, deduplicated, strings only'),
      c([['x'.repeat(256), 'y'.repeat(257)]], 'the length bound'),
      c([[]], 'nothing left'),
      c([['', 5]]),
      c([Array.from({ length: 2100 }, (_, i) => `m${i}`)], 'bounded to 2000'),
      c([[`\u{1F600}`.repeat(128), `\u{1F600}`.repeat(129)]], 'length counts code units'),
      c(['a']),
      c([{ 0: 'a' }]),
      c([null]),
    ],
  },
}

// ---- ai-provider/provider-selection ----

const statusSets = {
  claudeReady: { 'claude-code': ready('claude-code') },
}

const selectionFns: Group = {
  'ai-provider/provider-selection.isSubscriptionProvider': {
    ts: (a) => isSubscriptionProvider(a[0]),
    cases: [
      c(['claude-code']),
      c(['chatgpt']),
      c(['codex']),
      c(['anthropic']),
      c(['auto']),
      c(['']),
      c([5]),
      c([null]),
      c([['codex']]),
    ],
  },
  'ai-provider/provider-selection.selectAiProvider': {
    ts: (a) => selectAiProvider(a[0] as J, a[1] as J),
    cases: [
      c([sel('auto'), statusSets.claudeReady], 'auto: Claude Code is ready'),
      c(
        [
          sel('auto'),
          { 'claude-code': status('claude-code', 'not-installed'), chatgpt: ready('chatgpt') },
        ],
        'auto: ChatGPT before Codex',
      ),
      c([{ provider: 'auto' }, {}], 'auto: the first status has not answered'),
      c(
        [sel('auto'), { 'claude-code': status('claude-code', 'checking'), codex: ready('codex') }],
        'auto: a provider still checking holds the choice',
      ),
      c(
        [
          sel('auto'),
          { 'claude-code': status('claude-code', 'signed-out'), codex: ready('codex') },
        ],
        'auto: a missing ChatGPT status reads as signed out',
      ),
      c(
        [
          sel('auto', { subscriptionOff: { 'claude-code': true } }),
          {
            'claude-code': ready('claude-code'),
            chatgpt: status('chatgpt', 'signed-out'),
            codex: ready('codex'),
          },
        ],
        'auto: a CLI turned off is passed over at once',
      ),
      c(
        [
          sel('auto'),
          {
            'claude-code': status('claude-code', 'error'),
            chatgpt: status('chatgpt', 'metered'),
            codex: status('codex', 'off'),
          },
        ],
        'auto: no ready provider',
      ),
      c(
        [
          sel('auto', { subscriptionOff: { 'claude-code': true, codex: true } }),
          { chatgpt: status('chatgpt', 'checking') },
        ],
        'auto: ChatGPT is checking after two CLIs turned off',
      ),
      c([keyed('anthropic', { apiKey: 'k', model: 'm' }), {}], 'a configured key provider'),
      c([keyed('anthropic', { apiKey: '  ', model: 'm' }), {}], 'a blank key'),
      c([keyed('anthropic', { apiKey: 'k', model: ' ' }), {}], 'a blank model'),
      c([keyed('deepseek', { apiKey: '\uFEFF', model: 'm' }), {}], 'a byte order mark is space'),
      c([keyed('deepseek', { apiKey: '\u0085', model: 'm' }), {}], 'U+0085 is not'),
      c(
        [keyed('custom', { apiKey: '', model: 'm', baseUrl: 'http://localhost:1234/v1' }), {}],
        'custom needs a base URL, not a key',
      ),
      c(
        [keyed('custom', { apiKey: 'k', model: 'm', baseUrl: '' }), {}],
        'custom without a base URL',
      ),
      c(
        [keyed('gateway', { apiKey: '', model: '', baseUrl: 'https://gw.example/v1' }), {}],
        'a gateway needs only its URL',
      ),
      c([keyed('gateway', { apiKey: 'k', model: 'm' }), {}], 'a gateway without a URL'),
      c([{ provider: 'openai', providers: {} }, {}], 'the provider has no entry'),
      c([{ provider: 'openai' }, {}], 'no provider table'),
      c([sel('claude-code'), { 'claude-code': ready('claude-code') }], 'a ready subscription'),
      c(
        [
          sel('claude-code', { meteredAccepted: { 'claude-code': true } }),
          { 'claude-code': status('claude-code', 'metered', { meteredAccepted: true }) },
        ],
        'an accepted metered login',
      ),
      c(
        [
          sel('claude-code', { meteredAccepted: { 'claude-code': false } }),
          { 'claude-code': status('claude-code', 'metered', { meteredAccepted: true }) },
        ],
        'the status is accepted, the setting is not',
      ),
      c(
        [
          sel('codex', { meteredAccepted: { codex: true } }),
          { codex: status('codex', 'metered', { meteredAccepted: false }) },
        ],
        'the setting is accepted, the status is not',
      ),
      c(
        [sel('codex'), { codex: status('codex', 'error', { error: 'boom' }) }],
        'an error with its text',
      ),
      c([sel('codex'), { codex: status('codex', 'error') }], 'an error without text'),
      c(
        [sel('codex'), { codex: status('codex', 'error', { error: '' }) }],
        'an error with an empty text',
      ),
      c([sel('chatgpt'), {}], 'ChatGPT with no status'),
      c([sel('codex'), {}], 'Codex with no status'),
      c([sel('codex'), { codex: status('codex', 'not-installed') }]),
      c([sel('codex'), { codex: status('codex', 'signed-out') }]),
      c([sel('codex'), { codex: status('codex', 'checking') }]),
      c(
        [
          sel('claude-code', { subscriptionOff: { 'claude-code': true } }),
          { 'claude-code': ready('claude-code') },
        ],
        'a ready status of a CLI turned off',
      ),
      c([sel('codex'), { codex: status('codex', 'bogus') }], 'a state no check writes: no reason'),
      c(
        [
          sel('codex', { subscriptionOff: { 'claude-code': true } }),
          { codex: { provider: 'claude-code', state: 'ready', meteredAccepted: false } },
        ],
        'the status names another provider that is off',
      ),
      c([sel('zzz'), claudeOnly()], 'an unknown selection reads as auto'),
      c([sel(5), claudeOnly()], 'a selection that is no string'),
      c(
        [sel('Anthropic', { providers: { Anthropic: { apiKey: 'k', model: 'm' } } }), claudeOnly()],
        'ids are exact',
      ),
      c(
        [sel('auto', { subscriptionOff: { 'claude-code': 'true' } }), claudeOnly()],
        'only true turns a CLI off',
      ),
    ],
  },
  'ai-provider/provider-selection.providerSelectionOf': {
    ts: (a) => providerSelectionOf(a[0] as J),
    cases: [
      c([{ provider: 'openai' }]),
      c([{ provider: 'auto' }]),
      c([{ provider: 'nope' }]),
      c([{ provider: 5 }]),
      c([{}]),
      c([{ provider: 'opencode-go' }]),
    ],
  },
  'ai-provider/provider-selection.isKeyProviderConfigured': {
    ts: (a) => isKeyProviderConfigured(a[0] as J, a[1] as J),
    cases: [
      c([keyed('openai', { apiKey: 'k', model: 'm' }), 'openai']),
      c([keyed('openai', { apiKey: '', model: 'm' }), 'openai']),
      c(
        [keyed('openai', { apiKey: 'k', model: 'm' }), 'codex'],
        'a subscription provider is never configured',
      ),
      c([keyed('openai', { apiKey: 'k', model: 'm' }), 'removed-provider']),
      c([keyed('gateway', { baseUrl: ' https://g ' }), 'gateway']),
      c([keyed('custom', { model: 'm', baseUrl: 'http://x' }), 'custom']),
      c([{}, 'openai']),
    ],
  },
  'ai-provider/provider-selection.subscriptionStateOf': {
    ts: (a) => subscriptionStateOf(a[0] as J, a[1] as J),
    cases: [
      c([{}, 'chatgpt']),
      c([{}, 'codex']),
      c([{ codex: { state: 'ready' } }, 'codex']),
      c([{ chatgpt: { state: null } }, 'chatgpt'], 'a null state falls back'),
      c([{ codex: {} }, 'codex']),
    ],
  },
  'ai-provider/provider-selection.subscriptionOffIn': {
    ts: (a) => subscriptionOffIn(a[0] as J, a[1] as J),
    cases: [
      c([{ subscriptionOff: { codex: true } }, 'codex']),
      c([{ subscriptionOff: { codex: true } }, 'claude-code']),
      c([{ subscriptionOff: { chatgpt: true } }, 'chatgpt'], 'ChatGPT has no switch'),
      c([{}, 'codex']),
      c([{ subscriptionOff: { codex: 1 } }, 'codex']),
      c([{ subscriptionOff: { codex: true } }, null]),
    ],
  },
  'ai-provider/provider-selection.subscriptionConnection': {
    ts: (a) => subscriptionConnection(a[0] as J, a[1] as J) ?? null,
    cases: [
      c([{}, ready('codex')]),
      c([
        { meteredAccepted: { codex: true } },
        status('codex', 'metered', { meteredAccepted: true }),
      ]),
      c([{ meteredAccepted: { codex: true } }, status('codex', 'metered')]),
      c([{}, status('codex', 'signed-out')]),
      c([{}, null]),
      c([{ subscriptionOff: { codex: true } }, ready('codex')]),
      c([{}, 0]),
    ],
  },
}

function claudeOnly() {
  return { 'claude-code': ready('claude-code') }
}

// ---- ai-provider/legacy-settings ----

const dflt = defaultAiSettings()

const normalizeCases: Case[] = [
  c(['none', null], 'nothing stored'),
  c(
    [
      'none',
      {
        provider: 'anthropic',
        providers: { anthropic: { apiKey: ' sk-1 ', model: ' claude-sonnet-5-5 ' } },
      },
    ],
    'pasted whitespace is trimmed',
  ),
  c(['none', 'a string'], 'a file that is no object'),
  c(['none', [1, 2]], 'an array'),
  c(['none', {}], 'an empty object: no provider table'),
  c(
    ['none', { apiKey: 'sk-x', model: ' gpt-4 ', baseUrl: '' }],
    'the pre-provider shape moves into the custom slot',
  ),
  c(
    ['none', { apiKey: 'sk-x', model: 'm', baseUrl: ' https://llm.example/v1 ' }],
    'the pre-provider shape with its URL',
  ),
  c(['none', { apiKey: '', model: 'm', baseUrl: 'https://x' }], 'an empty legacy key is no slot'),
  c(
    [
      'none',
      {
        provider: 'nonexistent',
        providers: { openai: { apiKey: 'k', model: 'm' }, removed: { apiKey: 'x', model: 'y' } },
      },
    ],
    'an unknown selection reads as auto, an unknown provider is dropped',
  ),
  c(['none', { provider: 5, providers: {} }], 'a selection that is no string'),
  c(
    [
      'none',
      {
        provider: 'gateway',
        providers: { gateway: { apiKey: 'token', model: 'm', baseUrl: 'https://gw' } },
      },
    ],
    'a per-request token is never a setting',
  ),
  c(
    [
      'none',
      {
        provider: 'deepseek',
        providers: {
          deepseek: { apiKey: 'k', model: ' deepseek-reasoner ' },
          glm: { apiKey: 'k', model: 'glm-5-turbo' },
          gemini: { apiKey: 'k', model: 'gemini-3.7-flash' },
        },
      },
    ],
    'retired models are replaced',
  ),
  c(
    [
      'none',
      {
        providers: {
          deepseek: { apiKey: 'k', model: 'deep-seek-v4.1-flash' },
          glm: { apiKey: 'k', model: 'glm-5.3' },
        },
      },
    ],
    'the versioned spelling is retired, a current id stays',
  ),
  c(
    [
      'none',
      {
        providers: {
          openai: 'text',
          anthropic: [1],
          gemini: null,
          deepseek: {
            apiKey: 5,
            model: null,
            baseUrl: 7,
            cliPath: null,
            effort: 'High',
            models: ['a', ' a ', 3, ''],
            modelEfforts: {
              ' m ': { efforts: ['high', 'LOW', 'low'], defaultEffort: 'low' },
              '': { efforts: ['low'] },
              bad: { efforts: [] },
            },
          },
        },
      },
    ],
    'malformed provider configs',
  ),
  c(
    [
      'none',
      {
        providers: {
          codex: { apiKey: '', model: 'm', cliPath: ' /usr/bin/codex ', extra: 'dropped' },
        },
      },
    ],
    'a CLI path and an unknown field',
  ),
  c(
    [
      'none',
      {
        providers: { custom: { apiKey: ' k ', model: ' m ', baseUrl: ' http://localhost:1/v1 ' } },
      },
    ],
    'the custom slot seeds the endpoint list',
  ),
  c(
    ['none', { providers: { custom: { apiKey: '', model: '', baseUrl: '' } } }],
    'an empty custom slot',
  ),
  c(
    ['none', { providers: {}, customEndpoint: '' }],
    'an explicit empty active endpoint without a list',
  ),
  c(
    [
      'none',
      {
        providers: {},
        customEndpoints: [
          {
            id: 'a',
            name: ' A ',
            baseUrl: 'http://a',
            apiKey: 'ka',
            model: 'ma',
            models: ['x', ' x ', 'y', 5, ''],
            effort: 'high',
          },
          {
            id: ' b ',
            baseUrl: 'http://b',
            apiKey: '',
            model: 'mb',
            kind: 'local',
            timeoutMs: 120000,
            modelProfiles: {
              '10': { contextLength: 4096 },
              '2': {
                tools: true,
                vision: 'no',
                notes: ' n ',
                efforts: ['low', 'high'],
                defaultEffort: 'high',
              },
              b: { contextLength: 0 },
              ' ': { tools: true },
            },
          },
          { id: 'a', baseUrl: 'dup' },
          { id: '  ' },
          'x',
          null,
          { id: 'c', timeoutMs: 100, modelProfiles: [] },
        ],
        customEndpoint: 'b',
      },
    ],
    'the endpoint list, its active entry mirrored into the slot',
  ),
  c(
    [
      'none',
      {
        providers: {},
        customEndpoints: [{ id: 'a', baseUrl: 'http://a', apiKey: 'k', model: 'm' }],
        customEndpoint: 'gone',
      },
    ],
    'a stale active id falls to the first entry',
  ),
  c(
    [
      'none',
      {
        providers: {},
        customEndpoints: [{ id: 'a', baseUrl: 'http://a', apiKey: 'k', model: 'm' }],
        customEndpoint: '   ',
      },
    ],
    'an explicit empty active id clears the slot',
  ),
  c(
    [
      'none',
      {
        providers: {},
        customEndpoints: [
          {
            id: 'a',
            model: 'm',
            kind: 'local',
            effort: 'low',
            modelProfiles: {
              m: { efforts: ['low', 'high'], defaultEffort: 'high', contextLength: 2048 },
            },
          },
        ],
        customEndpoint: 'a',
      },
    ],
    'the active endpoint mirrors its model levels',
  ),
  c(
    [
      'none',
      {
        providers: {},
        customEndpoints: [
          { id: 'a', model: '__proto__', modelProfiles: { ['__proto__']: { efforts: ['low'] } } },
        ],
      },
    ],
    'a model named __proto__',
  ),
  c(
    ['none', { providers: {}, customEndpoints: 'nope', customEndpoint: 7 }],
    'a list that is no array',
  ),
  c(
    [
      'none',
      {
        providers: { custom: { apiKey: 'k', model: 'm', baseUrl: 'http://x' } },
        customEndpoints: [],
      },
    ],
    'an empty list next to a configured slot',
  ),
  c(
    [
      'fake',
      {
        provider: 'anthropic',
        providers: {
          anthropic: { apiKey: 'sealed:v1:sk%2D1%20', model: 'm' },
          openai: { apiKey: 'sealed:v1:null', model: 'm' },
          kimi: { apiKey: 'sealed:v1:throw', model: 'm' },
          glm: { apiKey: 'sealed:v1:%', model: 'm' },
          qwen: { apiKey: 'plain', model: 'm' },
        },
      },
    ],
    'sealed keys are opened, the ones that cannot be are empty',
  ),
  c(
    [
      'none',
      { provider: 'anthropic', providers: { anthropic: { apiKey: 'sealed:v1:abc', model: 'm' } } },
    ],
    'no codec: a sealed key reads as empty',
  ),
  c(
    [
      'fake',
      {
        providers: { custom: { apiKey: 'sealed:v1:k', model: 'm', baseUrl: 'http://x' } },
        customEndpoints: [
          { id: 'e', apiKey: 'sealed:v1:e%C3%A9', baseUrl: 'http://e', model: 'm' },
        ],
        media: { providers: { openai: { apiKey: 'sealed:v1:med', imageModel: 'i' } } },
        search: { provider: 'serper', providers: { serper: { apiKey: 'sealed:v1:srch' } } },
        readUrl: { githubToken: 'sealed:v1:ghp' },
      },
    ],
    'every secret of the settings',
  ),
  c(
    ['none', { providers: {}, subscriptionNoticeSeen: true }],
    'a bare notice flag reads as the current wording',
  ),
  c(
    ['none', { providers: {}, subscriptionNoticeSeen: true, subscriptionNoticeVersion: 1 }],
    'version 1',
  ),
  c(
    ['none', { providers: {}, subscriptionNoticeSeen: false, subscriptionNoticeVersion: 9 }],
    'above the current version',
  ),
  c(['none', { providers: {}, subscriptionNoticeVersion: -1 }], 'negative'),
  c(['none', { providers: {}, subscriptionNoticeSeen: 'yes' }], 'seen is no boolean'),
  c(['none', { providers: {}, pdfSendNoticeSeen: 3 }]),
  c(['none', { providers: {}, pdfSendNoticeSeen: 2.5 }]),
  c(['none', { providers: {}, pdfSendNoticeSeen: -1 }]),
  c(['none', { providers: {}, pdfSendNoticeSeen: '3' }]),
  c(
    [
      'none',
      { providers: {}, headlessSubscriptionEnabled: true, headlessSubscriptionConsentVersion: 2 },
    ],
    'the switch on with its consent',
  ),
  c(
    [
      'none',
      { providers: {}, headlessSubscriptionEnabled: true, headlessSubscriptionConsentVersion: 1 },
    ],
    'the switch on under an older consent',
  ),
  c(
    [
      'none',
      { providers: {}, headlessSubscriptionEnabled: true, headlessSubscriptionConsentVersion: 2.5 },
    ],
    'a fractional consent',
  ),
  c(['none', { providers: {}, maxOutputTokens: 100 }], 'a cap below the floor'),
  c(['none', { providers: {}, maxOutputTokens: 1e9 }], 'a cap above the ceiling'),
  c(['none', { providers: {}, maxOutputTokens: 5000.7 }], 'a fractional cap'),
  c(['none', { providers: {}, maxOutputTokens: null }], 'a null cap'),
  c(['none', { providers: {}, maxOutputTokens: '5000' }], 'a text cap'),
  c(['none', { providers: {}, internetTools: false }]),
  c(['none', { providers: {}, internetTools: 0 }], 'only false is kept'),
  c(['none', { providers: {}, readUrl: { githubToken: ' ghp ' } }]),
  c(['none', { providers: {}, readUrl: { githubToken: '  ' } }]),
  c(
    ['none', { readUrl: { githubToken: 'g' }, apiKey: 'k', model: 'm' }],
    'read_url on the pre-provider shape',
  ),
  c([
    'none',
    { providers: {}, subscriptionOff: { 'claude-code': true, chatgpt: true, codex: 'yes' } },
  ]),
  c(
    ['none', { apiKey: 'k', model: 'm', subscriptionOff: { codex: true } }],
    'a CLI turned off stays off on the pre-provider shape',
  ),
  c(['none', { providers: {}, meteredAccepted: { 'claude-code': true, codex: 1, chatgpt: true } }]),
  c(
    ['none', { providers: {}, media: { provider: 'openai' } }],
    'the pre-split media provider seeds the choices',
  ),
  c(['none', { providers: {}, media: { provider: 'chat' } }], 'a pre-split `chat` analysis choice'),
  c(
    [
      'none',
      {
        providers: {},
        media: {
          imageProvider: 'bogus',
          analysisProvider: 'stability',
          videoAnalysisProvider: 'openai',
          providers: {
            openai: { apiKey: ' k ', imageModel: ' m ', analysisModel: 5, baseUrl: ' http://x ' },
            microsoft: { apiKey: 'x', baseUrl: null },
            nope: { apiKey: 'z' },
            gemini: 'text',
          },
        },
      },
    ],
    'unknown and wrong-capability choices fall to their defaults',
  ),
  c(
    [
      'none',
      {
        providers: {},
        media: {
          imageProvider: 'none',
          analysisProvider: 'gemini',
          videoAnalysisProvider: 'gemini',
          providers: {
            '10': { apiKey: 'a' },
            '2': { apiKey: 'b' },
            custom: { apiKey: 'c', baseUrl: 'http://c' },
          },
        },
      },
    ],
    'integer keys of a media table',
  ),
  c(
    [
      'none',
      {
        providers: {},
        media: {
          imageProvider: 'codex',
          analysisProvider: 'deepseek',
          videoAnalysisProvider: 'deepseek',
        },
      },
    ],
    'deepseek cannot read video',
  ),
  c(
    ['none', { providers: {}, media: 'text', search: 5 }],
    'a media block and a search block that are no objects',
  ),
  c([
    'none',
    {
      providers: {},
      search: {
        provider: 'serper',
        providers: { serper: { apiKey: ' s ' }, tavily: { apiKey: 5 }, bogus: { apiKey: 'b' } },
      },
    },
  ]),
  c(
    ['none', { providers: {}, search: { provider: 'bogus', providers: { exa: { apiKey: 'e' } } } }],
    'an unknown search provider',
  ),
  c(['none', { providers: {}, search: { providers: [] } }], 'no search provider'),
  c(
    [
      'none',
      {
        providers: {
          '10': { apiKey: 'a' },
          '2': { apiKey: 'b' },
          openai: { apiKey: 'c', model: 'm' },
        },
      },
    ],
    'integer provider keys are unknown ids',
  ),
  c(
    [
      'none',
      JSON.parse(
        '{"providers":{"__proto__":{"apiKey":"p","model":"m"},"openai":{"apiKey":"k","model":"m"}},"provider":"openai"}',
      ),
    ],
    'an own __proto__ key',
  ),
  c(
    ['none', { providers: {}, newerField: { a: 1 }, provider: 'auto' }],
    'fields this build does not know are left out',
  ),
  c(
    [
      'none',
      { providers: {} },
      {
        ...dflt,
        readUrl: { githubToken: 'from-defaults' },
        subscriptionOff: { codex: true },
        maxOutputTokens: 70000,
        internetTools: false,
        subscriptionNoticeSeen: true,
        subscriptionNoticeVersion: 2,
      },
    ],
    'values the defaults carry',
  ),
  c(
    [
      'none',
      { providers: { openai: { apiKey: 'k', model: 'm' } }, maxOutputTokens: 50000 },
      { ...dflt, maxOutputTokens: 70000 },
    ],
    'the file wins over the defaults',
  ),
  c(
    [
      'none',
      { apiKey: 'k', model: 'm' },
      { ...dflt, readUrl: { githubToken: 'd' }, subscriptionOff: { 'claude-code': true } },
    ],
    'the legacy shape over defaults that carry values',
  ),
]

const normalizeFns: Group = {
  'ai-provider/legacy-settings.DEFAULT_AI_PROVIDER_SELECTION': constant(
    DEFAULT_AI_PROVIDER_SELECTION,
  ),
  'ai-provider/legacy-settings.DEFAULT_AI_IMAGE_PROVIDER': constant(DEFAULT_AI_IMAGE_PROVIDER),
  'ai-provider/legacy-settings.DEFAULT_AI_ANALYSIS_PROVIDER': constant(
    DEFAULT_AI_ANALYSIS_PROVIDER,
  ),
  'ai-provider/legacy-settings.DEFAULT_AI_VIDEO_ANALYSIS_PROVIDER': constant(
    DEFAULT_AI_VIDEO_ANALYSIS_PROVIDER,
  ),
  'ai-provider/legacy-settings.DEFAULT_AI_SEARCH_PROVIDER': constant(DEFAULT_AI_SEARCH_PROVIDER),
  'ai-provider/legacy-settings.normalizeAiSettings': {
    ts: (a) =>
      withCodec(a[0], () =>
        maskIds(normalizeAiSettings(a[1] ?? undefined, (a[2] ?? undefined) as J)),
      ),
    cases: normalizeCases,
  },
}

// ---- ai-provider/ai-settings-guard ----

const longPath = `/${'d'.repeat(1030)}/codex`
const guardFiles: Record<string, FileSpec> = {
  'bin/codex': 'x',
  'bin/my codex': 'x',
  adir: { dir: true },
}
const provider = (config: Record<string, unknown>, id = 'openai') => ({
  provider: id,
  providers: { [id]: config },
})

const guardCases: Case[] = [
  c(['text'], 'not an object'),
  c([null]),
  c([[1]], 'an array'),
  c([{ provider: 'nope', providers: {} }], 'an unknown provider'),
  c([{ provider: 5, providers: {} }]),
  c([{ provider: 'auto' }], 'no provider table'),
  c([{ provider: 'auto', providers: [] }], 'a provider table that is an array'),
  c([{ provider: 'auto', providers: {} }], 'the least that passes'),
  c([provider({ apiKey: 123, model: { a: 1 } })], 'values that are no strings: String()'),
  c([provider({ apiKey: ['a', null, 'b'], model: true })], 'an array and a boolean'),
  c([provider({ apiKey: null, model: undefined })], 'null and missing'),
  c(
    [provider({ apiKey: { toString: 'x' } })],
    'an object that converts to no primitive: a TypeError',
  ),
  c(
    [provider({ apiKey: '\u{1F600}'.repeat(5000), model: 'm'.repeat(300) })],
    'bounded lengths, counted in code units',
  ),
  c(
    [provider({ apiKey: 'k', model: 'm', baseUrl: 'https://api.example.com/v1/?x=1#frag' })],
    'the fragment goes, the query stays',
  ),
  c(
    [provider({ apiKey: 'k', model: 'm', baseUrl: ' HTTPS://Example.COM:443/a/../b ' })],
    'normalized as a URL',
  ),
  c(
    [provider({ apiKey: 'k', model: 'm', baseUrl: 'https://user:pw@example.com/' })],
    'credentials are refused',
  ),
  c(
    [provider({ apiKey: 'k', model: 'm', baseUrl: 'https://user@example.com/' })],
    'a user name is refused',
  ),
  c(
    [provider({ apiKey: 'k', model: 'm', baseUrl: 'https://:@example.com/' })],
    'empty credentials pass',
  ),
  c([provider({ apiKey: 'k', model: 'm', baseUrl: 'ftp://example.com/' })], 'not http'),
  c([provider({ apiKey: 'k', model: 'm', baseUrl: 'not a url' })], 'not a URL'),
  c([provider({ apiKey: 'k', model: 'm', baseUrl: 5 })], 'a number'),
  c([provider({ apiKey: 'k', model: 'm', baseUrl: '' })], 'empty'),
  c([provider({ apiKey: 'k', model: 'm', baseUrl: null })], 'null'),
  c(
    [provider({ apiKey: 'k', model: 'm', baseUrl: `https://e.com/${'a'.repeat(2100)}` })],
    'too long',
  ),
  c(
    [provider({ apiKey: 'k', model: 'm', baseUrl: 'https://\u0131.example/\u017F' })],
    'non-ASCII host and path',
  ),
  c([provider({ apiKey: 'k', model: 'm', cliPath: 'codex' }, 'codex')], 'a bare command is kept'),
  c([provider({ apiKey: 'k', model: 'm', cliPath: '  codex  ' }, 'codex')], 'trimmed'),
  c(
    [provider({ apiKey: 'k', model: 'm', cliPath: '$DIR/bin/codex' }, 'codex')],
    'an existing file',
    guardFiles,
  ),
  c(
    [provider({ apiKey: 'k', model: 'm', cliPath: ' $DIR/bin/my codex ' }, 'codex')],
    'a path with a space',
    guardFiles,
  ),
  c(
    [provider({ apiKey: 'k', model: 'm', cliPath: '$DIR/bin/missing' }, 'codex')],
    'a file that is not there',
    guardFiles,
  ),
  c([provider({ apiKey: 'k', model: 'm', cliPath: '$DIR/adir' }, 'codex')], 'a folder', guardFiles),
  c(
    [provider({ apiKey: 'k', model: 'm', cliPath: './codex' }, 'codex')],
    'a relative path that is not there',
  ),
  c([provider({ apiKey: 'k', model: 'm', cliPath: '~' }, 'codex')], 'the home folder is no file'),
  c(
    [
      provider(
        { apiKey: 'k', model: 'm', cliPath: '~/no-such-program-for-the-comparison' },
        'codex',
      ),
    ],
    'a file under home that is not there',
  ),
  c(
    [provider({ apiKey: 'k', model: 'm', cliPath: '~\\x' }, 'codex')],
    'a backslash after the tilde',
  ),
  c([provider({ apiKey: 'k', model: 'm', cliPath: 'a~b' }, 'codex')], 'a tilde inside is a path'),
  c([provider({ apiKey: 'k', model: 'm', cliPath: longPath }, 'codex')], 'too long'),
  c([provider({ apiKey: 'k', model: 'm', cliPath: '   ' }, 'codex')], 'blank'),
  c([provider({ apiKey: 'k', model: 'm', cliPath: 5 }, 'codex')], 'a number'),
  c(
    [provider({ apiKey: 'k', model: 'm', cliPath: 'caf\u00e9-\u0131' }, 'codex')],
    'a non-ASCII command',
  ),
  c(
    [
      provider(
        {
          apiKey: 'k',
          model: 'm',
          effort: 'high',
          modelEfforts: {
            a: { efforts: ['low', 'bogus', 'max'], defaultEffort: 'max' },
            '10': { efforts: ['low'] },
            '2': { efforts: ['none'], defaultEffort: 'high' },
          },
        },
        'codex',
      ),
    ],
    'effort levels; integer model ids',
  ),
  c(
    [provider({ apiKey: 'k', model: 'm', effort: ' LOW ', modelEfforts: [] }, 'codex')],
    'an unknown level',
  ),
  c(
    [provider({ apiKey: 'token', model: 'm', baseUrl: 'https://gw/' }, 'gateway')],
    'a gateway token is cleared',
  ),
  c(
    [
      {
        provider: 'auto',
        providers: {
          gateway: { apiKey: 'token' },
          openai: { apiKey: 'k' },
          nope: { apiKey: 'x' },
          '2': {},
          '10': {},
          anthropic: 'text',
          kimi: null,
        },
      },
    ],
    'unknown ids dropped, wrong values become empty configs',
  ),
  c(
    [{ provider: 'auto', providers: { anthropic: {}, '10': {}, openai: {} } }],
    'order of the known ids',
  ),
  c([
    {
      provider: 'auto',
      providers: {},
      meteredAccepted: { 'claude-code': true, codex: 'yes', chatgpt: false, other: true },
    },
  ]),
  c([{ provider: 'auto', providers: {}, meteredAccepted: [true] }]),
  c([{ provider: 'auto', providers: {}, subscriptionOff: { codex: true, chatgpt: true } }]),
  c(
    [
      {
        provider: 'auto',
        providers: {},
        headlessSubscriptionEnabled: true,
        headlessSubscriptionConsentVersion: 2,
        subscriptionNoticeSeen: true,
        subscriptionNoticeVersion: 1,
        pdfSendNoticeSeen: 4,
        internetTools: false,
      },
    ],
    'every flag',
  ),
  c(
    [
      {
        provider: 'auto',
        providers: {},
        headlessSubscriptionEnabled: 'true',
        headlessSubscriptionConsentVersion: -1,
        subscriptionNoticeSeen: 1,
        subscriptionNoticeVersion: 1.5,
        pdfSendNoticeSeen: 0,
        internetTools: true,
      },
    ],
    'every flag wrong',
  ),
  c(
    [
      {
        provider: 'auto',
        providers: {},
        headlessSubscriptionConsentVersion: 0,
        subscriptionNoticeVersion: 0,
        pdfSendNoticeSeen: 1.5,
      },
    ],
    'boundaries',
  ),
  c(
    [{ provider: 'auto', providers: {}, readUrl: { githubToken: ` ${'t'.repeat(9000)} ` } }],
    'a bounded token',
  ),
  c([{ provider: 'auto', providers: {}, readUrl: { githubToken: ' ' } }], 'a blank token'),
  c(
    [
      {
        provider: 'auto',
        providers: {},
        customEndpoints: [
          {
            id: ` ${'i'.repeat(70)} `,
            name: 'n'.repeat(200),
            baseUrl: 'http://e.example',
            apiKey: ' k ',
            model: 'm',
            models: ['a', 5, 'b'.repeat(300)],
            effort: 'low',
            kind: 'local',
            timeoutMs: 90000,
            modelProfiles: { m: { contextLength: 2048, tools: true } },
          },
          { id: 'second', baseUrl: 'ftp://bad' },
          { id: '' },
          'x',
          [1],
          null,
          { id: 9 },
        ],
        customEndpoint: 'c'.repeat(80),
      },
    ],
    'endpoints',
  ),
  c(
    [
      {
        provider: 'auto',
        providers: {},
        customEndpoints: [{ id: 'a', models: [] }],
        customEndpoint: 5,
      },
    ],
    'an active id that is no text',
  ),
  c(
    [{ provider: 'auto', providers: {}, customEndpoints: [], customEndpoint: 'a' }],
    'no endpoint, no active id',
  ),
  c(
    [{ provider: 'auto', providers: {}, customEndpoints: [{ id: 'a', apiKey: { toString: 1 } }] }],
    'a TypeError inside an endpoint',
  ),
  c([{ provider: 'auto', providers: {}, maxOutputTokens: 5000.9 }], 'floored'),
  c([{ provider: 'auto', providers: {}, maxOutputTokens: 0.5 }], 'positive but floors to zero'),
  c([{ provider: 'auto', providers: {}, maxOutputTokens: 0 }], 'zero'),
  c([{ provider: 'auto', providers: {}, maxOutputTokens: -3 }]),
  c([{ provider: 'auto', providers: {}, maxOutputTokens: '9' }]),
  c(
    [
      {
        provider: 'auto',
        providers: {},
        media: {
          imageProvider: 'openai',
          providers: {
            openai: { apiKey: 'k', baseUrl: 'https://u:p@x/' },
            doubao: { apiKey: 'k', baseUrl: 'https://ok.example/v3#f' },
            glm: { apiKey: 'k', baseUrl: '' },
            qwen: { apiKey: 'k', baseUrl: null },
            xai: { apiKey: 'k', baseUrl: 7 },
            minimax: [1],
            bfl: 'text',
            '10': { apiKey: 'x' },
            '2': { apiKey: 'y' },
          },
        },
      },
    ],
    'media base URLs pass the same gate',
  ),
  c(
    [{ provider: 'auto', providers: {}, media: { imageProvider: 'openai' } }],
    'a media block without providers',
  ),
  c(
    [{ provider: 'auto', providers: {}, media: { providers: [] } }],
    'media providers that are an array',
  ),
  c([{ provider: 'auto', providers: {}, media: [1] }], 'media that is an array'),
  c(
    [
      {
        provider: 'auto',
        providers: {},
        search: { provider: 'serper', providers: { serper: { apiKey: 'k' } }, extra: 1 },
      },
    ],
    'search passes as it is',
  ),
  c([{ provider: 'auto', providers: {}, search: [] }], 'search that is an array'),
  c(
    [
      JSON.parse(
        '{"provider":"auto","providers":{},"media":{"providers":{"__proto__":{"apiKey":"p"},"openai":{"apiKey":"k"}}}}',
      ),
    ],
    'an own __proto__ key in media providers',
  ),
  c(
    [
      {
        provider: 'auto',
        providers: {},
        pdfSendNoticeSeen: 1.4,
        subscriptionNoticeVersion: 2.4,
        headlessSubscriptionConsentVersion: 3.4,
      },
    ],
    'fractions below one half are no whole numbers',
  ),
]

const guardFns: Group = {
  'ai-provider/ai-settings-guard.sanitizeAiSettings': {
    ts: (a) => sanitizeAiSettings(a[0]),
    cases: guardCases,
  },
  'ai-provider/ai-settings-guard.validCliPath': {
    ts: (a) => validCliPath((a[0] ?? undefined) as J),
    cases: [
      c(['codex']),
      c(['   ']),
      c(['$DIR/bin/codex'], 'a file', guardFiles),
      c(['$DIR/adir'], 'a folder', guardFiles),
      c(['$DIR/missing'], 'missing', guardFiles),
      c([longPath]),
      c(['x'.repeat(1024)], 'the longest bare command'),
      c(['x'.repeat(1025)]),
      c([5]),
      c([null]),
      c(['~']),
    ],
  },
  'ai-provider/ai-settings-guard.sanitizeCliPath': {
    ts: (a) => sanitizeCliPath((a[0] ?? undefined) as J),
    cases: [
      c([' codex ']),
      c(['  $DIR/bin/codex  '], 'trimmed', guardFiles),
      c(['$DIR/missing'], 'missing', guardFiles),
      c([5]),
      c([null]),
      c(['~']),
    ],
  },
}

// ---- ai-provider/settings-secrets ----

const secretSettings = {
  provider: 'auto',
  providers: {
    openai: { apiKey: 'sealed:v1:aa', model: 'm' },
    claude: 'x',
    anthropic: { apiKey: 'k' },
  },
  customEndpoints: [{ id: 'a', apiKey: 'sealed:v1:bb' }, 'x', { id: 'b', apiKey: 7 }],
  media: {
    imageProvider: 'openai',
    providers: { openai: { apiKey: 'sealed:v1:cc' }, '10': { apiKey: 'z' } },
  },
  search: { provider: 'serper', providers: { serper: { apiKey: 'plain' } } },
  readUrl: { githubToken: 'sealed:v1:dd' },
  extra: { apiKey: 'untouched' },
}

const secretsFns: Group = {
  'ai-provider/settings-secrets.SEALED_PREFIX': constant(SEALED_PREFIX),
  'ai-provider/settings-secrets.isSealedSecret': {
    ts: (a) => isSealedSecret(a[0]),
    cases: [
      c(['sealed:v1:abc']),
      c(['sealed:v1:']),
      c(['sealed:v2:abc']),
      c(['Sealed:v1:abc']),
      c(['']),
      c([5]),
      c([null]),
      c([['sealed:v1:x']]),
    ],
  },
  'ai-provider/settings-secrets.mapAiSecrets': {
    ts: (a) => mapAiSecrets(a[0], a[1] === 'empty' ? () => '' : (v: string) => `<${v}>`),
    cases: [
      c([secretSettings, 'wrap'], 'every secret field'),
      c([secretSettings, 'empty']),
      c([{ providers: { __proto: { apiKey: 'a' } } }, 'wrap']),
      c(
        [JSON.parse('{"providers":{"__proto__":{"apiKey":"a"},"x":{"apiKey":"b"}}}'), 'wrap'],
        'an own __proto__ key',
      ),
      c(
        [
          { providers: 'text', customEndpoints: 'text', media: [1], search: 5, readUrl: 'x' },
          'wrap',
        ],
        'fields of the wrong shape',
      ),
      c([{ media: {}, search: { provider: 'x' } }, 'wrap'], 'blocks without a table'),
      c([{ providers: null }, 'wrap']),
      c([{ providers: { '10': { apiKey: 'a' }, '2': { apiKey: 'b' } } }, 'wrap'], 'integer keys'),
      c(['text', 'wrap'], 'not settings'),
      c([[1], 'wrap']),
      c([null, 'wrap']),
    ],
  },
  'ai-provider/settings-secrets.sealedAiSecretsIn': {
    ts: (a) => sealedAiSecretsIn(a[0]),
    cases: [
      c([
        {
          ...secretSettings,
          customEndpoints: [{ apiKey: 'sealed:v1:aa' }, { apiKey: 'sealed:v1:zz' }],
        },
      ]),
      c([{ providers: { a: { apiKey: 'plain' } } }]),
      c([null]),
    ],
  },
  'ai-provider/settings-secrets.openSecretValue': {
    ts: (a) => withCodec(a[0], () => openSecretValue(str(a, 1))),
    cases: [
      c(['fake', 'plain']),
      c(['fake', '']),
      c(['fake', 'sealed:v1:a%20b']),
      c(['fake', 'sealed:v1:%E2%82%AC']),
      c(['fake', 'sealed:v1:null'], 'the codec cannot open it'),
      c(['fake', 'sealed:v1:throw'], 'the codec throws'),
      c(['fake', 'sealed:v1:%'], 'a malformed escape throws'),
      c(['none', 'sealed:v1:abc'], 'no codec'),
      c(['none', 'plain']),
    ],
  },
  'ai-provider/settings-secrets.sealSecretValue': {
    ts: (a) => withCodec(a[0], () => sealSecretValue(str(a, 1))),
    cases: [
      c(['fake', 'sk-1']),
      c(['fake', 'a b\u00e9\u{1F600}']),
      c(['fake', '']),
      c(['fake', 'sealed:v1:x'], 'already sealed'),
      c(['fake', '!keep'], 'the codec cannot seal now'),
      c(['fake', '?boom'], 'the codec throws'),
      c(['none', 'sk-1'], 'no codec'),
    ],
  },
  'ai-provider/settings-secrets.openAiSecrets': {
    ts: (a) => withCodec(a[0], () => openAiSecrets(a[1])),
    cases: [
      c([
        'fake',
        {
          providers: { a: { apiKey: 'sealed:v1:k%201' }, b: { apiKey: 'sealed:v1:null' } },
          readUrl: { githubToken: 'sealed:v1:t' },
        },
      ]),
      c(['none', { providers: { a: { apiKey: 'sealed:v1:k' } } }]),
      c(['fake', 'text']),
    ],
  },
  'ai-provider/settings-secrets.sealAiSecrets': {
    ts: (a) => withCodec(a[0], () => sealAiSecrets(a[1])),
    cases: [
      c(['fake', secretSettings]),
      c(
        ['fake', { providers: { a: { apiKey: '' }, b: { apiKey: '!x' }, c: { apiKey: '?y' } } }],
        'empty, plain-forever and throwing keys stay',
      ),
      c(['none', secretSettings], 'no codec'),
      c(['fake', null]),
    ],
  },
}

// ---- ai-provider/{run-error,overload-error,network-error,free-ai,watchdog} ----

const resetsFuture = 1_794_538_800
const resetsPast = 1_794_400_000
const orText = (reset: string) =>
  `Rate limit exceeded: free-models-per-day. {"headers":{"X-RateLimit-Reset":"${reset}"}}`

const errorCases: unknown[][] = [
  [
    {
      $class: 'AiRunError',
      kind: 'rate-limit',
      message: 'limit',
      provider: 'claude-code',
      resetsAt: 1234,
    },
  ],
  [{ $class: 'AiRunError', kind: 'not-installed', message: 'm' }],
  [{ $class: 'AiRunError', kind: 'signed-out', message: 'm', provider: null }],
  [{ $class: 'AiRunError', kind: 'headless-limit', message: 'm', resetsAt: 0 }],
  [{ $class: 'AiTimeoutError', ms: 60000 }],
  [{ $class: 'AiTimeoutError', ms: 1499 }],
  [{ $class: 'AiCreditsError', message: 'Your credits have been exhausted' }],
  [err('x', { cause: { $class: 'AiCreditsError', message: 'c' } })],
  ['fetch failed'],
  [err('Claude fetch failed: cause=ECONNRESET')],
  [err('boom', { code: 'ECONNREFUSED' })],
  [err('boom', { code: 'ERR_CONNECTION_TIMED_OUT' })],
  [err('boom', { code: 'err_connection_closed' })],
  [err('x', { cause: err('y', { cause: err('socket hang up') }) })],
  [err('request ERR_CONNECTION_ please')],
  [{ message: 'plain object: ECONNRESET' }],
  [{ code: 'EPIPE' }],
  [{ code: 5, message: 5 }],
  [
    err(
      'Quota exceeded for quota metric "generate_content_free_tier_requests", limit: 0, model: gemini-4-argon',
    ),
  ],
  [err('FreeTier ... "quotaValue": "0"')],
  [err('FreeTier only, no zero')],
  [err('RESOURCE_EXHAUSTED GenerateRequestsPerDayPerProjectPerModel-FreeTier limit: 20')],
  [err('RESOURCE_EXHAUSTED FreeTier-PerDay quota, limit: 0')],
  [orText(String(resetsFuture))],
  [orText(String(resetsPast))],
  [orText(String(resetsFuture * 1000))],
  [orText('12345')],
  [err('Rate limit exceeded: free-models-per-day. Add 10 credits')],
  [err('x', { cause: err(`free-models-per-day X-RateLimit-Reset\\":\\"${resetsFuture}`) })],
  [err('HTTP 429: too many requests')],
  [err('Claude HTTP 529: Overloaded')],
  [err('the engine is overloaded')],
  [err('Rate-limit hit')],
  [err('ratelimit hit')],
  [err('RESOURCE EXHAUSTED')],
  [err('Resource has been exhausted (e.g. check quota).')],
  [err('quota exceeded')],
  [err('Your credits have been exhausted. HTTP 429')],
  [err('credits per minute exceeded, rate limit')],
  [err('insufficient credits, rate limit')],
  [err('pricing page, rate limit')],
  [err('pricing page, HTTP 503')],
  [err('rate limit\ncredits exhausted')],
  [err('overloaded', { cause: err('inner') })],
  [
    err('inner', {
      cause: err('mid', {
        cause: err('deep', {
          cause: err('deeper', { cause: err('deepest', { cause: err('rate limit') }) }),
        }),
      }),
    }),
  ],
  [
    err('inner', {
      cause: err('mid', {
        cause: err('deep', { cause: err('deeper', { cause: err('rate limit') }) }),
      }),
    }),
  ],
  ['too many requests'],
  ['plain failure'],
  ['HTTP 4290'],
  ['x HTTP 429 y'],
  ['HTTP  429'],
  ['rate\u017Flimit'],
  ['\u212Aate limit overload'],
  ['ECONNRESET'.toLowerCase()],
  ['erro\u0131_network'],
  ['overlo\u0131ad'],
  [err('')],
  [err('', { cause: err('rate limit') })],
  [{}],
  [null],
  [0],
  [5],
  [[1, 2]],
  [['rate limit']],
  [{ cause: 'rate limit' }],
  [{ cause: { message: 'fetch failed' } }],
  [{ message: 5, cause: 'overloaded' }],
  [err('HTTP 529')],
  [err('upstream said HTTP 529: busy')],
  [err('credits low, HTTP 529')],
  [
    err('inner', {
      cause: err('mid', {
        cause: err('deep', {
          cause: err('deeper', { cause: err('deepest', { cause: err('fetch failed') }) }),
        }),
      }),
    }),
  ],
  [
    err('inner', {
      cause: err('mid', {
        cause: err('deep', { cause: err('deeper', { cause: err('fetch failed') }) }),
      }),
    }),
  ],
]

const clockCases: Case[] = errorCases.map((e) => c(e))

const errorFns: Group = {
  'ai-provider/run-error.aiStreamErrorFields': {
    ts: (a, cx) => withNow(cx.now, () => aiStreamErrorFields(build(a[0]) as J)),
    cases: clockCases,
  },
  'ai-provider/overload-error.isAiOverloadedError': {
    ts: (a) => isAiOverloadedError(build(a[0])),
    cases: clockCases,
  },
  'ai-provider/network-error.isAiNetworkError': {
    ts: (a) => isAiNetworkError(build(a[0])),
    cases: clockCases,
  },
  'ai-provider/free-ai.isFreeTierModelRefusal': {
    ts: (a) => isFreeTierModelRefusal(build(a[0])),
    cases: clockCases,
  },
  'ai-provider/free-ai.freeLimitOf': {
    ts: (a) => freeLimitOf(build(a[0]), a[1] as number),
    cases: errorCases.map((e) => c([e[0], NOW])),
  },
  'ai-provider/free-ai.nextPacificMidnight': {
    ts: (a) => nextPacificMidnight(a[0] as number),
    cases: [
      NOW,
      Date.UTC(2026, 2, 8, 9, 59, 59),
      Date.UTC(2026, 2, 8, 10, 0, 0),
      Date.UTC(2026, 10, 1, 8, 59, 59),
      Date.UTC(2026, 10, 1, 9, 0, 0),
      Date.UTC(2025, 6, 4, 12, 30, 15),
      Date.UTC(2007, 2, 11, 10, 0, 0),
      Date.UTC(2006, 3, 2, 9, 59, 59),
      Date.UTC(2006, 3, 2, 10, 0, 0),
      Date.UTC(2005, 3, 3, 10, 0, 0),
      Date.UTC(1999, 9, 31, 8, 59, 59),
      Date.UTC(1999, 9, 31, 9, 0, 0),
      Date.UTC(1987, 3, 5, 10, 0, 0),
      Date.UTC(1986, 3, 27, 10, 0, 0),
      Date.UTC(1980, 3, 27, 9, 59, 59),
      Date.UTC(1975, 1, 23, 10, 0, 0),
      Date.UTC(1974, 0, 6, 10, 0, 0),
      Date.UTC(1974, 3, 28, 12, 0, 0),
      Date.UTC(1970, 3, 26, 10, 0, 0),
      Date.UTC(1970, 6, 1, 0, 0, 0),
      Date.UTC(1967, 5, 1, 12, 0, 0),
      Date.UTC(2040, 2, 11, 10, 0, 0),
      Date.UTC(2038, 0, 19, 3, 14, 7),
      NOW + 999,
      NOW + 0.5,
      Date.UTC(2026, 6, 4, 7, 0, 0),
      Date.UTC(2026, 6, 4, 6, 59, 59),
    ].map((now) => c([now])),
  },
  'ai-provider/watchdog.normalizeWatchdogTimeout': {
    ts: (a) => normalizeWatchdogTimeout(a[0] as number, a[1] as number),
    cases: [
      c([60000, 1]),
      c([0, 7]),
      c([-5, 7]),
      c([null, 7], 'not a number'),
      c([500, 7], 'raised to the floor'),
      c([1000, 7]),
      c([600000, 7]),
      c([600001, 7], 'lowered to the cap'),
      c([1e300, 7]),
      c([0.0001, 7]),
      c([1500.5, 7]),
      c(['5000', 7]),
    ],
  },
}

// ---- ai-provider/{registry,effort,search-settings,media,local-profile,custom-endpoints} ----

const utilFns: Group = {
  'ai-provider/registry.normalizeBaseUrl': {
    ts: (a) => normalizeBaseUrl((a[0] ?? undefined) as J, str(a, 1)),
    cases: [
      c(['https://api.example.com/v1', '']),
      c([' https://api.example.com/v1?api-version=2 ', '']),
      c(['https://api.example.com/v1#frag', '']),
      c(['https://api.example.com#', '']),
      c(['HTTP://EXAMPLE.com:80/x', '']),
      c([null, 'https://fallback.example/']),
      c(['', 'https://fallback.example/'], 'empty is no fallback'),
      c([null, '']),
      c(['   ', 'x']),
      c([`https://e.com/${'a'.repeat(2100)}`, '']),
      c([`https://e.com/${'a'.repeat(2025)}`, ''], 'just under the bound'),
      c(['ftp://example.com', '']),
      c(['javascript:alert(1)', '']),
      c(['file:///etc/passwd', '']),
      c(['https://u:p@example.com', '']),
      c(['https://u@example.com', '']),
      c(['http://[::1]:8080/v1', '']),
      c(['http://localhost:11434', '']),
      c(['example.com/v1', '']),
      c(['https://\u0131.example/\u017F?k=\u212A', '']),
      c(['https://exa mple.com/', '']),
      c(['https://example.com/\u{1F600}', '']),
      c([`https://a.com/${'x'.repeat(2048 - 14)}`, ''], 'exactly 2048 units'),
      c([`https://a.com/${'x'.repeat(2049 - 14)}`, ''], 'one past the bound'),
    ],
  },
  'ai-provider/effort.aiEffortOf': {
    ts: (a) => aiEffortOf(a[0]),
    cases: [
      c(['high']),
      c([' max ']),
      c(['HIGH']),
      c(['']),
      c(['none']),
      c(['\uFEFFlow']),
      c(['\u0085low']),
      c([5]),
      c([null]),
    ],
  },
  'ai-provider/effort.aiEffortsOf': {
    ts: (a) => aiEffortsOf(a[0]),
    cases: [
      c([['max', 'low', 'low', ' high ', 'bogus', 5]]),
      c([['bogus']]),
      c([[]]),
      c(['low']),
      c([{ 0: 'low' }]),
      c([null]),
      c([['max', 'xhigh', 'none', 'minimal', 'medium', 'high', 'low']], 'every level, shuffled'),
    ],
  },
  'ai-provider/effort.aiModelEffortOf': {
    ts: (a) => aiModelEffortOf(a[0]),
    cases: [
      c([{ efforts: ['low', 'high'], defaultEffort: 'high' }]),
      c([{ efforts: ['low'], defaultEffort: 'high' }], 'a default that is no level of the model'),
      c([{ efforts: ['high', 'low'], defaultEffort: 'bogus' }]),
      c([{ efforts: ['bogus'] }]),
      c([{}]),
      c([[]]),
      c(['x']),
      c([null]),
    ],
  },
  'ai-provider/effort.aiModelEffortsOf': {
    ts: (a) => aiModelEffortsOf(a[0]),
    cases: [
      c(
        [
          {
            b: { efforts: ['low'] },
            '10': { efforts: ['high'] },
            '2': { efforts: ['max'], defaultEffort: 'max' },
          },
        ],
        'integer keys come first',
      ),
      c(
        [
          {
            ' pad ': { efforts: ['low'] },
            '': { efforts: ['low'] },
            ['x'.repeat(257)]: { efforts: ['low'] },
            ['y'.repeat(256)]: { efforts: ['low'] },
          },
        ],
        'trimmed ids and the length bound',
      ),
      c([{ a: { efforts: [] }, b: 5, c: null }]),
      c(
        [JSON.parse('{"__proto__":{"efforts":["low"]},"a":{"efforts":["low"]}}')],
        'an own __proto__ key is counted and not kept',
      ),
      c([JSON.parse('{"__proto__":{"efforts":["low"]}}')], 'only a __proto__ key'),
      c([{ ' a ': { efforts: ['low'] }, a: { efforts: ['high'] } }], 'two keys that trim alike'),
      c(
        [
          Object.fromEntries(
            Array.from({ length: 2100 }, (_, i) => [`m${i}`, { efforts: ['low'] }]),
          ),
        ],
        'bounded to 2000',
      ),
      c([[{ efforts: ['low'] }]]),
      c([null]),
    ],
  },
  'ai-provider/search-settings.defaultAiSearchSettings': {
    ts: () => defaultAiSearchSettings(),
    cases: [c([]), c([], 'again')],
    single: 'a constant',
  },
  'ai-provider/search-settings.resolveAiSearchSettings': {
    ts: (a) => resolveAiSearchSettings((a[0] ?? undefined) as J),
    cases: [
      c([null]),
      c([
        {
          provider: 'serper',
          providers: {
            serper: { apiKey: ' k ' },
            tavily: { apiKey: 5 },
            exa: {},
            keenable: { apiKey: '' },
          },
        },
      ]),
      c([{ providers: { parallel: { apiKey: 'p' } } }]),
      c([{ provider: null }], 'null falls to the default'),
      c([{ provider: 'unknown-id' }], 'kept as it is'),
      c([{ provider: 5, providers: [] }]),
      c([0], 'falsy'),
      c(['text'], 'truthy, no fields'),
      c([[{ provider: 'x' }]]),
    ],
  },
  'ai-provider/media.defaultAiMediaSettings': {
    ts: () => defaultAiMediaSettings(),
    cases: [c([]), c([], 'again')],
    single: 'a constant',
  },
  'ai-provider/media.resolveAiMediaSettings': {
    ts: (a) => resolveAiMediaSettings((a[0] ?? undefined) as J),
    cases: [
      c([null]),
      c([{ provider: 'openai' }], 'the pre-catalog choice seeds both'),
      c([{ provider: 'chat' }]),
      c([{ provider: 'gemini', analysisProvider: 'chat' }]),
      c([{ imageProvider: 'none', analysisProvider: 'chat', videoAnalysisProvider: 'gemini' }]),
      c([{ analysisProvider: 'doubao' }], 'video follows the analysis choice'),
      c([
        {
          analysisProvider: null,
          imageProvider: null,
          videoAnalysisProvider: null,
          provider: 'xai',
        },
      ]),
      c(
        [
          {
            providers: {
              openai: { apiKey: ' k ', imageModel: ' m ', analysisModel: 7, baseUrl: ' u ' },
              custom: { apiKey: 5, baseUrl: null },
              microsoft: { baseUrl: 'x' },
              zzz: { apiKey: 'z', baseUrl: 'b' },
            },
          },
        ],
        'trimmed strings, unknown ids kept',
      ),
      c(
        [{ providers: { '10': { apiKey: 'a' }, '2': { apiKey: 'b' }, openai: { apiKey: 'c' } } }],
        'integer keys come first',
      ),
      c(
        [{ providers: [{ apiKey: 'a' }, null, 'x', { imageModel: 'i' }] }],
        'a list of configs: indexes are ids',
      ),
      c([{ providers: 'text' }], 'a string of characters'),
      c([{ providers: 5 }]),
      c(
        [JSON.parse('{"providers":{"__proto__":{"apiKey":"p"},"gemini":{"apiKey":"g"}}}')],
        'an own __proto__ key',
      ),
      c([0], 'falsy'),
      c(['text'], 'truthy, no fields'),
      c([[1]]),
    ],
  },
  'ai-provider/local-profile.localEndpointFieldsOf': {
    ts: (a) => localEndpointFieldsOf(a[0]),
    cases: [
      c([
        {
          kind: 'local',
          timeoutMs: 60000,
          modelProfiles: {
            m: {
              contextLength: 10000000,
              maxContextLength: 10000001,
              tools: false,
              vision: true,
              contextSource: 'user',
              toolsSource: 'server',
              visionSource: 'test',
              checkedAt: 5,
              notes: ` ${'n'.repeat(600)} `,
              efforts: ['high', 'low'],
              defaultEffort: 'low',
            },
          },
        },
      ]),
      c([{ kind: 'remote', timeoutMs: 59999 }]),
      c([{ timeoutMs: 600000.5 }]),
      c([{ timeoutMs: 600000 }]),
      c(
        [
          {
            modelProfiles: {
              '10': { tools: true },
              '2': { vision: false },
              b: { contextLength: 0 },
              [' ']: { tools: true },
              ['k'.repeat(257)]: { tools: true },
              ' pad ': { tools: true, contextSource: 'bogus' },
            },
          },
        ],
        'integer ids first, trimmed',
      ),
      c(
        [
          {
            modelProfiles: {
              m: {
                checkedAt: -1,
                contextLength: 1.5,
                tools: 'yes',
                notes: '   ',
                efforts: ['bogus'],
                defaultEffort: 'low',
              },
            },
          },
        ],
        'every field malformed: the entry is dropped',
      ),
      c(
        [{ modelProfiles: { m: { efforts: ['low'], defaultEffort: 'high' } } }],
        'a default outside the levels',
      ),
      c([JSON.parse('{"modelProfiles":{"__proto__":{"tools":true}}}')], 'an own __proto__ id'),
      c([{ modelProfiles: [] }]),
      c([[1]]),
      c(['x']),
      c([null]),
      c(
        [
          {
            kind: 'local',
            modelProfiles: {
              m: { contextLength: 4096, tools: true, vision: false, checkedAt: 7.4 },
            },
          },
        ],
        'a fractional checkedAt',
      ),
    ],
  },
  'ai-provider/custom-endpoints.resolveCustomEndpoints': {
    ts: (a) => maskIds(resolveCustomEndpoints(a[0] as J)),
    cases: [
      c(
        [
          {
            provider: 'custom',
            providers: { custom: { apiKey: 'k', model: 'm', baseUrl: 'http://x' } },
          },
        ],
        'a slot without a list seeds one entry',
      ),
      c(
        [{ provider: 'custom', providers: { custom: { apiKey: '', model: '', baseUrl: '' } } }],
        'an empty slot',
      ),
      c([{ providers: {}, customEndpoint: '' }], 'an explicit empty id survives'),
      c([{ providers: {}, customEndpoint: 'x' }], 'a stale id without a list is dropped'),
      c(
        [
          {
            providers: { a: { apiKey: 'x' } },
            customEndpoints: [
              { id: 'e1', baseUrl: 'http://1', apiKey: 'k1', model: 'm1' },
              {
                id: 'e2',
                baseUrl: 'http://2',
                apiKey: 'k2',
                model: 'm2',
                effort: 'high',
                modelProfiles: { m2: { efforts: ['low', 'high'], defaultEffort: 'low' } },
              },
            ],
            customEndpoint: 'e2',
          },
        ],
        'the active entry is mirrored with its levels',
      ),
      c(
        [
          {
            customEndpoints: [
              {
                id: 'e1',
                model: '__proto__',
                effort: 'max',
                modelProfiles: { m: { efforts: ['low'] } },
              },
            ],
          },
        ],
        'a model named __proto__',
      ),
      c(
        [
          {
            providers: {},
            customEndpoints: [{ id: 'e1', baseUrl: 'http://1' }],
            customEndpoint: '  ',
          },
        ],
        'an explicit empty id clears the slot',
      ),
      c(
        [{ providers: 'text', customEndpoints: [{ id: 'e1' }] }],
        'providers that are a string spread as characters',
      ),
      c(
        [{ providers: [1, 2], customEndpoints: [{ id: 'e1' }], extra: 1 }],
        'providers that are an array spread as indexes',
      ),
      c([{ b: 1, customEndpoints: [{ id: 'e1' }], a: 2 }], 'keys that are set later come last'),
      c(
        [{ customEndpoints: [{ id: 'e1' }], customEndpoint: 'e1', provider: 'x', providers: null }],
        'null providers',
      ),
    ],
  },
}

// ---- docs/ai-run and sheets/ai-run ----

const docsTexts: docsAiRun.AiRunTexts = {
  noApiKey: (p) => `no key for ${p}`,
  noModel: () => 'no model',
}

const runStatuses = {
  none: {},
  claude: claudeOnly(),
  codexSignedOut: { codex: status('codex', 'signed-out') },
}

const sealedFile = {
  provider: 'anthropic',
  providers: { anthropic: { apiKey: 'sealed:v1:sk%2D9', model: 'claude-sonnet-5-5' } },
}

const docsRunCases: Case[] = [
  c(['none', 'not settings', {}], 'a payload that is no object'),
  c(['none', null, {}]),
  c(['none', { provider: 'nope', providers: {} }, {}], 'an unknown provider'),
  c(
    ['none', { provider: 'auto', providers: {} }, runStatuses.claude],
    'auto lands on a ready subscription',
  ),
  c(['none', { provider: 'auto', providers: {} }, {}], 'auto with no status'),
  c(
    ['none', keyed('anthropic', { apiKey: 'k', model: 'claude-sonnet-5-5' }), {}],
    'a key provider that can run',
  ),
  c(
    ['none', keyed('anthropic', { apiKey: '', model: 'claude-sonnet-5-5' }), {}],
    'a key provider with a model and no key',
  ),
  c(['none', keyed('anthropic', { apiKey: '', model: '' }), {}], 'a key provider with no model'),
  c(
    ['none', { provider: 'claude-code', providers: {} }, runStatuses.claude],
    'a subscription with no entry',
  ),
  c(
    [
      'none',
      { provider: 'claude-code', providers: {} },
      { 'claude-code': status('claude-code', 'not-installed') },
    ],
    'not installed',
  ),
  c(
    [
      'none',
      { provider: 'claude-code', providers: {} },
      { 'claude-code': status('claude-code', 'signed-out') },
    ],
    'signed out',
  ),
  c(
    [
      'none',
      { provider: 'claude-code', providers: {} },
      { 'claude-code': status('claude-code', 'metered', { meteredAccepted: false }) },
    ],
    'a metered login not allowed',
  ),
  c(
    [
      'none',
      { provider: 'claude-code', providers: {} },
      { 'claude-code': status('claude-code', 'checking') },
    ],
    'still checking',
  ),
  c(['none', { provider: 'claude-code', providers: {} }, {}], 'no status yet'),
  c(
    [
      'none',
      { provider: 'codex', providers: {} },
      { codex: status('codex', 'error', { error: 'the CLI failed' }) },
    ],
    'the status error text',
  ),
  c(
    ['none', { provider: 'codex', providers: {} }, { codex: status('codex', 'error') }],
    'an error without text',
  ),
  c(
    [
      'none',
      { provider: 'codex', providers: {}, subscriptionOff: { codex: true } },
      { codex: ready('codex') },
    ],
    'turned off in this app',
  ),
  c(
    [
      'none',
      { provider: 'claude-code', providers: {}, meteredAccepted: { 'claude-code': true } },
      { 'claude-code': status('claude-code', 'metered', { meteredAccepted: true }) },
    ],
    'an accepted metered login',
  ),
  c(
    [
      'none',
      {
        provider: 'codex',
        providers: { codex: { apiKey: '', model: 'gpt', cliPath: 'codex', effort: 'high' } },
      },
      { codex: ready('codex') },
    ],
    'a stored entry of a subscription',
  ),
  c(['fake', sealedFile, {}], 'sealed keys of the request open'),
  c(['none', sealedFile, {}], 'no codec: the key is empty'),
  c(['none', provider({ apiKey: { toString: 'x' } }), {}], 'a TypeError of the settings guard'),
  c(
    [
      'none',
      {
        provider: 'custom',
        providers: { custom: { apiKey: '', model: 'm', baseUrl: 'http://localhost:1234/v1' } },
        customEndpoints: [{ id: 'a', model: 'm', baseUrl: 'http://localhost:1234/v1' }],
      },
      {},
    ],
    'a custom endpoint list',
  ),
]

const withMeteredCases: Case[] = [
  c(['none', null, 'claude-code', true], 'nothing stored'),
  c([
    'none',
    { provider: 'openai', providers: { openai: { apiKey: 'k', model: 'm' } } },
    'codex',
    true,
  ]),
  c(
    ['none', { providers: {}, meteredAccepted: { 'claude-code': true } }, 'claude-code', false],
    'taken back',
  ),
  c(
    ['none', { providers: {}, meteredAccepted: { 'claude-code': true } }, 'chatgpt', true],
    'a provider with no entry yet',
  ),
  c(
    ['fake', { providers: { openai: { apiKey: 'sealed:v1:k', model: 'm' } } }, 'codex', true],
    'sealed keys are opened by the read',
  ),
]

const streamChunkCases: Case[] = errorCases.slice(0, 22).map((e, i) => c([`req-${i}`, e[0]]))

const toErrorCases: Case[] = [
  c(['r1', { $class: 'Error', message: 'boom' }]),
  c(['r1', { $class: 'AiRunError', kind: 'signed-out', message: 'sign in', provider: 'codex' }]),
  c(['r2', 'a string']),
  c(['r2', 5]),
  c(['r2', { message: 'plain' }]),
  c(['r2', { toString: 'x' }], 'an object that converts to no primitive'),
  c([
    'r3',
    { $class: 'Error', message: 'fetch failed', cause: { $class: 'Error', message: 'ECONNRESET' } },
  ]),
  c(['r4', { $class: 'AiTimeoutError', ms: 180000 }]),
  c(['r5', { $class: 'AiCreditsError', message: 'credits exhausted' }]),
  c(['r6', null]),
  c(['r6', [1, 2]]),
  c(['\u{1F600}', { $class: 'Error', message: 'HTTP 429' }]),
]

const failureCases: Case[] = [
  c([{ $class: 'Error', message: 'HTTP 429 too many' }, 'The AI is busy']),
  c([{ $class: 'Error', message: 'boom' }, 'The AI is busy']),
  c(['rate limit hit', 'busy']),
  c(['plain text', 'busy']),
  c([
    { $class: 'AiRunError', kind: 'not-installed', message: 'm', provider: 'claude-code' },
    'busy',
  ]),
  c([{ $class: 'AiTimeoutError', ms: 5000 }, 'busy']),
  c([{ $class: 'AiCreditsError', message: 'credits' }, 'busy']),
  c([{ message: 'overloaded' }, 'busy'], 'a plain object'),
  c([{ toString: 1 }, 'busy'], 'an object that converts to no primitive'),
  c([null, 'busy']),
  c([5, 'busy']),
  c([{ $class: 'Error', message: '' }, 'busy']),
]

const callbackCases: Case[] = [
  c(['req-1', [{ provider: 'claude-code', window: 'five_hour', utilization: 0.5, resetsAt: 123 }]]),
  c(['req-2', []]),
  c(['\u{1F600}', [{ provider: 'codex', window: 'seven_day', utilization: 1, resetsAt: 0 }]]),
]

function streamCallbacks(
  make: (id: string, send: (chunk: J) => void) => J,
): (a: unknown[], cx: TsContext) => unknown {
  return (a, cx) => {
    const callbacks = make(str(a, 0), (chunk) => cx.log('send', chunk))
    callbacks.onSubscriptionUsage(a[1])
    callbacks.onInputTruncated()
    return undefined
  }
}

const docsRunFns: Group = {
  'docs/ai-run.AI_INVALID_SETTINGS_ERROR': constant(docsAiRun.AI_INVALID_SETTINGS_ERROR),
  'docs/ai-run.resolveAiRun': {
    ts: (a) => withCodec(a[0], () => maskIds(docsAiRun.resolveAiRun(a[1], a[2] as J, docsTexts))),
    cases: docsRunCases,
  },
  'docs/ai-run.subscriptionStreamCallbacks': {
    ts: streamCallbacks((id, send) => docsAiRun.subscriptionStreamCallbacks(id, send)),
    cases: callbackCases,
  },
  'docs/ai-run.aiStreamErrorChunk': {
    ts: (a, cx) =>
      withNow(cx.now, () => docsAiRun.aiStreamErrorChunk(str(a, 0), build(a[1], true))),
    cases: [...toErrorCases, ...streamChunkCases],
  },
  'docs/ai-run.aiChatFailure': {
    ts: (a, cx) =>
      withNow(cx.now, () => docsAiRun.aiChatFailure(build(a[0], true), () => str(a, 1))),
    cases: failureCases,
  },
  'docs/ai-run.withMeteredAccepted': {
    ts: (a) =>
      withCodec(a[0], () =>
        maskIds(docsAiRun.withMeteredAccepted(a[1], a[2] as J, a[3] as boolean)),
      ),
    cases: withMeteredCases,
  },
  'docs/ai-run.withSubscriptionOff': {
    ts: (a) =>
      withCodec(a[0], () =>
        maskIds(docsAiRun.withSubscriptionOff(a[1], a[2] as J, a[3] as boolean)),
      ),
    cases: [
      c(['none', null, 'codex', true], 'turned off'),
      c(
        ['none', { providers: {}, subscriptionOff: { codex: true } }, 'codex', false],
        'turned back on: the key goes',
      ),
      c(
        [
          'none',
          { providers: {}, subscriptionOff: { codex: true, 'claude-code': true } },
          'codex',
          false,
        ],
        'another stays off',
      ),
      c(['none', { providers: {}, subscriptionOff: { codex: true } }, 'claude-code', true]),
      c(
        [
          'none',
          {
            provider: 'openai',
            providers: { openai: { apiKey: 'k', model: 'm' } },
            maxOutputTokens: 5000,
          },
          'codex',
          true,
        ],
        'the key comes last',
      ),
      c(['none', { providers: {} }, 'codex', false], 'nothing to turn on'),
    ],
  },
}

const sheetsRunFns: Group = {
  'sheets/ai-run.aiSettingsFromStored': {
    ts: (a) => withCodec(a[0], () => maskIds(sheetsAiRun.aiSettingsFromStored(a[1]))),
    cases: [
      c(['none', null]),
      c(['none', { provider: 'openai', providers: { openai: { apiKey: ' k ', model: 'm' } } }]),
      c(['fake', sealedFile]),
      c(['none', { apiKey: 'k', model: 'm' }]),
    ],
  },
  'sheets/ai-run.resolveAiRunTarget': {
    ts: (a) => withCodec(a[0], () => maskIds(sheetsAiRun.resolveAiRunTarget(a[1], a[2] as J))),
    cases: [
      c(
        ['none', { provider: 'auto', providers: {} }, runStatuses.claude],
        'auto lands on a ready subscription',
      ),
      c(['none', { provider: 'auto', providers: {} }, {}], 'auto with no status'),
      c(['none', null, {}], 'nothing stored'),
      c(['none', keyed('anthropic', { apiKey: 'k', model: 'm' }), {}], 'a key provider'),
      c(['none', keyed('anthropic', { apiKey: '', model: 'm' }), {}], 'not configured'),
      c(
        ['none', { provider: 'codex', providers: {} }, { codex: status('codex', 'signed-out') }],
        'a subscription that cannot run',
      ),
      c(
        [
          'none',
          { provider: 'claude-code', providers: {} },
          { 'claude-code': status('claude-code', 'bogus') },
        ],
        'a state no check writes',
      ),
      c(
        ['none', { provider: 'openai', providers: {} }, {}],
        'a key provider that cannot run names no subscription',
      ),
      c(['fake', sealedFile, {}], 'sealed keys open'),
      c(
        [
          'none',
          { provider: 'claude-code', providers: {}, subscriptionOff: { 'claude-code': true } },
          claudeOnly(),
        ],
        'turned off',
      ),
    ],
  },
  'sheets/ai-run.aiRunBlockChunk': {
    ts: (a) => sheetsAiRun.aiRunBlockChunk(str(a, 0), a[1] as J),
    cases: [
      c([
        'r1',
        {
          error: 'AI is not connected (signed-out)',
          errorCode: 'signed-out',
          errorProvider: 'codex',
        },
      ]),
      c(['r2', { error: 'AI is not connected (no-subscription)', errorCode: 'not-connected' }]),
      c(['\u{1F600}', { error: '', errorCode: 'off-in-app' }]),
    ],
  },
  'sheets/ai-run.aiStreamErrorChunk': {
    ts: (a, cx) =>
      withNow(cx.now, () => sheetsAiRun.aiStreamErrorChunk(str(a, 0), build(a[1], true))),
    cases: [...toErrorCases, ...streamChunkCases.slice(0, 8)],
  },
  'sheets/ai-run.subscriptionStreamCallbacks': {
    ts: streamCallbacks((id, send) => sheetsAiRun.subscriptionStreamCallbacks(id, send)),
    cases: callbackCases,
  },
  'sheets/ai-run.withMeteredAccepted': {
    ts: (a) =>
      withCodec(a[0], () =>
        maskIds(sheetsAiRun.withMeteredAccepted(a[1], a[2] as J, a[3] as boolean)),
      ),
    cases: withMeteredCases,
  },
}

// ---- ai-keepalive ----

/** `setInterval` and `clearInterval` are fakes that log; `tick` fires the interval while it is set */
function keepalive(first: boolean): (a: unknown[], cx: TsContext) => unknown {
  return (a, cx) => {
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    let active = false
    let callback: (() => void) | undefined
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      cx.log('setInterval', ms)
      callback = fn
      active = true
      return 1
    }) as unknown as typeof setInterval
    globalThis.clearInterval = ((handle: unknown) => {
      cx.log('clearInterval', handle)
      active = false
    }) as unknown as typeof clearInterval
    try {
      const send = () => cx.log('send')
      const interval = (a[0] ?? undefined) as number | undefined
      const handle = first
        ? startFirstChunkKeepalive(send, interval)
        : (() => {
            const stop = startAiKeepalive(send, interval)
            return { stop, firstChunk: () => undefined }
          })()
      for (const step of a[1] as string[]) {
        if (step === 'tick') {
          if (active) callback?.()
        } else if (step === 'stop') handle.stop()
        else if (step === 'firstChunk' && first) handle.firstChunk()
      }
    } finally {
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
    }
    return undefined
  }
}

const keepaliveFns: Group = {
  'ai-keepalive.AI_KEEPALIVE_INTERVAL_MS': constant(AI_KEEPALIVE_INTERVAL_MS),
  'ai-keepalive.startAiKeepalive': {
    ts: keepalive(false),
    cases: [
      c([null, ['tick', 'tick', 'stop', 'tick']], 'the default interval, stopped after two pings'),
      c([1000, ['stop', 'stop']], 'stopping twice clears once'),
      c([250.5, []], 'never stopped'),
      c([0, ['tick', 'stop']]),
    ],
  },
  'ai-keepalive.startFirstChunkKeepalive': {
    ts: keepalive(true),
    cases: [
      c(
        [null, ['tick', 'firstChunk', 'tick', 'firstChunk', 'stop']],
        'the first chunk stops it, once',
      ),
      c([2000, ['tick', 'stop', 'firstChunk', 'tick']], 'stopped before the first chunk'),
      c([null, ['tick']], 'no chunk yet'),
      c([5000, ['firstChunk']]),
    ],
  },
}

// ---- free-ai-strings, ai-default-fonts, slides-ai-fonts ----

const fontSpec = (runs: unknown[]) => ({
  title: 'Deck',
  elements: [
    {
      type: 'text',
      x: 0,
      paragraphs: [{ align: 'left', runs }, { runs: [{ text: 'b', sizePt: 14 }] }],
    },
    { type: 'image', paragraphs: [{ runs: [{ text: 'ignored' }] }] },
    { type: 'shape' },
    { type: 'text', paragraphs: [] },
  ],
})

const slidesFontFiles = (value: unknown): Record<string, FileSpec> => ({
  'app-settings.json': JSON.stringify(value),
})

const fontFns: Group = {
  'free-ai-strings.FREE_AI_PAGE_STRINGS': constant(FREE_AI_PAGE_STRINGS),
  'ai-default-fonts.TITLE_ROLE_MIN_PT': constant(TITLE_ROLE_MIN_PT),
  'ai-default-fonts.readSlidesAiFonts': {
    ts: (a) => readSlidesAiFonts({ getPath: () => str(a, 0) }, str(a, 1)),
    cases: [
      c(['$DIR', 'ko'], 'no file', {}),
      c(['$DIR', 'ja'], 'no file, a language the bundled faces do not cover'),
      c(
        ['$DIR', 'en'],
        'a stored choice',
        slidesFontFiles({
          [SLIDES_AI_FONTS_KEY]: { mode: 'serifTitle', sans: ' Gowun Dodum ', serif: 'Batang' },
        }),
      ),
      c(['$DIR', 'ko'], 'the key is missing', slidesFontFiles({ other: 1 })),
      c(['$DIR', 'ko'], 'the file holds an array', { 'app-settings.json': '[1]' }),
      c(['$DIR', 'ko'], 'the file is not JSON', { 'app-settings.json': '{nope' }),
      c(['$DIR', 'ko'], 'a byte order mark', {
        'app-settings.json': `\uFEFF${JSON.stringify({ [SLIDES_AI_FONTS_KEY]: { mode: 'serif' } })}`,
      }),
      c(
        ['$DIR', 'ko'],
        'a bad mode and a bad family',
        slidesFontFiles({ [SLIDES_AI_FONTS_KEY]: { mode: 'bogus', sans: 5, serif: 'a"b' } }),
      ),
      c(['$DIR/missing-folder', 'ko'], 'the folder is not there'),
      c(['$DIR', 'ko'], 'the file is a folder', { 'app-settings.json': { dir: true } }),
      c(['$DIR', 'ko'], 'ill-formed bytes', { 'app-settings.json': { hex: '7b2261223a22ff227d' } }),
    ],
  },
  'ai-default-fonts.fillMissingRunFonts': {
    ts: (a) => fillMissingRunFonts(a[0] as J, a[1] as J),
    cases: [
      c(
        [
          fontSpec([
            { text: 'Title', sizePt: 40 },
            { text: 'sub', sizePt: 28 },
            { text: 'body', sizePt: 27.9 },
            { text: 'none' },
            { text: 'kept', font: 'Arial', sizePt: 50 },
            { text: 'empty', font: '', sizePt: 30 },
            { text: 'str', sizePt: '40' },
          ]),
          { title: 'Serif', body: 'Sans' },
        ],
        'sizes split titles from body',
      ),
      c(
        [fontSpec([{ text: 'kept', font: 'Arial' }]), { title: 'T', body: 'B' }],
        'only the first paragraph keeps its fonts',
      ),
      c(
        [
          {
            elements: [
              { type: 'image', paragraphs: [{ runs: [{ text: 'x' }] }] },
              { type: 'shape' },
            ],
          },
          { title: 'T', body: 'B' },
        ],
        'nothing to fill',
      ),
      c(
        [
          {
            elements: [
              { type: 'text', paragraphs: [{ runs: [{ text: 'x', sizePt: 28 }], align: 'c' }] },
            ],
            other: { a: 1 },
          },
          { title: 'T', body: 'B' },
        ],
        'key order of the run and the spec',
      ),
      c([{ elements: [] }, { title: 'T', body: 'B' }]),
    ],
  },
  'ai-default-fonts.parseFontRoles': {
    ts: (a) => parseFontRoles(a[0]),
    cases: [
      c([{ title: ' Serif ', body: 'Sans' }]),
      c([{ title: 'Serif', body: ' ' }]),
      c([{ title: 'x'.repeat(80), body: 'b' }]),
      c([{ title: 'x'.repeat(81), body: 'b' }]),
      c([{ title: ` ${'x'.repeat(79)} `, body: 'b' }], 'the length counts the spaces'),
      c([{ title: 5, body: 'b' }]),
      c([{}]),
      c([[]]),
      c(['text']),
      c([null]),
    ],
  },
  'slides-ai-fonts.SLIDES_AI_FONTS_KEY': constant(SLIDES_AI_FONTS_KEY),
  'slides-ai-fonts.defaultSlidesAiFonts': {
    ts: (a) => defaultSlidesAiFonts(str(a, 0)),
    cases: [c(['ko']), c(['en']), c(['ja']), c(['']), c(['EN'])],
  },
  'slides-ai-fonts.normalizeSlidesAiFonts': {
    ts: (a) => normalizeSlidesAiFonts((a[0] ?? undefined) as J, str(a, 1)),
    cases: [
      c([null, 'ko']),
      c([null, 'ja']),
      c([{ mode: 'serif', sans: 'A', serif: 'B' }, 'ko']),
      c([{ mode: 'serifTitle' }, 'ja']),
      c([{ mode: 'auto', sans: ' Sans ', serif: 'Se"rif' }, 'en'], 'a quote goes'),
      c([{ mode: 'bogus', sans: '', serif: 'x'.repeat(81) }, 'ko'], 'unusable values fall back'),
      c([{ sans: 'x'.repeat(80), serif: `\u{1F600}`.repeat(40) }, 'ko'], 'eighty code units'),
      c(
        [{ sans: `\u{1F600}`.repeat(41), serif: 'a\tb\u007F\u0085c' }, 'ko'],
        'control characters go, U+0085 stays',
      ),
      c([{ sans: '\u0001\u001F ' }, 'ko'], 'only control characters'),
      c([{ sans: 5, serif: null }, 'ko']),
      c([[{ mode: 'serif' }], 'ko']),
      c(['serif', 'ko']),
    ],
  },
}

// ---- ai-naming-provider, ai-naming ----

const namingStatuses = {
  claudeReady: claudeOnly(),
  codexReady: { codex: ready('codex') },
}

const namingFns: Group = {
  'ai-naming-provider.resolveNamingProvider': {
    ts: (a) => withCodec(a[0], () => maskIds(resolveNamingProvider(a[1], a[2] as J))),
    cases: [
      c(['none', null, {}], 'nothing stored, nothing ready'),
      c(
        [
          'none',
          { provider: 'auto', providers: {}, subscriptionNoticeVersion: 2 },
          namingStatuses.claudeReady,
        ],
        'a subscription with the notice read',
      ),
      c(
        [
          'none',
          { provider: 'auto', providers: {}, subscriptionNoticeVersion: 1 },
          namingStatuses.claudeReady,
        ],
        'the notice of an older wording',
      ),
      c(
        [
          'none',
          { provider: 'auto', providers: {}, subscriptionNoticeSeen: true },
          namingStatuses.claudeReady,
        ],
        'a file from before notice versions: version 1',
      ),
      c([
        'none',
        {
          provider: 'auto',
          providers: {},
          subscriptionNoticeSeen: true,
          subscriptionNoticeVersion: 2,
        },
        namingStatuses.codexReady,
      ]),
      c(
        ['none', { provider: 'auto', providers: {} }, namingStatuses.claudeReady],
        'the notice never read',
      ),
      c(
        ['none', keyed('anthropic', { apiKey: 'k', model: 'm' }), {}],
        'a key provider needs no notice',
      ),
      c(
        ['none', keyed('anthropic', { apiKey: '', model: 'm' }), {}],
        'a key provider that cannot run',
      ),
      c(
        [
          'none',
          { provider: 'codex', providers: {}, subscriptionNoticeVersion: 2 },
          { codex: status('codex', 'signed-out') },
        ],
        'a subscription that cannot run',
      ),
      c(
        [
          'none',
          { provider: 'codex', providers: {}, subscriptionNoticeVersion: 2 },
          { codex: status('codex', 'bogus') },
        ],
        'a state no check writes',
      ),
      c(
        [
          'none',
          {
            provider: 'claude-code',
            providers: { 'claude-code': { apiKey: '', model: 'opus' } },
            subscriptionNoticeVersion: 2,
          },
          namingStatuses.claudeReady,
        ],
        'a stored entry',
      ),
      c(
        [
          'fake',
          {
            provider: 'anthropic',
            providers: { anthropic: { apiKey: 'sealed:v1:k%201', model: 'm' } },
          },
          {},
        ],
        'a sealed key',
      ),
      c(
        [
          'none',
          {
            provider: 'claude-code',
            providers: {},
            subscriptionNoticeSeen: true,
            subscriptionNoticeVersion: -1,
          },
          namingStatuses.claudeReady,
        ],
        'a negative version is no version',
      ),
    ],
  },
  'ai-naming.sanitizeFileStem': {
    ts: (a) => sanitizeFileStem(str(a, 0)),
    cases: [
      'Quarterly Revenue',
      '"Q3 / Revenue.md"',
      '- Meeting notes',
      '\u2013 \u2014 \u2022 > # * bullet',
      '`quoted`',
      "'single'",
      'path/to/file.docx',
      'C:\\dir\\sub\\Report 2024.pdf',
      'a/b\\c/',
      '',
      '/',
      '...',
      '.env',
      '..hidden',
      '.hidden.txt',
      'name.',
      'name. ',
      'ab.cd',
      'a.bc',
      'abc.d',
      'abcdefghij.klmnopqrs',
      'notes.v2',
      'file.tar.gz',
      '\u0131stanbul raporu.xlsx',
      'caf\u00e9\u00a0menu',
      '\u017Feta.txt',
      '\u212Aelvin.txt',
      'a<b>c:d"e|f?g*h',
      'tab\there\r\nline',
      'ctrl\u0001chars\u007F',
      'line\u2028sep.txt',
      'zero\u200Bwidth',
      '   spaced   out   ',
      'CON',
      'con.txt',
      'Nul',
      'COM1',
      'lpt9',
      'LPT0',
      'comet',
      'aux ',
      'x'.repeat(60),
      'x'.repeat(61),
      'x'.repeat(100),
      `${'word '.repeat(20)}end`,
      `${'a'.repeat(40)} ${'b'.repeat(40)}`,
      `${'a'.repeat(20)} ${'b'.repeat(60)}`,
      `${'a'.repeat(29)} ${'b'.repeat(60)}`,
      `${'a'.repeat(30)} ${'b'.repeat(60)}`,
      `${'a'.repeat(31)} ${'b'.repeat(60)}`,
      `${'a '.repeat(40)}`,
      `\u0131${'i'.repeat(70)}`,
      `${'.'.repeat(5)}name`,
      `"${'title '.repeat(15)}"`,
      'Report.\u{1F600}',
      '\u{1F600}\u{1F600} party.txt',
      '# Heading *bold*',
      '> quote "x"',
      `${'a'.repeat(40)} ${'b'.repeat(19)} c`,
      `${'a'.repeat(61)} c`,
    ].map((raw) => c([raw])),
  },
  'ai-naming.buildNamingInstruction': {
    ts: (a) => buildNamingInstruction(str(a, 0), str(a, 1)),
    cases: [
      c(['Body text', 'English']),
      c(['', 'Korean']),
      c(['line 1\nline 2\n\n\n\nline 3', 'fran\u00e7ais']),
      c(['\u{1F600}', '']),
    ],
  },
  'ai-naming.excerptForNaming': {
    ts: (a) => excerptForNaming(str(a, 0), (a[1] ?? undefined) as number | undefined),
    cases: [
      c(['  short text  ', null]),
      c(['a\n\n\n\nb\n\n\n\n\n\nc', null], 'blank runs collapse'),
      c(['a\n\nb', null], 'two newlines stay'),
      c(['x'.repeat(4000), null], 'at the limit'),
      c(['x'.repeat(4001), null], 'past the limit'),
      c(
        [`${'y'.repeat(3998)}\u{1F600}z`, null],
        'the cut lands right after a pair (a cut inside one leaves a lone surrogate no Rust string holds)',
      ),
      c(['abcdef', 3]),
      c(['abcdef', 6]),
      c(['abcdef', 0]),
      c(['abcdef', -2], 'a negative limit counts from the end'),
      c(['abcdef', 2.7], 'a fractional limit'),
      c(['\n\n\n  padded  \n\n\n', null]),
      c(['', null]),
      c([`${'y'.repeat(3999)}\u{1F600}z`, null], 'the cut lands inside a pair'),
    ],
  },
}

// ---- ai-secrets ----

const storages = {
  win: { available: true },
  none: { available: false },
  gnome: { available: true, backend: 'gnome_libsecret' },
  basic: { available: true, backend: 'basic_text' },
  kwallet6: { available: true, backend: 'kwallet6' },
  noBackend: { available: true },
  nullBackend: { available: true, backend: null },
  encThrows: { available: true, encryptThrows: true },
  decThrows: { available: true, decryptThrows: true },
}

function storageOf(spec: Record<string, unknown>) {
  return {
    isEncryptionAvailable: () => !!spec.available,
    encryptString: (plain: string) => {
      if (spec.encryptThrows) throw new Error('encrypt failed')
      return Buffer.from(`enc:${plain}`, 'utf8')
    },
    decryptString: (sealed: Buffer) => {
      const text = sealed.toString('utf8')
      if (spec.decryptThrows || !text.startsWith('enc:')) throw new Error('decrypt failed')
      return text.slice(4)
    },
    ...('backend' in spec ? { getSelectedStorageBackend: () => spec.backend as string } : {}),
  }
}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

const localStateFiles = (value: unknown): Record<string, FileSpec> => ({
  'Local State': typeof value === 'string' ? value : JSON.stringify(value),
})

const aiFileFiles = (value: unknown): Record<string, FileSpec> => ({
  'ai-settings.json': typeof value === 'string' ? value : JSON.stringify(value),
})

/** `process.stdin`, `process.stdout` and the timers are fakes fed `events` */
async function revealEntry(
  codec: AiSecretCodec,
  events: unknown[],
): Promise<{ line: string; code: number }> {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {}
  const timers: { id: number; fn: () => void; ms: number }[] = []
  let nextId = 0
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const id = ++nextId
    timers.push({ id, fn, ms })
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => {
    const at = timers.findIndex((t) => t.id === id)
    if (at >= 0) timers.splice(at, 1)
  }) as unknown as typeof clearTimeout
  const stdin: J = {
    on(event: string, fn: (...args: unknown[]) => void) {
      ;(listeners[event] ??= []).push(fn)
      return stdin
    },
    removeAllListeners() {
      for (const key of Object.keys(listeners)) delete listeners[key]
      return stdin
    },
    pause() {},
  }
  let written = ''
  const stdout = {
    write(line: string, done?: () => void) {
      written = line
      done?.()
      return true
    },
  }
  const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
  const realStdout = Object.getOwnPropertyDescriptor(process, 'stdout')
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true })
  try {
    const run = runRevealEntry(codec)
    const fire = (event: string, ...args: unknown[]) =>
      [...(listeners[event] ?? [])].forEach((f) => f(...args))
    for (const event of events) {
      if (event === 'end') fire('end')
      else if (event === 'error') fire('error')
      else if (event === 'timeout') timers.find((t) => t.ms === 5000)?.fn()
      else {
        const e = event as { data?: string; hex?: string; bytes?: number }
        const chunk =
          e.data !== undefined
            ? Buffer.from(e.data, 'utf8')
            : e.hex !== undefined
              ? Buffer.from(e.hex, 'hex')
              : Buffer.alloc(e.bytes ?? 0, 'a')
        fire('data', chunk)
      }
    }
    // the five-second timer ends a stdin that never ended
    timers.find((t) => t.ms === 5000)?.fn()
    const code = await run
    return { line: written, code }
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
    if (realStdin) Object.defineProperty(process, 'stdin', realStdin)
    if (realStdout) Object.defineProperty(process, 'stdout', realStdout)
  }
}

/** a reveal request padded with spaces to 2 MiB plus `extra` bytes */
const paddedRequest = (extra: number): string => {
  const request = JSON.stringify(['sealed:v1:plain%20a'])
  return request + ' '.repeat(2 * 1024 * 1024 + extra - request.length)
}

const sealedA = `sealed:v1:${encodeURIComponent('plain a')}`
const sealedB = `sealed:v1:${encodeURIComponent('b\u00e9\u{1F600}')}`

const secretsFns2: Group = {
  'ai-secrets.REVEAL_FLAG': constant(REVEAL_FLAG),
  'ai-secrets.MAX_REVEAL_VALUES': constant(MAX_REVEAL_VALUES),
  'ai-secrets.linuxKeyringSeals': {
    ts: (a) => linuxKeyringSeals(storageOf(a[0] as Record<string, unknown>)),
    cases: [
      storages.gnome,
      storages.basic,
      storages.kwallet6,
      storages.noBackend,
      storages.nullBackend,
      { available: true, backend: 'kwallet4' },
      { available: true, backend: 'Gnome_Libsecret' },
    ].map((s) => c([s])),
  },
  'ai-secrets.platformSeals': {
    ts: (a) =>
      platformSeals(storageOf(a[0] as Record<string, unknown>), str(a, 1) as NodeJS.Platform),
    cases: [
      c([storages.win, 'win32']),
      c([storages.none, 'win32'], 'encryption not available'),
      c([storages.gnome, 'linux']),
      c([storages.basic, 'linux']),
      c([storages.noBackend, 'linux']),
      c([storages.win, 'darwin'], 'macOS keeps them plain'),
      c([storages.gnome, 'freebsd']),
      c([storages.none, 'linux']),
    ],
  },
  'ai-secrets.sealingKeyOnDisk': {
    ts: (a) => sealingKeyOnDisk(str(a, 0)),
    cases: [
      c(
        ['$DIR/Local State'],
        'the key is there',
        localStateFiles({ os_crypt: { encrypted_key: 'abc' } }),
      ),
      c(['$DIR/Local State'], 'an empty key', localStateFiles({ os_crypt: { encrypted_key: '' } })),
      c(
        ['$DIR/Local State'],
        'a key that is no text',
        localStateFiles({ os_crypt: { encrypted_key: 5 } }),
      ),
      c(['$DIR/Local State'], 'no os_crypt', localStateFiles({ other: 1 })),
      c(['$DIR/Local State'], 'os_crypt is a text', localStateFiles({ os_crypt: 'x' })),
      c(['$DIR/Local State'], 'null', localStateFiles('null')),
      c(['$DIR/Local State'], 'not JSON', localStateFiles('{nope')),
      c(
        ['$DIR/Local State'],
        'a byte order mark',
        localStateFiles(`\uFEFF${JSON.stringify({ os_crypt: { encrypted_key: 'abc' } })}`),
      ),
      c(['$DIR/missing']),
      c(['$DIR'], 'a folder'),
    ],
  },
  'ai-secrets.safeStorageCodec': {
    ts: (a) => {
      const codec = safeStorageCodec(
        storageOf(a[0] as Record<string, unknown>),
        str(a, 1) as NodeJS.Platform,
        () => a[2] === true,
      )
      return str(a, 3) === 'seal' ? codec.seal(str(a, 4)) : codec.open(str(a, 4))
    },
    cases: [
      c([storages.win, 'win32', true, 'seal', 'sk-1']),
      c([storages.win, 'win32', false, 'seal', 'sk-1'], 'Windows waits for the key on disk'),
      c([storages.gnome, 'linux', false, 'seal', 'sk-1'], 'Linux with a keyring does not wait'),
      c([storages.basic, 'linux', true, 'seal', 'sk-1'], 'Linux without a keyring'),
      c([storages.win, 'darwin', true, 'seal', 'sk-1'], 'macOS'),
      c([storages.none, 'win32', true, 'seal', 'sk-1']),
      c([storages.encThrows, 'win32', true, 'seal', 'sk-1'], 'encryptString throws'),
      c([storages.win, 'win32', true, 'seal', '\u{1F600} \u00e9']),
      c([storages.win, 'win32', true, 'open', `sealed:v1:${b64('enc:sk-1')}`]),
      c([storages.win, 'win32', true, 'open', `sealed:v1:${b64('enc:\u00e9\u{1F600}')}`]),
      c(
        [storages.win, 'win32', true, 'open', `sealed:v1:${b64('enc:sk-1').replace(/=+$/, '')}`],
        'without padding',
      ),
      c(
        [
          storages.win,
          'win32',
          true,
          'open',
          `sealed:v1:${b64('enc:sk-1').replace(/\+/g, '-').replace(/\//g, '_')}`,
        ],
        'the URL-safe alphabet',
      ),
      c(
        [
          storages.win,
          'win32',
          true,
          'open',
          `sealed:v1:${b64('enc:>>>?').replace(/\+/g, '-').replace(/\//g, '_')}`,
        ],
        'the URL-safe dash is the sixty-second digit',
      ),
      c(
        [
          storages.win,
          'win32',
          true,
          'open',
          `sealed:v1:${b64('enc:???>').replace(/\+/g, '-').replace(/\//g, '_')}`,
        ],
        'the URL-safe underscore is the sixty-third digit',
      ),
      c(
        [
          storages.win,
          'win32',
          true,
          'open',
          `sealed:v1:${b64('enc:sk-1').slice(0, 4)}\n${b64('enc:sk-1').slice(4)}`,
        ],
        'a line break inside is skipped',
      ),
      c(
        [
          storages.win,
          'win32',
          true,
          'open',
          `sealed:v1:${b64('enc:sk-1').slice(0, 4)}!!${b64('enc:sk-1').slice(4)}`,
        ],
        'characters outside the alphabet are skipped',
      ),
      c([storages.win, 'win32', true, 'open', `sealed:v1:${b64('enc:sk-1')}==`], 'extra padding'),
      c(
        [storages.win, 'win32', true, 'open', `sealed:v1:${b64('enc:sk-1')}trailing`],
        'text after the padding',
      ),
      c([storages.win, 'win32', true, 'open', 'sealed:v1:!!!'], 'nothing decodes'),
      c([storages.win, 'win32', true, 'open', 'sealed:v1:']),
      c([storages.win, 'win32', true, 'open', 'sealed:v1:A'], 'one character'),
      c(
        [storages.decThrows, 'win32', true, 'open', `sealed:v1:${b64('enc:sk-1')}`],
        'decryptString throws',
      ),
      c([storages.none, 'win32', true, 'open', `sealed:v1:${b64('enc:sk-1')}`], 'cannot open'),
      c([storages.win, 'win32', true, 'open', 'plain'], 'not sealed'),
    ],
  },
  'ai-secrets.holdsPlainSecrets': {
    ts: (a) => holdsPlainSecrets(a[0]),
    cases: [
      c([{ providers: { a: { apiKey: 'plain' } } }]),
      c([{ providers: { a: { apiKey: 'sealed:v1:x' } } }]),
      c([{ providers: { a: { apiKey: '' } } }]),
      c([{ providers: { a: { apiKey: 'sealed:v1:x' } }, readUrl: { githubToken: 'tok' } }]),
      c([{ customEndpoints: [{ apiKey: 'k' }] }]),
      c([{ search: { providers: { serper: { apiKey: 'k' } } } }]),
      c([{ media: { providers: { openai: { apiKey: 'k' } } } }]),
      c([null]),
      c(['text']),
    ],
  },
  'ai-secrets.sealStoredAiSettings': {
    ts: (a) => withCodec(a[0], () => sealStoredAiSettings(str(a, 1))),
    cases: [
      c(
        ['fake', '$DIR/ai-settings.json'],
        'plain keys are sealed',
        aiFileFiles({
          provider: 'openai',
          providers: { openai: { apiKey: 'sk-1', model: 'm' } },
          readUrl: { githubToken: 'tok' },
        }),
      ),
      c(
        ['fake', '$DIR/ai-settings.json'],
        'nothing plain',
        aiFileFiles({ providers: { openai: { apiKey: 'sealed:v1:x', model: 'm' } } }),
      ),
      c(
        ['fake', '$DIR/ai-settings.json'],
        'a key that stays plain',
        aiFileFiles({ providers: { openai: { apiKey: '!sk-1' } } }),
      ),
      c(
        ['fake', '$DIR/ai-settings.json'],
        'one key stays plain: the file is left',
        aiFileFiles({ providers: { openai: { apiKey: 'sk-1' }, kimi: { apiKey: '!k' } } }),
      ),
      c(
        ['fake', '$DIR/ai-settings.json'],
        'sealing throws: the key stays plain',
        aiFileFiles({ providers: { openai: { apiKey: '?sk-1' } } }),
      ),
      c(
        ['none', '$DIR/ai-settings.json'],
        'no codec',
        aiFileFiles({ providers: { openai: { apiKey: 'sk-1' } } }),
      ),
      c(['fake', '$DIR/ai-settings.json'], 'not JSON', aiFileFiles('{nope')),
      c(['fake', '$DIR/missing.json'], 'no file'),
      c(['fake', '$DIR/adir'], 'a folder', { adir: { dir: true } }),
      c(['fake', '$DIR/sub/ai-settings.json'], 'a nested path', {
        'sub/ai-settings.json': JSON.stringify({
          customEndpoints: [{ id: 'a', apiKey: 'k\u00e9' }],
        }),
      }),
      c(
        ['fake', '$DIR/ai-settings.json'],
        'key order of the written file',
        aiFileFiles({
          z: 1,
          '10': 2,
          providers: { b: { apiKey: 'x' }, '2': { apiKey: 'y' } },
          a: 3,
        }),
      ),
    ],
  },
  'ai-secrets.openFileSearchKeys': {
    ts: (a) => withCodec(a[0], () => openFileSearchKeys(a[1])),
    cases: [
      c([
        'fake',
        {
          keys: { a: 'sealed:v1:k%201', b: 'plain', c: 5, d: 'sealed:v1:null' },
          jevKeys: { x: 'sealed:v1:j' },
          other: 1,
        },
      ]),
      c(['fake', { keys: null, jevKeys: 'text' }]),
      c(['fake', { keys: ['sealed:v1:z', 'p'] }], 'an array of keys'),
      c(['fake', { other: 1 }]),
      c(['none', { keys: { a: 'sealed:v1:k' } }]),
      c(['fake', ['x']], 'an array is an object that spreads'),
      c(['fake', 'text']),
      c(['fake', null]),
      c(['fake', { keys: { '10': 'sealed:v1:a', '2': 'b', b: 'c' } }], 'integer keys'),
    ],
  },
  'ai-secrets.sealFileSearchKeys': {
    ts: (a) => withCodec(a[0], () => sealFileSearchKeys(a[1] as { keys: Record<string, string> })),
    cases: [
      c(['fake', { keys: { a: 'sk-1', b: '', c: 'sealed:v1:x', d: '!p' }, other: 1 }]),
      c(['none', { keys: { a: 'sk-1' } }]),
      c(['fake', { keys: { '10': 'a', '2': 'b', z: 'c' } }]),
    ],
  },
  'ai-secrets.fileSearchHoldsPlainKeys': {
    ts: (a) => fileSearchHoldsPlainKeys(a[0]),
    cases: [
      c([{ keys: { a: 'plain' } }]),
      c([{ keys: { a: 'sealed:v1:x', b: '' } }]),
      c([{ keys: { a: 5 } }]),
      c([{ keys: [] }]),
      c([{ keys: ['k'] }]),
      c([{ keys: 'text' }]),
      c([{}]),
      c([null]),
      c(['text']),
    ],
  },
  'ai-secrets.revealRequestOf': {
    ts: (a) => revealRequestOf(str(a, 0)),
    cases: [
      c([JSON.stringify([sealedA, sealedB])]),
      c(['[]']),
      c([JSON.stringify([sealedA, 'plain'])], 'a value that is not sealed'),
      c([JSON.stringify([sealedA, 5])]),
      c([JSON.stringify(Array.from({ length: 64 }, () => sealedA))], 'the most values'),
      c([JSON.stringify(Array.from({ length: 65 }, () => sealedA))]),
      c([JSON.stringify([`sealed:v1:${'x'.repeat(16374)}`])], 'the longest value'),
      c([JSON.stringify([`sealed:v1:${'x'.repeat(16375)}`])]),
      c([JSON.stringify([`sealed:v1:${'\u{1F600}'.repeat(8187)}`])], 'counted in code units'),
      c([JSON.stringify({ a: sealedA })]),
      c(['not json']),
      c(['']),
      c(['null']),
    ],
  },
  'ai-secrets.revealAnswer': {
    ts: (a) => revealAnswer(a[1] as string[] | null, codecValue(a[0])),
    cases: [
      c(['fake', [sealedA, sealedB]]),
      c(['fake', [sealedA, sealedA]], 'the same value twice'),
      c(['fake', ['sealed:v1:null', sealedA]], 'a value this PC cannot open'),
      c(['fake', []]),
      c(['fake', null], 'a bad request'),
      c(['none', [sealedA]], 'no codec opens nothing'),
      c(['fake', ['sealed:v1:throw']], 'the codec throws'),
      c(['fake', ['sealed:v1:%']], 'a malformed escape throws'),
    ],
  },
  'ai-secrets.runRevealEntry': {
    ts: (a) => revealEntry(codecValue(a[0]), a[1] as unknown[]),
    cases: [
      c(['fake', [{ data: JSON.stringify([sealedA, sealedB]) }, 'end']]),
      c(
        ['fake', [{ data: '[' }, { data: JSON.stringify([sealedA]).slice(1) }, 'end']],
        'two chunks',
      ),
      c(['fake', [{ data: 'not json' }, 'end']], 'a bad request'),
      c(['fake', [{ data: JSON.stringify([sealedA]) }, 'error']], 'stdin fails after its data'),
      c(['fake', [{ data: JSON.stringify([sealedA]) }, 'timeout']], 'the five seconds pass'),
      c(['fake', [{ data: JSON.stringify([sealedA]) }]], 'stdin never ends'),
      c(['fake', ['end']], 'nothing came'),
      c(['fake', [{ data: paddedRequest(0) }, 'end']], 'exactly the most bytes is read'),
      c(['fake', [{ data: paddedRequest(1) }, 'end']], 'one byte more is dropped'),
      c(
        ['fake', [{ data: JSON.stringify([sealedA]) }, { bytes: 2 * 1024 * 1024 }, 'end']],
        'more bytes after a good request drop it all',
      ),
      c(['fake', [{ hex: Buffer.from(JSON.stringify([sealedA]), 'utf8').toString('hex') }, 'end']]),
      c(
        ['fake', [{ hex: 'ef' }, { data: JSON.stringify([sealedA]) }, 'end']],
        'an ill-formed byte',
      ),
      c(
        ['fake', [{ hex: 'efbbbf' }, { data: JSON.stringify([sealedA]) }, 'end']],
        'a byte order mark stays',
      ),
      c(['none', [{ data: JSON.stringify([sealedA]) }, 'end']], 'no codec opens nothing'),
      c(['fake', [{ data: JSON.stringify(['sealed:v1:throw']) }, 'end']], 'the codec throws'),
      c(
        ['fake', [{ data: JSON.stringify([sealedA]) }, 'end', { data: 'late' }]],
        'an event after the end',
      ),
    ],
  },
}

// ---- ai-run-guard, drive-ai-channels ----

function guardOf(mode: string): AiRunGuard | null {
  switch (mode) {
    case 'always':
      return () => 'no'
    case 'free':
      return (input) =>
        input.provider === 'openrouter' || input.model.endsWith(':free')
          ? `refused for ${input.senderId}`
          : null
    case 'allow':
      return () => null
    default:
      return null
  }
}

const runInput = (senderId: number, providerId: string, model: string) => ({
  senderId,
  provider: providerId,
  model,
})

const guardFns2: Group = {
  'ai-run-guard.aiRunRefusal': {
    ts: (a) => {
      setAiRunGuard(guardOf(str(a, 0)))
      try {
        return aiRunRefusal(a[1] as J)
      } finally {
        setAiRunGuard(null)
      }
    },
    cases: [
      c(['none', runInput(1, 'openrouter', 'm')], 'no check: every run goes'),
      c(['always', runInput(2, 'anthropic', 'm')]),
      c(['free', runInput(3, 'openrouter', 'm')]),
      c(['free', runInput(4, 'gemini', 'x:free')]),
      c(['free', runInput(5, 'gemini', 'gemini-3.5-flash-lite')]),
      c(['allow', runInput(6, 'openrouter', ':free')]),
      c(['free', runInput(7.5, 'openrouter', '')], 'a fractional sender'),
    ],
  },
  'ai-run-guard.setAiRunGuard': {
    ts: (a) => {
      const answers: unknown[] = []
      try {
        for (const step of a[0] as { set?: string; ask?: J }[]) {
          if (step.set !== undefined) setAiRunGuard(guardOf(step.set))
          else answers.push(aiRunRefusal(step.ask))
        }
      } finally {
        setAiRunGuard(null)
      }
      return answers
    },
    cases: [
      c(
        [
          [
            { ask: runInput(1, 'openrouter', '') },
            { set: 'free' },
            { ask: runInput(1, 'openrouter', '') },
            { set: 'none' },
            { ask: runInput(2, 'openrouter', '') },
          ],
        ],
        'a guard set and taken away',
      ),
      c(
        [
          [
            { set: 'always' },
            { ask: runInput(3, 'a', 'b') },
            { set: 'allow' },
            { ask: runInput(3, 'a', 'b') },
          ],
        ],
        'a guard replaced',
      ),
      c([[]]),
    ],
  },
  'drive-ai-channels.DRIVE_AI_CHANNELS': constant(DRIVE_AI_CHANNELS),
  'drive-ai-channels.driveConnectedOf': {
    ts: (a) => driveConnectedOf(a[0]),
    cases: [
      c([{ state: 'connected' }]),
      c([{ state: 'disconnected' }]),
      c([{ state: 'Connected' }]),
      c([{}]),
      c([[{ state: 'connected' }]]),
      c(['connected']),
      c([null]),
    ],
  },
  'drive-ai-channels.driveAiOn': {
    ts: (a) => driveAiOn(a[0]),
    cases: [
      c([{ state: 'connected', aiAccess: true, trainingAck: true }]),
      c([{ state: 'connected', aiAccess: true }], 'the training confirmation is missing'),
      c([{ state: 'connected', aiAccess: true, trainingAck: 'true' }]),
      c([{ state: 'connected', aiAccess: false, trainingAck: true }]),
      c([{ state: 'error', aiAccess: true, trainingAck: true }]),
      c([{}]),
      c([null]),
      c(['x']),
    ],
  },
}

export const group: Group = {
  ...providersFns,
  ...selectionFns,
  ...normalizeFns,
  ...guardFns,
  ...secretsFns,
  ...errorFns,
  ...utilFns,
  ...docsRunFns,
  ...sheetsRunFns,
  ...keepaliveFns,
  ...fontFns,
  ...namingFns,
  ...secretsFns2,
  ...guardFns2,
}
