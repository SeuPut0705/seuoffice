// first: variables set under the old prefix are taken over before anything reads its own
import '@seuoffice/i18n/old-names-env'
import { execSync, spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { release } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  safeStorage,
  powerMonitor,
  session,
  shell,
  webContents,
} from 'electron'
import type {
  MenuItemConstructorOptions,
  MessageBoxOptions,
  NativeImage,
  WebContents,
} from 'electron'
import { atomicWriteFile } from './atomic-write'
import { registerAiNamingIpc } from './ai-naming-service'
import { tabStripOverlay } from './title-bar-overlay'
import { shellWindowBackground } from './window-background'
import { installPointerSize } from './pointer-size'
import { installShellPermissionGuard } from './permission-guard'
import {
  applyUiScaleTo,
  applyUiScaleToAll,
  changeUiScale,
  onUiScaleChanged,
  readUiScale,
} from './ui-scale'
import menuDocxIcon1x from './assets/menu-docx.png?asset'
import menuDocxIcon2x from './assets/menu-docx@2x.png?asset'
import menuXlsxIcon1x from './assets/menu-xlsx.png?asset'
import menuXlsxIcon2x from './assets/menu-xlsx@2x.png?asset'
import menuPptxIcon1x from './assets/menu-pptx.png?asset'
import menuPptxIcon2x from './assets/menu-pptx@2x.png?asset'
import menuPdfIcon1x from './assets/menu-pdf.png?asset'
import menuPdfIcon2x from './assets/menu-pdf@2x.png?asset'
import menuMdIcon1x from './assets/menu-md.png?asset'
import menuMdIcon2x from './assets/menu-md@2x.png?asset'
import menuHtmlIcon1x from './assets/menu-html.png?asset'
import menuHtmlIcon2x from './assets/menu-html@2x.png?asset'
import menuMindmapIcon1x from './assets/menu-mindmap.png?asset'
import menuMindmapIcon2x from './assets/menu-mindmap@2x.png?asset'
import menuHwpIcon1x from './assets/menu-hwp.png?asset'
import menuHwpIcon2x from './assets/menu-hwp@2x.png?asset'
import menuEpubIcon1x from './assets/menu-epub.png?asset'
import menuEpubIcon2x from './assets/menu-epub@2x.png?asset'
import menuDiagramIcon1x from './assets/menu-diagram.png?asset'
import menuDiagramIcon2x from './assets/menu-diagram@2x.png?asset'
import menuHomeIcon1x from './assets/menu-home.png?asset'
import menuHomeIcon2x from './assets/menu-home@2x.png?asset'
import {
  createI18n,
  documentLocale,
  installLang,
  isLang,
  normalizeLang,
  requestedLanguage,
  setUiLang,
  type Lang,
} from '@seuoffice/i18n'
import {
  DEV_USER_DATA_DIR_NAME,
  PRODUCT_NAME,
  USER_DATA_DIR_NAME,
  productName,
} from '@seuoffice/i18n'
import {
  DEFAULT_SAVE_DIR_KEY,
  defaultSaveDirFallback,
  DROP_OPEN_CHANNEL,
  GITHUB_REPO_URL,
  appMenuLabels,
  appMenuTemplate,
  contextMenuLabels,
  editMenuTemplate,
  installContextMenu,
  installNavigationGuard,
  isUsableSaveDir,
  HEADLESS_EXIT,
  formatHeadlessEnvelope,
  headlessExitCode,
  parseHeadlessExportArgv,
  setHeadlessMode,
  setOpenFilesSource,
  fileHasUnsavedChanges,
  setOpenPathProbe,
  type HeadlessArgvParse,
  showOpenDialogWithMemory,
  showSaveDialogWithMemory,
  windowMenuTemplate,
  aboutMenuItem,
  appMenuPopupTemplate,
  helpCheckUpdatesItems,
  setSettingsInvoker,
  setUpdateCheckInvoker,
  settingsMenuItem,
  installRendererProtocol,
  AUTHOR_NAME_KEY,
  readAuthorNameSetting,
  sanitizeAuthorName,
  systemAuthorName,
  safeExternalUrl,
  markAppShuttingDown,
  recoveryEditors,
  resetAppShuttingDown,
  resumeDiscardedCopies,
  type RecoveryUntitledIdentity,
  readLegacyImportPrompt,
  writeLegacyImportPrompt,
} from '@seuoffice/electron-utils'
import { SPLIT_PANE_CHANNELS } from '@seuoffice/electron-utils/split-pane-bridge'
import { createMainProcessProxyDispatcher } from '@seuoffice/electron-utils/main-proxy'
import {
  agentSkillNoticeDue,
  markAgentSkillNoticeSeen,
  readAppSettings,
  writeAgentPrefs,
  writeAppSetting,
  writeAppSettings,
  writeAppSettingThen,
} from './app-settings'
import {
  builtinSkillsDirFor,
  createTemplateTabs,
  createUserSkillsService,
  registerTemplateTabsIpc,
  registerUserSkillsIpc,
  type OpenedCopyTab,
  type TemplateCopy,
} from './user-skills'
import { OPEN_DOCUMENTS_FILE, clearOpenDocuments, publishOpenDocuments } from './open-documents'
import { startControlServer, type ControlServer } from './control-server'
import { controlHandler } from './control-handlers'
import { installCliLinkBestEffort } from './cli-link'
import { createDefaultAppService, execFileRunner } from './default-app'
import { registerIntegrationsIpc } from './integrations-ipc'
import { registerResultStoreIpc } from './result-store-ipc'
import { FEEDBACK_SURVEY_URL, feedbackDetails, feedbackText, platformLabel } from './feedback'
import { registerDriveIpc, type DriveService } from './drive/drive-ipc'
import { startMcpHub } from './mcp-client/hub-app'
import type { McpHub } from './mcp-client/hub'
import { freeAiInUse } from './drive/drive-consent'
import { registerOutboundIpc } from './outbound-confirm'
import { projectSkillsAllowed, projectSkillsView, setProjectSkills } from './agent/project-skills'
import {
  ATTACHABLE_EXTS,
  ATTACHABLE_IMAGE_EXTS,
  ATTACHABLE_IMAGE_MAX_BYTES,
  ATTACHABLE_MAX_BYTES,
  attachableMaxBytes,
  diagramPictureExtOfName,
  parseFileToText,
} from '@seuoffice/file-parse'
import { createDocList } from './doc-picker/doc-list'
import { resolveDocAsker } from './doc-picker/doc-asker'
import { createDocPicker } from './doc-picker/doc-picker-window'
import { handleDroppedFiles, type DroppedFilesDeps } from './dropped-files'
import { collectLaunchPaths } from './launch-paths'

import {
  buildDocsMenu,
  configureDocsRuntime,
  docsFileRenamed,
  readRecentFiles,
  readStarredFiles,
  readStarredGroupMap,
  readStarredGroups,
  recordRecentFile,
  removeRecentFiles,
  removeStarredFiles,
  replaceRecentFile,
  registerAiIpc,
  registerProjectIpc,
  setStarredGroup,
  toggleStarredFile,
  registerDocsIpc,
  exportDocsHeadless,
  setDocsExtraFileMenuItems,
  setDocsDocumentLinkMenuItems,
  setDocsMenuGate,
  setDocsShellHooks,
  createAiDocument,
  projectFilePaths,
  projectFileRenamed,
  setDocsHostWindowHook,
  setDocsShellWindow,
  setDocsFileSavedHook,
  setDocsFileOpenedHook,
  setSessionPathResolver,
  defaultSaveDir,
  uniquePathIn,
  authorizeMcpDocWrite,
  activeAiStreamCount,
  legacyDocumentChatFor,
} from '../../../docs/src/main/docs-main'
import { blankXlsxBuffer } from '@seuoffice/xlsx-gateway/gateway/csv-import-xlsx'
import { blankPdfBuffer } from '../../../pdf/src/main/blank-pdf'
import {
  applyMcpSettings,
  clearMcpLogs,
  configureMcpRuntime,
  currentMcpRuntimeDeps,
  getMcpRecentLogs,
  mcpLogFilePath,
  mcpStatus,
  revealMcpLogFile,
  startMcpFromSettings,
  stopMcpSync,
  type McpSettings,
} from './mcp/app-mcp'
import { createCliRunner } from './mcp/cli-runner'
import { DEFAULT_MCP_PORT } from './mcp/mcp-server'
import { createDocsControl, installDocsBridge } from './mcp/docs-bridge'
import { createSlidesControl } from './mcp/slides-bridge'
import { createSheetsControl, installSheetsBridge } from './mcp/sheets-bridge'
import { createOpenDocumentsControl, createOpenTargetResolver } from './mcp/open-documents-bridge'
import { createDiagramControl } from './mcp/diagram-bridge'
import { sanitizeFileBase } from './mcp/tools/document-tools'
import { createFileViaCli } from './mcp/headless-cli'
import {
  configureSheetsRuntime,
  exportSheetsPdfHeadless,
  hasActiveQueuedWorkbook,
  installSheetsMenu,
  markSheetsShuttingDown,
  resolveSheetsSessionPath,
  markSheetsUnsavedNew,
  markSheetsUntitledPath,
  unmarkSheetsUnsavedNew,
  sheetsSuggestedPathTaken,
  authorizeMcpSheetWrite,
  sendSheetsMenuAction,
  sheetsFileRenamed,
  setSheetsActivateTabHook,
  setSheetsCloseTabHook,
  setSheetsExtraFileMenuItems,
  setSheetsDocumentLinkMenuItems,
  setSheetsHostWindowHook,
  setSheetsPasswordPrompt,
  setSheetsShellWindow,
  setSheetsWorkbookOpenedHook,
  startSheetsCaptureServer,
  stopSheetsSidecar,
} from '../../../sheets/src/main/sheets-main'
import { setDelimitedImportLimit } from '../../../sheets/src/main/csv-import-limit'
import {
  configureSlidesRuntime,
  discardSlidesRecovery,
  exportSlidesPdfHeadless,
  installSlidesMenu,
  readSlidesRecentFiles,
  replaceSlidesRecentFile,
  setSlidesCloseTabHook,
  setSlidesExtraFileMenuItems,
  setSlidesDocumentLinkMenuItems,
  setSlidesOpenedHook,
  setSlidesHostWindowHook,
  setSlidesPasswordPrompt,
  setSlidesShellWindow,
  setSlidesShowBleed,
  slidesFileRenamed,
  slidesMicrophoneOpen,
} from '../../../slides/src/main/slides-main'
import { moveSlidesTemplateSelection } from '../../../slides/src/main/template-selection-ipc'
import {
  configurePdfRuntime,
  flushPdfSave,
  markPdfUntitledPath,
  pdfFileRenamed,
  requestPdfPageImages,
  requestPdfSaveAsOutcome,
  pdfCloseCancelled,
  sendPdfPrintRequest,
  setPdfRenamedHook,
  setPdfRedactionSavedHook,
  setPdfSaveAsInFlight,
} from '../../../pdf/src/main/pdf-main'
import { PDF_CHANNELS } from '../../../pdf/src/shared/ipc'
import { convertPdfFileToDocxLocalWithPrompt, PdfLoadError } from './pdf2docx-local'
import { insertIntoNoteTab, openNoteTab, type NoteTabHost } from './pdf-note-tabs'
import { convertPdfFileToPptxLocalWithPrompt } from './pdf2pptx-local'
import { convertPdfFileToXlsxLocalWithPrompt } from './pdf2xlsx-local'
import { closePdfPasswordDialog, promptPdfPassword } from './pdf-password-dialog'
import { createDocumentPasswordPrompt } from './document-password-prompt'
import {
  cancelWindowJob,
  grantPdfStructureTarget,
  registerPdfStructureIpc,
  runWindowJob,
} from './pdf-structure-ipc'
import { registerPdfConvertUiIpc, requestPdfConvertDialog } from './pdf-convert-ui'
import {
  pdfSaveAsDefaultPath,
  pdfSaveAsFilters,
  pdfSaveAsFormatOf,
  pdfSaveAsPickedPath,
} from './pdf-save-as-formats'
import {
  configureMarkdownRuntime,
  exportMarkdownPdfHeadless,
  markdownDiscardPendingAssets,
  markdownFileRenamed,
  markdownReadText,
  markdownSaveToPath,
  requestMarkdownSave,
  sendMarkdownExportRequest,
  sendMarkdownPrintRequest,
  setMarkdownDocxExportedHook,
  setMarkdownFileSavedHook,
} from '../../../markdown/src/main/markdown-main'
import {
  configureHwpRuntime,
  editorTakes,
  exportHwpPdfHeadless,
  hwpFileRenamed,
  hwpReadText,
  requestHwpPreview,
  requestHwpPrint,
  requestHwpSave,
  setHwpFileSavedHook,
} from '../../../hwp/src/main/hwp-main'
import {
  HWP_DEFAULT_FORMAT_KEY,
  normalizeHwpDefaultFormat,
  readHwpDefaultFormat,
} from '../../../hwp/src/main/default-format'
import { SLIDES_AI_FONTS_KEY, normalizeSlidesAiFonts } from '@seuoffice/ui/slides-ai-fonts'
import {
  configureHtmlRuntime,
  exportHtmlHeadless,
  htmlDiscardPendingAssets,
  htmlFileRenamed,
  htmlReadText,
  htmlSaveToPath,
  registerPrivilegedSchemes,
  requestHtmlSave,
  sendHtmlExportRequest,
  sendHtmlPrintRequest,
  setHtmlDocxExportPrepareHook,
  setHtmlDocxExportedHook,
  setHtmlFileSavedHook,
  setHtmlPresentHooks,
  setHtmlProvisionalTitleHook,
} from '../../../html/src/main/html-main'
import {
  configureMindmapRuntime,
  mindmapFileRenamed,
  mindmapSaveToPath,
  requestMindmapSave,
  sendMindmapExportRequest,
  sendMindmapMenuCommand,
  sendMindmapPrintRequest,
  setMindmapFileSavedHook,
  setMindmapMakeFromDocumentHook,
  setMindmapProvisionalTitleHook,
} from '../../../mindmap/src/main/mindmap-main'
import { mindmapReadOutline } from '../../../mindmap/src/main/mcp-queries'
import {
  EPUB_ASSET_SCHEME_PRIVILEGE,
  configureEpubRuntime,
  epubFileRenamed,
  registerEpubAssetProtocol,
  requestEpubSave,
  sendEpubMenuCommand,
  setEpubFileSavedHook,
} from '../../../epub/src/main/epub-main'
import { epubReadText, epubSaveToPath } from '../../../epub/src/main/mcp-queries'
import type { EpubMenuCommand } from '../../../epub/src/shared/ipc'
import { migrateJobRecords } from './pdf-structure/job-migration'
import {
  DRAWIO_SCHEME_PRIVILEGE,
  configureDiagramRuntime,
  diagramFileRenamed,
  diagramHasRecoveryCopy,
  diagramOpenRefusal,
  diagramSaveToPath,
  requestDiagramSave,
  sendDiagramExportRequest,
  sendDiagramMenuCommand,
  sendDiagramPrintRequest,
  setDiagramFileSavedHook,
  setDiagramHelpHook,
  setDiagramOpenFailedHook,
  setDiagramProvisionalTitleHook,
  visioOpenRefusal,
} from '../../../diagram/src/main/diagram-main'
import { openDiagramChecked } from './diagram-open-gate'
import {
  diagramApplyOps,
  diagramReadPage,
  diagramReadText,
} from '../../../diagram/src/main/mcp-queries'
import { exportDiagramHeadless } from '../../../diagram/src/main/headless-main'
import type { DiagramMenuCommand } from '../../../diagram/src/shared/ipc'
import type {
  AutoSaveDefault,
  AuthorNameSetting,
  FolderListing,
  FolderRoot,
  MoveConflictPolicy,
  MoveResult,
  NewFileOpts,
  RecentEntry,
  RecentPage,
  RenameResult,
  DocTheme,
  UiTheme,
  FileSearchPage,
  FileSearchQuery,
  FileSearchRerank,
  FileSearchSettings,
} from '../shared/home-api'
import { CSV_IMPORT_LIMIT_CHOICES_MB, HOME_CHANNELS } from '../shared/home-api'
import { csvImportLimitMb } from './csv-import-limit'
import {
  normalizeAiPanelPrefs,
  sameAiPanelPrefs,
  type AiPanelPrefs,
} from '@seuoffice/ui/ai-panel-prefs'
import type { DocumentTabKind, TabKind } from '../shared/tabs-api'
import { TABS_CHANNELS } from '../shared/tabs-api'
import { SPLIT_TABS_CHANNELS } from '../shared/split-view-api'
import type {
  SplitDropIntent,
  SplitHint,
  SplitOrientation,
  SplitViewState,
} from '../shared/split-view-api'
import { TAB_STRIP_HEIGHT } from '../shared/tab-drag-geometry'
import { SHELL_SUBSCRIPTION_CHANNELS, isSubscriptionProviderId } from '../shared/subscription-api'
import {
  SUBSCRIPTION_CHATGPT_USAGE_URL,
  SUBSCRIPTION_INSTALL_URLS,
  initSubscriptionChildTracking,
  sharedSubscriptionStatuses,
  shutdownSubscriptionChildren,
  trackedSubscriptionChildCount,
} from '@seuoffice/ai-provider/subscription'
import { showErrorDialog } from './error-dialog'
import { startRendererWatchdog } from './renderer-watchdog'
import { crashLogPath, memoryFigures, startCrashWatch, startLowMemoryWatch } from './crash-watch'
import { startHeartbeat, type HeartbeatHandle } from './crash-heartbeat'
import {
  capStatPaths,
  matchesExtFamily,
  normalizeRecentQuery,
  pageRecentPaths,
  statPathEntriesAsync,
} from './recent-files'
import { isMoveSource, isUserVisibleFile, type FileTargetSources } from './file-targets'
import {
  DOCX_RE,
  HTML_RE,
  ODT_RE,
  WORD97_RE,
  MINDMAP_RE,
  HWP_RE,
  EPUB_RE,
  DIAGRAM_RE,
  PDF_RE,
  PPTX_RE,
  TEXT_RE,
  XLSX_RE,
  renameStaysInApp,
} from './app-routing'
import { isSameFile, pdfSaveAsTarget, isValidRawRenameName } from './rename-validation'
import {
  FolderWatcher,
  createFolder,
  describeRoot,
  isInsideRoot,
  pathsUnder,
  listFolder,
  movePathsInto,
  rebasePath,
  renameFolder,
  uniqueNameIn,
  type FolderErrors,
} from './folder-tree'
import {
  FOLDER_ROOTS_KEY,
  describeExtraRoot,
  readExtraRoots,
  withExtraRoot,
  withoutExtraRoot,
} from './folder-roots'
import extractWorkerPath from './file-index/extract-worker?modulePath'
import { FileIndexer } from './file-index/indexer'
import { FileIndexStore } from './file-index/store'
import { normalizeFileSearchSettings, probeDecision, SearchReranker } from './file-index/rerank'
import {
  createKnowledgeDocument,
  KB_NOT_IN_BASE,
  KbRunScopes,
  listKnowledgeFiles,
  parseKbCreateRequest,
  parseKbOpenScope,
  readKnowledgeOrProjectPage,
  searchSavedKnowledgeWithProject,
} from './knowledge-base'
import {
  PROJECT_EDITORS,
  PROJECT_FOLDER_LISTEN_CHANNEL,
  type ProjectEditor,
} from '@seuoffice/project-store'
import { ProjectChatStore } from './projects/chat-store'
import { resolveCloudOnly } from './projects/cloud-files'
import { createCachedCloudResolver } from './projects/cloud-cache'
import {
  downloadPromptOptions,
  folderPickerOptions,
  trustChoiceOf,
  trustPromptOptions,
  useExistingPromptOptions,
} from './projects/project-dialog-text'
import {
  createCachedFileLister,
  createContextFiles,
  projectMentionFiles,
} from './projects/project-files'
import { NewDocumentPlacer, type NewDocumentOpener } from './projects/new-documents'
import { ProjectGuide } from './projects/project-guide'
import {
  createProjectNameOnly,
  createRerankIgnoreFilter,
  mergeIndexRoots,
  projectFolderRoots,
} from './projects/project-index'
import {
  registerProjectFolderIpc,
  waitForPageReturn,
  type ProjectIpcController,
  type ProjectWindow,
} from './projects/project-ipc'
import { PROJECT_UNAVAILABLE, ProjectFolderTools, type DownloadAsk } from './projects/project-tools'
import {
  runHeadlessExport,
  type HeadlessExporters,
  type HeadlessPlaceholderExport,
} from './headless-export'
import { TabManager, canonicalPath, type DetachedTab } from './tab-manager'
import { tabMenuTemplate, type TabMenuActions, isProgramFile } from './tab-menu'
import { runTabDocumentAction, type TabDocumentAction } from './tab-document-actions'
import { duplicateDocumentFile } from './tab-duplicate'
import { closeTabsInOrder, createRecentlyClosedTracker } from './tab-lifecycle'
import { handleTabShortcut } from './tab-shortcuts'
import { readSplitMemory, writeSplitMemory, type SplitMemory } from './split-memory'
import { SPLIT_EVEN_RATIO, decideSplitDrop, paneRects, splitDropZone } from './split-layout'
import { configureGenerateWindow } from './generate/generate-window'
import { configurePdfToolsWindow, openPdfToolsWithFile } from './pdf-tools/pdf-tools-window'
import {
  configureQuickLookWindow,
  notifyQuickLookLangOrThemeChanged,
  shouldKeepQuickLookInTray,
  stopQuickLookRuntime,
} from './quick-look/quick-look-window'
import { normalizeQuickLookSettings } from '../shared/quick-look-home'
import {
  HOME_KINDS_CHANNELS,
  HOME_KINDS_SETTING_KEY,
  normalizeHomeKinds,
  storedHomeKinds,
  visibleHomeKinds,
  type HomeKind,
  type HomeKindsSettings,
} from '../shared/home-kinds'
import {
  configureAgentWindow,
  isAgentWindowContents,
  stopAgentSessions,
} from './agent/agent-window'
import { startAgentMcpServer } from './agent/agent-mcp'
import { sweepAgentSessionFolders } from './agent/agent-session-folders'
import { userSkillsManageGate } from './agent/agent-skills'
import {
  buildAgentSkillBundle,
  startClaudeAgentSession,
  startCodexAgentSession,
} from '@seuoffice/ai-provider/agent-session'
import { normalizeAgentPrefs } from '../shared/agent-api'
import {
  droppedSkillSourceOf,
  normalizeAiSettings,
  setAiSecretCodec,
  type AiSettings,
} from '@seuoffice/ai-provider'
import {
  REVEAL_FLAG,
  fileSearchHoldsPlainKeys,
  openFileSearchKeys,
  runRevealEntry,
  sealFileSearchKeys,
  safeStorageCodec,
  sealStoredAiSettings,
  sealingKeyOnDisk,
} from './ai-secrets'
import { homedir, tmpdir } from 'node:os'
import {
  configureDocumentLinks,
  documentLinkFileMenuItems,
  documentLinkFileMoved,
  documentLinkPaths,
  makeFromDocument,
  noteDocumentSaved,
  refreshDocumentLinkMenu,
  type LinkedDocument,
} from './document-links-shell'
import {
  applyShellWindowState,
  installShellWindowBoundsPersistence,
  readShellWindowState,
  SHELL_WINDOW_DEFAULT_HEIGHT,
  SHELL_WINDOW_DEFAULT_WIDTH,
  SHELL_WINDOW_MIN_HEIGHT,
  SHELL_WINDOW_MIN_WIDTH,
} from './window-bounds'
import { installShellCloseGuard } from './window-close-guard'
import {
  holdSessionTabsForUpdateRestart,
  markSessionCleanExit,
  markSessionClosedToTray,
  markSessionOsEnd,
  markSessionUpdateRestart,
  noteSessionChanged,
  sessionRecorder,
} from './session-record'
import {
  createLaunchListGate,
  createOsSessionEnd,
  liveSessionSource,
  liveTabContents,
} from './launch-recovery'
import {
  crashedUntitledCopy,
  discardEditorRecovery,
  installRecoveryTitleSources,
  pushHwpRecoveryTitles,
  reopenUntitledCopy,
  runLaunchRecovery,
  tabUntitledCopy,
  type RestoredTabOpenerDeps,
} from './recovery-shell'
import { RECOVERY_LIST_CHANNELS } from '../shared/recovery-list-api'
import {
  activateDetached,
  closeDetachedWithoutPrompt,
  createDetachedEditorWindow,
  detachedFilePaths,
  detachedOpenDocuments,
  detachedRenameFile,
  detachedSessionTabs,
  detachedSetFileFor,
  detachedWebContentsFor,
  detachedSetTitleFor,
  detachedDocumentFor,
  detachedWindowForWebContents,
  dockBandFor,
  dragTornWindow,
  endTornDrag,
  findDetachedTabByPath,
  focusDetachedByPath,
  focusedDetachedKind,
  focusedDetachedTab,
  isDetachedEditorWindow,
  isDetachedTabId,
  isTearingOff,
  setDetachedChangedListener,
  setDockHost,
  takeTornTab,
} from './detached-windows'
import { checkForUpdatesNow, initAutoUpdater } from './updater'
import { cancelUpdateRestart, reopenedByInstaller, updateRestartRequested } from './update-restart'

/**
 * SeuOffice unified shell: ONE Electron app, ONE BrowserWindow, hosting the
 * docs and sheets modules as WebContentsView tabs behind a WPS-style tab
 * strip. The shell owns the lifecycle — single-instance lock, file-
 * association routing by extension, and per-active-tab menu switching.
 * Renderers load from each module's build output (apps/docs/out,
 * apps/sheets/out), so build those before running the shell.
 */

// ANY unpacked run (`npm run shell`, `npm run dev`, `npx electron .`) must not
// share the installed app's userData or single-instance lock — otherwise a dev
// run silently quits and forwards its argv to the running installed SeuOffice.
// SEUOFFICE_USER_DATA: test drivers point this at a scratch dir so an
// automated instance can run alongside the dev instance (separate lock).
if (!app.isPackaged) {
  if (process.env.SEUOFFICE_USER_DATA) {
    app.setPath('userData', process.env.SEUOFFICE_USER_DATA)
  } else {
    // One token, no space: a space breaks unquoted shell expansions, rsync
    // targets and .desktop Exec= lines (genoffice#1817). The name follows the
    // packaged profile's, and both are this product's own: a profile of the
    // upstream app is never adopted.
    app.setPath('userData', join(app.getPath('appData'), DEV_USER_DATA_DIR_NAME))
  }
} else {
  // The installed app keeps v0.12.11's machine name while Electron reads it:
  // productName ("SeuOffice") would otherwise rename the userData folder and
  // the macOS keychain item "<app name> Safe Storage", orphaning stored tokens
  // and saved absolute paths. Electron fixes the keychain name before ready, so
  // the name goes back to the display one once ready; role-based menus (appMenu:
  // "Quit <app name>") and anything else that prints app.name then read SeuOffice.
  app.setName(USER_DATA_DIR_NAME)
  app.setPath('userData', join(app.getPath('appData'), USER_DATA_DIR_NAME))
  void app.whenReady().then(() => app.setName(PRODUCT_NAME))
}

/**
 * `--headless-export <file> --to <format> --out <path> [--json]`: one document, no
 * window, one stdout line, then exit. Parsed at module scope so the dock icon
 * is gone before the app can bounce it and so every editor module sees the
 * headless flag before it registers anything.
 */
const headlessArgv = parseHeadlessExportArgv(process.argv)
if (headlessArgv.kind !== 'none') {
  setHeadlessMode(true)
  app.dock?.hide()
}

/**
 * `--reveal-ai-secrets`: the terminal command's way to open the keys this app
 * sealed (decision 0063, ai-secrets.ts). Sealed values on stdin, one JSON line
 * on stdout, exit. No window, no lock, nothing else.
 */
const revealSecretsRun = process.argv.includes(REVEAL_FLAG)
if (revealSecretsRun) {
  setHeadlessMode(true)
  app.dock?.hide()
}

// module build outputs: packaged builds carry them as extraResources
// (resources/modules/*, resources/native/*); dev/unpacked resolves them
// relative to apps/shell in the monorepo layout.
const SIDECAR_EXE = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
const APPS_ROOT = join(app.getAppPath(), '..')
const DOCS_OUT = app.isPackaged
  ? join(process.resourcesPath, 'modules', 'docs')
  : join(APPS_ROOT, 'docs', 'out')
const SHEETS_OUT = app.isPackaged
  ? join(process.resourcesPath, 'modules', 'sheets')
  : join(APPS_ROOT, 'sheets', 'out')
const SLIDES_OUT = app.isPackaged
  ? join(process.resourcesPath, 'modules', 'slides')
  : join(APPS_ROOT, 'slides', 'out')
const PDF_OUT = app.isPackaged
  ? join(process.resourcesPath, 'modules', 'pdf')
  : join(APPS_ROOT, 'pdf', 'out')
const MARKDOWN_OUT = app.isPackaged
  ? join(process.resourcesPath, 'modules', 'markdown')
  : join(APPS_ROOT, 'markdown', 'out')
const HTML_OUT = app.isPackaged
  ? join(process.resourcesPath, 'modules', 'html')
  : join(APPS_ROOT, 'html', 'out')
const MINDMAP_OUT = app.isPackaged
  ? join(process.resourcesPath, 'modules', 'mindmap')
  : join(APPS_ROOT, 'mindmap', 'out')
const HWP_OUT = app.isPackaged
  ? join(process.resourcesPath, 'modules', 'hwp')
  : join(APPS_ROOT, 'hwp', 'out')
const EPUB_OUT = app.isPackaged
  ? join(process.resourcesPath, 'modules', 'epub')
  : join(APPS_ROOT, 'epub', 'out')
// the draw.io bundle sits beside the renderer (out/drawio; modules/diagram/drawio packaged)
const DIAGRAM_OUT = app.isPackaged
  ? join(process.resourcesPath, 'modules', 'diagram')
  : join(APPS_ROOT, 'diagram', 'out')
const SIDECAR_BIN = app.isPackaged
  ? join(process.resourcesPath, 'native', SIDECAR_EXE)
  : join(APPS_ROOT, 'sheets', 'native', 'xlsx-engine', 'target', 'release', SIDECAR_EXE)

let cliRunner: ReturnType<typeof createCliRunner> | null = null
/** the bundled CLI on the app's own Node runtime (MCP headless tools, Ask AI create_document) */
function bundledCliRunner(): ReturnType<typeof createCliRunner> {
  cliRunner ??= createCliRunner({
    executable: process.execPath,
    entry: app.isPackaged
      ? join(process.resourcesPath, 'cli', 'seuoffice.cjs')
      : join(APPS_ROOT, '..', 'packages', 'cli', 'dist', 'seuoffice.cjs'),
    // the sheets engine the app itself runs; the CLI's own lookup only knows the packaged layout and a checkout
    env: existsSync(SIDECAR_BIN) ? { XLSX_SIDECAR_PATH: SIDECAR_BIN } : {},
  })
  return cliRunner
}

/**
 * Markdown made into .docx bytes by the bundled CLI in an app temp folder, for
 * a home create_document with a project (spec 6): the file reaches the
 * project folder only through its write guard, after the conversion succeeded.
 */
