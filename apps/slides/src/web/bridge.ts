import { DEFAULT_AI_PANEL_PREFS, NO_AUTO_SAVE_DEFAULT } from '@seuoffice/ui'
import {
  createAiStreamBridge,
  createWebBridge,
  documentByPath,
  editMode,
  installWebBridge,
  joinPageCollab,
  registerCollabCapable,
  reportError,
  reportOpened,
  unsupported,
  waitForDocument,
  WebUnsupportedError,
  webAiSettings,
  webLanguage,
  type PageCollab,
  type WebDocument,
} from '@seuoffice/web-platform'
import { setUiLang } from '@seuoffice/i18n'
import { getPrivateFontData, listPrivateFontFaces } from '../main/fonts'
import type { DeckChange, DesktopFilesApi, OpenResult, SlidesApi } from '../shared/ipc'
import type { SlidesOp } from './collab-ops'
import type { Redraw, SlidesCollabHandles } from './collab-side'
import { coEditDeck, deckEdits, installHostSave, requestRendererSave } from './deck-edits'
import { deckReads } from './deck-reads'
import { currentSession, openPptxForWeb, renderDeck } from './session'

// `ready` must say so before anything asks for the document
registerCollabCapable()

/** The languages the slides renderer's bridge speaks (narrower than the shared Lang) */
type SlidesLang = Awaited<ReturnType<SlidesApi['getLanguage']>>

const noop = (): void => {}
const unsubscribe = (): (() => void) => noop

/** Members that exist only to change the deck */
const EDIT_MEMBERS = [
  'addBlankSlide',
  'addChart',
  'addComment',
  'addElement',
  'addImageBytes',
  'addInk',
  'addMediaBytes',
  'addModel3d',
  'addSection',
  'addSlide',
  'addSlideWithLayout',
  'addSmartArt',
  'addTable',
  'applyEditScript',
  'applyHeaderFooter',
  'applyTheme',
  'applyTxn',
  'batchEditTransform',
  'cancelTransformPreview',
  'changeShape',
  'clipboardExternal',
  'copyElements',
  'copyElementsImage',
  'copySlides',
  'deleteComment',
  'deleteElement',
  'deleteElements',
  'deleteSlide',
  'deleteSlides',
  'duplicateElements',
  'duplicateSlides',
  'editBackground',
  'editChart',
  'editConnectorEndpoints',
  'editFill',
  'editImageFill',
  'editPictureOpacity',
  'editPictureSrcRect',
  'editStroke',
  'editTableCell',
  'editTableStyle',
  'editText',
  'editTransform',
  'editTransformMulti',
  'findReplace',
  'flipElements',
  'getModel3dData',
  'groupElements',
  'insertImage',
  'insertImageUrl',
  'insertMedia',
  'landGeneratedPages',
  'localGeneratePage',
  'masterAddElement',
  'masterClose',
  'masterDeleteElement',
  'masterEditFill',
  'masterEditStroke',
  'masterEditText',
  'masterEditTransform',
  'masterEnter',
  'masterOpen',
  'moveSection',
  'moveSlide',
  'moveSlides',
  'nativeClipboard',
  'newBlank',
  'pasteElements',
  'pasteSlide',
  'pickModel3d',
  'redo',
  'removeSection',
  'removeSectionSlides',
  'renameSection',
  'reorderElement',
  'repasteSlide',
  'replacePictureBytes',
  'replacePictureUrl',
  'setAdvanceTimes',
  'setAnimations',
  'setEffects',
  'setElementFont',
  'setElementHidden',
  'setElementName',
  'setElementParagraphFormat',
  'setLink',
  'setModel3dView',
  'setNotes',
  'setSections',
  'setShapeAdjust',
  'setShapeGeometry',
  'setSlideHidden',
  'setSlideLayout',
  'setSlideSize',
  'setSlidesHidden',
  'setTableCellAnchor',
  'setTableColWidth',
  'setTableRowHeight',
  'setTextAnchor',
  'setTextBodyProps',
  'setTransition',
  'tableMerge',
  'tableStructure',
  'ungroupElement',
  'undo',
] as const satisfies ReadonlyArray<keyof SlidesApi>

/** Members that write or hand the deck to the desktop (files, export, print) */
const SAVE_MEMBERS = [
  'askWithheldExport',
  'exportImages',
  'exportPdf',
  'listPrinters',
  'pickExportDir',
  'pickExportPdfPath',
  'pickPictureFile',
  'printSlides',
  'printerOptions',
  'save',
  'saveAs',
  'saveIntoProject',
  'savePicture',
] as const satisfies ReadonlyArray<keyof SlidesApi>

