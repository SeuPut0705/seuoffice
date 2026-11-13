/**
 * "Export as ODT": the editor's own Word export bytes go through `docxToOdt`
 * and land in a `.odt` file. Nothing here builds a document; the docx is
 * whatever the Word export of this editor writes, so the ODT carries exactly
 * what that export carries (redacted ranges included — AI redaction never
 * changes the exported document, and the ODT path adds nothing to it).
 *
 * When the conversion reports features it changes (`converted`) or leaves out
 * (`dropped`), the user confirms before anything is written; cancel writes
 * nothing. The steps are injected so the flow is testable without Electron.
 */
import { createI18n, getUiLang, type Lang } from '@seuoffice/i18n'
import {
  docxToOdt,
  type ConversionReport,
  type DocxToOdtResult,
  type ReportFeature,
} from '@seuoffice/odt-engine'
import {
  markedOdtBox,
  markedOdtChoice,
  type MarkedOdtBox,
} from '@seuoffice/electron-utils/marked-odt'
import type { MessageBoxOptions } from 'electron'
import type { MarkedExportChoice, MarkedExportFormat } from '../shared/ipc'

export type OdtExportOutcome =
  { ok: true; path: string } | { ok: true; canceled: true } | { ok: false; error: string }

export interface OdtExportSteps {
  /** the target path (save dialog); null = the user canceled */
  pickPath(): Promise<string | null>
  /** the editor's Word export of the current document */
  docx(): Promise<Uint8Array>
  /** asked only when the report lists something; false = the user canceled */
  confirm(report: ConversionReport): Promise<boolean>
  /** last gate before the file is written; false = canceled */
  prepare?(path: string): Promise<boolean>
  write(path: string, bytes: Uint8Array): Promise<void>
}

type Convert = (docx: Uint8Array) => Promise<DocxToOdtResult>

