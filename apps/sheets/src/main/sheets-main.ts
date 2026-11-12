import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {
  copyFile,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { refreshCsvDigest } from './csv-digest'
import { legacyCsvCharset } from './document-locale'
import { ImportRegistry } from './import-registry'
import { createServer } from 'node:http'
import { basename, dirname, isAbsolute, join, resolve as resolvePath, extname } from 'node:path'

import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  net,
  screen,
  session as electronSession,
  shell,
  systemPreferences,
  webContents,
  WebContentsView,
} from 'electron'
import type {
  IpcMainInvokeEvent,
  MenuItemConstructorOptions,
  OpenDialogOptions,
  SaveDialogOptions,
  WebContents,
} from 'electron'
import { z } from 'zod'
import {
  abortOnDestroyed,
  appMenuLabels,
  appMenuTemplate,
  buildPrintableHtml,
  configuredAuthorName,
  configuredDefaultSaveDir,
  confirmOverwriteIfConflicted,
  contextMenuLabels,
  fetchRemoteImage,
  installContextMenu,
  installNavigationGuard,
  isHeadlessMode,
  isModifiedSince,
  isPathOpenElsewhere,
  printHtmlToPdf,
  recordDiskState,
  safeExternalUrl,
  shouldDeferAutoSave,
  showOpenDialogWithMemory,
  showSaveDialogWithMemory,
  helpMenuTemplate,
  viewMenuTemplate,
  windowMenuTemplate,
  settingsMenuItem,
  installRendererProtocol,
  registerRendererScheme,
  rendererUrl,
  writeJsonAtomic,
  assertFileSaved,
  createRecoveryStore,
  isAppShuttingDown,
  isUntitledIdentity,
  markAppShuttingDown,
  newUntitledRecoveryId,
  recoveryFolderName,
  registerRecoveryEditor,
  resetAppShuttingDown,
  resolveRecoveryOnOpen,
  resumeDiscardedCopies,
  unprotectableNoticeText,
  type RecoveryCopyInfo,
  type RecoveryCopyState,
  type RecoveryIdentity,
  type RecoveryOpenFileRequest,
  type RecoveryOpenUntitledRequest,
  type SaveDiskState,
} from '@seuoffice/electron-utils'
import { aiRunRefusal } from '@seuoffice/electron-utils/ai-run-guard'
import { createMainProcessProxyDispatcher } from '@seuoffice/electron-utils/main-proxy'
import {
  encryptOoxml,
  isCfbHeader,
  isEncryptedOfficeFile,
  OfficeDecryptError,
  unlockOfficeFile,
  type OfficePasswordAsk,
} from '@seuoffice/electron-utils/office-encryption'
import {
  createI18n,
  documentLocale,
  getUiLang,
  normalizeLang,
  PRODUCT_NAME,
  setUiLang,
} from '@seuoffice/i18n'
import { fetchRemoteTable } from '@seuoffice/electron-utils/remote-table'
import { ProjectStore } from '@seuoffice/project-store'
import {
  aiChatGptSignInPages,
  aiSubscriptionLoginWindowText,
} from '@seuoffice/ui/ai-subscription-login-window'

import {
  isAiOverloadedError,
  chatForProvider,
  maxOutputTokensOf,
  setAiUserAgent,
  setRescueFetch,
  streamForProvider,
  type AiSettings,
  type AiStreamChunk,
  sealAiSecrets,
  withStoredUnknownFields,
} from '@seuoffice/ai-provider'
import { shutdownCodexAppServers } from '@seuoffice/ai-provider/codex-app-server'
import { withStoredMainFields } from '@seuoffice/ai-provider/key-models'
import {
  ensureSubscriptionIpc,
  sharedSubscriptionStatuses,
  shutdownSubscriptionChildren,
} from '@seuoffice/ai-provider/subscription'
import { decodeCsvBuffer } from '@seuoffice/xlsx-gateway/gateway/csv-import'
import type { CsvImportProgress } from '@seuoffice/xlsx-gateway/gateway/csv-import'
import { delimitedImportLimit } from './csv-import-limit'
import {
  csvToXlsxBufferForOpen,
  sheetCsvToXlsxBuffer,
} from '@seuoffice/xlsx-gateway/gateway/csv-import-xlsx'
import {
  abortMediaCalls,
  aiToolCapabilities,
  readAiSettingsFile,
  webSearchTool,
  imageSearchTool,
  readUrlTool,
  generateImageTool,
  localMediaRoots,
  withMediaCallSignal,
  type AiToolCapabilities,
} from '@seuoffice/ai-search'
import {
  parseFileToText,
  ATTACHABLE_EXTS,
  ATTACHABLE_IMAGE_EXTS,
  ATTACHABLE_MAX_BYTES,
  attachableMaxBytes,
  ATTACHABLE_IMAGE_MAX_BYTES,
  diagramPictureExtOf,
  diagramPictureExtOfName,
} from '@seuoffice/file-parse'
import { familyInfoFor } from '@seuoffice/font-metrics'
import { resolveWorkbookSave } from './workbook-save-resolve'
import {
  promoteFileAtomically,
  readArchiveEntriesText,
  readArchiveEntryText,
  saveWorkbookViaSidecar,
  type ArchiveClient,
} from '@seuoffice/xlsx-gateway/gateway/xlsx-package-io'
import {
  connectionSourceOf,
  refreshableQueriesOf,
} from '@seuoffice/xlsx-gateway/gateway/xlsx-connection-refresh'
import type { PartReader } from '@seuoffice/xlsx-gateway/gateway/xlsx-connections'
import { parsePivotDefinition } from '@seuoffice/xlsx-gateway/gateway/xlsx-pivot'
import { parseSlicerState } from '@seuoffice/xlsx-gateway/gateway/xlsx-slicer'
import { listWorkbookQueries } from '@seuoffice/xlsx-gateway/gateway/xlsx-connections'
import { manifestNamesSchema, readWorkbookRedactionPart } from './workbook-redactions'
import type {
  AttachmentAddResult,
  AttachmentImageResult,
  AttachmentMeta,
  AttachmentReadResult,
  WorkbookFile,
} from '../shared/desktop-api'
import {
  aiChatRequestSchema,
  aiSettingsInputSchema,
  aiStreamRequestSchema,
  workbookFileSchema,
  workbookFormulaCellsRequestSchema,
  workbookRowOutlineResultSchema,
  workbookFormulaCellsResultSchema,
  workbookFindCellsRequestSchema,
  workbookFindCellsResultSchema,
  workbookRecalcRequestSchema,
  workbookRecalcResultSchema,
  workbookPickSelectionSchema,
  externalLinksRequestSchema,
  externalLinksResultSchema,
  externalLinksUpdateResultSchema,
  externalLinkRevealRequestSchema,
  workbookMediaRequestSchema,
  workbookMediaResultSchema,
  workbookConnectionsRequestSchema,
  workbookConnectionsResultSchema,
  workbookPivotRequestSchema,
  workbookRefreshRequestSchema,
  workbookRefreshResultSchema,
  workbookQueriesRequestSchema,
  workbookQueriesResultSchema,
  workbookRedactionsRequestSchema,
  workbookRedactionsResultSchema,
  localImageRequestSchema,
  localImageResultSchema,
  screenCaptureRequestSchema,
  screenCaptureResultSchema,
  screenSourcesResultSchema,
  workbookPivotDefinitionSchema,
  workbookCreateDocumentRequestSchema,
  workbookExportCsvRequestSchema,
  workbookExportOdsRequestSchema,
  workbookExportPdfRequestSchema,
  printerInfoSchema,
  workbookRangeRequestSchema,
  workbookRangeResultSchema,
  workbookSaveEditsAbortSchema,
  workbookSaveEditsBeginSchema,
  saveEditsChunkArraySchema,
  workbookSaveEditsChunkSchema,
  workbookPasswordUpdateRequestSchema,
  workbookSaveRequestSchema,
  workbookSlicerStateRequestSchema,
  workbookSlicerStateResultSchema,
  type WorkbookCreateDocumentResult,
  type WorkbookSaveRequest,
} from '../shared/desktop-api'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import {
  aiRunBlockChunk,
  aiSettingsFromStored,
  aiStreamErrorChunk,
  resolveAiRunTarget,
  subscriptionStreamCallbacks,
  withMeteredAccepted,
} from './ai-run'
import { atomicWriteFile } from './atomic-write'
import { closeGuardDecision, ShutdownLatch } from './close-guard'
import { SaveEditsTransferStore } from './save-edits-transfer'
import { exportPdf, printWorkbook } from './pdf-export'
import { exportWorkbookAsOds, type OdsLoss, type OdsLossKind } from './ods-export'
import {
  resolveSheetsSaveAsPick,
  SaveAsExportTargets,
  sheetsSaveAsFilters,
  sheetsSaveAsSuggestion,
} from './save-as-formats'
import { installStandaloneTemplateFontProtocol } from './template-fonts'
import {
  allowsAutomaticWorkbookRecovery,
  convertedSessionRecovery,
  migrateLegacyUnsavedNew,
  saveAsDefaultFor,
  sessionRecoveryIdentity,
  untitledWorkbookExt,
} from './recovery-policy'
import {
  setSystemShortDate,
  shortDatePatternForSystemLocale,
} from '@seuoffice/xlsx-gateway/shared/short-date'
import {
  cleanupExpiredPastedFiles,
  cleanupImportTempDirectory,
  cleanupSessionResources,
} from './temp-files'
import { XlsxSidecarClient } from './xlsx-sidecar-client'
import { convertLegacyWorkbook } from './legacy-import'
import { sessionAfterRename } from './session-rename'
import { continuedOpenOptions, sessionToContinue } from './session-reopen'
import {
  appendSaveFailure,
  describeReopenFailure,
  reopenFailureNote,
  SAVE_FAILURE_LOG_FILE,
  sessionSourceFormat,
} from './save-failure-log'

/**
 * Sheets main-process logic as an embeddable module: no top-level lifecycle.
 * Standalone mode (apps/sheets entry) calls startSheetsStandalone(); the
 * unified shell calls configureSheetsRuntime() + createSheetsWindow() and
 * owns the app lifecycle. AI IPC is registered separately so the shell can
 * substitute its single unified handler set (same channel names as docs).
 */

const tMain = createI18n({
  en: {
    filterSpreadsheets: 'Spreadsheets',
    filterXlsx: 'Excel Workbooks',
    filterXlsm: 'Excel Macro-Enabled Workbooks',
    dlgAddAttachment: 'Add Attachments',
    filterSupported: 'Supported Files',
    filterAll: 'All Files',
    errUnsupportedExt: '.{ext} files are not supported',
    errNotFile: 'not a file',
    errTooLarge: 'exceeds the {mb}MB limit',
    errImageTooLarge: 'image exceeds the 5MB limit',
    errUnreadable: 'cannot be read',
    errFileTooLarge: 'File exceeds the size limit',
    errParseFailed: 'Failed to parse file',
    errHtmlNoTable: 'This file is a web page, not a spreadsheet; no table to import was found.',
    errImageNoText: 'Image attachments have no text; the image is sent along with the user message',
    errNotImage: 'not a supported image type',
    errNoApiKey: 'No API key configured for {provider}',
    errAiBusy: 'The AI service is busy right now — please try again in a moment',
    errNoModel: 'No model name configured',
    errImgAbsPath: 'Image path must be absolute.',
    errImgNotFound: 'Image file not found: {path}',
    errImgTooLarge20: 'Image exceeds 20MB and cannot be inserted.',
    errImgBadType: 'The file is not a PNG/JPEG/GIF image.',
    errEncryptedOpenTitle: 'Cannot open the password-protected workbook',
    errEncryptedUnsupported:
      'This file uses an encryption method this app cannot unlock. Remove the password in Excel, then open it again.',
    errDiskChanged: 'The workbook changed on disk after it was opened — use Save As instead.',
    errSaveUnreadable:
      'The saved result could not be opened again, so the original file was not overwritten. The original is unchanged and your edits are still on screen.',
    errSaveUnreadableReason:
      'Reason: {reason}\n\nChoose "Copy reason" and paste it into Send feedback to help us find the cause.',
    btnCopyReason: 'Copy reason',
    btnCloseDialog: 'Close',
    menuFile: 'File',
    menuOpenWorkbook: 'Open Workbook…',
    menuSave: 'Save',
    menuSaveAs: 'Save As…',
    menuExportPdf: 'Export PDF…',
    menuPrint: 'Print…',
    menuClose: 'Close',
    menuQuit: 'Quit',
    menuEdit: 'Edit',
    menuUndo: 'Undo',
    menuRedo: 'Redo',
    closeUnsavedMsg: '{count} unsaved change(s)',
    closeUnsavedDetail: 'Your changes will be lost if you close without saving.',
    btnDontSave: "Don't Save",
    btnCancel: 'Cancel',
    csvSaveAsNotice: "CSV files can't keep formatting — saving as .xlsx keeps all your changes.",
    menuExportCsv: 'Export CSV…',
    menuExportOds: 'Export as ODS…',
    filterOds: 'OpenDocument Spreadsheet (.ods)',
    errOdsOriginalTarget: 'The original ODS file cannot be overwritten. Choose a different name.',
    errOdsEncrypted:
      'Password-protected workbooks cannot be exported as ODS. Remove the password first.',
    odsLossMsg: 'Not everything can be saved to ODS',
    odsLossDetail:
      'This workbook uses features ODS cannot hold. They are left out of the exported copy:',
    odsLossFormulas: 'Formulas kept as values only: {count}',
    odsLossCharts: 'Charts: {count}',
    odsLossImages: 'Images: {count}',
    odsLossConditionalFormats: 'Conditional formatting rules: {count}',
    odsLossValidations: 'Data validation rules: {count}',
    odsLossPivots: 'Pivot tables: {count}',
    odsLossComments: 'Comments: {count}',
    odsLossMacros: 'Macros: {count}',
    odsLossShapes: 'Shapes and text boxes: {count}',
    odsLossSlicers: 'Slicers: {count}',
    odsLossSparklines: 'Sparklines: {count}',
    withheldExportMsg: "A copy as {format} can't keep the cells hidden from the AI",
    withheldExportDetail:
      '{format} has nowhere to record which cells are hidden from the AI, so a copy would hand those cells to anyone who opens it, an AI included.\n\nSave as .xlsx keeps the marks. Export {format} without the marks writes the real values, and the marks are gone from that file. Nothing has been written yet.',
    withheldExportWithoutMarksBtn: 'Export {format} without the marks',
    odsContinueBtn: 'Continue',
    errOdsExportFailed: 'The ODS export failed: {message}',
    errOdsReopenFailed:
      'The exported ODS file could not be opened again, so it was removed. The workbook is unchanged.',
    filterCsv: 'CSV (Comma delimited)',
    filterPdfActiveSheet: 'PDF (Current sheet)',
    csvFormulaLossMsg: 'This sheet contains formulas that CSV cannot keep.',
    csvFormulaLossDetail:
      'CSV keeps plain values only — formulas are flattened to their current results, and formatting is lost.',
    csvKeepXlsxBtn: 'Save as .xlsx',
    csvContinueBtn: 'Continue as CSV',
    csvActiveSheetOnlyNotice:
      'CSV files hold a single sheet — only the active sheet "{name}" will be exported.',
    csvKeepFormatMsg: 'Keep saving in CSV format?',
    csvKeepFormatDetail:
      'CSV keeps plain values of a single sheet only — formulas, formatting, and any additional sheets are not saved to the .csv file.',
    saveAsNeedsExtension:
      'Add an extension to the file name, for example report.xlsx or report.ods.',
  },
  ko: {
    filterSpreadsheets: '스프레드시트',
    filterXlsx: 'Excel 통합 문서',
    filterXlsm: 'Excel 매크로 사용 통합 문서',
    dlgAddAttachment: '첨부 파일 추가',
    filterSupported: '지원되는 파일',
    filterAll: '모든 파일',
    errUnsupportedExt: '.{ext} 형식은 지원되지 않습니다',
    errNotFile: '파일이 아닙니다',
    errTooLarge: '{mb}MB 제한을 초과했습니다',
    errImageTooLarge: '이미지가 5MB 제한을 초과했습니다',
    errUnreadable: '읽을 수 없습니다',
    errFileTooLarge: '파일이 크기 제한을 초과했습니다',
    errParseFailed: '파일을 구문 분석하지 못했습니다',
    errHtmlNoTable: '이 파일은 스프레드시트가 아니라 웹 페이지입니다. 가져올 표를 찾지 못했습니다.',
    errImageNoText:
      '이미지 첨부에는 텍스트가 없습니다. 이미지는 사용자 메시지와 함께 전송되므로 이미지를 직접 확인하세요',
    errNotImage: '지원되는 이미지 형식이 아닙니다',
    errNoApiKey: '{provider}의 API 키가 설정되지 않았습니다',
    errAiBusy: 'AI 서비스가 혼잡합니다. 잠시 후 다시 시도해 주세요',
    errNoModel: '모델 이름이 설정되지 않았습니다',
    errImgAbsPath: '이미지 경로는 절대 경로여야 합니다.',
    errImgNotFound: '이미지 파일을 찾을 수 없습니다: {path}',
    errImgTooLarge20: '이미지가 20MB를 초과하여 삽입할 수 없습니다.',
    errImgBadType: '이 파일은 PNG/JPEG/GIF 이미지가 아닙니다.',
    errEncryptedOpenTitle: '암호가 걸린 통합 문서를 열 수 없습니다',
    errEncryptedUnsupported:
      '이 파일에 쓰인 암호 방식은 이 앱에서 풀 수 없습니다. Excel에서 암호를 해제한 뒤 다시 열어 주세요.',
    errDiskChanged:
      '통합 문서가 열린 후 디스크에서 변경되었습니다. 다른 이름으로 저장을 사용하세요.',
    errSaveUnreadable:
      '저장한 결과를 다시 열 수 없어 원래 파일을 덮어쓰지 않았습니다. 원래 파일은 그대로이고, 편집한 내용은 화면에 남아 있습니다.',
    errSaveUnreadableReason:
      '까닭: {reason}\n\n"까닭 복사"를 누른 뒤 의견 보내기에 붙여 넣어 주시면 원인을 찾는 데 도움이 됩니다.',
    btnCopyReason: '까닭 복사',
    btnCloseDialog: '닫기',
    menuFile: '파일',
    menuOpenWorkbook: '통합 문서 열기…',
    menuSave: '저장',
    menuSaveAs: '다른 이름으로 저장…',
    menuExportPdf: 'PDF 내보내기…',
    menuPrint: '인쇄…',
    menuClose: '닫기',
    menuQuit: '끝내기',
    menuEdit: '편집',
    menuUndo: '실행 취소',
    menuRedo: '다시 실행',
    closeUnsavedMsg: '저장하지 않은 변경이 {count}건 있습니다',
    closeUnsavedDetail: '저장하지 않고 닫으면 변경 내용이 손실됩니다.',
    btnDontSave: '저장 안 함',
    btnCancel: '취소',
    csvSaveAsNotice:
      'CSV 형식은 서식을 저장할 수 없습니다. .xlsx로 저장하면 모든 변경 내용이 유지됩니다.',
    menuExportCsv: 'CSV 내보내기…',
    menuExportOds: 'ODS로 내보내기…',
    filterOds: 'OpenDocument 스프레드시트 (.ods)',
    errOdsOriginalTarget: '원본 ODS 파일은 덮어쓸 수 없습니다. 다른 이름을 선택하세요.',
    errOdsEncrypted: '암호가 걸린 워크북은 ODS로 내보낼 수 없습니다. 먼저 암호를 풀어 주세요.',
    odsLossMsg: 'ODS에 모두 담을 수 없습니다',
    odsLossDetail: '이 워크북에 있는 다음 기능은 ODS에 담지 못해 내보낸 사본에서 빠집니다:',
    odsLossFormulas: '값만 남는 수식: {count}',
    odsLossCharts: '차트: {count}',
    odsLossImages: '그림: {count}',
    odsLossConditionalFormats: '조건부 서식 규칙: {count}',
    odsLossValidations: '데이터 유효성 검사 규칙: {count}',
    odsLossPivots: '피벗 테이블: {count}',
    odsLossComments: '메모: {count}',
    odsLossMacros: '매크로: {count}',
    odsLossShapes: '도형·글상자: {count}',
    odsLossSlicers: '슬라이서: {count}',
    odsLossSparklines: '스파크라인: {count}',
    withheldExportMsg: '{format} 사본에는 AI에서 숨긴 셀의 표시를 담을 수 없습니다',
    withheldExportDetail:
      '{format}에는 AI에서 숨긴 셀을 기록할 곳이 없어, 사본을 여는 누구에게나(AI 포함) 그 셀이 그대로 보입니다.\n\n.xlsx로 저장하면 숨김 표시가 유지됩니다. 표시 없이 {format} 내보내기는 실제 값을 그대로 저장하며, 그 파일에서는 숨김 표시가 사라집니다. 아직 아무것도 저장하지 않았습니다.',
    withheldExportWithoutMarksBtn: '표시 없이 {format} 내보내기',
    odsContinueBtn: '계속',
    errOdsExportFailed: 'ODS 내보내기에 실패했습니다: {message}',
    errOdsReopenFailed: '내보낸 ODS 파일을 다시 열지 못해 지웠습니다. 워크북은 그대로입니다.',
    filterCsv: 'CSV (쉼표로 분리)',
    filterPdfActiveSheet: 'PDF (현재 시트)',
    csvFormulaLossMsg: '현재 시트에 CSV 형식이 유지할 수 없는 수식이 포함되어 있습니다.',
    csvFormulaLossDetail:
      'CSV는 값만 유지합니다 — 수식은 현재 계산 결과로 바뀌고 서식은 손실됩니다.',
    csvKeepXlsxBtn: '.xlsx로 저장',
    csvContinueBtn: 'CSV로 계속 저장',
    csvActiveSheetOnlyNotice:
      'CSV 파일에는 시트 하나만 포함됩니다 — 활성 시트 "{name}"만 내보냅니다.',
    csvKeepFormatMsg: 'CSV 형식으로 계속 저장하시겠습니까?',
    csvKeepFormatDetail:
      'CSV는 시트 하나의 값만 유지합니다 — 수식, 서식, 추가 시트는 .csv 파일에 저장되지 않습니다.',
    saveAsNeedsExtension: '파일 이름에 확장자를 붙여 주세요. 예: 보고서.xlsx, 보고서.ods',
  },
})
const tm = (key: Parameters<typeof tMain>[1], params?: Parameters<typeof tMain>[2]) =>
  tMain(getUiLang(), key, params)

interface SessionInfo {
  readonly path: string
  /// Byte-for-byte copy of the file as it was opened (in the OS temp dir).
  /// Saves patch this snapshot rather than the live path, so an external
  /// overwrite of the file can never corrupt the save base — and Save As
  /// stays usable after one. Removed when the session closes.
  readonly snapshotPath: string
  /// Digest of the snapshot (== the file at open time).
  readonly sha256: string
  readonly sheetNames: ReadonlyMap<string, string>
  readonly automaticRecoveryDisabled: boolean
  /// Set when the session opened a converted copy (.xls import): the
  /// first save routes through Save As, defaulting to this .xlsx path.
  readonly suggestSaveAs?: string
  /// Opened from an .ods conversion: the document keeps saying that saving
  /// writes an .xlsx, and how many formulas the conversion kept as values.
  /// A restored copy records the count in its recovery metadata.
  readonly odsConverted?: boolean
  readonly formulasDropped?: number
  /// The original .ods this session was opened from (decision 0119). It is
  /// only ever read, so no ODS export may write to it — not even after the
  /// session's first Save As moved it onto a new .xlsx.
  readonly odsSourcePath?: string
  /// The shell's "New spreadsheet" backing file in a temp directory: like an
  /// import the first Save is a Save As, but AutoSave and the recovery copy
  /// keep running (keyed on suggestSaveAs), and a quiet save writes in place.
  readonly unsavedNew?: boolean
  /// The converted copy came from a CSV: the Save As dialog explains that
  /// formatting requires .xlsx (CSV keeps values only).
  readonly csvImport?: boolean
  /// CSV session: the original .csv on disk. Save keeps the CSV identity —
  /// the xlsx save lands on the temp copy and the serialized csvContent is
  /// written back here.
  readonly csvSourcePath?: string
  /// Digest of the original .csv at open/save time — guards the write-back
  /// against external modification, like restoreTargetSha.
  readonly csvSourceSha?: string
  /// App-owned directory containing the converted CSV/XLS copy. Removed only
  /// after the sidecar session and its independent snapshot are closed.
  readonly importTempDir?: string
  /// Set when the session opened a restored crash-recovery copy: the restore
  /// prompt was the user's confirmation, so a plain Save silently writes back
  /// to this original path (no Save As detour).
  readonly restoreTarget?: string
  /// Digest of the original file at restore time — guards the silent
  /// write-back against external modification, mirroring the sha256 check on
  /// the session's own path.
  readonly restoreTargetSha?: string
  /// The opened file was 0 bytes: the session runs on a blank archive in the
  /// temp dir and restoreTarget is the empty original. Unlike a restored
  /// recovery copy, this session still needs its own crash-recovery copy,
  /// keyed by the original.
  readonly emptySource?: boolean
  /// The user's file is password-protected: the session runs on a decrypted
  /// copy in importTempDir, restoreTarget (or, for a converted .xls,
  /// suggestSaveAs) is the encrypted file, and every save re-encrypts with this
  /// password before it reaches the target. Held in memory only; the crash
  /// recovery copy is off so no plaintext lands under userData.
  readonly password?: string
  /// The copy an untitled workbook writes (its own slot in the recovery store),
  /// the untitled copy of a CSV or converted session, or the copy a tab
  /// restored as untitled because its original was missing.
  readonly recoveryIdentity?: RecoveryIdentity
  /// The file a CSV or converted session (or the untitled workbook restored
  /// from its copy) came from: its copy is titled with this file's name and
  /// records the path, which the first Save As offers again after a restore.
  readonly recoveryOriginalPath?: string
  /// Opened from a recovery copy and not saved since: the work exists only in
  /// the copy (the journal is empty), so the tab counts as unsaved.
  readonly unsavedRestore?: boolean
  /// Split-view save guard (@seuoffice/electron-utils/save-conflict): the disk
  /// snapshot this copy last read or wrote, with the document path it belongs
  /// to (a CSV session's snapshot is its .csv, not the converted temp copy).
  /// Recorded at open and after every successful save.
  readonly diskState?: { readonly path: string; readonly state: SaveDiskState }
}