/** The presenter and audience windows are desktop windows */
const PRESENTER_MEMBERS = [
  'audienceReady',
  'presenterEnd',
  'presenterStart',
  'presenterSwap',
] as const satisfies ReadonlyArray<keyof SlidesApi>

/** AI runs go through the desktop main process and its settings store */
const AI_MEMBERS = [
  'analyzeMedia',
  'generateImage',
  'getAiDefaultFonts',
  'imageSearch',
  'listStyleTemplates',
  'loadStyleTemplate',
  'openAiModelSettings',
  'openFontSettings',
  'readUrl',
  'saveStyleSidecar',
  'saveStyleTemplate',
  'setAiSettings',
  'setTemplateSelection',
  'webSearch',
] as const satisfies ReadonlyArray<keyof SlidesApi>

function unsupportedMembers(
  feature: string,
  names: ReadonlyArray<keyof SlidesApi>,
): Partial<SlidesApi> {
  return Object.fromEntries(names.map((name) => [name, unsupported(feature)]))
}

let reported = false
/** The host is told once, when the first deck reaches the renderer */
function reportFirst(result: OpenResult | null): OpenResult | null {
  if (result && !reported) {
    reported = true
    queueMicrotask(reportOpened)
  }
  return result
}

let pendingTaken = false

/** set when the host asked for co-editing and the page joined its session */
let coEditing: PageCollab<SlidesCollabHandles> | null = null

/** The renderer's deck-changed listeners; only co-editing sends them anything */
const deckListeners = new Set<(change: DeckChange) => void>()

/**
 * Tell the renderer the deck changed under it. An update names the order and the slides to draw
 * again (the renderer keeps the others, and a text box open on one of them); without one the
 * whole deck is sent.
 */
function redrawDeck(redraw: Redraw): void {
  const session = currentSession()
  const slides = redraw.update ? redraw.update.slides : renderDeck()
  if (!session || !slides) return
  const { cx, cy } = session.opened.deck.size
  const change: DeckChange = {
    slides,
    size: { cx, cy },
    ...(redraw.update ? { order: redraw.update.order } : {}),
    ...(redraw.replaced?.length ? { replaced: redraw.replaced } : {}),
    ...(redraw.rebuild ? { rebuild: true } : {}),
  }
  for (const listener of deckListeners) listener(change)
}

/**
 * Join the host's co-editing session for `doc` before the deck opens; a later joiner opens the
 * session's base file, not the host's copy.
 */
async function joinSlidesCollab(doc: WebDocument): Promise<void> {
  let renderer: SlidesCollabHandles | null = null
  const page = await joinPageCollab<SlidesCollabHandles, SlidesOp>({
    // 3: rebuilt runs preserve language tags, and newly authored Hangul is tagged ko-KR
    format: { name: 'pptx', schema: 3 },
    fileName: doc.fileName,
    bytes: doc.bytes,
    // the renderer's own save flow: an open text edit and notes are committed, then the session saves
    hostSave: () => requestRendererSave(),
    // an export is the deck as the person sees it: what they are still typing goes in first.
    // A viewer has nothing open, and its page refuses the members a commit would call
    ...(editMode() ? { commitDrafts: () => renderer?.commitDrafts() } : {}),
    adapter: async (handles) => {
      renderer = handles
      // a page that never co-edits never loads these
      const { openSlidesCollab } = await import('./collab-side')
      return openSlidesCollab(handles, {
        fileName: doc.fileName,
        path: doc.virtualPath,
        canEdit: editMode(),
        editMembers: EDIT_MEMBERS,
        install: (members) => Object.assign(slidesApi, members),
        redraw: redrawDeck,
      })
    },
  })
  if (!page) return
  coEditing = page
  doc.bytes = page.baseBytes
  if (editMode()) coEditDeck(page.save)
}

// AI turns go to the embed host, which calls its gateway (decision 0017)
const ai = createAiStreamBridge()

