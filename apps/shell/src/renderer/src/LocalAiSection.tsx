import { useEffect, useRef, useState } from 'react'
import { localContextTokensOf, newCustomEndpointId } from '@genoffice/ai-provider/browser'
import type {
  AiCustomEndpoint,
  AiLocalDiscoveryResult,
  AiLocalInspectionResult,
  AiLocalModelProfile,
  AiLocalModelSummary,
  AiLocalServerKind,
  AiLocalTestResult,
  AiLocalValueSource,
  AiSettings,
} from '@genoffice/ai-provider/browser'
import type { StringKey, TFunc } from './locale'
import {
  LOCAL_PRESET_IDS,
  LOCAL_PRESETS,
  applyInspection,
  applyPreset,
  applyTestResult,
  localAddressNotice,
  localEndpointDraft,
  localEndpoints,
  localServerStatus,
  localTestView,
  mergeLoadedModel,
  newLocalDraft,
  normalizeLocalBaseUrl,
  normalizeTimeoutMinutes,
  removeLocalEndpoint,
  saveLocalDraft,
} from './local-ai'
import type {
  LocalEndpointDraft,
  LocalPreset,
  LocalServerProbe,
  LocalTestCheck,
  LocalTestResult,
  LocalValidationCode,
} from './local-ai'

// ── Local AI card ─────────────────────────────────────────
// Everything the rules in local-ai.ts decide is laid out here: saved servers,
// the form of one server, its advertised models, per-model profiles and the
// four-row connection test. The card never contacts a server on its own: only
// the buttons in this file do, and saving never changes the AI in use.

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCheck(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.status === 'pass' || value.status === 'fail' || value.status === 'skip')
  )
}

function isDiscoveryResult(value: unknown): value is AiLocalDiscoveryResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (value.ok) {
    return (
      (value.server === 'ollama' || value.server === 'openai-compatible') &&
      Array.isArray(value.models) &&
      value.models.every((model) => isRecord(model) && typeof model.id === 'string')
    )
  }
  return typeof value.errorCode === 'string'
}

function isInspectionResult(value: unknown): value is AiLocalInspectionResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  return value.ok ? isRecord(value.profile) : typeof value.errorCode === 'string'
}

function isTestResult(value: unknown): value is AiLocalTestResult {
  return (
    isRecord(value) &&
    isCheck(value.server) &&
    isCheck(value.model) &&
    isCheck(value.chat) &&
    isCheck(value.tools) &&
    typeof value.checkedAt === 'number' &&
    typeof value.elapsedMs === 'number'
  )
}

function probeOfTest(result: LocalTestResult): LocalServerProbe {
  if (result.inputError === 'shape' || result.server.status !== 'pass') {
    const code = result.server.code
    return {
      ok: false,
      errorCode: code === 'unreachable' || code === 'timeout' ? code : 'shape',
    }
  }
  return {
    ok: true,
    server: result.serverKind ?? 'openai-compatible',
    models: result.models ?? [],
  }
}

function serverKindOf(draft: LocalEndpointDraft, probed: AiLocalServerKind | undefined) {
  if (probed) return probed
  if (draft.preset === 'ollama') return 'ollama'
  if (draft.preset === 'lmstudio' || draft.preset === 'vllm') return 'openai-compatible'
  return undefined
}