// ---- runtime configuration (paths differ when bundled into the shell) ----

/** AI create_document content the sheets app cannot build itself — the shell
 * routes it into the docs-owned creation flow (docx opens a fresh docs tab). */
export interface SheetsAiHostDocumentRequest {
  type: 'docx' | 'pdf' | 'md' | 'html'
  title: string
  content: string
}

interface SheetsRuntimeConfig {
  /** absolute path to the sheets preload bundle */
  preloadPath: string
  /** dev-server URL for the sheets renderer (wins over rendererFile) */
  rendererUrl?: string | undefined
  /** absolute path to the built sheets renderer index.html */
  rendererFile: string
  /** absolute path to the Rust xlsx-sidecar binary */
  sidecarPath?: string | undefined
  /** Shell router used to open exported/AI-generated files in a new SeuOffice tab. */
  openGeneratedPath?: (path: string) => boolean
  /**
   * Host-owned cross-app document creator (the shell routes docx/pdf/md into Docs).
   * `ownerWebContentsId` is the asking view: its panel's project decides where
   * the document goes (spec 6).
   */
  createDocument?: (
    request: SheetsAiHostDocumentRequest,
    ownerWebContentsId?: number,
  ) => Promise<WorkbookCreateDocumentResult>
  /**
   * Project folders (spec 6): the folder an untitled document's save dialog
   * opens in for this view, or null for the default save folder.
   */
  newDocumentDir?: (webContentsId: number) => Promise<string | null>
  /**
   * Project folders (spec 6): write a new document the AI made in this view
   * into the project its panel chose (a free name, never over a file);
   * resolves to the path written, or null when the panel has no project.
   */
  writeNewDocument?: (
    webContentsId: number,
    fileName: string,
    bytes: Uint8Array,
  ) => Promise<string | null>
}

let runtime: SheetsRuntimeConfig = {
  preloadPath: join(__dirname, '../preload/index.js'),
  rendererUrl: process.env.ELECTRON_RENDERER_URL,
  rendererFile: join(__dirname, '../renderer/index.html'),
  createDocument: createStandaloneSheetsDocument,
}

export function configureSheetsRuntime(config: SheetsRuntimeConfig): void {
  runtime = config
}

/** After writing an exported/AI-generated file: open it in the right tab
 * (shell) or reveal it in the folder (standalone). Tab-opening failure must
 * not report the write itself as failed — the file is already persisted. */
function openGeneratedFile(path: string): void {
  // Headless export must stay silent: no tab, no file-manager window
  // (same guard as markdown-main's openExportedPdf, genoffice#1815).
  if (isHeadlessMode()) return
  try {
    if (runtime.openGeneratedPath?.(path)) return
  } catch (err) {
    console.warn('[sheets] Failed to open generated file:', err)
  }
  shell.showItemInFolder(path)
}

/** Pick a safe file-name stem for an AI-created file (mirrors docs' sanitizeAiDocFileBase). */
export function sanitizeGeneratedFileBase(title: string): string {
  const cleaned = String(title ?? '')
    // eslint-disable-next-line no-control-regex -- generated file names must reject controls
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 80)
    .trim()
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'Untitled'
}

/** first free path for fileName inside dir: name.ext, name-2.ext, name-3.ext… */
export function uniquePathIn(dir: string, fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const base = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''
  let candidate = join(dir, fileName)
  for (let i = 2; existsSync(candidate); i++) candidate = join(dir, `${base}-${i}${ext}`)
  return candidate
}

/** Standalone-window fallback for AI docx/pdf/md/html creation (mirrors pdf-main's
 * createStandaloneDocument): pdf renders in a hidden sandboxed window, md/html
 * write the source as-is; docx needs the Docs app and is refused. */
async function createStandaloneSheetsDocument(
  request: SheetsAiHostDocumentRequest,
): Promise<WorkbookCreateDocumentResult> {
  if (request.type === 'docx') {
    // read by the model as the tool's answer: English, with the product's own name
    return {
      ok: false,
      error: 'Creating DOCX files requires the SeuOffice shell or Docs app.',
    }
  }
  const title = sanitizeGeneratedFileBase(request.title)
  try {
    if (request.type === 'pdf') {
      const bytes = await printHtmlToPdf(
        buildPrintableHtml(title, request.content),
        () =>
          new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } }),
      )
      const path = uniquePathIn(configuredDefaultSaveDir(app), `${title}.pdf`)
      await writeFile(path, bytes)
      openGeneratedFile(path)
      return { ok: true, path }
    }
    const path = uniquePathIn(configuredDefaultSaveDir(app), `${title}.${request.type}`)
    await writeFile(path, request.content, 'utf8')
    openGeneratedFile(path)
    return { ok: true, path }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

let mainWindow: BrowserWindow | null = null
let sidecar: XlsxSidecarClient | null = null

/** the single real BrowserWindow hosting the tab strip, used as dialog parent in tab mode */
let sheetsShellWindow: BrowserWindow | null = null
export function setSheetsShellWindow(win: BrowserWindow | null): void {
  sheetsShellWindow = win
}

/** the window hosting a tab's WebContentsView when BrowserWindow.fromWebContents
 *  cannot tell (detached "Open in New Window" editors) */
let hostWindowHook: ((wc: WebContents) => BrowserWindow | undefined) | null = null
export function setSheetsHostWindowHook(
  fn: ((wc: WebContents) => BrowserWindow | undefined) | null,
): void {
  hostWindowHook = fn
}

/// The shell registers how to bring a tab (by webContents id) to the front —
/// the cross-workbook picker re-activates the editing tab after a pick.
let activateTabHook: ((wcId: number) => void) | null = null
export function setSheetsActivateTabHook(fn: ((wcId: number) => void) | null): void {
  activateTabHook = fn
}

function hostWindowFor(wc: WebContents): BrowserWindow | undefined {
  const own = hostWindowHook?.(wc) ?? BrowserWindow.fromWebContents(wc)
  if (own && !own.isDestroyed()) return own
  return sheetsShellWindow && !sheetsShellWindow.isDestroyed() ? sheetsShellWindow : undefined
}

interface SheetsTabSession {
  readonly webContents: WebContents
  readonly client: XlsxSidecarClient
  readonly sessions: Map<string, SessionInfo>
  readonly aiStreams: Map<string, AbortController>
  /// Chunked uploads of large saves' cell edits, pending their save request.
  readonly saveTransfers: SaveEditsTransferStore
  /// The file this tab currently shows (merge sources excluded) — what the
  /// cross-workbook picker matches external links against. null until the
  /// first open lands; Save As keeps it current.
  currentPath: string | null
}

/** per-tab session state, keyed by webContents.id — replaces the old single-window closures
 * that `registerIpcHandlers`/`validateSender` used to capture, which broke as soon as a second
 * tab (or a closed-then-reopened tab) registered and overwrote the previous closure. */
/// Same ceiling as local add_image (readLocalImage's 20MB check)
const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024
// the .csv/.tsv ceiling lives with the numbers it describes (the gateway's
// csv-limits, exposed through csv-import-limit)

/**
 * The delimited import (a .csv/.tsv opened as a workbook) that is running for
 * a tab, so the renderer can cancel it: a 250 MB file takes a while, and the
 * user should not have to wait it out.
 */
const pendingImports = new ImportRegistry()

const sheetsTabs = new Map<number, SheetsTabSession>()
let activeSheetsWebContents: WebContents | null = null
let pastedTempCleanupStarted = false

function startPastedTempCleanup(): void {
  if (pastedTempCleanupStarted) return
  pastedTempCleanupStarted = true
  void cleanupExpiredPastedFiles(app.getPath('temp'))
}

function sessionFor(event: IpcMainInvokeEvent): SheetsTabSession {
  const entry = sheetsTabs.get(event.sender.id)
  if (!entry) throw new Error('Untrusted IPC sender.')
  return entry
}

/**
 * Parts the connection walk reads: the connections part, the workbook and its
 * relationships, sheet relationship parts, tables and query tables. Worksheet
 * cell data is never read, so the prefetch stays small even for a big sheet.
 */
function isConnectionWalkPart(name: string): boolean {
  return (
    name === 'xl/connections.xml' ||
    name === 'xl/workbook.xml' ||
    name === 'xl/_rels/workbook.xml.rels' ||
    name.startsWith('xl/tables/') ||
    name.startsWith('xl/queryTables/') ||
    /^xl\/worksheets\/_rels\/[^/]+\.rels$/.test(name)
  )
}

/**
 * A part reader over a session snapshot for the connection walk. The walk asks
 * for parts by path, so every part it can ask for is fetched in one sidecar
 * round trip; a part the manifest does not list reads as undefined.
 */
async function connectionPartReader(
  client: ArchiveClient,
  snapshotPath: string,
): Promise<PartReader> {
  const manifest = z
    .object({ entries: z.array(z.object({ name: z.string() })) })
    .parse(await client.archiveManifest(snapshotPath))
  const wanted = manifest.entries.map((entry) => entry.name).filter(isConnectionWalkPart)
  const texts = await readArchiveEntriesText(client, snapshotPath, wanted)
  return async (path) => texts.get(path)
}

/**
 * Local media roots for a sheets renderer: the directories of the workbooks its
 * tab has open, plus the directory sheets stages pasted images in. A tab can
 * hold several workbook sessions, so every open one contributes its directory —
 * a tool call naming a file the user put next to the workbook they are editing
 * is the legitimate case, and nothing else is readable.
 */
function sheetsMediaRoots(wcId: number): string[] {
  const tab = sheetsTabs.get(wcId)
  const workbookDirs = tab ? [...tab.sessions.values()].map((s) => dirname(s.path)) : []
  return localMediaRoots(...workbookDirs, join(app.getPath('temp'), 'seuoffice-pasted'))
}

/// A save request referencing a chunked edit transfer gets the accumulated
/// edits spliced back in; the transfer is consumed either way.
function resolveTransferredEdits(
  entry: SheetsTabSession,
  request: WorkbookSaveRequest,
): WorkbookSaveRequest {
  if (request.editsTransferId === undefined) return request
  if (request.edits.length > 0) throw new Error('Save request mixes inline and transferred edits.')
  const edits = entry.saveTransfers.take(request.editsTransferId, request.sessionId)
  return { ...request, edits }
}

function dialogParent(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  return hostWindowFor(event.sender)
}

async function openFileDialog(event: IpcMainInvokeEvent, options: OpenDialogOptions) {
  return showOpenDialogWithMemory(dialog, dialogParent(event), options)
}

async function saveFileDialog(event: IpcMainInvokeEvent, options: SaveDialogOptions) {
  // before any pick is remembered, bare-name suggestions anchor in the
  // configurable default save folder instead of Electron's Downloads pin
  return showSaveDialogWithMemory(dialog, dialogParent(event), options, () =>
    configuredDefaultSaveDir(app),
  )
}

/** The .xlsx-shaped document path a session's Save As defaults are built from. */
function workbookSuggestion(session: SessionInfo): string {
  return (
    session.suggestSaveAs ??
    (session.csvSourcePath === undefined ? undefined : saveAsDefaultFor(session.csvSourcePath)) ??
    session.restoreTarget ??
    session.path
  )
}

/** The ODS export's default: the workbook's base name and folder, plus .ods. */
async function suggestedOdsPath(session: SessionInfo): Promise<string> {
  const source = workbookSuggestion(session)
  const name = basename(source)
  const stem = name.slice(0, name.length - extname(name).length) || name
  const candidate = join(dirname(source), `${stem}.ods`)
  // An .ods-converted session's base name points back at the protected
  // original; offer the next free name instead of a target it must refuse.
  if (
    session.odsSourcePath !== undefined &&
    (await sameFilePath(candidate, session.odsSourcePath))
  ) {
    return uniquePathIn(dirname(candidate), basename(candidate))
  }
  return candidate
}

/** Both paths resolved through symlinks where they exist, then case-folded on Windows. */
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolvePath(path)
  try {
    return await realpath(absolute)
  } catch {
    try {
      return join(await realpath(dirname(absolute)), basename(absolute))
    } catch {
      return absolute
    }
  }
}

async function sameFilePath(a: string, b: string): Promise<boolean> {
  const [left, right] = [await canonicalPath(a), await canonicalPath(b)]
  // The original-protection rule is deliberately case-insensitive everywhere:
  // refusing a name the person can freely change is cheaper than writing over
  // the original on a case-insensitive volume.
  return left.toLowerCase() === right.toLowerCase()
}

/** Dialogs that omit the extension (some Linux desktops) still write .ods. */
function odsTargetPath(path: string): string {
  return /\.ods$/i.test(path) ? path : `${path}.ods`
}

/** The ODS export's own save dialog; undefined when the person cancels. */
async function askOdsTarget(
  event: IpcMainInvokeEvent,
  defaultPath: string,
): Promise<string | undefined> {
  const selection = await saveFileDialog(event, {
    defaultPath,
    filters: [{ name: tm('filterOds'), extensions: ['ods'] }],
  })
  if (selection.canceled || !selection.filePath) return undefined
  return odsTargetPath(selection.filePath)
}

const ODS_LOSS_LABELS: Record<OdsLossKind, Parameters<typeof tMain>[1]> = {
  formulas: 'odsLossFormulas',
  charts: 'odsLossCharts',
  images: 'odsLossImages',
  conditionalFormats: 'odsLossConditionalFormats',
  validations: 'odsLossValidations',
  pivots: 'odsLossPivots',
  comments: 'odsLossComments',
  macros: 'odsLossMacros',
  shapes: 'odsLossShapes',
  slicers: 'odsLossSlicers',
  sparklines: 'odsLossSparklines',
}