async function markdownDocxBytes(markdown: string): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), 'seuoffice-kb-docx-'))
  try {
    const out = join(dir, 'document.docx')
    await createFileViaCli(bundledCliRunner(), {
      type: 'docx',
      input: { name: 'content.md', content: markdown },
      out,
    })
    return new Uint8Array(readFileSync(out))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

configureDocsRuntime({
  preloadPath: join(DOCS_OUT, 'preload', 'index.js'),
  rendererUrl: process.env.DOCS_RENDERER_URL,
  rendererFile: join(DOCS_OUT, 'renderer', 'index.html'),
})
configureSheetsRuntime({
  preloadPath: join(SHEETS_OUT, 'preload', 'index.js'),
  rendererUrl: process.env.SHEETS_RENDERER_URL,
  rendererFile: join(SHEETS_OUT, 'renderer', 'index.html'),
  sidecarPath: SIDECAR_BIN,
  openGeneratedPath: (path) => openGeneratedDocument(path),
  // The sheets AI's create_document (docx/pdf/md) funnels into the docs-owned
  // creation flow, like the pdf app below.
  createDocument: createAiDocument,
  newDocumentDir: (id) => newDocumentFolderFor(id),
  writeNewDocument: (id, fileName, bytes) => writeProjectNewDocument(id, fileName, bytes),
})
configureSlidesRuntime({
  preloadPath: join(SLIDES_OUT, 'preload', 'index.js'),
  rendererDevUrl: process.env.SLIDES_RENDERER_URL,
  rendererFilePath: join(SLIDES_OUT, 'renderer', 'index.html'),
  openGeneratedPath: (path) => openGeneratedDocument(path),
  newDocumentDir: (id) => newDocumentFolderFor(id),
  // a deck a create flow handed to the AI goes into the panel's project once made (spec 6)
  writeNewDocument: (id, fileName, bytes) => writeProjectNewDocument(id, fileName, bytes),
})
/** a PDF's note (reading-assist 4.9): its Markdown tab or detached window, else a new tab */
const noteTabHost: NoteTabHost = {
  focusExisting: (path) => {
    const detached = findDetachedTabByPath(path)
    if (detached?.kind === 'markdown' && focusDetachedByPath(path)) return detached.webContents
    const id = tabManager?.findMarkdownTabByPath(path)
    if (!tabManager || !id) return undefined
    revealShellWindow()
    tabManager.activateTab(id)
    return tabManager.webContentsForTab(id)
  },
  openNew: (path) => {
    revealShellWindow()
    if (!tabManager) return undefined
    recordRecentFile(path)
    return tabManager.webContentsForTab(tabManager.openMarkdownTab(path))
  },
}
configurePdfRuntime({
  preloadPath: join(PDF_OUT, 'preload', 'index.js'),
  rendererUrl: process.env.PDF_RENDERER_URL,
  rendererFile: join(PDF_OUT, 'renderer', 'index.html'),
  openGeneratedPath: (path) => openGeneratedDocument(path),
  createDocument: createAiDocument,
  openPdfTools: (path, tool) => openPdfToolsWithFile(path, tool),
  openNote: (path) => openNoteTab(noteTabHost, path) !== null,
  insertIntoNote: (path, text) => insertIntoNoteTab(noteTabHost, path, text),
  newDocumentDir: (id) => newDocumentFolderFor(id),
})
configureMarkdownRuntime({
  preloadPath: join(MARKDOWN_OUT, 'preload', 'index.js'),
  rendererUrl: process.env.MARKDOWN_RENDERER_URL,
  rendererFile: join(MARKDOWN_OUT, 'renderer', 'index.html'),
  openGeneratedPath: (path) => openGeneratedDocument(path),
  newDocumentDir: (id) => newDocumentFolderFor(id),
  writeNewDocument: (id, fileName, bytes) => writeProjectNewDocument(id, fileName, bytes),
})
configureHtmlRuntime({
  preloadPath: join(HTML_OUT, 'preload', 'index.js'),
  rendererUrl: process.env.HTML_RENDERER_URL,
  rendererFile: join(HTML_OUT, 'renderer', 'index.html'),
  openGeneratedPath: (path) => openGeneratedDocument(path),
  newDocumentDir: (id) => newDocumentFolderFor(id),
  writeNewDocument: (id, fileName, bytes) => writeProjectNewDocument(id, fileName, bytes),
})
configureMindmapRuntime({
  preloadPath: join(MINDMAP_OUT, 'preload', 'index.js'),
  rendererUrl: process.env.MINDMAP_RENDERER_URL,
  rendererFile: join(MINDMAP_OUT, 'renderer', 'index.html'),
  newDocumentDir: (id) => newDocumentFolderFor(id),
  // a map a create flow handed to the AI goes into the panel's project once made (spec 6)
  writeNewDocument: (id, fileName, bytes) => writeProjectNewDocument(id, fileName, bytes),
})
configureHwpRuntime({
  preloadPath: join(HWP_OUT, 'preload', 'index.js'),
  rendererUrl: process.env.HWP_RENDERER_URL,
  rendererFile: join(HWP_OUT, 'renderer', 'index.html'),
  openGeneratedPath: (path) => openGeneratedDocument(path),
  openFileDialog: () => void openFileViaDialog(),
  goHome: () => tabManager?.openHomeTab(),
  newDocument: () => newHwpTab(),
  importPdf: () => void importPdfAsHwp(),
  newDocumentDir: (id) => newDocumentFolderFor(id),
})
configureEpubRuntime({
  preloadPath: join(EPUB_OUT, 'preload', 'index.js'),
  rendererUrl: process.env.EPUB_RENDERER_URL,
  rendererFile: join(EPUB_OUT, 'renderer', 'index.html'),
  userDataDir: () => app.getPath('userData'),
  // the stored translation's job records follow the book's new bytes after a save
  migrateJobRecords,
  // a result book is never written over a file open in any tab or window
  isPathOpenInTab: (path) => isPathOpenInAnyTab(path),
})
configureDiagramRuntime({
  preloadPath: join(DIAGRAM_OUT, 'preload', 'index.js'),
  rendererUrl: process.env.DIAGRAM_RENDERER_URL,
  rendererFile: join(DIAGRAM_OUT, 'renderer', 'index.html'),
  drawioDir: join(DIAGRAM_OUT, 'drawio'),
  bridgeFile: join(DIAGRAM_OUT, 'bridge', 'bridge.js'),
  packaged: app.isPackaged,
  newDocumentDir: (id) => newDocumentFolderFor(id),
  writeNewDocument: (id, fileName, bytes) => writeProjectNewDocument(id, fileName, bytes),
})
// privileged-scheme registration is only legal before app ready, and only once
// per process: the html module's call carries the book's asset scheme and the
// diagram editor's draw.io scheme along
registerPrivilegedSchemes([EPUB_ASSET_SCHEME_PRIVILEGE, DRAWIO_SCHEME_PRIVILEGE])

// ---- UI language ----
// Persisted in userData/app-settings.json so the editor modules can read the
// same file when they pick up i18n later. SEUOFFICE_LANG overrides for tests.

const APP_SETTINGS_PATH = () => join(app.getPath('userData'), 'app-settings.json')
/** Google Drive (decision 0033); registered once this instance holds the single-instance lock */
let driveService: DriveService | null = null
/** the person's own MCP servers (user MCP spec 5.1); started once the app is ready */
let mcpHub: McpHub | null = null
const OPEN_DOCUMENTS_PATH = () => join(app.getPath('userData'), OPEN_DOCUMENTS_FILE)
/** only the instance holding the single-instance lock may write or remove the registry */
let ownsOpenDocumentsRegistry = false
const publishOpenDocumentsIfOwner = (paths: readonly string[]) => {
  if (ownsOpenDocumentsRegistry) publishOpenDocuments(OPEN_DOCUMENTS_PATH(), paths)
}

/** every open file: the shell's tabs plus the detached editor windows */
function publishAllOpenDocuments(): void {
  publishOpenDocumentsIfOwner([...(tabManager?.openFilePaths() ?? []), ...detachedFilePaths()])
}
setDetachedChangedListener(() => {
  publishAllOpenDocuments()
  noteLiveSession()
})

// ---- crash recovery (launch list, session record, OS shutdown) ----

/** the launch recovery list: Home asks for it, the launch flow fills it in */
const launchListGate = createLaunchListGate()
/** files that arrived (second instance, Finder) while the launch list was unanswered */
let deferredLaunchPaths: string[] = []
/** before-quit ran and no close prompt has vetoed it since */
let appQuitting = false

/** what restored tabs need to load: nothing may load until the launch list is answered */
const restoredTabDeps: RestoredTabOpenerDeps = {
  blocked: () => launchListGate.blocking(),
  afterSheetsOpen: () => {
    if (hasActiveQueuedWorkbook()) startQueuedWorkbookNudge()
  },
}

/** the open document tabs, for the session record (a no-op until the launch started it) */
function noteLiveSession(): void {
  if (!sessionRecorder()) return
  noteSessionChanged(
    liveSessionSource({
      strip: tabManager?.sessionTabs() ?? null,
      detached: detachedSessionTabs(),
      untitledOf: (tab) =>
        tabUntitledCopy(
          tab,
          tab.kind,
          tabManager?.webContentsForTab(tab.id) ?? detachedWebContentsFor(tab.id),
        ),
    }),
  )
}

/**
 * The live webContents of an open document for MCP / AI callers: a restored
 * tab is loaded (and its editor page waited for) first; one waiting on the
 * user's recovery answer fails with a message the agent can relay.
 */
function liveDocumentContents(tabId: string): Promise<WebContents | undefined> {
  return liveTabContents(tabId, {
    ensureLoaded: (id) =>
      tabManager ? tabManager.ensureTabLoaded(id) : Promise.resolve({ status: 'missing' as const }),
    detached: (id) => detachedWebContentsFor(id),
    titleOf: (id) => tabManager?.list().find((tab) => tab.id === id)?.title,
  })
}

/**
 * The OS is ending the session (Windows session end, macOS / Linux shutdown):
 * no save prompt, every editor writes its copies now, nothing deletes them,
 * and the next run treats this exit as abnormal (spec 4).
 */
/** the main process's heartbeat (crash-heartbeat.ts); normal runs only */
let mainHeartbeat: HeartbeatHandle | null = null

const endForOsSession = createOsSessionEnd({
  markShuttingDown: () => {
    appQuitting = true
    markSheetsShuttingDown()
    markAppShuttingDown()
  },
  markSessionOsEnd: () => {
    markSessionOsEnd()
    mainHeartbeat?.markEnded('os')
  },
  editors: () => recoveryEditors(),
  finish: () => {
    stopSheetsSidecar()
    stopMcpSync()
    releaseAppResources()
    // app.exit skips the close prompts and every window clean-up
    app.exit(0)
  },
})

/** untitled documents' copies are listed under the tab title the user sees */
installRecoveryTitleSources(
  (contents) =>
    tabManager?.describeWebContents(contents.id)?.title ?? detachedDocumentFor(contents.id)?.title,
)

ipcMain.handle(RECOVERY_LIST_CHANNELS.get, (event) => {
  // the shell window's Home only (the manual shares the preload)
  if (!shellWindow || event.sender !== shellWindow.webContents) return null
  return launchListGate.get()
})
ipcMain.handle(RECOVERY_LIST_CHANNELS.submit, async (event, result: unknown) => {
  if (!shellWindow || event.sender !== shellWindow.webContents) {
    throw new Error('the launch recovery list belongs to the main window')
  }
  await launchListGate.submit(result)
})

/** ai-settings.json as every reader gets it (the docs main owns the file; agent sessions only read it) */
function readStoredAiSettings(): AiSettings {
  try {
    return normalizeAiSettings(
      JSON.parse(readFileSync(join(app.getPath('userData'), 'ai-settings.json'), 'utf8')),
    )
  } catch {
    return normalizeAiSettings({})
  }
}

let uiLang: Lang | null = null

function currentLang(): Lang {
  if (uiLang) return uiLang
  // the value as written goes along with the UI language it narrows to: what a
  // workbook's dates are formatted for follows it (a Japanese system keeps its formats)
  if (process.env.SEUOFFICE_LANG) {
    uiLang = normalizeLang(process.env.SEUOFFICE_LANG)
    setUiLang(uiLang, process.env.SEUOFFICE_LANG)
    return uiLang
  }
  const stored = readAppSettings(APP_SETTINGS_PATH()).language
  uiLang = installLang(stored, app.getLocale())
  setUiLang(uiLang, requestedLanguage(stored, app.getLocale()))
  return uiLang
}

/** the language documents are read for; currentLang() is what first records the request */
function currentDocumentLocale(): string {
  currentLang()
  return documentLocale()
}

function persistLang(lang: Lang): void {
  // write first: app-settings.json can be unwritable, and a language committed to
  // memory before the write survives only until the next launch
  writeAppSettingThen(APP_SETTINGS_PATH(), 'language', lang, (persisted) => {
    uiLang = persisted
    setUiLang(persisted)
  })
}

let cachedAutoUpdateCheck: boolean | null = null

function autoUpdateCheckEnabled(): boolean {
  cachedAutoUpdateCheck ??= readAppSettings(APP_SETTINGS_PATH()).autoUpdateCheck !== false
  return cachedAutoUpdateCheck
}

let cachedTheme: UiTheme | null = null

function currentTheme(): UiTheme {
  if (cachedTheme) return cachedTheme
  const saved = readAppSettings(APP_SETTINGS_PATH()).theme
  cachedTheme = saved === 'light' || saved === 'dark' ? saved : 'system'
  return cachedTheme
}

let cachedDocTheme: DocTheme | null = null

function currentDocTheme(): DocTheme {
  if (cachedDocTheme) return cachedDocTheme
  const saved = readAppSettings(APP_SETTINGS_PATH()).documentTheme
  cachedDocTheme = saved === 'light' || saved === 'dark' ? saved : 'follow'
  return cachedDocTheme
}

/**
 * The ceiling a delimited import (a .csv/.tsv opened as a workbook) may reach,
 * in MB. The editors take it through setDelimitedImportLimit, so the value the
 * user picks applies to the next file they open.
 */
function currentCsvImportLimitMb(): number {
  return csvImportLimitMb(readAppSettings(APP_SETTINGS_PATH()))
}

let cachedAutoSaveDefault: AutoSaveDefault | null = null

function currentAutoSaveDefault(): AutoSaveDefault {
  if (cachedAutoSaveDefault) return cachedAutoSaveDefault
  const saved = readAppSettings(APP_SETTINGS_PATH())
  const updatedAt = saved.autoSaveDefaultUpdatedAt
  cachedAutoSaveDefault = {
    on: saved.autoSaveDefault === true,
    updatedAt: typeof updatedAt === 'number' && updatedAt > 0 ? updatedAt : 0,
  }
  return cachedAutoSaveDefault
}

/** MCP server settings (persisted in userData/app-settings.json; default off). */
function currentMcpSettings(): McpSettings {
  const saved = readAppSettings(APP_SETTINGS_PATH())
  const port = saved.mcpPort
  return {
    enabled: saved.mcpEnabled === true,
    port:
      typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536
        ? port
        : DEFAULT_MCP_PORT,
    background: saved.mcpBackground === true,
    logging: saved.mcpLogging === true,
  }
}

let cachedAiPanelPrefs: AiPanelPrefs | null = null
function currentAiPanelPrefs(): AiPanelPrefs {
  if (cachedAiPanelPrefs) return cachedAiPanelPrefs
  const saved = readAppSettings(APP_SETTINGS_PATH())
  cachedAiPanelPrefs = normalizeAiPanelPrefs({
    side: saved.aiPanelSide,
    fontSize: saved.aiPanelFontSize,
    customFontSize: saved.aiPanelCustomFontSize,
    spellcheck: saved.aiPanelSpellcheck,
    openInNewDocs: saved.aiPanelOpenInNewDocs,
    showAiSidebar: saved.aiPanelShowSidebar,
  })
  return cachedAiPanelPrefs
}

const tMain = createI18n({
  en: {
    menuTabSave: 'Save',
    menuTabSaveAs: 'Save As…',
    menuTabPrint: 'Print…',
    menuTabRename: 'Rename',
    menuTabDuplicate: 'Duplicate (copy the saved file)',
    menuTabSplitBeside: 'Split side by side',
    menuTabCopyPath: 'Copy path',
    menuTabCopyName: 'Copy file name',
    menuTabReveal: 'Show in folder',
    menuTabOpenDefault: 'Open with the default app',
    menuTabMoveLeft: 'Move left',
    menuTabMoveRight: 'Move right',
    menuTabCloseOthers: 'Close other tabs',
    menuTabCloseRight: 'Close tabs to the right',
    menuTabCloseAll: 'Close all tabs',
    menuTabReopen: 'Reopen closed tab',
    dlgAddFolderRoot: 'Add Folder to Home',
    watchdogTitle: 'Document is using too many resources',
    watchdogBody:
      '"{title}" has been using a lot of memory or CPU for several minutes ({memory} MB, {cpu}% CPU). You can keep waiting, or close the document (you will be asked to save unsaved changes first). Diagnostics have been recorded.',
    watchdogWait: 'Keep Waiting',
    watchdogClose: 'Close Document',
    watchdogIgnore: "Don't Remind Again",
    crashTitle: 'A document stopped unexpectedly',
    crashBody: '"{title}" stopped unexpectedly. Changes made since it was last saved may be lost.',
    crashReopen: 'Reopen',
    crashReload: 'Reload',
    crashClose: 'Close',
    crashLater: 'Not Now',
    errFolderRootUnusable: 'The selected folder cannot be read',
    menuFile: 'File',
    menuSectionNew: 'New',
    menuView: 'View',
    menuUiZoomIn: 'Interface Zoom In',
    menuUiZoomOut: 'Interface Zoom Out',
    menuUiZoomReset: 'Reset Interface Zoom',
    menuOpenInNewWindow: 'Open in New Window',
    menuSplitRight: 'Split Right',
    menuSplitDown: 'Split Down',
    menuUnsplit: 'Unsplit',
    menuNewDoc: 'AI Docs',
    menuNewSheet: 'AI Sheets',
    untitledSheet: 'Untitled Spreadsheet',
    untitledDoc: 'Untitled Document',
    untitledDeck: 'Untitled Presentation',
    untitledMarkdown: 'Untitled Markdown',
    untitledHtml: 'Untitled HTML',
    untitledMindmap: 'Untitled Mind Map',
    untitledDiagram: 'Untitled Diagram',
    untitledHwp: 'Untitled HWP',
    untitledPdf: 'Untitled PDF',
    menuNewSlide: 'AI Slides',
    menuNewMarkdown: 'AI Markdown',
    menuNewHtml: 'AI HTML',
    menuNewMindmap: 'Mind Map',
    menuNewDiagram: 'Diagram',
    menuNewHwp: 'AI HWP',
    menuNewPdf: 'AI PDF',
    menuImportPdf: 'Import PDF…',
    menuExportPdf: 'Export as PDF…',
    menuExportImages: 'Export as Images…',
    menuExportHtml: 'Export as Single-File HTML…',
    menuExportMapImage: 'Export as Image (PNG)…',
    menuExportMapSvg: 'Export as Image (SVG)…',
    menuExportSvg: 'Export as SVG…',
    menuZoomFit: 'Fit to Window',
    menuExportMapOutline: 'Export as Markdown Outline…',
    menuMakeFromDocument: 'Make Another Document from This',
    menuDocumentSources: 'View Sources',
    menuDerivedDocuments: 'Documents Made from This',
    menuOpenInDocs: 'Convert and Open in Docs',
    menuPrint: 'Print…',
    menuPreview: 'Print Preview…',
    menuOpen: 'Open…',
    menuSave: 'Save',
    menuSaveAs: 'Save As…',
    menuClose: 'Close',
    menuEdit: 'Edit',
    menuWindow: 'Window',
    menuHome: 'Home',
    backToHome: 'Back to Home',
    dlgOpenTitle: 'Open File',
    filterSupported: 'Supported Files',
    filterWord: 'Word Documents',
    filterOdt: 'OpenDocument Text',
    filterExcel: 'Excel Workbooks',
    filterPpt: 'PowerPoint Presentations',
    filterMarkdown: 'Text Files (Markdown, TXT, JSON)',
    filterHtml: 'HTML Documents',
    filterMindmap: 'Mind Maps (XMind, FreeMind, Freeplane)',
    filterHwp: 'HWP Documents (HWP, HWPX)',
    filterEpub: 'E-books (EPUB)',
    filterDiagram: 'Diagrams (draw.io, VSDX)',
    menuFind: 'Find…',
    menuReplace: 'Replace…',
    menuTranslateBook: 'Translate Book…',
    filterPdf: 'PDF Documents',
    filterPdfPageImages: 'PNG Images (one file per page)',
    errBadArgs: 'Invalid arguments',
    errBadName: 'Invalid file name',
    errBadExtension: 'That extension is not supported, and the file would no longer open',
    errMissing: 'File not found',
    errExists: 'A file with that name already exists',
    errRenameFailed: 'Rename failed',
    errPdfSaveAsFailed: 'Could not save the PDF copy',
    errNewTabFailed: 'Could not create the new document',
    errDuplicateFailed: 'Could not duplicate the file',
    errUnsupportedExt: '.{ext} files are not supported',
    copySuffix: 'copy',
    menuHelp: 'Help',
    menuUserGuide: 'User Guide',
    thirdPartyNotices: 'Third-Party Notices',
    menuExportDocx: 'Export as Word…',
    menuExportOdt: 'Export as ODT…',
    btnCancel: 'Cancel',
    pdfDocxFailedMsg: 'Export as Word failed',
    pdfDocxBusyMsg: 'A Word export is already in progress. Please wait for it to finish.',
    menuExportPptx: 'Export as PowerPoint…',
    pdfPptxFailedMsg: 'Export as PowerPoint failed',
    pdfPptxBusyMsg: 'An export is already in progress. Please wait for it to finish.',
    pdfPptxLocalScannedDetail:
      'Each page was exported as a full-page image; the text on the slides is not editable.',
    menuExportXlsx: 'Export as Excel…',
    menuExportMd: 'Export as Markdown…',
    menuExportEpub: 'Export as EPUB…',
    pdfXlsxFailedMsg: 'Export as Excel failed',
    pdfXlsxBusyMsg: 'An export is already in progress. Please wait for it to finish.',
    pdfXlsxLocalScannedDetail:
      "Scanned pages cannot be converted to cells; each page's worksheet carries a notice row instead.",
    pdfXlsxLocalSkippedMsg: 'Some pages were not converted to cells',
    pdfXlsxLocalSkippedDetail:
      'Pages {pages} could not be converted to cells; their worksheets carry a notice row instead.',
    pdfDocxLocalScannedMsg: 'Scanned document detected',
    pdfDocxLocalScannedDetail:
      'The pages were exported as images to preserve their appearance; no editable text could be recognized.',
    pdfDocxLocalDegradedMsg: 'Some pages were exported as images',
    pdfDocxLocalDegradedDetail:
      'Page(s) {pages} could not be reliably reconstructed and were exported as full-page images.',
    pdfDocxLocalOcrMsg: 'Scanned pages converted to editable text',
    pdfDocxLocalOcrDetail:
      'Page(s) {pages} were scans; their text was recovered with on-device OCR. Please proofread the result.',
    pdfDocxLocalEncryptedDetail:
      'This PDF is encrypted and could not be opened without the correct password.',
    pdfDocxLocalUnsupportedEncDetail:
      'This PDF uses certificate-based or otherwise unsupported encryption and cannot be converted.',
    pdfPwdTitle: 'Enter Password',
    pdfPwdPrompt: 'This PDF is encrypted. Enter the password to open it:',
    docPwdPrompt: 'This file is password-protected. Enter the password to open it:',
    pdfPwdRetryPrompt: 'Incorrect password. Please try again.',
    pdfPwdOk: 'OK',
    pdfPwdVerifying: 'Verifying password…',
    pdfPwdLabel: 'Password',
    pdfPwdPlaceholder: 'Enter the open password',
    pdfPwdShow: 'Show password',
    pdfPwdHide: 'Hide password',
    pdfDocxLocalCorruptDetail: 'The file is damaged or not a valid PDF and cannot be converted.',
    dlgPickSaveDir: 'Choose Default Save Location',
    errSaveDirUnusable:
      'The selected folder is not writable and cannot be used as the default save location',
    saveDirFallbackMsg: "Can't save to the Documents folder",
    saveDirFallbackDetail:
      'SeuOffice could not create or write {blocked}, so new files are saved in {using}. If Windows Security\'s "Controlled folder access" blocked it, add SeuOffice under "Allow an app through Controlled folder access" and restart the app. You can also pick another folder in Settings → General → Save Location.',
  },
  ko: {
    menuTabSave: '저장',
    menuTabSaveAs: '다른 이름으로 저장…',
    menuTabPrint: '인쇄…',
    menuTabRename: '이름 바꾸기',
    menuTabDuplicate: '복제(저장된 파일 복사)',
    menuTabSplitBeside: '나란히 분할',
    menuTabCopyPath: '경로 복사',
    menuTabCopyName: '파일 이름 복사',
    menuTabReveal: '폴더에서 표시',
    menuTabOpenDefault: '기본 앱으로 열기',
    menuTabMoveLeft: '왼쪽으로 이동',
    menuTabMoveRight: '오른쪽으로 이동',
    menuTabCloseOthers: '다른 탭 닫기',
    menuTabCloseRight: '오른쪽 탭 닫기',
    menuTabCloseAll: '모든 탭 닫기',
    menuTabReopen: '닫힌 탭 다시 열기',
    dlgAddFolderRoot: '홈에 폴더 추가',
    watchdogTitle: '문서가 리소스를 과도하게 사용하고 있습니다',
    watchdogBody:
      '"{title}"이(가) 몇 분 동안 많은 메모리 또는 CPU를 사용하고 있습니다(메모리 {memory} MB, CPU {cpu}%). 계속 기다리거나 이 문서를 닫을 수 있습니다(저장되지 않은 변경 사항이 있으면 먼저 저장 여부를 묻습니다). 진단 정보가 기록되었습니다.',
    watchdogWait: '계속 기다리기',
    watchdogClose: '문서 닫기',
    watchdogIgnore: '다시 알리지 않기',
    crashTitle: '문서가 예기치 않게 멈췄습니다',
    crashBody:
      '"{title}" 화면이 예기치 않게 꺼졌습니다. 마지막으로 저장한 뒤의 변경은 사라졌을 수 있습니다.',
    crashReopen: '다시 열기',
    crashReload: '다시 불러오기',
    crashClose: '닫기',
    crashLater: '나중에',
    errFolderRootUnusable: '선택한 폴더를 읽을 수 없습니다',
    menuFile: '파일',
    menuSectionNew: '새로 만들기',
    menuOpenInNewWindow: '새 창에서 열기',
    menuSplitRight: '오른쪽에 나누기',
    menuSplitDown: '아래에 나누기',
    menuUnsplit: '나누기 풀기',
    menuNewDoc: 'AI Docs',
    menuNewSheet: 'AI Sheets',
    untitledSheet: '제목 없는 스프레드시트',
    untitledDoc: '제목 없는 문서',
    untitledDeck: '제목 없는 프레젠테이션',
    untitledMarkdown: '제목 없는 Markdown',
    untitledHtml: '제목 없는 HTML',
    untitledMindmap: '제목 없는 마인드맵',
    untitledDiagram: '제목 없는 다이어그램',
    untitledHwp: '제목 없는 한글 문서',
    untitledPdf: '제목 없는 PDF',
    menuNewSlide: 'AI Slides',
    menuNewMarkdown: 'AI Markdown',
    menuNewHtml: 'AI HTML',
    menuNewMindmap: '마인드맵',
    menuNewDiagram: '다이어그램',
    menuNewHwp: 'AI 한글',
    menuNewPdf: 'AI PDF',
    menuImportPdf: 'PDF 가져오기…',
    menuExportPdf: 'PDF로 내보내기…',
    menuExportImages: '이미지로 내보내기…',
    menuExportHtml: '단일 파일 HTML로 내보내기…',
    menuExportMapImage: '이미지(PNG)로 내보내기…',
    menuExportMapSvg: '이미지(SVG)로 내보내기…',
    menuExportSvg: 'SVG로 내보내기…',
    menuZoomFit: '창에 맞추기',
    menuExportMapOutline: '마크다운 개요로 내보내기…',
    menuMakeFromDocument: '이 문서로 다른 문서 만들기',
    menuDocumentSources: '자료 보기',
    menuDerivedDocuments: '이 문서로 만든 문서',
    menuOpenInDocs: 'Docs 문서로 변환하여 열기',
    menuPrint: '인쇄…',
    menuPreview: '미리 보기…',
    menuOpen: '열기…',
    menuSave: '저장',
    menuSaveAs: '다른 이름으로 저장…',
    menuClose: '닫기',
    menuEdit: '편집',
    menuView: '보기',
    menuUiZoomIn: 'UI 확대',
    menuUiZoomOut: 'UI 축소',
    menuUiZoomReset: 'UI 배율을 100%로 다시 설정',
    menuWindow: '창',
    menuHome: '홈',
    backToHome: '홈으로 돌아가기',
    dlgOpenTitle: '파일 열기',
    filterSupported: '지원되는 파일',
    filterWord: 'Word 문서',
    filterOdt: 'OpenDocument 텍스트',
    filterExcel: 'Excel 통합 문서',
    filterPpt: 'PowerPoint 프레젠테이션',
    filterMarkdown: '텍스트 파일 (Markdown, TXT, JSON)',
    filterHtml: 'HTML 문서',
    filterMindmap: '마인드맵 (XMind, FreeMind, Freeplane)',
    filterHwp: '한글 문서 (HWP, HWPX)',
    filterEpub: '전자책 (EPUB)',
    filterDiagram: '다이어그램 (draw.io, VSDX)',
    menuFind: '찾기…',
    menuReplace: '바꾸기…',
    menuTranslateBook: '책 번역…',
    filterPdf: 'PDF 문서',
    filterPdfPageImages: 'PNG 이미지 (페이지마다 파일 하나)',
    errBadArgs: '잘못된 인수입니다',
    errBadName: '파일 이름이 잘못되었습니다',
    errBadExtension: '지원하지 않는 확장자이며 파일을 열 수 없게 됩니다',
    errMissing: '파일을 찾을 수 없습니다',
    errExists: '같은 이름의 파일이 이미 있습니다',
    errRenameFailed: '이름 바꾸기에 실패했습니다',
    errPdfSaveAsFailed: 'PDF 복사본을 저장할 수 없습니다',
    errNewTabFailed: '새 문서를 만들지 못했습니다',
    errDuplicateFailed: '파일을 복제할 수 없습니다',
    errUnsupportedExt: '.{ext} 형식은 지원되지 않습니다',
    copySuffix: '복사본',
    menuHelp: '도움말',
    menuUserGuide: '사용자 가이드',
    thirdPartyNotices: '타사 소프트웨어 고지',
    menuExportDocx: 'Word로 내보내기…',
    menuExportOdt: 'ODT로 내보내기…',
    btnCancel: '취소',
    pdfDocxFailedMsg: 'Word로 내보내기 실패',
    pdfDocxBusyMsg: 'Word 내보내기가 이미 진행 중입니다. 완료될 때까지 기다려 주세요.',
    menuExportPptx: 'PowerPoint로 내보내기…',
    pdfPptxFailedMsg: 'PowerPoint 내보내기 실패',
    pdfPptxBusyMsg: '변환이 진행 중입니다. 현재 내보내기가 완료될 때까지 기다려 주세요.',
    pdfPptxLocalScannedDetail:
      '각 페이지가 이미지로 내보내져 슬라이드의 텍스트를 편집할 수 없습니다.',
    menuExportXlsx: 'Excel로 내보내기…',
    menuExportMd: 'Markdown으로 내보내기…',
    menuExportEpub: 'EPUB으로 내보내기…',
    pdfXlsxFailedMsg: 'Excel 내보내기 실패',
    pdfXlsxBusyMsg: '변환이 진행 중입니다. 현재 내보내기가 완료될 때까지 기다려 주세요.',
    pdfXlsxLocalScannedDetail:
      '스캔된 페이지는 셀로 변환할 수 없어 각 페이지의 워크시트에 알림 행을 기록했습니다.',
    pdfXlsxLocalSkippedMsg: '일부 페이지가 셀로 변환되지 않았습니다',
    pdfXlsxLocalSkippedDetail:
      '{pages} 페이지는 셀로 변환할 수 없어 해당 워크시트에 알림 행을 기록했습니다.',
    pdfDocxLocalScannedMsg: '스캔 문서가 감지되었습니다',
    pdfDocxLocalScannedDetail:
      '모양을 유지하기 위해 각 페이지를 이미지로 내보냈습니다. 편집 가능한 텍스트를 인식할 수 없었습니다.',
    pdfDocxLocalDegradedMsg: '일부 페이지가 이미지로 내보내졌습니다',
    pdfDocxLocalDegradedDetail:
      '{pages}쪽은 레이아웃을 안정적으로 재구성할 수 없어 전체 페이지 이미지로 내보냈습니다.',
    pdfDocxLocalOcrMsg: '스캔 페이지를 편집 가능한 텍스트로 변환했습니다',
    pdfDocxLocalOcrDetail:
      '{pages}페이지는 스캔 이미지로, 로컬 OCR로 텍스트를 복원했습니다. 결과를 검토해 주세요.',
    pdfDocxLocalEncryptedDetail:
      '이 PDF는 암호화되어 있으며 올바른 비밀번호가 없어 변환할 수 없습니다.',
    pdfDocxLocalUnsupportedEncDetail:
      '이 PDF는 인증서 기반이거나 지원되지 않는 암호화 방식을 사용하므로 변환할 수 없습니다.',
    pdfPwdTitle: '비밀번호 입력',
    pdfPwdPrompt: '이 PDF는 암호화되어 있습니다. 열기 위한 비밀번호를 입력하세요:',
    docPwdPrompt: '이 파일은 암호로 보호되어 있습니다. 열기 위한 비밀번호를 입력하세요:',
    pdfPwdRetryPrompt: '비밀번호가 올바르지 않습니다. 다시 시도하세요.',
    pdfPwdOk: '확인',
    pdfPwdVerifying: '비밀번호 확인 중…',
    pdfPwdLabel: '암호',
    pdfPwdPlaceholder: '열기 암호 입력',
    pdfPwdShow: '암호 표시',
    pdfPwdHide: '암호 숨기기',
    pdfDocxLocalCorruptDetail: '파일이 손상되었거나 유효한 PDF가 아니어서 변환할 수 없습니다.',
    dlgPickSaveDir: '기본 저장 위치 선택',
    errSaveDirUnusable: '선택한 폴더에 쓸 수 없어 기본 저장 위치로 사용할 수 없습니다',
    saveDirFallbackMsg: '문서 폴더에 저장할 수 없습니다',
    saveDirFallbackDetail:
      '{blocked} 폴더를 만들거나 쓰지 못해서, 새 파일은 {using}에 저장합니다. Windows 보안의 "제어된 폴더 액세스"가 막은 것이라면 "제어된 폴더 액세스를 통해 앱 허용"에 SeuOffice를 추가한 뒤 앱을 다시 시작하세요. 설정 → 일반 → 저장 위치에서 다른 폴더를 고를 수도 있습니다.',
  },
})

const tm = (key: Parameters<typeof tMain>[1], params?: Parameters<typeof tMain>[2]) =>
  tMain(currentLang(), key, params)

let saveDirFallbackNoticed = false

/** once per run: tell the user new files land outside <Documents>/<product>, and why */
function noticeSaveDirFallback(): void {
  const fallback = defaultSaveDirFallback()
  if (!fallback || saveDirFallbackNoticed) return
  saveDirFallbackNoticed = true
  const options = {
    type: 'warning' as const,
    message: tm('saveDirFallbackMsg'),
    detail: tm('saveDirFallbackDetail', fallback),
  }
  void (shellWindow ? dialog.showMessageBox(shellWindow, options) : dialog.showMessageBox(options))
}

// ---- the shell window + its tab manager (recreated if the user closes it on macOS) ----

let shellWindow: BrowserWindow | null = null
let tabManager: TabManager | null = null

/**
 * New file from a folder view: the click remembers the folder per kind, the
 * new-tab code consumes it right away. Sheets / PDF write their blank file
 * straight into that folder; the editors that save untitled files themselves
 * (docs, slides, markdown, html) get the folder bound to the tab that was just
 * created, and the tab's first save moves the fresh file there.
 * key: 'doc' | 'sheet' | 'slide' | 'markdown' | 'html' | 'pdf'
 */
/** folders the user added to the home tree beside the default save folder */
function extraFolderRoots(): string[] {
  return readExtraRoots(readAppSettings(APP_SETTINGS_PATH()), defaultSaveDir())
}

function folderRootPaths(): string[] {
  return [defaultSaveDir(), ...extraFolderRoots()]
}

function insideAnyRoot(path: string): boolean {
  return folderRootPaths().some((root) => isInsideRoot(root, path))
}

function isAnyRoot(path: string): boolean {
  const key = resolve(path)
  return folderRootPaths().some((root) => resolve(root) === key)
}

const pendingNewFileDir = new Map<string, { dir: string; setAt: number }>()
/** folder bound to a freshly created editor tab, keyed by its webContents id; consumed by the first save */
const pendingDirByWc = new Map<number, { dir: string; setAt: number }>()
/** a pending folder only applies to a file created within this window after the click */
const PENDING_DIR_TTL_MS = 30 * 60 * 1000

function rememberPendingDir(kind: string, opts?: NewFileOpts): void {
  const dir = opts?.dir
  if (!dir || resolve(dir) === resolve(defaultSaveDir()) || !insideAnyRoot(dir)) {
    pendingNewFileDir.delete(kind)
    return
  }
  pendingNewFileDir.set(kind, { dir, setAt: Date.now() })
}

/** the folder remembered for this kind, consumed; null when none, expired or gone */
function takePendingDir(kind: string): { dir: string; setAt: number } | null {
  const pending = pendingNewFileDir.get(kind)
  pendingNewFileDir.delete(kind)
  if (!pending) return null
  if (Date.now() - pending.setAt > PENDING_DIR_TTL_MS) return null
  return existsSync(pending.dir) ? pending : null
}

/** where a shell-created blank file (sheet, pdf) lands: the remembered folder, else the root */
function newFileDir(kind: string): string {
  return takePendingDir(kind)?.dir ?? defaultSaveDir()
}

/** hand the remembered folder to the tab that was just opened for it */
function bindPendingDir(kind: string, tabId: string | undefined): void {
  const pending = takePendingDir(kind)
  const wc = tabId ? tabManager?.webContentsForTab(tabId) : undefined
  if (pending && wc) pendingDirByWc.set(wc.id, pending)
}

/**
 * A tab's file first hit disk (silent first save, Save As, or an open): if a
 * folder is bound to that tab and the file is a fresh one in the root, move
 * it there. A pre-existing file opened in the tab never qualifies: its birth
 * time (or, where the filesystem reports none, its mtime) predates the click.
 */
function applyPendingDir(wcId: number, filePath: string): string {
  const pending = pendingDirByWc.get(wcId)
  if (!pending) return filePath
  if (Date.now() - pending.setAt > PENDING_DIR_TTL_MS) {
    pendingDirByWc.delete(wcId)
    return filePath
  }
  if (resolve(dirname(filePath)) !== resolve(defaultSaveDir())) return filePath
  try {
    const stat = statSync(filePath)
    const born = stat.birthtimeMs || stat.mtimeMs
    if (born < pending.setAt - 2000) return filePath
  } catch {
    return filePath
  }
  pendingDirByWc.delete(wcId)
  if (!existsSync(pending.dir)) return filePath
  // a clash with an existing name takes the "(2)" suffix rather than staying in the root
  const target = join(pending.dir, uniqueNameIn(pending.dir, basename(filePath)))
  try {
    renameSync(filePath, target)
  } catch (err) {
    console.warn('[shell] move new file into folder failed:', err)
    return filePath
  }
  afterFileMoved(filePath, target)
  return target
}

/**
 * Everything that keys on a file path follows a rename/move: recents, stars,
 * the AI chat history (project-store), the slides start-screen list and any
 * open tab (which re-grants the new path and refreshes its title).
 */
function afterFileMoved(oldPath: string, newPath: string): void {
  replaceRecentFile(oldPath, newPath)
  projectFileRenamed(oldPath, newPath)
  documentLinkFileMoved(oldPath, newPath)
  if (/\.pptx$/i.test(newPath)) void replaceSlidesRecentFile(oldPath, newPath)
  if (/\.pptx$/i.test(newPath)) moveSlidesTemplateSelection(oldPath, newPath)
  const affected = tabManager?.renameTabFile(oldPath, newPath) ?? []
  const detachedAffected = detachedRenameFile(oldPath, newPath)
  if (detachedAffected) affected.push(detachedAffected)
  for (const t of affected) {
    if (t.kind === 'slides') slidesFileRenamed(t.webContents, oldPath, newPath)
    else if (t.kind === 'docs') docsFileRenamed(t.webContents, oldPath, newPath)
    else if (t.kind === 'sheets') sheetsFileRenamed(t.webContents, oldPath, newPath)
    else if (t.kind === 'markdown') markdownFileRenamed(t.webContents, oldPath, newPath)
    else if (t.kind === 'html') htmlFileRenamed(t.webContents, oldPath, newPath)
    else if (t.kind === 'mindmap') mindmapFileRenamed(t.webContents, oldPath, newPath)
    else if (t.kind === 'hwp') hwpFileRenamed(t.webContents, oldPath, newPath)
    else if (t.kind === 'epub') epubFileRenamed(t.webContents, oldPath, newPath)
    else if (t.kind === 'diagram') diagramFileRenamed(t.webContents, oldPath, newPath)
    else if (t.kind === 'pdf') pdfFileRenamed(t.webContents, oldPath, newPath)
  }
}

function trackedFilesUnder(dir: string): string[] {
  return pathsUnder(dir, [
    ...readRecentFiles(),
    ...readStarredFiles(),
    ...projectFilePaths(),
    ...readSlidesRecentFiles(),
    ...(tabManager?.openFilePaths() ?? []),
    ...detachedFilePaths(),
    ...documentLinkPaths(),
  ])
}

function statMaybeFile(path: string): { isFile: () => boolean } | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function fileTargetSources(): FileTargetSources {
  return {
    insideAnyRoot: (p) => insideAnyRoot(p),
    trackedPaths: [
      ...readRecentFiles(),
      ...readStarredFiles(),
      ...projectFilePaths(),
      ...readSlidesRecentFiles(),
      ...(tabManager?.openFilePaths() ?? []),
      ...detachedFilePaths(),
    ],
  }
}

/** a folder moved/renamed: re-key every tracked file that lived under it */
function afterFolderMoved(oldDir: string, newDir: string, filesBefore: readonly string[]): void {
  for (const file of filesBefore) afterFileMoved(file, rebasePath(file, oldDir, newDir))
}

const folderWatchers = new Map<string, FolderWatcher>()

let fileIndexStore: FileIndexStore | null = null
let fileIndexer: FileIndexer | null = null
let searchReranker: SearchReranker | null = null

function readFileSearchSettings(): FileSearchSettings {
  return normalizeFileSearchSettings(
    openFileSearchKeys(readAppSettings(APP_SETTINGS_PATH()).fileSearch),
  )
}

/** the search index lives in userData and follows the save folder plus recents/starred */
function ensureFileIndexer(): FileIndexer | null {
  if (fileIndexer) return fileIndexer
  try {
    fileIndexStore = new FileIndexStore(join(app.getPath('userData'), 'file-index.db'))
  } catch (e) {
    console.warn('[file-index] unavailable:', e instanceof Error ? e.message : e)
    return null
  }
  fileIndexer = new FileIndexer(fileIndexStore, extractWorkerPath, {
    // the listed project folders join the walk (not the home folder list, spec 5.9)
    roots: () =>
      mergeIndexRoots(
        folderRootPaths().filter((root) => existsSync(root)),
        projectFolderRoots(APP_SETTINGS_PATH()),
      ),
    extraPaths: () => [...readRecentFiles(), ...readStarredFiles()],
    // inside a project folder a file that is not on this PC is indexed by name only (spec 5.8)
    nameOnly: createProjectNameOnly({
      projectRoots: () => projectFolderRoots(APP_SETTINGS_PATH()),
    }),
  })
  return fileIndexer
}

const SEARCH_EXT_FAMILY: Record<string, readonly string[]> = {
  docx: ['docx', 'doc', 'dot', 'odt'],
  xlsx: ['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'ods'],
  pptx: ['pptx', 'ppt', 'odp', 'otp'],
  md: ['md', 'markdown', 'txt', 'json'],
  html: ['html', 'htm'],
  hwp: ['hwp', 'hwpx'],
  xmind: ['xmind', 'mm'],
  drawio: ['drawio', 'dio', 'drawio.svg', 'drawio.png', 'vsdx'],
}

/** one recursive watcher per tree root; follows the save-folder setting and the added folders */
function ensureFolderWatchers(): void {
  const wanted = new Set(folderRootPaths().filter((root) => existsSync(root)))
  for (const [root, watcher] of folderWatchers) {
    if (wanted.has(root) && watcher.active) continue
    watcher.close()
    folderWatchers.delete(root)
  }
  for (const root of wanted) {
    if (folderWatchers.has(root)) continue
    const watcher = new FolderWatcher(root, (dirs) => {
      fileIndexer?.refresh()
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed()) wc.send(HOME_CHANNELS.folderChanged, dirs)
      }
    })
    folderWatchers.set(root, watcher)
  }
}