function formatBytes(bytes: number | undefined): string | undefined {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return undefined
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

function statusText(state: ReturnType<typeof localServerStatus>['state'], t: TFunc): string {
  switch (state) {
    case 'checking':
      return t('setLocalStatusChecking')
    case 'online':
      return t('setLocalStatusOnline')
    case 'offline':
      return t('setLocalStatusOffline')
    case 'error':
      return t('setLocalStatusError')
    default:
      return t('setLocalStatusUnknown')
  }
}

function sourceText(source: AiLocalValueSource | undefined, t: TFunc): string {
  switch (source) {
    case 'server':
      return t('setLocalSourceServer')
    case 'user':
      return t('setLocalSourceUser')
    case 'test':
      return t('setLocalSourceTest')
    default:
      return t('setLocalUnknown')
  }
}

function capabilityText(value: boolean | undefined, t: TFunc): string {
  if (value === true) return t('setLocalSupported')
  if (value === false) return t('setLocalUnsupported')
  return t('setLocalUnknown')
}

function validationText(code: LocalValidationCode, t: TFunc): string {
  switch (code) {
    case 'empty':
      return t('setLocalErrorEmpty')
    case 'scheme':
      return t('setLocalErrorScheme')
    case 'too-long':
      return t('setLocalErrorTooLong')
    case 'credentials':
      return t('setLocalErrorCredentials')
    case 'range':
      return t('setLocalErrorRange')
    default:
      return t('setLocalErrorShape')
  }
}

/**
 * Abort a connection test in the main process, so its requests end there too
 * and not only the card's wait for them. An older preload without the call
 * leaves the test to run out its own time limit.
 */
function cancelTestInMain(testId: string): void {
  try {
    const cancel = window.aiOffice?.cancelLocalTest
    if (typeof cancel !== 'function') return
    void Promise.resolve(window.aiOffice.cancelLocalTest(testId)).catch(() => undefined)
  } catch {
    // nothing to cancel through; the test ends at its time limit
  }
}

/** One connection test in flight: its main-process handle and the server it probes. */
interface LocalTestRun {
  id: string
  key: string
}

const CHECK_LABEL: Record<LocalTestCheck, StringKey> = {
  server: 'setLocalTestServer',
  model: 'setLocalTestModel',
  chat: 'setLocalTestChat',
  tools: 'setLocalTestTools',
}

const TEST_STATE_LABEL: Record<'pass' | 'fail' | 'skip' | 'unconfirmed', StringKey> = {
  pass: 'setLocalPass',
  fail: 'setLocalFail',
  skip: 'setLocalSkip',
  unconfirmed: 'setLocalUnconfirmed',
}

export interface LocalAiSectionProps {
  t: TFunc
  settings: AiSettings
  /** read-change-write against the settings file; resolves to what was written */
  onApply: (change: (settings: AiSettings) => AiSettings) => Promise<AiSettings | null>
}

export function LocalAiSection({ t, settings, onApply }: LocalAiSectionProps) {
  const [draft, setDraft] = useState<LocalEndpointDraft | null>(null)
  const [probes, setProbes] = useState<Record<string, LocalServerProbe>>({})
  const [kinds, setKinds] = useState<Record<string, AiLocalServerKind>>({})
  const [summaries, setSummaries] = useState<Record<string, AiLocalModelSummary>>({})
  const [timeoutText, setTimeoutText] = useState('5')
  const [testResult, setTestResult] = useState<LocalTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [formError, setFormError] = useState<LocalValidationCode | null>(null)
  const [bridgeError, setBridgeError] = useState(false)
  const [saved, setSaved] = useState(false)
  const [deleteAsked, setDeleteAsked] = useState<string | null>(null)
  const [loadedModel, setLoadedModel] = useState('')
  const [contextMayDiffer, setContextMayDiffer] = useState<Record<string, boolean>>({})
  /** the connection test in flight; its answer is dropped once this no longer names it */
  const testRunRef = useRef<LocalTestRun | null>(null)

  // the card closed (settings closed, or another pane): end a running test in
  // the main process as well
  useEffect(
    () => () => {
      const run = testRunRef.current
      testRunRef.current = null
      if (run) cancelTestInMain(run.id)
    },
    [],
  )

  const servers = localEndpoints(settings)
  const activeId = settings.provider === 'custom' ? settings.customEndpoint : undefined
  const active = servers.find((endpoint) => endpoint.id === activeId)
  const draftKey = draft?.id || 'draft'
  const draftStatus = localServerStatus(probes[draftKey])
  const draftEndpoint = draft?.id ? servers.find((endpoint) => endpoint.id === draft.id) : undefined
  const handlersReady =
    typeof window.aiOffice?.getLocalModels === 'function' &&
    typeof window.aiOffice?.inspectLocalModel === 'function' &&
    typeof window.aiOffice?.testLocalModel === 'function'
  const unavailable = bridgeError || !handlersReady

  const handlerMissing = (): boolean => {
    const ready =
      typeof window.aiOffice?.getLocalModels === 'function' &&
      typeof window.aiOffice?.inspectLocalModel === 'function' &&
      typeof window.aiOffice?.testLocalModel === 'function'
    if (!ready) {
      setBridgeError(true)
      return true
    }
    return false
  }

  /**
   * Stop the running connection test: the main process aborts its request and
   * sends no further check, and whatever it answers is dropped here.
   */
  const cancelTest = () => {
    const run = testRunRef.current
    if (!run) return
    testRunRef.current = null
    setTesting(false)
    setProbes((current) => {
      if (current[run.key] !== 'checking') return current
      const next = { ...current }
      delete next[run.key]
      return next
    })
    cancelTestInMain(run.id)
  }

  const resetFormState = () => {
    // another server, a new one, or the form closing: a test of the old one stops
    cancelTest()
    setTestResult(null)
    setFormError(null)
    setSaved(false)
    setDeleteAsked(null)
    setContextMayDiffer({})
  }

  const editEndpoint = (endpoint: AiCustomEndpoint) => {
    resetFormState()
    const next = localEndpointDraft(endpoint)
    setDraft(next)
    setLoadedModel(endpoint.model)
    setTimeoutText(String(Math.round(next.timeoutMs / 60_000)))
    setSummaries({})
  }

  const startNew = (preset: LocalPreset = 'ollama') => {
    resetFormState()
    const next = newLocalDraft(preset)
    setDraft(next)
    setLoadedModel(next.model)
    setTimeoutText(String(Math.round(next.timeoutMs / 60_000)))
    setSummaries({})
  }

  const updateDraft = (patch: Partial<LocalEndpointDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
    setSaved(false)
  }

  /** an address or key edit makes the last answer about this server stale */
  const invalidateProbe = () => {
    // the address or key now names another server: a test of the old one stops
    cancelTest()
    setProbes((current) => {
      if (!(draftKey in current)) return current
      const next = { ...current }
      delete next[draftKey]
      return next
    })
    setKinds((current) => {
      if (!(draftKey in current)) return current
      const next = { ...current }
      delete next[draftKey]
      return next
    })
    setContextMayDiffer({})
    setTestResult(null)
  }

  const profileOf = (model: string): AiLocalModelProfile => draft?.modelProfiles?.[model] ?? {}

  const updateProfile = (model: string, next: AiLocalModelProfile) => {
    setDraft((current) => {
      if (!current) return current
      return {
        ...current,
        modelProfiles: { ...(current.modelProfiles ?? {}), [model]: next },
      }
    })
    setSaved(false)
  }

  const setContext = (field: 'contextLength' | 'maxContextLength', raw: string) => {
    const model = draft?.model.trim() ?? ''
    if (!model) return
    const next = { ...profileOf(model) }
    if (raw.trim() === '') {
      delete next[field]
      if (field === 'contextLength') delete next.contextSource
    } else {
      const value = localContextTokensOf(Number(raw))
      if (value === undefined) return
      next[field] = value
      next.contextSource = 'user'
    }
    updateProfile(model, next)
  }

  const refreshModels = async () => {
    if (!draft) return
    const address = normalizeLocalBaseUrl(draft.baseUrl, draft.preset)
    if (!address.ok) {
      setFormError(address.code)
      return
    }
    if (handlerMissing()) return
    setFormError(null)
    setRefreshing(true)
    const key = draftKey
    setProbes((current) => ({ ...current, [key]: 'checking' }))
    try {
      const result: unknown = await window.aiOffice.getLocalModels({
        baseUrl: address.value,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      })
      if (!isDiscoveryResult(result)) {
        setBridgeError(true)
        setProbes((current) => ({ ...current, [key]: { ok: false, errorCode: 'shape' } }))
        return
      }
      setProbes((current) => ({ ...current, [key]: result }))
      if (result.ok) {
        setKinds((current) => ({ ...current, [key]: result.server }))
        setSummaries((current) => ({
          ...current,
          ...Object.fromEntries(result.models.map((model) => [model.id, model])),
        }))
        updateDraft({ models: result.models.map((model) => model.id) })
      }
    } catch {
      setBridgeError(true)
      setProbes((current) => ({ ...current, [key]: { ok: false, errorCode: 'unreachable' } }))
    } finally {
      setRefreshing(false)
    }
  }

  const testConnection = async () => {
    if (!draft) return
    const address = normalizeLocalBaseUrl(draft.baseUrl, draft.preset)
    if (!address.ok) {
      setFormError(address.code)
      return
    }
    const model = draft.model.trim()
    if (!model) return
    const timeout = normalizeTimeoutMinutes(timeoutText)
    if (!timeout.ok) {
      setFormError('range')
      return
    }
    if (handlerMissing()) return
    setFormError(null)
    setTesting(true)
    setTestResult(null)
    const key = draftKey
    const run: LocalTestRun = { id: crypto.randomUUID(), key }
    testRunRef.current = run
    const stillCurrent = () => testRunRef.current === run
    setProbes((probesNow) => ({ ...probesNow, [key]: 'checking' }))
    try {
      const result: unknown = await window.aiOffice.testLocalModel({
        baseUrl: address.value,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        model,
        typed: !summaries[model] && !(draft.models ?? []).includes(model),
        timeoutMs: timeout.value,
        testId: run.id,
      })
      // cancelled, or the card moved on: this answer belongs to no form any more
      if (!stillCurrent()) return
      if (!isTestResult(result)) {
        setBridgeError(true)
        setProbes((current) => ({ ...current, [key]: { ok: false, errorCode: 'shape' } }))
        return
      }
      setTestResult(result)
      setProbes((current) => ({ ...current, [key]: probeOfTest(result) }))
      if (result.serverKind) {
        setKinds((current) => ({ ...current, [key]: result.serverKind as AiLocalServerKind }))
      }
      if (result.models && result.server.status === 'pass') {
        setSummaries((current) => ({
          ...current,
          ...Object.fromEntries(result.models!.map((summary) => [summary.id, summary])),
        }))
      }
      setDraft((current) => {
        if (!current) return current
        const profiles = { ...(current.modelProfiles ?? {}) }
        profiles[model] = applyTestResult(profiles[model] ?? {}, result)
        const models =
          result.server.status === 'pass' && result.models
            ? result.models.map((summary) => summary.id)
            : current.models
        return { ...current, modelProfiles: profiles, ...(models ? { models } : {}) }
      })
    } catch {
      if (!stillCurrent()) return
      setBridgeError(true)
      setProbes((probesNow) => ({ ...probesNow, [key]: { ok: false, errorCode: 'unreachable' } }))
    } finally {
      if (stillCurrent()) {
        testRunRef.current = null
        setTesting(false)
      }
    }
  }

  const inspect = async () => {
    if (!draft) return
    const address = normalizeLocalBaseUrl(draft.baseUrl, draft.preset)
    if (!address.ok) {
      setFormError(address.code)
      return
    }
    const model = draft.model.trim()
    if (!model) return
    if (handlerMissing()) return
    setInspecting(true)
    try {
      const kind = serverKindOf(draft, kinds[draftKey])
      const result: unknown = await window.aiOffice.inspectLocalModel({
        baseUrl: address.value,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        model,
        ...(kind ? { server: kind } : {}),
      })
      if (!isInspectionResult(result)) {
        setBridgeError(true)
        return
      }
      if (result.ok) {
        setDraft((current) => {
          if (!current) return current
          const currentProfile = current.modelProfiles?.[model] ?? {}
          return {
            ...current,
            modelProfiles: {
              ...(current.modelProfiles ?? {}),
              [model]: applyInspection(currentProfile, result.profile),
            },
          }
        })
        // `/api/show` reports the model's maximum; only `/api/ps` says what is
        // actually loaded now. Without it the number may be the maximum.
        setContextMayDiffer((current) => ({
          ...current,
          [`${draftKey}:${model}`]:
            result.profile.contextLength !== undefined &&
            result.profile.runningContextLength === undefined,
        }))
        setSaved(false)
      }
    } catch {
      setBridgeError(true)
    } finally {
      setInspecting(false)
    }
  }

  const save = async () => {
    if (!draft) return
    const address = normalizeLocalBaseUrl(draft.baseUrl, draft.preset)
    if (!address.ok) {
      setFormError(address.code)
      return
    }
    const timeout = normalizeTimeoutMinutes(timeoutText)
    if (!timeout.ok) {
      setFormError('range')
      return
    }
    const id = draft.id || newCustomEndpointId()
    const previousKey = draftKey
    const candidate: LocalEndpointDraft = {
      ...draft,
      id,
      baseUrl: address.value,
      timeoutMs: timeout.value,
    }
    const next = await onApply((latest) => {
      const existing = latest.customEndpoints?.find((endpoint) => endpoint.id === id)
      const model = existing
        ? mergeLoadedModel(candidate, loadedModel, existing.model)
        : candidate.model
      return saveLocalDraft(latest, { ...candidate, model })
    })
    if (!next) return
    const written = next.customEndpoints?.find((endpoint) => endpoint.id === id)
    if (written) {
      setDraft(localEndpointDraft(written))
      setLoadedModel(written.model)
      setTimeoutText(String(Math.round(localEndpointDraft(written).timeoutMs / 60_000)))
    }
    if (previousKey !== id) {
      // a new server keeps the answer its unsaved form just received
      setProbes((current) => {
        if (!(previousKey in current)) return current
        const moved = { ...current, [id]: current[previousKey] }
        delete moved[previousKey]
        return moved
      })
      setKinds((current) => {
        if (!(previousKey in current)) return current
        const moved = { ...current, [id]: current[previousKey] as AiLocalServerKind }
        delete moved[previousKey]
        return moved
      })
    }
    setFormError(null)
    setSaved(true)
  }

  const remove = async (id: string) => {
    setDeleteAsked(null)
    // a test of the server being deleted stops with it
    if (draft?.id === id) cancelTest()
    const next = await onApply((latest) => removeLocalEndpoint(latest, id))
    if (draft?.id === id) setDraft(null)
    if (next) setSaved(false)
  }

  const askDelete = (id: string) => {
    const endpoint = servers.find((entry) => entry.id === id)
    if (!endpoint) return
    if (endpoint.id === activeId) {
      setDeleteAsked(id)
      return
    }
    void remove(id)
  }

  const model = draft?.model.trim() ?? ''
  const profile = model ? profileOf(model) : {}
  // where a chat would send documents: advisory only, saving is never blocked
  const addressNotice = draft ? localAddressNotice(draft.baseUrl) : 'none'
  const models = draft?.models ?? []

  return (
    <section className="set-local-ai" data-local-ai="" aria-label={t('setLocalTitle')}>
      <h4 className="set-pane-subtitle set-sub-title">{t('setLocalTitle')}</h4>
      <div className="set-field-desc set-ai-note">{t('setLocalDesc')}</div>
      {unavailable && (
        <div className="set-adv-warning set-local-unavailable" role="alert">
          {t('setLocalUnavailable')}
        </div>
      )}
      {settings.provider === 'custom' && !active && (
        <div className="set-field-desc" data-local-selection="none">
          {t('setLocalNoSelection')}
        </div>
      )}

      {servers.length === 0 && !draft && (
        <div className="set-field-desc set-local-empty">{t('setLocalEmpty')}</div>
      )}

      {servers.length > 0 && (
        <div className="set-local-servers" role="list">
          {servers.map((endpoint) => {
            const status = localServerStatus(probes[endpoint.id])
            const inUse = endpoint.id === activeId
            const checked = status.state === 'offline' || status.state === 'error'
            const modelCount = status.modelCount ?? endpoint.models?.length ?? 0
            return (
              <div
                className="set-local-server"
                role="listitem"
                key={endpoint.id}
                data-local-server={endpoint.id}
                data-state={status.state}
              >
                <button
                  type="button"
                  className="set-local-server-main"
                  aria-pressed={draft?.id === endpoint.id}
                  onClick={() => editEndpoint(endpoint)}
                >
                  <span className="set-local-server-name">{endpoint.name || endpoint.baseUrl}</span>
                  <span className="set-local-server-address">{endpoint.baseUrl}</span>
                  <span className="set-local-server-status">{statusText(status.state, t)}</span>
                  <span className="set-local-server-count">
                    {modelCount === 1
                      ? t('setLocalModelCountOne', { count: modelCount })
                      : t('setLocalModelCount', { count: modelCount })}
                  </span>
                  {checked && (endpoint.models?.length ?? 0) > 0 && (
                    <span className="set-local-meta">{t('setLocalLastModels')}</span>
                  )}
                </button>
                {inUse && <span className="set-local-badge in-use">{t('setLocalInUse')}</span>}
              </div>
            )
          })}
        </div>
      )}

      <div className="set-btn-row set-local-add">
        <button type="button" className="set-btn" onClick={() => startNew()}>
          {t('setLocalAddServer')}
        </button>
      </div>

      {draft && (
        <div className="set-local-form" data-local-form="">
          <div className="set-pane-subhead">
            <h5 className="set-local-form-title">
              {draftEndpoint ? draftEndpoint.name || draftEndpoint.baseUrl : t('setLocalAddServer')}
            </h5>
            <span className="set-field-desc" data-local-status={draftStatus.state}>
              {statusText(draftStatus.state, t)}
            </span>
          </div>

          <div className="set-field">
            <div className="set-field-text">
              <div className="set-field-label">{t('setLocalPreset')}</div>
            </div>
            <div className="set-local-presets" role="group" aria-label={t('setLocalPreset')}>
              {LOCAL_PRESET_IDS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`set-btn${draft.preset === preset ? ' primary' : ''}`}
                  aria-pressed={draft.preset === preset}
                  onClick={() => {
                    setDraft(applyPreset(draft, preset))
                    setSaved(false)
                    invalidateProbe()
                  }}
                >
                  {preset === 'other' ? t('setLocalPresetOther') : LOCAL_PRESETS[preset].name}
                </button>
              ))}
            </div>
          </div>

          <div className="set-field">
            <div className="set-field-text">
              <label className="set-field-label" htmlFor="set-local-name">
                {t('setLocalName')}
              </label>
            </div>
            <input
              id="set-local-name"
              className="set-input"
              type="text"
              value={draft.name}
              spellCheck={false}
              onChange={(event) => updateDraft({ name: event.target.value })}
            />
          </div>

          <div className="set-field">
            <div className="set-field-text">
              <label className="set-field-label" htmlFor="set-local-address">
                {t('setLocalAddress')}
              </label>
            </div>
            <input
              id="set-local-address"
              className="set-input"
              type="text"
              value={draft.baseUrl}
              spellCheck={false}
              onChange={(event) => {
                updateDraft({ baseUrl: event.target.value })
                invalidateProbe()
              }}
            />
          </div>
          {addressNotice === 'unencrypted' && (
            <div
              className="set-field-desc set-local-warning"
              data-local-address-notice="unencrypted"
            >
              {t('setLocalAddressUnencrypted')}
            </div>
          )}
          {addressNotice === 'remote' && (
            <div className="set-field-desc" data-local-address-notice="remote">
              {t('setLocalAddressRemote')}
            </div>
          )}

          <div className="set-field">
            <div className="set-field-text">
              <label className="set-field-label" htmlFor="set-local-key">
                {t('setLocalApiKey')}
              </label>
            </div>
            <input
              id="set-local-key"
              className="set-input"
              type="password"
              value={draft.apiKey}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                updateDraft({ apiKey: event.target.value })
                invalidateProbe()
              }}
            />
          </div>

          <div className="set-field">
            <div className="set-field-text">
              <div className="set-field-stack">
                <label className="set-field-label" htmlFor="set-local-timeout">
                  {t('setLocalTimeout')}
                </label>
                <div className="set-field-desc">{t('setLocalTimeoutHint')}</div>
              </div>
            </div>
            <input
              id="set-local-timeout"
              className="set-input set-num-input"
              type="number"
              min={1}
              max={10}
              step={1}
              value={timeoutText}
              onChange={(event) => {
                setTimeoutText(event.target.value)
                setSaved(false)
              }}
            />
          </div>

          <div className="set-pane-subhead">
            <h5 className="set-local-form-title">{t('setLocalModels')}</h5>
            <div className="set-btn-row">
              <button
                type="button"
                className="set-btn"
                disabled={refreshing}
                onClick={refreshModels}
              >
                {t('setLocalRefreshModels')}
              </button>
            </div>
          </div>
          {draftStatus.state === 'offline' && models.length > 0 && (
            <div className="set-field-desc">{t('setLocalLastModels')}</div>
          )}
          {models.length === 0 ? (
            <div className="set-field-desc set-local-models-empty">
              {t('setLocalModelListEmpty')}
            </div>
          ) : (
            <ul className="set-local-models">
              {models.map((modelId) => {
                const modelProfile = draft.modelProfiles?.[modelId] ?? {}
                const summary = summaries[modelId]
                return (
                  <li key={modelId}>
                    <button
                      type="button"
                      className="set-local-model"
                      aria-pressed={model === modelId}
                      data-local-model={modelId}
                      onClick={() => {
                        updateDraft({ model: modelId })
                        setTestResult(null)
                      }}
                    >
                      <span className="set-local-model-id">{modelId}</span>
                      <span className="set-local-meta">
                        {t('setLocalParams')}: {summary?.parameterSize ?? t('setLocalUnknown')}
                      </span>
                      <span className="set-local-meta">
                        {t('setLocalQuantization')}: {summary?.quantization ?? t('setLocalUnknown')}
                      </span>
                      <span className="set-local-meta">
                        {t('setLocalSize')}:{' '}
                        {formatBytes(summary?.sizeBytes) ?? t('setLocalUnknown')}
                      </span>
                      <span className="set-local-meta">
                        {t('setLocalContext')}: {modelProfile.contextLength ?? t('setLocalUnknown')}
                      </span>
                      <span className="set-local-badge">
                        {t('setLocalTools')}: {capabilityText(modelProfile.tools, t)}
                      </span>
                      <span className="set-local-badge">
                        {t('setLocalVision')}: {capabilityText(modelProfile.vision, t)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          <div className="set-field">
            <div className="set-field-text">
              <div className="set-field-stack">
                <label className="set-field-label" htmlFor="set-local-model">
                  {t('setLocalModelId')}
                </label>
                <div className="set-field-desc">{t('setLocalModelIdHint')}</div>
              </div>
            </div>
            <input
              id="set-local-model"
              className="set-input"
              type="text"
              value={draft.model}
              spellCheck={false}
              onChange={(event) => {
                updateDraft({ model: event.target.value })
                setTestResult(null)
              }}
            />
          </div>

          {model && (
            <div className="set-local-profile" data-local-profile={model}>
              <h5 className="set-local-form-title">
                {t('setLocalProfileTitle')} · {model}
              </h5>
              <div className="set-field">
                <div className="set-field-text">
                  <div className="set-field-stack">
                    <label className="set-field-label" htmlFor="set-local-context">
                      {t('setLocalContext')}
                    </label>
                    <span className="set-local-source" data-local-source-context="">
                      {sourceText(profile.contextSource, t)}
                    </span>
                  </div>
                </div>
                <input
                  id="set-local-context"
                  className="set-input set-num-input"
                  type="number"
                  min={1}
                  value={profile.contextLength ?? ''}
                  onChange={(event) => setContext('contextLength', event.target.value)}
                />
              </div>
              <div className="set-field">
                <div className="set-field-text">
                  <div className="set-field-stack">
                    <label className="set-field-label" htmlFor="set-local-max-context">
                      {t('setLocalMaxContext')}
                    </label>
                    <span className="set-local-source" data-local-source-max-context="">
                      {sourceText(profile.contextSource, t)}
                    </span>
                  </div>
                </div>
                <input
                  id="set-local-max-context"
                  className="set-input set-num-input"
                  type="number"
                  min={1}
                  value={profile.maxContextLength ?? ''}
                  onChange={(event) => setContext('maxContextLength', event.target.value)}
                />
              </div>
              {contextMayDiffer[`${draftKey}:${model}`] && profile.contextSource !== 'user' && (
                <div className="set-field-desc" data-local-context-may-differ="">
                  {t('setLocalContextMayDiffer')}
                </div>
              )}
              <div className="set-field">
                <div className="set-field-text">
                  <div className="set-field-stack">
                    <label className="set-field-label" htmlFor="set-local-tools">
                      {t('setLocalTools')}
                    </label>
                    <span className="set-local-source" data-local-source-tools="">
                      {sourceText(profile.toolsSource, t)}
                    </span>
                  </div>
                </div>
                <select
                  id="set-local-tools"
                  className="set-input"
                  data-local-profile-tools=""
                  value={profile.tools === undefined ? '' : String(profile.tools)}
                  onChange={(event) => {
                    const next = { ...profile }
                    if (event.target.value === '') {
                      delete next.tools
                      delete next.toolsSource
                    } else {
                      next.tools = event.target.value === 'true'
                      next.toolsSource = 'user'
                    }
                    updateProfile(model, next)
                  }}
                >
                  <option value="">{t('setLocalUnconfirmed')}</option>
                  <option value="true">{t('setLocalSupported')}</option>
                  <option value="false">{t('setLocalUnsupported')}</option>
                </select>
              </div>
              <div className="set-field">
                <div className="set-field-text">
                  <div className="set-field-stack">
                    <label className="set-field-label" htmlFor="set-local-vision">
                      {t('setLocalVision')}
                    </label>
                    <span className="set-local-source" data-local-source-vision="">
                      {sourceText(profile.visionSource, t)}
                    </span>
                  </div>
                </div>
                <select
                  id="set-local-vision"
                  className="set-input"
                  data-local-profile-vision=""
                  value={profile.vision === undefined ? '' : String(profile.vision)}
                  onChange={(event) => {
                    const next = { ...profile }
                    if (event.target.value === '') {
                      delete next.vision
                      delete next.visionSource
                    } else {
                      next.vision = event.target.value === 'true'
                      next.visionSource = 'user'
                    }
                    updateProfile(model, next)
                  }}
                >
                  <option value="">{t('setLocalUnconfirmed')}</option>
                  <option value="true">{t('setLocalSupported')}</option>
                  <option value="false">{t('setLocalUnsupported')}</option>
                </select>
              </div>
              {profile.vision === false && (
                <div className="set-local-warning-block">
                  <div className="set-local-warning">{t('setLocalVisionUnsupported')}</div>
                  <div className="set-field-desc">{t('setLocalVisionWarn')}</div>
                </div>
              )}
              {profile.tools === false && (
                <div className="set-field-desc">{t('setLocalToolsNoEdit')}</div>
              )}
              <div className="set-field set-field-top">
                <div className="set-field-text">
                  <label className="set-field-label" htmlFor="set-local-notes">
                    {t('setLocalNotes')}
                  </label>
                </div>
                <textarea
                  id="set-local-notes"
                  className="set-input set-local-notes"
                  value={profile.notes ?? ''}
                  onChange={(event) => {
                    const profileNext = { ...profile }
                    if (event.target.value) profileNext.notes = event.target.value
                    else delete profileNext.notes
                    updateProfile(model, profileNext)
                  }}
                />
              </div>
              <div className="set-btn-row">
                <button
                  type="button"
                  className="set-btn"
                  disabled={inspecting || !model}
                  onClick={inspect}
                >
                  {t('setLocalRecheck')}
                </button>
              </div>
            </div>
          )}

          <div className="set-pane-subhead">
            <h5 className="set-local-form-title">{t('setLocalTest')}</h5>
            <div className="set-btn-row">
              <button
                type="button"
                className="set-btn"
                disabled={testing || !model}
                onClick={testConnection}
              >
                {testing ? t('setAiTesting') : t('setLocalTest')}
              </button>
              {testing && (
                <button
                  type="button"
                  className="set-btn"
                  data-local-test-cancel=""
                  onClick={cancelTest}
                >
                  {t('cancel')}
                </button>
              )}
            </div>
          </div>
          {testResult?.inputError === 'shape' && (
            <div className="set-field-desc set-local-invalid">{t('setLocalInvalidInput')}</div>
          )}
          {testResult && (
            <div className="set-local-tests">
              {localTestView(testResult).map((row) => (
                <div
                  className="set-local-test-row"
                  key={row.check}
                  data-local-test-check={row.check}
                  data-state={row.state}
                >
                  <span>{t(CHECK_LABEL[row.check])}</span>
                  <span>{t(TEST_STATE_LABEL[row.state])}</span>
                </div>
              ))}
              {localTestView(testResult).some((row) => row.state === 'unconfirmed') && (
                <div className="set-field-desc">{t('setLocalNoToolCall')}</div>
              )}
            </div>
          )}

          {formError && (
            <div className="set-field-desc set-local-warning">{validationText(formError, t)}</div>
          )}
          {saved && (
            <div className="set-field-desc" role="status">
              {t('setAiSaved')}
            </div>
          )}

          {deleteAsked && (
            <div className="set-adv-confirm" role="alertdialog" aria-label={t('setLocalDelete')}>
              <div className="set-field-desc set-adv-warning">
                {t('setLocalDeleteActiveConfirm')}
              </div>
              <div className="set-btn-row">
                <button type="button" className="set-btn" onClick={() => setDeleteAsked(null)}>
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  className="set-btn danger"
                  onClick={() => remove(deleteAsked)}
                >
                  {t('setLocalDelete')}
                </button>
              </div>
            </div>
          )}

          <div className="set-pane-footer set-local-actions">
            {draft.id && (
              <button type="button" className="set-btn danger" onClick={() => askDelete(draft.id)}>
                {t('setLocalDelete')}
              </button>
            )}
            <div className="set-btn-row">
              <button
                type="button"
                className="set-btn"
                onClick={() => {
                  setDraft(null)
                  resetFormState()
                  setSummaries({})
                }}
              >
                {t('cancel')}
              </button>
              <button type="button" className="set-btn primary" onClick={save}>
                {t('setAiSave')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