/** One warning listing only what this workbook actually loses, then Continue/Cancel. */
async function confirmOdsLoss(
  parent: BrowserWindow | undefined,
  losses: readonly OdsLoss[],
): Promise<boolean> {
  const detail = [
    tm('odsLossDetail'),
    '',
    // a count that could not be read is shown as unknown, never as none
    ...losses.map((loss) => `• ${tm(ODS_LOSS_LABELS[loss.kind], { count: loss.count ?? '?' })}`),
  ].join('\n')
  const options = {
    type: 'warning' as const,
    message: tm('odsLossMsg'),
    detail,
    buttons: [tm('odsContinueBtn'), tm('btnCancel')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  const { response } =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
  return response === 0
}

/**
 * A copy format that cannot keep the marks hiding cells from the AI is refused
 * before anything is written. The person chooses the native format, which
 * keeps them, or Cancel and clears the marks first.
 */
async function askWithheldExport(
  parent: BrowserWindow | undefined,
  format: 'ODS' | 'CSV',
): Promise<'xlsx' | 'export' | 'cancel'> {
  const options = {
    type: 'warning' as const,
    message: tm('withheldExportMsg', { format }),
    detail: tm('withheldExportDetail', { format }),
    buttons: [
      tm('csvKeepXlsxBtn'),
      tm('withheldExportWithoutMarksBtn', { format }),
      tm('btnCancel'),
    ],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  }
  const { response } =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
  return response === 0 ? 'xlsx' : response === 1 ? 'export' : 'cancel'
}

async function showOdsMessage(
  parent: BrowserWindow | undefined,
  type: 'error' | 'warning',
  message: string,
): Promise<void> {
  const options = {
    type,
    message,
    buttons: [tm('btnCloseDialog')],
    defaultId: 0,
    noLink: true,
  }
  if (parent && !parent.isDestroyed()) await dialog.showMessageBox(parent, options)
  else await dialog.showMessageBox(options)
}

/** Split-view save-guard outcome: 'overwrite' = the user confirmed replacing
 *  a sibling copy's change on disk, so this write skips the legacy
 *  external-change check for the document path. */
type SplitSaveVerdict = 'proceed' | 'cancel' | 'overwrite'

/** The disk snapshot recorded for `path`, or undefined when this session last
 *  read or wrote another path (a CSV session's state belongs to its .csv). */
function recordedStateFor(session: SessionInfo, path: string): SaveDiskState | undefined {
  return session.diskState?.path === path ? session.diskState.state : undefined
}

/**
 * The folder a workbook's relative link targets start from: that of the file
 * the person opened. A password workbook (and a restored copy) runs on a
 * working copy elsewhere, and "the file beside this one" is not beside that.
 */
function externalLinkBaseDir(session: SessionInfo): string {
  return dirname(session.restoreTarget ?? session.path)
}

/**
 * The same-document (split view) save guard: when the path is open in another
 * pane and the disk moved past this copy's recorded state, a background save
 * (quiet/AutoSave) defers silently — 'cancel' — while a manual save asks
 * whether to overwrite the sibling's change. Cancelling keeps the disk copy
 * and leaves this session dirty; 'overwrite' lets the caller skip the legacy
 * external-change check for this one write. A path open nowhere else skips
 * the guard entirely, so an ordinary save behaves exactly as before.
 */
async function guardSplitSave(options: {
  path: string
  recorded: SaveDiskState | undefined
  quiet: boolean
  event: IpcMainInvokeEvent
}): Promise<SplitSaveVerdict> {
  if (options.quiet) {
    return (await shouldDeferAutoSave(options.path, options.recorded)) ? 'cancel' : 'proceed'
  }
  if (!isPathOpenElsewhere(options.path)) return 'proceed'
  if (!(await isModifiedSince(options.recorded, options.path))) return 'proceed'
  const verdict = await confirmOverwriteIfConflicted({
    parent: dialogParent(options.event) ?? null,
    path: options.path,
    recorded: options.recorded,
    lang: getUiLang(),
  })
  return verdict === 'proceed' ? 'overwrite' : 'cancel'
}

/** Workbook file extensions the open pipeline accepts. Single source for the
 *  picker filters, the merge-source check, and the crash re-open check. */
const WORKBOOK_EXTS = new Set(['xlsx', 'xlsm', 'xls', 'csv', 'tsv'])

/** register a tab's webContents/client pair and wire up cleanup on teardown */
/** Clients whose process-death notification is already wired. A sidecar client
 *  is shared by every tab (the `sidecar ?? new XlsxSidecarClient(...)` reuse),
 *  so the wiring is per client and the crash is broadcast to the tabs using
 *  it — not attached once per tab, which would notify N times over. */
const crashNotifiedClients = new WeakSet<XlsxSidecarClient>()

/** Tell every live tab that the sidecar died, so it can re-open its workbook
 *  and adopt a live session. Positive signal: a workbook the app closed on
 *  purpose (closeWorkbook) or swapped during Save never reaches the client,
 *  because those only send a `close` command down the live pipe. */
function broadcastSidecarCrash(client: XlsxSidecarClient): void {
  for (const entry of sheetsTabs.values()) {
    if (entry.client !== client) continue
    if (entry.webContents.isDestroyed()) continue
    entry.webContents.send(IPC_CHANNELS.sidecarCrashed)
  }
}

function registerSheetsSession(webContents: WebContents, client: XlsxSidecarClient): void {
  startPastedTempCleanup()
  if (!crashNotifiedClients.has(client)) {
    crashNotifiedClients.add(client)
    client.onProcessExit(() => broadcastSidecarCrash(client))
  }
  sheetsTabs.set(webContents.id, {
    webContents,
    client,
    sessions: new Map(),
    aiStreams: new Map(),
    saveTransfers: new SaveEditsTransferStore(),
    currentPath: null,
  })
  activeSheetsWebContents = webContents
  // a dead renderer's copies are what the shell reopens the tab from
  webContents.on('render-process-gone', () => {
    tabRecoveryFor(webContents.id).crashed = true
  })
  webContents.once('destroyed', () => {
    const entry = sheetsTabs.get(webContents.id)
    sheetsTabs.delete(webContents.id)
    saveAsExportTargets.forget(webContents.id)
    // before the sessions are cleared below: a clean close drops the copies it wrote
    if (entry) settleTabRecoveryOnClose(webContents.id, entry)
    else tabRecovery.delete(webContents.id)
    if (entry) {
      // Free pending chunked-save uploads with the tab (the sweep timer's
      // closure would otherwise keep them reachable until the idle expiry).
      entry.saveTransfers.dispose()
      void closeAllSessions(entry)
    }
    if (activeSheetsWebContents === webContents) activeSheetsWebContents = null
  })
}

export function getSheetsWindow(): BrowserWindow | null {
  return mainWindow
}

/** the webContents of whichever sheets tab most recently registered or activated */
export function getActiveSheetsWebContents(): WebContents | null {
  return activeSheetsWebContents
}

/** shell tab switching keeps menu actions routed at the visible sheets tab */
export function setActiveSheetsWebContents(wc: WebContents | null): void {
  activeSheetsWebContents = wc
}

/** Shell notification: an open view's file was renamed on disk (renamed in the
 *  Home list) — sync the matching session's path in that tab (later saves write
 *  the new file) and push the renderer to update the title-bar file name. */
export function sheetsFileRenamed(wc: WebContents, oldPath: string, newPath: string): void {
  // A user-chosen name always wins: the file no longer qualifies for auto-rename.
  // A move that keeps the untitled name (folder tree), including the "(2)"
  // suffix a keep-both move adds, does not count as choosing one.
  const stem = (p: string) => basename(p).replace(/ \(\d+\)(?=\.[^.]+$)/, '')
  if (untitledWorkbookPaths.delete(oldPath) && stem(newPath) === stem(oldPath)) {
    untitledWorkbookPaths.add(newPath)
  }
  const entry = sheetsTabs.get(wc.id)
  if (!entry) return
  let matched = false
  for (const [id, session] of entry.sessions) {
    // Converted copies (.csv / .xls / .tsv) and restored recovery copies keep
    // the user's file in a side field, not in `path`; move those too, or the
    // next Save recreates the file under the old name.
    let renamed = sessionAfterRename(session, oldPath, newPath)
    if (renamed === null) continue
    // An unsaved new workbook's tab renames its hidden backing file; the name
    // the user typed is what the first Save As should offer (and the title its
    // next recovery copy carries — the copy itself keeps its untitled slot).
    if (session.unsavedNew && session.path === oldPath && session.suggestSaveAs !== undefined) {
      const suggested = join(dirname(session.suggestSaveAs), basename(newPath))
      if (
        suggested !== session.suggestSaveAs &&
        !existsSync(suggested) &&
        !sheetsSuggestedPathTaken(suggested)
      )
        renamed = { ...renamed, suggestSaveAs: suggested }
    }
    // A rename moves the same bytes: the split-view disk snapshot follows the
    // path so the save guard still judges the right file.
    if (renamed.diskState?.path === oldPath) {
      renamed = { ...renamed, diskState: { path: newPath, state: renamed.diskState.state } }
    }
    entry.sessions.set(id, renamed)
    matched = true
  }
  if (matched) wc.send(IPC_CHANNELS.workbookRenamed, basename(newPath))
}

/**
 * Workbooks the shell pre-created on disk with the localized untitled name
 * ("New Spreadsheet"). Only these ever qualify for the content-derived
 * auto-rename after an AI run; any manual rename removes the mark.
 */
const untitledWorkbookPaths = new Set<string>()
export function markSheetsUntitledPath(path: string): void {
  untitledWorkbookPaths.add(path)
}

/**
 * Backing workbooks the shell created in a temp directory for "New
 * spreadsheet". The user has no file yet — it only comes into existence at the
 * first Save, which this routes through Save As — and a tab closed without
 * saving discards the temp directory with it. Same shape as an .xls/.tsv
 * import: the file the session edits is not the user's file.
 */
interface UnsavedNewWorkbook {
  suggestSaveAs: string
  tempDir: string
  /** the untitled document's recovery copy (its identity outlives session swaps) */
  recovery: RecoveryIdentity
  /** the backing file holds a recovery copy's content: the tab opens unsaved */
  restored?: boolean
  /** a CSV or converted workbook's copy: the file it came from (see SessionInfo) */
  originalPath?: string
  /** the copy came from an .ods conversion: the restored tab keeps its footer notice */
  odsConverted?: boolean
  formulasDropped?: number
  /** the original .ods the copy came from (never an export target) */
  odsSourcePath?: string
}
const unsavedNewWorkbooks = new Map<string, UnsavedNewWorkbook>()

/**
 * shell: a would-be path already promised to another unsaved new workbook (open
 * tab or tab about to open). The file itself does not exist yet, so uniqueness
 * on disk is not enough.
 */
export function sheetsSuggestedPathTaken(path: string): boolean {
  for (const pending of unsavedNewWorkbooks.values())
    if (pending.suggestSaveAs === path) return true
  for (const tab of sheetsTabs.values())
    for (const session of tab.sessions.values()) if (session.suggestSaveAs === path) return true
  return false
}

/** shell: mark a backing workbook it just created as not-yet-saved (see above) */
export function markSheetsUnsavedNew(
  openPath: string,
  suggestSaveAs: string,
  tempDir: string,
): void {
  unsavedNewWorkbooks.set(openPath, {
    suggestSaveAs,
    tempDir,
    recovery: {
      kind: 'sheets',
      untitledId: newUntitledRecoveryId(),
      ext: untitledWorkbookExt(suggestSaveAs),
    },
  })
}

/** shell: the backing workbook could not be written, release its name */
export function unmarkSheetsUnsavedNew(openPath: string): void {
  unsavedNewWorkbooks.delete(openPath)
}

const mcpWritablePaths = new Map<number, Set<string>>()

/** Save As › PDF targets the dialog returned, accepted once by the PDF export */
const saveAsExportTargets = new SaveAsExportTargets()

/** MCP save_session: the shell resolved this path for the tab, so a dialog-free save may write it */
export function authorizeMcpSheetWrite(wcId: number, filePath: string): void {
  const set = mcpWritablePaths.get(wcId) ?? new Set<string>()
  set.add(filePath)
  mcpWritablePaths.set(wcId, set)
}

function canMcpSheetWrite(wcId: number, filePath: string): boolean {
  return mcpWritablePaths.get(wcId)?.has(filePath) === true
}

/** Sanitize an AI-provided sheet name into a safe filename base: strip illegal path chars, collapse whitespace, cap length; null if invalid. (Mirrors slides' draft naming.) */
function sanitizeAutoRenameBase(raw: string): string | null {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point here
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim()
  if (!cleaned) return null
  return cleaned.length > 40 ? cleaned.slice(0, 40).trim() : cleaned
}

/** shell hook: a tab opened a workbook (dialog or queued path) — used for tab titles/dedupe */
let workbookOpenedHook: ((wc: WebContents, path: string) => void) | null = null
export function setSheetsWorkbookOpenedHook(
  fn: ((wc: WebContents, path: string) => void) | null,
): void {
  workbookOpenedHook = fn
}

/** One password prompt for a file: `ask` is one attempt, `close` ends the prompt. */
export interface SheetsPasswordPrompt {
  ask: OfficePasswordAsk
  close: () => void
}

/** shell hook: the open-password prompt for encrypted workbooks (none in standalone) */
let passwordPromptFactory:
  ((parent: BrowserWindow | undefined, fileName: string) => SheetsPasswordPrompt) | null = null
export function setSheetsPasswordPrompt(
  fn: ((parent: BrowserWindow | undefined, fileName: string) => SheetsPasswordPrompt) | null,
): void {
  passwordPromptFactory = fn
}

/** forward an application-menu File command into the sheets renderer */
export function sendSheetsMenuAction(
  action:
    | 'open'
    | 'save'
    | 'save-as'
    | 'print'
    | 'export-pdf'
    | 'export-csv'
    | 'export-ods'
    | 'undo'
    | 'redo',
): void {
  activeSheetsWebContents?.send(IPC_CHANNELS.menuAction, action)
}

/** An already-mounted renderer polled for its queued workbook before one existed. */
export function nudgeQueuedWorkbook(contents: WebContents): void {
  contents.send(IPC_CHANNELS.menuAction, 'open')
}

// ---- AI settings persistence (main process avoids renderer CORS for the chat/stream proxy) ----

function userDataPath(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
}

// ── Crash recovery ──────────────────────────────────────────
// A dirty renderer asks for a recovery copy every 30s; it is written through the
// normal save pipeline (writeWorkbookTo) and handed to the shared recovery store,
// so it is a real workbook under <userData>/sheets-autosave (the folder and the
// sha1(path) naming earlier versions used). A successful save or "Don't Save"
// removes it; opening a file that has one asks with the shared named prompt
// first, unless the launch list already chose. A new workbook (a temp backing
// file the user never saved) is untitled: its copy lives in the store's
// untitled slot under the tab's title, never in a user folder. A password
// workbook gets no copy at all — it would be plaintext (decision 0041).
const recoveryStore = createRecoveryStore({ userDataDir: () => app.getPath('userData') })
const recoveryDir = () => userDataPath(recoveryFolderName('sheets'))
const fileRecoveryIdentity = (filePath: string): RecoveryIdentity => ({
  kind: 'sheets',
  filePath,
})

/**
 * Move the unsaved new workbooks an earlier version listed in
 * `unsaved-new.json` into untitled "later" copies (see migrateLegacyUnsavedNew).
 * Safe to call any number of times; a no-op once the old index is gone. The
 * shell calls it before it lists copies for the launch list.
 */
export function migrateSheetsLegacyRecovery(): void {
  try {
    migrateLegacyUnsavedNew(recoveryStore, recoveryDir())
  } catch (error) {
    console.warn('[sheets] legacy recovery migration failed:', error)
  }
}

/**
 * Formerly the would-be paths of new workbooks to reopen at every launch.
 * Untitled copies are now offered by the launch list instead, so this only
 * migrates the old index and answers nothing to reopen.
 * @deprecated list untitled copies with listSheetsUntitledCopies (or the shared store)
 */
export function pendingUnsavedNewRecoveries(): string[] {
  migrateSheetsLegacyRecovery()
  return []
}

/** shell: the untitled workbook copies the store holds (the legacy index migrated first) */
export function listSheetsUntitledCopies(
  states?: readonly RecoveryCopyState[],
): RecoveryCopyInfo[] {
  migrateSheetsLegacyRecovery()
  return recoveryStore.listCopies({
    kinds: ['sheets'],
    untitled: true,
    ...(states ? { states } : {}),
  })
}

/**
 * The untitled workbook copy this tab writes, if its workbook is a new one
 * (the shell's session record keeps the tab by it rather than by its temp
 * backing file, and reopens it after a renderer crash). Null otherwise.
 */
export function sheetsRecoveryIdentity(webContentsId: number): RecoveryIdentity | null {
  let identity: RecoveryIdentity | null = null
  for (const session of sheetsTabs.get(webContentsId)?.sessions.values() ?? []) {
    const candidate = sessionRecoveryIdentity(session)
    if (candidate && isUntitledIdentity(candidate)) identity = candidate
  }
  return identity
}

/** Per-tab recovery bookkeeping, keyed by webContents id. */
interface TabRecoveryState {
  /** copies this tab wrote, by copy path: a clean close removes only these */
  readonly written: Map<string, RecoveryIdentity>
  /** copies whose session closed while still unsaved: a clean close keeps them */
  readonly keep: Set<string>
  /**
   * copies this tab must neither write nor delete, by copy path: another
   * tab's (a second view of the same file), or one whose question could not
   * be answered when the file opened (left for later)
   */
  readonly held: Set<string>
  /**
   * "Don't Save" was answered: late copy writes from this tab are dropped
   * until the close is vetoed (resetSheetsShuttingDown)
   */
  discarded: boolean
  /** the renderer died: its copies are what the shell reopens from */
  crashed: boolean
  /** the password notice was shown in this tab */
  noticeShown: boolean
}

const tabRecovery = new Map<number, TabRecoveryState>()

function tabRecoveryFor(contentsId: number): TabRecoveryState {
  let state = tabRecovery.get(contentsId)
  if (!state) {
    state = {
      written: new Map(),
      keep: new Set(),
      held: new Set(),
      discarded: false,
      crashed: false,
      noticeShown: false,
    }
    tabRecovery.set(contentsId, state)
  }
  return state
}

/**
 * the copy title: a CSV or converted workbook shows the file it came from, an
 * untitled workbook its tab title, a file its name
 */
function recoveryTitleFor(session: SessionInfo): string | undefined {
  if (session.recoveryOriginalPath !== undefined) return basename(session.recoveryOriginalPath)
  return session.unsavedNew && session.suggestSaveAs !== undefined
    ? basename(session.suggestSaveAs)
    : undefined
}

/**
 * Work that exists only as a recovery copy, not in the renderer's journal: a
 * restored copy before its first save, and a new workbook whose quiet
 * AutoSave moved the edits into its backing file. Counted as unsaved, so the
 * tab shows it and the close guard asks.
 */
function sessionHasUnsavedCopy(session: SessionInfo): boolean {
  if (session.unsavedRestore) return true
  if (!session.unsavedNew) return false
  const identity = sessionRecoveryIdentity(session)
  return identity !== null && recoveryStore.copyInfo(identity) !== null
}

function unsavedCopySessions(contentsId: number): number {
  let count = 0
  for (const session of sheetsTabs.get(contentsId)?.sessions.values() ?? [])
    if (sessionHasUnsavedCopy(session)) count += 1
  return count
}

/** Move a finished file into place, copying when it lives on another volume. */
async function moveFileInto(source: string, target: string): Promise<void> {
  try {
    await rename(source, target)
  } catch {
    await copyFile(source, target)
  }
}

/**
 * Write one session's copy through the store; false when it has none, this
 * tab holds it, or it was superseded. The workbook is written to disk and
 * handed over by path (writeCopyStreamed), never read into memory. It is
 * produced in a temp folder of its own first: the archive writer leaves its
 * scratch file beside its target, and that must not end up in the recovery
 * folder if the app dies mid-write.
 */
async function writeSessionCopy(
  contentsId: number,
  session: SessionInfo,
  produce: (target: string) => Promise<unknown>,
  options: { ignoreSizeLimit?: boolean } = {},
): Promise<boolean> {
  // a headless export's hidden view converts the file and goes; it keeps no copy
  if (isHeadlessMode()) return false
  const identity = sessionRecoveryIdentity(session)
  if (identity === null) return false
  if (session.automaticRecoveryDisabled && !options.ignoreSizeLimit) return false
  const state = tabRecovery.get(contentsId)
  if (state?.discarded || state?.held.has(recoveryStore.copyPath(identity))) return false
  // taken before serializing: a save or "Don't Save" that lands meanwhile wins
  const ticket = recoveryStore.beginWrite(identity)
  const title = recoveryTitleFor(session)
  const result = await recoveryStore.writeCopyStreamed(
    identity,
    async (storeTemp) => {
      const directory = join(app.getPath('temp'), 'seuoffice-imports', randomUUID())
      try {
        await mkdir(directory, { recursive: true })
        const target = join(directory, `recovery${untitledWorkbookExt(session.path)}`)
        await produce(target)
        await moveFileInto(target, storeTemp)
      } finally {
        await cleanupImportTempDirectory(app.getPath('temp'), directory).catch(() => undefined)
      }
    },
    {
      ticket,
      ...(title === undefined ? {} : { title }),
      ...(session.recoveryOriginalPath === undefined
        ? {}
        : { originalPath: session.recoveryOriginalPath }),
      // a converted .ods keeps its formula count in the copy, so a restore
      // shows the same footer line (0 needs no record: absent reads as 0)
      ...(session.odsConverted &&
      session.formulasDropped !== undefined &&
      session.formulasDropped > 0
        ? { formulasDropped: session.formulasDropped }
        : {}),
    },
  )
  if (result !== 'written') return false
  tabRecoveryFor(contentsId).written.set(recoveryStore.copyPath(identity), identity)
  return true
}

/** a successful save: the document's copies are no longer needed */
function deleteCopiesAfterSave(contentsId: number, identities: (RecoveryIdentity | null)[]): void {
  const state = tabRecovery.get(contentsId)
  for (const identity of identities) {
    if (identity === null) continue
    // another tab's copy, or one still waiting for its question: not this save's
    if (state?.held.has(recoveryStore.copyPath(identity))) continue
    recoveryStore.deleteCopy(identity, 'saved')
    state?.written.delete(recoveryStore.copyPath(identity))
    state?.keep.delete(recoveryStore.copyPath(identity))
  }
}

/** "Don't Save" in the close prompt: drop every copy of the tab, and any late write */
function discardTabCopies(contentsId: number): void {
  const state = tabRecoveryFor(contentsId)
  state.discarded = true
  const identities = new Map(state.written)
  for (const session of sheetsTabs.get(contentsId)?.sessions.values() ?? []) {
    const identity = sessionRecoveryIdentity(session)
    if (identity !== null) identities.set(recoveryStore.copyPath(identity), identity)
  }
  for (const [key, identity] of identities) {
    if (!state.held.has(key)) recoveryStore.deleteCopy(identity, 'dontSave')
  }
  state.written.clear()
  state.keep.clear()
}

/**
 * MCP / AI closes this tab without saving (the shell then closes it with no
 * prompt): the same as answering "Don't Save" — the tab's copies go, and a
 * late copy write from the closing renderer is dropped.
 */
export function discardSheetsRecovery(contents: WebContents): void {
  if (contents.isDestroyed()) return
  discardTabCopies(contents.id)
}

/**
 * A close that was answered "Don't Save" was vetoed afterwards (another
 * tab's prompt cancelled the window close or the quit): the tab stays open
 * with its unsaved work, so its copies are written again.
 */
function resumeDiscardedTabCopies(): void {
  for (const state of tabRecovery.values()) state.discarded = false
}

/** a workbook session closes: remember a copy that still holds unsaved work */
function noteSessionClosed(contentsId: number, session: SessionInfo): void {
  const identity = sessionRecoveryIdentity(session)
  if (identity === null) return
  const unsaved = sessionHasUnsavedCopy(session) || (pendingEditCounts.get(contentsId) ?? 0) > 0
  if (unsaved) tabRecoveryFor(contentsId).keep.add(recoveryStore.copyPath(identity))
}

/**
 * The tab is going away. A clean tab removes the copies it wrote, except those
 * still holding unsaved work; a crashed renderer, a dirty tab and the app
 * ending (the store refuses then) keep everything.
 */
function settleTabRecoveryOnClose(contentsId: number, entry: SheetsTabSession): void {
  const state = tabRecovery.get(contentsId)
  decidedOpens.delete(contentsId)
  if (!state) return
  if (!state.crashed && !state.discarded) {
    for (const session of entry.sessions.values()) noteSessionClosed(contentsId, session)
    if ((pendingEditCounts.get(contentsId) ?? 0) === 0) {
      for (const [key, identity] of state.written) {
        if (!state.keep.has(key)) recoveryStore.deleteCopy(identity, 'closedClean')
      }
    }
  }
  tabRecovery.delete(contentsId)
}

/** shown once per tab when a workbook without a possible copy opens in it */
function showUnprotectableNotice(contents: WebContents): void {
  if (contents.isDestroyed()) return
  const state = tabRecoveryFor(contents.id)
  if (state.noticeShown) return
  state.noticeShown = true
  contents.send(IPC_CHANNELS.recoveryNotice, unprotectableNoticeText(getUiLang()))
}

/**
 * Opens the shell answered for a tab (launch list, restored tab): the file's
 * recovery question is settled, so its next open of that path does not ask.
 */
const decidedOpens = new Map<number, RecoveryOpenFileRequest>()

/** Load copy bytes into a temp file the session runs on (the original stays untouched). */
async function stageRecoveredCopy(
  bytes: Buffer,
  name: string,
): Promise<{ openPath: string; importTempDir: string }> {
  const directory = join(app.getPath('temp'), 'seuoffice-imports', randomUUID())
  await mkdir(directory, { recursive: true })
  const openPath = join(directory, name)
  try {
    await writeFile(openPath, bytes)
  } catch (error) {
    await cleanupImportTempDirectory(app.getPath('temp'), directory)
    throw error
  }
  return { openPath, importTempDir: directory }
}

/**
 * A file's recovery copy, settled before its content loads: the launch
 * list's decision when there is one, else the named per-file prompt (Esc and
 * closing restore). Restoring opens the copy's bytes from a temp file with the
 * user's file as the save target (`restoreTarget`) and the tab unsaved;
 * discarding deletes the copy. Null opens the file as saved.
 */
async function recoveredOpenFor(
  path: string,
  contents: WebContents | undefined,
  parent: BrowserWindow | undefined,
): Promise<PreparedWorkbookOpen | null> {
  // a headless export converts the file on disk: no one is there to answer the
  // prompt (whose Esc restores), and a copy it neither uses nor settles stays as it was
  if (isHeadlessMode()) return null
  const identity = fileRecoveryIdentity(path)
  const key = recoveryStore.copyPath(identity)
  const decided = contents ? decidedOpens.get(contents.id) : undefined
  const isDecided = decided !== undefined && contents !== undefined && decided.filePath === path
  if (isDecided) decidedOpens.delete(contents.id)
  const held = contents ? tabRecoveryFor(contents.id).held : undefined
  held?.delete(key)
  // a second view (split) of a file another tab keeps a copy for: that copy
  // is the other tab's unsaved work, so nothing is asked and nothing in this
  // tab writes or deletes it
  if (contents !== undefined && copyOwnedByAnotherView(contents.id, identity)) {
    held?.add(key)
    return null
  }
  if (isDecided && decided.decision === 'original') return null
  try {
    let bytes: Buffer | null = null
    if (isDecided) {
      bytes = await recoveryStore.readCopy(identity)
      if (bytes) recoveryStore.markCopyLoaded(identity)
    } else {
      const resolved = await resolveRecoveryOnOpen({
        store: recoveryStore,
        identity,
        dialog,
        parent: parent ?? null,
        lang: getUiLang(),
      })
      if (resolved.action === 'restore') bytes = resolved.bytes
    }
    if (!bytes) return null
    const staged = await stageRecoveredCopy(bytes, basename(path))
    return { ...staged, restoreTarget: path, unsavedRestore: true }
  } catch (error) {
    // The copy could not be prepared: the file opens as saved and the copy
    // waits for the next open or launch, untouched by this tab meanwhile.
    console.warn('[sheets] recovery copy could not be opened:', error)
    try {
      recoveryStore.setCopyState(identity, 'later')
    } catch (stateError) {
      console.warn('[sheets] recovery copy state could not be kept:', stateError)
    }
    held?.add(key)
    return null
  }
}

/**
 * Another live sheets tab keeps the document's copy: the copy exists, and
 * that tab has the document open restored from it or has written it (not
 * merely opened the file beside it).
 */
function copyOwnedByAnotherView(contentsId: number, identity: RecoveryIdentity): boolean {
  if (recoveryStore.openPlan(identity).action === 'none') return false
  const key = recoveryStore.copyPath(identity)
  for (const [id, entry] of sheetsTabs) {
    if (id === contentsId || entry.webContents.isDestroyed()) continue
    const state = tabRecovery.get(id)
    if (state?.held.has(key)) continue
    for (const session of entry.sessions.values()) {
      const own = sessionRecoveryIdentity(session)
      if (own === null || recoveryStore.copyPath(own) !== key) continue
      if (session.unsavedRestore || state?.written.has(key)) return true
    }
  }
  return false
}

/**
 * Editor contract: open `filePath` in a tab the shell created, its recovery
 * question already answered (the open itself runs when the renderer pulls the
 * queued path).
 */
export function openSheetsFileWithDecision(
  contents: WebContents,
  request: RecoveryOpenFileRequest,
): void {
  decidedOpens.set(contents.id, { filePath: request.filePath, decision: request.decision })
  queueWorkbookForView(contents, request.filePath)
  nudgeQueuedWorkbook(contents)
}

/**
 * Editor contract: load a copy into a tab the shell created as an untitled
 * workbook (an untitled copy, or a file copy whose original is missing). Like
 * "New spreadsheet" it runs on a backing file in its own temp folder, the
 * first save asks where, and it keeps writing the same copy until saved.
 * The first save offers what the document offered before: for the copy of a
 * CSV or converted workbook (the original path in `saveAsDefaultPath` or in
 * the copy's metadata) the original's folder and name as .xlsx; for a missing
 * original that path itself; else the default folder.
 */
export async function openSheetsUntitledCopy(
  contents: WebContents,
  request: RecoveryOpenUntitledRequest,
): Promise<void> {
  const bytes = await recoveryStore.readCopy(request.copy)
  if (!bytes) throw new Error('Recovery copy not found.')
  const copy = request.copy
  const ext = isUntitledIdentity(copy) ? copy.ext : untitledWorkbookExt(copy.filePath)
  // an untitled copy that names its original file came from a CSV or converted workbook
  const copyInfo = isUntitledIdentity(copy) ? recoveryStore.copyInfo(copy) : null
  const originalPath = isUntitledIdentity(copy)
    ? (request.saveAsDefaultPath ?? copyInfo?.originalPath ?? undefined)
    : undefined
  // a copy of an .ods document keeps its footer notice (decision 0119): the
  // original's extension says the session runs on a converted .xlsx, and the
  // copy's metadata says how many formulas were kept as values
  const odsConverted = originalPath?.toLowerCase().endsWith('.ods') === true
  const formulasDropped = odsConverted ? (copyInfo?.formulasDropped ?? 0) : undefined
  const offered =
    originalPath !== undefined ? saveAsDefaultFor(originalPath) : request.saveAsDefaultPath
  const stem =
    (offered === undefined
      ? undefined
      : sanitizeAutoRenameBase(basename(offered).replace(/\.[^.]+$/, ''))) ??
    sanitizeAutoRenameBase(basename(request.title).replace(/\.xls[xm]$/i, '')) ??
    'Workbook'
  const name = `${stem}${ext}`
  const suggestSaveAs = offered ?? join(configuredDefaultSaveDir(app), name)
  const staged = await stageRecoveredCopy(bytes, name)
  unsavedNewWorkbooks.set(staged.openPath, {
    suggestSaveAs,
    tempDir: staged.importTempDir,
    recovery: request.copy,
    restored: true,
    ...(originalPath === undefined ? {} : { originalPath }),
    ...(odsConverted ? { odsConverted } : {}),
    ...(formulasDropped === undefined ? {} : { formulasDropped }),
    ...(odsConverted && originalPath !== undefined ? { odsSourcePath: originalPath } : {}),
  })
  queueWorkbookForView(contents, staged.openPath)
  nudgeQueuedWorkbook(contents)
}

/** how long an OS shutdown waits for one tab's renderer to write its copy */
const RECOVERY_WRITE_NOW_TIMEOUT_MS = 8_000
const recoveryWriteNowWaiters = new Map<string, () => void>()

/**
 * Editor contract (the OS is ending the session): every live tab's renderer
 * writes its copy now. Resolves once all answered or timed out; never throws.
 */
export async function writeSheetsCopiesNow(): Promise<void> {
  const waits: Promise<void>[] = []
  for (const entry of sheetsTabs.values()) {
    const contents = entry.webContents
    if (contents.isDestroyed() || tabRecovery.get(contents.id)?.crashed) continue
    const nonce = randomUUID()
    waits.push(
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          recoveryWriteNowWaiters.delete(nonce)
          resolve()
        }, RECOVERY_WRITE_NOW_TIMEOUT_MS)
        recoveryWriteNowWaiters.set(nonce, () => {
          clearTimeout(timer)
          recoveryWriteNowWaiters.delete(nonce)
          resolve()
        })
        try {
          contents.send(IPC_CHANNELS.recoveryWriteNow, nonce)
        } catch {
          recoveryWriteNowWaiters.get(nonce)?.()
        }
      }),
    )
  }
  await Promise.all(waits)
}

/** a password workbook is open in this tab: it has no copy */
function sheetsTabIsUnprotectable(contentsId: number): boolean {
  for (const session of sheetsTabs.get(contentsId)?.sessions.values() ?? [])
    if (session.password !== undefined) return true
  return false
}

registerRecoveryEditor({
  kind: 'sheets',
  writeCopiesNow: () => writeSheetsCopiesNow().catch(() => undefined),
  openFileWithDecision: openSheetsFileWithDecision,
  openUntitledCopy: openSheetsUntitledCopy,
  isUnprotectable: (contents) => sheetsTabIsUnprotectable(contents.id),
})

function readJson<T>(path: string, fallback: T): T {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    /* corrupted state file: fall back to defaults */
  }
  return fallback
}

const SETTINGS_PATH = () => userDataPath('ai-settings.json')

/**
 * The only write of the settings file: keys and tokens go to disk sealed
 * (decision 0063), and fields a newer build wrote stay as they are.
 */
function writeAiSettingsFile(settings: unknown): void {
  const stored = readJson<unknown>(SETTINGS_PATH(), {})
  writeJsonAtomic(SETTINGS_PATH(), sealAiSecrets(withStoredUnknownFields(settings, stored)))
}

// Dev-only automation hooks: a fixed CDP port for driving the app from test
// scripts, and a workbook path that bypasses the native file dialog.
const debugPort = app.isPackaged ? undefined : process.env.XLSX_DEBUG_PORT
if (debugPort) app.commandLine.appendSwitch('remote-debugging-port', debugPort)
let forcedWorkbookPath = app.isPackaged ? undefined : process.env.XLSX_OPEN_PATH
/** shell-queued workbook paths keyed by tab webContents id: a multi-select Open
 * creates several sheets tabs at once, so the path must be bound to its own tab
 * (a single global would be overwritten by the next iteration). One-shot, unlike
 * the sticky dev env/capture-server path above. */
const queuedWorkbookPaths = new Map<number, string>()

/** queue a workbook this tab's first selectWorkbook call opens without a dialog (shell routing) */
export function queueWorkbookForView(contents: WebContents, path: string): void {
  queuedWorkbookPaths.set(contents.id, path)
  contents.once('destroyed', () => {
    queuedWorkbookPaths.delete(contents.id)
  })
}

/** is the active tab still waiting for the renderer to consume a shell-queued workbook? */
export function hasActiveQueuedWorkbook(): boolean {
  return activeSheetsWebContents !== null && queuedWorkbookPaths.has(activeSheetsWebContents.id)
}

/** set by shell for home:new-sheet: renderer opens blank workbook instead of demo */
let pendingNewBlank = false

/** signal the next sheets renderer to open a new blank workbook (shell mode only) */
export function setSheetsNewBlank(): void {
  pendingNewBlank = true
}