const slidesApi: Partial<SlidesApi> = {
  ...unsupportedMembers('slides.edit', EDIT_MEMBERS),
  ...unsupportedMembers('slides.save', SAVE_MEMBERS),
  ...unsupportedMembers('slides.presenter', PRESENTER_MEMBERS),
  ...unsupportedMembers('slides.ai', AI_MEMBERS),
  ...deckReads,
  consumePendingOpen: async (fitWidthPx) => {
    if (pendingTaken) return null
    pendingTaken = true
    const doc = await waitForDocument()
    if (!doc) return null
    try {
      await joinSlidesCollab(doc)
    } catch (error) {
      reportError('collab_unavailable', error instanceof Error ? error.message : String(error))
      return null
    }
    return reportFirst(await openPptxForWeb(doc, fitWidthPx))
  },
  openPptxPath: async (path, fitWidthPx) => {
    // a second open would replace the co-edited deck with the host's file
    const doc = !coEditing && documentByPath(path)
    return doc ? reportFirst(await openPptxForWeb(doc, fitWidthPx)) : null
  },
  openPptx: unsupported('slides.open-dialog'),
  getRenderSlides: async () => renderDeck(),
  privateFontFaces: async () => listPrivateFontFaces(),
  privateFontData: async (id) => getPrivateFontData(id),
  fontFamilyInfo: async () => [],
  fontInstallLocal: unsupported('slides.fonts'),
  openTemplateFontsFolder: unsupported('slides.fonts'),
  renderTemplateCover: async () => null,
  getLanguage: async () => webLanguage() as SlidesLang,
  getTheme: async () => 'system',
  getAutoSaveDefault: async () => NO_AUTO_SAVE_DEFAULT,
  getAiPanelPrefs: async () => DEFAULT_AI_PANEL_PREFS,
  setAiPanelPrefs: async () => DEFAULT_AI_PANEL_PREFS,
  getAiSettings: webAiSettings,
  getRecentFiles: async () => [],
  getChartColorSchemes: async () => null,
  getChartData: async () => null,
  getTemplateSelection: async () => null,
  takeGenerateHandoff: async () => null,
  reportGenerateRunStarted: async () => false,
  consumeHeadlessExport: async () => null,
  isDirty: async () => false,
  hasSlideClipboard: async () => false,
  clipboardProbe: async () => false,
  setShowFullScreen: async () => {},
  // an AI run holds and restores whole deck snapshots, which no other co-editing page has
  aiStream: (...args) =>
    coEditing
      ? Promise.reject(new WebUnsupportedError('slides.aiWhileCoEditing'))
      : ai.aiStream(...args),
  aiStreamCancel: ai.aiStreamCancel,
  onAiStream: ai.onAiStream,
  aiLogRunFailure: async () => {},
  // a read-only deck holds no AI run: the panel answers without one, and its editing tools are
  // refused (deck-edits.ts replaces these in edit mode)
  beginHistoryBatch: async () => false,
  endHistoryBatch: async () => null,
  aiRunBegin: async () => false,
  aiRunHold: async () => null,
  aiProposalAccept: async () => null,
  aiProposalReject: async () => false,
  aiSnapshotRestore: async () => null,
  headlessExportDone: noop,
  setAutoSavePref: noop,
  reportCloseSaveResult: noop,
  presenterSync: noop,
  presenterInk: noop,
  audienceNav: noop,
  microphoneRelease: noop,
  // menu, window and shell notifications that never arrive on the web
  onLanguageChanged: unsubscribe,
  onThemeChanged: unsubscribe,
  onAutoSaveDefaultChanged: unsubscribe,
  onAiPanelPrefsChanged: unsubscribe,
  onAiSettingsChanged: unsubscribe,
  onChromePressed: unsubscribe,
  onFontsChanged: unsubscribe,
  onCloseSaveRequest: unsubscribe,
  onHistoryChanged: unsubscribe,
  onDeckChanged: (handler) => {
    deckListeners.add(handler)
    return () => void deckListeners.delete(handler)
  },
  onMenuCommand: unsubscribe,
  onOpened: unsubscribe,
  onRenamed: unsubscribe,
  onAudienceNav: unsubscribe,
  onShowInk: unsubscribe,
  onShowSync: unsubscribe,
  // desktop-only services: undefined turns their features off, as without a shell
  aiSubscription: undefined,
  aiToolCapabilities: undefined,
  templateBytes: undefined,
  // a page the host lets edit: what deck-edits.ts carries over replaces the refusals and the
  // read-only answers above
  ...(editMode() ? deckEdits : {}),
}

/** Chat attachments are local files; the page has none to hand over */
const desktopFiles: Partial<DesktopFilesApi> = {
  pickAttachments: unsupported('slides.attachments'),
  addAttachmentPaths: unsupported('slides.attachments'),
  addPastedImage: unsupported('slides.attachments'),
  readAttachment: unsupported('slides.attachments'),
  readAttachmentImage: unsupported('slides.attachments'),
  getPathForFile: () => '',
}

export function installBridges(): void {
  setUiLang(webLanguage() as SlidesLang)
  if (editMode()) installHostSave()
  installWebBridge('slidesApi', createWebBridge<SlidesApi>('slidesApi', slidesApi))
  installWebBridge('desktop', createWebBridge<DesktopFilesApi>('desktop', desktopFiles))
  // aiOfficeDriveAi, aiOfficeOutbound, aiOfficeMcpTools, aiOfficeUserSkills, aiOfficeDocs,
  // projectApi, projectFolderApi, aiOfficeSplit and aiNamingApi stay absent: their callers probe
  // the window for them and read a missing one as "no shell", where an empty bridge would read as
  // a broken one
}