/**
 * Show the details that go into the survey, copy them, and open the survey in
 * the browser. Everything the app contributes is on screen before anything is
 * copied or opened; the app sends nothing itself.
 */
async function openFeedbackSurvey(): Promise<void> {
  const lang = currentLang()
  const detail = feedbackDetails(lang, {
    version: app.getVersion(),
    os: `${platformLabel(process.platform)} ${release()}`,
    language: lang,
  })
  const options = {
    type: 'info' as const,
    title: feedbackText(lang, 'dialogTitle'),
    message: feedbackText(lang, 'dialogTitle'),
    detail: `${feedbackText(lang, 'dialogBody')}\n\n${detail}`,
    buttons: [feedbackText(lang, 'btnOpen'), feedbackText(lang, 'btnCancel')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }
  const win = shellWindow ?? BrowserWindow.getFocusedWindow()
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  if (response !== 0) return
  clipboard.writeText(detail)
  shell.openExternal(FEEDBACK_SURVEY_URL).catch(() => {
    // no browser handler available; nothing actionable for the user here
  })
}

const FEEDBACK_MENU_ID = 'menu-send-feedback'

/**
 * Put the manual and the feedback entry in whatever menu is currently installed.
 *
 * Every tab kind builds its own application menu, which is how File and Edit
 * stay tab-shaped — and which is also why an item added to one builder is
 * missing from the other six. F1 worked from Home and nowhere else, and the
 * manual's own shortcut table was wrong for six of the seven tab kinds.
 *
 * Injecting after the builder has run is the one place that cannot be
 * forgotten: a new tab kind gets both for free, and a builder that already has
 * them is left alone rather than getting a second copy.
 */
function withHelpItems(): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  const userGuide: MenuItemConstructorOptions = {
    label: tm('menuUserGuide'),
    accelerator: 'F1',
    click: () => tabManager?.openHelpTab(),
  }
  const feedback: MenuItemConstructorOptions = {
    id: FEEDBACK_MENU_ID,
    label: feedbackText(currentLang(), 'menuLabel'),
    click: () => void openFeedbackSurvey(),
  }
  const help = menu.items.find((item) => item.role === 'help')
  // Slides and Sheets build a File/Edit/View template with no Help menu at
  // all, so there is nothing to insert into — one is created instead. Without
  // this the manual would be reachable from four of the seven tab kinds.
  if (!help) {
    menu.append(
      Menu.buildFromTemplate([
        {
          role: 'help',
          label: tm('menuHelp'),
          submenu: [userGuide, { type: 'separator' }, feedback],
        },
      ]).items[0]!,
    )
    return
  }
  const submenu = help.submenu
  if (!submenu) return
  if (submenu.items.some((i) => i.id === FEEDBACK_MENU_ID)) return
  // A separator survives a template only *between* two real items — Electron
  // drops one at either end, so `[userGuide, separator]` builds a single item
  // and the destructure below used to hand `undefined` to `insert`, which threw
  // "Invalid item" and took the main process down on the next tab switch. The
  // trailing entry is filler, discarded; the type check is what stops this from
  // silently regressing if Electron's rule ever changes again.
  const hasUserGuide = submenu.items.some((i) => i.accelerator === 'F1')
  const template: MenuItemConstructorOptions[] = hasUserGuide
    ? [feedback, { type: 'separator' }, { role: 'undo' }]
    : [userGuide, { type: 'separator' }, feedback, { type: 'separator' }, { role: 'undo' }]
  const items = Menu.buildFromTemplate(template).items.filter((i) => i.role !== 'undo')
  items.forEach((item, index) => submenu.insert(index, item))
}

function applyMenuFor(kind: TabKind): void {
  switch (kind) {
    case 'docs':
      buildDocsMenu()
      break
    case 'sheets':
      installSheetsMenu()
      break
    case 'slides':
      installSlidesMenu()
      break
    case 'pdf':
      buildPdfMenu()
      break
    case 'markdown':
      buildMarkdownMenu()
      break
    case 'html':
      buildHtmlMenu()
      break
    case 'mindmap':
      buildMindmapMenu()
      break
    case 'hwp':
      buildHwpMenu()
      break
    case 'epub':
      buildEpubMenu()
      break
    case 'diagram':
      buildDiagramMenu()
      break
    default:
      buildHomeMenu()
  }
  withHelpItems()
  withViewMenu()
}

/**
 * The View › interface-scale items, shared by the home menu and every editor
 * tab. CmdOrCtrl+Alt (not Shift): Shift+= is Sheets insert-cells and Docs
 * superscript, and the View menu now exists on editor tabs too, where those
 * accelerators are taken.
 */
function uiScaleMenuItems(): MenuItemConstructorOptions[] {
  return [
    {
      label: tm('menuUiZoomIn'),
      accelerator: 'CmdOrCtrl+Alt+=',
      click: () => changeUiScale(APP_SETTINGS_PATH(), 1),
    },
    {
      label: tm('menuUiZoomOut'),
      accelerator: 'CmdOrCtrl+Alt+-',
      click: () => changeUiScale(APP_SETTINGS_PATH(), -1),
    },
    { type: 'separator' },
    {
      label: tm('menuUiZoomReset'),
      accelerator: 'CmdOrCtrl+Alt+0',
      click: () => changeUiScale(APP_SETTINGS_PATH(), 0),
    },
  ]
}

function viewMenuTemplate(): MenuItemConstructorOptions {
  return { label: tm('menuView'), submenu: uiScaleMenuItems() }
}

/**
 * Interface-scale items in the View menu of every tab kind. Editor menus are
 * built in the editor apps (docs/sheets/slides) or by the three shell-owned
 * builders, so rather than teaching seven menu builders about the scale, the
 * current menu is post-processed here — the same shape as withHelpItems.
 * An existing View menu (docs, slides: document zoom) gains the items after a
 * separator; the rest get a fresh View menu inserted before the Help menu that
 * withHelpItems has just guaranteed.
 */
function withViewMenu(): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  const hasScale = menu.items.some((item) =>
    item.submenu?.items.some((i) => i.accelerator === 'CmdOrCtrl+Alt+='),
  )
  if (hasScale) return
  const view = menu.items.find((item) => item.label === tm('menuView'))
  if (view?.submenu) {
    // build the separator together with the items: Electron drops a separator
    // that sits alone in a template
    for (const item of Menu.buildFromTemplate([{ type: 'separator' }, ...uiScaleMenuItems()])
      .items) {
      view.submenu.append(item)
    }
    return
  }
  const viewItem = Menu.buildFromTemplate([viewMenuTemplate()]).items[0]!
  const helpIdx = menu.items.findIndex((item) => item.role === 'help')
  if (helpIdx === -1) menu.append(viewItem)
  else menu.insert(helpIdx, viewItem)
}

/// Interface scale (genoffice#1913). Read once at boot, then replaced by the View menu.
let currentUiScale = 1

/**
 * Stamp the stored interface scale into every renderer — now, and for any
 * window created later.
 *
 * `web-contents-created` is the hook that covers all three window kinds at
 * once: the shell window, every tab's WebContentsView, and a detached editor
 * window. Each gets it on `did-finish-load`, because a stylesheet inserted
 * before the document exists is thrown away.
 */
function installUiScale(): void {
  currentUiScale = readUiScale(APP_SETTINGS_PATH())
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-finish-load', () => applyUiScaleTo(contents, currentUiScale))
  })
  applyUiScaleToAll(currentUiScale)
  // A scale change moves the tab strip, so the editor views below it have to
  // move too — and the Windows/Linux caption band is sized from it.
  onUiScaleChanged((scale) => {
    currentUiScale = scale
    tabManager?.layout()
    refreshTitleBarOverlay()
  })
}

/**
 * Ctrl+Tab / Ctrl+Shift+Tab switch tabs; Ctrl+W (⌘W on macOS) closes the active
 * one. `web-contents-created` covers the shell's own strip and every tab's
 * WebContentsView, and the tab check keeps detached windows and the auxiliary
 * windows out of it — those have no tab strip of their own.
 *
 * The editors' menus already register the close chord. Handling it here as
 * well, with preventDefault, keeps one press from closing two tabs; Home falls
 * through to its File > Close, which still closes the window.
 */
function installTabShortcuts(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('before-input-event', (event, input) => {
      const manager = tabManager
      if (!manager) return
      // Ctrl+Tab in a Hangul table cell inserts a tab and Ctrl+Shift+Tab lines the paragraph
      // up at the caret, as Hancom does; elsewhere the shell keeps them for cycling tabs. The
      // editor answers from its own key map.
      if (
        input.type === 'keyDown' &&
        input.key === 'Tab' &&
        input.control &&
        !input.alt &&
        !input.meta &&
        manager.describeWebContents(contents.id)?.kind === 'hwp'
      ) {
        event.preventDefault()
        void editorTakes(contents, input.shift ? 'ctrl-shift-tab' : 'ctrl-tab').then((taken) => {
          if (!taken) manager.cycleTab(input.shift ? -1 : 1)
        })
        return
      }
      const handled = handleTabShortcut(input, contents.id, {
        isShellContents: (id) =>
          !!shellWindow && !shellWindow.isDestroyed() && shellWindow.webContents.id === id,
        hasTab: (id) => !!manager.tabIdForWebContents(id),
        activeKind: () => manager.list().find((tab) => tab.active)?.kind,
        cycle: (direction) => manager.cycleTab(direction),
        closeActive: () => manager.closeActiveTab(),
      })
      if (handled) event.preventDefault()
    })
  })
}

function refreshTitleBarOverlay(): void {
  if (process.platform === 'darwin' || !shellWindow || shellWindow.isDestroyed()) return
  shellWindow.setTitleBarOverlay(tabStripOverlay(nativeTheme.shouldUseDarkColors, currentUiScale))
}

function createShellWindow(): void {
  // Last session's geometry, when a display can still show it (issue #2049).
  // A saved position on an unplugged monitor falls back to the default
  // placement rather than opening where it cannot be grabbed.
  const restored = readShellWindowState(
    APP_SETTINGS_PATH(),
    screen.getAllDisplays().map((display) => display.workArea),
  )
  const win = new BrowserWindow({
    width: restored?.width ?? SHELL_WINDOW_DEFAULT_WIDTH,
    height: restored?.height ?? SHELL_WINDOW_DEFAULT_HEIGHT,
    // x/y only when a saved position survived validation; omitting them keeps
    // Electron's default placement on a first run
    ...(restored ? { x: restored.x, y: restored.y } : {}),
    minWidth: SHELL_WINDOW_MIN_WIDTH,
    minHeight: SHELL_WINDOW_MIN_HEIGHT,
    // shown below, once the stored geometry is applied: the sequence the fix
    // was measured with on Windows, and no visible jump of a few pixels
    show: false,
    title: productName(currentLang()),
    // Paint the theme's surface before the renderer's first frame so the window
    // does not flash white in dark mode. nativeTheme.themeSource is already set
    // from the saved theme in app.whenReady, before this window is created.
    // macOS uses vibrancy below, which must stay transparent.
    ...(process.platform === 'darwin'
      ? {}
      : { backgroundColor: shellWindowBackground(nativeTheme.shouldUseDarkColors) }),
    // vibrancy: editor modules punch translucent regions (e.g. the slides
    // thumbnail pane) through to the desktop
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, vibrancy: 'sidebar' as const }
      : {
          // the tab strip is the title bar, as on macOS; the application menu
          // stays registered for its accelerators and opens from the strip's
          // menu button (Alt still reveals the native bar where one exists)
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: tabStripOverlay(nativeTheme.shouldUseDarkColors, currentUiScale),
          autoHideMenuBar: true,
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // The constructor only gets the window near the right place and onto the
  // right display: on a scaled Windows display it creates the window a few
  // DIPs larger than asked. The stored content rectangle and the maximized
  // flag are applied here, before anything listens to the window's geometry.
  const baseline = applyShellWindowState(win, restored)
  win.show()
  shellWindow = win
  nativeTheme.on('updated', refreshTitleBarOverlay)
  win.once('closed', () => nativeTheme.off('updated', refreshTitleBarOverlay))
  // dragging the window by the tab strip's blank (draggable) area produces no
  // DOM event anywhere — will-move is the only signal to dismiss popovers
  win.on('will-move', () => broadcastChromePressed())
  // remember the window's position and size for the next launch (issue #2049)
  installShellWindowBoundsPersistence(APP_SETTINGS_PATH(), win, { restored, baseline })
  // A detached editor window claims the process-global menu/active-editor targets
  // while focused; take them back when the shell window regains focus. Keyboard
  // focus must land back on the active tab's view too — regaining window focus
  // gives it to the chrome webContents, leaving typing dead in the document.
  win.on('focus', () => {
    tabManager?.refreshActiveTargets()
    tabManager?.focusActiveView()
  })

  const manager = new TabManager(
    win,
    () => {
      win.webContents.send(TABS_CHANNELS.changed, manager.list())
      publishOpenDocumentsIfOwner([...manager.openFilePaths(), ...detachedFilePaths()])
      refreshDocumentLinkMenu()
      pushHwpRecoveryTitles(manager)
      noteLiveSession()
    },
    applyMenuFor,
    // no extension: these tabs have no file on disk yet; the title becomes the
    // real filename (the localized untitled default + .docx etc.) once the first save lands
    (kind) =>
      kind === 'help'
        ? tm('menuUserGuide')
        : kind === 'docs'
          ? tm('untitledDoc')
          : kind === 'slides'
            ? tm('untitledDeck')
            : kind === 'markdown'
              ? tm('untitledMarkdown')
              : kind === 'html'
                ? tm('untitledHtml')
                : kind === 'mindmap'
                  ? tm('untitledMindmap')
                  : kind === 'hwp'
                    ? tm('untitledHwp')
                    : kind === 'diagram'
                      ? tm('untitledDiagram')
                      : tm('untitledSheet'),
    // the tab strip is interface chrome, so its height follows the scale
    () => currentUiScale,
    // every split change: remember it, re-role the pane views, tell the strip
    (state) => handleSplitChanged(win, manager, state),
  )
  tabManager = manager
  manager.setClosedListener((closed) => recentlyClosed.push(closed))

  // Docking: a detached window dragged over this window's tab strip hands its
  // document back. The strip reports the insertion slot for each preview
  // (lastDockIndex); the slot is consumed by the dock that follows.
  setDockHost({
    band: () => dockBandFor(win, currentUiScale),
    preview: (x) => {
      if (!win.isDestroyed())
        win.webContents.send(TABS_CHANNELS.dockPreview, x === null ? null : { x })
    },
    dock: (tab) => {
      const index = lastDockIndex
      lastDockIndex = undefined
      if (!win.isDestroyed()) win.webContents.send(TABS_CHANNELS.dockPreview, null)
      manager.attachTab(tab, index)
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    },
  })

  // pushRecent-triggered docs menu rebuilds must not clobber the active tab's
  // menu; a focused detached docs window owns the menu just like an active tab
  setDocsMenuGate(
    () =>
      focusedDetachedKind() === 'docs' || manager.list().some((t) => t.active && t.kind === 'docs'),
  )

  setDocsShellWindow(win)
  setSheetsShellWindow(win)
  setDocsHostWindowHook((wc) => detachedWindowForWebContents(wc.id))
  setSheetsHostWindowHook((wc) => detachedWindowForWebContents(wc.id))
  // the cross-workbook range picker returns focus to the editing tab
  setSheetsActivateTabHook((wcId) => {
    const tabId = tabManager?.tabIdForWebContents(wcId)
    if (tabId !== undefined) tabManager?.activateTab(tabId)
  })
  setSlidesShellWindow(win)
  setSlidesHostWindowHook((wc) => detachedWindowForWebContents(wc.id))
  setSlidesShowBleed((wc, on) => manager.setContentBleed(wc, on))
  setHtmlPresentHooks({
    setBleed: (wc, on) => manager.setContentBleed(wc, on),
    hostWindow: (wc) => detachedWindowForWebContents(wc.id) ?? win,
    openTab: (owner, title) => {
      manager.openHtmlPresentTab(owner, title)
      return true
    },
    closeTab: (wc) => {
      const id = manager.tabIdForWebContents(wc.id)
      if (id) void manager.closeTab(id)
      return !!id
    },
  })
  // A detached docs/sheets window can outlive the shell window; its hooks must
  // then reach the live tab manager (recreating the shell), never this closure's.
  setDocsShellHooks({
    openTab: (openPath, options) => ensureTabManager().openDocsTab(openPath, options),
    openAiDocTab: (content) =>
      ensureTabManager().openDocsTab(undefined, { newBlank: true, aiContent: content }),
    // the AI's new Word document follows the project of the panel that asked (spec 6)
    openAiDocTabFor: (content, owner) => {
      const manager = ensureTabManager()
      const tabId = manager.openDocsTab(undefined, { newBlank: true, aiContent: content })
      const contents = manager.webContentsForTab(tabId)
      if (contents) followOpenerProject(contents, { kind: 'window', webContentsId: owner })
    },
    newDocumentDir: (id) => newDocumentFolderFor(id),
    writeNewDocument: (id, fileName, bytes) => writeProjectNewDocument(id, fileName, bytes),
    listTabs: () =>
      (tabManager?.list() ?? [])
        .filter((t) => t.kind === 'docs')
        .map((t) => ({ id: t.id, title: t.title, focused: t.active })),
    focusTab: (id) => tabManager?.activateTab(id),
    // ⌘W in a detached docs window closes that window (its own close guard runs)
    closeActiveTab: () => {
      const focused = BrowserWindow.getFocusedWindow()
      if (focused && focused !== win) focused.close()
      else tabManager?.closeActiveTab()
    },
    openGeneratedPath: (path) => openGeneratedDocument(path),
  })
  setSheetsCloseTabHook(() => {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && focused !== win) focused.close()
    else tabManager?.closeActiveTab()
  })
  // ⌘W targets the focused window: in a detached slides editor window it closes
  // that window (running its own close guard), not the shell's active tab
  setSlidesCloseTabHook(() => {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && focused !== win) focused.close()
    else manager.closeActiveTab()
  })
  // When ⌘O opens a file inside a tab, sync the tab title/path (used for de-dup by path) and record it as recent.
  // The first save / save-as fires this too, so applyPendingDir also runs here.
  setSheetsWorkbookOpenedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    detachedSetFileFor(wc.id, path)
    recordRecentFile(path)
  })
  setSlidesOpenedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    detachedSetFileFor(wc.id, path)
    recordRecentFile(path)
    noteDocumentSaved(wc, path, { mayBeOpen: true })
    applyPendingDir(wc.id, path)
  })
  // Encrypted workbooks and decks ask for their open password in the same
  // window the PDF conversions use, with document copy instead of PDF copy.
  const documentPasswordPrompt = (parent: BrowserWindow | undefined, fileName: string) =>
    createDocumentPasswordPrompt(
      {
        prompt: (name, retry) =>
          promptPdfPassword(parent && !parent.isDestroyed() ? parent : win, {
            fileName: name,
            retry,
            busy: false,
            lang: currentLang(),
            strings: {
              title: tm('pdfPwdTitle'),
              prompt: tm('docPwdPrompt'),
              retryPrompt: tm('pdfPwdRetryPrompt'),
              ok: tm('pdfPwdOk'),
              cancel: tm('btnCancel'),
              verifying: tm('pdfPwdVerifying'),
              label: tm('pdfPwdLabel'),
              placeholder: tm('pdfPwdPlaceholder'),
              show: tm('pdfPwdShow'),
              hide: tm('pdfPwdHide'),
            },
          }),
        close: closePdfPasswordDialog,
      },
      fileName,
    )
  setSheetsPasswordPrompt(documentPasswordPrompt)
  setSlidesPasswordPrompt(documentPasswordPrompt)
  // docs' save-as / silent first save lands on a new path → sync the tab title too
  setDocsFileSavedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    detachedSetFileFor(wc.id, path)
    recordRecentFile(path)
    return applyPendingDir(wc.id, path)
  })
  // ⌘O / open-path inside a docs tab: sync the tab title immediately, same
  // contract as the sheets/slides opened hooks (a plain save to the original
  // path never renames the tab, so the open must — r115)
  setDocsFileOpenedHook((wcId, path) => {
    manager.setTabFileFor(wcId, path)
    detachedSetFileFor(wcId, path)
    recordRecentFile(path)
    applyPendingDir(wcId, path)
  })
  // markdown untitled first save / Save As lands on a new path
  setMarkdownFileSavedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    detachedSetFileFor(wc.id, path)
    recordRecentFile(path)
    noteDocumentSaved(wc, path)
    applyPendingDir(wc.id, path)
  })
  setHtmlFileSavedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    detachedSetFileFor(wc.id, path)
    recordRecentFile(path)
    noteDocumentSaved(wc, path)
    applyPendingDir(wc.id, path)
  })
  // mind map untitled first save / Save As lands on a new path
  setMindmapFileSavedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    detachedSetFileFor(wc.id, path)
    recordRecentFile(path)
    noteDocumentSaved(wc, path)
    applyPendingDir(wc.id, path)
  })
  // the mind map's toolbar button "make another document from this one"
  setMindmapMakeFromDocumentHook((wc) => makeFromDocument(wc))
  // hwp Save As lands on a new path
  setHwpFileSavedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    detachedSetFileFor(wc.id, path)
    recordRecentFile(path)
    applyPendingDir(wc.id, path)
  })
  // a book's Save As lands on a new path
  setEpubFileSavedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    detachedSetFileFor(wc.id, path)
    recordRecentFile(path)
  })
  // a diagram's first save / Save As lands on a new path (an imported Visio
  // drawing's first save gives the untitled tab its file)
  setDiagramFileSavedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    detachedSetFileFor(wc.id, path)
    recordRecentFile(path)
    applyPendingDir(wc.id, path)
  })
  // draw.io's Help opens the app's own manual at the diagram topic
  setDiagramHelpHook(() => {
    revealShellWindow()
    tabManager?.openHelpTab('diagram')
  })
  // a tab whose file did not open after all (a Visio drawing draw.io could not
  // import): the tab goes and the reason shows as an app warning (spec 3.5)
  setDiagramOpenFailedHook((wc, message) => {
    const tabId = manager.tabIdForWebContents(wc.id)
    const detachedId = tabId === undefined ? detachedDocumentFor(wc.id)?.id : undefined
    if (tabId === undefined && detachedId === undefined) return false
    // after the answer reaches the editor: closing the tab ends its page
    setImmediate(() => {
      if (tabId !== undefined) manager.closeTabWithoutPrompt(tabId)
      else if (detachedId !== undefined) closeDetachedWithoutPrompt(detachedId)
      showAppWarning(message)
    })
    return true
  })
  setHtmlProvisionalTitleHook((wc, title) => {
    manager.setTabTitleFor(wc.id, title)
    detachedSetTitleFor(wc.id, title)
  })
  setMindmapProvisionalTitleHook((wc, title) => {
    manager.setTabTitleFor(wc.id, title)
    detachedSetTitleFor(wc.id, title)
  })
  setDiagramProvisionalTitleHook((wc, title) => {
    manager.setTabTitleFor(wc.id, title)
    detachedSetTitleFor(wc.id, title)
  })
  // A redacted copy becomes this tab's document; the source still exists.
  setPdfRedactionSavedHook((wc, path) => {
    manager.setTabFileFor(wc.id, path)
    detachedSetFileFor(wc.id, path)
    recordRecentFile(path)
    applyPendingDir(wc.id, path)
  })
  // pdf content-derived auto-rename: the file moved on disk, follow it everywhere
  setPdfRenamedHook((wc, oldPath, newPath) => {
    manager.setTabFileFor(wc.id, newPath)
    detachedSetFileFor(wc.id, newPath)
    replaceRecentFile(oldPath, newPath)
    projectFileRenamed(oldPath, newPath)
    documentLinkFileMoved(oldPath, newPath)
  })
  // markdown "convert & open in Docs" → route the fresh .docx to a docs tab
  setMarkdownDocxExportedHook((path) => {
    openDocumentPath(path)
  })
  // Word export to a path already open in a docs tab: close that tab before the file is
  // written (its unsaved-changes prompt applies, and a later save of the stale document
  // could otherwise overwrite the export); a cancelled close aborts the export.
  setHtmlDocxExportPrepareHook(async (path) => {
    const stale = manager.findDocsTabByPath(path)
    if (!stale) return true
    const active = manager.list().find((t) => t.active)?.id
    await manager.closeTab(stale)
    if (active && active !== stale) manager.activateTab(active)
    return !manager.findDocsTabByPath(path)
  })
  setHtmlDocxExportedHook((path) => {
    openDocumentPath(path)
  })

  // Closing the whole window walks every dirty sheets/pdf/slides/docs tab through
  // the same save/don't-save/cancel prompt; any cancel aborts the close. An
  // all-clean close is left untouched, so ⌘Q keeps quitting the app.
  installShellCloseGuard(win, manager, {
    // the quit is off: saves and clean closes may delete recovery copies again
    onVetoed: () => {
      appQuitting = false
      resetAppShuttingDown()
      // a "Restart & Install" that met a cancelled prompt is off as well
      cancelUpdateRestart()
      // tabs that answered "Don't Save" before another tab cancelled stay open
      // with their edits, so their recovery copies resume now (the PDF editor
      // also keeps a flag of its own)
      resumeDiscardedCopies()
      for (const tab of manager.dirtyPdfTabs()) pdfCloseCancelled(tab.webContents)
    },
  })

  // Windows ends the session (shutdown, restart, sign-out): copies, no prompts
  win.on('query-session-end', () => void endForOsSession())
  win.on('session-end', () => void endForOsSession())

  win.on('closed', () => {
    if (shellWindow === win) shellWindow = null
    if (tabManager === manager) {
      tabManager = null
      setDockHost(null)
      publishAllOpenDocuments()
      // the window closed into the tray: a later power loss must not bring
      // back the tabs the user just closed (spec 4)
      if (!appQuitting && shouldKeepQuickLookInTray()) markSessionClosedToTray()
      // macOS keeps running with no window: no tab is open any more (elsewhere
      // the quit follows, and its record keeps the strip for undecided copies)
      else if (!appQuitting && process.platform === 'darwin') noteLiveSession()
    }
    // the split bookkeeping follows this manager; a rebuilt window restarts
    // tab ids, so a stale shape must not leak into the next one
    lastSplitState = null
    if (splitMemoryTimer) {
      clearTimeout(splitMemoryTimer)
      splitMemoryTimer = null
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---- routing: one dispatch function for every open path ----

/**
 * Single source of truth for the open-dialog filter. The legacy .doc/.dot and
 * .ppt binaries route into the docs and slides import filters (each opens as a
 * converted .docx/.pptx copy).
 */
const OPEN_DIALOG_EXTENSIONS = [
  'docx',
  'doc',
  'dot',
  'odt',
  'xlsx',
  'xlsm',
  'xls',
  'csv',
  'tsv',
  'ods',
  'pptx',
  'ppt',
  'odp',
  'otp',
  'pdf',
  'md',
  'markdown',
  'txt',
  'json',
  'html',
  'htm',
  'xmind',
  'mm',
  'hwp',
  'hwpx',
  'epub',
  'drawio',
  'dio',
  // a draw.io picture by its double extension (a plain picture is no document)
  'drawio.svg',
  'drawio.png',
  'vsdx',
]

function notifyUnsupportedFile(filePath: string): void {
  const ext = extname(filePath).slice(1).toLowerCase() || basename(filePath)
  showAppWarning(tm('errUnsupportedExt', { ext }))
}

/** shell-hosted warning box; focused when a shell window exists, standalone otherwise */
function showAppWarning(message: string, detail?: string): void {
  const options = { type: 'warning' as const, message, ...(detail ? { detail } : {}) }
  if (shellWindow) {
    shellWindow.show()
    shellWindow.focus()
    void dialog.showMessageBox(shellWindow, options)
  } else {
    void dialog.showMessageBox(options)
  }
}

/**
 * Files dropped from the OS into any renderer arrive via installDropOpenBridge
 * and route through the normal File > Open pipeline; detached editor windows
 * can host the drop target, so the shell must reveal itself after opening.
 * A skill file (a SKILL.md, a skill zip) goes to Settings ▸ Skills' preview,
 * and a zip that holds no skill to the same page's "no skill found" notice.
 */
const droppedFilesDeps = (): DroppedFilesDeps => ({
  openDocumentPath,
  revealShellWindow,
  showWarning: showAppWarning,
  unsupportedMessage: (exts: string[]) => tm('errUnsupportedExt', { ext: exts.join(', ') }),
  skillSourceOf: (path) => droppedSkillSourceOf(path, homedir()),
  importSkills: (source) => {
    userSkillsIpc.queueDropped(source)
    openSkillsSettings()
  },
  noSkillsFound: () => {
    userSkillsIpc.queueDropped({ kind: 'no-skills' })
    openSkillsSettings()
  },
})

function registerDroppedFilesIpc(): void {
  ipcMain.on(DROP_OPEN_CHANNEL, (_event, raw: unknown) => {
    void handleDroppedFiles(raw, droppedFilesDeps())
  })
}

/** the single router: extension decides which module owns the file; false = nothing opened */
function openDocumentPath(filePath: string): boolean {
  // a copy of a Drive file (from Recent, say) reopens through Drive, so a copy
  // older than the file in Drive is refreshed first unless it holds unsent edits
  const viaDrive = driveService?.reopen(filePath)
  if (viaDrive) {
    void viaDrive.catch(() => routeDocumentPath(filePath))
    return true
  }
  const opened = routeDocumentPath(filePath)
  return opened
}

/**
 * Open a just-written export. Unlike File > Open, an already-open PDF tab is
 * reloaded from disk so a re-export to the same path shows the new bytes
 * instead of the previous in-memory document (which may also hold unsaved
 * annotations). In-memory edits on that tab are discarded — Save would
 * overwrite the file we just exported.
 */
function openGeneratedDocument(filePath: string): boolean {
  if (tabManager && PDF_RE.test(filePath)) {
    const existing = tabManager.findPdfTabByPath(filePath)
    if (existing) {
      tabManager.reloadTab(existing)
      tabManager.activateTab(existing)
      return true
    }
  }
  return openDocumentPath(filePath)
}

function routeDocumentPath(filePath: string): boolean {
  if (!existsSync(filePath)) return false
  // a detached editor window already shows this file — focus it, never a second copy
  if (focusDetachedByPath(filePath)) return true
  if (!tabManager) return false
  if (DOCX_RE.test(filePath) || ODT_RE.test(filePath) || WORD97_RE.test(filePath)) {
    recordRecentFile(filePath)
    const existing = tabManager.findDocsTabByPath(filePath)
    if (existing) tabManager.activateTab(existing)
    else tabManager.openDocsTab(filePath)
    return true
  }
  if (XLSX_RE.test(filePath)) {
    recordRecentFile(filePath)
    const existing = tabManager.findSheetsTabByPath(filePath)
    if (existing) {
      tabManager.activateTab(existing)
    } else {
      tabManager.openSheetsTab(filePath)
      startQueuedWorkbookNudge()
    }
    return true
  }
  if (PPTX_RE.test(filePath)) {
    recordRecentFile(filePath)
    const existing = tabManager.findSlidesTabByPath(filePath)
    if (existing) {
      tabManager.activateTab(existing)
    } else {
      // For a new tab the path goes through the pending queue; the renderer consumes it after mounting
      tabManager.openSlidesTab(filePath)
    }
    return true
  }
  if (PDF_RE.test(filePath)) {
    recordRecentFile(filePath)
    const existing = tabManager.findPdfTabByPath(filePath)
    if (existing) tabManager.activateTab(existing)
    else tabManager.openPdfTab(filePath)
    return true
  }
  if (TEXT_RE.test(filePath)) {
    recordRecentFile(filePath)
    const existing = tabManager.findMarkdownTabByPath(filePath)
    if (existing) tabManager.activateTab(existing)
    else tabManager.openMarkdownTab(filePath)
    return true
  }
  if (HTML_RE.test(filePath)) {
    recordRecentFile(filePath)
    const existing = tabManager.findHtmlTabByPath(filePath)
    if (existing) tabManager.activateTab(existing)
    else tabManager.openHtmlTab(filePath)
    return true
  }
  if (MINDMAP_RE.test(filePath)) {
    recordRecentFile(filePath)
    const existing = tabManager.findMindmapTabByPath(filePath)
    if (existing) tabManager.activateTab(existing)
    else tabManager.openMindmapTab(filePath)
    return true
  }
  if (HWP_RE.test(filePath)) {
    recordRecentFile(filePath)
    const existing = tabManager.findHwpTabByPath(filePath)
    if (existing) tabManager.activateTab(existing)
    else tabManager.openHwpTab(filePath)
    return true
  }
  if (EPUB_RE.test(filePath)) {
    recordRecentFile(filePath)
    const existing = tabManager.findEpubTabByPath(filePath)
    if (existing) tabManager.activateTab(existing)
    else tabManager.openEpubTab(filePath)
    return true
  }
  // a Visio drawing opens as a new diagram made from it; opening it again
  // comes back to that tab (findDiagramTabByPath asks the editor). A file that
  // does not open gets no tab, only the reason (spec 3.1, 3.5).
  if (DIAGRAM_RE.test(filePath)) {
    const existing = tabManager.findDiagramTabByPath(filePath)
    if (existing) {
      recordRecentFile(filePath)
      tabManager.activateTab(existing)
      return true
    }
    return openDiagramChecked(filePath, {
      refusal: (path) => diagramOpenRefusal(path, { hasRecoveryCopy: diagramHasRecoveryCopy }),
      visioRefusal: (path) => visioOpenRefusal(path),
      open: (path) => {
        if (!tabManager) return
        // the check of a .vsdx took a moment: the same file may have a tab by now
        const opened = tabManager.findDiagramTabByPath(path)
        recordRecentFile(path)
        if (opened) tabManager.activateTab(opened)
        else tabManager.openDiagramTab(path)
      },
      warn: (message, path) => showAppWarning(message, basename(path)),
    })
  }
  notifyUnsupportedFile(filePath)
  return false
}

/**
 * "New spreadsheet" no longer drops a file in the default folder up front: the
 * blank workbook is created in a temp directory and its first Save goes through
 * Save As (the same path an .xls/.tsv import takes), so a new tab that is
 * closed without saving leaves nothing behind to delete by hand — the temp
 * directory is discarded with the session. The save pipeline still needs a real
 * file to edit, hence the backing workbook rather than the in-memory blank grid.
 * Falls back to a file in the default folder, then to the in-memory blank tab.
 */
async function newSheetTab(recoverAs?: string): Promise<void> {
  // recoverAs: the would-be path of a new workbook whose recovery copy
  // survived a crash; the sheets module offers it under that name
  const dir = newFileDir('sheet')
  let suggestedPath = recoverAs ?? uniquePathIn(dir, `${tm('untitledSheet')}.xlsx`)
  // nothing is on disk yet, so two new tabs would otherwise be promised the same name
  for (let i = 2; !recoverAs && sheetsSuggestedPathTaken(suggestedPath); i++)
    suggestedPath = uniquePathIn(dir, `${tm('untitledSheet')} ${i}.xlsx`)
  try {
    // under the import root so the session-close cleanup removes it like an import copy
    const tempDir = join(app.getPath('temp'), 'seuoffice-imports', randomUUID())
    mkdirSync(tempDir, { recursive: true })
    const backingPath = join(tempDir, basename(suggestedPath))
    // reserve the name before the first await so a second new tab picks another;
    // the first Save As starts from the name the file would have had
    markSheetsUnsavedNew(backingPath, suggestedPath, tempDir)
    try {
      await atomicWriteFile(backingPath, await blankXlsxBuffer())
    } catch (err) {
      unmarkSheetsUnsavedNew(backingPath)
      throw err
    }
    // eligible for content-derived auto-rename after the first AI generation
    markSheetsUntitledPath(backingPath)
    tabManager?.openSheetsTab(backingPath)
    startQueuedWorkbookNudge()
    // no recent-file entry yet: there is no user-visible file until it is saved
  } catch (err) {
    console.warn('[shell] temp workbook create failed, writing to the default folder:', err)
    try {
      await atomicWriteFile(suggestedPath, await blankXlsxBuffer())
      markSheetsUntitledPath(suggestedPath)
      routeDocumentPath(suggestedPath)
    } catch (fallbackErr) {
      console.warn(
        '[shell] blank workbook create failed, opening in-memory blank tab:',
        fallbackErr,
      )
      try {
        tabManager?.openSheetsTab(undefined, { newBlank: true })
      } catch (finalErr) {
        surfaceNewTabError(finalErr)
      }
    }
  }
}

/**
 * A throw anywhere in the create-tab path (view creation, sidecar resolution,
 * renderer load) used to be swallowed by `void`-ed promises and ipc-invoke
 * rejections, so the click looked like a pure no-op — the exact "AI Sheets /
 * AI Slides do nothing" alpha report. Surface the failure instead.
 */
function surfaceNewTabError(err: unknown): void {
  console.error('[shell] new tab failed:', err)
  showErrorDialog(shellWindow, tm('errNewTabFailed'), err)
}

function newDocTab(): void {
  try {
    bindPendingDir('doc', tabManager?.openDocsTab(undefined, { newBlank: true }))
  } catch (err) {
    surfaceNewTabError(err)
  }
}

/** MCP: open a blank docs tab and return its webContents id, for the visible-editor bridge */
function openBlankDocsTabForMcp(): number {
  if (!tabManager) throw new Error('SeuOffice is not ready')
  const tabId = tabManager.openDocsTab(undefined, { newBlank: true })
  const view = tabManager.docsTabs().find((t) => t.id === tabId)
  if (!view) throw new Error('the new document tab could not be opened')
  return view.webContents.id
}

/**
 * MCP: open a blank sheets tab and return its webContents id, for the
 * visible-grid bridge. Like the app's own "new spreadsheet", a real blank
 * .xlsx is created up front (the save pipeline needs an on-disk workbook;
 * the fallback in-memory demo grid cannot save) — but the AI auto-rename
 * marking is skipped, the file name is the agent's business.
 */
async function openBlankSheetsTabForMcp(): Promise<number> {
  if (!tabManager) throw new Error('SeuOffice is not ready')
  const filePath = uniquePathIn(defaultSaveDir(), `${tm('untitledSheet')}.xlsx`)
  await atomicWriteFile(filePath, await blankXlsxBuffer())
  const tabId = tabManager.openSheetsTab(filePath)
  const view = tabManager.sheetsTabs().find((t) => t.id === tabId)
  if (!view) {
    // the tab never appeared, so nothing will ever consume this file
    try {
      rmSync(filePath)
    } catch (error) {
      console.warn('[mcp] could not remove the unused blank workbook:', error)
    }
    throw new Error('the new spreadsheet tab could not be opened')
  }
  const wcId = view.webContents.id
  mcpBlankSheetPaths.set(wcId, filePath)
  view.webContents.once('destroyed', () => mcpBlankSheetPaths.delete(wcId))
  // Same nudge the interactive path uses: the renderer subscribes to the open
  // action only after Univer mounts, so a single push can land in the void on a
  // cold start and leave the tab sitting on a blank in-memory workbook.
  startQueuedWorkbookNudge()
  return view.webContents.id
}

/** backing files of blank sheets tabs created by the MCP session tools */
const mcpBlankSheetPaths = new Map<number, string>()

/**
 * MCP: drop a blank sheets tab whose session never became ready, and delete the
 * empty workbook created for it. Without this a failed `create_session` leaves
 * an orphan tab plus an .xlsx in the default save folder that the user never
 * asked for — and nothing in the MCP surface can clean either one up.
 */
function abandonBlankSheetsTabForMcp(wcId: number): void {
  const manager = tabManager
  const filePath = mcpBlankSheetPaths.get(wcId)
  mcpBlankSheetPaths.delete(wcId)
  if (!manager) return
  // the grid may already be usable while the MCP bridge is not: keep anything the user typed
  if (manager.dirtySheetsTabs().some((t) => t.webContents.id === wcId)) return
  if (!abandonBlankTabForMcp(manager.sheetsTabs(), wcId)) return
  if (!filePath) return
  try {
    if (existsSync(filePath)) rmSync(filePath)
  } catch (error) {
    console.warn('[mcp] could not remove the unused blank workbook:', error)
  }
}

/**
 * MCP: close a tab whose session never became ready. Returns false when the
 * tab could not be closed (it is already gone, or the close failed).
 */
function abandonBlankTabForMcp(
  tabs: Array<{ id: string; webContents: WebContents }>,
  wcId: number,
): boolean {
  const tab = tabs.find((t) => t.webContents.id === wcId)
  if (!tab || !tabManager) return false
  try {
    return tabManager.closeTabWithoutPrompt(tab.id)
  } catch (error) {
    console.warn('[mcp] could not close the unused tab:', error)
    return false
  }
}

/** MCP: open a blank slides tab and return its webContents id, for the visible-deck bridge */
function openBlankSlidesTabForMcp(): number {
  if (!tabManager) throw new Error('SeuOffice is not ready')
  const tabId = tabManager.openSlidesTab()
  const view = tabManager.slidesTabs().find((t) => t.id === tabId)
  if (!view) throw new Error('the new presentation tab could not be opened')
  return view.webContents.id
}

function newSlideTab(): void {
  try {
    bindPendingDir('slide', tabManager?.openSlidesTab())
  } catch (err) {
    surfaceNewTabError(err)
  }
}

function newMarkdownTab(): void {
  try {
    bindPendingDir('markdown', tabManager?.openMarkdownTab())
  } catch (err) {
    surfaceNewTabError(err)
  }
}

function newHtmlTab(): void {
  try {
    bindPendingDir('html', tabManager?.openHtmlTab())
  } catch (err) {
    surfaceNewTabError(err)
  }
}

function newMindmapTab(): void {
  try {
    bindPendingDir('mindmap', tabManager?.openMindmapTab())
  } catch (err) {
    surfaceNewTabError(err)
  }
}

function newDiagramTab(): void {
  try {
    bindPendingDir('diagram', tabManager?.openDiagramTab())
  } catch (err) {
    surfaceNewTabError(err)
  }
}

function newHwpTab(): void {
  try {
    bindPendingDir('hwp', tabManager?.openHwpTab())
  } catch (err) {
    surfaceNewTabError(err)
  }
}

/**
 * "New PDF" creates a blank single-page .pdf in the default folder up front and
 * opens it as a regular file tab — the PDF module has no in-memory blank mode
 * (openPdfTab requires a path), same pattern as the blank workbook above.
 */
async function newPdfTab(): Promise<void> {
  try {
    const filePath = uniquePathIn(newFileDir('pdf'), `${tm('untitledPdf')}.pdf`)
    await atomicWriteFile(filePath, await blankPdfBuffer())
    // Opt the file into content-derived auto-naming on its first save
    markPdfUntitledPath(filePath)
    routeDocumentPath(filePath)
  } catch (err) {
    surfaceNewTabError(err)
  }
}

/**
 * The sheets renderer subscribes to menu actions only after Univer finishes
 * mounting (seconds on cold start), so a single 'open' can fire into the
 * void. Re-send until the queued workbook is consumed; consumption clears the
 * queue entry main-side (sheets-main), which stops the loop. The nudge only
 * reaches the active tab, so it gates on that tab's own queue entry —
 * background tabs from a multi-select Open pull their path themselves via the
 * renderer's has-queued-workbook poll.
 */
let workbookNudgeTimer: ReturnType<typeof setInterval> | null = null

function startQueuedWorkbookNudge(): void {
  if (workbookNudgeTimer) clearInterval(workbookNudgeTimer)
  const startedAt = Date.now()
  sendSheetsMenuAction('open')
  workbookNudgeTimer = setInterval(() => {
    if (
      !hasActiveQueuedWorkbook() ||
      Date.now() - startedAt > 30_000 ||
      !tabManager?.findSheetsTab()
    ) {
      if (workbookNudgeTimer) clearInterval(workbookNudgeTimer)
      workbookNudgeTimer = null
      return
    }
    sendSheetsMenuAction('open')
  }, 700)
}

// ---- project folders (decision 0088) ----
//
// One project guide, one chat store and one set of project tools for the whole
// app, made on first use (the guide needs the final app data folder). The tools
// hold their own run scopes, so editor runs never evict the home ask's group
// scopes. Every request is judged by the window that sent it (project-ipc.ts).

interface ProjectFolderRuntime {
  guide: ProjectGuide
  chats: ProjectChatStore
  tools: ProjectFolderTools
  scopes: KbRunScopes
}

let projectFolderRuntime: ProjectFolderRuntime | null = null
let projectFolderIpc: ProjectIpcController | null = null
/** webContents whose close and reload the project layer already follows */
const projectTrackedContents = new Set<number>()

/**
 * The "not on this PC" check for lists that are read often (the context file
 * names of every send, the project screen): a verdict is reused for a short
 * while instead of starting the detector each time. Reads never use it.
 */
const projectListCloudOnly = createCachedCloudResolver((paths) => resolveCloudOnly(paths))

/**
 * One project's AI-visible file walk, reused for a few seconds by the context
 * file names, the `@` list and the list tool. An `ignore` edit is a new key;
 * a change to the list or a new document in a folder drops the walks.
 */
const projectFileLister = createCachedFileLister()

function projectFolderServices(): ProjectFolderRuntime {
  if (projectFolderRuntime) return projectFolderRuntime
  const guide = new ProjectGuide({
    settingsPath: APP_SETTINGS_PATH(),
    homeDir: homedir(),
    userData: app.getPath('userData'),
    defaultParentDir: () => defaultSaveDir(),
    language: () => currentLang(),
    contextFiles: createContextFiles({
      resolveCloudOnly: projectListCloudOnly,
      list: projectFileLister,
    }),
  })
  const chats = new ProjectChatStore({ guide, trash: (path) => shell.trashItem(path) })
  const scopes = new KbRunScopes()
  const tools = new ProjectFolderTools({
    guide,
    scopes,
    store: () => {
      ensureFileIndexer()?.refreshIfStale(60_000)
      return fileIndexStore
    },
    // list and search marks may reuse recent verdicts; a read always asks afresh
    listCloudOnly: projectListCloudOnly,
    listFiles: projectFileLister,
    askDownload: (ask) => askProjectDownload(ask),
  })
  projectFolderRuntime = { guide, chats, tools, scopes }
  return projectFolderRuntime
}

// New documents the AI makes go into the panel's project folder (spec 6). The
// placer reads a window's chosen project from the request layer and writes
// through the project guide's write guard only.
const newDocuments = new NewDocumentPlacer({
  guide: {
    projectRoot: (id) => projectFolderServices().guide.projectRoot(id),
    writeNewDocument: (id, target, data) =>
      projectFolderServices().guide.writeNewDocument(id, target, data),
  },
  windowProject: async (id) => (projectFolderIpc ? projectFolderIpc.windowProject(id) : null),
  documentOf: (id) => {
    const win = projectWindowOf(id)
    return win?.kind === 'editor' ? win.docPath : null
  },
})

/** The folder an untitled document's save dialog opens in (spec 6); null: the default folder */
function newDocumentFolderFor(webContentsId: number): Promise<string | null> {
  return newDocuments.saveDialogFolder(webContentsId).catch(() => null)
}

/** A new document the AI made in this window, into its panel's project; null without one */
async function writeProjectNewDocument(
  webContentsId: number,
  fileName: string,
  bytes: Uint8Array,
): Promise<string | null> {
  const written = await newDocuments.writeFor(webContentsId, fileName, bytes)
  // the new file belongs in the next file list right away
  if (written) projectFileLister.invalidate()
  return written
}

/** The home renderer's webContents id, when the shell window is up */
function homeContentsId(): number | null {
  return shellWindow && !shellWindow.isDestroyed() ? shellWindow.webContents.id : null
}

/**
 * A create flow opened `contents` for `opener` (spec 5.2, 6): the new tab's AI
 * panel starts in the opener's project and its new document goes into the
 * opener's folder. Nothing changes when the opener has no project.
 */
function followOpenerProject(
  contents: {
    readonly id: number
    isDestroyed(): boolean
    once(e: 'destroyed', f: () => void): unknown
  },
  opener: NewDocumentOpener | null,
): void {
  if (!opener || contents.isDestroyed()) return
  const id = contents.id
  newDocuments.preset(id, newDocuments.placementOfOpener(opener, homeContentsId()))
  contents.once('destroyed', () => newDocuments.forget(id))
}

/** The window a project dialog belongs to: the detached window of `owner`, else the shell */
function projectDialogParent(owner: number): BrowserWindow | null {
  const parent = detachedWindowForWebContents(owner) ?? shellWindow
  return parent && !parent.isDestroyed() ? parent : null
}

async function projectMessageBox(owner: number, options: MessageBoxOptions): Promise<number> {
  const parent = projectDialogParent(owner)
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  return result.response
}

/** "'<file>' is not on this PC; download it?" over the asking window (spec 5.8) */
async function askProjectDownload(ask: DownloadAsk): Promise<boolean> {
  const response = await projectMessageBox(
    ask.owner,
    downloadPromptOptions(currentLang(), ask.fileName),
  )
  return response === 0
}

const PROJECT_EDITOR_KINDS = new Set<string>(PROJECT_EDITORS.filter((kind) => kind !== 'home'))

/** The AI window behind a webContents: the home renderer, an editor tab, or a detached editor */
function projectWindowOf(id: number): ProjectWindow | null {
  if (shellWindow && !shellWindow.isDestroyed() && shellWindow.webContents.id === id) {
    return { kind: 'home' }
  }
  const doc = tabManager?.describeWebContents(id) ?? detachedDocumentFor(id)
  if (!doc || !PROJECT_EDITOR_KINDS.has(doc.kind)) return null
  return {
    kind: 'editor',
    editor: doc.kind as Exclude<ProjectEditor, 'home'>,
    docPath: doc.filePath ?? null,
  }
}

/** Follows a window's close (forget it) and page loads (its listeners are gone) */
function trackProjectContents(contents: WebContents): void {
  const id = contents.id
  if (projectTrackedContents.has(id) || contents.isDestroyed()) return
  projectTrackedContents.add(id)
  contents.once('destroyed', () => {
    projectTrackedContents.delete(id)
    projectFolderIpc?.forget(id)
  })
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) projectFolderIpc?.reset(id)
  })
}

