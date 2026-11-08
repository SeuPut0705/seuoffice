import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { Lang, Params } from '@genoffice/i18n'
import {
  PDF_TOOL_ANNOT_KINDS,
  PDF_TOOL_MARGINS,
  PDF_TOOL_PAPERS,
  PDF_TOOL_SHEET_PAGES,
  type PdfEditorToolId,
  type PdfToolAccept,
  type PdfInputProblem,
  type PdfToolAnnotKind,
  type PdfToolError,
  type PdfToolId,
  type PdfToolInput,
  type PdfToolMargin,
  type PdfToolOptions,
  type PdfToolPaper,
  type PdfBlankCandidate,
  type PdfToolsStart,
} from '../../../shared/pdf-tools-api'
import { pdfToolsText, type PdfToolsStringKey } from '../i18n/strings-pdf-tools'
import { formatBytes } from '../generate/format'
import {
  IconConvertPdf,
  IconCropPages,
  IconEditText,
  IconExportImg,
  IconExtract,
  IconImagesToPdf,
  IconMergePages,
  IconMergePdf,
  IconPageSize,
  IconReverse,
  IconRotateAll,
  IconSplitPages,
  IconSplitPdf,
  IconToText,
  IconDuplex,
  IconOverlay,
  IconStripAnnots,
  IconBlankPages,
  IconCompress,
  IconLockPdf,
  IconUnlockPdf,
  IconRepairPdf,
  IconWatermark,
} from '../../../../../pdf/src/renderer/icons'

/** Home groups of the tools the window runs itself (decision 0030) */
const GROUPS: { label: PdfToolsStringKey; tools: PdfToolId[] }[] = [
  {
    label: 'groupOrganize',
    tools: ['merge', 'split', 'extract', 'reverse', 'rotate', 'blankPages'],
  },
  { label: 'groupPrint', tools: ['duplex', 'nup', 'pageSize', 'splitPages'] },
  { label: 'groupDecorate', tools: ['overlay'] },
  { label: 'groupClean', tools: ['stripAnnots'] },
  { label: 'groupConvert', tools: ['imagesToPdf', 'toText'] },
  { label: 'groupSizeSecurity', tools: ['compress', 'encrypt', 'decrypt', 'repair'] },
]

/** Tools that take several files; imagesToPdf takes pictures */
const takesMany = (tool: PdfToolId) =>
  tool === 'merge' || tool === 'imagesToPdf' || tool === 'duplex'
const takesImages = (tool: PdfToolId) => tool === 'imagesToPdf'
/** Which PDFs a tool takes (tools.ts toolAccepts) */
const accepts = (tool: PdfToolId): PdfToolAccept =>
  tool === 'decrypt' ? 'encrypted' : tool === 'repair' ? 'damaged' : 'pdf'
/** Tools that run in the PDF job process: no page progress, but they can be stopped */
const runsAsJob = (tool: PdfToolId) => tool === 'encrypt' || tool === 'decrypt' || tool === 'repair'
/** the longest password AES-256 PDF encryption keeps (tools.ts MAX_PASSWORD_BYTES) */
const passwordTooLong = (text: string) => new TextEncoder().encode(text).length > 127

const MARGIN_TEXT: Record<PdfToolMargin, PdfToolsStringKey> = {
  none: 'optMarginNone',
  small: 'optMarginSmall',
  large: 'optMarginLarge',
}

const EDITOR_TOOLS: PdfEditorToolId[] = ['stamps', 'crop', 'exportImages', 'convert', 'edit']

const TOOL_TEXT: Record<PdfToolId | PdfEditorToolId, [PdfToolsStringKey, PdfToolsStringKey]> = {
  merge: ['toolMerge', 'descMerge'],
  split: ['toolSplit', 'descSplit'],
  extract: ['toolExtract', 'descExtract'],
  reverse: ['toolReverse', 'descReverse'],
  rotate: ['toolRotate', 'descRotate'],
  nup: ['toolNup', 'descNup'],
  pageSize: ['toolPageSize', 'descPageSize'],
  splitPages: ['toolSplitPages', 'descSplitPages'],
  imagesToPdf: ['toolImagesToPdf', 'descImagesToPdf'],
  toText: ['toolToText', 'descToText'],
  duplex: ['toolDuplex', 'descDuplex'],
  overlay: ['toolOverlay', 'descOverlay'],
  stripAnnots: ['toolStripAnnots', 'descStripAnnots'],
  blankPages: ['toolBlankPages', 'descBlankPages'],
  compress: ['toolCompress', 'descCompress'],
  encrypt: ['toolEncrypt', 'descEncrypt'],
  decrypt: ['toolDecrypt', 'descDecrypt'],
  repair: ['toolRepair', 'descRepair'],
  stamps: ['toolStamps', 'descStamps'],
  crop: ['toolCrop', 'descCrop'],
  exportImages: ['toolExportImages', 'descExportImages'],
  convert: ['toolConvert', 'descConvert'],
  edit: ['toolEdit', 'descEdit'],
}

