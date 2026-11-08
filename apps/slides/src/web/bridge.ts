// not in the package's browser entry; providers.ts itself is browser-safe
import { defaultAiSettings } from '../../../../packages/ai-provider/src/providers'
import { DEFAULT_AI_PANEL_PREFS, NO_AUTO_SAVE_DEFAULT } from '@genoffice/ui'
import {
  createWebBridge,
  documentByPath,
  installWebBridge,
  reportOpened,
  unsupported,
  waitForDocument,
  webLanguage,
} from '@seuoffice/web-platform'
import { setUiLang } from '@genoffice/i18n'
import { getPrivateFontData, listPrivateFontFaces } from '../main/fonts'
import type { DesktopFilesApi, OpenResult, SlidesApi } from '../shared/ipc'
import { deckReads } from './deck-reads'
import { openPptxForWeb, renderDeck } from './session'

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
  'addSection',
  'addSlide',
  'addSlideWithLayout',
  'addSmartArt',
  'addTable',
  'aiSnapshotRestore',
  'applyEditScript',
  'applyHeaderFooter',
  'applyTheme',
  'applyTxn',
  'batchEditTransform',
  'beginHistoryBatch',
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
  'endHistoryBatch',
  'findReplace',
  'flipElements',
  'groupElements',
  'insertImage',
  'insertImageUrl',
  'insertMedia',
  'insertModel3d',
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
  'exportImages',
  'exportPdf',
  'pickExportDir',
  'pickExportPdfPath',
  'pickPictureFile',
  'printSlides',
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
  'aiStream',
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
    return doc ? reportFirst(await openPptxForWeb(doc, fitWidthPx)) : null
  },
  openPptxPath: async (path, fitWidthPx) => {
    const doc = documentByPath(path)
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
  getAiSettings: async () => defaultAiSettings(),
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
  aiStreamCancel: async () => {},
  aiLogRunFailure: async () => {},
  headlessExportDone: noop,
  setAutoSavePref: noop,
  reportCloseSaveResult: noop,
  presenterSync: noop,
  presenterInk: noop,
  audienceNav: noop,
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
  onDeckChanged: unsubscribe,
  onMenuCommand: unsubscribe,
  onOpened: unsubscribe,
  onRenamed: unsubscribe,
  onAiStream: unsubscribe,
  onAudienceNav: unsubscribe,
  onShowInk: unsubscribe,
  onShowSync: unsubscribe,
  // desktop-only services: undefined turns their features off, as without a shell
  aiSubscription: undefined,
  aiToolCapabilities: undefined,
  templateBytes: undefined,
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
  installWebBridge('slidesApi', createWebBridge<SlidesApi>('slidesApi', slidesApi))
  installWebBridge('desktop', createWebBridge<DesktopFilesApi>('desktop', desktopFiles))
  // aiOfficeDriveAi, aiOfficeOutbound, aiOfficeMcpTools, aiOfficeUserSkills, aiOfficeDocs,
  // projectApi, projectFolderApi and aiOfficeSplit stay absent: their callers probe the window
  // for them and read a missing one as "no shell", where an empty bridge would read as a broken one
}