function registerProjectFolderChannels(): void {
  projectFolderIpc = registerProjectFolderIpc({
    services: projectFolderServices,
    handle: (channel, handler) =>
      ipcMain.handle(channel, (event, args: unknown) => {
        trackProjectContents(event.sender)
        return handler(event.sender.id, args)
      }),
    windowOf: projectWindowOf,
    send: (target, channel, payload) => {
      const contents = webContents.fromId(target)
      if (!contents || contents.isDestroyed()) return false
      contents.send(channel, payload)
      return true
    },
    dialogs: {
      pickFolder: async (owner, purpose) => {
        const options = folderPickerOptions(currentLang(), purpose)
        const parent = projectDialogParent(owner)
        const result = parent
          ? await dialog.showOpenDialog(parent, options)
          : await dialog.showOpenDialog(options)
        return result.canceled ? null : (result.filePaths[0] ?? null)
      },
      confirmUseExisting: async (owner, folderPath) =>
        (await projectMessageBox(owner, useExistingPromptOptions(currentLang(), folderPath))) === 0,
      askTrust: async (owner, prompt) =>
        trustChoiceOf(await projectMessageBox(owner, trustPromptOptions(currentLang(), prompt))),
      waitForReturn: async (owner) => {
        const contents = webContents.fromId(owner)
        return contents ? waitForPageReturn(contents) : false
      },
    },
    legacyChatFor: (docPath) => legacyDocumentChatFor(docPath),
    openFolder: async (path) => {
      await shell.openPath(path)
    },
    openDocument: (path) => {
      if (!openDocumentPath(path)) return null
      const found = tabManager?.findTabByPath(path) ?? findDetachedTabByPath(path)
      if (!found) return null
      trackProjectContents(found.webContents)
      return found.webContents.id
    },
    showHome: () => {
      revealShellWindow()
      tabManager?.openHomeTab()
      const contents = shellWindow?.webContents
      if (!contents || contents.isDestroyed()) return null
      trackProjectContents(contents)
      return contents.id
    },
    // the index walks the listed project folders: follow additions, removals and moves
    projectsChanged: () => {
      projectFileLister.invalidate()
      fileIndexer?.refresh()
    },
    resolveCloudOnly: projectListCloudOnly,
    presetProjectOf: (sender) => newDocuments.presetProjectOf(sender),
  })
  ipcMain.on(PROJECT_FOLDER_LISTEN_CHANNEL, (event, message: unknown) => {
    trackProjectContents(event.sender)
    const { method, listening } = (message && typeof message === 'object' ? message : {}) as {
      method?: unknown
      listening?: unknown
    }
    projectFolderIpc?.listen(event.sender.id, method, listening)
  })
}

// ---- home IPC ----

function statEntries(paths: string[]): Promise<RecentEntry[]> {
  return statPathEntriesAsync(paths, new Set(readStarredFiles()))
}