// capturePage forces a renderer frame even when the window is occluded or on
// another Space, unlike CDP Page.captureScreenshot / macOS screencapture.
function startCaptureServer(): void {
  if (!debugPort) return
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/open') {
      forcedWorkbookPath = url.searchParams.get('path') ?? undefined
      response.writeHead(200)
      response.end('ok')
      return
    }
    // Drives the File menu from test scripts: CDP input can't reach native
    // menu accelerators, and osascript focus-stealing is flaky.
    if (url.pathname === '/menu') {
      const action = url.searchParams.get('action')
      if (
        action === 'open' ||
        action === 'save' ||
        action === 'save-as' ||
        action === 'print' ||
        action === 'export-pdf' ||
        action === 'export-csv' ||
        action === 'export-ods' ||
        action === 'undo' ||
        action === 'redo'
      ) {
        sendSheetsMenuAction(action)
        response.writeHead(200)
        response.end('ok')
      } else {
        response.writeHead(400)
        response.end('unknown action')
      }
      return
    }
    const webContents = getActiveSheetsWebContents()
    if (url.pathname !== '/capture' || !webContents) {
      response.writeHead(404)
      response.end()
      return
    }
    webContents
      .capturePage()
      .then((image) => {
        response.writeHead(200, { 'Content-Type': 'image/png' })
        response.end(image.toPNG())
      })
      .catch((error: unknown) => {
        response.writeHead(500)
        response.end(String(error))
      })
  })
  server.listen(Number(debugPort) + 1, '127.0.0.1')
}

const sidecarOpenResultSchema = workbookFileSchema.omit({
  sha256: true,
  readOnly: true,
})
type SidecarOpenResult = z.infer<typeof sidecarOpenResultSchema>

export async function createSheetsWindow(
  options: { includeAiHandlers?: boolean } = {},
): Promise<BrowserWindow> {
  const client = sidecar ?? new XlsxSidecarClient(resolveSidecarPath())
  sidecar = client
  client.start()
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 550,
    show: false,
    title: `${PRODUCT_NAME} Sheets`,
    // Traffic lights sit inside the toolbar row.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  mainWindow = window
  registerSheetsIpc()
  if (options.includeAiHandlers ?? true) registerSheetsAiIpc()
  if (options.includeAiHandlers ?? true) registerProjectIpc()
  registerSheetsSession(window.webContents, client)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (!app.isPackaged) {
    window.webContents.on('console-message', (details) => {
      process.stderr.write(`[renderer:${details.level}] ${details.message}\n`)
    })
  }
  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (sheetsPendingEditCount(window.webContents.id) === 0) return
    event.preventDefault()
    void requestSheetsClose(window.webContents, window).then((proceed) => {
      // destroy() skips this handler on the way out (close() would re-enter
      // with the count possibly still non-zero after a discard).
      if (proceed && !window.isDestroyed()) window.destroy()
      // not proceeding vetoes any quit that was in flight: go back to
      // prompting on later closes (see resetSheetsShuttingDown)
      else resetSheetsShuttingDown()
    })
  })
  window.on('closed', () => {
    mainWindow = null
  })

  await window.loadURL(rendererUrl(runtime.rendererUrl, 'sheets'))
  return window
}

/** hidden export windows: webContents id -> the PDF path the renderer must write */
const headlessExportTargets = new Map<number, string>()
/** settled by 'sheets:headless-export-done' (or by the renderer dying) */
const headlessExportWaiters = new Map<number, (result: HeadlessSheetsReport) => void>()

interface HeadlessSheetsReport {
  ok: boolean
  error?: string
}

/** End a headless run early (a failure the renderer can never observe). */
function failHeadlessExport(wcId: number, message: string): void {
  const settle = headlessExportWaiters.get(wcId)
  if (!settle) return
  headlessExportWaiters.delete(wcId)
  settle({ ok: false, error: message })
}

/**
 * Render `input` to `outPath` with no visible window: a hidden sheets
 * renderer opens the workbook through the normal queued-open path, lays the
 * active sheet out with its Page Layout settings and prints via the existing
 * hidden print window (main/pdf-export.ts).
 */
export async function exportSheetsPdfHeadless(
  input: string,
  outPath: string,
  timeoutMs = 600_000,
): Promise<void> {
  const client = sidecar ?? new XlsxSidecarClient(resolveSidecarPath())
  sidecar = client
  client.start()
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  registerSheetsIpc()
  registerSheetsSession(win.webContents, client)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  const wcId = win.webContents.id
  queueWorkbookForView(win.webContents, input)
  headlessExportTargets.set(wcId, outPath)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const report = await new Promise<HeadlessSheetsReport>((resolve) => {
      headlessExportWaiters.set(wcId, resolve)
      win.webContents.on('render-process-gone', (_event, details) =>
        resolve({ ok: false, error: `sheets renderer stopped (${details.reason})` }),
      )
      timer = setTimeout(
        () => resolve({ ok: false, error: `sheets export timed out after ${timeoutMs}ms` }),
        timeoutMs,
      )
      void win.webContents.loadURL(rendererUrl(runtime.rendererUrl, 'sheets'))
    })
    if (!report.ok) throw new Error(report.error ?? 'sheets export failed')
  } finally {
    if (timer) clearTimeout(timer)
    headlessExportWaiters.delete(wcId)
    headlessExportTargets.delete(wcId)
    if (!win.isDestroyed()) win.destroy()
  }
}

/** tab-mode equivalent of createSheetsWindow: same runtime/IPC wiring, no BrowserWindow of its own. */
export function createSheetsView(
  options: { includeAiHandlers?: boolean; openingWorkbook?: boolean } = {},
): WebContentsView {
  const client = sidecar ?? new XlsxSidecarClient(resolveSidecarPath())
  sidecar = client
  client.start()
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  registerSheetsIpc()
  if (options.includeAiHandlers ?? true) registerSheetsAiIpc()
  registerSheetsSession(view.webContents, client)
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  view.webContents.on('will-navigate', (event) => event.preventDefault())
  if (!app.isPackaged) {
    view.webContents.on('console-message', (details) => {
      process.stderr.write(`[renderer:${details.level}] ${details.message}\n`)
    })
  }
  // mode=tab: the shell's tab strip owns the traffic lights / caption buttons,
  // so the ribbon must not reserve space for them
  void view.webContents.loadURL(
    rendererUrl(runtime.rendererUrl, 'sheets', {
      mode: 'tab',
      ...(options.openingWorkbook ? { openingWorkbook: '1' } : {}),
    }),
  )
  return view
}

// ---- Chat attachments: local files parsed and fed to the agent (copied from
// the apps/docs docs-main attachment pipeline) ----

const ATTACHMENT_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** Extracted-text cache keyed by path; invalidated when mtime+size change */
const attachmentTextCache = new Map<string, { stamp: string; text: string }>()

function statAttachment(filePath: string): { meta?: AttachmentMeta; error?: string } {
  const name = basename(filePath)
  // a draw.io picture that holds its diagram is read as diagram text
  const ext = diagramPictureExtOf(filePath) ?? name.split('.').pop()?.toLowerCase() ?? ''
  if (!ATTACHABLE_EXTS.has(ext)) return { error: `${name}: ${tm('errUnsupportedExt', { ext })}` }
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return { error: `${name}: ${tm('errNotFile')}` }
    if (!ATTACHABLE_IMAGE_EXTS.has(ext) && stat.size > attachableMaxBytes(ext)) {
      return {
        error: `${name}: ${tm('errTooLarge', { mb: Math.round(ATTACHABLE_MAX_BYTES / 1024 / 1024) })}`,
      }
    }
    if (ATTACHABLE_IMAGE_EXTS.has(ext) && stat.size > ATTACHABLE_IMAGE_MAX_BYTES) {
      return { error: `${name}: ${tm('errImageTooLarge')}` }
    }
    return { meta: { path: filePath, name, ext, sizeBytes: stat.size } }
  } catch {
    return { error: `${name}: ${tm('errUnreadable')}` }
  }
}

function collectAttachments(paths: string[]): AttachmentAddResult {
  const accepted: AttachmentMeta[] = []
  const rejected: string[] = []
  for (const p of paths) {
    const { meta, error } = statAttachment(p)
    if (meta) accepted.push(meta)
    else if (error) rejected.push(error)
  }
  return { accepted, rejected }
}

/** Persists clipboard-pasted image bytes to a temp file (screenshots/bitmaps
 * without a local path); returns null for non-images or empty data */
let pastedImageSeq = 0
function savePastedImage(data: unknown, ext: unknown): string | null {
  const cleanExt = typeof ext === 'string' ? ext.toLowerCase() : ''
  if (!ATTACHABLE_IMAGE_EXTS.has(cleanExt)) return null
  const bytes =
    data instanceof ArrayBuffer
      ? Buffer.from(data)
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : null
  if (!bytes || bytes.byteLength === 0) return null
  const dir = join(app.getPath('temp'), 'seuoffice-pasted')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const filePath = join(dir, `pasted-${stamp}-${++pastedImageSeq}.${cleanExt}`)
  writeFileSync(filePath, bytes)
  return filePath
}

/** Attachment text extraction via @seuoffice/file-parse (docx/pdf/pptx/xlsx/plain text) */
async function extractAttachmentText(filePath: string): Promise<string> {
  // a file open with unsaved changes is not read (before the cache): a
  // withholding mark only reaches the file on save
  await assertFileSaved(filePath)
  const stat = statSync(filePath)
  const stamp = `${stat.mtimeMs}:${stat.size}`
  const cached = attachmentTextCache.get(filePath)
  if (cached && cached.stamp === stamp) return cached.text
  const capExt = diagramPictureExtOfName(filePath) ?? extname(filePath)
  if (stat.size > attachableMaxBytes(capExt)) throw new Error(tm('errFileTooLarge'))
  const parsed = await parseFileToText(filePath)
  if (!parsed.ok || parsed.kind !== 'text' || parsed.text == null) {
    throw new Error((!parsed.damaged && parsed.error) || tm('errParseFailed'))
  }
  attachmentTextCache.set(filePath, { stamp, text: parsed.text })
  // The cache is bounded (keeping a few recent files is enough)
  if (attachmentTextCache.size > 8) {
    const oldest = attachmentTextCache.keys().next().value
    if (oldest) attachmentTextCache.delete(oldest)
  }
  return parsed.text
}

// Close guard: the renderer mirrors its pending-save count here, used to show a
// save confirmation before closing the window/tab.
const pendingEditCounts = new Map<number, number>()
const closeSaveWaiters = new Map<number, (ok: boolean) => void>()
const trackedEditSenders = new Set<number>()

/**
 * Unsaved changes of a tab: the renderer's journal, plus work that lives only
 * in a recovery copy (a restored copy before its first save, a new workbook
 * whose quiet AutoSave emptied the journal).
 */
export function sheetsPendingEditCount(webContentsId: number): number {
  return (pendingEditCounts.get(webContentsId) ?? 0) + unsavedCopySessions(webContentsId)
}

/**
 * The app is shutting down (quit menu, SIGTERM from a restart/installer/killall,
 * SIGINT from a terminal, the OS ending the session). The close guard must not
 * save then: nobody answered the prompt, and a dialog raised during shutdown
 * resolves to its default button, which silently overwrote the user's original
 * file. Unsaved work is covered by the 30s recovery copy instead — the next
 * launch offers to restore it. The shared recovery latch goes up with this one,
 * so no editor's close cleanup deletes a copy meanwhile.
 */
const shutdownLatch = new ShutdownLatch()

const shuttingDown = (): boolean => shutdownLatch.active || isAppShuttingDown()

export function markSheetsShuttingDown(): void {
  shutdownLatch.mark()
  markAppShuttingDown()
}

/**
 * The quit was vetoed (a prevented window close that ended up not proceeding).
 * The latches must go back down: from now on closes are interactive again and
 * the save prompt must run — leaving them set would silently discard unsaved
 * edits on every later close, and keep copies from being deleted on save.
 */
export function resetSheetsShuttingDown(): void {
  shutdownLatch.reset()
  resetAppShuttingDown()
  resumeDiscardedTabCopies()
  // every editor's "Don't Save" block in the shared store, not just this one's
  resumeDiscardedCopies()
}

app.on('before-quit', markSheetsShuttingDown)
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    markSheetsShuttingDown()
    app.quit()
  })
}

/**
 * Close guard for a sheets renderer: true means proceed with the close.
 * Clean → true; dirty → Save/Don't Save/Cancel dialog. Save asks the renderer to run
 * its journal save and waits for the outcome — a failed or canceled save
 * keeps the window open (the renderer already surfaced the error). "Don't
 * Save" deletes the tab's recovery copies; a close while the app is ending
 * asks nothing and leaves them.
 */
export async function requestSheetsClose(
  contents: WebContents,
  parent?: BrowserWindow | null,
): Promise<boolean> {
  const count = sheetsPendingEditCount(contents.id)
  const decision = closeGuardDecision({
    pendingEdits: count,
    destroyed: contents.isDestroyed(),
    shuttingDown: shuttingDown(),
  })
  if (decision === 'proceed') return true
  const options = {
    // On macOS 'warning' shows the system warning triangle + app-icon badge
    type: 'warning' as const,
    message: tm('closeUnsavedMsg', { count }),
    detail: tm('closeUnsavedDetail'),
    buttons: [tm('menuSave'), tm('btnDontSave'), tm('btnCancel')],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  }
  const { response } =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
  if (response === 2) return false
  if (response === 1) {
    discardTabCopies(contents.id)
    return true
  }
  // The window went away (or a quit started) while the prompt was up: don't save
  if (shuttingDown() || contents.isDestroyed()) return true
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      closeSaveWaiters.delete(contents.id)
      resolve(false)
    }, 120_000)
    closeSaveWaiters.set(contents.id, (ok) => {
      clearTimeout(timer)
      resolve(ok)
    })
    contents.send(IPC_CHANNELS.closeSaveRequest)
  })
}

let coreIpcRegistered = false