const ERROR_TEXT: Record<PdfToolError, PdfToolsStringKey> = {
  'no-input': 'errNoInput',
  'need-two': 'errNeedTwo',
  missing: 'errMissing',
  'too-large': 'errTooLarge',
  range: 'errRange',
  'same-as-source': 'errSameAsSource',
  'unsaved-target': 'errUnsavedTarget',
  busy: 'errBusy',
  'no-text': 'errNoText',
  'need-background': 'errNeedBackground',
  'no-annots': 'errNoAnnots',
  'no-kinds': 'errNoKinds',
  'all-pages': 'errAllPages',
  'not-found': 'errNotFound',
  'none-chosen': 'errNoneChosen',
  'not-smaller': 'errNotSmaller',
  'password-empty': 'errPasswordEmpty',
  'password-same': 'errPasswordSame',
  'password-long': 'errPasswordLong',
  'wrong-password': 'errWrongPassword',
  failed: 'errFailed',
}

const REJECT_TEXT: Record<PdfInputProblem, PdfToolsStringKey> = {
  encrypted: 'rejectEncrypted',
  unreadable: 'rejectUnreadable',
  'too-large': 'rejectTooLarge',
  'not-image': 'rejectNotImage',
  'not-encrypted': 'rejectNotEncrypted',
}

const PER_SHEET = [2, 4, 6, 8, 9, 16]

const DEFAULT_OPTIONS: PdfToolOptions = {
  chunkSize: 1,
  pages: '',
  perSheet: 2,
  direction: 'horizontal',
  separator: false,
  rotation: 90,
  paper: 'A4',
  perPage: 2,
  imagePaper: 'A4',
  margin: 'small',
  sheetPages: 1,
  compressLevel: 'medium',
  layer: 'behind',
  backgroundPage: 1,
  applyPages: '',
  annotKinds: PDF_TOOL_ANNOT_KINDS.filter((kind) => kind !== 'links'),
}

const LEVEL_TEXT: Record<'light' | 'medium' | 'strong', PdfToolsStringKey> = {
  light: 'levelLight',
  medium: 'levelMedium',
  strong: 'levelStrong',
}

const ANNOT_KIND_TEXT: Record<PdfToolAnnotKind, PdfToolsStringKey> = {
  comments: 'kindComments',
  highlights: 'kindHighlights',
  drawings: 'kindDrawings',
  stamps: 'kindStamps',
  links: 'kindLinks',
  other: 'kindOther',
}

/** blankPages: a search under way, what it found, and the pages picked to remove */
interface BlankState {
  finding: { done: number; total: number } | null
  found: { pageCount: number; candidates: PdfBlankCandidate[] } | null
  chosen: number[]
}

const NO_BLANK: BlankState = { finding: null, found: null, chosen: [] }

type View =
  { kind: 'home' } | { kind: 'tool'; tool: PdfToolId } | { kind: 'editor'; tool: PdfEditorToolId }

type Outcome =
  | { kind: 'done'; outputs: { id: string; name: string; size: number }[] }
  | { kind: 'error'; message: string }
  | null

/** Each card shows the PDF editor's ribbon icon for the same command (icons.tsx) */
const TOOL_ICON: Record<PdfToolId | PdfEditorToolId, () => ReactElement> = {
  merge: IconMergePdf,
  split: IconSplitPdf,
  extract: IconExtract,
  reverse: IconReverse,
  rotate: IconRotateAll,
  nup: IconMergePages,
  pageSize: IconPageSize,
  splitPages: IconSplitPages,
  imagesToPdf: IconImagesToPdf,
  toText: IconToText,
  duplex: IconDuplex,
  overlay: IconOverlay,
  stripAnnots: IconStripAnnots,
  blankPages: IconBlankPages,
  compress: IconCompress,
  encrypt: IconLockPdf,
  decrypt: IconUnlockPdf,
  repair: IconRepairPdf,
  stamps: IconWatermark,
  crop: IconCropPages,
  exportImages: IconExportImg,
  convert: IconConvertPdf,
  edit: IconEditText,
}

function ToolIcon({ tool }: { tool: PdfToolId | PdfEditorToolId }) {
  const Glyph = TOOL_ICON[tool]
  return (
    <span className="pt-card-icon">
      <Glyph />
    </span>
  )
}