function registerHomeIpc(): void {
  ipcMain.handle(HOME_CHANNELS.getAppVersion, (): string => app.getVersion())

  ipcMain.handle(HOME_CHANNELS.recents, (_event, query: unknown): Promise<RecentPage> =>
    pageRecentPaths(readRecentFiles(), query, new Set(readStarredFiles())),
  )

  ipcMain.handle(HOME_CHANNELS.searchFiles, (_event, raw: unknown): FileSearchPage => {
    const query = (raw && typeof raw === 'object' ? raw : {}) as Partial<FileSearchQuery>
    const indexer = ensureFileIndexer()
    if (!indexer || !fileIndexStore) {
      return { hits: [], total: 0, index: { indexed: 0, pending: 0, scanning: false } }
    }
    // an open search box is the moment a stale index shows; rescan at most once a minute
    indexer.refreshIfStale(60_000)
    const q = typeof query.q === 'string' ? query.q.trim().slice(0, 200) : ''
    const filter = typeof query.ext === 'string' ? query.ext : ''
    const exts = filter && filter !== 'all' ? (SEARCH_EXT_FAMILY[filter] ?? [filter]) : undefined
    const offset = Number.isFinite(query.offset) ? Math.max(0, Math.floor(query.offset!)) : 0
    const limit = Number.isFinite(query.limit) ? Math.max(0, Math.floor(query.limit!)) : 50
    const starred = new Set(readStarredFiles())
    const result = q ? fileIndexStore.search(q, { exts, offset, limit }) : { hits: [], total: 0 }
    return {
      hits: result.hits.map((h) => ({ ...h, starred: starred.has(h.path) })),
      total: result.total,
      index: indexer.progress(),
    }
  })

  // Knowledge-base channel: the AI-side read access to the reader's starred
  // files (docs wires these into its panel; see knowledge-base.ts). Path
  // arguments are validated against the starred set — a corpus file is the
  // only thing a knowledge tool may read.
  // A home ask narrowed to one starred group (spec 8.8) carries a scope main
  // minted for that run; main resolves the group's members itself on every
  // call (see KbRunScopes). A call without a scope is an unscoped ask.
  // A home ask with a project chosen (spec 5.5) also reads that project folder:
  // the scope then covers the project plus the starred part (all, or one group).
  const kbRunScopes = new KbRunScopes()
  ipcMain.handle('kb:open-scope', async (event, raw: unknown): Promise<string> => {
    const { group, projectId } = parseKbOpenScope(raw)
    if (projectId === null) return kbRunScopes.open(event.sender.id, group, readStarredGroupMap())
    if (!(await projectFolderServices().tools.isAvailable(projectId))) {
      throw new Error(PROJECT_UNAVAILABLE)
    }
    const starred = group === null ? 'all' : { group: group as string }
    return kbRunScopes.openProject(event.sender.id, projectId, starred, readStarredGroupMap())
  })
  ipcMain.handle('kb:close-scope', (event, scope: unknown): void =>
    kbRunScopes.close(event.sender.id, scope),
  )

  ipcMain.handle('kb:list', (event, raw: unknown): unknown => {
    const starred = kbRunScopes.narrow(
      event.sender.id,
      raw,
      readStarredFiles(),
      readStarredGroupMap,
    )
    return listKnowledgeFiles(starred)
  })

  ipcMain.handle('kb:search', async (event, raw: unknown): Promise<unknown> => {
    const query = (raw && typeof raw === 'object' ? raw : {}) as { q?: unknown; limit?: unknown }
    const q = typeof query.q === 'string' ? query.q : ''
    const limitRaw = Number(query.limit)
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.floor(limitRaw)) : 8
    const store = fileIndexStore
    if (!q.trim() || !store) return []
    ensureFileIndexer()?.refreshIfStale(60_000)
    // a file saved since its last scan is still indexed as it was before the
    // save, so only the files the index holds as they are on disk are quoted
    const starred = store.pathsIndexedAsOnDisk(readStarredFiles())
    // a group-scoped ask searches its group only: a further filter on the set above, never a wider one
    const inScope = kbRunScopes.narrow(event.sender.id, raw, starred, readStarredGroupMap)
    // a scope that also holds a project searches that folder's AI-visible files too
    const projectId = kbRunScopes.projectOf(event.sender.id, raw)
    const within = projectId ? await projectFolderServices().tools.visibleTest(projectId) : null
    // a starred file open with unsaved changes is left out: its excerpt would
    // be the text as last saved, before any withholding mark still in the editor
    const hits = await searchSavedKnowledgeWithProject(
      (qq, pool, inside) =>
        store.search(qq, { limit: pool, ...(inside ? { within: inside } : {}) }).hits.map((h) => ({
          path: h.path,
          name: h.name,
          ext: h.ext,
          snippetText: (h.snippet ?? []).map((part) => part.text).join(''),
        })),
      q,
      inScope,
      Math.min(limit, 20),
      within,
      (paths) => store.pathsIndexedAsOnDisk(paths),
    )
    return hits
  })

  ipcMain.handle('kb:read', async (event, raw: unknown): Promise<unknown> => {
    const req = (raw && typeof raw === 'object' ? raw : {}) as {
      path?: unknown
      offset?: unknown
    }
    const path = typeof req.path === 'string' ? req.path : ''
    const offsetRaw = Number(req.offset)
    const offset = Number.isFinite(offsetRaw) ? Math.floor(offsetRaw) : 0
    if (!path) throw new Error(KB_NOT_IN_BASE)
    const owner = event.sender.id
    // the project this run's scope also reads (a scope main does not hold is refused here)
    const projectId = kbRunScopes.projectOf(owner, raw)
    // a starred file reads as before when the scope allows it (a group-scoped ask reads its group only)
    const starredAllowed =
      readStarredFiles().includes(path) &&
      kbRunScopes.narrow(owner, raw, [path], readStarredGroupMap).includes(path)
    // anything else is read only as a file of the run's project: visibility,
    // unsaved changes, size and the "not on this PC" question all apply there
    return readKnowledgeOrProjectPage(
      path,
      offset,
      starredAllowed,
      projectId
        ? (target, at) => projectFolderServices().tools.readPath(owner, projectId, target, at)
        : null,
    )
  })

  ipcMain.handle('kb:create-document', async (event, raw: unknown): Promise<unknown> => {
    const req = parseKbCreateRequest(raw)
    // a project chosen at home: the new document goes to its folder's top (spec 6)
    const placement = await newDocuments.placementFor(event.sender.id)
    return createKnowledgeDocument(
      {
        dir: defaultSaveDir,
        uniquePath: uniquePathIn,
        sanitizeBase: sanitizeFileBase,
        writeText: (path, text) => atomicWriteFile(path, Buffer.from(text, 'utf8')),
        markdownToDocx: async (markdown, out) => {
          await createFileViaCli(bundledCliRunner(), {
            type: 'docx',
            input: { name: 'content.md', content: markdown },
            out,
          })
        },
        recordRecent: recordRecentFile,
        ...(placement
          ? {
              project: {
                write: (fileName: string, bytes: Uint8Array) =>
                  newDocuments.write(placement, fileName, bytes),
                docxBytes: (markdown: string) => markdownDocxBytes(markdown),
              },
            }
          : {}),
      },
      req,
    )
  })

  ipcMain.handle(
    HOME_CHANNELS.rerankSearch,
    async (_event, raw: unknown): Promise<FileSearchRerank | null> => {
      const settings = readFileSearchSettings()
      if (!settings.rerank) return null
      const query = (raw && typeof raw === 'object' ? raw : {}) as { q?: unknown; paths?: unknown }
      const q = typeof query.q === 'string' ? query.q.trim().slice(0, 200) : ''
      const paths = Array.isArray(query.paths)
        ? query.paths.filter((p): p is string => typeof p === 'string').slice(0, 20)
        : []
      if (!q || paths.length < 2 || !ensureFileIndexer() || !fileIndexStore) return null
      // what a project's `ignore` lists stays out of the excerpts sent out (spec 5.9)
      searchReranker ??= new SearchReranker(
        fileIndexStore,
        undefined,
        createRerankIgnoreFilter({ guide: projectFolderServices().guide }),
      )
      // excerpts leave the machine here: only from files indexed as they are on disk
      return searchReranker.rerank(q, fileIndexStore.pathsIndexedAsOnDisk(paths), settings)
    },
  )

  ipcMain.handle(HOME_CHANNELS.getFileSearchSettings, (): FileSearchSettings =>
    readFileSearchSettings(),
  )

  ipcMain.handle(
    HOME_CHANNELS.setFileSearchSettings,
    (_event, patch: unknown): FileSearchSettings => {
      const current = readFileSearchSettings()
      const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<FileSearchSettings>
      const next = normalizeFileSearchSettings({
        ...current,
        ...p,
        keys: { ...current.keys, ...(p.keys ?? {}) },
      })
      writeAppSetting(APP_SETTINGS_PATH(), 'fileSearch', sealFileSearchKeys(next))
      return next
    },
  )

  ipcMain.handle(HOME_CHANNELS.testFileSearchRerank, (_event, input: unknown) =>
    probeDecision(normalizeFileSearchSettings(input)),
  )

  // Starred files sort by mtime, which requires stat-ing them all first; they are hand-picked and few, so this is fine
  ipcMain.handle(HOME_CHANNELS.starred, async (_event, query: unknown): Promise<RecentPage> => {
    const { offset, limit, ext } = normalizeRecentQuery(query)
    // the Starred view's group pills scope the whole query (totals included)
    const raw = (query && typeof query === 'object' ? query : {}) as { group?: unknown }
    const group = typeof raw.group === 'string' && raw.group ? raw.group : undefined
    const groupOf = readStarredGroupMap()
    const paths = readStarredFiles()
    const scoped = group ? paths.filter((p) => groupOf.get(p) === group) : paths
    const all = (await statEntries(scoped))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((entry) => {
        const g = groupOf.get(entry.path)
        return g ? { ...entry, group: g } : entry
      })
    const filtered = ext ? all.filter((entry) => matchesExtFamily(entry.ext, ext)) : all
    return {
      entries: limit === 0 ? [] : filtered.slice(offset, offset + limit),
      total: filtered.length,
      totalAll: all.length,
    }
  })

  ipcMain.handle(HOME_CHANNELS.starredGroups, (): string[] => readStarredGroups())

  ipcMain.handle(HOME_CHANNELS.setStarredGroup, (_event, paths: unknown, group: unknown) => {
    setStarredGroup(stringPaths(paths), typeof group === 'string' && group ? group : null)
  })

  ipcMain.handle(HOME_CHANNELS.statPaths, (_event, paths: unknown): Promise<RecentEntry[]> =>
    statEntries(capStatPaths(stringPaths(paths))),
  )

  ipcMain.handle(HOME_CHANNELS.toggleStar, (_event, path: unknown) => {
    if (typeof path === 'string') toggleStarredFile(path)
  })

  ipcMain.handle(HOME_CHANNELS.openPath, (_event, path: unknown) => {
    if (typeof path !== 'string' || !path || path.length > 4096) return
    openDocumentPath(path)
    fileIndexer?.refresh()
  })

  ipcMain.handle(HOME_CHANNELS.browse, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? shellWindow
    if (!win) return
    const result = await showOpenDialogWithMemory(dialog, win, {
      title: tm('dlgOpenTitle'),
      filters: [
        { name: tm('filterSupported'), extensions: OPEN_DIALOG_EXTENSIONS },
        { name: tm('filterWord'), extensions: ['docx', 'doc', 'dot'] },
        { name: tm('filterOdt'), extensions: ['odt'] },
        { name: tm('filterExcel'), extensions: ['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'ods'] },
        { name: tm('filterPpt'), extensions: ['pptx', 'ppt', 'odp', 'otp'] },
        { name: tm('filterPdf'), extensions: ['pdf'] },
        { name: tm('filterMarkdown'), extensions: ['md', 'markdown', 'txt', 'json'] },
        { name: tm('filterHtml'), extensions: ['html', 'htm'] },
        { name: tm('filterMindmap'), extensions: ['xmind', 'mm'] },
        { name: tm('filterHwp'), extensions: ['hwp', 'hwpx'] },
        { name: tm('filterEpub'), extensions: ['epub'] },
        {
          name: tm('filterDiagram'),
          extensions: ['drawio', 'dio', 'drawio.svg', 'drawio.png', 'vsdx'],
        },
      ],
      properties: ['openFile', 'multiSelections'],
    })
    if (!result.canceled) for (const path of result.filePaths) openDocumentPath(path)
  })

  ipcMain.handle(HOME_CHANNELS.newDoc, (_event, opts?: NewFileOpts) => {
    rememberPendingDir('doc', opts)
    newDocTab()
  })

  ipcMain.handle(HOME_CHANNELS.newSheet, (_event, opts?: NewFileOpts) => {
    rememberPendingDir('sheet', opts)
    void newSheetTab()
  })

  ipcMain.handle(HOME_CHANNELS.newSlide, (_event, opts?: NewFileOpts) => {
    rememberPendingDir('slide', opts)
    newSlideTab()
  })

  ipcMain.handle(HOME_CHANNELS.newMarkdown, (_event, opts?: NewFileOpts) => {
    rememberPendingDir('markdown', opts)
    newMarkdownTab()
  })

  ipcMain.handle(HOME_CHANNELS.newHtml, (_event, opts?: NewFileOpts) => {
    rememberPendingDir('html', opts)
    newHtmlTab()
  })

  ipcMain.handle(HOME_CHANNELS.newMindmap, (_event, opts?: NewFileOpts) => {
    rememberPendingDir('mindmap', opts)
    newMindmapTab()
  })

  ipcMain.handle(HOME_CHANNELS.newDiagram, (_event, opts?: NewFileOpts) => {
    rememberPendingDir('diagram', opts)
    newDiagramTab()
  })

  ipcMain.handle(HOME_CHANNELS.newHwp, (_event, opts?: NewFileOpts) => {
    rememberPendingDir('hwp', opts)
    newHwpTab()
  })

  ipcMain.handle(HOME_CHANNELS.newPdf, (_event, opts?: NewFileOpts) => {
    rememberPendingDir('pdf', opts)
    void newPdfTab()
  })

  ipcMain.handle(HOME_CHANNELS.removeRecent, (_event, paths: unknown) => {
    const list = stringPaths(paths)
    removeRecentFiles(list)
    // an unavailable entry's star must go with it, or the Starred view keeps
    // a dead dimmed row the recents list no longer shows
    removeStarredFiles(list.filter((p) => !existsSync(p)))
  })

  // Bulk unstar from the Starred view: every row there is a favorite, so the
  // selection action is "unstar", not "remove from recents" — removeRecent
  // keeps existing files' stars on purpose, which made the Starred view's
  // bulk removal a no-op for anything still on disk
  ipcMain.handle(HOME_CHANNELS.unstarPaths, (_event, paths: unknown) => {
    removeStarredFiles(stringPaths(paths))
  })

  ipcMain.handle(HOME_CHANNELS.revealPath, (_event, path: unknown) => {
    if (typeof path === 'string' && existsSync(path)) shell.showItemInFolder(path)
  })

  ipcMain.handle(
    HOME_CHANNELS.renameFile,
    (_event, path: unknown, newName: unknown): RenameResult => {
      if (typeof path !== 'string' || typeof newName !== 'string')
        return { ok: false, error: tm('errBadArgs') }
      // Validate the raw name before trimming: trimming first would
      // silently turn "report " into "report" and make the
      // trailing-space gate in isValidRenameName unreachable. Reject
      // with the localized gate instead of renaming to a different
      // name than requested.
      if (!isValidRawRenameName(newName)) return { ok: false, error: tm('errBadName') }
      if (!renameStaysInApp(path, newName.trim()))
        return { ok: false, error: tm('errBadExtension') }
      if (!isUserVisibleFile(path, fileTargetSources()))
        return { ok: false, error: tm('errBadArgs') }
      const name = newName.trim()
      if (!existsSync(path)) return { ok: false, error: tm('errMissing') }
      const target = join(dirname(path), name)
      if (target === path) return { ok: true, path }
      // A case-only rename (Report.pdf -> report.pdf) hits the source itself on
      // case-insensitive filesystems; only a genuinely different file blocks.
      if (existsSync(target) && !isSameFile(path, target)) {
        return { ok: false, error: tm('errExists') }
      }
      try {
        renameSync(path, target)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : tm('errRenameFailed') }
      }
      afterFileMoved(path, target)
      return { ok: true, path: target }
    },
  )

  ipcMain.handle(HOME_CHANNELS.duplicateFile, async (_event, path: unknown) => {
    if (typeof path !== 'string' || !existsSync(path)) return
    if (!isUserVisibleFile(path, fileTargetSources())) return
    await duplicateFile(path)
  })

  ipcMain.handle(HOME_CHANNELS.deleteFiles, async (_event, paths: unknown) => {
    const targets = fileTargetSources()
    // a missing path still passes so the ghost recent/star entry gets cleaned up
    const list = stringPaths(paths).filter(
      (p) => isUserVisibleFile(p, targets) && statMaybeFile(p)?.isFile() !== false,
    )
    for (const p of list) {
      try {
        await shell.trashItem(p)
      } catch {
        // file already gone or trash unavailable; still drop it from the list
      }
    }
    removeRecentFiles(list)
    // the files were deliberately destroyed — stars must not survive as ghosts
    removeStarredFiles(list)
  })

  ipcMain.handle(HOME_CHANNELS.openTrash, () => {
    if (process.platform === 'darwin') {
      void shell.openPath(join(app.getPath('home'), '.Trash'))
    } else if (process.platform === 'win32') {
      spawn('explorer.exe', ['shell:RecycleBin'], { detached: true }).unref()
    } else {
      void shell.openPath(join(app.getPath('home'), '.local', 'share', 'Trash', 'files'))
    }
  })

  ipcMain.handle(HOME_CHANNELS.openHelp, (_event, topic: unknown) => {
    // the tab manager keeps only an id-shaped topic; anything else opens as F1
    tabManager?.openHelpTab(typeof topic === 'string' ? topic : undefined)
  })
  ipcMain.handle(HOME_CHANNELS.getLanguage, (): Lang => currentLang())

  ipcMain.handle(HOME_CHANNELS.setLanguage, (_event, lang: unknown) => {
    if (!isLang(lang) || lang === currentLang()) return
    persistLang(lang)
    // the switcher lives on the home page, so the home menu is the active one
    buildHomeMenu()
    installDockMenu()
    installBackToHomeItems()
    notifyQuickLookLangOrThemeChanged()
    for (const wc of webContents.getAllWebContents()) wc.send('app:language-changed', lang)
  })

  ipcMain.handle(HOME_CHANNELS.getAutoUpdateCheck, () => autoUpdateCheckEnabled())

  ipcMain.handle(HOME_CHANNELS.setAutoUpdateCheck, (_event, on: unknown) => {
    if (typeof on !== 'boolean') return
    writeAppSetting(APP_SETTINGS_PATH(), 'autoUpdateCheck', on)
    cachedAutoUpdateCheck = on
  })

  ipcMain.handle(
    HOME_CHANNELS.onboardingSeen,
    (): boolean => readAppSettings(APP_SETTINGS_PATH()).onboardingSeen === true,
  )

  ipcMain.handle(HOME_CHANNELS.setOnboardingSeen, (): boolean => {
    try {
      writeAppSetting(APP_SETTINGS_PATH(), 'onboardingSeen', true)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(HOME_CHANNELS.getTheme, (): UiTheme => currentTheme())
  // editor tabs ask via the app-wide channel (symmetric with app:get-language)
  ipcMain.handle('app:get-theme', (): UiTheme => currentTheme())

  ipcMain.handle(HOME_CHANNELS.setTheme, (_event, theme: unknown) => {
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') return
    if (theme === currentTheme()) return
    cachedTheme = theme
    writeAppSetting(APP_SETTINGS_PATH(), 'theme', theme)
    nativeTheme.themeSource = theme
    refreshTitleBarOverlay()
    notifyQuickLookLangOrThemeChanged()
    for (const wc of webContents.getAllWebContents()) wc.send('app:theme-changed', theme)
  })

  ipcMain.handle(HOME_CHANNELS.getDocumentTheme, (): DocTheme => currentDocTheme())
  // editor tabs ask via the app-wide channel (symmetric with app:get-theme)
  ipcMain.handle('app:get-document-theme', (): DocTheme => currentDocTheme())

  ipcMain.handle(HOME_CHANNELS.setDocumentTheme, (_event, theme: unknown) => {
    if (theme !== 'light' && theme !== 'dark' && theme !== 'follow') return
    if (theme === currentDocTheme()) return
    cachedDocTheme = theme
    writeAppSetting(APP_SETTINGS_PATH(), 'documentTheme', theme)
    // the native theme is untouched — only the editors' canvas/paper follows this
    for (const wc of webContents.getAllWebContents()) wc.send('app:document-theme-changed', theme)
  })

  // comment / tracked-change author (Word: Options → General → User name);
  // the editor mains resolve the same key via configuredAuthorName
  const authorNameSetting = (): AuthorNameSetting => ({
    value: readAuthorNameSetting(APP_SETTINGS_PATH()),
    fallback: systemAuthorName(),
  })
  ipcMain.handle(HOME_CHANNELS.getAuthorName, (): AuthorNameSetting => authorNameSetting())
  ipcMain.handle('app:get-author-name', (): string => {
    const { value, fallback } = authorNameSetting()
    return value || fallback
  })
  ipcMain.handle(HOME_CHANNELS.setAuthorName, (_event, raw: unknown): AuthorNameSetting => {
    const value = sanitizeAuthorName(raw)
    if (value !== readAuthorNameSetting(APP_SETTINGS_PATH())) {
      writeAppSetting(APP_SETTINGS_PATH(), AUTHOR_NAME_KEY, value)
      const effective = value || systemAuthorName()
      for (const wc of webContents.getAllWebContents())
        wc.send('app:author-name-changed', effective)
    }
    return authorNameSetting()
  })

  ipcMain.handle(HOME_CHANNELS.getLegacyImportPrompt, (): boolean =>
    readLegacyImportPrompt(APP_SETTINGS_PATH()),
  )
  ipcMain.handle(HOME_CHANNELS.setLegacyImportPrompt, (_event, prompt: unknown): boolean => {
    writeLegacyImportPrompt(APP_SETTINGS_PATH(), prompt !== false)
    return readLegacyImportPrompt(APP_SETTINGS_PATH())
  })

  ipcMain.handle(HOME_CHANNELS.getAutoSaveDefault, (): AutoSaveDefault => currentAutoSaveDefault())
  ipcMain.handle('app:get-auto-save-default', (): AutoSaveDefault => currentAutoSaveDefault())

  ipcMain.handle(HOME_CHANNELS.setAutoSaveDefault, (_event, on: unknown) => {
    if (typeof on !== 'boolean') return
    if (on === currentAutoSaveDefault().on) return
    const next: AutoSaveDefault = { on, updatedAt: Date.now() }
    cachedAutoSaveDefault = next
    writeAppSettings(APP_SETTINGS_PATH(), {
      autoSaveDefault: next.on,
      autoSaveDefaultUpdatedAt: next.updatedAt,
    })
    for (const wc of webContents.getAllWebContents()) wc.send('app:auto-save-default-changed', next)
  })

  ipcMain.handle(HOME_CHANNELS.getCsvImportLimit, (): number => currentCsvImportLimitMb())
  ipcMain.handle('app:get-csv-import-limit', (): number => currentCsvImportLimitMb())
  ipcMain.handle(HOME_CHANNELS.setCsvImportLimit, (_event, mb: unknown) => {
    if (typeof mb !== 'number' || !Number.isInteger(mb)) return
    if (!CSV_IMPORT_LIMIT_CHOICES_MB.includes(mb as (typeof CSV_IMPORT_LIMIT_CHOICES_MB)[number])) {
      return
    }
    if (mb === currentCsvImportLimitMb()) return
    writeAppSettings(APP_SETTINGS_PATH(), { csvImportLimitMb: mb })
    setDelimitedImportLimit(mb * 1024 * 1024)
  })
  ipcMain.handle(HOME_CHANNELS.getMcpStatus, () => mcpStatus())

  ipcMain.handle(HOME_CHANNELS.setMcpSettings, async (_event, patch: unknown) => {
    if (!patch || typeof patch !== 'object') return mcpStatus()
    const request = patch as {
      enabled?: unknown
      port?: unknown
      background?: unknown
      logging?: unknown
    }
    const current = currentMcpSettings()
    const enabled = typeof request.enabled === 'boolean' ? request.enabled : current.enabled
    const port =
      typeof request.port === 'number' &&
      Number.isInteger(request.port) &&
      request.port > 0 &&
      request.port < 65536
        ? request.port
        : current.port
    const background =
      typeof request.background === 'boolean' ? request.background : current.background
    const logging = typeof request.logging === 'boolean' ? request.logging : current.logging
    writeAppSettings(APP_SETTINGS_PATH(), {
      mcpEnabled: enabled,
      mcpPort: port,
      mcpBackground: background,
      mcpLogging: logging,
    })
    try {
      return await applyMcpSettings({ enabled, port, background, logging })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ...mcpStatus(), error: message }
    }
  })

  ipcMain.handle(HOME_CHANNELS.getMcpLogs, () => getMcpRecentLogs())

  ipcMain.handle(HOME_CHANNELS.clearMcpLogs, () => {
    clearMcpLogs()
  })

  ipcMain.handle(HOME_CHANNELS.openMcpLogFile, () => {
    revealMcpLogFile()
    const logPath = mcpLogFilePath()
    if (logPath) shell.showItemInFolder(logPath)
  })

  ipcMain.handle(HOME_CHANNELS.getAiPanelPrefs, (): AiPanelPrefs => currentAiPanelPrefs())
  ipcMain.handle('app:get-ai-panel-prefs', (): AiPanelPrefs => currentAiPanelPrefs())

  const setAiPanelPrefs = (patch: unknown): AiPanelPrefs => {
    const prev = currentAiPanelPrefs()
    const raw =
      patch !== null && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}
    // unknown/malformed fields fall back to the previous value, not the default
    const next = normalizeAiPanelPrefs({
      side: raw.side === 'left' || raw.side === 'right' ? raw.side : prev.side,
      fontSize: 'fontSize' in raw ? raw.fontSize : prev.fontSize,
      customFontSize: 'customFontSize' in raw ? raw.customFontSize : prev.customFontSize,
      spellcheck: 'spellcheck' in raw ? raw.spellcheck : prev.spellcheck,
      openInNewDocs: 'openInNewDocs' in raw ? raw.openInNewDocs : prev.openInNewDocs,
      showAiSidebar: 'showAiSidebar' in raw ? raw.showAiSidebar : prev.showAiSidebar,
    })
    if (sameAiPanelPrefs(next, prev)) return prev
    cachedAiPanelPrefs = next
    writeAppSettings(APP_SETTINGS_PATH(), {
      aiPanelSide: next.side,
      aiPanelFontSize: next.fontSize,
      aiPanelCustomFontSize: next.customFontSize,
      aiPanelSpellcheck: next.spellcheck,
      aiPanelOpenInNewDocs: next.openInNewDocs,
      aiPanelShowSidebar: next.showAiSidebar,
    })
    for (const wc of webContents.getAllWebContents()) wc.send('app:ai-panel-prefs-changed', next)
    return next
  }
  ipcMain.handle(HOME_CHANNELS.setAiPanelPrefs, (_event, patch) => setAiPanelPrefs(patch))
  ipcMain.handle('app:set-ai-panel-prefs', (_event, patch) => setAiPanelPrefs(patch))

  // effective folder where new/untitled files land; the editor mains resolve
  // the same setting themselves (configuredDefaultSaveDir via docs' defaultSaveDir)
  // ── folder tree over the default save folder ──
  const folderErrors = (): FolderErrors => ({
    badArgs: tm('errBadArgs'),
    badName: tm('errBadName'),
    missing: tm('errMissing'),
    exists: tm('errExists'),
    failed: tm('errRenameFailed'),
  })
  const insideRoot = (path: unknown): path is string =>
    typeof path === 'string' && insideAnyRoot(path)
  const isRoot = (path: string) => isAnyRoot(path)

  ipcMain.handle(HOME_CHANNELS.folderRoots, (): FolderRoot[] => {
    // describeRoot creates a missing save folder, so its watcher has something to attach to
    const roots = [describeRoot(defaultSaveDir()), ...extraFolderRoots().map(describeExtraRoot)]
    ensureFolderWatchers()
    noticeSaveDirFallback()
    return roots
  })

  // an added folder joins the tree where it is: nothing on disk is created, copied or moved
  const addFolderRoot = (path: string): FolderRoot | null => {
    const extras = withExtraRoot(extraFolderRoots(), defaultSaveDir(), path)
    if (!extras) return null
    writeAppSetting(APP_SETTINGS_PATH(), FOLDER_ROOTS_KEY, extras)
    ensureFolderWatchers()
    fileIndexer?.refresh()
    return describeExtraRoot(path)
  }

  ipcMain.handle(HOME_CHANNELS.addFolderRoot, async (): Promise<FolderRoot | null> => {
    const result = await showOpenDialogWithMemory(dialog, shellWindow, {
      title: tm('dlgAddFolderRoot'),
      properties: ['openDirectory'],
    })
    const picked = result.filePaths[0]
    if (result.canceled || !picked) return null
    if (!describeExtraRoot(picked).readable) {
      showErrorDialog(shellWindow, tm('errFolderRootUnusable'), picked)
      return null
    }
    return addFolderRoot(picked)
  })

  ipcMain.handle(HOME_CHANNELS.dropFolderRoots, (_event, paths: unknown): FolderRoot[] => {
    const added: FolderRoot[] = []
    const files: string[] = []
    for (const path of stringPaths(paths)) {
      if (!describeExtraRoot(path).readable) {
        files.push(path)
        continue
      }
      const root = addFolderRoot(path)
      if (root) added.push(root)
    }
    if (files.length > 0) void handleDroppedFiles(files, droppedFilesDeps())
    return added
  })

  ipcMain.handle(HOME_CHANNELS.removeFolderRoot, (_event, path: unknown) => {
    if (typeof path !== 'string') return
    const extras = withoutExtraRoot(extraFolderRoots(), path)
    writeAppSetting(APP_SETTINGS_PATH(), FOLDER_ROOTS_KEY, extras)
    ensureFolderWatchers()
    fileIndexer?.refresh()
  })

  ipcMain.handle(HOME_CHANNELS.listFolder, (_event, dir: unknown): FolderListing => {
    if (!insideRoot(dir)) return { dir: String(dir), folders: [], files: [] }
    return listFolder(dir, new Set(readStarredFiles()))
  })

  ipcMain.handle(
    HOME_CHANNELS.createFolder,
    (_event, parent: unknown, name: unknown): RenameResult => {
      if (!insideRoot(parent) || typeof name !== 'string')
        return { ok: false, error: tm('errBadArgs') }
      return createFolder(parent, name, folderErrors())
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.renameFolder,
    (_event, dir: unknown, newName: unknown): RenameResult => {
      if (!insideRoot(dir) || isRoot(dir) || typeof newName !== 'string')
        return { ok: false, error: tm('errBadArgs') }
      const filesBefore = trackedFilesUnder(dir)
      const result = renameFolder(dir, newName, folderErrors())
      if (result.ok && result.path && result.path !== dir) {
        afterFolderMoved(dir, result.path, filesBefore)
      }
      return result
    },
  )

  ipcMain.handle(
    HOME_CHANNELS.movePaths,
    async (_event, paths: unknown, targetDir: unknown, policy: unknown): Promise<MoveResult> => {
      const list = stringPaths(paths)
      if (!insideRoot(targetDir)) {
        const error = tm('errBadArgs')
        return { moved: [], conflicts: [], failed: list.map((path) => ({ path, error })) }
      }
      const conflictPolicy: MoveConflictPolicy =
        policy === 'replace' || policy === 'keepBoth' || policy === 'skip' ? policy : 'ask'
      const isDir = (p: string) => {
        try {
          return statSync(p).isDirectory()
        } catch {
          return false
        }
      }
      // files may come from anywhere the UI can show (the Recent list); folders only from inside the tree, never a root itself
      const moveSources = { ...fileTargetSources(), isDirectory: isDir, isAnyRoot }
      const sources = list.filter((p) => isMoveSource(p, moveSources))
      const dirFiles = new Map(sources.filter(isDir).map((p) => [p, trackedFilesUnder(p)]))
      // 'replace' must not destroy data: the displaced target goes to the trash,
      // and everything keyed on its path (recents, stars, chat history) leaves
      // with it so the incoming file does not inherit another document's record
      const displaced: string[] = []
      const result = movePathsInto(sources, targetDir, conflictPolicy, folderErrors(), {
        replaceExisting: (path) => {
          const parked = join(dirname(path), `.seuoffice-replaced-${Date.now()}-${basename(path)}`)
          const files = isDir(path) ? trackedFilesUnder(path) : [path]
          renameSync(path, parked)
          return {
            commit: () => {
              displaced.push(parked)
              removeRecentFiles(files)
              removeStarredFiles(files)
              for (const file of files) projectFileRenamed(file, rebasePath(file, path, parked))
            },
            rollback: () => renameSync(parked, path),
          }
        },
      })
      for (const parked of displaced) {
        try {
          await shell.trashItem(parked)
        } catch {
          rmSync(parked, { recursive: true, force: true })
        }
      }
      for (const { from, to } of result.moved) {
        const files = dirFiles.get(from)
        if (files) afterFolderMoved(from, to, files)
        else afterFileMoved(from, to)
      }
      return result
    },
  )

  ipcMain.handle(HOME_CHANNELS.deleteFolder, async (_event, dir: unknown) => {
    if (!insideRoot(dir) || isRoot(dir)) return
    const files = trackedFilesUnder(dir)
    try {
      await shell.trashItem(dir)
    } catch {
      return
    }
    removeRecentFiles(files)
    removeStarredFiles(files)
  })

  ipcMain.handle(HOME_CHANNELS.getDefaultSaveDir, (): string => defaultSaveDir())

  const defaultApp = createDefaultAppService({
    platform: process.platform,
    packaged: app.isPackaged,
    exePath: app.getPath('exe'),
    registeredAppName: PRODUCT_NAME,
    run: execFileRunner,
    openExternal: (url) => shell.openExternal(url),
  })
  ipcMain.handle(HOME_CHANNELS.getDefaultAppStatus, () => defaultApp.status())
  ipcMain.handle(HOME_CHANNELS.setDefaultApp, () => defaultApp.set())

  ipcMain.handle(HOME_CHANNELS.pickDefaultSaveDir, async (): Promise<string | null> => {
    const result = await showOpenDialogWithMemory(dialog, shellWindow, {
      title: tm('dlgPickSaveDir'),
      defaultPath: defaultSaveDir(),
      properties: ['openDirectory', 'createDirectory'],
    })
    const picked = result.filePaths[0]
    if (result.canceled || !picked) return null
    if (!isUsableSaveDir(picked)) {
      showErrorDialog(shellWindow, tm('errSaveDirUnusable'), picked)
      return null
    }
    writeAppSetting(APP_SETTINGS_PATH(), DEFAULT_SAVE_DIR_KEY, picked)
    ensureFolderWatchers()
    return picked
  })

  ipcMain.handle(HOME_CHANNELS.getHwpDefaultFormat, () => readHwpDefaultFormat(app))

  ipcMain.handle(HOME_KINDS_CHANNELS.get, () => readHomeKinds())

  ipcMain.handle(HOME_KINDS_CHANNELS.set, (_event, raw: unknown) => {
    writeAppSetting(
      APP_SETTINGS_PATH(),
      HOME_KINDS_SETTING_KEY,
      storedHomeKinds(normalizeHomeKinds(raw)),
    )
    const next = readHomeKinds()
    // the setting lives on the home page, so the home menu is the active one
    applyMenuFor('home')
    installDockMenu()
    for (const wc of webContents.getAllWebContents()) wc.send(HOME_KINDS_CHANNELS.changed, next)
    return next
  })

  ipcMain.handle(HOME_CHANNELS.setHwpDefaultFormat, (_event, format: unknown) => {
    const next = normalizeHwpDefaultFormat(format)
    writeAppSetting(APP_SETTINGS_PATH(), HWP_DEFAULT_FORMAT_KEY, next)
    return next
  })

  // the slides editor reads the same key for each generation (apps/slides/src/main/ai-default-fonts.ts)
  ipcMain.handle(HOME_CHANNELS.getSlidesAiFonts, () =>
    normalizeSlidesAiFonts(
      readAppSettings(APP_SETTINGS_PATH())[SLIDES_AI_FONTS_KEY],
      currentDocumentLocale(),
    ),
  )
  ipcMain.handle(HOME_CHANNELS.setSlidesAiFonts, (_event, fonts: unknown) => {
    const next = normalizeSlidesAiFonts(fonts, currentDocumentLocale())
    writeAppSetting(APP_SETTINGS_PATH(), SLIDES_AI_FONTS_KEY, next)
    return next
  })

  ipcMain.handle(HOME_CHANNELS.openGitHubRepo, () => {
    shell.openExternal(GITHUB_REPO_URL).catch(() => {
      // no browser handler available; nothing actionable for the user here
    })
  })

  ipcMain.handle(HOME_CHANNELS.openFeedbackSurvey, () => {
    void openFeedbackSurvey()
  })

  ipcMain.handle(HOME_CHANNELS.openLicenseNotices, () => {
    void openThirdPartyNotices()
  })

  // the page is the vendor's fixed install guide; the renderer only names the provider
  ipcMain.handle(SHELL_SUBSCRIPTION_CHANNELS.openInstallHelp, (_event, provider: unknown) => {
    if (!isSubscriptionProviderId(provider)) return
    // ChatGPT installs nothing: its page is where the user sees and limits the app's use of the plan
    const url = safeExternalUrl(
      provider === 'chatgpt' ? SUBSCRIPTION_CHATGPT_USAGE_URL : SUBSCRIPTION_INSTALL_URLS[provider],
    )
    if (!url) return
    shell.openExternal(url).catch(() => {
      // no browser handler available; nothing actionable for the user here
    })
  })
}

function stringPaths(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : []
}

// electron-vite emits ?asset files under hashed names, which breaks nativeImage's
// automatic `@2x` sibling lookup — attach the retina representation by hand
function loadMenuIcon(path1x: string, path2x: string): NativeImage {
  const icon = nativeImage.createFromPath(path1x)
  icon.addRepresentation({ scaleFactor: 2, buffer: readFileSync(path2x) })
  return icon
}

// loaded once, not on every menu open
interface MenuIconSet {
  docx: NativeImage
  xlsx: NativeImage
  pptx: NativeImage
  pdf: NativeImage
  md: NativeImage
  html: NativeImage
  mindmap: NativeImage
  hwp: NativeImage
  epub: NativeImage
  diagram: NativeImage
  home: NativeImage
}
let menuIconCache: MenuIconSet | null = null
function menuIcons(): MenuIconSet {
  menuIconCache ??= {
    docx: loadMenuIcon(menuDocxIcon1x, menuDocxIcon2x),
    xlsx: loadMenuIcon(menuXlsxIcon1x, menuXlsxIcon2x),
    pptx: loadMenuIcon(menuPptxIcon1x, menuPptxIcon2x),
    pdf: loadMenuIcon(menuPdfIcon1x, menuPdfIcon2x),
    md: loadMenuIcon(menuMdIcon1x, menuMdIcon2x),
    html: loadMenuIcon(menuHtmlIcon1x, menuHtmlIcon2x),
    mindmap: loadMenuIcon(menuMindmapIcon1x, menuMindmapIcon2x),
    hwp: loadMenuIcon(menuHwpIcon1x, menuHwpIcon2x),
    epub: loadMenuIcon(menuEpubIcon1x, menuEpubIcon2x),
    diagram: loadMenuIcon(menuDiagramIcon1x, menuDiagramIcon2x),
    home: loadMenuIcon(menuHomeIcon1x, menuHomeIcon2x),
  }
  return menuIconCache
}

const TAB_MENU_ICON: Record<TabKind, keyof MenuIconSet> = {
  home: 'home',
  docs: 'docx',
  sheets: 'xlsx',
  slides: 'pptx',
  pdf: 'pdf',
  markdown: 'md',
  html: 'html',
  mindmap: 'mindmap',
  hwp: 'hwp',
  epub: 'epub',
  diagram: 'diagram',
  help: 'home',
}

function readHomeKinds(): HomeKindsSettings {
  return normalizeHomeKinds(readAppSettings(APP_SETTINGS_PATH())[HOME_KINDS_SETTING_KEY])
}

/** what each new-document entry is called and opens in the shell's menus */
const NEW_KIND_MENU: Record<
  Exclude<HomeKind, 'pdfTools'>,
  { label: Parameters<typeof tm>[0]; icon: keyof MenuIconSet; open: () => void }
> = {
  docx: { label: 'menuNewDoc', icon: 'docx', open: () => newDocTab() },
  xlsx: { label: 'menuNewSheet', icon: 'xlsx', open: () => void newSheetTab() },
  pptx: { label: 'menuNewSlide', icon: 'pptx', open: () => newSlideTab() },
  md: { label: 'menuNewMarkdown', icon: 'md', open: () => newMarkdownTab() },
  html: { label: 'menuNewHtml', icon: 'html', open: () => newHtmlTab() },
  xmind: { label: 'menuNewMindmap', icon: 'mindmap', open: () => newMindmapTab() },
  drawio: { label: 'menuNewDiagram', icon: 'diagram', open: () => newDiagramTab() },
  hwp: { label: 'menuNewHwp', icon: 'hwp', open: () => newHwpTab() },
  pdf: { label: 'menuNewPdf', icon: 'pdf', open: () => void newPdfTab() },
}

/**
 * The new-document entries in home's order, without the kinds the person hid
 * (Settings → General). `only` keeps a menu to its own shorter list; `section`
 * puts the "New" header above and a separator below, both left out when every
 * kind is hidden; `accelerator` goes on the first entry.
 */
function newDocumentMenuItems(opts: {
  icons?: boolean
  only?: readonly HomeKind[]
  section?: boolean
  accelerator?: string
}): MenuItemConstructorOptions[] {
  const items = visibleHomeKinds(readHomeKinds()).flatMap((kind): MenuItemConstructorOptions[] => {
    if (kind === 'pdfTools' || (opts.only && !opts.only.includes(kind))) return []
    const entry = NEW_KIND_MENU[kind]
    return [
      {
        label: tm(entry.label),
        ...(opts.icons ? { icon: menuIcons()[entry.icon] } : {}),
        click: entry.open,
      },
    ]
  })
  if (items.length > 0 && opts.accelerator) {
    items[0] = { ...items[0], accelerator: opts.accelerator }
  }
  if (!opts.section || items.length === 0) return items
  return [
    // enabled:false so pre-Sonoma macOS / Windows (no 'header' support) degrade
    // to an inert label instead of a clickable no-op item
    { label: tm('menuSectionNew'), type: 'header', enabled: false },
    ...items,
    { type: 'separator' },
  ]
}

// tab views see neither DOM events nor a focus change when the user clicks the
// shell chrome — relay the press so open popovers in documents can dismiss.
// The pressed document must be excluded: it already dismissed (or is opening)
// its own popovers via its local pointerdown listeners, and the async IPC
// round-trip would otherwise close a popover that very press just opened
// (home row menus died this way: pointerdown → broadcast → menu unmounts
// before the click event ever reached the menu item).
function broadcastChromePressed(exclude?: WebContents): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc !== exclude) wc.send('app:chrome-pressed')
  }
}

/** the shell's tab manager, recreating the shell window when a detached editor outlived it */
function ensureTabManager(): TabManager {
  if (!tabManager) createShellWindow()
  if (!tabManager) throw new Error('the shell window could not be created')
  return tabManager
}

/** "Open in New Window": reparent the tab's live view into a detached editor
 *  window — the document moves as-is, unsaved edits included. */
function detachTabToWindow(id: string): void {
  if (!tabManager) return
  const record = tabManager.detachTab(id)
  if (!record) return
  clearPaneRole(record)
  const win = createDetachedEditorWindow({ ...record, applyMenuFor })
  win.focus()
}

/** Tear-off: the tab leaves the strip for a window created under the held
 *  pointer at (x, y); the strip keeps steering it until release. */
function tearOffTabToWindow(id: string, x: number, y: number): boolean {
  if (!tabManager || isTearingOff() || !tabManager.canDetachTab(id)) return false
  const record = tabManager.detachTab(id)
  if (!record) return false
  clearPaneRole(record)
  createDetachedEditorWindow({ ...record, applyMenuFor, tearOffAt: { x, y } })
  return true
}

/**
 * A view leaving the strip (detached window or tear-off) is out of any split:
 * the split-change broadcast no longer reaches it, so its last pane role must
 * be withdrawn here or its AI panel would stay rail-collapsed in a window
 * that has no panes.
 */
function clearPaneRole(record: DetachedTab): void {
  if (!record.view.webContents.isDestroyed()) {
    record.view.webContents.send(SPLIT_PANE_CHANNELS.roleChanged, null)
  }
}

/** insertion slot the shell strip reported for the current dock preview */
let lastDockIndex: number | undefined

// ---- two-pane split wiring (decision 0037) ----

/** What a tab tear-off drag remembers about the split drop zones. Captured
 *  before tearOffTabToWindow: detaching a pane tab drops the split, so this is
 *  the only memory of the arrangement the drag started from. */
interface TornSplitDrag {
  tabId: string
  filePath?: string
  splitAtStart: SplitViewState | null
}

let tornSplitDrag: TornSplitDrag | null = null
/** the intent a release at the current drop zone would apply (null: none) */
let tornSplitDrop: SplitDropIntent | null = null
/** the last hint sent to the strip, so identical frames are not re-sent */
let lastSplitHint: SplitHint | null = null

function sameSplitHint(a: SplitHint | null, b: SplitHint | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height &&
    a.orientation === b.orientation
  )
}

/** push the drop-hint rectangle (or its removal) to the strip webContents */
function sendSplitHint(hint: SplitHint | null): void {
  if (sameSplitHint(hint, lastSplitHint)) return
  lastSplitHint = hint
  if (!shellWindow || shellWindow.isDestroyed()) return
  shellWindow.webContents.send(SPLIT_TABS_CHANNELS.hint, hint)
}

/** The pane whose document is the one a menu or a drag is about: the same tab
 *  id, or a copy of the same canonical file. */
function splitPaneOfDocument(
  manager: TabManager,
  split: Pick<SplitViewState, 'aTabId' | 'bTabId'> | null,
  dragged: { tabId: string; filePath?: string },
): 'a' | 'b' | null {
  if (!split) return null
  const tabs = manager.list()
  const wanted = canonicalPath(dragged.filePath)
  for (const side of ['a', 'b'] as const) {
    const paneId = side === 'a' ? split.aTabId : split.bTabId
    if (paneId === dragged.tabId) return side
    const pane = tabs.find((t) => t.id === paneId)
    if (
      wanted !== undefined &&
      pane?.filePath !== undefined &&
      canonicalPath(pane.filePath) === wanted
    ) {
      return side
    }
  }
  return null
}

/** the split-drop context of a tab tear-off (null: not a document tab) */
function tearOffSplitContext(id: string): TornSplitDrag | null {
  const manager = tabManager
  if (!manager || !manager.canDetachTab(id)) return null
  const tab = manager.list().find((t) => t.id === id)
  if (!tab || tab.kind === 'home' || tab.kind === 'help') return null
  return { tabId: id, filePath: tab.filePath, splitAtStart: manager.splitState() }
}

/**
 * While the pointer is held: decide the zone under it from the drag start's
 * arrangement and push the hint. The pointer arrives in screen coordinates
 * (the strip sends pointer positions); the panes live in the window's content
 * area below the strip.
 */
function updateSplitHint(screenX: number, screenY: number): void {
  const drag = tornSplitDrag
  const manager = tabManager
  if (!drag || !manager || !shellWindow || shellWindow.isDestroyed()) return
  const bounds = shellWindow.getContentBounds()
  const zone = splitDropZone(screenX - bounds.x, screenY - bounds.y, bounds.width, bounds.height)
  if (!zone) {
    tornSplitDrop = null
    sendSplitHint(null)
    return
  }
  // a pane tab's tear-off already dropped the split, so the decision reads the
  // arrangement captured at drag start; a strip tab reads the live one
  const paneAtStart =
    drag.splitAtStart !== null &&
    (drag.splitAtStart.aTabId === drag.tabId || drag.splitAtStart.bTabId === drag.tabId)
  const split = paneAtStart ? drag.splitAtStart : manager.splitState()
  tornSplitDrop = decideSplitDrop({
    split,
    dragged: {
      isDocument: true,
      isPaneTab: paneAtStart,
      docPane: splitPaneOfDocument(manager, split, drag),
    },
    dropped: zone,
  })
  // the hint marks the b-side pane the drop would land in — the same window
  // content coordinates the pane views are laid out in (bounding the space
  // below the strip, like TabManager.contentBounds)
  const rects = paneRects(
    {
      x: 0,
      y: TAB_STRIP_HEIGHT,
      width: bounds.width,
      height: Math.max(0, bounds.height - TAB_STRIP_HEIGHT),
    },
    zone,
    split?.ratio ?? SPLIT_EVEN_RATIO,
  )
  sendSplitHint({
    left: rects.b.x,
    top: rects.b.y,
    width: rects.b.width,
    height: rects.b.height,
    orientation: zone,
  })
}

/**
 * A released tear-off whose last pointer position was over a split edge: take
 * the torn tab back (its window is destroyed), re-attach it without activating
 * and realize the decided intent. False leaves everything to the normal
 * dock / detached-window flow.
 */
function applyTornSplitDrop(): boolean {
  const drag = tornSplitDrag
  const intent = tornSplitDrop
  if (!drag || !intent) {
    tornSplitDrag = null
    tornSplitDrop = null
    sendSplitHint(null)
    return false
  }
  const record = takeTornTab()
  tornSplitDrag = null
  tornSplitDrop = null
  sendSplitHint(null)
  if (!record) return false
  const manager = ensureTabManager()
  const newTabId = manager.attachTab(record, undefined, false)
  applyTornIntent(manager, newTabId, intent, drag)
  return true
}

/** Realize the drop: splitWith covers create/replace/reorient/focus; a pane
 *  tab flips the orientation or restores the split it was torn out of. */
function applyTornIntent(
  manager: TabManager,
  newTabId: string,
  intent: SplitDropIntent,
  drag: TornSplitDrag,
): void {
  if (intent.kind === 'flip' || intent.kind === 'noop') {
    const start = drag.splitAtStart
    if (!start) {
      manager.activateTab(newTabId)
      return
    }
    manager.beginSplit(
      start.aTabId === drag.tabId ? newTabId : start.aTabId,
      start.bTabId === drag.tabId ? newTabId : start.bTabId,
      intent.kind === 'flip' ? intent.orientation : start.orientation,
      start.ratio,
      start.focus,
    )
    return
  }
  manager.splitWith(newTabId, intent)
}

/** last split state pushed through handleSplitChanged (for ratio-only detection) */
let lastSplitState: SplitViewState | null = null
let splitMemoryTimer: ReturnType<typeof setTimeout> | null = null

/** the parts of a split a pane role depends on; the divider only moves ratio */
function splitShape(state: SplitViewState | null): string {
  return state === null
    ? 'none'
    : `${state.aTabId}|${state.bTabId}|${state.orientation}|${state.focus}`
}

/** one split change: tell every pane view its role, push the state to the strip,
 *  and remember the arrangement. A divider drag changes only the ratio, so its
 *  memory write is debounced (roles and tabs never change mid-drag, and a
 *  per-frame settings rewrite would fsync on every pointer move). */
function handleSplitChanged(
  win: BrowserWindow,
  manager: TabManager,
  state: SplitViewState | null,
): void {
  const ratioOnly =
    state !== null && lastSplitState !== null && splitShape(state) === splitShape(lastSplitState)
  lastSplitState = state
  // the session record keeps the split (crash recovery spec 5.2)
  noteLiveSession()
  if (!ratioOnly) notifySplitRoles(manager)
  if (!win.isDestroyed()) win.webContents.send(SPLIT_TABS_CHANNELS.changed, state)
  if (splitMemoryTimer) {
    clearTimeout(splitMemoryTimer)
    splitMemoryTimer = null
  }
  if (ratioOnly) {
    splitMemoryTimer = setTimeout(() => {
      splitMemoryTimer = null
      // the window may have closed mid-drag; its manager must not write
      if (tabManager !== manager) return
      persistSplitMemory(manager, lastSplitState)
    }, 400)
  } else {
    persistSplitMemory(manager, state)
  }
}

/** save the split, or clear the memory when it is gone; best-effort */
function persistSplitMemory(manager: TabManager, state: SplitViewState | null): void {
  try {
    if (state === null) {
      writeSplitMemory(null, { settingsPath: APP_SETTINGS_PATH })
      return
    }
    const tabs = new Map(manager.list().map((tab) => [tab.id, tab]))
    writeSplitMemory(
      {
        aTabIdPath: tabs.get(state.aTabId)?.filePath,
        bTabIdPath: tabs.get(state.bTabId)?.filePath,
        orientation: state.orientation,
        ratio: state.ratio,
        focus: state.focus,
      },
      { settingsPath: APP_SETTINGS_PATH },
    )
  } catch {
    // the memory is best-effort: a failed write never disturbs the split
  }
}

/** push the current pane role to every tab view (null = not in a split) */
function notifySplitRoles(manager: TabManager): void {
  for (const tab of manager.list()) {
    const wc = manager.webContentsForTab(tab.id)
    if (!wc || wc.isDestroyed()) continue
    wc.send(SPLIT_PANE_CHANNELS.roleChanged, manager.splitRoleOf(wc.id))
  }
}

/**
 * A launch with no file argument: reopen the remembered arrangement when its
 * documents are still on disk, else the home screen as always. A remembered
 * path that is gone is skipped — one remaining document opens alone, both gone
 * falls back to home. The memory is left untouched: the next split change
 * rewrites it.
 */
function restoreSplitMemoryOrHome(): void {
  const manager = ensureTabManager()
  const memory = readRememberedSplit()
  const aPath = fileOnDisk(memory?.a)
  const bPath = fileOnDisk(memory?.b)
  if (aPath === undefined && bPath === undefined) {
    manager.openHomeTab()
    return
  }
  const orientation = memory?.orientation ?? 'side'
  const ratio = memory?.ratio ?? SPLIT_EVEN_RATIO
  const focus = memory?.focus ?? 'b'
  // both panes held the same file: one tab, duplicated for the second pane
  if (aPath !== undefined && bPath !== undefined && canonicalPath(aPath) === canonicalPath(bPath)) {
    const aTabId = openRememberedTab(aPath)
    if (aTabId === undefined) {
      manager.openHomeTab()
      return
    }
    const bTabId = manager.openDuplicatePaneTab(aTabId)
    if (bTabId === null) return
    manager.beginSplit(aTabId, bTabId, orientation, ratio, focus)
    return
  }
  const aTabId = openRememberedTab(aPath)
  const bTabId = openRememberedTab(bPath)
  if (aTabId === undefined && bTabId === undefined) {
    manager.openHomeTab()
    return
  }
  if (aTabId !== undefined && bTabId !== undefined) {
    manager.beginSplit(aTabId, bTabId, orientation, ratio, focus)
  }
}