export function registerSheetsIpc(): void {
  if (coreIpcRegistered) return
  coreIpcRegistered = true

  ipcMain.handle(IPC_CHANNELS.userDisplayName, (event): string => {
    sessionFor(event)
    return configuredAuthorName(app)
  })

  // Registered here (not in registerSheetsAiIpc, skipped in shell mode):
  // slides' ai:generate-image only exists once a slides view opens, so sheets
  // owns its channel the way pdf does.
  ipcMain.handle(
    IPC_CHANNELS.aiGenerateImage,
    (event, op: { prompt?: unknown; aspectRatio?: unknown }) =>
      // ends with its tab, or when the tab's AI run is stopped
      withMediaCallSignal(event.sender, (signal) =>
        generateImageTool(
          SETTINGS_PATH(),
          {
            prompt: String(op?.prompt ?? ''),
            ...(op?.aspectRatio ? { aspectRatio: String(op.aspectRatio) } : {}),
          },
          {
            mediaRoots: sheetsMediaRoots(event.sender.id),
            context: { path: 'screen', statuses: sharedSubscriptionStatuses() },
            signal,
          },
        ),
      ),
  )

  // What the image and search tools can do right now. Registered here for the
  // same reason: the renderer offers generate_image from this answer.
  ipcMain.handle(IPC_CHANNELS.aiToolCapabilities, (): AiToolCapabilities =>
    aiToolCapabilities(readAiSettingsFile(SETTINGS_PATH()), {
      path: 'screen',
      statuses: sharedSubscriptionStatuses(),
    }),
  )

  // the renderer finished the copy an OS shutdown asked for (writeSheetsCopiesNow)
  ipcMain.on(IPC_CHANNELS.recoveryWriteNowDone, (event, nonce: unknown) => {
    if (!sheetsTabs.has(event.sender.id)) return
    if (typeof nonce === 'string') recoveryWriteNowWaiters.get(nonce)?.()
  })

  ipcMain.on(IPC_CHANNELS.pendingEditsChanged, (event, count: unknown) => {
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return
    const senderId = event.sender.id
    pendingEditCounts.set(senderId, Math.floor(count))
    if (!trackedEditSenders.has(senderId)) {
      trackedEditSenders.add(senderId)
      event.sender.once('destroyed', () => {
        trackedEditSenders.delete(senderId)
        pendingEditCounts.delete(senderId)
        closeSaveWaiters.get(senderId)?.(false)
        closeSaveWaiters.delete(senderId)
      })
    }
  })

  ipcMain.on(IPC_CHANNELS.closeSaveResult, (event, ok: unknown) => {
    const waiter = closeSaveWaiters.get(event.sender.id)
    if (!waiter) return
    closeSaveWaiters.delete(event.sender.id)
    waiter(ok === true)
  })

  // shared with the other editor modules — last (identical) registration wins
  ipcMain.removeHandler('app:get-language')
  ipcMain.handle('app:get-language', () => getUiLang())
  // shared with the docs module the same way: last (identical) registration wins
  ipcMain.removeHandler(IPC_CHANNELS.documentLocale)
  ipcMain.handle(IPC_CHANNELS.documentLocale, () => documentLocale())

  // shared with the other editor modules — last (identical) registration wins
  ipcMain.removeHandler('app:font-family-info')
  ipcMain.handle('app:font-family-info', (_event, families: unknown) => familyInfoFor(families))

  /** returns true once when shell opened this tab for a new blank workbook */
  ipcMain.handle('sheets:consume-new-blank', () => {
    if (pendingNewBlank) {
      pendingNewBlank = false
      return true
    }
    return false
  })

  /**
   * Is a shell-queued workbook still waiting to be opened? The shell's 'open'
   * nudge loop gives up after 30s; on slow dev cold starts (vite compiles the
   * renderer on demand) Univer mounts later than that and the queued path
   * would strand the tab as a blank in-memory workbook. The renderer polls
   * this once it is ready and triggers the open itself.
   */
  ipcMain.handle('sheets:has-queued-workbook', (event) => queuedWorkbookPaths.has(event.sender.id))

  // ---- headless export mode (--headless-export) ----

  ipcMain.handle('sheets:consume-headless-export', (event): string | null => {
    const target = headlessExportTargets.get(event.sender.id) ?? null
    headlessExportTargets.delete(event.sender.id)
    return target
  })

  ipcMain.on('sheets:headless-export-done', (event, result: unknown) => {
    const settle = headlessExportWaiters.get(event.sender.id)
    if (!settle) return
    headlessExportWaiters.delete(event.sender.id)
    const state = result as { ok?: unknown; error?: unknown } | null
    settle({
      ok: state?.ok === true,
      ...(typeof state?.error === 'string' ? { error: state.error } : {}),
    })
  })

  /// `explicitPath` re-opens a known file without the picker or the shell
  /// queue — the crash-recovery entry point. It runs the SAME pipeline
  /// (prepareWorkbookForOpen + openWorkbookSession + the opened hook) as a
  /// user-picked or shell-queued open, so a recovered workbook is a normal
  /// session rather than a merge source.
  const openSelectedWorkbook = async (event: IpcMainInvokeEvent, explicitPath?: string) => {
    const entry = sessionFor(event)
    let path = explicitPath ?? queuedWorkbookPaths.get(event.sender.id) ?? forcedWorkbookPath
    // consume immediately (before the slow session open) so the shell's
    // retry loop stops re-sending 'open' for the same file
    queuedWorkbookPaths.delete(event.sender.id)
    if (!path) {
      const selection = await openFileDialog(event, {
        properties: ['openFile'],
        filters: [
          {
            name: tm('filterSpreadsheets'),
            extensions: ['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'ods'],
          },
        ],
      })
      if (selection.canceled || !selection.filePaths[0]) return null
      path = selection.filePaths[0]
    }
    // A delimited import can take a while on a big file, so the renderer
    // watches its progress and can cancel it.
    const owner = event.sender.id
    // a superseded import may have left its bar standing; this open owns the
    // tab now, whether or not it will report anything itself
    const superseded = pendingImports.controllerFor(owner) !== undefined
    const importController = pendingImports.start(owner)
    if (superseded && !event.sender.isDestroyed())
      event.sender.send(IPC_CHANNELS.importProgress, null)
    // only a delimited import reports progress; a plain .xlsx never does,
    // and there is no bar to take down for it
    let reported = false
    const reportProgress = (progress: CsvImportProgress | null): void => {
      if (event.sender.isDestroyed()) return
      // an import that was replaced no longer owns the bar
      if (pendingImports.controllerFor(owner) !== importController) return
      if (progress === null) {
        if (!reported) return
        reported = false
      } else {
        reported = true
      }
      event.sender.send(IPC_CHANNELS.importProgress, progress)
    }
    let prepared: Awaited<ReturnType<typeof prepareWorkbookForOpen>>
    try {
      prepared = await prepareWorkbookForOpen(
        entry.client,
        path,
        event.sender,
        dialogParent(event),
        {
          import: {
            onProgress: reportProgress,
            signal: importController.signal,
          },
        },
      )
    } catch (error) {
      // The user stopped the import: nothing opens, and it is not a failure
      // to report. The renderer already knows it asked for this.
      if (pendingImports.wasCancelled(importController)) return null
      throw error
    } finally {
      // the import is over (done, failed or cancelled): the bar must not
      // stand into the next open; reportProgress drops this for a
      // superseded import, so finish comes after
      reportProgress(null)
      pendingImports.finish(owner, importController)
    }
    // a decision the shell passed for this tab served this open (or never applied)
    decidedOpens.delete(event.sender.id)
    if (prepared === null) return null
    // The recovery prompt (or the file dialog / import conversion) can outlive
    // the tab: once the renderer is destroyed, its 'destroyed' handler has
    // already run closeAllSessions and dropped the tab entry, so a session
    // opened now would never be closed and its snapshot would leak.
    if (event.sender.isDestroyed()) {
      await discardPreparedOpen(prepared)
      return null
    }
    // a CSV or converted workbook keeps its unsaved work in an untitled copy
    const converted = convertedSessionRecovery(prepared, path)
    const result = await openWorkbookSession(entry.client, prepared.openPath, entry.sessions, {
      suggestSaveAs: prepared.suggestSaveAs,
      csvImport: prepared.csvImport,
      csvSourcePath: prepared.csvSourcePath,
      emptyCsv: prepared.emptyCsv,
      importTempDir: prepared.importTempDir,
      restoreTarget: prepared.restoreTarget,
      emptySource: prepared.emptySource,
      unsavedNew: prepared.unsavedNew,
      password: prepared.password,
      recoveryIdentity: converted?.recoveryIdentity ?? prepared.recoveryIdentity,
      recoveryOriginalPath: converted?.recoveryOriginalPath ?? prepared.recoveryOriginalPath,
      unsavedRestore: prepared.unsavedRestore,
      odsConverted: prepared.odsConverted,
      formulasDropped: prepared.formulasDropped,
      odsSourcePath: prepared.odsSourcePath,
    })
    entry.currentPath = path
    // The sidecar open itself can also outlive the tab after the pre-open
    // check. Close the newly registered session instead of stranding it in
    // the detached entry map.
    if (event.sender.isDestroyed()) {
      const session = entry.sessions.get(result.sessionId)
      entry.sessions.delete(result.sessionId)
      if (session !== undefined) {
        await cleanupSessionResources({
          tempRoot: app.getPath('temp'),
          snapshotPath: session.snapshotPath,
          importTempDir: session.importTempDir,
          closeSidecar: () => entry.client.close(result.sessionId),
        })
      }
      return null
    }
    // an unsaved new workbook's tab already shows the untitled name; its temp
    // backing path must not become a recent file
    if (!prepared.unsavedNew) workbookOpenedHook?.(event.sender, path)
    // a password workbook keeps no recovery copy: say so once in this tab
    if (prepared.password !== undefined) showUnprotectableNotice(event.sender)
    return result
  }

  // The renderer cancels a delimited import that is taking too long; the
  // conversion throws and nothing opens.
  ipcMain.handle(IPC_CHANNELS.cancelImport, (event) => {
    pendingImports.cancel(event.sender.id)
  })

  ipcMain.handle(IPC_CHANNELS.selectWorkbook, async (event) => {
    try {
      return await openSelectedWorkbook(event)
    } catch (err) {
      // A headless export has no dialog to report a failed open through, and
      // its renderer would poll to the deadline waiting for a workbook that
      // will never arrive — settle the run with the real reason instead.
      failHeadlessExport(event.sender.id, `the input workbook did not open (${String(err)})`)
      throw err
    }
  })

  // Review › Change Password: the encrypted file gets its saved contents again
  // under the new password. The session's plaintext snapshot is those contents
  // (the renderer saves pending edits first), so nothing is decrypted here.
  ipcMain.handle(IPC_CHANNELS.updateWorkbookPassword, async (event, input: unknown) => {
    const { sessionId, newPassword } = workbookPasswordUpdateRequestSchema.parse(input)
    const entry = sessionFor(event)
    const session = entry.sessions.get(sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    const encryptedPath = session.restoreTarget
    if (session.password === undefined || encryptedPath === undefined) {
      throw new Error('This workbook is not protected by an open password.')
    }
    const currentSha = await sha256File(encryptedPath).catch(() => undefined)
    if (currentSha !== undefined && currentSha !== session.restoreTargetSha) {
      throw new Error(tm('errDiskChanged'))
    }
    const encryptedBytes = encryptOoxml(await readFile(session.snapshotPath), newPassword)
    const encryptedSha = createHash('sha256').update(encryptedBytes).digest('hex')
    try {
      await atomicWriteFile(encryptedPath, encryptedBytes)
    } catch (error) {
      // A write can fail after its bytes are in place (the cleanup behind the
      // rename). The file then opens with the new password only, so what is
      // answered is what the file holds, not how the call ended: "failed"
      // would send the person back to a password that no longer opens it.
      const landed = await sha256File(encryptedPath).catch(() => undefined)
      if (landed !== encryptedSha) throw error
    }
    // The session follows the file before anything else is awaited: a save
    // under the old password would lock the file with it again, and one
    // checked against the old digest would be refused as an outside change.
    entry.sessions.set(sessionId, {
      ...session,
      password: newPassword,
      restoreTargetSha: encryptedSha,
    })
    const diskState = await recordDiskState(encryptedPath)
    const current = entry.sessions.get(sessionId)
    if (diskState !== null && current !== undefined) {
      entry.sessions.set(sessionId, {
        ...current,
        diskState: { path: encryptedPath, state: diskState },
      })
    }
  })

  ipcMain.handle(IPC_CHANNELS.reopenWorkbook, async (event, path: unknown) => {
    const validated = z.string().min(1).parse(path)
    // A converted, restored, new or decrypted workbook is more than its path:
    // re-open the twin of the session being continued, so Save still knows
    // the copy is a copy and the original keeps its protection.
    const entry = sessionFor(event)
    const previous = sessionToContinue(entry.sessions.values(), validated)
    if (previous !== null) {
      if (!existsSync(previous.path)) throw new Error('Workbook file not found.')
      const result = await openWorkbookSession(
        entry.client,
        previous.path,
        entry.sessions,
        continuedOpenOptions(previous),
      )
      const twin = entry.sessions.get(result.sessionId)
      if (event.sender.isDestroyed()) {
        // The tab closed while the twin was opening; its sessions are already
        // cleaned up, so this one has to go the same way.
        entry.sessions.delete(result.sessionId)
        if (twin !== undefined) {
          await cleanupSessionResources({
            tempRoot: app.getPath('temp'),
            snapshotPath: twin.snapshotPath,
            importTempDir: previous.importTempDir,
            closeSidecar: () => entry.client.close(result.sessionId),
          })
        }
        return null
      }
      if (twin !== undefined && previous.importTempDir !== undefined) {
        entry.sessions.set(result.sessionId, { ...twin, importTempDir: previous.importTempDir })
      }
      return result
    }
    // A crash re-open targets the file the user already has open, so a
    // missing/deleted file is a real failure rather than a reason to pop the
    // picker at someone who did not ask to open anything.
    if (!existsSync(validated)) throw new Error('Workbook file not found.')
    const ext = validated.slice(validated.lastIndexOf('.') + 1).toLowerCase()
    if (!WORKBOOK_EXTS.has(ext)) throw new Error(`Unsupported workbook: ${ext}`)
    return openSelectedWorkbook(event, validated)
  })

  // Merge sources: same open pipeline as selectWorkbook, but multi-select,
  // never consuming the shell's queued open path and never retitling the tab
  // (workbookOpenedHook) — these sessions exist only to be read from and
  // closed by the renderer's merge routine.
  /** Open the given spreadsheet paths as merge-source sessions; cleans up
   *  everything already opened when a later file fails or the tab dies. */
  const openMergeSources = async (
    event: Electron.IpcMainInvokeEvent,
    paths: readonly string[],
  ): Promise<unknown[] | null> => {
    const entry = sessionFor(event)
    const opened: { sessionId: string }[] = []
    const closeOpened = async () => {
      for (const { sessionId } of opened) {
        const session = entry.sessions.get(sessionId)
        entry.sessions.delete(sessionId)
        if (session !== undefined) {
          await cleanupSessionResources({
            tempRoot: app.getPath('temp'),
            snapshotPath: session.snapshotPath,
            importTempDir: session.importTempDir,
            closeSidecar: () => entry.client.close(sessionId),
          })
        }
      }
    }
    try {
      for (const path of paths) {
        const prepared = await prepareWorkbookForOpen(
          entry.client,
          path,
          event.sender,
          dialogParent(event),
          { skipRecoveryPrompt: true },
        )
        // a cancelled password prompt cancels the whole merge pick
        if (prepared === null) {
          await closeOpened()
          return null
        }
        if (event.sender.isDestroyed()) {
          await discardPreparedOpen(prepared)
          break
        }
        const result = await openWorkbookSession(entry.client, prepared.openPath, entry.sessions, {
          suggestSaveAs: prepared.suggestSaveAs,
          csvImport: prepared.csvImport,
          csvSourcePath: prepared.csvSourcePath,
          importTempDir: prepared.importTempDir,
          restoreTarget: prepared.restoreTarget,
          emptySource: prepared.emptySource,
          unsavedNew: prepared.unsavedNew,
          password: prepared.password,
        })
        opened.push(result as { sessionId: string })
        if (event.sender.isDestroyed()) break
      }
    } catch (error) {
      // a later file failing must not strand the sessions already opened
      await closeOpened()
      throw error
    }
    if (event.sender.isDestroyed()) {
      await closeOpened()
      return null
    }
    return opened.length > 0 ? opened : null
  }

  ipcMain.handle(IPC_CHANNELS.selectWorkbooksForMerge, async (event) => {
    const selection = await openFileDialog(event, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: tm('filterSpreadsheets'), extensions: ['xlsx', 'xlsm', 'xls', 'csv', 'tsv'] },
      ],
    })
    if (selection.canceled || selection.filePaths.length === 0) return null
    return openMergeSources(event, selection.filePaths)
  })

  const MERGE_SOURCE_EXTS = WORKBOOK_EXTS
  ipcMain.handle(IPC_CHANNELS.openWorkbooksForMerge, async (event, input: unknown) => {
    const paths = z.array(z.string().min(1)).min(1).max(20).parse(input)
    for (const path of paths) {
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
      if (!MERGE_SOURCE_EXTS.has(ext)) throw new Error(`Unsupported merge source: ${ext}`)
      if (!existsSync(path)) throw new Error('Merge source not found.')
      // an attached workbook open with unsaved changes is not read, like any attachment
      await assertFileSaved(path)
    }
    return openMergeSources(event, paths)
  })

  ipcMain.handle(IPC_CHANNELS.readWorkbookRange, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookRangeRequestSchema.parse(input)
    if (!entry.sessions.has(request.sessionId)) throw new Error('Unknown workbook session.')
    const result = await entry.client.readRange(request)
    return workbookRangeResultSchema.parse(result)
  })

  ipcMain.handle(IPC_CHANNELS.readWorkbookFormulas, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookFormulaCellsRequestSchema.parse(input)
    if (!entry.sessions.has(request.sessionId)) throw new Error('Unknown workbook session.')
    const result = await entry.client.readFormulaCells(request)
    return workbookFormulaCellsResultSchema.parse(result)
  })

  ipcMain.handle(IPC_CHANNELS.findWorkbookCells, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookFindCellsRequestSchema.parse(input)
    if (!entry.sessions.has(request.sessionId)) throw new Error('Unknown workbook session.')
    const result = await entry.client.findCells(request)
    return workbookFindCellsResultSchema.parse(result)
  })

  ipcMain.handle(IPC_CHANNELS.readWorkbookRowOutline, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookFormulaCellsRequestSchema.parse(input)
    if (!entry.sessions.has(request.sessionId)) throw new Error('Unknown workbook session.')
    const result = await entry.client.readRowOutline(request)
    return workbookRowOutlineResultSchema.parse(result)
  })

  // IronCalc recalculation: sheet ids resolve through the session's file
  // sheet names, so the renderer never sees paths and sheets added this
  // session (no file part) fail closed before reaching the engine.
  const sidecarRecalcResultSchema = z
    .object({
      cells: z.array(
        z
          .object({
            sheet: z.string(),
            row: z.number().int().nonnegative(),
            column: z.number().int().nonnegative(),
            formatted: z.string(),
            number: z.number().optional(),
            isError: z.boolean().optional(),
            isFormula: z.boolean(),
          })
          .strict(),
      ),
      cached: z.boolean().optional(),
    })
    .strict()
  // The external-links handlers are session-bound like the other workbook
  // handlers: the renderer names a session, never a filesystem path, and main
  // resolves the path the session was opened from.
  ipcMain.handle(IPC_CHANNELS.listExternalLinks, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = externalLinksRequestSchema.parse(input)
    const session = entry.sessions.get(request.sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    const result = await entry.client.listExternalLinks({
      path: session.path,
      baseDir: externalLinkBaseDir(session),
    })
    return externalLinksResultSchema.parse(result)
  })
  ipcMain.handle(IPC_CHANNELS.updateExternalLinks, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = externalLinksRequestSchema.parse(input)
    const session = entry.sessions.get(request.sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    // The saved file is what the update must read: the panel saves before it
    // asks, so the on-disk bytes match the grid the values are applied to.
    const result = await entry.client.updateExternalLinks({
      path: session.path,
      baseDir: externalLinkBaseDir(session),
      // The panel's Update button is the person asking for the sources it
      // lists, one on another computer included; nothing else sets this.
      allowRemoteSources: true,
    })
    return externalLinksUpdateResultSchema.parse(result)
  })
  // The formula cells referencing each [n] link, with the value a Break would
  // freeze them at: the file-level usage scan, not the model's view.
  ipcMain.handle(IPC_CHANNELS.readExternalLinkUsage, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = externalLinksRequestSchema.parse(input)
    const session = entry.sessions.get(request.sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    return entry.client.readExternalLinkUsage({ path: session.path })
  })
  // Change Source's file picker: the host picks the new source file itself, the
  // renderer only names the link it belongs to.
  ipcMain.handle(IPC_CHANNELS.selectExternalLinkSource, async (event) => {
    const selection = await openFileDialog(event, {
      properties: ['openFile'],
      filters: [{ name: tm('filterSpreadsheets'), extensions: [...WORKBOOK_EXTS] }],
    })
    if (selection.canceled || selection.filePaths.length === 0) return null
    return selection.filePaths[0] ?? null
  })
  // ── cross-workbook range picking (genoffice#2109) ──────────────────────
  // One pick armed at a time: the tab editing a formula arms it, the user
  // clicks a range in another workbook's tab, that tab reports the
  // selection, and main relays it back and re-activates the editor.
  let pendingWorkbookPick: { pickId: string; sourceWcId: number; targetWcId: number } | null = null
  const broadcastPickCancelled = (pickId: string, exceptWcId: number): void => {
    for (const entry of sheetsTabs.values()) {
      if (entry.webContents.id === exceptWcId || entry.webContents.isDestroyed()) continue
      entry.webContents.send(IPC_CHANNELS.workbookPickCancelled, { pickId })
    }
  }
  ipcMain.handle(IPC_CHANNELS.listWorkbookTabs, (event) => ({
    tabs: [...sheetsTabs.values()]
      .filter(
        (entry) =>
          entry.webContents.id !== event.sender.id &&
          !entry.webContents.isDestroyed() &&
          entry.currentPath !== null,
      )
      .map((entry) => ({
        wcId: entry.webContents.id,
        name: basename(entry.currentPath!),
        path: entry.currentPath!,
      })),
  }))
  ipcMain.handle(IPC_CHANNELS.armWorkbookPick, (event, input: unknown) => {
    const { wcId } = z.object({ wcId: z.number().int() }).strict().parse(input)
    const pickId = 'pick-' + randomUUID()
    if (pendingWorkbookPick) broadcastPickCancelled(pendingWorkbookPick.pickId, event.sender.id)
    pendingWorkbookPick = { pickId, sourceWcId: event.sender.id, targetWcId: wcId }
    // only the tab holding the selected link's source workbook is armed
    const target = sheetsTabs.get(wcId)
    if (target && wcId !== event.sender.id && !target.webContents.isDestroyed()) {
      target.webContents.send(IPC_CHANNELS.workbookPickArmed, { pickId })
    }
    return { pickId }
  })
  ipcMain.handle(IPC_CHANNELS.sendWorkbookPickSelection, (event, input: unknown) => {
    const selection = workbookPickSelectionSchema.parse(input)
    const pending = pendingWorkbookPick
    // only the tab the pick was armed against answers
    if (!pending || pending.pickId !== selection.pickId || event.sender.id !== pending.targetWcId)
      return
    pendingWorkbookPick = null
    const source = sheetsTabs.get(pending.sourceWcId)
    if (source && !source.webContents.isDestroyed()) {
      source.webContents.send(IPC_CHANNELS.workbookPickSelected, selection)
    }
    broadcastPickCancelled(pending.pickId, pending.sourceWcId)
    activateTabHook?.(pending.sourceWcId)
  })
  ipcMain.handle(IPC_CHANNELS.cancelWorkbookPick, (event, input: unknown) => {
    const { pickId } = z
      .object({ pickId: z.string().min(1) })
      .strict()
      .parse(input)
    if (!pendingWorkbookPick || pendingWorkbookPick.pickId !== pickId) return
    pendingWorkbookPick = null
    broadcastPickCancelled(pickId, event.sender.id)
  })
  // The preload sends this one (fire-and-forget): handle() would make the
  // renderer's send() a no-op. The renderer names a link index of its session,
  // never a path, so Locate resolves the source from the session's own listing.
  ipcMain.on(IPC_CHANNELS.revealLinkSource, (event, input: unknown) => {
    void (async () => {
      const request = externalLinkRevealRequestSchema.safeParse(input)
      const entry = sheetsTabs.get(event.sender.id)
      if (!request.success || !entry) return
      const session = entry.sessions.get(request.data.sessionId)
      if (!session) return
      try {
        const listing = await entry.client.listExternalLinks({
          path: session.path,
          baseDir: externalLinkBaseDir(session),
        })
        const source = listing.links.find((link) => link.index === request.data.index)?.source
        // Reveal only real files: a missing source is a silent no-op.
        if (source === null || source === undefined || !existsSync(source)) return
        shell.showItemInFolder(source)
      } catch {
        // Locate is best-effort: a sidecar failure changes nothing on disk
      }
    })()
  })
  ipcMain.handle(IPC_CHANNELS.recalcWorkbook, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookRecalcRequestSchema.parse(input)
    const session = entry.sessions.get(request.sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    const fileSheetName = (sheetId: string): string => {
      const name = session.sheetNames.get(sheetId)
      if (name === undefined) throw new Error(`Unknown sheet for recalculation: ${sheetId}`)
      return name
    }
    const result = sidecarRecalcResultSchema.parse(
      await entry.client.recalcCells({
        // The snapshot, not the live path: recalculated values are painted on
        // the session's grid (and saved into its formula cells), so they must
        // come from the session's own bytes even if the file changed on disk.
        path: session.snapshotPath,
        edits: request.edits.map((edit) => ({
          sheet: fileSheetName(edit.sheetId),
          row: edit.row,
          column: edit.column,
          input: edit.input,
        })),
        reads: request.reads.map((read) => ({
          sheet: fileSheetName(read.sheetId),
          range: read.range,
        })),
      }),
    )
    const idsByName = new Map([...session.sheetNames].map(([id, name]) => [name, id]))
    return workbookRecalcResultSchema.parse({
      cells: result.cells.flatMap((cell) => {
        const sheetId = idsByName.get(cell.sheet)
        if (sheetId === undefined) return []
        return [
          {
            sheetId,
            row: cell.row,
            column: cell.column,
            formatted: cell.formatted,
            ...(cell.number === undefined ? {} : { number: cell.number }),
            ...(cell.isError ? { isError: true } : {}),
            isFormula: cell.isFormula,
          },
        ]
      }),
    })
  })

  ipcMain.handle(IPC_CHANNELS.readWorkbookMedia, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookMediaRequestSchema.parse(input)
    if (!entry.sessions.has(request.sessionId)) throw new Error('Unknown workbook session.')
    const result = await entry.client.readMedia(request)
    return workbookMediaResultSchema.parse(result)
  })

  function sniffImageType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | null {
    if (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    )
      return 'image/png'
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'image/jpeg'
    }
    if (bytes.length >= 6 && bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
    return null
  }

  ipcMain.handle(IPC_CHANNELS.readLocalImage, async (event, input: unknown) => {
    sessionFor(event)
    const request = localImageRequestSchema.parse(input)
    const resolved = request.path.startsWith('~/')
      ? join(app.getPath('home'), request.path.slice(2))
      : request.path
    if (!isAbsolute(resolved)) throw new Error(tm('errImgAbsPath'))
    const info = await stat(resolved).catch(() => null)
    if (!info?.isFile()) throw new Error(tm('errImgNotFound', { path: request.path }))
    if (info.size > 20 * 1024 * 1024) throw new Error(tm('errImgTooLarge20'))
    const bytes = await readFile(resolved)
    const mediaType = sniffImageType(bytes)
    if (mediaType === null) {
      throw new Error(tm('errImgBadType'))
    }
    return localImageResultSchema.parse({ mediaType, base64: bytes.toString('base64') })
  })

  ipcMain.handle(IPC_CHANNELS.captureScreenSources, async (event) => {
    sessionFor(event)
    // macOS gates desktopCapturer behind the Screen Recording permission and
    // returns black frames instead of failing; surface a real denied state.
    if (process.platform === 'darwin') {
      const status = systemPreferences.getMediaAccessStatus('screen')
      if (status !== 'granted' && status !== 'not-determined') {
        return screenSourcesResultSchema.parse({ status: 'denied', sources: [] })
      }
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false,
    })
    if (
      process.platform === 'darwin' &&
      systemPreferences.getMediaAccessStatus('screen') !== 'granted'
    ) {
      return screenSourcesResultSchema.parse({ status: 'denied', sources: [] })
    }
    const selfWindow = hostWindowFor(event.sender)
    const selfId = selfWindow?.getMediaSourceId()
    return screenSourcesResultSchema.parse({
      status: 'ok',
      sources: sources
        .filter((source) => source.id !== selfId)
        .map((source) => ({
          id: source.id,
          name: source.name,
          kind: source.id.startsWith('screen') ? 'screen' : 'window',
          thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
        })),
    })
  })

  ipcMain.handle(IPC_CHANNELS.captureScreenSource, async (event, input: unknown) => {
    sessionFor(event)
    const request = screenCaptureRequestSchema.parse(input)
    // desktopCapturer only ever returns thumbnails, so a full-res capture is
    // a re-listing with the thumbnail sized to the largest physical display.
    const displays = screen.getAllDisplays()
    const captureSize = {
      width: Math.min(
        4096,
        Math.max(1920, ...displays.map((d) => Math.ceil(d.size.width * d.scaleFactor))),
      ),
      height: Math.min(
        4096,
        Math.max(1080, ...displays.map((d) => Math.ceil(d.size.height * d.scaleFactor))),
      ),
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: captureSize,
      fetchWindowIcons: false,
    })
    const source = sources.find((candidate) => candidate.id === request.id)
    if (!source || source.thumbnail.isEmpty()) return null
    let image = source.thumbnail
    let png = image.toPNG()
    if (png.length > 20 * 1024 * 1024) {
      image = image.resize({ width: Math.round(image.getSize().width / 2) })
      png = image.toPNG()
    }
    const { width, height } = image.getSize()
    return screenCaptureResultSchema.parse({
      mediaType: 'image/png',
      base64: png.toString('base64'),
      width,
      height,
    })
  })

  ipcMain.handle(IPC_CHANNELS.readPivotDefinition, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookPivotRequestSchema.parse(input)
    const session = entry.sessions.get(request.sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    // Read from the session snapshot so the definition matches what the
    // renderer shows even if the file on disk changed since open.
    const [pivotXml, cacheXml] = await Promise.all([
      readArchiveEntryText(entry.client, session.snapshotPath, request.path),
      readArchiveEntryText(entry.client, session.snapshotPath, request.cachePath),
    ])
    return workbookPivotDefinitionSchema.parse(parsePivotDefinition(pivotXml, cacheXml))
  })

  ipcMain.handle(IPC_CHANNELS.readSlicerState, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookSlicerStateRequestSchema.parse(input)
    const session = entry.sessions.get(request.sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    // The slicer parts are read from the session snapshot in one sidecar
    // extraction; the gateway parser does the rest.
    const manifest = manifestNamesSchema.parse(
      await entry.client.archiveManifest(session.snapshotPath),
    )
    const names = manifest.entries.map((archiveEntry) => archiveEntry.name)
    const hasSlicerParts = names.some((name) =>
      /^xl\/(?:slicers|timelines)\/[^/]+\.xml$/.test(name),
    )
    if (!hasSlicerParts) return []
    // Worksheet parts and their rels are keys/lookups for the parser (host
    // sheets, pivot binding), so both ride the paths() view; only the XML
    // texts below are actually extracted.
    const wanted = names.filter(
      (name) =>
        name === 'xl/workbook.xml' ||
        name === 'xl/_rels/workbook.xml.rels' ||
        /^xl\/(?:slicers|timelines|slicerCaches|timelineCaches|pivotTables)\/[^/]+\.xml$/.test(
          name,
        ) ||
        /^xl\/pivotCache\/pivotCacheDefinition\d*\.xml$/.test(name) ||
        /^xl\/worksheets\/(?:_rels\/)?[^/]+\.xml(?:\.rels)?$/.test(name),
    )
    const texts = await readArchiveEntriesText(entry.client, session.snapshotPath, wanted)
    return workbookSlicerStateResultSchema.parse(
      await parseSlicerState({
        paths: async () => names,
        readText: async (path) => {
          const text = texts.get(path)
          if (text === undefined) throw new Error(`Workbook is missing ${path}.`)
          return text
        },
      }),
    )
  })

  // The workbook's refreshable web queries: the walk follows both shapes Excel
  // writes (a table part's relationship, or a legacy ExternalData_N name) and
  // returns the sheet and range each query fills. Read from the session
  // snapshot so the list matches what the renderer shows.
  ipcMain.handle(IPC_CHANNELS.listWorkbookConnections, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookConnectionsRequestSchema.parse(input)
    const session = entry.sessions.get(request.sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    const read = await connectionPartReader(entry.client, session.snapshotPath)
    return workbookConnectionsResultSchema.parse({ connections: await refreshableQueriesOf(read) })
  })

  // Refreshing a query: the renderer names only the connection id, and the URL
  // is resolved from the workbook part here — this IPC is not a fetch proxy.
  // The fetch still goes through the SSRF gate, because a workbook could name
  // loopback, a cloud metadata endpoint or a UNC share.
  ipcMain.handle(IPC_CHANNELS.refreshWorkbookConnection, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookRefreshRequestSchema.parse(input)
    const session = entry.sessions.get(request.sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    // Only this part is needed, and a workbook without connections has no
    // listed query to refresh: a missing part means "no such connection".
    const connectionsXml = await readArchiveEntryText(
      entry.client,
      session.snapshotPath,
      'xl/connections.xml',
    ).catch(() => undefined)
    const read: PartReader = async (path) =>
      path === 'xl/connections.xml' ? connectionsXml : undefined
    const source = await connectionSourceOf(read, request.connectionId)
    if (!source) throw new Error('This workbook has no refreshable web query with that id.')
    const table = await fetchRemoteTable(source)
    if (!table) throw new Error('Could not read a table from that address.')
    return workbookRefreshResultSchema.parse({
      headers: [...table.headers],
      rows: table.rows.map((row) => [...row]),
    })
  })

  ipcMain.handle(IPC_CHANNELS.readWorkbookQueries, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookQueriesRequestSchema.parse(input)
    const session = entry.sessions.get(request.sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    // existence from the manifest, so a missing part reads as absent rather than as a sidecar error
    const manifest = z
      .object({ entries: z.array(z.object({ name: z.string() })) })
      .parse(await entry.client.archiveManifest(session.snapshotPath))
    const names = new Set(manifest.entries.map((e) => e.name))
    return workbookQueriesResultSchema.parse(
      await listWorkbookQueries((path) =>
        names.has(path)
          ? readArchiveEntryText(entry.client, session.snapshotPath, path)
          : Promise.resolve(undefined),
      ),
    )
  })

  ipcMain.handle(IPC_CHANNELS.readWorkbookRedactions, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookRedactionsRequestSchema.parse(input)
    const session = entry.sessions.get(request.sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    // A damaged part answers `unreadable` rather than an empty list: reporting
    // "nothing is withheld" would hand the model the values it holds.
    return workbookRedactionsResultSchema.parse(
      await readWorkbookRedactionPart(entry.client, session.snapshotPath),
    )
  })

  ipcMain.handle(IPC_CHANNELS.exportPdf, async (event, input: unknown) => {
    sessionFor(event)
    const request = workbookExportPdfRequestSchema.parse(input)
    // Save As › PDF: only the path this tab's Save As dialog just returned
    // skips the export's own dialog
    if (
      request.saveAsPath !== undefined &&
      !saveAsExportTargets.take(event.sender.id, request.saveAsPath)
    ) {
      throw new Error('export target was not authorized')
    }
    const result = await exportPdf(event, request, request.saveAsPath)
    if (!result.canceled && result.path) openGeneratedFile(result.path)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.printWorkbook, async (event, input: unknown) => {
    sessionFor(event)
    return printWorkbook(event, workbookExportPdfRequestSchema.parse(input))
  })

  ipcMain.handle(IPC_CHANNELS.listPrinters, async (event) => {
    sessionFor(event)
    const printers = await event.sender.getPrintersAsync()
    return printers.map((printer) =>
      printerInfoSchema.parse({
        name: printer.name,
        displayName: printer.displayName || printer.name,
      }),
    )
  })

  ipcMain.handle(IPC_CHANNELS.exportCsv, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookExportCsvRequestSchema.parse(input)
    const parent = dialogParent(event)
    if (request.hasFormulas) {
      // Excel's CSV warning flow: offer keeping the formulas via .xlsx first.
      const options = {
        type: 'warning' as const,
        message: tm('csvFormulaLossMsg'),
        detail: tm('csvFormulaLossDetail'),
        buttons: [tm('csvKeepXlsxBtn'), tm('csvContinueBtn'), tm('btnCancel')],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      }
      const { response } = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options)
      if (response === 0) return { canceled: true, saveAsXlsxInstead: true }
      if (response === 2) return { canceled: true }
    }
    let pickedPath = request.targetPath
    if (pickedPath === undefined) {
      const selection = await saveFileDialog(event, {
        defaultPath: request.fileName,
        filters: [{ name: tm('filterCsv'), extensions: ['csv'] }],
        ...(request.activeSheetName
          ? {
              title: tm('csvActiveSheetOnlyNotice', { name: request.activeSheetName }),
              message: tm('csvActiveSheetOnlyNotice', { name: request.activeSheetName }),
            }
          : {}),
      })
      if (selection.canceled || !selection.filePath) return { canceled: true }
      pickedPath = selection.filePath
    }
    const targetPath = pickedPath.toLowerCase().endsWith('.csv') ? pickedPath : `${pickedPath}.csv`
    // UTF-8 BOM so Excel decodes the reopened file correctly. Written beside
    // the destination and renamed into place: a plain writeFile creates the
    // (empty) file before the data lands, and anything watching for the
    // export — the e2e retry loop included — can read zero bytes in that
    // window.
    const csvBytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(request.content, 'utf8'),
    ])
    await atomicWriteFile(targetPath, csvBytes)
    // An export can land on a CSV session's own source file; refresh the
    // digest so the next Save does not read this write as an external change.
    const writtenSha = await sha256File(targetPath).catch(() => undefined)
    if (writtenSha !== undefined) refreshCsvDigest(entry.sessions, targetPath, writtenSha)
    return { canceled: false, path: targetPath }
  })

  ipcMain.handle(IPC_CHANNELS.exportOds, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookExportOdsRequestSchema.parse(input)
    // The pending edits ride along as a save request. An upload they refer to
    // is taken here, before anything can return early, so a refused or
    // canceled export does not leave it waiting in memory.
    const pending =
      request.workbook === undefined || request.workbook.sessionId !== request.sessionId
        ? undefined
        : resolveTransferredEdits(entry, request.workbook)
    const session = entry.sessions.get(request.sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    const parent = dialogParent(event)

    // A password workbook runs on a plaintext temp copy; exporting it as an
    // unprotected ODS would write that plaintext where the user expects a
    // locked document (decision 0119).
    if (session.password !== undefined) {
      await showOdsMessage(parent, 'error', tm('errOdsEncrypted'))
      return { canceled: true, reason: 'encrypted' }
    }

    // Save As › ODS: only the path this tab's Save As dialog just returned
    // skips the export's own dialog.
    let targetPath: string | undefined
    if (request.targetPath !== undefined) {
      if (!saveAsExportTargets.take(event.sender.id, request.targetPath)) {
        throw new Error('export target was not authorized')
      }
      targetPath = odsTargetPath(request.targetPath)
    }

    // The original .ods the session was converted from is read-only for this
    // session. Refuse it and ask for another name instead of choosing one.
    for (;;) {
      if (targetPath === undefined) {
        targetPath = await askOdsTarget(event, await suggestedOdsPath(session))
        if (targetPath === undefined) return { canceled: true, reason: 'canceled' }
      }
      if (
        session.odsSourcePath === undefined ||
        !(await sameFilePath(targetPath, session.odsSourcePath))
      ) {
        break
      }
      await showOdsMessage(parent, 'error', tm('errOdsOriginalTarget'))
      targetPath = undefined
    }

    // The sidecar converts a real .xlsx package. With edits pending, that
    // package is a private copy written through the save writer — the same
    // one a skill's template uses: no dialog, no session swap, the opened
    // file and its recovery copy untouched. The export is a copy of what is
    // on screen, and the workbook stays as unsaved as it was.
    const copyDirectory =
      pending === undefined
        ? undefined
        : join(app.getPath('temp'), 'seuoffice-imports', randomUUID())
    let outcome: Awaited<ReturnType<typeof exportWorkbookAsOds>>
    try {
      let sourcePath = session.snapshotPath
      if (pending !== undefined && copyDirectory !== undefined) {
        await mkdir(copyDirectory, { recursive: true })
        sourcePath = join(copyDirectory, 'export.xlsx')
        await writeWorkbookTo(entry.client, session, pending, sourcePath)
      }
      outcome = await exportWorkbookAsOds({
        sidecar: entry.client,
        sourcePath,
        targetPath,
        confirmLoss: (losses) => confirmOdsLoss(parent, losses),
        confirmHidden: () => askWithheldExport(parent, 'ODS'),
      })
    } catch (error) {
      outcome = {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }
    } finally {
      if (copyDirectory !== undefined) {
        await cleanupImportTempDirectory(app.getPath('temp'), copyDirectory).catch(() => undefined)
      }
    }
    if (outcome.status === 'exported') {
      return { canceled: false, path: outcome.path, ...outcome.result }
    }
    if (outcome.status === 'redacted') {
      return {
        canceled: true,
        reason: 'redacted',
        ...(outcome.choice === 'xlsx' ? { saveAsXlsxInstead: true } : {}),
      }
    }
    if (outcome.status === 'unreadable') {
      await showOdsMessage(parent, 'error', tm('errOdsReopenFailed'))
      return { canceled: true, reason: 'unreadable' }
    }
    if (outcome.status === 'failed') {
      await showOdsMessage(parent, 'error', tm('errOdsExportFailed', { message: outcome.message }))
      return { canceled: true, reason: 'failed' }
    }
    return { canceled: true, reason: 'canceled' }
  })

  // AI create_document: dialog-free — the file lands in the default save
  // folder under a unique sanitized name and opens in a new tab. xlsx/csv
  // write the renderer-serialized worksheet data here (xlsx through the same
  // CSV→xlsx conversion as CSV imports, values only); docx/pdf/md go through
  // the host-owned creator (the shell routes them into the docs flow, #960).
  ipcMain.handle(
    IPC_CHANNELS.createDocument,
    async (event, input: unknown): Promise<WorkbookCreateDocumentResult> => {
      sessionFor(event)
      const request = workbookCreateDocumentRequestSchema.parse(input)
      try {
        if (request.type === 'csv') {
          const fileName = `${sanitizeGeneratedFileBase(request.title)}.csv`
          // UTF-8 BOM so Excel decodes the reopened file correctly (same as exportCsv)
          const bytes = Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from(request.content, 'utf8'),
          ])
          // with a project chosen in this view's panel, into that folder (spec 6)
          const placed = await runtime.writeNewDocument?.(event.sender.id, fileName, bytes)
          const filePath = placed ?? uniquePathIn(configuredDefaultSaveDir(app), fileName)
          if (!placed) await atomicWriteFile(filePath, bytes)
          openGeneratedFile(filePath)
          return { ok: true, path: filePath }
        }
        if (request.type === 'xlsx') {
          const buffer = await sheetCsvToXlsxBuffer(request.content, request.sheetName ?? 'Sheet1')
          const fileName = `${sanitizeGeneratedFileBase(request.title)}.xlsx`
          // the workbook is made in memory first; with a project, written into its folder
          const placed = await runtime.writeNewDocument?.(event.sender.id, fileName, buffer)
          const filePath = placed ?? uniquePathIn(configuredDefaultSaveDir(app), fileName)
          if (!placed) await atomicWriteFile(filePath, buffer)
          openGeneratedFile(filePath)
          return { ok: true, path: filePath }
        }
        const create = runtime.createDocument
        if (!create) return { ok: false, error: 'Document creation is unavailable in this host.' }
        return await create(
          { type: request.type, title: request.title, content: request.content },
          event.sender.id,
        )
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // First Save of a CSV session: Excel's "keep this format?" question. The
  // renderer remembers the answer for the file, so it is asked once.
  ipcMain.handle(IPC_CHANNELS.csvWithheldChoice, async (event) => {
    sessionFor(event)
    return askWithheldExport(dialogParent(event), 'CSV')
  })

  ipcMain.handle(IPC_CHANNELS.csvSaveConfirm, async (event) => {
    sessionFor(event)
    const options = {
      type: 'warning' as const,
      message: tm('csvKeepFormatMsg'),
      detail: tm('csvKeepFormatDetail'),
      buttons: [tm('csvContinueBtn'), tm('csvKeepXlsxBtn'), tm('btnCancel')],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    }
    const parent = dialogParent(event)
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    return response === 0 ? 'csv' : response === 1 ? 'xlsx' : 'cancel'
  })

  ipcMain.handle(IPC_CHANNELS.saveWorkbook, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const client = entry.client
    const request = resolveTransferredEdits(entry, workbookSaveRequestSchema.parse(input))
    const session = entry.sessions.get(request.sessionId)
    if (!session) throw new Error('Unknown workbook session.')

    // A CSV session's plain Save keeps the CSV identity: the xlsx save lands
    // on the temp copy and the serialized csvContent is written back to the
    // original .csv afterwards.
    const csvInPlace = request.mode === 'save' && session.csvSourcePath !== undefined
    let targetPath = session.path
    // MCP explicit-path save (planning/mcp-server.md): dialog-free Save As to
    // an exact path with a clobber guard — docs:save-to parity. Only the xlsx
    // pipeline is reachable this way (.xlsm/.csv need their interactive flows).
    if (request.targetPath !== undefined) {
      if (request.mode !== 'save-as') throw new Error('An explicit save path needs Save As.')
      if (!isAbsolute(request.targetPath)) throw new Error('Save path must be absolute.')
      targetPath = /\.xlsx$/i.test(request.targetPath)
        ? request.targetPath
        : `${request.targetPath}.xlsx`
      // only a target the MCP layer resolved for this tab may be written without a dialog
      if (!canMcpSheetWrite(event.sender.id, targetPath)) {
        throw new Error('save target was not authorized')
      }
      if (existsSync(targetPath) && request.overwrite !== true) {
        throw new Error(`file already exists: ${targetPath}`)
      }
    } else if (request.mode === 'save' && request.quiet && session.unsavedNew) {
      // AutoSave / AI-run autosave of a workbook the user has not named yet:
      // no dialog mid-flow, the edits land in the backing temp file and the
      // session stays an unsaved new one (Ctrl+S still asks where to save)
      targetPath = session.path
    } else if (request.mode === 'save-as' || session.suggestSaveAs !== undefined) {
      // .xlsm keeps its extension: untouched archive entries (vbaProject.bin,
      // the macro-enabled content type) round-trip verbatim through the save.
      const macroEnabled = /\.xlsm$/i.test(
        session.suggestSaveAs ?? session.restoreTarget ?? session.path,
      )
      // a new workbook whose panel has a project is offered in that folder (spec 6);
      // a restored one keeps offering where its original was
      const projectDir =
        session.unsavedNew && session.suggestSaveAs !== undefined && !session.recoveryOriginalPath
          ? await runtime.newDocumentDir?.(event.sender.id)
          : null
      // PDF/ODS (copies) only on an explicit Save As: a first Save can be the
      // save-before-close, which a copy must not answer
      const offerCopies = request.mode === 'save-as'
      const suggestion =
        (projectDir && session.suggestSaveAs !== undefined
          ? join(projectDir, basename(session.suggestSaveAs))
          : undefined) ??
        session.suggestSaveAs ??
        session.csvSourcePath?.replace(/\.[^.]+$/, '.xlsx') ??
        session.restoreTarget ??
        session.path
      // A name the model proposed for the reader's own request prefills the
      // dialog rather than replacing it: the reader still chooses where the
      // file goes, and cancelling still cancels. Without one, the dialog opens
      // on the name the save would have offered anyway.
      const proposed = request.defaultName ? sanitizeAutoRenameBase(request.defaultName) : null
      const named = proposed
        ? join(dirname(suggestion), `${proposed}.${macroEnabled ? 'xlsm' : 'xlsx'}`)
        : suggestion
      const selection = await saveFileDialog(event, {
        // with copy formats on offer the suggestion carries no extension: the
        // file type chosen in the dialog supplies it
        defaultPath: offerCopies ? sheetsSaveAsSuggestion(named) : named,
        // the workbook's own type first, then the copies (CSV, ODS, PDF)
        filters: sheetsSaveAsFilters(macroEnabled, offerCopies, (key) => tm(key)),
        // CSV import: explain why the save goes through .xlsx (CSV keeps values only)
        ...(session.csvImport
          ? { title: tm('csvSaveAsNotice'), message: tm('csvSaveAsNotice') }
          : {}),
      })
      if (selection.canceled || !selection.filePath) return { canceled: true }
      const pick = resolveSheetsSaveAsPick(selection.filePath, macroEnabled, offerCopies)
      // Some Linux dialogs do not append the chosen filter's extension. A bare
      // name cannot tell the workbook apart from a CSV/ODS/PDF copy, and
      // guessing the workbook would silently write an .xlsx after the person
      // picked the ODS filter; ask for an extension instead of saving.
      if (pick.kind === 'needs-extension') {
        const parent = dialogParent(event)
        const options = {
          type: 'warning' as const,
          message: tm('saveAsNeedsExtension'),
          buttons: [tm('btnCloseDialog')],
          defaultId: 0,
          noLink: true,
        }
        if (parent && !parent.isDestroyed()) await dialog.showMessageBox(parent, options)
        else await dialog.showMessageBox(options)
        return { canceled: true }
      }
      // A CSV pick can't ride the xlsx pipeline: hand the path back so the
      // renderer serializes the active sheet through the CSV export channel.
      if (pick.kind === 'csv') return { canceled: true, csvSaveAsPath: pick.path }
      // An ODS pick is a copy as well: the renderer asks the ODS export to
      // write it, and the session keeps its .xlsx path.
      if (pick.kind === 'ods') {
        saveAsExportTargets.authorize(event.sender.id, pick.path)
        return { canceled: true, odsSaveAsPath: pick.path }
      }
      // A PDF pick is a copy too: the renderer lays out the active sheet and
      // the PDF export writes it here without asking again. The session, its
      // path and its pending edits stay as they are.
      if (pick.kind === 'pdf') {
        saveAsExportTargets.authorize(event.sender.id, pick.path)
        return { canceled: true, pdfSaveAsPath: pick.path }
      }
      targetPath = pick.path
    } else if (session.restoreTarget !== undefined) {
      // Restored crash-recovery copy: the restore prompt was the confirmation,
      // so Save writes straight back to the original — unless someone else
      // changed it since the restore.
      const verdict = await guardSplitSave({
        path: session.restoreTarget,
        recorded: recordedStateFor(session, session.restoreTarget),
        quiet: request.quiet === true,
        event,
      })
      if (verdict === 'cancel') return { canceled: true }
      if (verdict !== 'overwrite') {
        const currentSha = await sha256File(session.restoreTarget).catch(() => undefined)
        if (currentSha !== undefined && currentSha !== session.restoreTargetSha) {
          throw new Error(tm('errDiskChanged'))
        }
      }
      targetPath = session.restoreTarget
    } else {
      // Plain in-place save: refuse to silently overwrite a file some other
      // program changed after this session opened it. Save As (above) skips
      // this guard on purpose — it patches the session snapshot, not the live
      // file, and writes to a path the user just confirmed, so it stays
      // usable as the escape hatch this error message points to. A file that
      // was deleted on disk is fine: saving recreates it. Split-view copy
      // pairs are judged first: their confirmed overwrite already covered the
      // disk change, so the refusal below steps aside for that one write.
      const verdict = await guardSplitSave({
        path: session.path,
        recorded: recordedStateFor(session, session.path),
        quiet: request.quiet === true,
        event,
      })
      if (verdict === 'cancel') return { canceled: true }
      if (verdict !== 'overwrite') {
        const currentSha = await sha256File(session.path).catch(() => undefined)
        if (currentSha !== undefined && currentSha !== session.sha256) {
          throw new Error(tm('errDiskChanged'))
        }
      }
    }
    // The CSV write-back gets the same external-change guard as restoreTarget;
    // a deleted .csv is fine — the write recreates it.
    if (csvInPlace && session.csvSourcePath !== undefined) {
      const verdict = await guardSplitSave({
        path: session.csvSourcePath,
        recorded: recordedStateFor(session, session.csvSourcePath),
        quiet: request.quiet === true,
        event,
      })
      if (verdict === 'cancel') return { canceled: true }
      if (verdict !== 'overwrite') {
        const csvSha = await sha256File(session.csvSourcePath).catch(() => undefined)
        if (csvSha !== undefined && csvSha !== session.csvSourceSha) {
          throw new Error(tm('errDiskChanged'))
        }
      }
    }

    // An encrypted workbook's save lands as plaintext only inside its own temp
    // dir; the target receives the re-encrypted bytes, so no plaintext ever
    // reaches the user's folder.
    const plainSaveDir =
      session.password !== undefined && session.importTempDir !== undefined
        ? join(session.importTempDir, randomUUID())
        : undefined
    const plainSavePath =
      plainSaveDir === undefined ? undefined : join(plainSaveDir, basename(targetPath))
    if (plainSaveDir !== undefined) await mkdir(plainSaveDir, { recursive: true })
    // The save lands on the next session's snapshot first, and the sidecar
    // opens it there before any user-visible file is touched. Writing the
    // target first and reopening it afterwards meant an output the engine
    // could not read back had already replaced the original, while the old
    // session was gone — every later Save then failed with "Unknown workbook
    // session." and the edits could not be saved anywhere.
    const stagedPath = await reserveSnapshotPath()
    let mutation: Awaited<ReturnType<typeof writeWorkbookTo>>
    try {
      mutation = await writeWorkbookTo(client, session, request, stagedPath)
    } catch (error) {
      await rm(stagedPath, { force: true }).catch(() => undefined)
      throw error
    }
    let stagedOpen: SidecarOpenResult
    try {
      // The previous session is still resident while its save reopens, so a
      // large workbook opens slower here than it did the first time; give it
      // the headroom the archive commands of the same save get.
      stagedOpen = sidecarOpenResultSchema.parse(
        await client.open(stagedPath, documentLocale(), systemShortDate(), {
          timeoutMs: SAVE_REOPEN_TIMEOUT_MS,
        }),
      )
    } catch (error) {
      const stagedBytes = await stat(stagedPath).then(
        (info) => info.size,
        () => null,
      )
      await rm(stagedPath, { force: true }).catch(() => undefined)
      console.warn('[sheets] the saved workbook did not reopen; the target was left as is:', error)
      const failure = describeReopenFailure(error)
      const sourceFormat = sessionSourceFormat(session)
      appendSaveFailure(join(app.getPath('userData'), SAVE_FAILURE_LOG_FILE), {
        failure,
        sourceFormat,
        stagedBytes,
        appVersion: app.getVersion(),
      })
      if (request.quiet !== true && !isHeadlessMode()) {
        await showSaveUnreadableDialog(
          dialogParent(event),
          reopenFailureNote(failure),
          sourceFormat,
        )
      }
      throw new Error(`${tm('errSaveUnreadable')} ${reopenFailureNote(failure)}`, {
        cause: error,
      })
    }
    try {
      if (plainSavePath !== undefined && session.password !== undefined) {
        await copyFile(stagedPath, plainSavePath)
        await atomicWriteFile(
          targetPath,
          encryptOoxml(await readFile(stagedPath), session.password),
        )
      } else {
        await placeStagedSave(stagedPath, targetPath)
      }

      if (csvInPlace && session.csvSourcePath !== undefined && request.csvContent !== undefined) {
        // The temp copy already holds the saved bytes: refresh the session's
        // guard digest first, so a failed CSV write-back below leaves a
        // retryable session instead of stranding the next Save on
        // errDiskChanged against its own write.
        const savedSha = await sha256File(session.path).catch(() => undefined)
        if (savedSha !== undefined && entry.sessions.has(request.sessionId)) {
          entry.sessions.set(request.sessionId, { ...session, sha256: savedSha })
        }
        // UTF-8 BOM so Excel decodes the reopened file correctly.
        await writeFile(
          session.csvSourcePath,
          Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(request.csvContent, 'utf8')]),
        )
      }
    } catch (error) {
      await client.close(stagedOpen.sessionId).catch(() => undefined)
      await rm(stagedPath, { force: true }).catch(() => undefined)
      throw error
    }

    // The sidecar session still streams the pre-save bytes; swap it for a
    // fresh session over the saved file so future reads match the disk state.
    const quietUnsavedNew = targetPath === session.path && session.unsavedNew === true
    entry.sessions.delete(request.sessionId)
    await cleanupSessionResources({
      tempRoot: app.getPath('temp'),
      snapshotPath: session.snapshotPath,
      // A CSV in-place save keeps saving into the temp copy, and a quiet save of
      // an unsaved new workbook just wrote its backing file — the directory
      // must survive the session swap. So must an encrypted workbook's: the
      // next session runs on the plaintext copy just written there.
      importTempDir:
        csvInPlace || quietUnsavedNew || plainSavePath !== undefined
          ? undefined
          : session.importTempDir,
      closeSidecar: () => client.close(request.sessionId),
    })
    if (plainSavePath !== undefined) await rm(session.path, { force: true }).catch(() => undefined)
    const staged = { snapshotPath: stagedPath, opened: stagedOpen }
    const file = await openWorkbookSession(
      client,
      plainSavePath ?? targetPath,
      entry.sessions,
      plainSavePath !== undefined
        ? {
            importTempDir: session.importTempDir,
            restoreTarget: targetPath,
            password: session.password,
            odsSourcePath: session.odsSourcePath,
            staged,
          }
        : csvInPlace
          ? {
              csvImport: true,
              csvSourcePath: session.csvSourcePath,
              importTempDir: session.importTempDir,
              // the CSV stays open: later edits keep writing the same copy slot
              recoveryIdentity: session.recoveryIdentity,
              recoveryOriginalPath: session.recoveryOriginalPath,
              odsSourcePath: session.odsSourcePath,
              staged,
            }
          : quietUnsavedNew
            ? {
                suggestSaveAs: session.suggestSaveAs,
                importTempDir: session.importTempDir,
                unsavedNew: true,
                recoveryIdentity: session.recoveryIdentity,
                recoveryOriginalPath: session.recoveryOriginalPath,
                unsavedRestore: session.unsavedRestore,
                odsSourcePath: session.odsSourcePath,
                // still the converted copy of an .ods: the notice and its
                // dropped-formula count stay with it across the quiet save
                odsConverted: session.odsConverted,
                formulasDropped: session.formulasDropped,
                staged,
              }
            : { odsSourcePath: session.odsSourcePath, staged },
    )
    // the swap retargets the tab: a Save As renames the file the picker
    // matches links against
    entry.currentPath = (csvInPlace ? session.csvSourcePath : undefined) ?? targetPath
    if (quietUnsavedNew && session.suggestSaveAs !== undefined) {
      // the temp path must not reach the title or recents; the recovery copy
      // is what a crash restores from (and what keeps the tab unsaved), so it
      // tracks the saved bytes even when the periodic copy is off for size
      try {
        await writeSessionCopy(event.sender.id, session, (target) => copyFile(targetPath, target), {
          ignoreSizeLimit: true,
        })
      } catch (error) {
        console.warn('[sheets] recovery copy of an unsaved new workbook failed:', error)
      }
      return { canceled: false, file, touchedEntries: mutation.touchedEntries }
    }
    // Notify shell (if running) so it can update the tab title and record the
    // saved path in recent files (mirrors the open hook; covers Save As + first
    // save after converting an .xls/.csv import). A CSV session's user-visible
    // file is the original .csv, not the temp copy the xlsx save landed on.
    workbookOpenedHook?.(
      event.sender,
      (csvInPlace ? session.csvSourcePath : undefined) ?? targetPath,
    )
    // The file on disk now carries these edits: the saved document's copy goes,
    // and so does the copy the session wrote under its own identity (an
    // untitled workbook's, or a restored file's when Save As went elsewhere).
    deleteCopiesAfterSave(event.sender.id, [
      fileRecoveryIdentity(targetPath),
      sessionRecoveryIdentity(session),
      session.restoreTarget === undefined ? null : fileRecoveryIdentity(session.restoreTarget),
    ])
    return { canceled: false, file, touchedEntries: mutation.touchedEntries }
  })

  // Chunked upload for edit sets too large to inline in one save request:
  // the renderer opens a transfer, streams ordered slices, then references
  // the transfer id from the save (or recovery) request that follows.
  ipcMain.handle(IPC_CHANNELS.saveEditsBegin, (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookSaveEditsBeginSchema.parse(input)
    if (!entry.sessions.has(request.sessionId)) throw new Error('Unknown workbook session.')
    entry.saveTransfers.begin(request)
  })

  ipcMain.handle(IPC_CHANNELS.saveEditsChunk, (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookSaveEditsChunkSchema.parse(input)
    // The chunk crosses the bridge and the IPC hop as a flat JSON string;
    // the edits stay untrusted input until they pass the cell-edit schema.
    entry.saveTransfers.addChunk({
      sessionId: request.sessionId,
      transferId: request.transferId,
      seq: request.seq,
      edits: saveEditsChunkArraySchema.parse(JSON.parse(request.editsJson)),
    })
  })

  // Best-effort cleanup from renderer failure paths; a no-op if the transfer
  // was already consumed or expired.
  ipcMain.handle(IPC_CHANNELS.saveEditsAbort, (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookSaveEditsAbortSchema.parse(input)
    entry.saveTransfers.discard(request.transferId, request.sessionId)
  })

  // Crash-recovery copy of a dirty workbook: the same save pipeline with a
  // userData target, no session swap and no dialogs — best-effort, silent on failure.
  ipcMain.handle(IPC_CHANNELS.writeWorkbookRecovery, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = resolveTransferredEdits(entry, workbookSaveRequestSchema.parse(input))
    const session = entry.sessions.get(request.sessionId)
    // Which copy (if any) is decided by sessionRecoveryIdentity: none for a
    // password workbook; an untitled slot for a new workbook and for a CSV or
    // converted session; the user's file for a restored copy or an empty
    // original (both run on a temp file the session was snapshotted from).
    if (!session) return { ok: false }
    try {
      const written = await writeSessionCopy(event.sender.id, session, (target) =>
        writeWorkbookTo(entry.client, session, request, target),
      )
      return { ok: written }
    } catch (error) {
      console.warn('[sheets] recovery copy failed:', error)
      return { ok: false }
    }
  })

  // The workbook as edited, for a skill's template (spec 5.6): written to a
  // temp file of its own through the save writer and read back. No dialog, no
  // session swap, the opened file and the recovery copy untouched.
  ipcMain.handle(IPC_CHANNELS.workbookTemplateBytes, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = resolveTransferredEdits(entry, workbookSaveRequestSchema.parse(input))
    const session = entry.sessions.get(request.sessionId)
    if (!session) return { ok: false }
    const directory = join(app.getPath('temp'), 'seuoffice-imports', randomUUID())
    try {
      await mkdir(directory, { recursive: true })
      const target = join(directory, 'template.xlsx')
      await writeWorkbookTo(entry.client, session, request, target)
      const bytes = new Uint8Array(await readFile(target))
      return { ok: true, bytes }
    } catch (error) {
      console.warn('[sheets] template copy failed:', error)
      return { ok: false }
    } finally {
      await cleanupImportTempDirectory(app.getPath('temp'), directory).catch(() => undefined)
    }
  })

  ipcMain.handle(IPC_CHANNELS.closeWorkbook, async (event, sessionId: unknown) => {
    const entry = sessionFor(event)
    const validatedSessionId = z.string().uuid().parse(sessionId)
    entry.saveTransfers.discardSession(validatedSessionId)
    const session = entry.sessions.get(validatedSessionId)
    if (!entry.sessions.delete(validatedSessionId)) return
    if (session === undefined) return
    // The copy is left alone here: this also runs while the app quits (the
    // renderer unmounts) and when a tab swaps workbooks. A copy still holding
    // unsaved work is remembered so the tab's clean close keeps it.
    noteSessionClosed(event.sender.id, session)
    await cleanupSessionResources({
      tempRoot: app.getPath('temp'),
      snapshotPath: session.snapshotPath,
      importTempDir: session.importTempDir,
      closeSidecar: () => entry.client.close(validatedSessionId),
    })
  })

  // Content-derived naming for AI-generated workbooks (sheets' analog of slides'
  // deckName): the renderer proposes a base name after an AI run lands; the file
  // is renamed only while it still carries the shell's auto-created untitled name.
  ipcMain.handle(
    IPC_CHANNELS.autoRenameWorkbook,
    (event, sessionId: unknown, baseName: unknown) => {
      const entry = sessionFor(event)
      const validatedSessionId = z.string().uuid().parse(sessionId)
      const session = entry.sessions.get(validatedSessionId)
      if (!session || !untitledWorkbookPaths.has(session.path)) return { renamed: false }
      const base = sanitizeAutoRenameBase(z.string().min(1).max(100).parse(baseName))
      if (!base) return { renamed: false }
      // An unsaved new workbook has no user-visible file to rename — it sits in
      // a temp directory that closing the tab discards. Retarget the suggested
      // Save As name instead, so the AI-derived name is what the first save
      // offers, and leave the mark in place for a later run. No rename on disk
      // and no open hook: the temp path must not reach the title or recents.
      if (session.suggestSaveAs !== undefined) {
        const suggestDir = dirname(session.suggestSaveAs)
        let suggested = join(suggestDir, `${base}.xlsx`)
        const taken = (p: string) =>
          p !== session.suggestSaveAs && (existsSync(p) || sheetsSuggestedPathTaken(p))
        for (let i = 2; taken(suggested) && i < 100; i++) {
          suggested = join(suggestDir, `${base}-${i}.xlsx`)
        }
        if (suggested === session.suggestSaveAs || taken(suggested)) return { renamed: false }
        entry.sessions.set(validatedSessionId, { ...session, suggestSaveAs: suggested })
        event.sender.send(IPC_CHANNELS.workbookRenamed, basename(suggested))
        return { renamed: true, name: basename(suggested) }
      }
      const dir = dirname(session.path)
      let target = join(dir, `${base}.xlsx`)
      for (let i = 2; existsSync(target) && i < 100; i++) target = join(dir, `${base}-${i}.xlsx`)
      if (existsSync(target) || target === session.path) return { renamed: false }
      try {
        renameSync(session.path, target)
      } catch (err) {
        console.warn('[sheets] auto-rename failed:', err)
        return { renamed: false }
      }
      untitledWorkbookPaths.delete(session.path)
      entry.sessions.set(validatedSessionId, { ...session, path: target })
      event.sender.send(IPC_CHANNELS.workbookRenamed, basename(target))
      // Same contract as open/save: shell updates the tab title and recents
      workbookOpenedHook?.(event.sender, target)
      return { renamed: true, name: basename(target) }
    },
  )

  ipcMain.handle(IPC_CHANNELS.openExternal, async (event, url: unknown) => {
    sessionFor(event)
    const validatedUrl = safeExternalUrl(url)
    if (!validatedUrl) {
      throw new Error('Only http(s) links can be opened.')
    }
    await shell.openExternal(validatedUrl)
  })

  // ── Chat attachments (same structure as the docs/slides files:* pipeline) ──

  ipcMain.handle(IPC_CHANNELS.filesPick, async (event): Promise<AttachmentAddResult | null> => {
    sessionFor(event)
    const selection = await openFileDialog(event, {
      title: tm('dlgAddAttachment'),
      filters: [
        { name: tm('filterSupported'), extensions: [...ATTACHABLE_EXTS] },
        { name: tm('filterAll'), extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    })
    if (selection.canceled || selection.filePaths.length === 0) return null
    return collectAttachments(selection.filePaths)
  })

  ipcMain.handle(IPC_CHANNELS.filesAdd, (event, paths: unknown): AttachmentAddResult => {
    sessionFor(event)
    return collectAttachments(z.array(z.string().min(1).max(1024)).max(50).parse(paths))
  })

  ipcMain.handle(
    IPC_CHANNELS.filesRead,
    async (
      event,
      filePath: unknown,
      offset: unknown,
      maxChars: unknown,
    ): Promise<AttachmentReadResult> => {
      sessionFor(event)
      const validatedPath = z.string().min(1).max(1024).parse(filePath)
      const name = basename(validatedPath)
      const ext = diagramPictureExtOf(validatedPath) ?? name.split('.').pop()?.toLowerCase() ?? ''
      if (!ATTACHABLE_EXTS.has(ext)) return { ok: false, error: tm('errUnsupportedExt', { ext }) }
      if (ATTACHABLE_IMAGE_EXTS.has(ext)) {
        return { ok: false, error: tm('errImageNoText') }
      }
      try {
        const text = await extractAttachmentText(validatedPath)
        const start = Math.max(0, Math.floor(Number(offset)) || 0)
        const size = Math.min(Math.max(1, Math.floor(Number(maxChars)) || 1), 48_000)
        return {
          ok: true,
          name,
          totalChars: text.length,
          offset: start,
          text: text.slice(start, start + size),
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // Image attachments read raw bytes → base64; the renderer puts them into the
  // user message's images for multimodal input
  ipcMain.handle(IPC_CHANNELS.filesReadImage, (event, filePath: unknown): AttachmentImageResult => {
    sessionFor(event)
    const validatedPath = z.string().min(1).max(1024).parse(filePath)
    const name = basename(validatedPath)
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    const mime = ATTACHMENT_IMAGE_MIME[ext]
    if (!mime) return { ok: false, error: `${name}: ${tm('errNotImage')}` }
    try {
      const stat = statSync(validatedPath)
      if (stat.size > ATTACHABLE_IMAGE_MAX_BYTES) {
        return { ok: false, error: `${name}: ${tm('errImageTooLarge')}` }
      }
      return { ok: true, base64: readFileSync(validatedPath).toString('base64'), mime }
    } catch {
      return { ok: false, error: `${name}: ${tm('errUnreadable')}` }
    }
  })

  // Clipboard-pasted images (screenshots and other bitmaps without a local
  // path): persisted to a temp file, then go through the regular attachment flow
  ipcMain.handle(
    IPC_CHANNELS.filesAddPastedImage,
    (event, data: unknown, ext: unknown): AttachmentAddResult => {
      sessionFor(event)
      const filePath = savePastedImage(data, ext)
      return filePath
        ? collectAttachments([filePath])
        : { accepted: [], rejected: [tm('errNotImage')] }
    },
  )
}

let aiIpcRegistered = false

export function registerSheetsAiIpc(): void {
  if (aiIpcRegistered) return
  aiIpcRegistered = true
  app.once('before-quit', shutdownCodexAppServers)

  // Node fetch (undici) direct connections get reset under VPN/tun setups; retry over Chromium's stack
  setRescueFetch((url, init) => net.fetch(url, init))
  setAiUserAgent(`${PRODUCT_NAME}/${app.getVersion()}`)

  const broadcastAiSettingsChanged = (): void => {
    for (const wc of webContents.getAllWebContents())
      if (!wc.isDestroyed()) wc.send(IPC_CHANNELS.aiSettingsChanged)
  }

  // Subscription connection (Claude, Codex): one registration per process,
  // whichever editor's main asks first
  ensureSubscriptionIpc(ipcMain, {
    getSettings: () => aiSettingsFromStored(readJson<unknown>(SETTINGS_PATH(), {})),
    setMeteredAccepted: (provider, accepted) => {
      writeAiSettingsFile(
        withMeteredAccepted(readJson<unknown>(SETTINGS_PATH(), {}), provider, accepted),
      )
      broadcastAiSettingsChanged()
    },
    dataDir: app.getPath('userData'),
    broadcast: (channel, payload) => {
      for (const wc of webContents.getAllWebContents())
        if (!wc.isDestroyed()) wc.send(channel, payload)
    },
    loginWindowText: (provider) => aiSubscriptionLoginWindowText(getUiLang(), provider),
    // the ChatGPT sign-in is the app's own (decision 0081): OpenAI's page in the system browser
    chatGptSignIn: {
      openBrowser: async (url) => {
        const target = safeExternalUrl(url)
        if (!target) return false
        return shell.openExternal(target).then(
          () => true,
          () => false,
        )
      },
      pages: () => aiChatGptSignInPages(getUiLang()),
    },
  })

  ipcMain.handle(IPC_CHANNELS.aiGetSettings, (event): AiSettings => {
    sessionFor(event)
    return aiSettingsFromStored(readJson<unknown>(SETTINGS_PATH(), {}))
  })

  ipcMain.handle(IPC_CHANNELS.aiSetSettings, async (event, input: unknown) => {
    sessionFor(event)
    const settings = aiSettingsInputSchema.parse(input)
    // the live model lists (decision 0087) and the CLIs turned off (decision 0114) are the
    // main process's: the file's copy is kept
    const stored = aiSettingsFromStored(readJson<unknown>(SETTINGS_PATH(), {}))
    writeAiSettingsFile(withStoredMainFields(settings as AiSettings, stored))
    broadcastAiSettingsChanged()
  })

  ipcMain.handle(IPC_CHANNELS.aiChat, async (event, input: unknown) => {
    sessionFor(event)
    const request = aiChatRequestSchema.parse(input)
    // never another provider than the one selected: a request none can run is refused
    const target = resolveAiRunTarget(request.settings, sharedSubscriptionStatuses())
    if (!target.ok) return { ok: false, error: target.block.error }
    const { provider, config } = target
    const refusal = aiRunRefusal({ senderId: event.sender.id, provider, model: config.model })
    if (refusal) return { ok: false, error: refusal }
    try {
      const result = await chatForProvider(provider, config, request.system, request.user)
      // the one-shot path reports HTTP failures as ok:false with the raw body —
      // replace capacity/rate-limit dumps with the localized "busy" message
      if (!result.ok && isAiOverloadedError(result.error)) {
        return { ok: false, error: tm('errAiBusy') }
      }
      return result
    } catch (err) {
      return { ok: false, error: isAiOverloadedError(err) ? tm('errAiBusy') : String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.aiStream, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = aiStreamRequestSchema.parse(input)
    const { requestId, system, messages } = request
    const tools = request.tools ?? []
    // never another provider than the one selected: a request none can run is
    // answered with its cause, so the panel shows how to connect
    const target = resolveAiRunTarget(request.settings, sharedSubscriptionStatuses())
    const maxTokens = request.maxTokens ?? maxOutputTokensOf(target.settings)
    const send = (chunk: AiStreamChunk) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.aiStreamChunk, chunk)
    }
    if (!target.ok) {
      send(aiRunBlockChunk(requestId, target.block))
      return
    }
    const { provider, config } = target
    const refusal = aiRunRefusal({ senderId: event.sender.id, provider, model: config.model })
    if (refusal) {
      send({ requestId, type: 'error', error: refusal })
      return
    }
    const controller = new AbortController()
    entry.aiStreams.set(requestId, controller)
    const unwatchSender = abortOnDestroyed(event.sender, controller)
    // wire-activity keepalive: lets the renderer's silence watchdog tell a slow turn from a dead one
    let lastPing = 0
    const ping = () => {
      const now = Date.now()
      if (now - lastPing < 5_000) return
      lastPing = now
      send({ requestId, type: 'ping' })
    }
    try {
      let stopReason: string | undefined
      await streamForProvider(provider, config, system, messages, tools, maxTokens, {
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        signal: controller.signal,
        onDelta: (text) => send({ requestId, type: 'delta', text }),
        onReasoningDelta: (text) => send({ requestId, type: 'reasoning', text }),
        onToolCall: (toolCall) => send({ requestId, type: 'tool-call', toolCall }),
        onActivity: ping,
        onStopReason: (reason) => {
          stopReason = reason
        },
        onUsage: (usage) => send({ requestId, type: 'usage', usage }),
        ...subscriptionStreamCallbacks(requestId, send),
      })
      // sheets tsconfig sets exactOptionalPropertyTypes: an explicit
      // `stopReason: undefined` is not assignable to AiStreamChunk, so only
      // include the property when a reason was actually reported.
      send(
        stopReason === undefined
          ? { requestId, type: 'done' }
          : { requestId, type: 'done', stopReason },
      )
    } catch (err) {
      if (controller.signal.aborted) {
        send({ requestId, type: 'done' })
      } else {
        send(aiStreamErrorChunk(requestId, err))
      }
    } finally {
      unwatchSender()
      entry.aiStreams.delete(requestId)
    }
  })

  ipcMain.handle(IPC_CHANNELS.aiStreamCancel, (event, requestId: unknown) => {
    const entry = sessionFor(event)
    entry.aiStreams.get(z.string().min(1).parse(requestId))?.abort()
    // Stop while a tool runs names a turn that already ended: end the tab's media calls too
    abortMediaCalls(event.sender.id)
  })

  // Shared search tools (content + images): Serper with DuckDuckGo fallback
  // (same source as slides/docs)
  ipcMain.handle('ai:web-search', async (event, query: unknown, maxResults?: unknown) => {
    sessionFor(event)
    try {
      return await webSearchTool(
        SETTINGS_PATH(),
        z.string().parse(query),
        typeof maxResults === 'number' ? maxResults : 6,
      )
    } catch (err) {
      return { results: [], method: 'error', error: String(err) }
    }
  })
  ipcMain.handle('ai:image-search', async (event, query: unknown, maxResults?: unknown) => {
    sessionFor(event)
    try {
      return await imageSearchTool(
        SETTINGS_PATH(),
        z.string().parse(query),
        typeof maxResults === 'number' ? maxResults : 8,
      )
    } catch (err) {
      return { images: [], method: 'error', error: String(err) }
    }
  })
  // Read one web page as text (the read_url tool), paged by character offset.
  // A long download ends with the tab or when the tab's AI run is stopped.
  ipcMain.handle('ai:read-url', async (event, url: unknown, offset?: unknown) => {
    sessionFor(event)
    try {
      return await withMediaCallSignal(event.sender, (signal) =>
        readUrlTool(
          SETTINGS_PATH(),
          z.string().parse(url),
          typeof offset === 'number' ? offset : 0,
          { signal },
        ),
      )
    } catch {
      return { ok: false, error: 'The read failed.', errorCode: 'network' }
    }
  })

  // Standalone parity with docs-main's shell-wide handler: AI-supplied URLs are
  // prompt-injectable, so fetchRemoteImage refuses non-http schemes and
  // private/link-local targets and validates every redirect hop. Size-capped to
  // match the local add_image limit.
  ipcMain.handle(
    'ai:fetch-image',
    async (event, url: unknown): Promise<{ base64: string; mime: string } | null> => {
      sessionFor(event)
      try {
        const resp = await fetchRemoteImage(z.string().parse(url))
        if (!resp || !resp.ok || !resp.body) return null
        const declared = Number(resp.headers.get('content-length') ?? 0)
        if (declared > MAX_REMOTE_IMAGE_BYTES) return null
        // Stream with a running cap: a missing/understated Content-Length must
        // not let a prompt-injected URL buffer unbounded bytes before a
        // post-hoc size check
        const reader = resp.body.getReader()
        const chunks: Buffer[] = []
        let received = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          if (received > MAX_REMOTE_IMAGE_BYTES) {
            await reader.cancel()
            return null
          }
          chunks.push(Buffer.from(value))
        }
        const buf = Buffer.concat(chunks)
        const ct = resp.headers.get('content-type') ?? ''
        const mime = ct.includes('png')
          ? 'image/png'
          : ct.includes('gif')
            ? 'image/gif'
            : 'image/jpeg'
        return { base64: buf.toString('base64'), mime }
      } catch {
        return null
      }
    },
  )
}

// ── project-store IPC (standalone mode) ────────────────────────────────────
// In shell mode docs-main.registerProjectIpc has already registered it
// (idempotency guard).

let sheetsProjectStore: ProjectStore | null = null
let sheetsProjectIpcRegistered = false

function getSheetsProjectStore(): ProjectStore {
  if (!sheetsProjectStore) sheetsProjectStore = new ProjectStore(app.getPath('userData'))
  return sheetsProjectStore
}

export function registerProjectIpc(): void {
  if (sheetsProjectIpcRegistered) return
  sheetsProjectIpcRegistered = true

  ipcMain.handle(
    'project:resolveChat',
    (event, args: { filePath: string | null; tempChatId?: string; sessionId?: string }) => {
      const store = getSheetsProjectStore()
      store.ensureDefaultProject()

      // sheets mode: reverse-look up the file path via sessionId
      let resolvedPath = args.filePath
      if (!resolvedPath && args.sessionId) {
        const tabEntry = sheetsTabs.get(event.sender.id)
        if (tabEntry) {
          resolvedPath = tabEntry.sessions.get(args.sessionId)?.path ?? null
        }
      }

      if (!resolvedPath) {
        return { projectId: 'default', chatId: args.tempChatId ?? `unsaved-${Date.now()}` }
      }
      return store.resolveChatForFile(resolvedPath)
    },
  )

  ipcMain.handle(
    'project:appendChat',
    (
      _event,
      args: {
        projectId: string
        chatId: string
        role: 'user' | 'assistant'
        text: string
        tools?: Array<{
          name: string
          summary: string
          isError?: boolean
          input?: string
          output?: string
        }>
        attachments?: Array<{ name: string; path?: string; ext?: string; sizeBytes?: number }>
        scope?: { label: string; text?: string }
        /** skill chips of a user message; the store bounds and filters them */
        skills?: unknown
      },
    ) => {
      if (args.role !== 'user' && args.role !== 'assistant') {
        throw new Error(`Invalid chat role: ${String(args.role)}`)
      }
      if (typeof args.text !== 'string' || args.text.length > 200_000) {
        throw new Error('Invalid chat text: must be a string up to 200000 chars')
      }
      if (args.tools && !Array.isArray(args.tools)) throw new Error('Invalid chat tools')
      if (args.attachments && !Array.isArray(args.attachments)) {
        throw new Error('Invalid chat attachments')
      }
      const msg: Parameters<ProjectStore['appendChatMessage']>[2] = {
        role: args.role,
        text: args.text,
      }
      if (args.tools) msg.tools = args.tools
      if (args.attachments) msg.attachments = args.attachments
      if (args.scope) msg.scope = args.scope
      if (Array.isArray(args.skills)) msg.skills = args.skills as NonNullable<typeof msg.skills>

      getSheetsProjectStore().appendChatMessage(args.projectId, args.chatId, msg)
    },
  )

  ipcMain.handle(
    'project:loadChat',
    (_event, args: { projectId: string; chatId: string; limit?: number }) => {
      return getSheetsProjectStore().loadChat(args.projectId, args.chatId, args.limit ?? 200)
    },
  )

  ipcMain.handle(
    'project:rebindChat',
    (
      event,
      args: {
        projectId: string
        tempChatId: string
        newChatId?: string
        newFilePath?: string
        sessionId?: string
      },
    ) => {
      const store = getSheetsProjectStore()
      let path = args.newFilePath ?? null
      if (!path && args.sessionId) {
        path = resolveSheetsSessionPath(event.sender.id, args.sessionId)
      }
      if (path) {
        return store.rebindChatToFile(args.projectId, args.tempChatId, path)
      }
      if (args.newChatId) store.rebindChat(args.projectId, args.tempChatId, args.newChatId)
      return { projectId: args.projectId, chatId: args.newChatId ?? args.tempChatId }
    },
  )
}

/**
 * sessionId → workbook file path reverse lookup (injected into docs-main's
 * project:resolveChat in shell mode). In standalone mode the handler registered
 * above queries sheetsTabs directly.
 */
export function resolveSheetsSessionPath(senderId: number, sessionId: string): string | null {
  return sheetsTabs.get(senderId)?.sessions.get(sessionId)?.path ?? null
}

/**
 * Write the workbook with a save request's edits through the sidecar. Split out
 * of the save handler so a crash-recovery copy can reuse the exact same pipeline
 * with a different targetPath.
 */
async function writeWorkbookTo(
  client: XlsxSidecarClient,
  session: SessionInfo,
  request: WorkbookSaveRequest,
  targetPath: string,
): Promise<Awaited<ReturnType<typeof saveWorkbookViaSidecar>>> {
  return saveWorkbookViaSidecar({
    client,
    // The snapshot, not the live path: the save base must be the bytes this
    // session's pending edits were made against, regardless of what other
    // programs did to the file since.
    sourcePath: session.snapshotPath,
    targetPath,
    ...resolveWorkbookSave(session.sheetNames, request),
  })
}

/** Copies the workbook into the temp snapshot dir; the copy is the session's
 * save base (see SessionInfo.snapshotPath). */
async function snapshotWorkbook(path: string): Promise<string> {
  const snapshotPath = await reserveSnapshotPath()
  await copyFile(path, snapshotPath)
  return snapshotPath
}

/** a fresh snapshot path in the session temp dir; nothing is written there yet */
/** A save's output opens as part of that save, so it gets the limit the save's
 *  archive commands get (xlsx-sidecar-client ARCHIVE_TIMEOUT_MS), not the 30s
 *  of a plain open. */
const SAVE_REOPEN_TIMEOUT_MS = 180_000

async function reserveSnapshotPath(): Promise<string> {
  const dir = join(app.getPath('temp'), 'seuoffice-sheets-sessions')
  await mkdir(dir, { recursive: true })
  return join(dir, `${randomUUID()}.xlsx`)
}

/** Copies a verified staged save to its target: beside the target first, then
 * promoted over it, so a failed copy never leaves the target half-written. */
async function placeStagedSave(stagedPath: string, targetPath: string): Promise<void> {
  const besideTarget = join(dirname(targetPath), `.${randomUUID()}.tmp.xlsx`)
  try {
    await copyFile(stagedPath, besideTarget)
    await promoteFileAtomically(besideTarget, targetPath)
  } catch (error) {
    await rm(besideTarget, { force: true }).catch(() => undefined)
    throw error
  }
}

let cachedShortDate: string | undefined

/// Derived from the OS region (not the UI language) and shared with the
/// gateway's save-side numFmtId mapping via setSystemShortDate.
function systemShortDate(): string {
  if (cachedShortDate === undefined) {
    cachedShortDate = shortDatePatternForSystemLocale(app.getSystemLocale())
    setSystemShortDate(cachedShortDate)
  }
  return cachedShortDate
}

/** the tab died between prepare and open: release the temp copy and any name reserved for it */
async function discardPreparedOpen(prepared: {
  openPath: string
  importTempDir?: string | undefined
}): Promise<void> {
  unsavedNewWorkbooks.delete(prepared.openPath)
  if (prepared.importTempDir !== undefined)
    await cleanupImportTempDirectory(app.getPath('temp'), prepared.importTempDir)
}

async function openWorkbookSession(
  client: XlsxSidecarClient,
  path: string,
  sessions: Map<string, SessionInfo>,
  options?: {
    suggestSaveAs?: string | undefined
    csvImport?: boolean | undefined
    csvSourcePath?: string | undefined
    emptyCsv?: boolean | undefined
    importTempDir?: string | undefined
    restoreTarget?: string | undefined
    emptySource?: boolean | undefined
    unsavedNew?: boolean | undefined
    password?: string | undefined
    recoveryIdentity?: RecoveryIdentity | undefined
    recoveryOriginalPath?: string | undefined
    unsavedRestore?: boolean | undefined
    /// Opened from an .ods conversion: the footer says saving writes an .xlsx
    /// and how many formulas were kept as values.
    odsConverted?: boolean | undefined
    formulasDropped?: number | undefined
    /// The original .ods this converted copy came from (never an export target).
    odsSourcePath?: string | undefined
    /// A save's output already opened by the sidecar: it is this session's
    /// snapshot as it stands, so neither the copy nor the open is repeated.
    staged?: { snapshotPath: string; opened: SidecarOpenResult } | undefined
  },
): Promise<WorkbookFile> {
  const {
    suggestSaveAs,
    csvImport,
    csvSourcePath,
    emptyCsv,
    importTempDir,
    restoreTarget,
    emptySource,
    unsavedNew,
    password,
    recoveryIdentity,
    recoveryOriginalPath,
    unsavedRestore,
    odsConverted,
    formulasDropped,
    odsSourcePath,
    staged,
  } = options ?? {}
  // Snapshot first, then the sidecar opens the snapshot (not the live path):
  // everything the session serves — cell reads, media, recalc, saves — comes
  // from the same bytes, even if the file on disk changes right after the
  // copy. The digest also describes exactly those bytes.
  const snapshotPath = staged?.snapshotPath ?? (await snapshotWorkbook(path))
  // The document path this copy is judged by (split-view save guard): the file
  // the user sees, not the converted temp copy (CSV) or recovery copy (restore).
  const diskStatePath = restoreTarget ?? csvSourcePath ?? path
  try {
    const [opened, digest, snapshotStat, restoreTargetSha, csvSourceSha, diskState] =
      await Promise.all([
        staged?.opened ??
          client
            .open(snapshotPath, documentLocale(), systemShortDate())
            .then((result) => sidecarOpenResultSchema.parse(result)),
        sha256File(snapshotPath),
        stat(snapshotPath),
        // Missing original (deleted since the crash) is fine: the write-back recreates it.
        restoreTarget === undefined
          ? Promise.resolve(undefined)
          : sha256File(restoreTarget).catch(() => undefined),
        csvSourcePath === undefined
          ? Promise.resolve(undefined)
          : sha256File(csvSourcePath).catch(() => undefined),
        recordDiskState(diskStatePath),
      ])
    // an encrypted workbook writes no recovery copy: it would be plaintext
    const automaticRecoveryDisabled =
      password !== undefined || !allowsAutomaticWorkbookRecovery(opened.sheets)
    sessions.set(opened.sessionId, {
      path,
      snapshotPath,
      sha256: digest,
      sheetNames: new Map(opened.sheets.map((sheet) => [sheet.id, sheet.name])),
      automaticRecoveryDisabled,
      ...(suggestSaveAs === undefined ? {} : { suggestSaveAs }),
      ...(odsConverted ? { odsConverted: true } : {}),
      ...(formulasDropped === undefined ? {} : { formulasDropped }),
      ...(odsSourcePath === undefined ? {} : { odsSourcePath }),
      ...(csvImport ? { csvImport } : {}),
      ...(csvSourcePath === undefined ? {} : { csvSourcePath }),
      ...(csvSourceSha === undefined ? {} : { csvSourceSha }),
      ...(importTempDir === undefined ? {} : { importTempDir }),
      ...(restoreTarget === undefined ? {} : { restoreTarget }),
      ...(restoreTargetSha === undefined ? {} : { restoreTargetSha }),
      ...(emptySource ? { emptySource } : {}),
      ...(unsavedNew ? { unsavedNew } : {}),
      ...(password === undefined ? {} : { password }),
      ...(recoveryIdentity === undefined ? {} : { recoveryIdentity }),
      ...(recoveryOriginalPath === undefined ? {} : { recoveryOriginalPath }),
      ...(unsavedRestore ? { unsavedRestore } : {}),
      ...(diskState === null ? {} : { diskState: { path: diskStatePath, state: diskState } }),
    })
    unsavedNewWorkbooks.delete(path)
    return workbookFileSchema.parse({
      ...opened,
      // The engine names the workbook after the file it was given, which is
      // the snapshot (a uuid): the renderer is told the name of the document
      // the user sees, the one its status line and loading notices speak of.
      name: basename(restoreTarget ?? csvSourcePath ?? odsSourcePath ?? suggestSaveAs ?? path),
      // The renderer-facing path is what the user opened: for a restored
      // recovery copy that is the original file, not the copy under userData.
      path: restoreTarget ?? path,
      sha256: digest,
      fileBytes: snapshotStat.size,
      readOnly: false,
      needsSaveAs: suggestSaveAs !== undefined,
      ...(odsConverted ? { odsConverted: true } : {}),
      ...(formulasDropped === undefined ? {} : { formulasDropped }),
      ...(unsavedNew ? { unsavedNew: true } : {}),
      ...(csvSourcePath === undefined ? {} : { csvPath: csvSourcePath }),
      ...(emptyCsv ? { emptyCsv: true } : {}),
      // an encrypted workbook's restoreTarget is the file itself, not a restore
      restoredFromRecovery: restoreTarget !== undefined && password === undefined,
      automaticRecoveryDisabled,
      // a converted encrypted .xls has no encrypted package to rewrite until its Save As
      ...(password !== undefined && restoreTarget !== undefined ? { passwordProtected: true } : {}),
    })
  } catch (error) {
    if (staged !== undefined) await client.close(staged.opened.sessionId).catch(() => undefined)
    await rm(snapshotPath, { force: true }).catch(() => undefined)
    unsavedNewWorkbooks.delete(path)
    if (importTempDir !== undefined) {
      await cleanupImportTempDirectory(app.getPath('temp'), importTempDir)
    }
    throw error
  }
}

/// A 0-byte .xlsx is an empty workbook, not a corrupt one. The sidecar needs a
/// real archive, so a blank one opens from the temp dir with the original as
/// the write-back target (the restore path: Save writes it even with no edits).
async function openEmptyXlsx(path: string): Promise<{
  openPath: string
  importTempDir: string
  restoreTarget: string
  emptySource: true
}> {
  const directory = join(app.getPath('temp'), 'seuoffice-imports', randomUUID())
  await mkdir(directory, { recursive: true })
  const openPath = join(directory, basename(path))
  try {
    await writeFile(openPath, (await csvToXlsxBufferForOpen('', 'Sheet1')).buffer)
  } catch (error) {
    await cleanupImportTempDirectory(app.getPath('temp'), directory)
    throw error
  }
  return { openPath, importTempDir: directory, restoreTarget: path, emptySource: true }
}

/// .xls and .ods open path: an HTML table export is read here, a real container
/// goes to the sidecar. Excel sniffs content over the extension, which is why
/// these mislabelled exports open there instead of being called broken files.
/// Returns the formulas the conversion could not translate (0 for the HTML path).
async function convertLegacyImport(
  client: XlsxSidecarClient,
  path: string,
  targetPath: string,
): Promise<number> {
  const conversion = await convertLegacyWorkbook(client, path, targetPath, legacyCsvCharset())
  if (conversion.kind === 'html-too-large') throw new Error(tm('errFileTooLarge'))
  if (conversion.kind === 'html-no-table') throw new Error(tm('errHtmlNoTable'))
  return conversion.formulasDropped
}

/** a CFB container: an encrypted .xlsx/.xlsm, or any .xls */
async function hasCfbHeader(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(8)
    const { bytesRead } = await handle.read(head, 0, 8, 0)
    return isCfbHeader(head.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

/// A save whose output did not reopen. The toast and the status bar cut a long
/// line short, so the reason at the end of the message never reached a report;
/// the dialog shows it in full and copies it for one.
async function showSaveUnreadableDialog(
  parent: BrowserWindow | undefined,
  reason: string,
  sourceFormat: string,
): Promise<void> {
  const options = {
    type: 'warning' as const,
    message: tm('errSaveUnreadable'),
    detail: tm('errSaveUnreadableReason', { reason }),
    buttons: [tm('btnCopyReason'), tm('btnCloseDialog')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }
  const { response } =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
  if (response !== 0) return
  clipboard.writeText(`${tm('errSaveUnreadable')} ${reason} (${sourceFormat}, ${app.getVersion()})`)
}

async function showEncryptedOpenFailure(parent: BrowserWindow | undefined): Promise<void> {
  const options = {
    type: 'warning' as const,
    message: tm('errEncryptedOpenTitle'),
    detail: tm('errEncryptedUnsupported'),
  }
  if (parent && !parent.isDestroyed()) await dialog.showMessageBox(parent, options)
  else await dialog.showMessageBox(options)
}

/// A password-protected workbook asks for its password and opens as a
/// decrypted copy in the temp dir. An .xlsx/.xlsm keeps the user's file as
/// restoreTarget, so Save writes back to it (re-encrypted); an encrypted .xls
/// converts like any .xls and its first save is a Save As. Resolves undefined
/// for a file that is not encrypted, and null when the user cancelled the
/// prompt or the file cannot be decrypted (the user has been told why).
async function prepareEncryptedWorkbook(
  client: XlsxSidecarClient,
  path: string,
  extension: string,
  parent: BrowserWindow | undefined,
): Promise<PreparedWorkbookOpen | null | undefined> {
  if (extension !== 'xlsx' && extension !== 'xlsm' && extension !== 'xls') return undefined
  if (!(await hasCfbHeader(path))) return undefined
  const bytes = await readFile(path)
  if (!isEncryptedOfficeFile(bytes)) return undefined
  // a headless export has no one to ask: only a file Excel opens unasked gets through
  const headless = isHeadlessMode()
  const prompt = headless ? undefined : passwordPromptFactory?.(parent, basename(path))
  let unlocked: Awaited<ReturnType<typeof unlockOfficeFile>> | 'failed'
  try {
    unlocked = await unlockOfficeFile(
      bytes,
      prompt?.ask ??
        (headless
          ? () => Promise.resolve(null)
          : () =>
              Promise.reject(
                new OfficeDecryptError('unsupported', 'no password prompt available'),
              )),
    )
  } catch (error) {
    if (!(error instanceof OfficeDecryptError)) throw error
    unlocked = 'failed'
  } finally {
    prompt?.close()
  }
  if (unlocked === 'failed') {
    if (!headless) await showEncryptedOpenFailure(parent)
    return null
  }
  if (unlocked === null) return null
  const directory = join(app.getPath('temp'), 'seuoffice-imports', randomUUID())
  await mkdir(directory, { recursive: true })
  try {
    if (extension !== 'xls') {
      const openPath = join(directory, basename(path))
      await writeFile(openPath, unlocked.bytes)
      return {
        openPath,
        importTempDir: directory,
        restoreTarget: path,
        password: unlocked.password,
      }
    }
    const stem = basename(path).replace(/\.[^.]+$/, '')
    const plainXls = join(directory, `${stem}.xls`)
    const openPath = join(directory, `${stem}.xlsx`)
    await writeFile(plainXls, unlocked.bytes)
    await client.convertWorkbook({ path: plainXls, targetPath: openPath })
    await rm(plainXls, { force: true })
    return {
      openPath,
      importTempDir: directory,
      suggestSaveAs: path.replace(/\.[^.]+$/, '.xlsx'),
      // Excel's built-in password guarded only editing: the new .xlsx gets no open password
      ...(unlocked.asked ? { password: unlocked.password } : {}),
    }
  } catch (error) {
    await cleanupImportTempDirectory(app.getPath('temp'), directory)
    throw error
  }
}

interface PreparedWorkbookOpen {
  openPath: string
  suggestSaveAs?: string
  csvImport?: boolean
  csvSourcePath?: string
  emptyCsv?: boolean
  importTempDir?: string
  restoreTarget?: string
  emptySource?: boolean
  unsavedNew?: boolean
  password?: string
  recoveryIdentity?: RecoveryIdentity
  recoveryOriginalPath?: string
  unsavedRestore?: boolean
  /// The copy came from an .ods: the document keeps saying that saving writes
  /// an .xlsx, and how many formulas the conversion kept as values only.
  odsConverted?: boolean
  formulasDropped?: number
  /// The original .ods the copy was converted from; no export may write there.
  odsSourcePath?: string
}

/// .xls, .ods and .tsv open as a converted copy in the temp dir; the session
/// remembers the original's .xlsx sibling as the Save As default. .csv converts
/// the same way but keeps its file identity, so Save writes values back to it.
/// Resolves null when an encrypted file's open was cancelled or refused.
async function prepareWorkbookForOpen(
  client: XlsxSidecarClient,
  path: string,
  contents?: WebContents | undefined,
  parent?: BrowserWindow | undefined,
  options?: {
    skipRecoveryPrompt?: boolean
    /** progress and cancellation for a delimited import */
    import?: {
      readonly onProgress?: (progress: CsvImportProgress) => void
      readonly signal?: AbortSignal
    }
  },
): Promise<PreparedWorkbookOpen | null> {
  // A shell-created "New spreadsheet" opens from a temp directory and has no
  // user-visible file yet: Save As produces it, and closing unsaved discards
  // the directory. The mark is consumed once the session exists (see
  // openWorkbookSession) so the name stays reserved through the open and a
  // reopened path is a normal file.
  const unsavedNew = unsavedNewWorkbooks.get(path)
  if (unsavedNew !== undefined) {
    const base = {
      suggestSaveAs: unsavedNew.suggestSaveAs,
      importTempDir: unsavedNew.tempDir,
      unsavedNew: true,
      recoveryIdentity: unsavedNew.recovery,
      ...(unsavedNew.restored ? { unsavedRestore: true } : {}),
      ...(unsavedNew.originalPath === undefined
        ? {}
        : { recoveryOriginalPath: unsavedNew.originalPath }),
      // a copy of an .ods document keeps its footer notice (converted .xlsx)
      ...(unsavedNew.odsConverted
        ? {
            odsConverted: true,
            ...(unsavedNew.formulasDropped === undefined
              ? {}
              : { formulasDropped: unsavedNew.formulasDropped }),
            ...(unsavedNew.odsSourcePath === undefined
              ? {}
              : { odsSourcePath: unsavedNew.odsSourcePath }),
          }
        : {}),
    }
    // An untitled copy of a .csv/.tsv/.xls (a skill template's, spec 5.7) is
    // converted beside itself in its own temp folder: the session edits the
    // .xlsx, the first save asks where, closing discards the folder.
    const copyExtension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    if (copyExtension === 'csv' || copyExtension === 'tsv' || copyExtension === 'xls') {
      const openPath = join(
        unsavedNew.tempDir,
        `${basename(path).replace(/\.[^.]+$/, '')}-${randomUUID().slice(0, 8)}.xlsx`,
      )
      if (copyExtension === 'xls') {
        await convertLegacyImport(client, path, openPath)
      } else {
        const copySize = (await stat(path)).size
        const limitBytes = delimitedImportLimit()
        if (copySize > limitBytes) {
          const limitMb = Math.round(limitBytes / 1024 / 1024)
          const sizeMb = (copySize / 1024 / 1024).toFixed(1)
          throw new Error(`${tm('errTooLarge', { mb: limitMb })} (${sizeMb} MB)`)
        }
        const converted = await csvToXlsxBufferForOpen(
          await decodeCsvBuffer(await readFile(path), legacyCsvCharset()),
          'Sheet1',
          copyExtension === 'tsv' ? '\t' : undefined,
        )
        await writeFile(openPath, converted.buffer)
      }
      // the mark follows the file the session edits
      unsavedNewWorkbooks.delete(path)
      unsavedNewWorkbooks.set(openPath, unsavedNew)
      return { openPath, ...base }
    }
    // a copy reopened as untitled (openSheetsUntitledCopy): its content is the
    // backing file already, and it is loaded now
    if (unsavedNew.restored) recoveryStore.markCopyLoaded(unsavedNew.recovery)
    return { openPath: path, ...base }
  }
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  // An encrypted file never has a recovery copy: it is not written for one.
  const encrypted = await prepareEncryptedWorkbook(client, path, extension, parent)
  if (encrypted !== undefined) return encrypted
  if (extension !== 'csv' && extension !== 'tsv' && extension !== 'xls' && extension !== 'ods') {
    // Unsaved work from a lost session is settled before the file's content
    // loads (recoveredOpenFor). Restoring opens the copy with restoreTarget
    // pointing back at the original, so a plain Save writes straight back
    // over the file the user opened — choosing to restore was the
    // confirmation. Merge sources are read-only picks: never surface (or
    // worse, discard) another workbook's crash recovery from here.
    if (!options?.skipRecoveryPrompt) {
      const recovered = await recoveredOpenFor(path, contents, parent)
      if (recovered !== null) return recovered
    }
    if (extension === 'xlsx' && (await stat(path)).size === 0) return openEmptyXlsx(path)
    return { openPath: path }
  }
  const stem = basename(path).replace(/\.[^.]+$/, '')
  const directory = join(app.getPath('temp'), 'seuoffice-imports', randomUUID())
  await mkdir(directory, { recursive: true })
  const openPath = join(directory, `${stem}.xlsx`)
  let emptyCsv = false
  let formulasDropped = 0
  try {
    if (extension === 'csv' || extension === 'tsv') {
      const csvStat = await stat(path)
      const limitBytes = delimitedImportLimit()
      if (csvStat.size > limitBytes) {
        const limitMb = Math.round(limitBytes / 1024 / 1024)
        const sizeMb = (csvStat.size / 1024 / 1024).toFixed(1)
        throw new Error(`${tm('errTooLarge', { mb: limitMb })} (${sizeMb} MB)`)
      }
      const converted = await csvToXlsxBufferForOpen(
        await decodeCsvBuffer(await readFile(path), legacyCsvCharset()),
        'Sheet1',
        // A .tsv's delimiter is declared by its extension, and sniffing by
        // frequency can get it wrong: annotation-heavy exports (gene
        // descriptions, database cross-references) hold comma-separated
        // lists, so a narrow table ends up with more commas than tabs and
        // every row shatters on the comma. A .csv keeps the sniff — the prose
        // guard in resolveImportDelimiter is what that path needs.
        extension === 'tsv' ? '\t' : undefined,
        options?.import,
      )
      emptyCsv = converted.empty
      await writeFile(openPath, converted.buffer)
    } else {
      formulasDropped = await convertLegacyImport(client, path, openPath)
    }
  } catch (error) {
    await cleanupImportTempDirectory(app.getPath('temp'), directory)
    throw error
  }
  // CSV keeps its file identity: Save writes the values back to the original
  // .csv (Excel's behavior), so no Save As detour is suggested. Legacy .xls,
  // .ods and view-only .tsv route the first save through Save As to a fresh
  // .xlsx — writing values back to a .tsv would need a tab serializer this
  // path lacks, and an .ods cannot hold the workbook bytes at all.
  return extension === 'csv'
    ? {
        openPath,
        importTempDir: directory,
        csvImport: true,
        csvSourcePath: path,
        ...(emptyCsv ? { emptyCsv: true } : {}),
      }
    : {
        openPath,
        importTempDir: directory,
        suggestSaveAs: path.replace(/\.[^.]+$/, '.xlsx'),
        ...(extension === 'ods'
          ? { odsConverted: true, formulasDropped, odsSourcePath: path }
          : {}),
      }
}

/** shell-injected items appended to the File menu (e.g. Back to Home) */
let extraFileMenuItems: MenuItemConstructorOptions[] = []

export function setSheetsExtraFileMenuItems(items: MenuItemConstructorOptions[]): void {
  extraFileMenuItems = items
}

/** shell-built File-menu entries for the open document (make another document
 * from it, its sources, the documents made from it); asked at every build */
let documentLinkMenuItems: (() => MenuItemConstructorOptions[]) | null = null

export function setSheetsDocumentLinkMenuItems(
  items: (() => MenuItemConstructorOptions[]) | null,
): void {
  documentLinkMenuItems = items
}

/** tab mode: closes the sheets tab instead of the whole shell window (Cmd+W / role:'close') */
let closeActiveTabHook: (() => void) | null = null
export function setSheetsCloseTabHook(fn: (() => void) | null): void {
  closeActiveTabHook = fn
}

/// The ribbon has no File tab; file commands live in
/// the application menu and are forwarded to the renderer.
function installApplicationMenu(): void {
  const sendMenuAction = sendSheetsMenuAction
  const labels = appMenuLabels(getUiLang())
  const appMenu = appMenuTemplate(process.platform, labels, {
    appLabel: app.name,
    extra: [settingsMenuItem(labels)],
  })
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(appMenu ? [appMenu] : []),
      {
        label: tm('menuFile'),
        submenu: [
          {
            label: tm('menuOpenWorkbook'),
            accelerator: 'CmdOrCtrl+O',
            click: () => sendMenuAction('open'),
          },
          ...(extraFileMenuItems.length > 0
            ? [{ type: 'separator' as const }, ...extraFileMenuItems]
            : []),
          ...(documentLinkMenuItems?.() ?? []),
          { type: 'separator' },
          {
            label: tm('menuSave'),
            accelerator: 'CmdOrCtrl+S',
            click: () => sendMenuAction('save'),
          },
          {
            label: tm('menuSaveAs'),
            accelerator: 'Shift+CmdOrCtrl+S',
            click: () => sendMenuAction('save-as'),
          },
          { type: 'separator' },
          {
            label: tm('menuPrint'),
            accelerator: 'CmdOrCtrl+P',
            click: () => sendMenuAction('print'),
          },
          { type: 'separator' },
          {
            label: tm('menuExportPdf'),
            click: () => sendMenuAction('export-pdf'),
          },
          {
            label: tm('menuExportCsv'),
            click: () => sendMenuAction('export-csv'),
          },
          {
            label: tm('menuExportOds'),
            click: () => sendMenuAction('export-ods'),
          },
          { type: 'separator' },
          // tab mode: the item closes the focused tab or window, never the app,
          // so it is named and bound like every other editor's Close
          closeActiveTabHook
            ? {
                label: tm('menuClose'),
                accelerator: 'CmdOrCtrl+W',
                click: () => closeActiveTabHook?.(),
              }
            : process.platform === 'darwin'
              ? { role: 'close' as const, label: tm('menuClose') }
              : { role: 'quit' as const, label: tm('menuQuit') },
          { type: 'separator' },
          settingsMenuItem(labels),
        ],
      },
      {
        label: tm('menuEdit'),
        submenu: [
          // role: 'editMenu' would bind ⌘Z to webContents.undo(), a text-editing
          // no-op that starves Univer of the shortcut — forward it instead.
          {
            label: tm('menuUndo'),
            accelerator: 'CmdOrCtrl+Z',
            click: () => sendMenuAction('undo'),
          },
          {
            label: tm('menuRedo'),
            accelerator: 'Shift+CmdOrCtrl+Z',
            click: () => sendMenuAction('redo'),
          },
          { type: 'separator' },
          { role: 'cut', label: labels.cut },
          { role: 'copy', label: labels.copy },
          { role: 'paste', label: labels.paste },
          { type: 'separator' },
          { role: 'selectAll', label: labels.selectAll },
        ],
      },
      // ⌘R is Fill Right and ⌘0/⌘+/⌘- hide columns / zoom the sheet; menu
      // accelerators would swallow them on macOS.
      viewMenuTemplate(labels, { devItems: !app.isPackaged, pageZoom: false }),
      windowMenuTemplate(process.platform, labels),
      helpMenuTemplate(labels),
    ]),
  )
}

/** stop the Rust sidecar (shell calls this from its own before-quit hook) */
export function stopSheetsSidecar(): void {
  sidecar?.stop()
  sidecar = null
}

export {
  installApplicationMenu as installSheetsMenu,
  startCaptureServer as startSheetsCaptureServer,
}

/**
 * Attaches a proxy to the main process's global fetch (same source as
 * slides-main.applyMainProcessProxy): main-process Node fetch (undici) ignores
 * the system proxy by default, so direct connections from mainland networks to
 * overseas LLM endpoints like api.anthropic.com time out or get rejected by
 * egress region (403 Request not allowed). Environment variables take priority;
 * otherwise the system proxy is read via session.resolveProxy() after app ready.
 */
async function applyMainProcessProxy(): Promise<void> {
  const setDispatcher = async (proxyUrl: string) => {
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
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  if (envProxy) {
    await setDispatcher(envProxy)
    return
  }
  try {
    await app.whenReady()
    // PAC/rule proxies answer per-host: probe an LLM endpoint the main-process fetch targets
    const resolved = await electronSession.defaultSession.resolveProxy('https://api.anthropic.com/')
    const m = /PROXY\s+([^;]+)/i.exec(resolved || '')
    if (m?.[1]) {
      await setDispatcher(`http://${m[1].trim()}`)
    } else {
      console.log('[proxy] system proxy = DIRECT, no dispatcher set')
    }
  } catch (e) {
    console.warn('[proxy] resolveProxy failed:', e)
  }
}

export function startSheetsStandalone(): void {
  registerRendererScheme()
  installNavigationGuard(app)
  installContextMenu(app, () => contextMenuLabels(getUiLang()))
  // SEUOFFICE_USER_DATA: test drivers point this at a scratch dir so automated
  // instances get their own userData AND single-instance lock (the lock is scoped
  // to userData), allowing parallel instances alongside a normal dev run.
  // Same dev-only hook as apps/slides/src/main/slides-main.ts.
  if (!app.isPackaged && process.env.SEUOFFICE_USER_DATA) {
    app.setPath('userData', process.env.SEUOFFICE_USER_DATA)
  }
  void applyMainProcessProxy()
  app.whenReady().then(() => {
    installRendererProtocol({ sheets: join(__dirname, '../renderer') })
    // the shell's Word editor serves these URLs there; alone, sheets does
    installStandaloneTemplateFontProtocol()
    const requestedLang = process.env.SEUOFFICE_LANG ?? app.getLocale()
    setUiLang(normalizeLang(requestedLang), requestedLang)
    app.setAccessibilitySupportEnabled(true)
    installApplicationMenu()
    startCaptureServer()
    return createSheetsWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', () => {
    stopSheetsSidecar()
  })
  // a subscription program started for an AI run must not outlive the app
  app.on('will-quit', shutdownSubscriptionChildren)
  process.on('exit', shutdownSubscriptionChildren)
  app.on('activate', () => {
    if (!mainWindow) void createSheetsWindow()
  })
}

function resolveSidecarPath(): string {
  const executable = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
  if (runtime.sidecarPath) return runtime.sidecarPath
  if (process.env.XLSX_SIDECAR_PATH) return process.env.XLSX_SIDECAR_PATH
  if (app.isPackaged) return join(process.resourcesPath, 'native', executable)
  return join(app.getAppPath(), 'native', 'xlsx-engine', 'target', 'release', executable)
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

async function closeAllSessions(entry: {
  client: XlsxSidecarClient
  sessions: Map<string, SessionInfo>
}): Promise<void> {
  const sessions = [...entry.sessions.entries()]
  entry.sessions.clear()
  await Promise.allSettled(
    sessions.map(async ([sessionId, session]) => {
      await cleanupSessionResources({
        tempRoot: app.getPath('temp'),
        snapshotPath: session.snapshotPath,
        importTempDir: session.importTempDir,
        closeSidecar: () => entry.client.close(sessionId),
      })
    }),
  )
}