export function PdfToolsWindow({ lang }: { lang: Lang }) {
  const api = window.aiOfficePdfTools
  const t = (key: PdfToolsStringKey, params?: Params) => pdfToolsText(lang, key, params)
  const [view, setView] = useState<View>({ kind: 'home' })
  const [inputs, setInputs] = useState<PdfToolInput[]>([])
  /** overlay: the PDF whose page goes behind or over the document */
  const [background, setBackground] = useState<PdfToolInput | null>(null)
  const [rejected, setRejected] = useState<string[]>([])
  const [options, setOptions] = useState<PdfToolOptions>(DEFAULT_OPTIONS)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome>(null)
  /** blankPages: the search, what it found, and the pages the user picked */
  const [blank, setBlank] = useState<BlankState>(NO_BLANK)
  /** a long tool's progress while it runs (compress) */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const openTool = (next: View) => {
    setView(next)
    setInputs([])
    setBackground(null)
    setBlank(NO_BLANK)
    setRejected([])
    setOptions(DEFAULT_OPTIONS)
    setOutcome(null)
  }

  const pick = async (tool: PdfToolId) => {
    const many = takesMany(tool)
    const result = await api.pickInputs(many, takesImages(tool) ? 'image' : 'pdf', accepts(tool))
    setRejected(result.rejected.map((r) => t(REJECT_TEXT[r.problem], { name: r.name })))
    if (result.inputs.length === 0) return
    setOutcome(null)
    // what was found belongs to the PDF it was found in
    setBlank(NO_BLANK)
    setInputs((prev) => (many ? [...prev, ...result.inputs] : result.inputs.slice(0, 1)))
  }

  const findBlank = async () => {
    const input = inputs[0]
    if (!input) return
    setOutcome(null)
    setBlank({ ...NO_BLANK, finding: { done: 0, total: input.pages } })
    const stop = api.onProgress((done, total) =>
      setBlank((prev) => (prev.finding ? { ...prev, finding: { done, total } } : prev)),
    )
    try {
      const result = await api.findBlankPages(input.id)
      if (result.ok) {
        // pages that draw nothing start picked; nearly white ones wait for the user
        const chosen = result.candidates.filter((c) => c.reason === 'empty').map((c) => c.page)
        setBlank({ finding: null, found: result, chosen })
      } else {
        setBlank(NO_BLANK)
        if ('error' in result) setOutcome({ kind: 'error', message: t(ERROR_TEXT[result.error]) })
      }
    } finally {
      stop()
    }
  }

  const pickBackground = async () => {
    const result = await api.pickInputs(false, 'pdf')
    setRejected(result.rejected.map((r) => t(REJECT_TEXT[r.problem], { name: r.name })))
    const picked = result.inputs[0]
    if (!picked) return
    setOutcome(null)
    setBackground(picked)
    // a page the new background does not have falls back to its first
    setOptions((prev) =>
      (prev.backgroundPage ?? 1) > picked.pages ? { ...prev, backgroundPage: 1 } : prev,
    )
  }

  const move = (index: number, by: -1 | 1) => {
    setInputs((prev) => {
      const next = [...prev]
      const target = index + by
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target]!, next[index]!]
      return next
    })
  }

  const runTool = async (tool: PdfToolId) => {
    setBusy(true)
    setOutcome(null)
    const stop = api.onProgress((done, total) => setProgress({ done, total }))
    // the typed-again password is only checked here; it is never sent
    const { passwordConfirm: _confirm, ...sent } = options
    try {
      const result = await api.run({
        tool,
        inputIds: inputs.map((i) => i.id),
        options: tool === 'blankPages' ? { ...sent, removePages: blank.chosen.join(',') } : sent,
        ...(tool === 'overlay' && background ? { backgroundId: background.id } : {}),
      })
      if (result.ok) {
        setOutcome({ kind: 'done', outputs: result.outputs })
        // a password the file now has, or had, is not kept on screen once it is used
        setOptions((prev) => ({
          ...prev,
          password: '',
          passwordConfirm: '',
          permissionPassword: '',
        }))
      } else if ('error' in result) {
        setOutcome({ kind: 'error', message: t(ERROR_TEXT[result.error]) })
      }
    } finally {
      stop()
      setProgress(null)
      setBusy(false)
    }
  }

  const set = (patch: PdfToolOptions) => setOptions((prev) => ({ ...prev, ...patch }))

  // a task the PDF editor's ribbon opened this window on, its file already picked;
  // the latest render's handlers, so the effect itself runs once
  const startRef = useRef<(start: PdfToolsStart) => void>(() => {})
  startRef.current = (start) => {
    openTool({ kind: 'tool', tool: start.tool })
    setInputs(start.inputs)
    setRejected(start.rejected.map((r) => t(REJECT_TEXT[r.problem], { name: r.name })))
  }
  useEffect(() => {
    const take = () =>
      void api.takeStart().then((start) => {
        if (start) startRef.current(start)
      })
    take()
    return api.onStartReady(take)
  }, [api])

  return (
    <div className="pt">
      <header className="pt-head">
        <h1 className="pt-title">{t('windowTitle')}</h1>
        <p className="pt-intro">{t('intro')}</p>
        <p className="pt-local">{t('localNote')}</p>
      </header>
      <main className="pt-body">
        {view.kind === 'home' && (
          <>
            {GROUPS.map((group) => (
              <section className="pt-section" key={group.label}>
                <h2 className="pt-label">{t(group.label)}</h2>
                <div className="pt-cards">
                  {group.tools.map((tool) => (
                    <button
                      key={tool}
                      type="button"
                      className="pt-card"
                      onClick={() => openTool({ kind: 'tool', tool })}
                    >
                      <ToolIcon tool={tool} />
                      <span className="pt-card-text">
                        <span className="pt-card-title">{t(TOOL_TEXT[tool][0])}</span>
                        <span className="pt-card-desc">{t(TOOL_TEXT[tool][1])}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
            <section className="pt-section">
              <h2 className="pt-label">{t('groupEditor')}</h2>
              <div className="pt-cards">
                {EDITOR_TOOLS.map((tool) => (
                  <button
                    key={tool}
                    type="button"
                    className="pt-card pt-card-editor"
                    onClick={() => openTool({ kind: 'editor', tool })}
                  >
                    <ToolIcon tool={tool} />
                    <span className="pt-card-text">
                      <span className="pt-card-title">{t(TOOL_TEXT[tool][0])}</span>
                      <span className="pt-card-desc">{t(TOOL_TEXT[tool][1])}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </>
        )}

        {view.kind === 'editor' && (
          <section className="pt-section">
            <button type="button" className="pt-back" onClick={() => openTool({ kind: 'home' })}>
              <span className="pt-back-arrow">←</span> {t('back')}
            </button>
            <h2 className="pt-tool-title">{t(TOOL_TEXT[view.tool][0])}</h2>
            <p className="pt-hint">{t(TOOL_TEXT[view.tool][1])}</p>
            <p className="pt-hint">{t('editorHint')}</p>
            <div className="pt-actions">
              <button
                type="button"
                className="pt-btn pt-btn-primary"
                onClick={() => void api.openInEditor()}
              >
                {t('openInEditor')}
              </button>
            </div>
          </section>
        )}

        {view.kind === 'tool' && (
          <ToolPanel
            lang={lang}
            tool={view.tool}
            t={t}
            inputs={inputs}
            background={background}
            blank={blank}
            progress={progress}
            onCancelRun={() => void api.cancelRun()}
            onFindBlank={() => void findBlank()}
            onCancelFind={() => void api.cancelFind()}
            onChooseBlank={(chosen) => setBlank((prev) => ({ ...prev, chosen }))}
            rejected={rejected}
            options={options}
            busy={busy}
            outcome={outcome}
            onBack={() => openTool({ kind: 'home' })}
            onPick={() => void pick(view.tool)}
            onPickBackground={() => void pickBackground()}
            onRemoveBackground={() => setBackground(null)}
            onRemove={(id) => {
              setInputs((prev) => prev.filter((i) => i.id !== id))
              setBlank(NO_BLANK)
            }}
            onMove={move}
            onOptions={set}
            onRun={() => void runTool(view.tool)}
            onOpen={(id) => void api.openResult(id)}
            onReveal={(id) => void api.revealResult(id)}
          />
        )}
      </main>
      <footer className="pt-foot">
        <button type="button" className="pt-btn" onClick={() => void api.close()}>
          {t('close')}
        </button>
      </footer>
    </div>
  )
}

interface ToolPanelProps {
  lang: Lang
  tool: PdfToolId
  t: (key: PdfToolsStringKey, params?: Params) => string
  inputs: PdfToolInput[]
  background: PdfToolInput | null
  blank: BlankState
  progress: { done: number; total: number } | null
  onCancelRun(): void
  onFindBlank(): void
  onCancelFind(): void
  onChooseBlank(pages: number[]): void
  rejected: string[]
  options: PdfToolOptions
  busy: boolean
  outcome: Outcome
  onBack(): void
  onPick(): void
  onPickBackground(): void
  onRemoveBackground(): void
  onRemove(id: string): void
  onMove(index: number, by: -1 | 1): void
  onOptions(patch: PdfToolOptions): void
  onRun(): void
  onOpen(id: string): void
  onReveal(id: string): void
}

function ToolPanel(p: ToolPanelProps) {
  const { t, tool, inputs, options } = p
  const many = takesMany(tool)
  const images = takesImages(tool)
  const first = inputs[0]
  const ready =
    tool === 'merge'
      ? inputs.length >= 2
      : many
        ? inputs.length >= 1
        : inputs.length === 1 &&
          (tool !== 'overlay' || !!p.background) &&
          (tool !== 'stripAnnots' || (options.annotKinds ?? []).length > 0) &&
          (tool !== 'blankPages' || p.blank.chosen.length > 0) &&
          (tool !== 'encrypt' || encryptReady(options)) &&
          (tool !== 'decrypt' || !!options.password)
  const pickLabel: PdfToolsStringKey = images
    ? inputs.length === 0
      ? 'pickImages'
      : 'addMoreImages'
    : inputs.length === 0
      ? 'pickFiles'
      : many
        ? 'addMore'
        : 'replaceFile'
  const hint: PdfToolsStringKey = images
    ? 'hintImages'
    : tool === 'duplex'
      ? 'hintDuplex'
      : tool === 'overlay'
        ? 'hintOverlay'
        : tool === 'decrypt'
          ? 'hintDecrypt'
          : tool === 'repair'
            ? 'hintRepair'
            : many
              ? 'hintMerge'
              : 'hintOne'
  const done = p.outcome?.kind === 'done' ? p.outcome.outputs : null
  // a damaged file's pages are not known until it is repaired
  const meta = (input: PdfToolInput) =>
    input.kind === 'image' || input.pages === 0
      ? formatBytes(input.size, p.lang)
      : `${t(input.pages === 1 ? 'pageCountOne' : 'pageCount', { n: input.pages })} · ${formatBytes(input.size, p.lang)}`
  const firstOutput = done?.[0]

  return (
    <section className="pt-section">
      <button type="button" className="pt-back" onClick={p.onBack}>
        <span className="pt-back-arrow">←</span> {t('back')}
      </button>
      <h2 className="pt-tool-title">{t(TOOL_TEXT[tool][0])}</h2>
      <p className="pt-hint">{t(hint)}</p>

      {inputs.length > 0 && (
        <ul className="pt-list">
          {inputs.map((input, index) => (
            <li className="pt-item" key={input.id}>
              <span className="pt-item-name" title={input.name}>
                {input.name}
              </span>
              <span className="pt-item-meta">{meta(input)}</span>
              {many && (
                <>
                  <button
                    type="button"
                    className="pt-icon-btn"
                    aria-label={t('moveUp')}
                    title={t('moveUp')}
                    disabled={index === 0}
                    onClick={() => p.onMove(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="pt-icon-btn"
                    aria-label={t('moveDown')}
                    title={t('moveDown')}
                    disabled={index === inputs.length - 1}
                    onClick={() => p.onMove(index, 1)}
                  >
                    ↓
                  </button>
                </>
              )}
              <button
                type="button"
                className="pt-icon-btn"
                aria-label={t('remove')}
                title={t('remove')}
                onClick={() => p.onRemove(input.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="pt-actions pt-actions-start">
        <button type="button" className="pt-btn" onClick={p.onPick} disabled={p.busy}>
          {t(pickLabel)}
        </button>
      </div>
      {tool === 'overlay' && (
        <>
          <h3 className="pt-field-label pt-subhead">{t('labelBackground')}</h3>
          {p.background && (
            <ul className="pt-list">
              <li className="pt-item">
                <span className="pt-item-name" title={p.background.name}>
                  {p.background.name}
                </span>
                <span className="pt-item-meta">{meta(p.background)}</span>
                <button
                  type="button"
                  className="pt-icon-btn"
                  aria-label={t('remove')}
                  title={t('remove')}
                  onClick={p.onRemoveBackground}
                >
                  ×
                </button>
              </li>
            </ul>
          )}
          <div className="pt-actions pt-actions-start">
            <button type="button" className="pt-btn" onClick={p.onPickBackground} disabled={p.busy}>
              {t(p.background ? 'replaceBackground' : 'pickBackground')}
            </button>
          </div>
        </>
      )}
      {p.rejected.map((line) => (
        <p className="pt-note pt-note-error" key={line} role="alert">
          {line}
        </p>
      ))}

      {first && tool === 'blankPages' && (
        <BlankPagesReview
          t={t}
          blank={p.blank}
          busy={p.busy}
          onFind={p.onFindBlank}
          onCancel={p.onCancelFind}
          onChoose={p.onChooseBlank}
        />
      )}
      {first && (
        <Options
          tool={tool}
          t={t}
          options={options}
          pages={first.pages}
          backgroundPages={p.background?.pages ?? 0}
          onChange={p.onOptions}
        />
      )}

      <div className="pt-actions">
        <button
          type="button"
          className="pt-btn pt-btn-primary"
          disabled={!ready || p.busy}
          onClick={p.onRun}
        >
          {p.busy ? t('running') : t('run')}
        </button>
      </div>
      {p.busy && (p.progress || runsAsJob(tool)) && (
        <div className="pt-actions" role="status">
          {p.progress && (
            <span className="pt-hint">
              {t('workingProgress', { done: p.progress.done, total: p.progress.total })}
            </span>
          )}
          <button type="button" className="pt-btn" onClick={p.onCancelRun}>
            {t('cancelRun')}
          </button>
        </div>
      )}

      {p.outcome?.kind === 'error' && (
        <p className="pt-note pt-note-error" role="alert">
          {p.outcome.message}
        </p>
      )}
      {done && firstOutput && (
        <div className="pt-note pt-note-done" role="status">
          <span>
            {done.length === 1
              ? tool === 'compress' && first
                ? t('doneCompressed', {
                    name: firstOutput.name,
                    before: formatBytes(first.size, p.lang),
                    after: formatBytes(firstOutput.size, p.lang),
                  })
                : t('doneOne', { name: firstOutput.name })
              : t('doneMany', { n: done.length })}
          </span>
          <span className="pt-done-actions">
            {done.length === 1 && (
              <button type="button" className="pt-btn" onClick={() => p.onOpen(firstOutput.id)}>
                {t('openResult')}
              </button>
            )}
            <button type="button" className="pt-btn" onClick={() => p.onReveal(firstOutput.id)}>
              {t('reveal')}
            </button>
          </span>
        </div>
      )}
    </section>
  )
}

interface OptionsProps {
  tool: PdfToolId
  t: (key: PdfToolsStringKey, params?: Params) => string
  options: PdfToolOptions
  pages: number
  /** overlay: pages of the picked background, 0 before one is picked */
  backgroundPages: number
  onChange(patch: PdfToolOptions): void
}

function Options({ tool, t, options, pages, backgroundPages, onChange }: OptionsProps) {
  switch (tool) {
    case 'split':
      return (
        <label className="pt-field">
          <span className="pt-field-label">{t('optChunk')}</span>
          <input
            type="number"
            className="pt-input pt-input-short"
            min={1}
            max={pages}
            value={options.chunkSize ?? 1}
            onChange={(e) =>
              onChange({ chunkSize: Math.max(1, Math.floor(Number(e.target.value) || 1)) })
            }
          />
        </label>
      )
    case 'extract':
      return (
        <label className="pt-field">
          <span className="pt-field-label">{t('optRange')}</span>
          <input
            type="text"
            className="pt-input"
            value={options.pages ?? ''}
            placeholder={`1-${pages}`}
            onChange={(e) => onChange({ pages: e.target.value })}
          />
        </label>
      )
    case 'nup':
      return (
        <div className="pt-fields">
          <label className="pt-field">
            <span className="pt-field-label">{t('optPerSheet')}</span>
            <select
              className="pt-input pt-input-short"
              value={options.perSheet ?? 2}
              onChange={(e) => onChange({ perSheet: Number(e.target.value) })}
            >
              {PER_SHEET.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="pt-field pt-choices">
            <legend className="pt-field-label">{t('optDirection')}</legend>
            <Choice
              name="direction"
              checked={options.direction !== 'vertical'}
              label={t('optHorizontal')}
              onPick={() => onChange({ direction: 'horizontal' })}
            />
            <Choice
              name="direction"
              checked={options.direction === 'vertical'}
              label={t('optVertical')}
              onPick={() => onChange({ direction: 'vertical' })}
            />
          </fieldset>
          <label className="pt-check">
            <input
              type="checkbox"
              checked={options.separator === true}
              onChange={(e) => onChange({ separator: e.target.checked })}
            />
            {t('optSeparator')}
          </label>
        </div>
      )
    case 'rotate':
      return (
        <fieldset className="pt-field pt-choices">
          <legend className="pt-field-label">{t('optRotation')}</legend>
          <Choice
            name="rotation"
            checked={options.rotation === 90}
            label={t('optRotateRight')}
            onPick={() => onChange({ rotation: 90 })}
          />
          <Choice
            name="rotation"
            checked={options.rotation === 270}
            label={t('optRotateLeft')}
            onPick={() => onChange({ rotation: 270 })}
          />
          <Choice
            name="rotation"
            checked={options.rotation === 180}
            label={t('opt180')}
            onPick={() => onChange({ rotation: 180 })}
          />
        </fieldset>
      )
    case 'pageSize':
      return (
        <label className="pt-field">
          <span className="pt-field-label">{t('optPaper')}</span>
          <select
            className="pt-input pt-input-short"
            value={options.paper ?? 'A4'}
            onChange={(e) => onChange({ paper: e.target.value as PdfToolPaper })}
          >
            {PDF_TOOL_PAPERS.map((paper) => (
              <option key={paper} value={paper}>
                {paper}
              </option>
            ))}
          </select>
        </label>
      )
    case 'splitPages':
      return (
        <fieldset className="pt-field pt-choices">
          <legend className="pt-field-label">{t('optPerPage')}</legend>
          {([2, 4, 9] as const).map((n) => (
            <Choice
              key={n}
              name="perPage"
              checked={(options.perPage ?? 2) === n}
              label={String(n)}
              onPick={() => onChange({ perPage: n })}
            />
          ))}
        </fieldset>
      )
    case 'imagesToPdf': {
      const paper = options.imagePaper ?? 'A4'
      return (
        <div className="pt-fields">
          <label className="pt-field">
            <span className="pt-field-label">{t('optPaper')}</span>
            <select
              className="pt-input pt-input-short"
              value={paper}
              onChange={(e) => onChange({ imagePaper: e.target.value as PdfToolPaper | 'image' })}
            >
              {PDF_TOOL_PAPERS.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
              <option value="image">{t('optImageSize')}</option>
            </select>
          </label>
          {paper !== 'image' && (
            <fieldset className="pt-field pt-choices">
              <legend className="pt-field-label">{t('optMargin')}</legend>
              {PDF_TOOL_MARGINS.map((margin) => (
                <Choice
                  key={margin}
                  name="margin"
                  checked={(options.margin ?? 'small') === margin}
                  label={t(MARGIN_TEXT[margin])}
                  onPick={() => onChange({ margin })}
                />
              ))}
            </fieldset>
          )}
        </div>
      )
    }
    case 'stripAnnots': {
      const chosen = options.annotKinds ?? []
      const toggle = (kind: PdfToolAnnotKind, on: boolean) =>
        onChange({
          annotKinds: PDF_TOOL_ANNOT_KINDS.filter((k) => (k === kind ? on : chosen.includes(k))),
        })
      return (
        <div className="pt-fields">
          <fieldset className="pt-field pt-choices">
            <legend className="pt-field-label">{t('optAnnotKinds')}</legend>
            {PDF_TOOL_ANNOT_KINDS.map((kind) => (
              <label className="pt-check" key={kind}>
                <input
                  type="checkbox"
                  checked={chosen.includes(kind)}
                  onChange={(e) => toggle(kind, e.target.checked)}
                />
                {t(ANNOT_KIND_TEXT[kind])}
              </label>
            ))}
          </fieldset>
          <label className="pt-field">
            <span className="pt-field-label">{t('optCleanPages')}</span>
            <input
              type="text"
              className="pt-input"
              value={options.applyPages ?? ''}
              placeholder={`1-${pages}`}
              onChange={(e) => onChange({ applyPages: e.target.value })}
            />
          </label>
          <p className="pt-hint">{t('noteStripAnnots')}</p>
        </div>
      )
    }
    case 'overlay':
      return (
        <div className="pt-fields">
          <fieldset className="pt-field pt-choices">
            <legend className="pt-field-label">{t('optLayer')}</legend>
            <Choice
              name="layer"
              checked={options.layer !== 'front'}
              label={t('optBehind')}
              onPick={() => onChange({ layer: 'behind' })}
            />
            <Choice
              name="layer"
              checked={options.layer === 'front'}
              label={t('optFront')}
              onPick={() => onChange({ layer: 'front' })}
            />
          </fieldset>
          {backgroundPages > 1 && (
            <label className="pt-field">
              <span className="pt-field-label">{t('optBackgroundPage')}</span>
              <input
                type="number"
                className="pt-input pt-input-short"
                min={1}
                max={backgroundPages}
                value={options.backgroundPage ?? 1}
                onChange={(e) =>
                  onChange({
                    backgroundPage: Math.min(
                      backgroundPages,
                      Math.max(1, Math.floor(Number(e.target.value) || 1)),
                    ),
                  })
                }
              />
            </label>
          )}
          <label className="pt-field">
            <span className="pt-field-label">{t('optApplyPages')}</span>
            <input
              type="text"
              className="pt-input"
              value={options.applyPages ?? ''}
              placeholder={`1-${pages}`}
              onChange={(e) => onChange({ applyPages: e.target.value })}
            />
          </label>
          <p className="pt-hint">{t('noteOverlay')}</p>
        </div>
      )
    case 'compress':
      return (
        <div className="pt-fields">
          <fieldset className="pt-field pt-choices">
            <legend className="pt-field-label">{t('optLevel')}</legend>
            {(['light', 'medium', 'strong'] as const).map((level) => (
              <Choice
                key={level}
                name="compressLevel"
                checked={(options.compressLevel ?? 'medium') === level}
                label={t(LEVEL_TEXT[level])}
                onPick={() => onChange({ compressLevel: level })}
              />
            ))}
          </fieldset>
          <p className="pt-hint">{t('noteCompress')}</p>
        </div>
      )
    case 'duplex':
      return (
        <div className="pt-fields">
          <label className="pt-field">
            <span className="pt-field-label">{t('optSheetPages')}</span>
            <select
              className="pt-input pt-input-short"
              value={options.sheetPages ?? 1}
              onChange={(e) => onChange({ sheetPages: Number(e.target.value) })}
            >
              {PDF_TOOL_SHEET_PAGES.map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? t('optNoNup') : n}
                </option>
              ))}
            </select>
          </label>
          <p className="pt-hint">{t('noteDuplex')}</p>
        </div>
      )
    case 'toText':
      return <p className="pt-hint">{t('noteToText')}</p>
    case 'encrypt':
      return <EncryptOptions t={t} options={options} onChange={onChange} />
    case 'decrypt':
      return (
        <div className="pt-fields">
          <label className="pt-field">
            <span className="pt-field-label">{t('optCurrentPassword')}</span>
            <input
              type="password"
              className="pt-input"
              autoComplete="off"
              spellCheck={false}
              value={options.password ?? ''}
              onChange={(e) => onChange({ password: e.target.value })}
            />
          </label>
          <p className="pt-hint">{t('noteDecrypt')}</p>
        </div>
      )
    case 'repair':
      return <p className="pt-hint">{t('noteRepair')}</p>
    default:
      return null
  }
}

/** encrypt: both passwords typed, the same twice, and the permission one different */
function encryptReady(o: PdfToolOptions): boolean {
  const password = o.password ?? ''
  if (!password || password !== o.passwordConfirm || passwordTooLong(password)) return false
  if (!o.restrict) return true
  const permission = o.permissionPassword ?? ''
  return !!permission && permission !== password && !passwordTooLong(permission)
}

function EncryptOptions({
  t,
  options,
  onChange,
}: Pick<OptionsProps, 't' | 'options' | 'onChange'>) {
  const password = options.password ?? ''
  const confirm = options.passwordConfirm ?? ''
  const permission = options.restrict ? (options.permissionPassword ?? '') : ''
  // what is wrong is said as the user types, so the run button is never greyed out unexplained
  const problem: PdfToolsStringKey | null =
    passwordTooLong(password) || passwordTooLong(permission)
      ? 'errPasswordLong'
      : confirm && confirm !== password
        ? 'passwordMismatch'
        : permission && permission === password
          ? 'errPasswordSame'
          : null
  const field = (label: PdfToolsStringKey, value: string, patch: (v: string) => PdfToolOptions) => (
    <label className="pt-field">
      <span className="pt-field-label">{t(label)}</span>
      <input
        type="password"
        className="pt-input"
        autoComplete="new-password"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(patch(e.target.value))}
      />
    </label>
  )
  return (
    <div className="pt-fields">
      {field('optPassword', password, (v) => ({ password: v }))}
      {field('optPasswordConfirm', confirm, (v) => ({ passwordConfirm: v }))}
      <label className="pt-check">
        <input
          type="checkbox"
          checked={options.restrict === true}
          onChange={(e) => onChange({ restrict: e.target.checked })}
        />
        {t('optRestrict')}
      </label>
      {options.restrict && (
        <>
          {field('optPermissionPassword', permission, (v) => ({ permissionPassword: v }))}
          <p className="pt-hint">{t('noteRestrict')}</p>
        </>
      )}
      {problem && (
        <p className="pt-note pt-note-error" role="alert">
          {t(problem)}
        </p>
      )}
      <p className="pt-hint">{t('noteEncrypt')}</p>
    </div>
  )
}

interface BlankPagesReviewProps {
  t: (key: PdfToolsStringKey, params?: Params) => string
  blank: BlankState
  busy: boolean
  onFind(): void
  onCancel(): void
  onChoose(pages: number[]): void
}

/** Find blank pages, then show each candidate large enough to judge; only ticked pages go */
function BlankPagesReview({ t, blank, busy, onFind, onCancel, onChoose }: BlankPagesReviewProps) {
  const { finding, found, chosen } = blank
  if (finding) {
    return (
      <div className="pt-actions pt-actions-start" role="status">
        <span className="pt-hint">
          {t('findingBlank', { done: finding.done, total: finding.total })}
        </span>
        <button type="button" className="pt-btn" onClick={onCancel}>
          {t('cancelFind')}
        </button>
      </div>
    )
  }
  if (!found) {
    return (
      <>
        <p className="pt-hint">{t('noteBlank')}</p>
        <div className="pt-actions pt-actions-start">
          <button type="button" className="pt-btn" onClick={onFind} disabled={busy}>
            {t('findBlank')}
          </button>
        </div>
      </>
    )
  }
  if (found.candidates.length === 0) {
    return (
      <p className="pt-note" role="status">
        {t('blankNone')}
      </p>
    )
  }
  const picked = new Set(chosen)
  const toggle = (page: number, on: boolean) =>
    onChoose(found.candidates.map((c) => c.page).filter((p) => (p === page ? on : picked.has(p))))
  return (
    <>
      <div className="pt-actions pt-actions-start">
        <span className="pt-hint">{t('blankFound', { n: found.candidates.length })}</span>
        <button
          type="button"
          className="pt-btn"
          onClick={() => onChoose(found.candidates.map((c) => c.page))}
        >
          {t('selectAll')}
        </button>
        <button type="button" className="pt-btn" onClick={() => onChoose([])}>
          {t('selectNone')}
        </button>
      </div>
      <ul className="pt-blank-grid">
        {found.candidates.map((c) => (
          <li key={c.page}>
            <label className="pt-blank">
              {c.thumb ? (
                <img className="pt-blank-thumb" src={c.thumb} alt="" />
              ) : (
                <span className="pt-blank-thumb pt-blank-nothumb" />
              )}
              <span className="pt-blank-text">
                <input
                  type="checkbox"
                  checked={picked.has(c.page)}
                  onChange={(e) => toggle(c.page, e.target.checked)}
                />
                {t('blankPageLabel', { n: c.page })}
              </span>
              <span className="pt-blank-reason">
                {t(c.reason === 'empty' ? 'blankEmpty' : 'blankNearlyWhite')}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </>
  )
}

function Choice(props: { name: string; checked: boolean; label: string; onPick(): void }) {
  return (
    <label className="pt-choice">
      <input type="radio" name={props.name} checked={props.checked} onChange={props.onPick} />
      {props.label}
    </label>
  )
}