/** pick → docx → ODT → confirm (when the report is non-empty) → write */
export async function exportOdt(
  steps: OdtExportSteps,
  convert: Convert = (docx) => docxToOdt(docx),
): Promise<OdtExportOutcome> {
  try {
    const path = await steps.pickPath()
    if (!path) return { ok: true, canceled: true }
    const { odtBytes, report } = await convert(await steps.docx())
    // an ODT shows a hidden-from-AI run as plain words: nothing is written
    if (report.some((item) => item.feature === 'hidden_from_ai')) {
      return { ok: false, error: tOdt(getUiLang(), 'markedRefused') }
    }
    if (report.length > 0 && !(await steps.confirm(report))) return { ok: true, canceled: true }
    if (steps.prepare && !(await steps.prepare(path))) return { ok: true, canceled: true }
    await steps.write(path, odtBytes)
    return { ok: true, path }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** The confirmation message box: what changes and what is left out, by feature. */
export function odtReportMessageBox(
  report: ConversionReport,
  lang: Lang = getUiLang(),
): MessageBoxOptions {
  const t = (key: OdtKey) => tOdt(lang, key)
  const section = (kind: 'converted' | 'dropped', heading: OdtKey) => {
    const lines = report
      .filter((item) => item.kind === kind)
      .map((item) => {
        const name = t(FEATURE_KEY[item.feature])
        return `• ${item.count > 1 ? `${name} (${item.count})` : name}`
      })
    return lines.length > 0 ? [t(heading), ...lines].join('\n') : null
  }
  const detail = [section('converted', 'odtChanges'), section('dropped', 'odtLeftOut')]
    .filter((part): part is string => part !== null)
    .join('\n\n')
  return {
    type: 'warning',
    title: t('odtExportTitle'),
    message: t('odtConfirmMessage'),
    detail,
    buttons: [t('odtSave'), t('odtCancel')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }
}

/** Show the confirmation through `show` (Electron's dialog.showMessageBox); true = save. */
export async function confirmOdtReport(
  report: ConversionReport,
  show: (options: MessageBoxOptions) => Promise<{ response: number }>,
  lang: Lang = getUiLang(),
): Promise<boolean> {
  const { response } = await show(odtReportMessageBox(report, lang))
  return response === 0
}

const MARKED_KEYS: Record<MarkedExportFormat, { message: OdtKey; detail: OdtKey; clear: OdtKey }> =
  {
    odt: { message: 'markedMessage', detail: 'markedDetail', clear: 'markedClear' },
    pdf: { message: 'markedMessagePdf', detail: 'markedDetailFile', clear: 'markedClearPdf' },
    png: { message: 'markedMessagePng', detail: 'markedDetailFile', clear: 'markedClearPng' },
  }

/**
 * The choice box for a document with content hidden from AI that is about to be
 * exported as `format` (one box, the two ways out): Word, which keeps the mark,
 * the export without the marks, or cancel.
 */
export async function askMarkedExport(
  format: MarkedExportFormat,
  show: (options: MarkedOdtBox) => Promise<{ response: number }>,
  lang: Lang = getUiLang(),
): Promise<MarkedExportChoice> {
  const t = (key: OdtKey) => tOdt(lang, key)
  const keys = MARKED_KEYS[format]
  const { response } = await show(
    markedOdtBox({
      title: t('markedTitle'),
      message: t(keys.message),
      detail: t(keys.detail),
      saveDocx: t('markedDocx'),
      clearMarks: t(keys.clear),
      cancel: t('odtCancel'),
    }),
  )
  return markedOdtChoice(response)
}

/** Name of the save-dialog filter for `.odt` */
export function odtFilterName(lang: Lang = getUiLang()): string {
  return tOdt(lang, 'filterOdt')
}

const FEATURE_KEY: Record<ReportFeature, OdtKey> = {
  toc: 'featToc',
  chart: 'featChart',
  equation: 'featEquation',
  shape: 'featShape',
  textbox: 'featTextbox',
  columns: 'featColumns',
  citation: 'featCitation',
  cross_reference: 'featCrossReference',
  page_color: 'featPageColor',
  mirror_margins: 'featMirrorMargins',
  theme: 'featTheme',
  comment: 'featComment',
  revision: 'featRevision',
  ink: 'featInk',
  watermark: 'featWatermark',
  password: 'featPassword',
  protection: 'featProtection',
  form_field: 'featFormField',
  object: 'featObject',
  hidden_from_ai: 'featHiddenFromAi',
}

const tOdt = createI18n({
  en: {
    filterOdt: 'ODT Text Document',
    odtExportTitle: 'Export as ODT',
    odtConfirmMessage: 'Some content will change or be left out in the ODT file.',
    odtChanges: 'What changes',
    odtLeftOut: 'What is left out',
    odtSave: 'Save',
    odtCancel: 'Cancel',
    markedTitle: 'Content hidden from AI',
    markedMessage: 'This document has content hidden from AI, and an ODT file cannot keep that.',
    markedDetail:
      'Exported as ODT, the hidden content would read as plain text to everyone, AI included. Export as Word (.docx) instead, which keeps the hiding, or clear the marks for the ODT copy. This document keeps its marks either way.',
    markedDocx: 'Export as Word (.docx)',
    markedClear: 'Clear marks and export as ODT',
    markedMessagePdf: 'This document has content hidden from AI, and a PDF file cannot keep that.',
    markedMessagePng: 'This document has content hidden from AI, and page images cannot keep that.',
    markedDetailFile:
      'The exported file has no hidden-from-AI marks: anything that reads it, an AI included, sees the hidden content. Export as Word (.docx) instead, which keeps the marks, or export without them. This document keeps its marks either way.',
    markedClearPdf: 'Export as PDF without the marks',
    markedClearPng: 'Export images without the marks',
    featToc: 'Table of contents',
    featChart: 'Charts',
    featEquation: 'Equations',
    featShape: 'Shapes',
    featTextbox: 'Text boxes',
    featColumns: 'Columns',
    featCitation: 'Citations and bibliography',
    featCrossReference: 'Cross-references and caption numbers',
    featPageColor: 'Page color',
    featMirrorMargins: 'Mirror margins',
    featTheme: 'Theme fonts and colors',
    featComment: 'Comments',
    featRevision: 'Tracked changes',
    featInk: 'Ink',
    featWatermark: 'Watermark',
    featPassword: 'Password',
    featProtection: 'Editing restrictions and read-only recommendation',
    featFormField: 'Form fields',
    featObject: 'Other objects',
    featHiddenFromAi: 'Hidden-from-AI marks (the text stays, readable by AI)',
  },
  ko: {
    filterOdt: 'ODT 문서',
    odtExportTitle: 'ODT로 내보내기',
    odtConfirmMessage: 'ODT 파일에서는 일부 내용이 바뀌거나 빠집니다.',
    odtChanges: '바뀌는 것',
    odtLeftOut: '빠지는 것',
    odtSave: '저장',
    odtCancel: '취소',
    markedTitle: 'AI에게 숨긴 내용',
    markedMessage: '이 문서에는 AI에게 숨긴 내용이 있는데, ODT 파일에는 이를 담을 수 없습니다.',
    markedDetail:
      'ODT로 내보내면 숨긴 내용이 AI를 포함한 모두에게 일반 글자로 보입니다. 대신 숨김이 유지되는 Word(.docx)로 내보내거나, ODT 사본에서 표시를 지우세요. 어느 쪽이든 이 문서의 표시는 그대로 남습니다.',
    markedDocx: 'Word(.docx)로 내보내기',
    markedClear: '표시 지우고 ODT로 내보내기',
    markedMessagePdf: '이 문서에는 AI에게 숨긴 내용이 있는데, PDF 파일에는 이를 담을 수 없습니다.',
    markedMessagePng: '이 문서에는 AI에게 숨긴 내용이 있는데, 쪽 이미지에는 이를 담을 수 없습니다.',
    markedDetailFile:
      '내보낸 파일에는 AI에게 숨김 표시가 없습니다. 그 파일을 읽는 모든 것은 AI를 포함해 숨긴 내용을 그대로 봅니다. 대신 숨김 표시가 유지되는 Word(.docx)로 내보내거나, 표시 없이 내보내세요. 어느 쪽이든 이 문서의 표시는 그대로 남습니다.',
    markedClearPdf: '표시 없이 PDF로 내보내기',
    markedClearPng: '표시 없이 이미지로 내보내기',
    featToc: '목차',
    featChart: '차트',
    featEquation: '수식',
    featShape: '도형',
    featTextbox: '글상자',
    featColumns: '다단',
    featCitation: '인용·참고 문헌',
    featCrossReference: '상호 참조·그림 번호',
    featPageColor: '쪽 배경색',
    featMirrorMargins: '마주보는 여백',
    featTheme: '테마 글꼴·색',
    featComment: '메모',
    featRevision: '변경 기록',
    featInk: '펜 글씨',
    featWatermark: '워터마크',
    featPassword: '암호',
    featProtection: '편집 제한·읽기 전용 권장',
    featFormField: '누름틀',
    featObject: '기타 개체',
    featHiddenFromAi: 'AI에게 가린 표시(글은 남고 AI가 읽을 수 있음)',
  },
})

type OdtKey = Parameters<typeof tOdt>[1]