/** the remembered arrangement, or null when there is none to trust */
function readRememberedSplit(): SplitMemory | null {
  try {
    return readSplitMemory({ settingsPath: APP_SETTINGS_PATH })
  } catch {
    return null
  }
}

/** route one remembered path into its editor tab; the landed tab's id */
function openRememberedTab(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  routeDocumentPath(path)
  return tabManager?.findTabByPath(path)?.id
}

/** the path when it names a file on disk right now */
function fileOnDisk(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  try {
    return existsSync(path) ? path : undefined
  } catch {
    return undefined
  }
}

/** Menu-command target for the editors whose menus resolve through the shell
 *  (pdf / markdown / html): the focused detached window of that kind first,
 *  else the shell's active tab of that kind. */
function activeEditorTarget(
  kind: TabKind,
  fromTabs: () => { id: string; webContents: WebContents; filePath?: string } | undefined,
): { id: string; webContents: WebContents; filePath?: string } | undefined {
  const detachedTab = focusedDetachedTab()
  if (detachedTab?.kind === kind) return detachedTab
  return fromTabs()
}
function activePdfTarget() {
  return activeEditorTarget('pdf', () => tabManager?.activePdfTab())
}

/** ⌘W / File > Close targets the focused window: a detached editor closes
 *  itself (its own unsaved-changes guard runs), otherwise the shell's active tab
 *  — the same rule the docs / sheets / slides close hooks follow */
function closeFocusedEditor(): void {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && focused !== shellWindow && isDetachedEditorWindow(focused)) focused.close()
  else tabManager?.closeActiveTab()
}

/** the window a pdf command's dialogs and progress belong to: the detached
 *  editor hosting the tab when there is one, else the shell */
function pdfHostWindow(tab: { webContents: WebContents } | undefined): BrowserWindow | null {
  if (!tab) return null
  return detachedWindowForWebContents(tab.webContents.id) ?? shellWindow
}
function activeMarkdownTarget() {
  return activeEditorTarget('markdown', () => tabManager?.activeMarkdownTab())
}
function activeHtmlTarget() {
  return activeEditorTarget('html', () => tabManager?.activeHtmlTab())
}
function activeMindmapTarget() {
  return activeEditorTarget('mindmap', () => tabManager?.activeMindmapTab())
}
function activeDiagramTarget() {
  return activeEditorTarget('diagram', () => tabManager?.activeDiagramTab())
}

/** the document a kind's File menu acts on, for the provenance entries (spec 8.2, 9) */
function linkedDocumentFor(kind: TabKind): LinkedDocument | undefined {
  const target =
    kind === 'html'
      ? activeHtmlTarget()
      : activeEditorTarget(kind, () => {
          const tab = tabManager?.list().find((t) => t.active && t.kind === kind)
          const wc = tab ? tabManager?.webContentsForTab(tab.id) : undefined
          return tab && wc ? { id: tab.id, webContents: wc } : undefined
        })
  return target ? linkedDocumentForWebContents(target.webContents) : undefined
}

/** the document behind a webContents: a shell tab, or the focused detached window */
function linkedDocumentForWebContents(wc: WebContents): LinkedDocument | undefined {
  if (wc.isDestroyed()) return undefined
  const inTab = tabManager?.describeWebContents(wc.id)
  if (inTab) {
    return {
      webContents: wc,
      title: inTab.title,
      ...(inTab.filePath ? { filePath: inTab.filePath } : {}),
    }
  }
  const detached = focusedDetachedTab()
  if (detached?.webContents.id !== wc.id) return undefined
  return {
    webContents: wc,
    title: detached.window.getTitle(),
    ...(detached.filePath ? { filePath: detached.filePath } : {}),
  }
}

/** whose menu is the application menu: the focused detached window's, else the active tab's */
function linkMenuKind(): TabKind | undefined {
  const detached = focusedDetachedTab()
  if (detached) return detached.kind
  const active = tabManager?.list().find((t) => t.active)
  // a Present tab shows the Home menu
  if (active?.kind === 'html' && !tabManager?.activeHtmlTab()) return 'home'
  return active?.kind
}
function activeHwpTarget() {
  return activeEditorTarget('hwp', () => tabManager?.activeHwpTab())
}
function activeEpubTarget() {
  return activeEditorTarget('epub', () => tabManager?.activeEpubTab())
}

/** whether a tab or a detached window of any editor has this file open */
function isPathOpenInAnyTab(path: string): boolean {
  const wanted = canonicalPath(path)
  if (wanted === undefined) return false
  const open = [...(tabManager?.openFilePaths() ?? []), ...detachedFilePaths()]
  return open.some((openPath) => canonicalPath(openPath) === wanted)
}

/**
 * Split-view IPC: the strip's split state and divider channels, the editors'
 * pane-role bridge (packages/electron-utils/src/split-pane-bridge.ts), and the
 * same-document save probe the editors consult before writing.
 */
function registerSplitIpc(): void {
  ipcMain.handle(SPLIT_TABS_CHANNELS.get, () => tabManager?.splitState() ?? null)
  ipcMain.on(SPLIT_TABS_CHANNELS.setRatio, (_event, ratio: unknown) => {
    if (typeof ratio === 'number' && Number.isFinite(ratio)) tabManager?.setSplitRatio(ratio)
  })
  ipcMain.handle(
    SPLIT_PANE_CHANNELS.getRole,
    (event) => tabManager?.splitRoleOf(event.sender.id) ?? null,
  )
  ipcMain.on(SPLIT_PANE_CHANNELS.requestFocus, (event) =>
    tabManager?.focusPaneByWebContents(event.sender.id),
  )
  ipcMain.on(SPLIT_PANE_CHANNELS.reportFocus, (event) =>
    tabManager?.focusPaneByWebContents(event.sender.id),
  )
  // Same-document save guard: the editors ask whether the path is open in
  // another copy (another pane or detached window). One copy alone never
  // counts — a normal save behaves exactly as before.
  setOpenPathProbe((path) => {
    try {
      const wanted = canonicalPath(path)
      if (wanted === undefined) return false
      let copies = 0
      for (const tab of tabManager?.list() ?? []) {
        if (tab.filePath !== undefined && canonicalPath(tab.filePath) === wanted) copies++
      }
      for (const openPath of detachedFilePaths()) {
        if (canonicalPath(openPath) === wanted) copies++
      }
      return copies > 1
    } catch {
      return false
    }
  })
}

/** files of tabs that were closed, newest last, so "Reopen closed tab" can bring them back */
const recentlyClosed = createRecentlyClosedTracker()

function duplicateFile(path: string): Promise<string | undefined> {
  return duplicateDocumentFile(path, {
    copySuffix: tm('copySuffix'),
    recordRecentFile,
    onError: (error) => showErrorDialog(shellWindow, tm('errDuplicateFailed'), error),
  })
}

/** The shell's side of every entry of the tab menu (see tab-menu.ts for what is offered). */
function tabMenuActions(): TabMenuActions {
  const documentAction = (id: string, action: TabDocumentAction) => {
    if (!tabManager) return
    runTabDocumentAction(
      {
        tabs: tabManager,
        savePdf: (contents) => {
          void flushPdfSave(contents)
        },
        savePdfAs: (target) => {
          void savePdfAs(target)
        },
        printPdf: sendPdfPrintRequest,
        saveMarkdown: (contents, mode) => {
          void requestMarkdownSave(contents, mode)
        },
        printMarkdown: sendMarkdownPrintRequest,
        saveHtml: (contents, mode) => {
          void requestHtmlSave(contents, mode)
        },
        printHtml: sendHtmlPrintRequest,
        saveMindmap: (contents, mode) => {
          void requestMindmapSave(contents, mode)
        },
        printMindmap: sendMindmapPrintRequest,
        saveHwp: (contents, mode) => {
          void requestHwpSave(contents, mode)
        },
        // the same as File > Print and Ctrl+P: the preview opens, and prints from there
        printHwp: (contents) => requestHwpPreview(contents, 'print'),
      },
      id,
      action,
    )
  }
  return {
    save: (id) => documentAction(id, 'save'),
    saveAs: (id) => documentAction(id, 'saveAs'),
    print: (id) => documentAction(id, 'print'),
    openInNewWindow: (id) => detachTabToWindow(id),
    // two windows side by side, each on its own half of the screen the tab is on
    splitBeside: (id) => {
      if (!tabManager || !shellWindow) return
      const record = tabManager.detachTab(id)
      if (!record) return
      const win = createDetachedEditorWindow({ ...record, applyMenuFor })
      const area = screen.getDisplayMatching(shellWindow.getBounds()).workArea
      const half = Math.floor(area.width / 2)
      if (shellWindow.isMaximized()) shellWindow.unmaximize()
      if (shellWindow.isFullScreen()) shellWindow.setFullScreen(false)
      shellWindow.setBounds({ x: area.x, y: area.y, width: half, height: area.height })
      win.setBounds({ x: area.x + half, y: area.y, width: area.width - half, height: area.height })
      win.focus()
    },
    rename: (id) => {
      if (shellWindow && !shellWindow.isDestroyed())
        shellWindow.webContents.send(TABS_CHANNELS.startRename, id)
    },
    duplicate: (path) => {
      void duplicateFile(path).then((target) => {
        if (target) openDocumentPath(target)
      })
    },
    copyText: (text) => clipboard.writeText(text),
    reveal: (path) => shell.showItemInFolder(path),
    openDefault: (path) => {
      // a document tab is a document, never a program; keep it that way for a renamed one
      if (!isProgramFile(path)) void shell.openPath(path)
    },
    move: (id, toIndex) => tabManager?.reorderTab(id, toIndex),
    closeTabs: (ids) => void (tabManager && closeTabsInOrder(tabManager, ids)),
    reopenClosed: () => recentlyClosed.reopenNext(openDocumentPath, existsSync),
  }
}

function registerTabsIpc(): void {
  ipcMain.on(TABS_CHANNELS.chromePressed, (event) => broadcastChromePressed(event.sender))
  ipcMain.handle(TABS_CHANNELS.list, () => tabManager?.list() ?? [])
  ipcMain.handle(TABS_CHANNELS.activate, (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return
    tabManager?.activateTab(id)
  })
  ipcMain.handle(TABS_CHANNELS.close, (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return
    return tabManager?.closeTab(id)
  })
  ipcMain.handle(TABS_CHANNELS.reorder, (_event, id: string, toIndex: number) => {
    if (typeof id === 'string' && Number.isInteger(toIndex)) tabManager?.reorderTab(id, toIndex)
  })
  // "all tabs" overflow menu — native popup because the editors' WebContentsView
  // would cover any DOM dropdown the shell renderer draws below the tab strip
  // the ☰ button is the Windows/Linux menu: the window's menus, then the update
  // check as an item of its own (Help keeps it only on macOS)
  ipcMain.handle(TABS_CHANNELS.showAppMenu, (_event, x: unknown, y: unknown) => {
    if (!shellWindow) return
    const appMenu = Menu.getApplicationMenu()
    if (!appMenu) return
    const menus: MenuItemConstructorOptions[] = appMenu.items.map((item) =>
      item.submenu
        ? { label: item.label, submenu: item.submenu }
        : item.type === 'separator'
          ? { type: 'separator' }
          : { label: item.label, enabled: item.enabled, click: () => item.click() },
    )
    Menu.buildFromTemplate(appMenuPopupTemplate(menus, appMenuLabels(currentLang()))).popup({
      window: shellWindow,
      ...(typeof x === 'number' && typeof y === 'number'
        ? { x: Math.round(x), y: Math.round(y) }
        : {}),
    })
  })
  ipcMain.handle(TABS_CHANNELS.showMenu, (_event, x: unknown, y: unknown) => {
    if (!tabManager || !shellWindow) return
    const menu = Menu.buildFromTemplate(
      tabManager.list().map((tab) => ({
        label: tab.title,
        type: 'checkbox' as const,
        checked: tab.active,
        icon: menuIcons()[TAB_MENU_ICON[tab.kind]],
        click: () => tabManager?.activateTab(tab.id),
      })),
    )
    menu.popup({
      window: shellWindow,
      ...(typeof x === 'number' && typeof y === 'number'
        ? { x: Math.round(x), y: Math.round(y) }
        : {}),
    })
  })
  ipcMain.handle(TABS_CHANNELS.detach, (_event, id: unknown) => {
    if (typeof id !== 'string' || !tabManager?.canDetachTab(id)) return
    detachTabToWindow(id)
  })
  // drag-to-tear-off: the strip drives the window until the pointer lifts
  ipcMain.handle(TABS_CHANNELS.tearOff, (_event, id: unknown, x: unknown, y: unknown) => {
    if (typeof id !== 'string' || typeof x !== 'number' || typeof y !== 'number') return false
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    // remember what the drag started from before the tab leaves the strip:
    // tearing a pane tab out drops the split, so this is the only record
    tornSplitDrag = tearOffSplitContext(id)
    tornSplitDrop = null
    lastSplitHint = null
    const torn = tearOffTabToWindow(id, x, y)
    if (!torn) tornSplitDrag = null
    return torn
  })
  ipcMain.on(TABS_CHANNELS.dragTornWindow, (_event, x: unknown, y: unknown) => {
    if (
      typeof x === 'number' &&
      typeof y === 'number' &&
      Number.isFinite(x) &&
      Number.isFinite(y)
    ) {
      dragTornWindow(x, y)
      updateSplitHint(x, y)
    }
  })
  ipcMain.handle(TABS_CHANNELS.dockTornWindow, (_event, index: unknown) => {
    if (applyTornSplitDrop()) return
    const tab = takeTornTab()
    if (!tab) return
    ensureTabManager().attachTab(tab, typeof index === 'number' ? index : undefined)
  })
  ipcMain.handle(TABS_CHANNELS.endTornDrag, () => {
    if (applyTornSplitDrop()) return
    endTornDrag()
  })
  ipcMain.on(TABS_CHANNELS.dockIndex, (_event, index: unknown) => {
    lastDockIndex = typeof index === 'number' && Number.isInteger(index) ? index : undefined
  })
  // per-tab context menu — native for the same reason as the tab list above
  ipcMain.handle(TABS_CHANNELS.showTabMenu, (_event, id: unknown, x: unknown, y: unknown) => {
    if (!tabManager || !shellWindow || typeof id !== 'string') return
    const tab = tabManager.list().find((t) => t.id === id)
    if (!tab || tab.kind === 'home') return
    const template = tabMenuTemplate({
      tab,
      tabs: tabManager.list(),
      canDetach: tabManager.canDetachTab(id),
      fileExists: !!tab.filePath && existsSync(tab.filePath),
      canReopen: recentlyClosed.getEntries().length > 0,
      tm,
      actions: tabMenuActions(),
    })
    // in-app split entries: document tabs only, right after the window actions
    if (tabManager.canDetachTab(id) && tab.kind !== 'help') {
      const applySplitMenu = (dropped: SplitOrientation): void => {
        if (!tabManager) return
        const intent = decideSplitDrop({
          split: tabManager.splitState(),
          dragged: {
            isDocument: true,
            isPaneTab: tabManager.isPaneTab(id),
            docPane: splitPaneOfDocument(tabManager, tabManager.splitState(), {
              tabId: id,
              filePath: tab.filePath,
            }),
          },
          dropped,
        })
        if (intent) tabManager.splitWith(id, intent)
      }
      const openIdx = template.findIndex((item) => item.id === 'openInNewWindow')
      template.splice(
        openIdx + 1,
        0,
        { type: 'separator' },
        { label: tm('menuSplitRight'), click: () => applySplitMenu('side') },
        { label: tm('menuSplitDown'), click: () => applySplitMenu('stack') },
        ...(tabManager.isPaneTab(id)
          ? [{ label: tm('menuUnsplit'), click: () => tabManager?.unsplit() }]
          : []),
      )
    }
    Menu.buildFromTemplate(template).popup({
      window: shellWindow,
      ...(typeof x === 'number' && typeof y === 'number'
        ? { x: Math.round(x), y: Math.round(y) }
        : {}),
    })
  })
  // "+" new-file menu — native for the same reason as the tab list above
  ipcMain.handle(TABS_CHANNELS.showNewMenu, (_event, x: unknown, y: unknown) => {
    if (!tabManager || !shellWindow) return
    const menu = Menu.buildFromTemplate([
      ...newDocumentMenuItems({ icons: true, section: true }),
      { label: tm('menuOpen'), click: () => void openFileViaDialog() },
    ])
    menu.popup({
      window: shellWindow,
      ...(typeof x === 'number' && typeof y === 'number'
        ? { x: Math.round(x), y: Math.round(y) }
        : {}),
    })
  })
}

// ---- home menu ----

async function openFileViaDialog(): Promise<void> {
  const win = shellWindow ?? BrowserWindow.getFocusedWindow()
  if (!win) return
  const result = await showOpenDialogWithMemory(dialog, win, {
    filters: [{ name: tm('filterSupported'), extensions: OPEN_DIALOG_EXTENSIONS }],
    properties: ['openFile', 'multiSelections'],
  })
  if (!result.canceled) for (const path of result.filePaths) openDocumentPath(path)
}

function buildHomeMenu(): void {
  const labels = appMenuLabels(currentLang())
  // macOS only: the application menu is spelled out so it can carry a
  // Settings entry of our own (role:'appMenu' is a fixed template)
  const appMenu = appMenuTemplate(process.platform, labels, {
    appLabel: app.name,
    extra: [settingsMenuItem(labels)],
  })
  const template: MenuItemConstructorOptions[] = [
    ...(appMenu ? [appMenu] : []),
    {
      label: tm('menuFile'),
      submenu: [
        // Ctrl+N makes the first entry home lists
        ...newDocumentMenuItems({ section: true, accelerator: 'CmdOrCtrl+N' }),
        {
          label: tm('menuOpen'),
          accelerator: 'CmdOrCtrl+O',
          click: () => void openFileViaDialog(),
        },
        { type: 'separator' },
        { role: 'close', label: tm('menuClose') },
        { type: 'separator' },
        settingsMenuItem(labels),
      ],
    },
    viewMenuTemplate(),
    editMenuTemplate(process.platform, appMenuLabels(currentLang())),
    windowMenuTemplate(process.platform, appMenuLabels(currentLang())),
    {
      role: 'help',
      label: tm('menuHelp'),
      submenu: [
        { label: tm('menuUserGuide'), accelerator: 'F1', click: () => tabManager?.openHelpTab() },
        { type: 'separator' },
        { label: tm('thirdPartyNotices'), click: () => void openThirdPartyNotices() },
        { type: 'separator' },
        ...helpCheckUpdatesItems(appMenuLabels(currentLang())),
        aboutMenuItem(appMenuLabels(currentLang())),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- pdf menu (pdf-main has no menu of its own; the shell owns pdf tabs, so it builds one) ----

function buildPdfMenu(): void {
  const labels = appMenuLabels(currentLang())
  // macOS only: the application menu is spelled out so it can carry a
  // Settings entry of our own (role:'appMenu' is a fixed template)
  const appMenu = appMenuTemplate(process.platform, labels, {
    appLabel: app.name,
    extra: [settingsMenuItem(labels)],
  })
  const template: MenuItemConstructorOptions[] = [
    ...(appMenu ? [appMenu] : []),
    {
      label: tm('menuFile'),
      submenu: [
        {
          label: tm('menuOpen'),
          accelerator: 'CmdOrCtrl+O',
          click: () => void openFileViaDialog(),
        },
        { type: 'separator' },
        {
          label: tm('backToHome'),
          accelerator: 'Shift+CmdOrCtrl+H',
          click: () => tabManager?.openHomeTab(),
        },
        { type: 'separator' },
        {
          label: tm('menuSave'),
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            const tab = activePdfTarget()
            if (tab) void flushPdfSave(tab.webContents)
          },
        },
        {
          label: tm('menuSaveAs'),
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => void savePdfAs(),
        },
        ...documentLinkFileMenuItems('pdf'),
        { type: 'separator' },
        // local pdf2docx (P4): in-process PDFium wasm, no cloud counterpart
        {
          label: tm('menuExportDocx'),
          click: () => void exportPdfAsDocxLocal(),
        },
        // local pdf2pptx (P25): one slide per page, no cloud counterpart
        {
          label: tm('menuExportPptx'),
          click: () => void exportPdfAsPptxLocal(),
        },
        // local pdf2xlsx (P26): one worksheet per page, no cloud counterpart
        {
          label: tm('menuExportXlsx'),
          click: () => void exportPdfAsXlsxLocal(),
        },
        // Markdown / EPUB: the pdf tab's conversion dialog (page range, save location, progress)
        {
          label: tm('menuExportMd'),
          click: () => requestPdfConvertDialog(activePdfTarget()?.webContents, 'md'),
        },
        {
          label: tm('menuExportEpub'),
          click: () => requestPdfConvertDialog(activePdfTarget()?.webContents, 'epub'),
        },
        { type: 'separator' },
        {
          label: tm('menuPrint'),
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            const tab = activePdfTarget()
            if (tab) sendPdfPrintRequest(tab.webContents)
          },
        },
        { type: 'separator' },
        {
          label: tm('menuClose'),
          accelerator: 'CmdOrCtrl+W',
          click: () => closeFocusedEditor(),
        },
        { type: 'separator' },
        settingsMenuItem(labels),
      ],
    },
    editMenuTemplate(process.platform, appMenuLabels(currentLang())),
    windowMenuTemplate(process.platform, appMenuLabels(currentLang())),
    {
      role: 'help',
      label: tm('menuHelp'),
      submenu: [
        { label: tm('thirdPartyNotices'), click: () => void openThirdPartyNotices() },
        { type: 'separator' },
        ...helpCheckUpdatesItems(appMenuLabels(currentLang())),
        aboutMenuItem(appMenuLabels(currentLang())),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- markdown menu (markdown-main has no menu of its own; the shell owns markdown tabs) ----

function buildMarkdownMenu(): void {
  const labels = appMenuLabels(currentLang())
  // macOS only: the application menu is spelled out so it can carry a
  // Settings entry of our own (role:'appMenu' is a fixed template)
  const appMenu = appMenuTemplate(process.platform, labels, {
    appLabel: app.name,
    extra: [settingsMenuItem(labels)],
  })
  const template: MenuItemConstructorOptions[] = [
    ...(appMenu ? [appMenu] : []),
    {
      label: tm('menuFile'),
      submenu: [
        {
          label: tm('menuOpen'),
          accelerator: 'CmdOrCtrl+O',
          click: () => void openFileViaDialog(),
        },
        { type: 'separator' },
        {
          label: tm('backToHome'),
          accelerator: 'Shift+CmdOrCtrl+H',
          click: () => tabManager?.openHomeTab(),
        },
        { type: 'separator' },
        {
          label: tm('menuSave'),
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            const tab = activeMarkdownTarget()
            if (tab) void requestMarkdownSave(tab.webContents, 'save')
          },
        },
        {
          label: tm('menuSaveAs'),
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            const tab = activeMarkdownTarget()
            if (tab) void requestMarkdownSave(tab.webContents, 'saveAs')
          },
        },
        ...documentLinkFileMenuItems('markdown'),
        { type: 'separator' },
        {
          label: tm('menuExportDocx'),
          click: () => {
            const tab = activeMarkdownTarget()
            if (tab) sendMarkdownExportRequest(tab.webContents, 'docx')
          },
        },
        {
          label: tm('menuExportOdt'),
          click: () => {
            const tab = activeMarkdownTarget()
            if (tab) sendMarkdownExportRequest(tab.webContents, 'odt')
          },
        },
        {
          label: tm('menuExportPdf'),
          click: () => {
            const tab = activeMarkdownTarget()
            if (tab) sendMarkdownExportRequest(tab.webContents, 'pdf')
          },
        },
        {
          label: tm('menuExportImages'),
          click: () => {
            const tab = activeMarkdownTarget()
            if (tab) sendMarkdownExportRequest(tab.webContents, 'png')
          },
        },
        {
          label: tm('menuOpenInDocs'),
          click: () => {
            const tab = activeMarkdownTarget()
            if (tab) sendMarkdownExportRequest(tab.webContents, 'docs')
          },
        },
        { type: 'separator' },
        {
          label: tm('menuPrint'),
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            const tab = activeMarkdownTarget()
            if (tab) sendMarkdownPrintRequest(tab.webContents)
          },
        },
        { type: 'separator' },
        {
          label: tm('menuClose'),
          accelerator: 'CmdOrCtrl+W',
          click: () => closeFocusedEditor(),
        },
        { type: 'separator' },
        settingsMenuItem(labels),
      ],
    },
    editMenuTemplate(process.platform, appMenuLabels(currentLang())),
    windowMenuTemplate(process.platform, appMenuLabels(currentLang())),
    {
      role: 'help',
      label: tm('menuHelp'),
      submenu: [
        { label: tm('thirdPartyNotices'), click: () => void openThirdPartyNotices() },
        { type: 'separator' },
        ...helpCheckUpdatesItems(appMenuLabels(currentLang())),
        aboutMenuItem(appMenuLabels(currentLang())),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- hwp menu (hwp-main has no menu of its own; the shell owns hwp tabs) ----

function buildHwpMenu(): void {
  const labels = appMenuLabels(currentLang())
  // macOS only: the application menu is spelled out so it can carry a
  // Settings entry of our own (role:'appMenu' is a fixed template)
  const appMenu = appMenuTemplate(process.platform, labels, {
    appLabel: app.name,
    extra: [settingsMenuItem(labels)],
  })
  const template: MenuItemConstructorOptions[] = [
    ...(appMenu ? [appMenu] : []),
    {
      label: tm('menuFile'),
      submenu: [
        {
          label: tm('menuOpen'),
          accelerator: 'CmdOrCtrl+O',
          click: () => void openFileViaDialog(),
        },
        { label: tm('menuImportPdf'), click: () => void importPdfAsHwp() },
        { type: 'separator' },
        {
          label: tm('backToHome'),
          accelerator: 'Shift+CmdOrCtrl+H',
          click: () => tabManager?.openHomeTab(),
        },
        { type: 'separator' },
        // no accelerators here: the embedded editor swallows Ctrl+S and Ctrl+P
        // before the menu sees them, so hwp-main takes those shortcuts off the key
        // event itself; registering them twice would run them twice whenever focus
        // sits outside the editor
        {
          label: tm('menuSave'),
          click: () => {
            const tab = activeHwpTarget()
            if (tab) void requestHwpSave(tab.webContents, 'save')
          },
        },
        {
          label: tm('menuSaveAs'),
          click: () => {
            const tab = activeHwpTarget()
            if (tab) void requestHwpSave(tab.webContents, 'saveAs')
          },
        },
        { type: 'separator' },
        {
          label: tm('menuExportPdf'),
          click: () => {
            const tab = activeHwpTarget()
            if (tab) requestHwpPrint(tab.webContents, 'pdf')
          },
        },
        {
          label: tm('menuPreview'),
          click: () => {
            const tab = activeHwpTarget()
            if (tab) requestHwpPreview(tab.webContents, 'open')
          },
        },
        {
          label: tm('menuPrint'),
          click: () => {
            const tab = activeHwpTarget()
            if (tab) requestHwpPreview(tab.webContents, 'print')
          },
        },
        { type: 'separator' },
        {
          label: tm('menuClose'),
          accelerator: 'CmdOrCtrl+W',
          click: () => closeFocusedEditor(),
        },
        { type: 'separator' },
        settingsMenuItem(labels),
      ],
    },
    editMenuTemplate(process.platform, appMenuLabels(currentLang())),
    windowMenuTemplate(process.platform, appMenuLabels(currentLang())),
    {
      role: 'help',
      label: tm('menuHelp'),
      submenu: [
        { label: tm('thirdPartyNotices'), click: () => void openThirdPartyNotices() },
        { type: 'separator' },
        ...helpCheckUpdatesItems(appMenuLabels(currentLang())),
        aboutMenuItem(appMenuLabels(currentLang())),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- book menu (epub-main has no menu of its own; the shell owns book tabs) ----

function buildEpubMenu(): void {
  const isMac = process.platform === 'darwin'
  const labels = appMenuLabels(currentLang())
  /** a command for the book in the active tab or the focused detached window */
  const toBook = (command: EpubMenuCommand) => () => {
    const tab = activeEpubTarget()
    if (tab) sendEpubMenuCommand(tab.webContents, command)
  }
  // Undo, redo, find, replace and zoom go to the book: its history and its view
  // are the editor's own, so the page roles would not reach them. The editor
  // takes these keys itself; the shortcut is shown but not registered, or one
  // press would run twice.
  const bookKey = (
    label: string,
    accelerator: string,
    command: EpubMenuCommand,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: toBook(command),
  })
  const appMenu = appMenuTemplate(process.platform, labels, {
    appLabel: app.name,
    extra: [settingsMenuItem(labels)],
  })
  const template: MenuItemConstructorOptions[] = [
    ...(appMenu ? [appMenu] : []),
    {
      label: tm('menuFile'),
      submenu: [
        {
          label: tm('menuOpen'),
          accelerator: 'CmdOrCtrl+O',
          click: () => void openFileViaDialog(),
        },
        { type: 'separator' },
        {
          label: tm('backToHome'),
          accelerator: 'Shift+CmdOrCtrl+H',
          click: () => tabManager?.openHomeTab(),
        },
        { type: 'separator' },
        {
          label: tm('menuSave'),
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            const tab = activeEpubTarget()
            if (tab) void requestEpubSave(tab.webContents, 'save')
          },
        },
        {
          label: tm('menuSaveAs'),
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            const tab = activeEpubTarget()
            if (tab) void requestEpubSave(tab.webContents, 'saveAs')
          },
        },
        { type: 'separator' },
        { label: tm('menuTranslateBook'), click: toBook('translate-book') },
        { type: 'separator' },
        {
          label: tm('menuClose'),
          accelerator: 'CmdOrCtrl+W',
          click: () => closeFocusedEditor(),
        },
        { type: 'separator' },
        settingsMenuItem(labels),
      ],
    },
    {
      label: labels.edit,
      submenu: [
        bookKey(labels.undo, 'CmdOrCtrl+Z', 'undo'),
        bookKey(labels.redo, isMac ? 'Shift+Cmd+Z' : 'Ctrl+Y', 'redo'),
        { type: 'separator' },
        { role: 'cut', label: labels.cut },
        { role: 'copy', label: labels.copy },
        { role: 'paste', label: labels.paste },
        { role: 'delete', label: labels.delete },
        { type: 'separator' },
        { role: 'selectAll', label: labels.selectAll },
        { type: 'separator' },
        bookKey(tm('menuFind'), 'CmdOrCtrl+F', 'find'),
        bookKey(tm('menuReplace'), isMac ? 'Alt+Cmd+F' : 'Ctrl+H', 'replace'),
      ],
    },
    {
      label: labels.view,
      submenu: [
        bookKey(labels.actualSize, 'CmdOrCtrl+0', 'zoom-reset'),
        bookKey(labels.zoomIn, 'CmdOrCtrl+=', 'zoom-in'),
        bookKey(labels.zoomOut, 'CmdOrCtrl+-', 'zoom-out'),
        { type: 'separator' },
        { role: 'togglefullscreen', label: labels.fullscreen },
      ],
    },
    windowMenuTemplate(process.platform, appMenuLabels(currentLang())),
    {
      role: 'help',
      label: tm('menuHelp'),
      submenu: [
        { label: tm('thirdPartyNotices'), click: () => void openThirdPartyNotices() },
        { type: 'separator' },
        ...helpCheckUpdatesItems(appMenuLabels(currentLang())),
        aboutMenuItem(appMenuLabels(currentLang())),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- html menu (html-main has no menu of its own; the shell owns html tabs) ----

function buildHtmlMenu(): void {
  const labels = appMenuLabels(currentLang())
  // macOS only: the application menu is spelled out so it can carry a
  // Settings entry of our own (role:'appMenu' is a fixed template)
  const appMenu = appMenuTemplate(process.platform, labels, {
    appLabel: app.name,
    extra: [settingsMenuItem(labels)],
  })
  const template: MenuItemConstructorOptions[] = [
    ...(appMenu ? [appMenu] : []),
    {
      label: tm('menuFile'),
      submenu: [
        {
          label: tm('menuOpen'),
          accelerator: 'CmdOrCtrl+O',
          click: () => void openFileViaDialog(),
        },
        { type: 'separator' },
        {
          label: tm('backToHome'),
          accelerator: 'Shift+CmdOrCtrl+H',
          click: () => tabManager?.openHomeTab(),
        },
        { type: 'separator' },
        {
          label: tm('menuSave'),
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            const tab = activeHtmlTarget()
            if (tab) void requestHtmlSave(tab.webContents, 'save')
          },
        },
        {
          label: tm('menuSaveAs'),
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            const tab = activeHtmlTarget()
            if (tab) void requestHtmlSave(tab.webContents, 'saveAs')
          },
        },
        ...documentLinkFileMenuItems('html'),
        { type: 'separator' },
        {
          label: tm('menuExportDocx'),
          click: () => {
            const tab = activeHtmlTarget()
            if (tab) sendHtmlExportRequest(tab.webContents, 'docx')
          },
        },
        {
          label: tm('menuExportOdt'),
          click: () => {
            const tab = activeHtmlTarget()
            if (tab) sendHtmlExportRequest(tab.webContents, 'odt')
          },
        },
        {
          label: tm('menuExportPdf'),
          click: () => {
            const tab = activeHtmlTarget()
            if (tab) sendHtmlExportRequest(tab.webContents, 'pdf')
          },
        },
        {
          label: tm('menuExportHtml'),
          click: () => {
            const tab = activeHtmlTarget()
            if (tab) sendHtmlExportRequest(tab.webContents, 'html')
          },
        },
        { type: 'separator' },
        {
          label: tm('menuPrint'),
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            const tab = activeHtmlTarget()
            if (tab) sendHtmlPrintRequest(tab.webContents)
          },
        },
        { type: 'separator' },
        {
          label: tm('menuClose'),
          accelerator: 'CmdOrCtrl+W',
          click: () => closeFocusedEditor(),
        },
        { type: 'separator' },
        settingsMenuItem(labels),
      ],
    },
    editMenuTemplate(process.platform, appMenuLabels(currentLang())),
    windowMenuTemplate(process.platform, appMenuLabels(currentLang())),
    {
      role: 'help',
      label: tm('menuHelp'),
      submenu: [
        { label: tm('thirdPartyNotices'), click: () => void openThirdPartyNotices() },
        { type: 'separator' },
        ...helpCheckUpdatesItems(appMenuLabels(currentLang())),
        aboutMenuItem(appMenuLabels(currentLang())),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- diagram menu (diagram-main has no menu of its own; the shell owns diagram tabs) ----

function buildDiagramMenu(): void {
  const isMac = process.platform === 'darwin'
  const labels = appMenuLabels(currentLang())
  /** a command for the diagram in the active tab or the focused detached window */
  const toDiagram = (command: DiagramMenuCommand) => () => {
    const tab = activeDiagramTarget()
    if (tab) sendDiagramMenuCommand(tab.webContents, command)
  }
  // Undo, redo, find and zoom go to the diagram: its history and its view are
  // draw.io's own, so the page roles would not reach them. draw.io takes these
  // keys itself; the shortcut is shown but not registered, or one press would
  // run twice.
  const diagramKey = (
    label: string,
    accelerator: string,
    command: DiagramMenuCommand,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: toDiagram(command),
  })
  /** the editor asks which pages, then exports them */
  const exportItem = (
    label: string,
    format: 'png' | 'svg' | 'pdf',
  ): MenuItemConstructorOptions => ({
    label,
    click: () => {
      const tab = activeDiagramTarget()
      if (tab) sendDiagramExportRequest(tab.webContents, format)
    },
  })
  const appMenu = appMenuTemplate(process.platform, labels, {
    appLabel: app.name,
    extra: [settingsMenuItem(labels)],
  })
  const template: MenuItemConstructorOptions[] = [
    ...(appMenu ? [appMenu] : []),
    {
      label: tm('menuFile'),
      submenu: [
        {
          label: tm('menuSectionNew'),
          accelerator: 'CmdOrCtrl+N',
          click: () => newDiagramTab(),
        },
        {
          label: tm('menuOpen'),
          accelerator: 'CmdOrCtrl+O',
          click: () => void openFileViaDialog(),
        },
        { type: 'separator' },
        {
          label: tm('backToHome'),
          accelerator: 'Shift+CmdOrCtrl+H',
          click: () => tabManager?.openHomeTab(),
        },
        { type: 'separator' },
        {
          label: tm('menuSave'),
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            const tab = activeDiagramTarget()
            if (tab) void requestDiagramSave(tab.webContents, 'save')
          },
        },
        {
          label: tm('menuSaveAs'),
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            const tab = activeDiagramTarget()
            if (tab) void requestDiagramSave(tab.webContents, 'saveAs')
          },
        },
        { type: 'separator' },
        exportItem(tm('menuExportMapImage'), 'png'),
        exportItem(tm('menuExportSvg'), 'svg'),
        exportItem(tm('menuExportPdf'), 'pdf'),
        { type: 'separator' },
        {
          label: tm('menuPrint'),
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            const tab = activeDiagramTarget()
            if (tab) sendDiagramPrintRequest(tab.webContents)
          },
        },
        { type: 'separator' },
        {
          label: tm('menuClose'),
          accelerator: 'CmdOrCtrl+W',
          click: () => closeFocusedEditor(),
        },
        { type: 'separator' },
        settingsMenuItem(labels),
      ],
    },
    {
      label: labels.edit,
      submenu: [
        diagramKey(labels.undo, 'CmdOrCtrl+Z', 'undo'),
        diagramKey(labels.redo, isMac ? 'Shift+Cmd+Z' : 'Ctrl+Y', 'redo'),
        { type: 'separator' },
        { role: 'cut', label: labels.cut },
        { role: 'copy', label: labels.copy },
        { role: 'paste', label: labels.paste },
        { role: 'delete', label: labels.delete },
        { type: 'separator' },
        { role: 'selectAll', label: labels.selectAll },
        { type: 'separator' },
        diagramKey(tm('menuFind'), 'CmdOrCtrl+F', 'find'),
      ],
    },
    {
      label: labels.view,
      submenu: [
        { label: labels.actualSize, click: toDiagram('zoom-reset') },
        diagramKey(labels.zoomIn, 'CmdOrCtrl+=', 'zoom-in'),
        diagramKey(labels.zoomOut, 'CmdOrCtrl+-', 'zoom-out'),
        { label: tm('menuZoomFit'), click: toDiagram('zoom-fit') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: labels.fullscreen },
      ],
    },
    windowMenuTemplate(process.platform, appMenuLabels(currentLang())),
    {
      role: 'help',
      label: tm('menuHelp'),
      submenu: [
        { label: tm('thirdPartyNotices'), click: () => void openThirdPartyNotices() },
        { type: 'separator' },
        ...helpCheckUpdatesItems(appMenuLabels(currentLang())),
        aboutMenuItem(appMenuLabels(currentLang())),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- mind map menu (mindmap-main has no menu of its own; the shell owns mind map tabs) ----

function buildMindmapMenu(): void {
  const isMac = process.platform === 'darwin'
  const labels = appMenuLabels(currentLang())
  const appMenu = appMenuTemplate(process.platform, labels, {
    appLabel: app.name,
    extra: [settingsMenuItem(labels)],
  })
  const template: MenuItemConstructorOptions[] = [
    ...(appMenu ? [appMenu] : []),
    {
      label: tm('menuFile'),
      submenu: [
        {
          label: tm('menuSectionNew'),
          accelerator: 'CmdOrCtrl+N',
          click: () => newMindmapTab(),
        },
        {
          label: tm('menuOpen'),
          accelerator: 'CmdOrCtrl+O',
          click: () => void openFileViaDialog(),
        },
        { type: 'separator' },
        {
          label: tm('backToHome'),
          accelerator: 'Shift+CmdOrCtrl+H',
          click: () => tabManager?.openHomeTab(),
        },
        { type: 'separator' },
        {
          label: tm('menuSave'),
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            const tab = activeMindmapTarget()
            if (tab) void requestMindmapSave(tab.webContents, 'save')
          },
        },
        {
          label: tm('menuSaveAs'),
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            const tab = activeMindmapTarget()
            if (tab) void requestMindmapSave(tab.webContents, 'saveAs')
          },
        },
        ...documentLinkFileMenuItems('mindmap'),
        { type: 'separator' },
        {
          label: tm('menuExportMapImage'),
          click: () => {
            const tab = activeMindmapTarget()
            if (tab) sendMindmapExportRequest(tab.webContents, 'png')
          },
        },
        {
          label: tm('menuExportMapSvg'),
          click: () => {
            const tab = activeMindmapTarget()
            if (tab) sendMindmapExportRequest(tab.webContents, 'svg')
          },
        },
        {
          label: tm('menuExportPdf'),
          click: () => {
            const tab = activeMindmapTarget()
            if (tab) sendMindmapExportRequest(tab.webContents, 'pdf')
          },
        },
        {
          label: tm('menuExportMapOutline'),
          click: () => {
            const tab = activeMindmapTarget()
            if (tab) sendMindmapExportRequest(tab.webContents, 'markdown')
          },
        },
        { type: 'separator' },
        {
          label: tm('menuPrint'),
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            const tab = activeMindmapTarget()
            if (tab) sendMindmapPrintRequest(tab.webContents)
          },
        },
        { type: 'separator' },
        {
          label: tm('menuClose'),
          accelerator: 'CmdOrCtrl+W',
          click: () => closeFocusedEditor(),
        },
        { type: 'separator' },
        settingsMenuItem(labels),
      ],
    },
    {
      label: labels.edit,
      submenu: [
        // Undo and redo go to the map: its history is not the page's own, so the
        // undo / redo roles would not reach it. The map already takes the keys
        // itself; on Windows and Linux the shortcut is shown but not registered,
        // or one press would undo twice.
        {
          label: labels.undo,
          accelerator: 'CmdOrCtrl+Z',
          registerAccelerator: false,
          click: () => {
            const tab = activeMindmapTarget()
            if (tab) sendMindmapMenuCommand(tab.webContents, 'undo')
          },
        },
        {
          label: labels.redo,
          accelerator: isMac ? 'Shift+Cmd+Z' : 'Ctrl+Y',
          registerAccelerator: false,
          click: () => {
            const tab = activeMindmapTarget()
            if (tab) sendMindmapMenuCommand(tab.webContents, 'redo')
          },
        },
        { type: 'separator' },
        { role: 'cut', label: labels.cut },
        { role: 'copy', label: labels.copy },
        { role: 'paste', label: labels.paste },
        { role: 'delete', label: labels.delete },
        { type: 'separator' },
        { role: 'selectAll', label: labels.selectAll },
      ],
    },
    windowMenuTemplate(process.platform, appMenuLabels(currentLang())),
    {
      role: 'help',
      label: tm('menuHelp'),
      submenu: [
        { label: tm('thirdPartyNotices'), click: () => void openThirdPartyNotices() },
        { type: 'separator' },
        ...helpCheckUpdatesItems(appMenuLabels(currentLang())),
        aboutMenuItem(appMenuLabels(currentLang())),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Save As for pdf tabs: write pending edits to the picked path only, then open the copy.
 * Non-destructive: the original file is never written with the copy, and a cancelled
 * dialog changes nothing on disk (dialog first, no flush into the source). The dialog
 * also lists every conversion (pdf-save-as-formats.ts); a converted name never replaces
 * the open PDF's path, title or unsaved state. Markdown and EPUB targets are granted to
 * the view's conversion dialog, which saves pending edits first and then writes there
 * (the File menu's conversions do the same); PNG page images are drawn by the view and
 * written beside the picked name, one per page; Word / PowerPoint / Excel run the File
 * menu's local conversion with the picked name once this flow has ended.
 */
/** In-flight guard (same pattern as exportPdfAsDocxLocal): a re-trigger while the dialog
    or write is active must not start a second flow that overwrites the first one's
    waiter/target grant or clears its autosave pause early */
let savingPdfAs = false

async function savePdfAs(tab = activePdfTarget()): Promise<void> {
  const convert = await savePdfAsPick(tab)
  // after the Save As flow: the conversion saves pending edits, prompts and
  // shows progress on its own, like the File menu item
  if (convert) await convert()
}

async function savePdfAsPick(tab = activePdfTarget()): Promise<(() => Promise<void>) | undefined> {
  const host = pdfHostWindow(tab)
  if (!tab?.filePath || !host || savingPdfAs) return
  savingPdfAs = true
  // Pause renderer autosave for the whole flow: the dialog blurs the window, and a
  // blur-triggered autosave would write the pending edits into the original file
  setPdfSaveAsInFlight(tab.webContents, true)
  try {
    const picked = await showSaveDialogWithMemory(dialog, host, {
      // No extension in the suggestion: the file type chosen in the dialog supplies
      // it. A typed name keeps the extension it was given.
      defaultPath: pdfSaveAsDefaultPath(tab.filePath),
      // PDF first, then every conversion; a name with an unknown extension stays
      // a plain PDF copy
      filters: pdfSaveAsFilters(tm),
    })
    if (picked.canceled || !picked.filePath) return
    // A dialog that does not add the chosen type's extension (some Linux desktops)
    // leaves a bare name: the default type is PDF
    const pickedPath = pdfSaveAsPickedPath(picked.filePath)
    const target = pdfSaveAsTarget({ canceled: false, filePath: pickedPath }, tab.filePath)
    if (!target) return
    const format = pdfSaveAsFormatOf(target)
    if (format === 'md' || format === 'epub') {
      // The path came from this dialog, never from the renderer: grant it to the
      // view's own conversion dialog, which then writes exactly there
      if (!grantPdfStructureTarget(tab.webContents, tab.filePath, target, format)) {
        console.error(`[shell] pdf save as ${format}: target was not granted`)
        await dialog.showMessageBox(host, { type: 'error', message: tm('errPdfSaveAsFailed') })
        return
      }
      requestPdfConvertDialog(tab.webContents, format, target)
      return
    }
    if (format === 'png') {
      // granted in the pdf main process; the view draws the pages and the
      // export writes one file per page beside this name, then reveals them
      if (!requestPdfPageImages(tab.webContents, target)) {
        await dialog.showMessageBox(host, { type: 'error', message: tm('errPdfSaveAsFailed') })
      }
      return
    }
    if (format === 'docx' || format === 'pptx' || format === 'xlsx') {
      const preset = { tab, target }
      return format === 'docx'
        ? () => exportPdfAsDocxLocal(preset)
        : format === 'pptx'
          ? () => exportPdfAsPptxLocal(preset)
          : () => exportPdfAsXlsxLocal(preset)
    }
    // Always ask the renderer: it shows the annotation choices for the copy and,
    // with no pending edits and annotations kept, asks the pdf main process for a
    // byte-identical copy instead of rewriting the file here.
    const outcome = await requestPdfSaveAsOutcome(tab.webContents, target)
    if (outcome === 'cancelled') return
    if (outcome === 'failed') {
      // The renderer's toast carries the detailed reason; this makes a failed
      // copy visible even when the PDF tab is not the focused pane.
      console.error('[shell] pdf save as failed: renderer did not complete the save')
      await dialog.showMessageBox(host, {
        type: 'error',
        message: tm('errPdfSaveAsFailed'),
      })
      return
    }
    openDocumentPath(target)
  } catch (err) {
    console.error('[shell] pdf save as failed:', err)
    showErrorDialog(host, tm('errPdfSaveAsFailed'), err)
  } finally {
    savingPdfAs = false
    setPdfSaveAsInFlight(tab.webContents, false)
  }
}

/**
 * In-flight guard: covers the whole flow (dialogs included) so re-triggering
 * from the menu can never start a second conversion
 */
let exportingPdfDocx = false

/** Save As › Word / PowerPoint / Excel: the tab and the name its dialog already picked */
interface PdfExportPreset {
  tab: { id: string; webContents: WebContents; filePath?: string }
  target: string
}

/**
 * Export as Word for pdf tabs, fully local (pdf2docx P4): flush pending
 * edits, pick the destination, convert in-process via PDFium wasm, write the
 * file and open it in a Docs tab. No login, no credits.
 */
async function exportPdfAsDocxLocal(preset?: PdfExportPreset): Promise<void> {
  const tab = preset?.tab ?? activePdfTarget()
  const host = pdfHostWindow(tab)
  if (!tab?.filePath || !host) return
  if (exportingPdfDocx) {
    void dialog.showMessageBox(host, {
      type: 'info',
      message: tm('pdfDocxBusyMsg'),
    })
    return
  }
  exportingPdfDocx = true
  try {
    if (!(await flushPdfSave(tab.webContents, true))) return
    // Save As already picked the name: no second dialog
    const picked = preset
      ? { canceled: false, filePath: preset.target }
      : await showSaveDialogWithMemory(dialog, host, {
          defaultPath: tab.filePath.replace(/\.pdf$/i, '.docx'),
          filters: [{ name: tm('filterWord'), extensions: ['docx'] }],
        })
    if (picked.canceled || !picked.filePath) return
    // If the destination is already open in a docs tab, close it first (its
    // normal unsaved-changes guard applies) so the converted file opens fresh
    // instead of leaving a stale tab whose next save would clobber the result.
    const staleTabId = tabManager?.findDocsTabByPath(picked.filePath)
    if (staleTabId) {
      await tabManager?.closeTab(staleTabId)
      tabManager?.activateTab(tab.id)
      if (tabManager?.findDocsTabByPath(picked.filePath)) return
    }
    host.setProgressBar(2)
    // encrypted PDFs prompt for the password (P23), looping on wrong entries;
    // null result = user cancelled the prompt → abort silently
    const pdfPath = tab.filePath
    const result = await convertPdfFileToDocxLocalWithPrompt(
      pdfPath,
      (retry) =>
        promptPdfPassword(host, {
          fileName: basename(pdfPath),
          retry,
          busy: false,
          lang: currentLang(),
          strings: {
            title: tm('pdfPwdTitle'),
            prompt: tm('pdfPwdPrompt'),
            retryPrompt: tm('pdfPwdRetryPrompt'),
            ok: tm('pdfPwdOk'),
            cancel: tm('btnCancel'),
            verifying: tm('pdfPwdVerifying'),
            label: tm('pdfPwdLabel'),
            placeholder: tm('pdfPwdPlaceholder'),
            show: tm('pdfPwdShow'),
            hide: tm('pdfPwdHide'),
          },
        }),
      (page, total) => {
        if (host && !host.isDestroyed() && total > 0) {
          host.setProgressBar(page / total)
        }
      },
    )
    if (result === null) return
    await atomicWriteFile(picked.filePath, result.docx)

    // degrade transparency (plan §7.6 dual-track split): whole scan → say so
    // once; individual image-fallback pages → name them;
    // OCR-recovered scans ('ocr') are SUCCESSES — announce the recovery (the
    // user should proofread machine-read text), never the image-export notice
    const ocrPages = result.pageResults.filter((r) => r.status === 'ocr').map((r) => r.page)
    const imagePages = result.pageResults
      .filter((r) => r.status !== 'ok' && r.status !== 'ocr')
      .map((r) => r.page)
    if (result.scannedDocument) {
      await dialog.showMessageBox(host, {
        type: 'info',
        message: tm('pdfDocxLocalScannedMsg'),
        detail: tm('pdfDocxLocalScannedDetail'),
      })
    } else if (imagePages.length > 0 && ocrPages.length > 0) {
      // mixed documents surface BOTH facts in one dialog: which pages shipped
      // as images and which carry machine-read text the user should proofread
      await dialog.showMessageBox(host, {
        type: 'info',
        message: tm('pdfDocxLocalDegradedMsg'),
        detail:
          tm('pdfDocxLocalDegradedDetail', { pages: imagePages.join(', ') }) +
          '\n\n' +
          tm('pdfDocxLocalOcrDetail', { pages: ocrPages.join(', ') }),
      })
    } else if (imagePages.length > 0) {
      await dialog.showMessageBox(host, {
        type: 'info',
        message: tm('pdfDocxLocalDegradedMsg'),
        detail: tm('pdfDocxLocalDegradedDetail', { pages: imagePages.join(', ') }),
      })
    } else if (ocrPages.length > 0) {
      await dialog.showMessageBox(host, {
        type: 'info',
        message: tm('pdfDocxLocalOcrMsg'),
        detail: tm('pdfDocxLocalOcrDetail', { pages: ocrPages.join(', ') }),
      })
    }
    openDocumentPath(picked.filePath)
  } catch (err) {
    if (host && !host.isDestroyed()) {
      // structured load failures (P22): password-protected / damaged PDFs get
      // a human-readable explanation instead of the raw PDFium error string
      const detail =
        err instanceof PdfLoadError
          ? err.code === 'password-required'
            ? tm('pdfDocxLocalEncryptedDetail')
            : err.code === 'unsupported'
              ? // certificate-based or otherwise unsupported security (FPDF
                // error 5): a hard PDFium boundary — no password can open it
                // locally, so the message must NOT suggest one (P24 C)
                tm('pdfDocxLocalUnsupportedEncDetail')
              : tm('pdfDocxLocalCorruptDetail')
          : err instanceof Error
            ? err.message
            : String(err)
      void dialog.showMessageBox(host, {
        type: 'error',
        message: tm('pdfDocxFailedMsg'),
        detail,
      })
    }
  } finally {
    // the prompt window may still be open when the loop exits through cancel
    // or a non-password error thrown mid-retry
    closePdfPasswordDialog()
    exportingPdfDocx = false
    if (host && !host.isDestroyed()) host.setProgressBar(-1)
  }
}

/**
 * Export as PowerPoint for pdf tabs, fully local (pdf2pptx P25): flush
 * pending edits, pick the destination, convert in-process via PDFium wasm,
 * write the file and open it in a Slides tab. No login, no credits. Shares
 * the in-flight guard with the Word exports so pdfium never runs two
 * conversions at once.
 */
async function exportPdfAsPptxLocal(preset?: PdfExportPreset): Promise<void> {
  const tab = preset?.tab ?? activePdfTarget()
  const host = pdfHostWindow(tab)
  if (!tab?.filePath || !host) return
  if (exportingPdfDocx) {
    void dialog.showMessageBox(host, {
      type: 'info',
      message: tm('pdfPptxBusyMsg'),
    })
    return
  }
  exportingPdfDocx = true
  try {
    if (!(await flushPdfSave(tab.webContents, true))) return
    // Save As already picked the name: no second dialog
    const picked = preset
      ? { canceled: false, filePath: preset.target }
      : await showSaveDialogWithMemory(dialog, host, {
          defaultPath: tab.filePath.replace(/\.pdf$/i, '.pptx'),
          filters: [{ name: tm('filterPpt'), extensions: ['pptx'] }],
        })
    if (picked.canceled || !picked.filePath) return
    // same stale-tab handling as the Word export (see exportPdfAsDocxLocal),
    // against the slides tab that may already show the destination file
    const staleTabId = tabManager?.findSlidesTabByPath(picked.filePath)
    if (staleTabId) {
      await tabManager?.closeTab(staleTabId)
      tabManager?.activateTab(tab.id)
      if (tabManager?.findSlidesTabByPath(picked.filePath)) return
    }
    host.setProgressBar(2)
    // encrypted PDFs prompt for the password (P23), looping on wrong entries;
    // null result = user cancelled the prompt → abort silently
    const pdfPath = tab.filePath
    const result = await convertPdfFileToPptxLocalWithPrompt(
      pdfPath,
      (retry) =>
        promptPdfPassword(host, {
          fileName: basename(pdfPath),
          retry,
          busy: false,
          lang: currentLang(),
          strings: {
            title: tm('pdfPwdTitle'),
            prompt: tm('pdfPwdPrompt'),
            retryPrompt: tm('pdfPwdRetryPrompt'),
            ok: tm('pdfPwdOk'),
            cancel: tm('btnCancel'),
            verifying: tm('pdfPwdVerifying'),
            label: tm('pdfPwdLabel'),
            placeholder: tm('pdfPwdPlaceholder'),
            show: tm('pdfPwdShow'),
            hide: tm('pdfPwdHide'),
          },
        }),
      (page, total) => {
        if (host && !host.isDestroyed() && total > 0) {
          host.setProgressBar(page / total)
        }
      },
    )
    if (result === null) return
    await atomicWriteFile(picked.filePath, result.pptx)

    // degrade transparency (same split as the Word export): whole scan vs
    // individual image-fallback pages
    const imagePages = result.pageResults.filter((r) => r.status !== 'ok').map((r) => r.page)
    if (result.scannedDocument) {
      await dialog.showMessageBox(host, {
        type: 'info',
        message: tm('pdfDocxLocalScannedMsg'),
        detail: tm('pdfPptxLocalScannedDetail'),
      })
    } else if (imagePages.length > 0) {
      await dialog.showMessageBox(host, {
        type: 'info',
        message: tm('pdfDocxLocalDegradedMsg'),
        detail: tm('pdfDocxLocalDegradedDetail', { pages: imagePages.join(', ') }),
      })
    }
    openDocumentPath(picked.filePath)
  } catch (err) {
    if (host && !host.isDestroyed()) {
      // structured load failures (P22): same explanations as the Word export
      const detail =
        err instanceof PdfLoadError
          ? err.code === 'password-required'
            ? tm('pdfDocxLocalEncryptedDetail')
            : err.code === 'unsupported'
              ? tm('pdfDocxLocalUnsupportedEncDetail')
              : tm('pdfDocxLocalCorruptDetail')
          : err instanceof Error
            ? err.message
            : String(err)
      void dialog.showMessageBox(host, {
        type: 'error',
        message: tm('pdfPptxFailedMsg'),
        detail,
      })
    }
  } finally {
    closePdfPasswordDialog()
    exportingPdfDocx = false
    if (host && !host.isDestroyed()) host.setProgressBar(-1)
  }
}

/**
 * Export as Excel for pdf tabs, fully local (pdf2xlsx P26): flush pending
 * edits, pick the destination, convert in-process via PDFium wasm, write the
 * file and open it in a Sheets tab. No login, no credits. Shares the
 * in-flight guard with the Word/PowerPoint exports so pdfium never runs two
 * conversions at once.
 */
async function exportPdfAsXlsxLocal(preset?: PdfExportPreset): Promise<void> {
  const tab = preset?.tab ?? activePdfTarget()
  const host = pdfHostWindow(tab)
  if (!tab?.filePath || !host) return
  if (exportingPdfDocx) {
    void dialog.showMessageBox(host, {
      type: 'info',
      message: tm('pdfXlsxBusyMsg'),
    })
    return
  }
  exportingPdfDocx = true
  try {
    if (!(await flushPdfSave(tab.webContents, true))) return
    // Save As already picked the name: no second dialog
    const picked = preset
      ? { canceled: false, filePath: preset.target }
      : await showSaveDialogWithMemory(dialog, host, {
          defaultPath: tab.filePath.replace(/\.pdf$/i, '.xlsx'),
          filters: [{ name: tm('filterExcel'), extensions: ['xlsx'] }],
        })
    if (picked.canceled || !picked.filePath) return
    // same stale-tab handling as the Word export (see exportPdfAsDocxLocal),
    // against the sheets tab that may already show the destination file
    const staleTabId = tabManager?.findSheetsTabByPath(picked.filePath)
    if (staleTabId) {
      await tabManager?.closeTab(staleTabId)
      tabManager?.activateTab(tab.id)
      if (tabManager?.findSheetsTabByPath(picked.filePath)) return
    }
    host.setProgressBar(2)
    // encrypted PDFs prompt for the password (P23), looping on wrong entries;
    // null result = user cancelled the prompt → abort silently
    const pdfPath = tab.filePath
    const result = await convertPdfFileToXlsxLocalWithPrompt(
      pdfPath,
      (retry) =>
        promptPdfPassword(host, {
          fileName: basename(pdfPath),
          retry,
          busy: false,
          lang: currentLang(),
          strings: {
            title: tm('pdfPwdTitle'),
            prompt: tm('pdfPwdPrompt'),
            retryPrompt: tm('pdfPwdRetryPrompt'),
            ok: tm('pdfPwdOk'),
            cancel: tm('btnCancel'),
            verifying: tm('pdfPwdVerifying'),
            label: tm('pdfPwdLabel'),
            placeholder: tm('pdfPwdPlaceholder'),
            show: tm('pdfPwdShow'),
            hide: tm('pdfPwdHide'),
          },
        }),
      (page, total) => {
        if (host && !host.isDestroyed() && total > 0) {
          host.setProgressBar(page / total)
        }
      },
    )
    if (result === null) return
    await atomicWriteFile(picked.filePath, result.xlsx)

    // degrade transparency: pages that could not become cells got a notice
    // row on their worksheet instead of an image (a spreadsheet has none)
    const noticePages = result.pageResults.filter((r) => r.status !== 'ok').map((r) => r.page)
    if (result.scannedDocument) {
      await dialog.showMessageBox(host, {
        type: 'info',
        message: tm('pdfDocxLocalScannedMsg'),
        detail: tm('pdfXlsxLocalScannedDetail'),
      })
    } else if (noticePages.length > 0) {
      await dialog.showMessageBox(host, {
        type: 'info',
        message: tm('pdfXlsxLocalSkippedMsg'),
        detail: tm('pdfXlsxLocalSkippedDetail', { pages: noticePages.join(', ') }),
      })
    }
    openDocumentPath(picked.filePath)
  } catch (err) {
    if (host && !host.isDestroyed()) {
      // structured load failures (P22): same explanations as the Word export
      const detail =
        err instanceof PdfLoadError
          ? err.code === 'password-required'
            ? tm('pdfDocxLocalEncryptedDetail')
            : err.code === 'unsupported'
              ? tm('pdfDocxLocalUnsupportedEncDetail')
              : tm('pdfDocxLocalCorruptDetail')
          : err instanceof Error
            ? err.message
            : String(err)
      void dialog.showMessageBox(host, {
        type: 'error',
        message: tm('pdfXlsxFailedMsg'),
        detail,
      })
    }
  } finally {
    closePdfPasswordDialog()
    exportingPdfDocx = false
    if (host && !host.isDestroyed()) host.setProgressBar(-1)
  }
}

// The pdf renderer's converter dropdown funnels into the same local conversion
// flows as the File menu items (dialogs, password prompt, in-flight guard included)
ipcMain.handle(PDF_CHANNELS.convertOffice, async (e, format: unknown) => {
  // only the active pdf tab may trigger a conversion (its file is the source)
  if (activePdfTarget()?.webContents.id !== e.sender.id) return
  if (format === 'docx') await exportPdfAsDocxLocal()
  else if (format === 'xlsx') await exportPdfAsXlsxLocal()
  else if (format === 'pptx') await exportPdfAsPptxLocal()
  else if (format === 'hwp') await openPdfAsHwp()
})

/**
 * Converter › HWP (decision 0116): the PDF opens in a new, untitled Hangul tab, where
 * the editor's own PDF import asks how to lay it out and converts it in the tab. The
 * PDF is copied first (pending edits flushed) so the tab reads a file of its own; the
 * copy goes with the tab, and the first save asks where to put the .hwp/.hwpx.
 */
async function openPdfAsHwp(): Promise<void> {
  const tab = activePdfTarget()
  if (!tab?.filePath || !tabManager) return
  if (!(await flushPdfSave(tab.webContents, true))) return
  openPdfCopyAsHwp(tab.filePath)
}

/** The copy of `pdfPath` as a new, untitled Hangul tab that imports it; the copy goes with the tab. */
function openPdfCopyAsHwp(pdfPath: string): void {
  if (!tabManager) return
  const dir = join(app.getPath('temp'), 'seuoffice-pdf-imports', randomUUID())
  const baseName = basename(pdfPath).replace(/\.pdf$/i, '')
  let tabId: string
  try {
    mkdirSync(dir, { recursive: true })
    const copy = join(dir, basename(pdfPath))
    copyFileSync(pdfPath, copy)
    tabId = tabManager.openHwpTab(copy, { untitledCopy: { title: baseName, importedPdf: true } })
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
  const contents = tabManager.webContentsForTab(tabId)
  if (contents) contents.once('destroyed', () => rmSync(dir, { recursive: true, force: true }))
  else rmSync(dir, { recursive: true, force: true })
}

/**
 * Hangul editor › File › Import PDF (decision 0116): the same conversion started from
 * the Hangul side. The embedded editor's own Open is off, so the shell asks for the PDF
 * and opens it as the converter does: a new, untitled Hangul tab imports a copy, and the
 * document of the tab the menu was used in stays as it is. The PDF on disk is what is
 * read, as with any file picked in Open.
 */
async function importPdfAsHwp(): Promise<void> {
  const win = shellWindow ?? BrowserWindow.getFocusedWindow()
  if (!win || !tabManager) return
  const result = await showOpenDialogWithMemory(dialog, win, {
    filters: [{ name: tm('filterPdf'), extensions: ['pdf'] }],
    properties: ['openFile'],
  })
  const pdfPath = result.canceled ? undefined : result.filePaths[0]
  if (!pdfPath) return
  try {
    openPdfCopyAsHwp(pdfPath)
  } catch (err) {
    dialog.showErrorBox(basename(pdfPath), err instanceof Error ? err.message : String(err))
  }
}

function openThirdPartyNotices(): Promise<string> {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'THIRD-PARTY-NOTICES.txt')
    : join(app.getAppPath(), 'build', 'THIRD-PARTY-NOTICES.txt')
  return shell.openPath(path)
}

/** every module's File menu gets a way back to the launcher */
function installBackToHomeItems(): void {
  const backToHomeItem: MenuItemConstructorOptions = {
    label: tm('backToHome'),
    accelerator: 'Shift+CmdOrCtrl+H',
    click: () => tabManager?.openHomeTab(),
  }
  setDocsExtraFileMenuItems([backToHomeItem])
  setSheetsExtraFileMenuItems([backToHomeItem])
  setSlidesExtraFileMenuItems([backToHomeItem])
}

/** the editors that build their own menus show the same provenance entries (spec 8.2, 9) */
function installDocumentLinkMenuItems(): void {
  setDocsDocumentLinkMenuItems(() => documentLinkFileMenuItems('docs'))
  setSheetsDocumentLinkMenuItems(() => documentLinkFileMenuItems('sheets'))
  setSlidesDocumentLinkMenuItems(() => documentLinkFileMenuItems('slides'))
}

/** The Settings view lives in the Home tab, so every app's menu points here:
 *  ⌘, lands on it from anywhere in the suite. The window comes back first if
 *  it was hidden or minimized, and asking again re-opens the same panel —
 *  the renderer keeps one. */
function openSettingsView(): void {
  const win = shellWindow ?? BrowserWindow.getFocusedWindow()
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  tabManager?.openHomeTab()
  win.webContents.send(HOME_CHANNELS.openSettings, { section: 'general' })
}

function installDockMenu(): void {
  if (process.platform !== 'darwin') return
  app.dock?.setMenu(
    Menu.buildFromTemplate([
      { label: tm('menuHome'), click: () => tabManager?.openHomeTab() },
      ...newDocumentMenuItems({ only: ['docx', 'xlsx', 'pptx', 'md', 'pdf'] }),
    ]),
  )
}

// On mainland-China networks the main process's Node fetch (undici) bypasses the system proxy,
// so direct calls to overseas LLM/image-search APIs time out or get region-blocked (403).
// Prefer proxy env vars (terminal launch); a packaged app launched from Finder inherits no shell
// env vars, so fall back to the system HTTP proxy. The renderer uses Chromium's system proxy and
// is unaffected. Same bootstrap as slides-main startSlidesStandalone.
async function installMainProcessProxy(): Promise<void> {
  let proxyUrl = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
  ].find((v) => v && /^https?:\/\//.test(v))
  if (!proxyUrl) {
    try {
      // PAC/rule proxies answer per-host; one dispatcher serves every main-process
      // request (AI key providers, web search, image fetches), so probe with the
      // project's own host as a neutral public destination
      const resolved = await session.defaultSession.resolveProxy(GITHUB_REPO_URL)
      const m = /PROXY\s+([^;\s]+)/.exec(resolved)
      if (m) proxyUrl = `http://${m[1]}`
    } catch {
      /* no system proxy */
    }
  }
  if (!proxyUrl) return
  try {
    const { setGlobalDispatcher } = await import('undici')
    // loopback stays direct: a Custom provider on 127.0.0.1 must not ride
    // the proxy as an absolute-form request (#2084)
    setGlobalDispatcher(await createMainProcessProxyDispatcher(proxyUrl))
    // strip user:pass credentials before logging
    console.log('[proxy] main-process fetch via', proxyUrl.replace(/\/\/[^@/]*@/, '//***@'))
  } catch (e) {
    console.warn('[proxy] failed to set proxy dispatcher:', e)
  }
}

// ---- lifecycle (the shell is the only owner) ----

let pendingLaunchPaths = collectLaunchPaths(process.argv)
let controlServer: ControlServer | null = null

// show() does not un-minimize, and on macOS ⌘W destroys the shell window while the
// app keeps running — either way a file opened from Finder would land out of sight.
function revealShellWindow(): void {
  if (!shellWindow) createShellWindow()
  if (shellWindow?.isMinimized()) shellWindow.restore()
  shellWindow?.show()
  shellWindow?.focus()
}

function openLaunchPaths(paths: readonly string[]): void {
  let opened = false
  for (const filePath of paths) opened = openDocumentPath(filePath) || opened
  if (!opened) tabManager?.openHomeTab()
}

// On macOS a file opened from Finder is not in argv; it arrives via the open-file event (before ready).
// If another instance already holds the lock, this process exits, and the path must ride along in
// the lock request's additionalData to the surviving instance — so the lock request is deferred
// until ready, after the path is known.
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (!app.isReady()) {
    if (!pendingLaunchPaths.includes(filePath)) pendingLaunchPaths.push(filePath)
    return
  }
  revealShellWindow()
  // the launch list is still up: open it once the restored tabs are settled
  if (launchListGate.blocking()) deferredLaunchPaths.push(filePath)
  else openLaunchPaths([filePath])
})

app.on('second-instance', (_event, argv, _cwd, additionalData) => {
  const paths = collectLaunchPaths(argv, additionalData)
  revealShellWindow()
  if (launchListGate.blocking()) deferredLaunchPaths.push(...paths)
  else openLaunchPaths(paths)
})

installNavigationGuard(app)
// before app ready: no session, the default one included, exists without its answer
installShellPermissionGuard({
  microphoneOpen: slidesMicrophoneOpen,
  rendererDir: join(__dirname, '../renderer'),
})
installContextMenu(app, () => contextMenuLabels(currentLang()))
registerAiIpc()
ipcMain.handle('ai:open-model-settings', () => {
  const win = shellWindow
  if (!win || win.isDestroyed()) return
  // the request may come from a detached window or while the shell is minimized
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  tabManager?.openHomeTab()
  win.webContents.send(HOME_CHANNELS.openSettings, { section: 'aiModel' })
})
// the slides template gallery's "Change" beside the default fonts (decision 0115)
ipcMain.handle('slides:open-font-settings', () => {
  const win = shellWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  tabManager?.openHomeTab()
  win.webContents.send(HOME_CHANNELS.openSettings, { section: 'general', field: 'slidesAiFonts' })
})
// Model file naming. Registered here beside the other AI wiring so every
// window type can reach it.
registerAiNamingIpc(() => currentLang())
registerProjectIpc()
registerDocsIpc()
registerHomeIpc()
registerProjectFolderChannels()
registerIntegrationsIpc({
  settingsPath: APP_SETTINGS_PATH,
  window: () => shellWindow,
  cliDir: app.isPackaged
    ? join(process.resourcesPath, 'cli')
    : join(APPS_ROOT, '..', 'packages', 'cli', 'bin'),
  skillPath: app.isPackaged
    ? join(process.resourcesPath, 'cli', 'skills', 'seuoffice', 'SKILL.md')
    : join(APPS_ROOT, '..', 'skills', 'seuoffice', 'SKILL.md'),
  cliPackageJson: app.isPackaged
    ? join(process.resourcesPath, 'cli', 'package.json')
    : join(APPS_ROOT, '..', 'packages', 'cli', 'package.json'),
})
registerResultStoreIpc(ipcMain, () => app.getPath('userData'))
registerTabsIpc()
registerSplitIpc()
registerDroppedFilesIpc()
registerPdfStructureIpc()
registerPdfConvertUiIpc({
  findMarkdownTab: (path) => tabManager?.findMarkdownTabByPath(path),
  closeTab: async (tabId) => {
    await tabManager?.closeTab(tabId)
  },
  activateView: (viewId) => {
    const tabId = tabManager?.tabIdForWebContents(viewId)
    if (tabId) tabManager?.activateTab(tabId)
  },
  openDocument: (path) => openDocumentPath(path),
})

// The person's skills (settings → skills, the AI windows' `/` list and skill
// reads, skill cards, the agent session's skills). Writes go only to
// ~/.seuoffice/skills; removing is the OS trash; GitHub only on request.
const builtinSkillsDir = (): string =>
  builtinSkillsDirFor({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  })
const userSkills = createUserSkillsService({
  homeDir: () => homedir(),
  builtinDir: builtinSkillsDir,
  settingsPath: APP_SETTINGS_PATH,
  tempDir: () => join(tmpdir(), 'seuoffice-skills'),
  trash: (path) => shell.trashItem(path),
  // Node's fetch: no browser cookies; the core sets no-redirect and no-credentials per request
  fetch: (url, init) => fetch(url, init),
})
/** Bring the main window forward with the settings open on the skills page */
function openSkillsSettings(): void {
  const win = shellWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  tabManager?.openHomeTab()
  win.webContents.send(HOME_CHANNELS.openSettings, { section: 'skills' })
}
const userSkillsIpc = registerUserSkillsIpc({
  service: userSkills,
  // the settings screen; the agent window only for the install preview a session proposed
  canManage: userSkillsManageGate({
    isMainWindow: (sender) =>
      !!shellWindow && !shellWindow.isDestroyed() && sender === shellWindow.webContents,
    isAgentWindow: (sender) => isAgentWindowContents(sender),
  }),
  openSettings: openSkillsSettings,
  agentNoticeDue: () => agentSkillNoticeDue(APP_SETTINGS_PATH()),
  markAgentNoticeSeen: () => markAgentSkillNoticeSeen(APP_SETTINGS_PATH()),
})

// Template copies in new tabs (spec 5.6, 5.7): a skill template's copy, or the
// current document's for a template preview, opens as a new untitled document
// of its editor; the request is handed to that tab's AI panel, which runs it
// through its own send gate. The skill folder is only read here.
const templateTabs = createTemplateTabs({
  makeCopyDir: async () => {
    const dir = join(app.getPath('temp'), 'seuoffice-template-copies', randomUUID())
    mkdirSync(dir, { recursive: true })
    return dir
  },
  writeFile: (path, bytes) => atomicWriteFile(path, Buffer.from(bytes)),
  readFile: async (path) => new Uint8Array(readFileSync(path)),
  removeDir: async (dir) => rmSync(dir, { recursive: true, force: true }),
  templateFileOf: (id) => userSkills.templateFile(id),
  openCopy: (copy) => openTemplateCopyTab(copy),
  // a skill template's copy follows the project of the panel that asked (spec 6)
  copyOpenedFor: (contents, openerId) =>
    followOpenerProject(contents, { kind: 'window', webContentsId: openerId }),
  // "Open a new document from the template" in a document with content: the
  // asking tab's file goes along only when it is saved without unsaved changes
  // (docs/security.md "저장하지 않은 파일은 읽지 않는다")
  currentDocumentOf: async (openerId) => {
    const filePath =
      tabManager?.describeWebContents(openerId)?.filePath ?? detachedDocumentFor(openerId)?.filePath
    if (!filePath) return 'unsaved'
    return (await fileHasUnsavedChanges(filePath)) ? 'unsaved' : { path: filePath }
  },
  focusTab: (tabId) => {
    const manager = tabManager
    if (!manager || !manager.list().some((tab) => tab.id === tabId)) return false
    const win = shellWindow
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    manager.activateTab(tabId)
    return true
  },
  newId: () => randomUUID(),
  now: () => Date.now(),
})
registerTemplateTabsIpc(templateTabs)

/** A template copy's new untitled tab: sheets here (its backing workbook), the others in the tab manager */
async function openTemplateCopyTab(copy: TemplateCopy): Promise<OpenedCopyTab | null> {
  const manager = tabManager
  if (!manager) return null
  if (copy.editor !== 'sheets') return manager.openTemplateCopy(copy)
  // like "New spreadsheet": a backing workbook in its own temp folder, never a
  // file of the person's until the first save asks where; a .csv/.tsv/.xls
  // copy is converted there when the tab opens it
  const extension = extname(copy.fileName).toLowerCase()
  const saveExtension = extension === '.xlsm' ? '.xlsm' : '.xlsx'
  const stem = copy.fileName.slice(0, copy.fileName.length - extension.length) || copy.title
  const dir = newFileDir('sheet')
  let suggestedPath = uniquePathIn(dir, `${stem}${saveExtension}`)
  for (let i = 2; sheetsSuggestedPathTaken(suggestedPath); i++) {
    suggestedPath = uniquePathIn(dir, `${stem} ${i}${saveExtension}`)
  }
  const tempDir = join(app.getPath('temp'), 'seuoffice-imports', randomUUID())
  mkdirSync(tempDir, { recursive: true })
  const backingPath = join(tempDir, `${stem}${extension}`)
  markSheetsUnsavedNew(backingPath, suggestedPath, tempDir)
  try {
    await atomicWriteFile(backingPath, Buffer.from(copy.bytes))
  } catch (err) {
    unmarkSheetsUnsavedNew(backingPath)
    rmSync(tempDir, { recursive: true, force: true })
    throw err
  }
  const tabId = manager.openSheetsTab(backingPath)
  startQueuedWorkbookNudge()
  const contents = manager.webContentsForTab(tabId)
  return contents ? { tabId, contents } : null
}

// sheets' project:resolveChat goes through the handler registered by docs-main; the sessionId reverse lookup hooks in here
setSessionPathResolver(resolveSheetsSessionPath)

/** Dev-only pid marker for the takeover below; scoped to userData like the lock itself. */
const devPidFile = () => join(app.getPath('userData'), 'dev-instance.pid')

/** Hidden-window exporters, one per editor module (HEADLESS_TARGETS says which formats each takes). */
const headlessExporters: HeadlessExporters = {
  // the request stays with the diagram exporter: docs and html take a timeout fourth
  docs: (input, outPath, format) => exportDocsHeadless(input, outPath, format),
  sheets: (input, outPath) => exportSheetsPdfHeadless(input, outPath),
  slides: (input, outPath) => exportSlidesPdfHeadless(input, outPath),
  markdown: (input, outPath) => exportMarkdownPdfHeadless(input, outPath),
  html: (input, outPath, format) => exportHtmlHeadless(input, outPath, format),
  hwp: (input, outPath) => exportHwpPdfHeadless(input, outPath),
  diagram: exportDiagramHeadless,
}

/** a marked Word document's HTML or Markdown: the bundled CLI's conversion, a placeholder for each hidden span */
const headlessPlaceholderExport: HeadlessPlaceholderExport = async (input, outPath, format) => {
  const result = await bundledCliRunner().run(
    ['convert', input, '--to', format, '--out', outPath, '--force'],
    { timeoutMs: 300_000 },
  )
  if (result.ok) return
  const message =
    result.json && 'message' in result.json ? result.json.message : result.stderr.trim()
  throw new Error(message || `the conversion to ${format} failed`)
}

/**
 * The whole `--headless-export` run: no shell window, no menus, no updater,
 * no single-instance lock (a GUI instance may well be running). Prints
 * exactly one line and exits with the seuoffice convention (0/1/2/3).
 */
async function runHeadlessExportEntry(
  parsed: Exclude<HeadlessArgvParse, { kind: 'none' }>,
): Promise<void> {
  const outcome =
    parsed.kind === 'error'
      ? ({ ok: false, code: HEADLESS_EXIT.badArgs, message: parsed.message } as const)
      : await runHeadlessExport(
          parsed.request,
          headlessExporters,
          undefined,
          headlessPlaceholderExport,
        )
  const json = parsed.kind === 'error' ? parsed.json : parsed.request.json
  stopSheetsSidecar()
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy()
  // Writing to a pipe can finish asynchronously, and app.exit() would cut the
  // envelope off mid-line; wait for the flush (but never longer than 2s).
  const line = formatHeadlessEnvelope(outcome, json) + '\n'
  await new Promise<void>((resolve) => {
    const bail = setTimeout(resolve, 2000)
    process.stdout.write(line, () => {
      clearTimeout(bail)
      resolve()
    })
  })
  // app.quit() always exits 0; the seuoffice envelope needs the real code, and
  // every teardown this run owns has already happened.
  app.exit(headlessExitCode(outcome))
}

app.whenReady().then(async () => {
  // safeStorage works only once the app is ready: keys read before this read as empty
  const secretCodec = safeStorageCodec(safeStorage, process.platform, () =>
    sealingKeyOnDisk(join(app.getPath('userData'), 'Local State')),
  )
  setAiSecretCodec(secretCodec)
  if (revealSecretsRun) {
    app.exit(await runRevealEntry(secretCodec))
    return
  }
  // the editors take the ceiling before anything can be opened: the headless
  // export opens documents too
  setDelimitedImportLimit(currentCsvImportLimitMb() * 1024 * 1024)
  installRendererProtocol({
    docs: join(DOCS_OUT, 'renderer'),
    sheets: join(SHEETS_OUT, 'renderer'),
    slides: join(SLIDES_OUT, 'renderer'),
    pdf: join(PDF_OUT, 'renderer'),
    markdown: join(MARKDOWN_OUT, 'renderer'),
    html: join(HTML_OUT, 'renderer'),
    mindmap: join(MINDMAP_OUT, 'renderer'),
    hwp: join(HWP_OUT, 'renderer'),
    epub: join(EPUB_OUT, 'renderer'),
    // the diagram tab's own partition gets the same root from the editor (diagram-session.ts)
    diagram: join(DIAGRAM_OUT, 'renderer'),
    // the manual shares the shell's own renderer bundle (help mode)
    help: join(__dirname, '../renderer'),
  })
  // the open books' pictures, styles and fonts (only entries of a book a tab has open)
  registerEpubAssetProtocol()
  if (headlessArgv.kind !== 'none') {
    await runHeadlessExportEntry(headlessArgv)
    return
  }
  // first scan waits for the windows to come up; later ones follow folder changes.
  // Past the headless branch: an export that outlasts the wait must not start
  // walking the user's folders into the search index.
  setTimeout(() => ensureFileIndexer()?.refresh(), 4000)
  const lockData = () =>
    pendingLaunchPaths.length > 0
      ? { launchPath: pendingLaunchPaths[0], launchPaths: pendingLaunchPaths }
      : {}
  let hasLock = app.requestSingleInstanceLock(lockData())
  if (!hasLock && !app.isPackaged) {
    // Dev watch restart: electron-vite SIGTERMs the previous instance and spawns this
    // one immediately. Chromium turns that SIGTERM into a graceful quit (Node's
    // process.on('SIGTERM') never fires in the main process), and the quit can wedge
    // in the close-confirmation flow — the zombie then keeps the single-instance lock,
    // this instance quits, and electron-vite's on-close handler exits with it, killing
    // the renderer dev server (blank shell window until a manual dev restart).
    // The previous instance is doomed either way: kill it and take over the lock.
    try {
      const oldPid = Number(readFileSync(devPidFile(), 'utf-8').trim())
      if (Number.isFinite(oldPid) && oldPid > 0 && oldPid !== process.pid) {
        // pid-recycling guard: only kill if that pid is still an Electron process
        const cmd = execSync(`ps -o command= -p ${oldPid}`).toString()
        if (cmd.includes('Electron')) process.kill(oldPid, 'SIGKILL')
      }
    } catch {
      // no previous instance recorded / already gone (ps exits non-zero)
    }
    for (let i = 0; i < 20 && !hasLock; i++) {
      await new Promise((r) => setTimeout(r, 150))
      hasLock = app.requestSingleInstanceLock(lockData())
    }
  }
  if (!hasLock) {
    app.quit()
    return
  }
  // a subscription CLI a force-killed previous run left behind is ended, then
  // this run records the ones it starts (userData is final by now)
  void initSubscriptionChildTracking(app.getPath('userData')).catch(() => undefined)
  // keys an earlier version (or a hand edit) left plain are sealed once this run holds the lock;
  // on the very first run the key is not on disk yet, so this only makes Chromium create it and
  // the keys are sealed on a later save or the next start
  try {
    if (process.platform === 'win32' && safeStorage.isEncryptionAvailable()) {
      safeStorage.encryptString('')
    }
    sealStoredAiSettings(join(app.getPath('userData'), 'ai-settings.json'))
    const storedSearch = readAppSettings(APP_SETTINGS_PATH()).fileSearch
    if (fileSearchHoldsPlainKeys(storedSearch)) {
      const sealed = sealFileSearchKeys(readFileSearchSettings())
      if (!fileSearchHoldsPlainKeys(sealed))
        writeAppSetting(APP_SETTINGS_PATH(), 'fileSearch', sealed)
    }
  } catch {
    // an unwritable data folder keeps the plain file; the next save tries again
  }
  // a registry left by a crashed instance must not block seuoffice writes
  ownsOpenDocumentsRegistry = true
  publishOpenDocuments(OPEN_DOCUMENTS_PATH(), [])
  if (!app.isPackaged) {
    try {
      writeFileSync(devPidFile(), String(process.pid))
    } catch {
      // best-effort: without the marker the next restart just retries the lock
    }
  }

  void installMainProcessProxy()
  app.setAccessibilitySupportEnabled(true)
  // Settle the shared uiLang from saved settings BEFORE any tab renderer can
  // ask 'app:get-language': the editor handlers return the i18n module's
  // mutable lang, whose 'zh' default otherwise wins the race for whichever
  // tab loads first (e.g. sheets booting in Chinese while docs shows English).
  currentLang()
  // native menus/dialogs/scrollbars follow the persisted theme from first paint
  nativeTheme.themeSource = currentTheme()
  // off the startup path: a symlink / registry write nobody is waiting for
  setTimeout(() => installCliLinkBestEffort(APP_SETTINGS_PATH()), 3000)
  startSheetsCaptureServer()
  registerOutboundIpc({
    internetToolsOn: () => readStoredAiSettings().internetTools !== false,
    lang: () => currentLang(),
    window: () => shellWindow,
  })
  driveService = registerDriveIpc({
    userData: () => app.getPath('userData'),
    settingsPath: APP_SETTINGS_PATH,
    lang: () => currentLang(),
    window: () => shellWindow,
    // a Drive copy opens like any local file; the Drive service already chose the copy
    openPath: (path) => routeDocumentPath(path),
    isOpen: (path) =>
      (tabManager?.openFilePaths() ?? []).some(
        (open) => resolve(open).toLowerCase() === resolve(path).toLowerCase(),
      ),
    parse: (path) => parseFileToText(path),
    freeAi: () => freeAiInUse(readStoredAiSettings()),
    documentOf: (id) => tabManager?.describeWebContents(id)?.filePath ?? null,
  })
  // The person's own MCP servers: one connection per server for every window;
  // Settings changes them through a channel only the shell window may use.
  mcpHub = startMcpHub({
    lang: () => currentLang(),
    shellWindow: () => shellWindow,
    openIntegrations: () => {
      const win = shellWindow
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      tabManager?.openHomeTab()
      win.webContents.send(HOME_CHANNELS.openSettings, { section: 'integrations' })
    },
  })
  // The "Attach documents" window: an editor's AI panel asks the shell for the
  // documents it already knows, and the shell hands back the paths it ticked.
  // One window at a time, over the window that asked. The same list, built for
  // the asking editor, answers the AI panel's `@` list.
  createDocPicker({
    askerFor: (wcId) =>
      resolveDocAsker(wcId, {
        tabFor: (id) => {
          const tabId = tabManager?.tabIdForWebContents(id)
          if (!tabId) return undefined
          const filePath = tabManager?.describeWebContents(id)?.filePath
          return { id: tabId, ...(filePath ? { filePath } : {}) }
        },
        split: () => tabManager?.splitState() ?? null,
        detachedFor: (id) => detachedDocumentFor(id),
      }),
    list: createDocList({
      openDocuments: async () => {
        const tabs = tabManager ? await tabManager.openDocuments() : []
        const detached = await detachedOpenDocuments()
        return [...tabs, ...detached].map((doc) => ({
          id: doc.id,
          ...(doc.filePath ? { path: doc.filePath } : {}),
          title: doc.title,
          dirty: doc.dirty,
        }))
      },
      recent: async () =>
        readRecentFiles().map((path) => ({ path, title: basename(path), missing: false })),
      // spec 5.13: the newest AI-visible files of the asking panel's project
      projectFiles: async (asker) => {
        if (asker.webContentsId === undefined || !projectFolderIpc) return []
        const projectId = await projectFolderIpc.windowProject(asker.webContentsId)
        if (!projectId) return []
        const visibility = await projectFolderServices().guide.aiVisibility(projectId)
        return visibility ? projectMentionFiles(visibility, undefined, projectFileLister) : []
      },
      stat: async (path) => {
        const entry = (await statPathEntriesAsync([path], new Set<string>()))[0]
        return entry && !entry.missing ? { sizeBytes: entry.sizeBytes } : null
      },
      attachable: {
        ATTACHABLE_EXTS,
        ATTACHABLE_IMAGE_EXTS,
        ATTACHABLE_MAX_BYTES,
        ATTACHABLE_IMAGE_MAX_BYTES,
        attachableMaxBytes,
        diagramPictureExtOfName,
      },
    }),
    lang: () => currentLang(),
    theme: () => currentTheme(),
  })
  // Which open documents have unsaved changes, for the attachment readers of the
  // editor mains and the knowledge base: a file being edited is not read as
  // another document's material until it is saved (a withholding mark only
  // reaches the file on save).
  setOpenFilesSource(async () => {
    const tabs = tabManager ? await tabManager.openDocuments() : []
    return [...tabs, ...(await detachedOpenDocuments())]
  })
  // Register the docs renderer bridge listeners before the MCP server can take
  // a visible-editing request.
  installDocsBridge()
  installSheetsBridge()
  // MCP server: localhost-only, docx generation for external agents. Deps are
  // injected so the mcp module never imports this file back.
  // family controls are referenced twice (their own tools + the open-documents
  // tool), so create them once here
  const mcpDocsControl = createDocsControl({
    openBlankTab: () => openBlankDocsTabForMcp(),
    authorizeSave: authorizeMcpDocWrite,
    abandonBlankTab: (wcId) => {
      if (tabManager) abandonBlankTabForMcp(tabManager.docsTabs(), wcId)
    },
  })
  const mcpSlidesControl = createSlidesControl({
    openBlankTab: () => openBlankSlidesTabForMcp(),
    abandonBlankTab: (wcId) => {
      if (tabManager) abandonBlankTabForMcp(tabManager.slidesTabs(), wcId)
    },
  })
  const mcpSheetsControl = createSheetsControl({
    openBlankTab: () => openBlankSheetsTabForMcp(),
    authorizeSave: authorizeMcpSheetWrite,
    abandonBlankTab: (wcId) => abandonBlankSheetsTabForMcp(wcId),
  })
  // The PDF tools window (decision 0030): Home's "PDF tools" card opens it; what it
  // writes, or a PDF picked for an editor-only tool, opens in a tab here.
  configurePdfToolsWindow({
    parentWindow: () => shellWindow,
    lang: () => currentLang(),
    theme: () => currentTheme(),
    openResult: (path) => {
      revealShellWindow()
      // a text tab already on this path shows the old file: read it again, as a
      // PDF tab is (the tools never write over a file with unsaved changes)
      const textTab = TEXT_RE.test(path) ? tabManager?.findMarkdownTabByPath(path) : undefined
      if (tabManager && textTab) {
        tabManager.reloadTab(textTab)
        tabManager.activateTab(textTab)
        return true
      }
      return openGeneratedDocument(path)
    },
    openForEditing: (path) => {
      revealShellWindow()
      return openDocumentPath(path)
    },
    runJob: runWindowJob,
    cancelJob: cancelWindowJob,
  })
  configureQuickLookWindow({
    parentWindow: () => shellWindow,
    lang: () => currentLang(),
    theme: () => currentTheme(),
    trayIcon: () => {
      try {
        return menuIcons().home
      } catch {
        return null
      }
    },
    readSettings: () => normalizeQuickLookSettings(readAppSettings(APP_SETTINGS_PATH()).quickLook),
    writeSettings: (next) => writeAppSetting(APP_SETTINGS_PATH(), 'quickLook', next),
    openInEditor: (filePath) => {
      revealShellWindow()
      openDocumentPath(filePath)
    },
    showShellWindow: () => {
      revealShellWindow()
    },
    quitApp: () => {
      stopQuickLookRuntime()
      app.quit()
    },
  })
  // The generate window ("make a new document from these files"): Home's entry
  // points open it; "make" opens a new untitled tab with the request queued
  // for it. A material open with unsaved changes is saved in place through the
  // same dialog-free saves the MCP save-and-close uses, or its tab is shown.
  configureGenerateWindow({
    parentWindow: () => shellWindow,
    lang: () => currentLang(),
    theme: () => currentTheme(),
    // the new tab follows the project of the window the create window was opened from (spec 6)
    openTargetTab: (handoff, opener) => {
      revealShellWindow()
      const manager = ensureTabManager()
      const contents = manager.webContentsForTab(manager.openGenerateTargetTab(handoff))
      if (contents) followOpenerProject(contents, opener)
    },
    openConvertedTab: (doc, opener) => {
      revealShellWindow()
      const manager = ensureTabManager()
      const contents = manager.webContentsForTab(manager.openConversionResult(doc))
      if (contents) followOpenerProject(contents, opener)
    },
    starredGroupPaths: (group) => {
      const groupOf = readStarredGroupMap()
      return readStarredFiles().filter((p) => groupOf.get(p) === group)
    },
    tabIdFor: (wcId) => tabManager?.tabIdForWebContents(wcId),
    openMaterials: {
      list: async () => {
        const tabs = tabManager ? await tabManager.openDocuments() : []
        return [...tabs, ...(await detachedOpenDocuments())]
      },
      webContentsFor: (tabId) =>
        tabManager?.webContentsForTab(tabId) ?? detachedWebContentsFor(tabId),
      reveal: (tabId) => {
        if (activateDetached(tabId)) return
        tabManager?.activateTab(tabId)
        revealShellWindow()
      },
      save: {
        docs: (wcId, path) =>
          mcpDocsControl.runCommand(wcId, 'save_document', { path, overwrite: true }),
        sheets: (wcId, path) =>
          mcpSheetsControl.runCommand(wcId, 'save_sheet', { path, overwrite: true }),
        slides: (wcId, path) => mcpSlidesControl.saveDeck(wcId, path, true),
        markdown: (wc) => requestMarkdownSave(wc, 'save'),
        html: (wc) => requestHtmlSave(wc, 'save'),
        mindmap: (wc) => requestMindmapSave(wc, 'save'),
      },
    },
  })
  // Provenance records (spec 9) and the editors' File-menu entry "make another
  // document from this one" (8.2). After the make window: the records follow
  // the hand-off store's events, and the entry opens that window.
  configureDocumentLinks({
    userDataPath: () => app.getPath('userData'),
    activeDocument: (kind) => linkedDocumentFor(kind),
    documentFor: (wc) => linkedDocumentForWebContents(wc),
    parentFor: (wc) => detachedWindowForWebContents(wc.id) ?? shellWindow,
    openPath: (path) => void openDocumentPath(path),
    labels: () => ({
      make: tm('menuMakeFromDocument'),
      sources: tm('menuDocumentSources'),
      derived: tm('menuDerivedDocuments'),
    }),
    tabIdFor: (wcId) => tabManager?.tabIdForWebContents(wcId),
    menuKind: () => linkMenuKind(),
    applyMenu: (kind) => applyMenuFor(kind),
  })
  configureMcpRuntime({
    version: app.getVersion(),
    defaultSaveDir: () => defaultSaveDir(),
    openPath: (filePath) => routeDocumentPath(filePath),
    docsControl: mcpDocsControl,
    slidesControl: mcpSlidesControl,
    sheetsControl: mcpSheetsControl,
    // documents the user has open: the tab list plus each family's own bridge,
    // so an agent reaches a tab nobody but the user opened
    openDocumentsControl: createOpenDocumentsControl({
      list: async () => {
        const tabs = tabManager ? await tabManager.openDocuments() : []
        return [...tabs, ...(await detachedOpenDocuments())]
      },
      webContentsFor: (tabId) => liveDocumentContents(tabId),
      closeTab: (tabId) =>
        closeDetachedWithoutPrompt(tabId) || (tabManager?.closeTabWithoutPrompt(tabId) ?? false),
      // a restored tab that never loaded closes as it is: its copy stays (spec 5.3)
      isUnloaded: (tabId) => tabManager?.isTabUnloaded(tabId) ?? false,
      // closing without saving drops the copy, as "Don't Save" does (spec 2)
      recoveryDiscard: (tab, contents) => discardEditorRecovery(tab.kind, contents),
      defaultSaveDir: () => defaultSaveDir(),
      docs: mcpDocsControl,
      sheets: mcpSheetsControl,
      slides: mcpSlidesControl,
      slidesDiscard: discardSlidesRecovery,
      markdown: {
        read: markdownReadText,
        save: markdownSaveToPath,
        discard: markdownDiscardPendingAssets,
      },
      html: {
        read: htmlReadText,
        save: htmlSaveToPath,
        discard: htmlDiscardPendingAssets,
      },
      mindmap: {
        read: mindmapReadOutline,
        save: mindmapSaveToPath,
      },
      hwp: { read: hwpReadText },
      epub: {
        read: epubReadText,
        save: epubSaveToPath,
      },
      diagram: { read: diagramReadText, save: diagramSaveToPath },
    }),
    // the headless create_*/read_* tools delegate to the bundled seuoffice CLI
    // (the same engines, no second implementation); it runs on the app's own
    // Node runtime via ELECTRON_RUN_AS_NODE
    cliRunner: bundledCliRunner(),
    // lets the content tools take a `document` argument (tab id or path) and edit
    // a tab the *user* has open, with no create_session involved
    resolveTarget: createOpenTargetResolver({
      list: async () => {
        const tabs = tabManager ? await tabManager.openDocuments() : []
        return [...tabs, ...(await detachedOpenDocuments())]
      },
      webContentsFor: (tabId) => liveDocumentContents(tabId),
      // an agent editing a background tab would otherwise work where nobody can
      // see it: switch to that tab and bring its window forward first
      activate: (tabId) => {
        if (!activateDetached(tabId)) tabManager?.activateTab(tabId)
      },
      revealWindow: (tabId) => {
        if (!isDetachedTabId(tabId)) revealShellWindow()
      },
    }),
    // read_diagram / apply_diagram_ops: the diagram editor's own read table and executor
    diagramControl: createDiagramControl({
      list: async () => {
        const tabs = tabManager ? await tabManager.openDocuments() : []
        return [...tabs, ...(await detachedOpenDocuments())]
      },
      webContentsFor: (tabId) => liveDocumentContents(tabId),
      isDetached: (tabId) => isDetachedTabId(tabId),
      activate: (tabId) => {
        if (!activateDetached(tabId)) tabManager?.activateTab(tabId)
      },
      revealWindow: (tabId) => {
        if (!isDetachedTabId(tabId)) revealShellWindow()
      },
      readPage: diagramReadPage,
      applyOps: diagramApplyOps,
    }),
    logFilePath: join(app.getPath('userData'), 'mcp-log.txt'),
  })
  // Agent mode (decision 0032): the person's Claude Code or Codex with its own tools in a
  // project folder, in a window of its own. Its MCP server is per session and token-guarded,
  // built from the same controls as the one above; the skills are a copy kept under userData.
  configureAgentWindow({
    parentWindow: () => shellWindow,
    lang: () => currentLang(),
    theme: () => currentTheme(),
    statuses: () => sharedSubscriptionStatuses(),
    aiSettings: () => readStoredAiSettings(),
    readPrefs: () => normalizeAgentPrefs(readAppSettings(APP_SETTINGS_PATH()).agent),
    writePrefs: (prefs) => writeAgentPrefs(APP_SETTINGS_PATH(), prefs),
    openPath: (path) => routeDocumentPath(path),
    openDocuments: () => [...(tabManager?.openFilePaths() ?? []), ...detachedFilePaths()],
    userData: app.getPath('userData'),
    runners: {
      claude: (options, onEvent) => startClaudeAgentSession(options, onEvent),
      codex: (options, onEvent) => startCodexAgentSession(options, onEvent),
    },
    // the session's skill tools only show a card or an install proposal in the agent window
    startAppMcp: (projectRoot, { skillTools }) => {
      const mcp = currentMcpRuntimeDeps()
      if (!mcp) throw new Error('the MCP runtime is not configured')
      return startAgentMcpServer({ ...mcp, skillTools }, projectRoot)
    },
    // the person's MCP servers reach a session through relays the app opens (user MCP spec 9)
    userMcp: () => mcpHub,
    listSkills: () => userSkills.list(),
    openTemplatePreview: (owner, input) => templateTabs.openPreview(owner, input),
    // the enabled skills (settings → skills), and the project's only while the person has
    // turned them on as they are now (decision 0064), read again at the start
    buildSkills: async (projectRoot) => {
      const enabled = await userSkills.enabledForAgent(projectRoot)
      const withProject = await projectSkillsAllowed(APP_SETTINGS_PATH(), projectRoot, enabled)
      return buildAgentSkillBundle(
        withProject ? enabled : enabled.filter((skill) => skill.source !== 'project'),
        // not under userData: that folder is protected from sessions, and the
        // copied skills' scripts must be readable to run
        join(process.env.LOCALAPPDATA ?? tmpdir(), 'seuoffice', 'agent-skills'),
      )
    },
    projectSkills: {
      view: async (folder) =>
        projectSkillsView(APP_SETTINGS_PATH(), folder, await userSkills.enabledForAgent(folder)),
      set: async (folder, on) =>
        setProjectSkills(APP_SETTINGS_PATH(), folder, await userSkills.enabledForAgent(folder), on),
    },
  })
  // session folders a run that did not quit normally left; after the start, so it never slows it
  setTimeout(() => void sweepAgentSessionFolders(), 10_000).unref()
  void startMcpFromSettings(currentMcpSettings()).catch((error) => {
    console.error('[mcp] failed to start on boot:', error)
  })
  installUiScale()
  installPointerSize(app)
  installTabShortcuts()
  createShellWindow()
  // deferred to ready: labels need currentLang(), which reads app.getLocale()
  installBackToHomeItems()
  installDocumentLinkMenuItems()
  installDockMenu()
  setUpdateCheckInvoker(() => void checkForUpdatesNow())
  initAutoUpdater(() => shellWindow, autoUpdateCheckEnabled)
  // every app's Settings entry (⌘, / Ctrl+,) lands on the shell's Settings view
  setSettingsInvoker(() => openSettingsView())
  // crash record on this PC (crash-log.jsonl in userData) and, outside
  // headless runs, a prompt when the renderer of an open document dies
  const crashMemory = () =>
    memoryFigures({
      aiStreams: activeAiStreamCount,
      cliChildren: trackedSubscriptionChildCount,
    })
  startCrashWatch({
    prompt: headlessArgv.kind === 'none',
    memory: crashMemory,
    editorOf: (wc) => {
      if (shellWindow && !shellWindow.isDestroyed() && shellWindow.webContents.id === wc.id) {
        return 'home'
      }
      return (
        tabManager?.describeWebContents(wc.id)?.kind ?? detachedDocumentFor(wc.id)?.kind ?? 'other'
      )
    },
    documentOf: (wc) => {
      const doc = tabManager?.describeWebContents(wc.id) ?? detachedDocumentFor(wc.id)
      return doc && doc.kind !== 'home' && doc.kind !== 'help' ? doc : null
    },
    parentWindow: (wc) => detachedWindowForWebContents(wc.id) ?? shellWindow,
    closeDocument: (wc) => {
      const id = tabManager?.tabIdForWebContents(wc.id)
      if (id && tabManager) return tabManager.closeTabWithoutPrompt(id)
      const detachedId = detachedDocumentFor(wc.id)?.id
      return detachedId ? closeDetachedWithoutPrompt(detachedId) : false
    },
    reopen: (filePath) => void openDocumentPath(filePath),
    // an untitled document comes back from its recovery copy (spec 8); its
    // identity is read while the editor still knows the crashed view
    untitledCopyOf: (wc) => {
      const doc = tabManager?.describeWebContents(wc.id) ?? detachedDocumentFor(wc.id)
      if (!doc) return null
      const id = tabManager?.tabIdForWebContents(wc.id) ?? detachedDocumentFor(wc.id)?.id
      return crashedUntitledCopy({ ...doc, ...(id ? { id } : {}) }, wc)
    },
    reopenUntitled: (doc, copy) => {
      if (doc.kind === 'home' || doc.kind === 'help') return
      revealShellWindow()
      reopenUntitledCopy(
        ensureTabManager(),
        doc.kind as DocumentTabKind,
        doc.title,
        copy as RecoveryUntitledIdentity,
        restoredTabDeps,
      )
    },
    t: (key, params) => tm(key, params),
  })
  // a PC (or the main process's heap) that runs short of memory leaves a line too
  startLowMemoryWatch({ memory: crashMemory })
  // a main process that dies leaves no line of its own: its last heartbeat
  // is reported at the next launch (headless exports are short and unattended)
  if (headlessArgv.kind === 'none') {
    mainHeartbeat = startHeartbeat({
      userDataDir: app.getPath('userData'),
      logPath: crashLogPath(),
      memory: crashMemory,
    })
  }
  // resource watchdog: a renderer that stays hot for minutes gets diagnostics
  // recorded and the user an offer to close the document (headless exports
  // are short-lived and unattended)
  if (headlessArgv.kind === 'none') {
    startRendererWatchdog({
      describe: (wc) => tabManager?.describeWebContents(wc.id) ?? null,
      parentWindow: (wc) => BrowserWindow.fromWebContents(wc) ?? shellWindow,
      closeDocument: async (wc) => {
        const id = tabManager?.tabIdForWebContents(wc.id)
        if (id && tabManager) await tabManager.closeTab(id)
        else BrowserWindow.fromWebContents(wc)?.close()
      },
      t: (key, params) => tm(key, params),
    })
  }

  // Crash recovery (spec 5): after an abnormal exit the previous tabs come
  // back unloaded and the launch list asks about unsaved copies; otherwise,
  // as before, no file argument reopens the remembered split when its
  // documents are still on disk, else the home screen, and a launch with a
  // file opens just it (the memory is left for the next plain launch).
  const launchPaths = pendingLaunchPaths
  pendingLaunchPaths = []
  runLaunchRecovery({
    userDataDir: app.getPath('userData'),
    gate: launchListGate,
    manager: () => ensureTabManager(),
    launchPaths,
    openLaunchPaths,
    restoreSplitMemoryOrHome,
    afterSheetsOpen: restoredTabDeps.afterSheetsOpen,
    sessionChanged: noteLiveSession,
    reopenedByInstaller: reopenedByInstaller(),
    settled: () => {
      const paths = deferredLaunchPaths
      deferredLaunchPaths = []
      if (paths.length > 0) openLaunchPaths(paths)
    },
  })
  // macOS and Linux announce a shutdown here (Windows through the window session-end)
  // (the typings omit the event; preventDefault asks the OS to wait for the copies)
  const onShutdown = (event?: { preventDefault?: () => void }): void => {
    event?.preventDefault?.()
    void endForOsSession()
  }
  powerMonitor.on('shutdown', onShutdown)

  startControlServer(
    app.getPath('userData'),
    controlHandler({
      reveal: revealShellWindow,
      openDocument: openDocumentPath,
      activateTab: (id) => {
        if (!activateDetached(id)) tabManager?.activateTab(id)
      },
      findTab: (path) => tabManager?.findTabByPath(path) ?? findDetachedTabByPath(path),
    }),
  ).then(
    (server) => {
      controlServer = server
    },
    (err: unknown) => console.warn('[control] not listening:', err),
  )

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createShellWindow()
  })
})

app.on('window-all-closed', () => {
  // A headless export destroys its hidden window between documents; only
  // runHeadlessExportEntry decides when that run is over.
  if (headlessArgv.kind !== 'none') return
  if (shouldKeepQuickLookInTray()) return
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // "Restart & Install": the tabs as they are now come back after the update,
  // whatever the closing windows report on the way out
  if (updateRestartRequested()) holdSessionTabsForUpdateRestart()
  // No close prompt may fall through to "Save" during shutdown, and from here
  // on no editor clean-up may delete a recovery copy (a vetoed close resets both)
  appQuitting = true
  markAppShuttingDown()
  markSheetsShuttingDown()
  stopSheetsSidecar()
  // release the MCP port synchronously (macOS keeps the process alive after
  // the last window closes, so window-all-closed is not enough)
  stopMcpSync()
  // the person's MCP servers: calls end, servers stop, a runtime download stops
  void mcpHub?.stopAll()
})

// after every window has closed, so the shell window's own 'closed' republish cannot revive the file
app.on('will-quit', () => {
  // the quit path completed: the next launch is a normal one (a no-op in a
  // second instance or a headless export, which never started a record),
  // unless it is the restart into an update, which brings the tabs back.
  // This runs before the updater's own will-quit (registered later), which
  // reads the same request to start the installer.
  if (updateRestartRequested()) markSessionUpdateRestart()
  else markSessionCleanExit()
  mainHeartbeat?.markEnded('quit')
  releaseAppResources()
})

/** what every way out of a normal run releases (will-quit, and an OS session end) */
function releaseAppResources(): void {
  // project use times held back to spare the settings file (written once a minute)
  try {
    projectFolderRuntime?.guide.flushTouches()
  } catch {
    // the settings file is not writable now; the list order is only a convenience
  }
  fileIndexer?.stop()
  fileIndexStore?.close()
  for (const watcher of folderWatchers.values()) watcher.close()
  controlServer?.close()
  // a second instance that lost the lock quits too; it must not delete the running editor's list
  if (ownsOpenDocumentsRegistry) clearOpenDocuments(OPEN_DOCUMENTS_PATH())
  stopAgentSessions()
  driveService?.stop()
  void mcpHub?.stopAll()
  stopQuickLookRuntime()
  shutdownSubscriptionChildren()
}

// app.exit() and process.exit() skip before-quit / will-quit (the headless
// export ends that way, and so does an exit on a fatal error); 'exit' is the
// one event every such way out still emits, so no subscription CLI outlives
// the app. A process killed outright runs nothing: the next start cleans up.
process.on('exit', () => shutdownSubscriptionChildren())
